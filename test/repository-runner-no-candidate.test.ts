import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { human } from "./helpers.js";

// Issue #12 through the real CLI and real processes: a worker that finishes
// its turn having changed nothing is a recorded attempt outcome the operator
// can route, never a runner crash, and never a silent retry of the same blind
// attempt.

const cli = fileURLToPath(new URL("../../scripts/rhiz-harness.mjs", import.meta.url));
const WORKER_ACCOUNT = "I cannot complete this from the attached material. No files were edited.";

const FAKE_CODEX = String.raw`
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const threadId = "thread:fake";
const turnId = "turn:fake";

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/fake", platformFamily: "unix", platformOs: "test" } });
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: {
      thread: { id: threadId }, model: "fake-model", modelProvider: "fake", serviceTier: null, cwd: message.params.cwd,
      instructionSources: [], approvalPolicy: "untrusted", approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: null,
    } });
  } else if (message.method === "turn/start") {
    const log = process.env.FAKE_LOG;
    writeFileSync(join(log, "turn-" + (readdirSync(log).length + 1) + ".json"), "{}");
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "message:empty", text: ${JSON.stringify(WORKER_ACCOUNT)} } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
  } else if (message.id !== undefined && message.method !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rhiz-runner-no-candidate-"));
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

  const workId = "work:empty-attempt";
  const contract = join(root, "work.json");
  writeFileSync(contract, JSON.stringify({
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
  }));
  const check = `if(!require('fs').readFileSync('src/arm.txt','utf8').length)process.exit(1)`;
  const config = { command: process.execPath, args: ["-e", check], expectedExitCodes: [0], evidenceKind: "test" };
  const verify = join(root, "verify.json");
  writeFileSync(verify, JSON.stringify({
    id: `plan:${workId}`,
    workId,
    contractRevision: 1,
    checks: [
      { id: "check:arm", providerId: "verifier:local-command", description: "The arm file was written",
        criterionIds: ["criterion:tests"], requirementIds: ["evidence:tests"], config },
      { id: "check:arm-negative-control", providerId: "verifier:local-command", description: "The check rejects an emptied arm file",
        negativeControlFor: "check:arm",
        perturbation: { kind: "overwrite-file", path: "src/arm.txt", content: "", description: "arm file emptied" }, config },
    ],
  }));
  return { root, repo, log, codex, contract, verify };
}

test("a worker that changes nothing stops the runner cleanly with a routable receipt, not a crash or a blind retry", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const started = spawnSync(process.execPath, [cli, "start", "--contract", f.contract, "--verify", f.verify, "--json", "--repo", f.repo], {
    encoding: "utf8",
    env: { ...process.env, RHIZ_CODEX_COMMAND: f.codex, FAKE_LOG: f.log },
    timeout: 180_000,
  });

  assert.doesNotMatch(started.stderr, /candidate contains no changed paths/);
  assert.doesNotMatch(started.stderr, /AssertionError|triggerUncaughtException/, `runner crashed:\n${started.stderr}`);

  const result = JSON.parse(started.stdout);
  // The Work is not verified, so the run does not succeed, but it ends on its own receipt.
  assert.equal(result.exitCode, 1);
  assert.equal(result.receipt?.outcome, "attempt-failed");
  assert.equal(result.receipt.attempts.length, 1);
  assert.match(result.receipt.attempts[0].failure, /produced no candidate/);
  assert.match(result.receipt.attempts[0].failure, /No files were edited/);
  assert.equal(result.receipt.candidate, null);

  // One blind attempt, not the whole budget spent repeating it.
  assert.equal(readdirSync(f.log).length, 1);

  // The operator routes it, in the worker's own words, and it is not a first-attempt success.
  assert.equal(result.status.nextAction, "resume");
  assert.match(result.status.nextActionReason, /produced no candidate/);
  assert.equal(result.status.attempts.failed, 1);

  // Following that route runs the next attempt of the same Work, which ends the same way.
  const resumed = spawnSync(process.execPath, [cli, "resume", "work:empty-attempt", "--json", "--repo", f.repo], {
    encoding: "utf8",
    env: { ...process.env, RHIZ_CODEX_COMMAND: f.codex, FAKE_LOG: f.log },
    timeout: 180_000,
  });
  assert.doesNotMatch(resumed.stderr, /AssertionError|triggerUncaughtException/, `resume crashed:\n${resumed.stderr}`);
  const again = JSON.parse(resumed.stdout);
  assert.equal(again.receipt?.outcome, "attempt-failed");
  assert.equal(again.receipt.attempts[0].attemptNumber, 2);
  assert.equal(again.status.attempts.failed, 2);
  assert.equal(readdirSync(f.log).length, 2);
});
