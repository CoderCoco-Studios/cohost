import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildProgress, StackController, containerService, defaultExec, NO_PROVISION, type ExecFile } from "../src/index.js";

/**
 * What `docker compose --progress plain up -d --build --remove-orphans` prints for a two-service project: one service's
 * build is all cache hits, the other runs a two-stage build; then Compose recreates and starts the containers. Shaped
 * like BuildKit's plain progress (vertex numbers, `[target stage n/m]` names, CACHED/DONE ends) and Compose's plain
 * container lines.
 */
const SUCCESS = `#0 building with "default" instance using docker driver

#1 [chat internal] load build definition from Dockerfile
#1 transferring dockerfile: 1.20kB done
#1 DONE 0.0s

#2 [voice internal] load build definition from Dockerfile
#2 transferring dockerfile: 2.31kB done
#2 DONE 0.0s

#3 [chat auth] library/node:pull token for registry-1.docker.io
#3 DONE 0.0s

#4 [chat 1/3] FROM docker.io/library/node:24-slim@sha256:abc
#4 CACHED

#5 [chat 2/3] COPY package.json ./
#5 CACHED

#6 [chat 3/3] RUN pnpm install --frozen-lockfile
#6 CACHED

#7 [voice deps 1/2] FROM docker.io/nvidia/cuda:12.8.0-runtime
#7 DONE 41.2s

#8 [voice deps 2/2] RUN pip install -r requirements.txt
#8 0.512 Collecting torch==2.8.0
#8 31.04 Successfully installed torch-2.8.0
#8 DONE 31.9s

#9 [voice 1/1] COPY --from=deps /opt/venv /opt/venv
#9 DONE 2.1s

#10 exporting to image
#10 naming to docker.io/library/cohost-voice done
#10 DONE 3.0s
 Container cohost-redis-1  Recreate
 Container cohost-redis-1  Recreated
 Container cohost-voice-1  Recreate
 Container cohost-voice-1  Recreated
 Container cohost-redis-1  Starting
 Container cohost-redis-1  Started
 Container cohost-voice-1  Starting
 Container cohost-voice-1  Started
`;

const FAILURE = `#1 [voice internal] load build definition from Dockerfile
#1 DONE 0.0s

#2 [voice 1/4] FROM docker.io/nvidia/cuda:12.8.0-runtime
#2 CACHED

#3 [voice 2/4] RUN pip install -r requirements.txt
#3 0.401 Collecting torch==9.9.9
#3 1.230 ERROR: Could not find a version that satisfies the requirement torch==9.9.9
#3 1.231 ERROR: No matching distribution found for torch==9.9.9
#3 ERROR: process "/bin/sh -c pip install -r requirements.txt" did not complete successfully: exit code: 1
------
 > [voice 2/4] RUN pip install -r requirements.txt:
1.231 ERROR: No matching distribution found for torch==9.9.9
------
failed to solve: process "/bin/sh -c pip install -r requirements.txt" did not complete successfully: exit code: 1
`;

const feed = (text: string): BuildProgress => {
  const p = new BuildProgress();
  for (const l of text.split("\n")) p.push(l);
  return p;
};

// @spec CTRL-STACK-022
test("parser: rows per service in first-seen order; all-cached is cached, a multi-stage build counts every stage's steps", () => {
  const p = feed(SUCCESS);
  const rows = p.rows();
  assert.deepEqual(rows.map((r) => r.service), ["chat", "voice"]);
  assert.deepEqual(rows[0], { service: "chat", state: "cached", step: 3, of: 3, total: 3, current: "RUN pnpm install --frozen-lockfile", done: 3, cached: 3 });
  assert.equal(rows[1]!.state, "built");
  assert.equal(rows[1]!.total, 3); // deps 2 + final stage 1
  assert.equal(rows[1]!.done, 3);
  assert.equal(rows[1]!.cached, 0);
  assert.equal(p.failure(), undefined);
});

// @spec CTRL-STACK-022
test("parser: a running step shows building with its step, total and text; unknown lines change nothing", () => {
  const p = new BuildProgress();
  assert.equal(p.push("#0 building with \"default\" instance using docker driver"), false);
  assert.equal(p.push("random noise"), false);
  assert.equal(p.push("#4 [eyes 2/5] RUN apt-get update && apt-get install -y libgl1 " + "x".repeat(200)), true);
  const [row] = p.rows();
  assert.equal(row!.service, "eyes");
  assert.equal(row!.state, "building");
  assert.equal(row!.step, 2);
  assert.equal(row!.of, 5);
  assert.equal(row!.total, 5);
  assert.equal(row!.done, 0);
  assert.equal(row!.current!.length, 120);
  p.push("#4 DONE 1.0s");
  p.push("#4 DONE 1.0s"); // counted once
  assert.equal(p.rows()[0]!.done, 1);
  assert.equal(p.rows()[0]!.state, "building"); // 1 of 5
});

// @spec CTRL-STACK-022
test("parser: a Compose `Built` line marks the service built", () => {
  const p = new BuildProgress();
  p.push("#4 [eyes 2/5] RUN make");
  p.push(" Service eyes  Built");
  assert.equal(p.rows()[0]!.state, "built");
});

// @spec CTRL-STACK-023
test("parser: a step error fails its service and keeps the step's last output lines and the error line", () => {
  const p = feed(FAILURE);
  assert.equal(p.rows()[0]!.state, "failed");
  assert.deepEqual(p.failure(), {
    service: "voice",
    lines: [
      "Collecting torch==9.9.9",
      "ERROR: Could not find a version that satisfies the requirement torch==9.9.9",
      "ERROR: No matching distribution found for torch==9.9.9",
      "ERROR: process \"/bin/sh -c pip install -r requirements.txt\" did not complete successfully: exit code: 1",
    ],
  });
  const q = new BuildProgress();
  for (let i = 0; i < 15; i++) q.push(`#3 0.${i} line ${i}`);
  q.push("#3 ERROR: boom");
  assert.equal(q.failure()!.service, undefined); // vertex 3 belongs to no service
  assert.deepEqual(q.failure()!.lines, [...Array.from({ length: 10 }, (_, i) => `line ${i + 5}`), "ERROR: boom"]);
});

// @spec CTRL-STACK-024
test("parser: container lines are recorded as touched and end every build still running; names resolve to services", () => {
  const p = new BuildProgress();
  p.push("#4 [eyes 2/5] RUN make");
  p.push(" ✔ Container cohost-redis-1  Recreated");
  assert.deepEqual(p.touched(), ["cohost-redis-1"]);
  assert.equal(p.rows()[0]!.state, "built");
  assert.equal(containerService("cohost-redis-1", ["redis", "cortex"]), "redis");
  assert.equal(containerService("my-proj-connector-discord-12", ["connector-discord", "discord"]), "connector-discord");
  assert.equal(containerService("redis", ["redis"]), "redis");
  assert.equal(containerService("cohost-other-1", ["redis"]), undefined);
  assert.deepEqual(feed(SUCCESS).touched(), ["cohost-redis-1", "cohost-voice-1"]);
});

/** A StackController whose `up` streams `chunks` through `onOutput` and then succeeds or fails. */
function streaming(chunks: string[], fail?: { stderr: string }) {
  const seen: Array<{ args: string[]; hasOnOutput: boolean }> = [];
  const lines: Array<[string, string]> = [];
  const exec: ExecFile = async (_file, args, opts) => {
    seen.push({ args, hasOnOutput: typeof opts.onOutput === "function" });
    if (args.includes("up")) {
      for (const c of chunks) opts.onOutput?.(c);
      if (fail) throw Object.assign(new Error("exit 1"), { stderr: fail.stderr, stdout: "" });
      return { stdout: "", stderr: "" };
    }
    if (args.includes("ps")) return { stdout: JSON.stringify([{ Service: "redis", State: "running", Health: "healthy" }]), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const stack = new StackController({
    provision: NO_PROVISION, exec, cwd: mkdtempSync(join(tmpdir(), "cohost-bp-")), env: {}, onPath: (n) => n === "docker",
    now: () => 0, sleep: async () => {}, onOutput: (k, l) => { lines.push([k, l]); if (l === "THROW") throw new Error("callback broke"); },
  });
  return { stack, seen, lines };
}

// @spec CTRL-STACK-002
test("launch: runs compose with --progress plain before up", async () => {
  const h = streaming([]);
  await h.stack.launch();
  assert.deepEqual(h.seen[0]!.args, ["compose", "--progress", "plain", "up", "-d", "--build", "--remove-orphans"]);
});

// @spec CTRL-STACK-002
test("launch: a failed up reports the last non-empty line it printed, not the start of its output", async () => {
  const h = streaming(["#1 [voice 1/2] RUN x\n", "#1 ERROR: bad\n", "failed to solve: process did not complete\n\n"], { stderr: "#1 [voice 1/2] RUN x\n#1 ERROR: bad\nfailed to solve: process did not complete\n\n" });
  const r = await h.stack.launch();
  assert.deepEqual(r, { ok: false, detail: "failed to solve: process did not complete" });
});

// @spec CTRL-STACK-020
test("launch and rebuild: every output line of up reaches onOutput in order, split on \\n and \\r, partial lines joined, empty dropped; a throwing callback is ignored", async () => {
  const h = streaming(["#1 [chat 1/2] FR", "OM node\r\n#1 DONE 0.1s   \n\n", "THROW\n", " Container cohost-chat-1  Started"]);
  const r = await h.stack.launch();
  assert.equal(r.ok, true);
  assert.deepEqual(h.lines, [["launch", "#1 [chat 1/2] FROM node"], ["launch", "#1 DONE 0.1s"], ["launch", "THROW"], ["launch", " Container cohost-chat-1  Started"]]);
  h.lines.length = 0;
  await h.stack.rebuild();
  assert.equal(h.lines[0]![0], "rebuild");
  // Only `up` streams: the status probes get no onOutput.
  assert.ok(h.seen.filter((c) => c.args.includes("ps")).every((c) => !c.hasOnOutput));
  assert.ok(h.seen.filter((c) => c.args.includes("up")).every((c) => c.hasOnOutput));
});

// @spec CTRL-STACK-021
test("defaultExec with onOutput forwards both streams as they arrive and keeps only a 64 KiB tail of each", async () => {
  const chunks: string[] = [];
  const script = "process.stdout.write('o'.repeat(100000) + 'END-OUT'); process.stderr.write('e'.repeat(100000) + 'END-ERR');";
  const r = await defaultExec(process.execPath, ["-e", script], { env: process.env, onOutput: (c) => chunks.push(c) });
  const all = chunks.join("");
  assert.ok(all.includes("END-OUT") && all.includes("END-ERR"));
  assert.equal(all.length, 200014);
  assert.equal(r.stdout.length, 65536);
  assert.ok(r.stdout.endsWith("END-OUT"));
  assert.equal(r.stderr.length, 65536);
  assert.ok(r.stderr.endsWith("END-ERR"));
  await assert.rejects(
    defaultExec(process.execPath, ["-e", "process.stderr.write('x'.repeat(70000) + 'LAST'); process.exit(3)"], { env: process.env, onOutput: () => {} }),
    (err: { stderr: string }) => err.stderr.length === 65536 && err.stderr.endsWith("LAST"),
  );
});

// @spec CTRL-STACK-008
test("status: carries each container's ID as id when Compose reports one", async () => {
  const exec: ExecFile = async () => ({ stdout: JSON.stringify([{ ID: "abc123", Service: "redis", State: "running", Health: "" }, { Service: "cortex", State: "exited", ExitCode: 1 }]), stderr: "" });
  const st = await new StackController({ provision: NO_PROVISION, exec, cwd: tmpdir(), env: {}, onPath: (n) => n === "docker" }).status();
  assert.deepEqual(st.services, [{ service: "redis", status: "running", id: "abc123" }, { service: "cortex", status: "exited", exitCode: 1 }]);
});
