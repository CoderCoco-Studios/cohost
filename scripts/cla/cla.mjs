#!/usr/bin/env node
/**
 * The `cla` workflow's check (deployment design, "Licensing and contribution").
 *
 * Every contributor to a pull request must have signed CLA.md. The workflow runs this script from the base
 * repository's own commit on `pull_request_target` and `issue_comment`, so the code holding the write token is
 * never the pull request's. It uses only Node's built-ins and the GitHub REST API through GITHUB_TOKEN.
 *
 * The signature record is `.github/cla/signatures.json` on the `cla-signatures` branch, in the format the earlier
 * CLA Assistant Lite action wrote, so every existing signer stays signed.
 *
 * Exit status: 0 when every contributor has signed (or nothing was checked), 1 otherwise.
 */
// @spec DEPLOY-CI-013, DEPLOY-CI-014, DEPLOY-CI-015, DEPLOY-CI-016, DEPLOY-CI-017
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SIGN_PHRASE = "I have read the CLA Document and I hereby sign the CLA";
/** `github-actions[bot]`'s account id: the one contributor skipped, matched by id, never by name. */
export const BOT_ID = 41898282;
/** Marks the check's own comment so a later run updates it instead of posting another. */
export const MARKER = "<!-- cohost-cla -->";
/** The earlier action's comments carried this text; a pull request that has one gets it updated in place. */
const LEGACY_MARKER = "CLA Assistant Lite bot";
export const BRANCH = "cla-signatures";
export const RECORD_PATH = ".github/cla/signatures.json";
const PER_PAGE = 100;
const WRITE_ATTEMPTS = 3;
/** The most commits the REST API lists for one pull request. */
export const MAX_COMMITS = 250;

/** A GitHub REST client over the given fetch. Returns parsed JSON, or null for a 404 when `allow404` is set. */
function client({ fetch, apiUrl, token, repository }) {
  const base = `${apiUrl}/repos/${repository}`;
  async function call(method, path, body, { allow404 = false, conflict = [] } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "cohost-cla",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    if (conflict.includes(res.status)) return { conflict: true, status: res.status, message: await res.text() };
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  async function all(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const items = await call("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      out.push(...items);
      if (items.length < PER_PAGE) return out;
    }
  }
  return { call, all };
}

/**
 * One contributor per commit: the author's GitHub account, else the committer's, else the author's name with no
 * account (id null). Deduplicated by account id, or by name for unlinked commits; `github-actions[bot]` skipped.
 */
export function resolveContributors(commits) {
  const seen = new Map();
  for (const c of commits) {
    const user = c.author ?? c.committer;
    const who = user ? { name: user.login, id: user.id } : { name: c.commit?.author?.name ?? "unknown", id: null };
    if (who.id === BOT_ID) continue;
    const key = who.id === null ? `name:${who.name}` : `id:${who.id}`;
    if (!seen.has(key)) seen.set(key, who);
  }
  return [...seen.values()];
}

/**
 * A name from a commit, which anyone can set, made safe for the comment: one code span with its backticks removed
 * and each `@` followed by a zero-width space, so it can neither mention anyone nor become a link or HTML.
 */
export function safeName(name) {
  const text = String(name).replace(/`/g, "").replace(/[\r\n]+/g, " ").replace(/@/g, "@\u200b").trim();
  return `\`${text || "unknown"}\``;
}

/** Splits the contributors into signed, unsigned (with an account) and unknown (no account). */
export function classify(contributors, record) {
  const ids = new Set(record.signedContributors.map((s) => s.id));
  return {
    signed: contributors.filter((c) => c.id !== null && ids.has(c.id)),
    notSigned: contributors.filter((c) => c.id !== null && !ids.has(c.id)),
    unknown: contributors.filter((c) => c.id === null),
  };
}

/** The record's text as the earlier action wrote it: two-space JSON, no trailing newline. */
export function formatRecord(record) {
  return JSON.stringify(record, null, 2);
}

export function isSignComment(body) {
  return (body ?? "").trim().toLowerCase() === SIGN_PHRASE.toLowerCase();
}

/** The check's comment, worded as the earlier action's was, with the marker that finds it again. */
export function commentBody(map, claUrl, totalCommits = 0) {
  if (totalCommits > MAX_COMMITS) {
    return `${MARKER}\n**CLA check:** This pull request has ${totalCommits} commits, more than the ${MAX_COMMITS} the GitHub API lists, so its contributors cannot all be checked. Please split it into smaller pull requests, or squash its commits, then comment **recheck**.`;
  }
  if (map.notSigned.length === 0 && map.unknown.length === 0) {
    return `${MARKER}\n**CLA check:** All contributors have signed the CLA ✍️ ✅`;
  }
  const total = map.signed.length + map.notSigned.length;
  const you = total > 1 ? "you all" : "you";
  let text = `${MARKER}\n**CLA check:** <br/>Thank you for your submission, we really appreciate it. Like many open-source projects, we ask that ${you} sign our [Contributor License Agreement](${claUrl}) before we can accept your contribution. You can sign the CLA by just posting a Pull Request Comment same as the below format.<br/>\n   - - -\n   ${SIGN_PHRASE}\n   - - -\n   `;
  if (total > 1) {
    text += `**${map.signed.length}** out of **${total}** committers have signed the CLA.`;
    for (const c of map.signed) text += `<br/>:white_check_mark: @${c.name}`;
    for (const c of map.notSigned) text += `<br/>:x: @${c.name}`;
    text += "<br/>";
  }
  if (map.unknown.length > 0) {
    const seem = map.unknown.length > 1 ? "seem" : "seems";
    text += `${map.unknown.map((c) => safeName(c.name)).join(", ")} ${seem} not to be a GitHub user.`;
    text += " You need a GitHub account to be able to sign the CLA. If you have already a GitHub account, please [add the email address used for this commit to your account](https://help.github.com/articles/why-are-my-commits-linked-to-the-wrong-user/#commits-are-not-linked-to-any-user).<br/>";
  }
  text += "<sub>You can retrigger this check by commenting **recheck** in this Pull Request.</sub>";
  return text;
}

/** Reads the record and its blob SHA; a missing branch or file reads as an empty record (DEPLOY-CI-016). */
async function readRecord(gh) {
  const file = await gh.call("GET", `/contents/${RECORD_PATH}?ref=${BRANCH}`, undefined, { allow404: true });
  if (!file) return { record: { signedContributors: [] }, sha: undefined };
  const record = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  if (!Array.isArray(record.signedContributors)) record.signedContributors = [];
  return { record, sha: file.sha };
}

/** Creates the `cla-signatures` branch from the default branch's head when it does not exist. */
async function ensureBranch(gh) {
  if (await gh.call("GET", `/git/ref/heads/${BRANCH}`, undefined, { allow404: true })) return;
  const repo = await gh.call("GET", "");
  const head = await gh.call("GET", `/git/ref/heads/${repo.default_branch}`);
  const made = await gh.call("POST", "/git/refs", { ref: `refs/heads/${BRANCH}`, sha: head.object.sha }, { conflict: [422] });
  // Another run created the branch between the lookup and here: that is the branch wanted.
  if (made.conflict && !/Reference already exists/i.test(made.message)) throw new Error(`POST /git/refs: HTTP 422 ${made.message}`);
}

/**
 * Records a signature for each matching comment from an unsigned contributor and writes the record back, retrying
 * on a write conflict (another pull request's run wrote it in between). Returns the record as written.
 */
async function recordSignatures(gh, ctx, contributors) {
  const comments = await gh.all(`/issues/${ctx.number}/comments`);
  for (let attempt = 1; ; attempt++) {
    const { record, sha } = await readRecord(gh);
    const { notSigned } = classify(contributors, record);
    const added = [];
    for (const c of comments) {
      if (!isSignComment(c.body) || c.user?.id === BOT_ID) continue;
      const who = notSigned.find((n) => n.id === c.user?.id);
      if (!who || added.some((a) => a.id === who.id)) continue;
      added.push({ name: c.user.login, id: c.user.id, comment_id: c.id, created_at: c.created_at, repoId: ctx.repoId, pullRequestNo: ctx.number });
    }
    if (added.length === 0) return record;
    record.signedContributors.push(...added);
    if (sha === undefined) await ensureBranch(gh);
    const names = added.map((a) => a.name).join(", ");
    const put = await gh.call(
      "PUT",
      `/contents/${RECORD_PATH}`,
      { message: `${names} has signed the CLA in ${ctx.repository}#${ctx.number}`, content: Buffer.from(formatRecord(record)).toString("base64"), branch: BRANCH, ...(sha === undefined ? {} : { sha }) },
      // 409 or 422: the file changed (or appeared) since it was read; read it again and retry.
      { conflict: attempt < WRITE_ATTEMPTS ? [409, 422] : [] },
    );
    if (!put.conflict) {
      ctx.log(`recorded: ${names}`);
      return record;
    }
  }
}

/** Creates the check's comment, or updates the one already there; posts none when all have signed and none exists. */
async function upsertComment(gh, ctx, map, totalCommits = 0) {
  const comments = await gh.all(`/issues/${ctx.number}/comments`);
  const mine = comments.find((c) => c.user?.id === BOT_ID && (c.body?.includes(MARKER) || c.body?.includes(LEGACY_MARKER)));
  const allSigned = totalCommits <= MAX_COMMITS && map.notSigned.length === 0 && map.unknown.length === 0;
  const body = commentBody(map, ctx.claUrl, totalCommits);
  if (mine) {
    if (mine.body !== body) await gh.call("PATCH", `/issues/comments/${mine.id}`, { body });
  } else if (!allSigned) {
    await gh.call("POST", `/issues/${ctx.number}/comments`, { body });
  }
}

/** Re-runs the pull request's most recent `pull_request_target` run of this workflow when it failed. */
async function rerunFailedRun(gh, ctx, headSha) {
  if (!ctx.runId) return;
  const self = await gh.call("GET", `/actions/runs/${ctx.runId}`);
  const runs = await gh.call("GET", `/actions/workflows/${self.workflow_id}/runs?event=pull_request_target&head_sha=${headSha}&per_page=1`);
  const last = runs.workflow_runs?.[0];
  if (last && last.conclusion === "failure") {
    await gh.call("POST", `/actions/runs/${last.id}/rerun`);
    ctx.log(`re-ran run ${last.id}`);
  }
}

/**
 * Runs the check for one workflow event. `fetch` is injected so tests drive it against a fake API.
 * Returns the exit status.
 */
export async function run({ eventName, event, repository, token, apiUrl = "https://api.github.com", serverUrl = "https://github.com", runId, fetch = globalThis.fetch, log = console.log }) {
  const gh = client({ fetch, apiUrl, token, repository });
  const isComment = eventName === "issue_comment";
  if (isComment && !event.issue?.pull_request) return 0;
  const number = isComment ? event.issue.number : event.pull_request.number;

  if (!isComment && event.action === "closed") {
    if (event.pull_request.merged) {
      await gh.call("PUT", `/issues/${number}/lock`);
      log(`locked #${number}`);
    }
    return 0;
  }

  const pr = isComment ? await gh.call("GET", `/pulls/${number}`) : event.pull_request;
  const headSha = pr.head.sha;
  const totalCommits = pr.commits ?? 0;
  const ctx = { number, repository, repoId: event.repository?.id, runId, log, claUrl: `${serverUrl}/${repository}/blob/main/CLA.md` };
  if (totalCommits > MAX_COMMITS) {
    await upsertComment(gh, ctx, { signed: [], notSigned: [], unknown: [] }, totalCommits);
    log(`${totalCommits} commits: more than the ${MAX_COMMITS} the API lists; not checked`);
    return 1;
  }
  const contributors = resolveContributors(await gh.all(`/pulls/${number}/commits`));
  const record = isComment ? await recordSignatures(gh, ctx, contributors) : (await readRecord(gh)).record;
  const map = classify(contributors, record);
  await upsertComment(gh, ctx, map);
  const passed = map.notSigned.length === 0 && map.unknown.length === 0;
  log(passed ? "every contributor has signed the CLA" : `not signed: ${[...map.notSigned, ...map.unknown].map((c) => c.name).join(", ")}`);
  if (passed && isComment) await rerunFailedRun(gh, ctx, headSha);
  return passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  for (const name of ["GITHUB_TOKEN", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_REPOSITORY"]) {
    if (!env[name]) {
      console.error(`cla: ${name} is not set; this runs in the cla workflow`);
      process.exit(2);
    }
  }
  const code = await run({
    eventName: env.GITHUB_EVENT_NAME,
    event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL,
    serverUrl: env.GITHUB_SERVER_URL,
    runId: env.GITHUB_RUN_ID,
  });
  process.exit(code);
}
