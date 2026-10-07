import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { human } from "./helpers.js";

// Comparable benchmark arms share Work identity, task identity, and base by
// design. Each execution must still own its integration ref: the first arm
// advances its candidate ref, and the second arm must initialize, run,
// verify, and record its own receipt rather than collide with the first.

const runner = fileURLToPath(new URL("../../scripts/run-repository-work.mjs", import.meta.url));

// A minimal stdio Codex App Server: read-only thread, one Rhiz-approved file
// change that the server applies only after the client accepts it.
const FAKE_CODEX = String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const threadId = "thread:fake";
const turnId = "turn:fake";
let cwd = null;
let target = null;
let content = "arm:" + process.pid + ":" + Date.now() + "\n";
let attemptNumber = 1;

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/fake", platformFamily: "unix", platformOs: "test" } });
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "thread/start") {
    cwd = message.params.cwd;
    attemptNumber = cwd.includes("attempt-2") ? 2 : 1;
    if (process.env.RHIZ_USAGE_FIXTURE_MODE && attemptNumber === 1) content = "first candidate fails verification\n";
    target = join(cwd, "src", "arm.txt");
    send({ id: message.id, result: {
      thread: { id: threadId }, model: "fake-model", modelProvider: "fake", serviceTier: null, cwd,
      instructionSources: [], approvalPolicy: "untrusted", approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: null,
    } });
  } else if (message.method === "turn/start") {
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
    if (process.env.RHIZ_USAGE_FIXTURE_MODE) {
      const usage = { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { inputTokens: 10 * attemptNumber, outputTokens: 2 * attemptNumber }, last: { inputTokens: 1, outputTokens: 1 } } } };
      send(usage);
      send(usage);
    }
    const failed = process.env.RHIZ_USAGE_FIXTURE_MODE === "fail-second" && attemptNumber === 2;
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: failed ? "failed" : "completed", error: null } } });
  } else if (message.id !== undefined && message.method !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function remoteHead(repo: string, ref: string): string | undefined {
  return git(repo, ["ls-remote", "--refs", "origin", ref]).split("\t")[0] || undefined;
}

function fixture(usageMode?: "retry" | "fail-second") {
  const root = mkdtempSync(join(tmpdir(), "rhiz-benchmark-arms-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
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
  const base = git(repo, ["rev-parse", "HEAD"]);

  const workId = "work:benchmark-arms";
  const contract = {
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
    workerPolicy: { preferredProviders: [], maxAttempts: usageMode ? 2 : 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const check = "const c=require('fs').readFileSync('src/arm.txt','utf8');if(!c.startsWith('arm:'))process.exit(1)";
  const plan = {
    id: "plan:benchmark-arms",
    workId,
    contractRevision: 1,
    checks: [
      {
        id: "check:arm",
        providerId: "verifier:local-command",
        description: "The arm file was written",
        criterionIds: ["criterion:tests"],
        requirementIds: ["evidence:tests"],
        config: { command: process.execPath, args: ["-e", check], expectedExitCodes: [0], evidenceKind: "test" },
      },
      {
        id: "check:arm-negative-control",
        providerId: "verifier:local-command",
        description: "The check rejects a corrupted arm file",
        negativeControlFor: "check:arm",
        perturbation: { kind: "overwrite-file", path: "src/arm.txt", content: "broken\n", description: "arm file corrupted" },
        config: { command: process.execPath, args: ["-e", check], expectedExitCodes: [0], evidenceKind: "test" },
      },
    ],
  };
  writeFileSync(join(root, "work.json"), JSON.stringify(contract));
  writeFileSync(join(root, "verify.json"), JSON.stringify(plan));
  writeFileSync(join(root, "fake-codex.mjs"), FAKE_CODEX);
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "fake-codex.mjs")}" "$@"\n`);
  chmodSync(codex, 0o755);
  return { root, repo, base, workId, codex, usageMode };
}

function runArm(f: ReturnType<typeof fixture>, variant: string, extra: string[] = []) {
  const output = join(f.root, `receipt-${variant}.json`);
  const result = spawnSync(process.execPath, [
    runner,
    "--repo", f.repo,
    "--contract", join(f.root, "work.json"),
    "--verify", join(f.root, "verify.json"),
    "--base", f.base,
    "--ledger", join(f.root, "ledger"),
    "--output", output,
    ...extra,
  ], {
    encoding: "utf8",
    env: { ...process.env, RHIZ_CODEX_COMMAND: f.codex, RHIZ_USAGE_FIXTURE_MODE: f.usageMode },
    timeout: 120_000,
  });
  return { result, receipt: () => JSON.parse(readFileSync(output, "utf8")) };
}

function benchmarkArm(f: ReturnType<typeof fixture>, variant: string) {
  return runArm(f, variant, ["--benchmark-case", "case:benchmark-arms", "--benchmark-variant", variant]);
}

test("comparable benchmark arms with one Work id and base each own a distinct integration ref", () => {
  const f = fixture();
  try {
    const first = benchmarkArm(f, "baseline");
    assert.equal(first.result.status, 0, `first arm failed:\n${first.result.stderr}`);
    const a = first.receipt();
    assert.equal(a.benchmarkRun.outcome, "verified");
    const aRef: string = a.candidate.verifiedRef;
    // The first arm advanced its ref past the shared base.
    assert.notEqual(a.candidate.head, f.base);
    assert.equal(remoteHead(f.repo, aRef), a.candidate.head);

    const second = benchmarkArm(f, "treatment");
    assert.equal(second.result.status, 0, `second arm failed:\n${second.result.stderr}`);
    const b = second.receipt();
    assert.equal(b.benchmarkRun.outcome, "verified");
    assert.equal(b.verification.status, a.verification.status);
    assert.equal(b.verification.status, "pass");
    assert.equal(b.board.state, "ready");

    // Comparability is unchanged across arms.
    assert.equal(a.workId, f.workId);
    assert.equal(b.workId, f.workId);
    assert.equal(a.baseRevision, f.base);
    assert.equal(b.baseRevision, f.base);
    assert.equal(a.benchmarkRun.taskIdentity, b.benchmarkRun.taskIdentity);
    assert.equal(a.benchmarkRun.baseIdentity, b.benchmarkRun.baseIdentity);
    assert.notEqual(a.ledgerRoot, b.ledgerRoot);

    // Each arm owns its ref; the first arm's result is untouched.
    const bRef: string = b.candidate.verifiedRef;
    assert.notEqual(aRef, bRef);
    const runOf = (ledgerRoot: string) => ledgerRoot.split("/benchmark-runs/")[1];
    assert.equal(aRef, `refs/rhiz/work/work-benchmark-arms/benchmark-runs/${runOf(a.ledgerRoot)}/candidate`);
    assert.equal(bRef, `refs/rhiz/work/work-benchmark-arms/benchmark-runs/${runOf(b.ledgerRoot)}/candidate`);
    assert.equal(remoteHead(f.repo, aRef), a.candidate.head);
    assert.equal(remoteHead(f.repo, bRef), b.candidate.head);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("non-benchmark Work keeps its one Work-scoped integration ref", () => {
  const f = fixture();
  try {
    const run = runArm(f, "plain");
    assert.equal(run.result.status, 0, `plain run failed:\n${run.result.stderr}`);
    const receipt = run.receipt();
    assert.equal(receipt.candidate.verifiedRef, "refs/rhiz/work/work-benchmark-arms/candidate");
    assert.equal(remoteHead(f.repo, receipt.candidate.verifiedRef), receipt.candidate.head);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("repository benchmark counts both retry attempts even when the last worker fails before Verify", () => {
  for (const mode of ["retry", "fail-second"] as const) {
    const f = fixture(mode);
    try {
      const run = benchmarkArm(f, mode);
      assert.equal(run.result.status, mode === "retry" ? 0 : 1, run.result.stderr);
      const receipt = run.receipt();
      assert.equal(receipt.benchmarkRun.attemptIds.length, 2);
      assert.equal(receipt.benchmarkRun.outcome, mode === "retry" ? "verified" : "failed");
      assert.deepEqual(receipt.benchmarkRun.usage, { inputTokens: 30, outputTokens: 6 });
      assert.equal(receipt.benchmarkRun.measurementCoverage.usage, "provider-reported");
      const terminal = readFileSync(join(receipt.ledgerRoot, "events.jsonl"), "utf8").trim().split("\n")
        .map(line => JSON.parse(line).event).filter(event => event.type === "attempt.finished" || event.type === "attempt.failed");
      assert.equal(terminal.length, 2);
      assert.deepEqual(terminal.map(event => event.payload.observedUsage.inputTokens), [10, 20]);
      assert.equal(terminal[1].type, mode === "retry" ? "attempt.finished" : "attempt.failed");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
