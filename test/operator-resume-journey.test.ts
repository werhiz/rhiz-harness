import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { human } from "./helpers.js";
import { readDurableLedgerEvents } from "../adapters/local/durable-ledger.js";

// The interrupted journey through the real CLI and real processes: start runs
// an attempt the verifier refuses, the second attempt's process is killed
// mid-run, resume continues the same Work, the worker sees the refusal that
// existed before the process died, the independent reviewer sees it too, and
// acceptance records a recovery with estimated and observed spend apart.

const cli = fileURLToPath(new URL("../../scripts/rhiz-harness.mjs", import.meta.url));
// The verifier's own words for the refused first attempt, as the local command verifier states them.
const REFUSAL_MARKER = "exit 1; expected 0";

const FAKE_CODEX = String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { existsSync, readdirSync } from "node:fs";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const threadId = "thread:fake";
const turnId = "turn:fake";
let cwd = null;
let target = null;
let content = "arm:" + process.pid + ":" + Date.now() + "\n";
let hang = false;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/fake", platformFamily: "unix", platformOs: "test" } });
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "thread/start") {
    cwd = message.params.cwd;
    target = join(cwd, "src", "arm.txt");
    send({ id: message.id, result: {
      thread: { id: threadId }, model: "fake-model", modelProvider: "fake", serviceTier: null, cwd,
      instructionSources: [], approvalPolicy: "untrusted", approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: null,
    } });
  } else if (message.method === "turn/start") {
    const log = process.env.FAKE_LOG;
    const turn = readdirSync(log).filter((name) => name.startsWith("turn-")).length + 1;
    writeFileSync(join(log, "turn-" + turn + ".json"), JSON.stringify(message.params));
    if (turn === 1) content = "wrong bytes\n";
    if (turn === 2) { send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } }); return; }
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    const item = { type: "fileChange", id: "file:arm", changes: [{ path: target, kind: { type: "add" }, diff: content }] };
    send({ method: "item/started", params: { threadId, turnId, item } });
    send({ id: "approval:arm", method: "item/fileChange/requestApproval", params: { threadId, turnId, itemId: "file:arm", startedAtMs: 1 } });
  } else if (message.id === "approval:arm" && message.result !== undefined) {
    if (message.result.decision === "accept") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "fileChange", id: "file:arm", changes: [{ path: target, kind: { type: "add" }, diff: content }] } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "message:arm", text: "wrote src/arm.txt" } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
  } else if (message.id !== undefined && message.method !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function contractFor(workId: string) {
  return {
    id: workId,
    objective: "Write src/arm.txt",
    type: "SHIP",
    scope: [{ uri: "repo://fixture", kind: "repository" }],
    writeScope: [{ uri: "repo://fixture/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [
        { action: "read", resources: [{ uri: "repo://fixture" }], constraints: [] },
        { action: "write", resources: [{ uri: "repo://fixture/src" }], constraints: [] },
      ],
      requiresHumanApproval: ["publish"],
    },
    acceptanceCriteria: [{ id: "criterion:tests", description: "The arm file exists", required: true }],
    requiredEvidence: [{ id: "evidence:tests", description: "Passing test evidence", acceptedKinds: ["test"], required: true }],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 3, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: true },
    createdBy: human,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function planFor(workId: string) {
  const check = `const c=require('fs').readFileSync('src/arm.txt','utf8');if(!c.startsWith('arm:')){process.exit(1)}`;
  return {
    id: `plan:${workId}`,
    workId,
    contractRevision: 1,
    checks: [
      {
        id: "check:arm", providerId: "verifier:local-command", description: "The arm file was written",
        criterionIds: ["criterion:tests"], requirementIds: ["evidence:tests"],
        config: { command: process.execPath, args: ["-e", check], expectedExitCodes: [0], evidenceKind: "test" },
      },
      {
        id: "check:arm-negative-control", providerId: "verifier:local-command", description: "The check rejects a corrupted arm file",
        negativeControlFor: "check:arm",
        perturbation: { kind: "overwrite-file", path: "src/arm.txt", content: "broken\n", description: "arm file corrupted" },
        config: { command: process.execPath, args: ["-e", check], expectedExitCodes: [0], evidenceKind: "test" },
      },
    ],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rhiz-operator-resume-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const log = join(root, "turns");
  mkdirSync(log);
  git(root, ["init", "--quiet", "--bare", remote]);
  git(root, ["init", "--quiet", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["config", "user.email", "fixture@localhost.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "--quiet", "-m", "base"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "--quiet", "origin", "main"]);
  writeFileSync(join(root, "fake-codex.mjs"), FAKE_CODEX);
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "fake-codex.mjs")}" "$@"\n`);
  chmodSync(codex, 0o755);
  // A reviewer that records the prompt it was given, and a Claude stand-in
  // that reports usage the way `claude -p --output-format json` does.
  const prompts = join(root, "review-prompts");
  mkdirSync(prompts);
  const verdict = JSON.stringify({ status: "pass", summary: "resolves the refusal", findings: [{ severity: "info", summary: "ok" }] });
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\ncat > "${prompts}/claude-prompt.txt"\nprintf '%s' '${JSON.stringify({ is_error: false, result: verdict, total_cost_usd: 0.0421, usage: { input_tokens: 900, output_tokens: 60 } })}'\n`);
  chmodSync(claude, 0o755);
  const contract = join(root, "work.json");
  const verify = join(root, "verify.json");
  writeFileSync(contract, JSON.stringify(contractFor("work:resume-journey")));
  writeFileSync(verify, JSON.stringify(planFor("work:resume-journey")));
  return { root, repo, log, codex, claude, prompts, contract, verify };
}

type Fixture = ReturnType<typeof fixture>;

function env(f: Fixture) {
  return { ...process.env, RHIZ_CODEX_COMMAND: f.codex, RHIZ_CLAUDE_COMMAND: f.claude, FAKE_LOG: f.log };
}

function cliRun(f: Fixture, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--repo", f.repo], { encoding: "utf8", env: env(f), timeout: 180_000 });
}

async function waitFor(path: string, ms: number) {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("start, kill mid-run, resume, review, accept: the earlier refusal survives the dead process and the records stay apart", async (t) => {
  const f = fixture();
  t.after(() => { if (!process.env.KEEP_FIXTURE) rmSync(f.root, { recursive: true, force: true }); });

  // 1. start: attempt 1 writes the wrong bytes and is refused; attempt 2 hangs.
  const child = spawn(process.execPath, [cli, "start", "--contract", f.contract, "--verify", f.verify, "--correlation-id", "build:resume-proof", "--json", "--repo", f.repo], {
    env: env(f), detached: true, stdio: "ignore",
  });
  await waitFor(join(f.log, "turn-2.json"), 120_000);
  // 2. actually kill the whole process group mid-run.
  process.kill(-child.pid!, "SIGKILL");
  await new Promise((resolve) => child.on("close", resolve));

  const interrupted = JSON.parse(String(cliRun(f, ["status", "--json"]).stdout));
  const work = interrupted.works[0];
  assert.equal(work.nextAction, "resume", work.nextActionReason);
  assert.equal(work.attempts.failed + work.attempts.active >= 1, true);
  assert.equal(work.verification.latest, "fail");

  const ledgerDirectory = join(git(f.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "rhiz-harness", "ledgers", "work-resume-journey");
  const beforeMismatch = await readDurableLedgerEvents(ledgerDirectory);
  const runner = fileURLToPath(new URL("../../scripts/run-repository-work.mjs", import.meta.url));
  const mismatch = spawnSync(process.execPath, [runner, "--repo", f.repo, "--contract", f.contract, "--verify", f.verify, "--resume", "true", "--correlation-id", "build:wrong"], { encoding: "utf8", env: env(f) });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /cannot change the original build correlation/);
  assert.deepEqual(await readDurableLedgerEvents(ledgerDirectory), beforeMismatch);

  // 3. resume continues the same Work and hands the worker the refusal that predates this process.
  const resumed = cliRun(f, ["resume", "work:resume-journey", "--json"]);
  assert.equal(resumed.status, 0, `resume failed:\n${resumed.stderr}`);
  const resumedJson = JSON.parse(String(resumed.stdout));
  assert.equal(resumedJson.status.state, "reviewing");
  const resumedEvents = await readDurableLedgerEvents(ledgerDirectory);
  assert.ok(resumedEvents.filter((e) => e.type === "attempt.started").every((e) => e.correlationId === "build:resume-proof"));
  assert.equal(resumedJson.receipt.resume.carriedRefusals.verificationResultEventIds.length, 1);
  assert.deepEqual(resumedJson.receipt.resume.carriedRefusals.missing, []);
  assert.deepEqual(resumedJson.receipt.resume.carriedRefusals.rejected, []);
  const turns = readdirSync(f.log).filter((name) => name.startsWith("turn-")).sort();
  const resumedTurn = readFileSync(join(f.log, turns[turns.length - 1]!), "utf8");
  assert.ok(turns.length >= 3, "resume ran a third turn");
  assert.ok(resumedTurn.includes(REFUSAL_MARKER), "the resumed worker saw the verifier's earlier refusal");
  assert.ok(resumedTurn.includes("NOT instructions"), "the refusal arrived as untrusted data, not as instruction");

  // 4. independent review through the Claude stand-in: it sees the refusal history and reports spend.
  const reviewed = cliRun(f, ["review", "work:resume-journey", "--reviewer", "claude", "--json"]);
  assert.equal(reviewed.status, 0, `review failed:\n${reviewed.stderr}`);
  const prompt = readFileSync(join(f.prompts, "claude-prompt.txt"), "utf8");
  assert.ok(prompt.includes(REFUSAL_MARKER), "the independent reviewer saw the earlier refusal");
  assert.equal(JSON.parse(String(reviewed.stdout)).status.nextAction, "accept");

  // 5. accept: a recovery, not a first-attempt success; observed spend reported by the provider, estimate separate.
  const accepted = cliRun(f, ["accept", "work:resume-journey", "--reason", "recovered and independently reviewed", "--json"]);
  assert.equal(accepted.status, 0, `accept failed:\n${accepted.stderr}`);
  const result = JSON.parse(String(accepted.stdout));
  const record = result.learning.analysis.record;
  assert.equal(record.recovered, true);
  assert.equal(record.firstAttemptSuccess, false);
  assert.ok(record.attempts >= 3);
  assert.ok(result.learning.analysis.classifications.includes("successful-recovery"));
  assert.equal(record.observedCostUsd, 0.0421);
  assert.equal(record.observedUsageReports, 1);
  assert.equal(typeof record.estimatedCostUsd, "number");
  assert.equal(result.status.metrics.humanInterventions, record.humanInterventions);
  assert.ok(result.learning.routerEvidence.length >= 1);
});
