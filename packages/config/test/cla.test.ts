import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOT_ID, MARKER, SIGN_PHRASE, run } from "../../../scripts/cla/cla.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const REPO = "acme/widget";
const API = "https://api.example.test";
const RECORD_PATH = ".github/cla/signatures.json";

/** The record as the earlier CLA Assistant Lite action wrote it on the cla-signatures branch. */
const EXISTING_RECORD = `{
  "signedContributors": [
    {
      "name": "CoderCoco",
      "id": 1407188,
      "comment_id": 6651612078,
      "created_at": "2026-11-05T06:42:53Z",
      "repoId": 1430307221,
      "pullRequestNo": 45
    }
  ]
}`;

interface User { login: string; id: number }
interface Commit { author: User | null; committer: User | null; name: string }
interface Comment { id: number; user: User; body: string; created_at: string }
interface Run { id: number; conclusion: string | null }

interface State {
  commits: Commit[];
  comments: Comment[];
  branch: boolean;
  /** The record's text on the branch, or null when the file is missing. */
  record: string | null;
  runs: Run[];
  /** Statuses the contents PUT answers before it accepts a write; each one also moves the file on, as another run's write would. */
  putFailures: number[];
  /** The branch appears between the ref lookup and the ref creation, as when another run created it. */
  refRace: boolean;
}

const ghBot: User = { login: "github-actions[bot]", id: BOT_ID };
const coco: User = { login: "CoderCoco", id: 1407188 };
const alice: User = { login: "alice", id: 501 };
const bob: User = { login: "bob", id: 502 };

interface Call { method: string; path: string; body: unknown }

/** An in-memory GitHub REST API: the routes the CLA script uses, recording every call. No network. */
function fakeGitHub(init: Partial<State>) {
  const state: State = { commits: [], comments: [], branch: true, record: EXISTING_RECORD, runs: [], putFailures: [], refRace: false, ...init };
  const calls: Call[] = [];
  let recordSha = 1;
  let nextComment = 9000;
  const json = (status: number, value: unknown) => new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const page = <T>(items: T[], url: URL) => {
    const per = Number(url.searchParams.get("per_page") ?? 30);
    const n = Number(url.searchParams.get("page") ?? 1);
    return items.slice((n - 1) * per, n * per);
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, API, "every request goes to the configured API");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-token");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    calls.push({ method, path: path + url.search, body });
    const base = `/repos/${REPO}`;
    const route = `${method} ${path}`;
    if (route === `GET ${base}/pulls/7/commits`) {
      // The REST API lists at most 250 commits of a pull request.
      return json(200, page(state.commits.slice(0, 250), url).map((c, i) => ({ sha: `c${i}`, author: c.author, committer: c.committer, commit: { author: { name: c.name }, committer: { name: c.name } } })));
    }
    if (route === `GET ${base}/pulls/7`) return json(200, { number: 7, head: { sha: "headsha" }, merged: false, commits: state.commits.length });
    if (route === `GET ${base}`) return json(200, { id: 77, default_branch: "main" });
    if (route === `GET ${base}/contents/${RECORD_PATH}`) {
      assert.equal(url.searchParams.get("ref"), "cla-signatures");
      if (!state.branch || state.record === null) return json(404, { message: "Not Found" });
      return json(200, { sha: `rec${recordSha}`, encoding: "base64", content: Buffer.from(state.record).toString("base64").replace(/(.{60})/g, "$1\n") });
    }
    if (route === `PUT ${base}/contents/${RECORD_PATH}`) {
      const b = body as { content: string; sha?: string; branch: string; message: string };
      assert.equal(b.branch, "cla-signatures");
      if (!state.branch) return json(404, { message: "Branch not found" });
      const fail = state.putFailures.shift();
      if (fail !== undefined) {
        recordSha += 1;
        return json(fail, { message: fail === 409 ? "is at rec-other but expected rec-old" : "sha wasn't supplied" });
      }
      if (state.record !== null) assert.equal(b.sha, `rec${recordSha}`, "an update names the SHA it read");
      else assert.equal(b.sha, undefined, "a new file has no SHA");
      state.record = Buffer.from(b.content, "base64").toString("utf8");
      recordSha += 1;
      return json(200, { content: { sha: `rec${recordSha}` } });
    }
    if (route === `GET ${base}/git/ref/heads/cla-signatures`) return state.branch ? json(200, { object: { sha: "cla-head" } }) : json(404, { message: "Not Found" });
    if (route === `GET ${base}/git/ref/heads/main`) return json(200, { object: { sha: "main-head" } });
    if (route === `POST ${base}/git/refs`) {
      assert.deepEqual(body, { ref: "refs/heads/cla-signatures", sha: "main-head" });
      if (state.refRace) {
        state.branch = true;
        return json(422, { message: "Reference already exists" });
      }
      state.branch = true;
      return json(201, { ref: "refs/heads/cla-signatures" });
    }
    if (route === `GET ${base}/issues/7/comments`) return json(200, page(state.comments, url));
    if (route === `POST ${base}/issues/7/comments`) {
      const c = { id: nextComment++, user: ghBot, body: (body as { body: string }).body, created_at: "2026-11-27T00:00:00Z" };
      state.comments.push(c);
      return json(201, c);
    }
    const patch = new RegExp(`^PATCH ${base}/issues/comments/(\\d+)$`).exec(route);
    if (patch) {
      const c = state.comments.find((x) => x.id === Number(patch[1]));
      assert.ok(c, "updates an existing comment");
      c.body = (body as { body: string }).body;
      return json(200, c);
    }
    if (route === `PUT ${base}/issues/7/lock`) return json(204, undefined);
    if (route === `GET ${base}/actions/runs/4242`) return json(200, { id: 4242, workflow_id: 31 });
    if (route === `GET ${base}/actions/workflows/31/runs`) {
      assert.equal(url.searchParams.get("event"), "pull_request_target");
      assert.equal(url.searchParams.get("head_sha"), "headsha");
      return json(200, { workflow_runs: state.runs });
    }
    const rerun = new RegExp(`^POST ${base}/actions/runs/(\\d+)/rerun$`).exec(route);
    if (rerun) return json(201, {});
    return json(500, { message: `unrouted ${route}` });
  };
  return { fetch, calls, state };
}

const prEvent = (action = "opened", merged = false) => ({ action, number: 7, pull_request: { number: 7, merged, head: { sha: "headsha" } }, repository: { id: 77 } });
const commentEvent = (comment: Comment) => ({ action: "created", issue: { number: 7, pull_request: { url: "x" } }, comment, repository: { id: 77 } });

async function check(gh: ReturnType<typeof fakeGitHub>, eventName: string, event: unknown) {
  const e = event as { pull_request?: { commits?: number } };
  if (e.pull_request && e.pull_request.commits === undefined) e.pull_request.commits = gh.state.commits.length;
  return run({ eventName, event, repository: REPO, token: "test-token", apiUrl: API, serverUrl: "https://github.example.test", runId: "4242", fetch: gh.fetch, log: () => {} });
}

const botComment = (gh: ReturnType<typeof fakeGitHub>) => gh.state.comments.filter((c) => c.user.id === BOT_ID);
const writes = (gh: ReturnType<typeof fakeGitHub>) => gh.calls.filter((c) => c.method === "PUT" && c.path.includes("/contents/"));

// @spec DEPLOY-CI-013
test("a pull request whose every author has signed passes and posts no comment", async () => {
  const gh = fakeGitHub({ commits: [{ author: coco, committer: coco, name: "Coco" }] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 0);
  assert.equal(botComment(gh).length, 0);
  assert.equal(writes(gh).length, 0);
});

// @spec DEPLOY-CI-013, DEPLOY-CI-014
test("an unsigned author fails the check and gets one comment linking CLA.md with the signing phrase", async () => {
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  const [c, ...more] = botComment(gh);
  assert.ok(c);
  assert.equal(more.length, 0);
  assert.ok(c.body.includes(MARKER));
  assert.ok(c.body.includes("https://github.example.test/acme/widget/blob/main/CLA.md"));
  assert.ok(c.body.includes(SIGN_PHRASE));
  assert.match(c.body, /recheck/);
  // A second run updates the same comment rather than posting another.
  assert.equal(await check(gh, "pull_request_target", prEvent("synchronize")), 1);
  assert.equal(botComment(gh).length, 1);
  assert.equal(gh.calls.filter((x) => x.method === "POST" && x.path === `/repos/${REPO}/issues/7/comments`).length, 1);
});

// @spec DEPLOY-CI-014
test("with several contributors the comment lists who has signed and who has not", async () => {
  const gh = fakeGitHub({ commits: [{ author: coco, committer: coco, name: "Coco" }, { author: alice, committer: alice, name: "Alice" }, { author: alice, committer: alice, name: "Alice" }] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  const body = botComment(gh)[0]!.body;
  assert.match(body, /\*\*1\*\* out of \*\*2\*\* committers have signed/);
  assert.match(body, /:white_check_mark: @CoderCoco/);
  assert.match(body, /:x: @alice/);
});

// @spec DEPLOY-CI-014
test("an existing comment from the earlier action is updated in place", async () => {
  const old: Comment = { id: 55, user: ghBot, body: "**CLA Assistant Lite bot:** please sign", created_at: "2026-11-01T00:00:00Z" };
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [old] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  assert.equal(botComment(gh).length, 1);
  assert.ok(old.body.includes(MARKER));
});

// @spec DEPLOY-CI-013
test("github-actions[bot] is skipped by account id, and no other name is allow-listed", async () => {
  const gh = fakeGitHub({ commits: [{ author: coco, committer: coco, name: "Coco" }, { author: ghBot, committer: ghBot, name: "github-actions[bot]" }] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 0);
  // A different account that merely carries a bot-like name is a contributor like any other.
  const other: User = { login: "renovate[bot]", id: 29139614 };
  const gh2 = fakeGitHub({ commits: [{ author: other, committer: other, name: "renovate[bot]" }] });
  assert.equal(await check(gh2, "pull_request_target", prEvent()), 1);
  // An unlinked commit named like the bot is not skipped.
  const gh3 = fakeGitHub({ commits: [{ author: null, committer: null, name: "github-actions[bot]" }] });
  assert.equal(await check(gh3, "pull_request_target", prEvent()), 1);
});

// @spec DEPLOY-CI-013, DEPLOY-CI-014
test("a commit with no linked account fails and is named in the comment", async () => {
  const gh = fakeGitHub({ commits: [{ author: coco, committer: coco, name: "Coco" }, { author: null, committer: null, name: "Mallory Unlinked" }] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  const body = botComment(gh)[0]!.body;
  assert.match(body, /`Mallory Unlinked` seems not to be a GitHub user/);
  // The committer's account stands in when the author has none.
  const gh2 = fakeGitHub({ commits: [{ author: null, committer: coco, name: "Someone" }] });
  assert.equal(await check(gh2, "pull_request_target", prEvent()), 0);
});

// @spec DEPLOY-CI-015
test("a signing comment from an unsigned author records the signature in the existing format and re-runs the failed run", async () => {
  const sign: Comment = { id: 7001, user: alice, body: `  ${SIGN_PHRASE.toUpperCase()}  `, created_at: "2026-11-27T10:00:00Z" };
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [sign], runs: [{ id: 99, conclusion: "failure" }] });
  assert.equal(await check(gh, "issue_comment", commentEvent(sign)), 0);
  const want = JSON.parse(EXISTING_RECORD) as { signedContributors: unknown[] };
  want.signedContributors.push({ name: "alice", id: 501, comment_id: 7001, created_at: "2026-11-27T10:00:00Z", repoId: 77, pullRequestNo: 7 });
  assert.equal(gh.state.record, JSON.stringify(want, null, 2), "two-space JSON, no trailing newline, existing entry unchanged");
  assert.ok(gh.state.record!.startsWith(EXISTING_RECORD.slice(0, EXISTING_RECORD.lastIndexOf("}\n  ]") + 1)), "the existing entry's text is byte-identical");
  const w = writes(gh);
  assert.equal(w.length, 1);
  assert.match((w[0]!.body as { message: string }).message, /alice has signed the CLA in acme\/widget#7/);
  assert.ok(gh.calls.some((x) => x.method === "POST" && x.path === `/repos/${REPO}/actions/runs/99/rerun`));
});

// @spec DEPLOY-CI-015
test("a comment with other text records nothing", async () => {
  const wrong: Comment = { id: 7002, user: alice, body: "I have read the CLA and I agree", created_at: "2026-11-27T10:00:00Z" };
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [wrong], runs: [{ id: 99, conclusion: "failure" }] });
  assert.equal(await check(gh, "issue_comment", commentEvent(wrong)), 1);
  assert.equal(writes(gh).length, 0);
  assert.equal(gh.state.record, EXISTING_RECORD);
  assert.ok(!gh.calls.some((x) => x.path.endsWith("/rerun")));
});

// @spec DEPLOY-CI-015
test("a signing comment from a signed contributor or a non-contributor records nothing", async () => {
  const again: Comment = { id: 7003, user: coco, body: SIGN_PHRASE, created_at: "2026-11-27T10:00:00Z" };
  const outsider: Comment = { id: 7004, user: bob, body: SIGN_PHRASE, created_at: "2026-11-27T10:01:00Z" };
  const gh = fakeGitHub({ commits: [{ author: coco, committer: coco, name: "Coco" }], comments: [again, outsider] });
  assert.equal(await check(gh, "issue_comment", commentEvent(again)), 0);
  assert.equal(writes(gh).length, 0);
  assert.equal(gh.state.record, EXISTING_RECORD);
});

// @spec DEPLOY-CI-015
test("a recheck comment re-runs the pull request's failed run once everyone has signed", async () => {
  const recheck: Comment = { id: 7005, user: coco, body: "recheck", created_at: "2026-11-27T10:00:00Z" };
  const gh = fakeGitHub({ commits: [{ author: coco, committer: coco, name: "Coco" }], comments: [recheck], runs: [{ id: 98, conclusion: "failure" }] });
  assert.equal(await check(gh, "issue_comment", commentEvent(recheck)), 0);
  assert.ok(gh.calls.some((x) => x.path === `/repos/${REPO}/actions/runs/98/rerun`));
  // A latest run that already passed is not re-run.
  const gh2 = fakeGitHub({ commits: [{ author: coco, committer: coco, name: "Coco" }], comments: [recheck], runs: [{ id: 97, conclusion: "success" }] });
  assert.equal(await check(gh2, "issue_comment", commentEvent(recheck)), 0);
  assert.ok(!gh2.calls.some((x) => x.path.endsWith("/rerun")));
});

// @spec DEPLOY-CI-016
test("a missing branch reads as an empty record, and the first signature creates the branch and the file", async () => {
  const sign: Comment = { id: 7006, user: alice, body: SIGN_PHRASE, created_at: "2026-11-27T11:00:00Z" };
  const gh = fakeGitHub({ branch: false, record: null, commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [sign] });
  assert.equal(await check(gh, "issue_comment", commentEvent(sign)), 0);
  assert.equal(gh.state.branch, true);
  assert.equal(gh.state.record, JSON.stringify({ signedContributors: [{ name: "alice", id: 501, comment_id: 7006, created_at: "2026-11-27T11:00:00Z", repoId: 77, pullRequestNo: 7 }] }, null, 2));
  // On a pull-request event the missing record only fails the check; nothing is written.
  const gh2 = fakeGitHub({ branch: false, record: null, commits: [{ author: coco, committer: coco, name: "Coco" }] });
  assert.equal(await check(gh2, "pull_request_target", prEvent()), 1);
  assert.equal(gh2.state.branch, false);
});

// @spec DEPLOY-CI-016
test("a missing file on an existing branch is created without a SHA", async () => {
  const sign: Comment = { id: 7007, user: alice, body: SIGN_PHRASE, created_at: "2026-11-27T12:00:00Z" };
  const gh = fakeGitHub({ record: null, commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [sign] });
  assert.equal(await check(gh, "issue_comment", commentEvent(sign)), 0);
  assert.ok(!gh.calls.some((x) => x.path.endsWith("/git/refs")));
  assert.match(gh.state.record!, /"name": "alice"/);
});

// @spec DEPLOY-CI-017
test("a merged pull request is locked and not checked; a closed unmerged one is left alone", async () => {
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }] });
  assert.equal(await check(gh, "pull_request_target", prEvent("closed", true)), 0);
  assert.deepEqual(gh.calls.map((c) => `${c.method} ${c.path}`), [`PUT /repos/${REPO}/issues/7/lock`]);
  const gh2 = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }] });
  assert.equal(await check(gh2, "pull_request_target", prEvent("closed", false)), 0);
  assert.deepEqual(gh2.calls, []);
});

// @spec DEPLOY-CI-013
test("commits are read across pages", async () => {
  const commits: Commit[] = Array.from({ length: 150 }, () => ({ author: coco, committer: coco, name: "Coco" }));
  commits.push({ author: alice, committer: alice, name: "Alice" });
  const gh = fakeGitHub({ commits });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  assert.match(botComment(gh)[0]!.body, /:x: @alice/);
});

// @spec DEPLOY-CI-005
test("the cla workflow runs the script from the base ref with least privilege", () => {
  const wf = readFileSync(`${repoRoot}.github/workflows/cla.yml`, "utf8");
  const code = wf.replace(/#.*$/gm, "");
  assert.match(code, /pull_request_target:\s*\n\s*types: \[opened, synchronize, reopened, closed\]/);
  assert.match(code, /issue_comment:\s*\n\s*types: \[created\]/);
  assert.match(code, /^jobs:\s*\n {2}cla:/m, "the job, and so the check, is named cla");
  const perms = /^permissions:\n((?: {2}.*\n)+)/m.exec(code)?.[1] ?? "";
  assert.deepEqual(perms.trim().split("\n").map((l) => l.trim()).toSorted(), ["actions: write", "contents: write", "pull-requests: write"]);
  const uses = [...code.matchAll(/uses: (\S+)@/g)].map((m) => m[1]);
  assert.deepEqual(uses, ["actions/checkout", "jdx/mise-action"]);
  assert.doesNotMatch(code, /head\.(?:sha|ref)|refs\/pull|github\.head_ref/, "never checks out the pull request's code");
  assert.match(code, /persist-credentials: false/);
  assert.match(code, /- uses: actions\/checkout@\S+\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}\n/, "checks out the workflow's own base commit");
  assert.match(code, /- uses: jdx\/mise-action@\S+\n\s+with:\n(?:\s+\S+: .*\n)*?\s+cache: false\n/, "a privileged job uses no cache");
  for (const m of code.matchAll(/^\s*(?:- )?run: (.*)$/gm)) assert.doesNotMatch(m[1]!, /\$\{\{\s*github\.event/, "no event text is interpolated into a run step");
  assert.match(code, /install_args: node\n/);
  assert.match(code, /run: MISE_TASK_RUN_AUTO_INSTALL=false mise run cla\n/);
  assert.match(code, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(code, /cancel-in-progress: false/);
  assert.doesNotMatch(code, /contributor-assistant/);
  const mise = readFileSync(`${repoRoot}mise.toml`, "utf8");
  assert.match(mise, /^\[tasks\.cla\]\n(?:.*\n)*?run = "node scripts\/cla\/cla\.mjs"$/m, "mise run cla runs the script");
});

// @spec DEPLOY-CI-014
test("an unlinked author name is shown as an escaped code span that cannot mention, link or inject HTML", async () => {
  const evil = "@CoderCoco `x` [click](https://evil.example) <img src=x onerror=alert(1)>";
  const gh = fakeGitHub({ commits: [{ author: null, committer: null, name: evil }] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  const body = botComment(gh)[0]!.body;
  assert.ok(!body.includes(evil), "the raw name never appears");
  assert.doesNotMatch(body, /@CoderCoco/, "no mention survives");
  assert.ok(body.includes("`@​CoderCoco x [click](https://evil.example) <img src=x onerror=alert(1)>`"), "the name sits in one code span, backticks removed, @ neutralised");
});

// @spec DEPLOY-CI-013
test("a pull request of more than 250 commits fails and says so rather than checking the first 250", async () => {
  const commits: Commit[] = Array.from({ length: 251 }, () => ({ author: coco, committer: coco, name: "Coco" }));
  const gh = fakeGitHub({ commits });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  assert.match(botComment(gh)[0]!.body, /251 commits/);
  // On a comment event the count comes from the pull request itself.
  const recheck: Comment = { id: 7010, user: coco, body: "recheck", created_at: "2026-11-27T10:00:00Z" };
  const gh2 = fakeGitHub({ commits, comments: [recheck] });
  assert.equal(await check(gh2, "issue_comment", commentEvent(recheck)), 1);
  // Exactly 250 is checked as usual.
  const gh3 = fakeGitHub({ commits: commits.slice(0, 250) });
  assert.equal(await check(gh3, "pull_request_target", prEvent()), 0);
});

// @spec DEPLOY-CI-016
test("a write rejected with 409 or 422 is retried from a fresh read", async () => {
  for (const status of [409, 422]) {
    const sign: Comment = { id: 7011, user: alice, body: SIGN_PHRASE, created_at: "2026-11-27T13:00:00Z" };
    const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [sign], putFailures: [status] });
    assert.equal(await check(gh, "issue_comment", commentEvent(sign)), 0, `after a ${status}`);
    assert.equal(writes(gh).length, 2);
    assert.match(gh.state.record!, /"name": "alice"/);
  }
  // Three rejections in a row give up and fail the run.
  const sign: Comment = { id: 7012, user: alice, body: SIGN_PHRASE, created_at: "2026-11-27T13:00:00Z" };
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [sign], putFailures: [409, 422, 409] });
  await assert.rejects(check(gh, "issue_comment", commentEvent(sign)));
});

// @spec DEPLOY-CI-016
test("a branch created by another run in between (422 Reference already exists) counts as created", async () => {
  const sign: Comment = { id: 7013, user: alice, body: SIGN_PHRASE, created_at: "2026-11-27T14:00:00Z" };
  const gh = fakeGitHub({ branch: false, record: null, refRace: true, commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [sign] });
  assert.equal(await check(gh, "issue_comment", commentEvent(sign)), 0);
  assert.match(gh.state.record!, /"name": "alice"/);
});

// @spec DEPLOY-CI-013
test("signatures match by account id: a renamed account stays signed, a new account with the recorded login does not", async () => {
  const renamed: User = { login: "CocoRenamed", id: coco.id };
  const gh = fakeGitHub({ commits: [{ author: renamed, committer: renamed, name: "Coco" }] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 0);
  const impostor: User = { login: "CoderCoco", id: 999999 };
  const gh2 = fakeGitHub({ commits: [{ author: impostor, committer: impostor, name: "Coco" }] });
  assert.equal(await check(gh2, "pull_request_target", prEvent()), 1);
});

// @spec DEPLOY-CI-015
test("a signing comment authored by the bot's account records nothing", async () => {
  const fromBot: Comment = { id: 7014, user: ghBot, body: SIGN_PHRASE, created_at: "2026-11-27T15:00:00Z" };
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [fromBot] });
  assert.equal(await check(gh, "issue_comment", commentEvent(fromBot)), 1);
  assert.equal(writes(gh).length, 0);
});

// @spec DEPLOY-CI-014
test("a comment by someone else that carries the marker is never the one updated", async () => {
  const planted: Comment = { id: 60, user: bob, body: `${MARKER} planted`, created_at: "2026-11-27T00:00:00Z" };
  const gh = fakeGitHub({ commits: [{ author: alice, committer: alice, name: "Alice" }], comments: [planted] });
  assert.equal(await check(gh, "pull_request_target", prEvent()), 1);
  assert.equal(planted.body, `${MARKER} planted`);
  assert.ok(!gh.calls.some((x) => x.method === "PATCH"));
  assert.equal(botComment(gh).length, 1);
});
