import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { human } from "./helpers.js";

// End to end proof of the operator CLI: start, status, review, accept, and the
// Router reading the first accepted Work when the second Work starts.

const cli = fileURLToPath(new URL("../../scripts/rhiz-harness.mjs", import.meta.url));

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
const content = "arm:" + process.pid + ":" + Date.now() + "\n";

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

function contractFor(workId: string, reviewRequired: boolean) {
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
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired },
    createdBy: human,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

function planFor(workId: string) {
  const check = "const c=require('fs').readFileSync('src/arm.txt','utf8');if(!c.startsWith('arm:'))process.exit(1)";
  return {
    id: `plan:${workId}`,
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
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rhiz-operator-cli-"));
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
  writeFileSync(join(root, "fake-codex.mjs"), FAKE_CODEX);
  const codex = join(root, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${join(root, "fake-codex.mjs")}" "$@"\n`);
  chmodSync(codex, 0o755);
  const reviewer = (name: string, status: string) => {
    const path = join(root, name);
    const verdict = JSON.stringify({ status, summary: status === "pass" ? "looks right" : "defect found", findings: [{ severity: status === "pass" ? "info" : "high", summary: status === "pass" ? "ok" : "src/arm.txt:1 wrong" }] });
    writeFileSync(path, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${verdict}'\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const writeWork = (workId: string, reviewRequired: boolean) => {
    const contract = join(root, `${workId.replace(":", "-")}.work.json`);
    const verify = join(root, `${workId.replace(":", "-")}.verify.json`);
    writeFileSync(contract, JSON.stringify(contractFor(workId, reviewRequired)));
    writeFileSync(verify, JSON.stringify(planFor(workId)));
    return { contract, verify };
  };
  return { root, repo, codex, reviewer, writeWork };
}

function cliRun(f: ReturnType<typeof fixture>, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args, "--repo", f.repo], {
    encoding: "utf8",
    env: { ...process.env, RHIZ_CODEX_COMMAND: f.codex },
    timeout: 180_000,
  });
}

function json(result: ReturnType<typeof spawnSync>) {
  return JSON.parse(String(result.stdout));
}

test("operator CLI: start, status, review, accept, and the Router learns from the accepted Work", () => {
  const f = fixture();
  try {
    const firstId = "work:operator-one";
    const first = f.writeWork(firstId, true);

    // 1. start runs the Work to a verified candidate that needs review.
    const started = cliRun(f, ["start", "--contract", first.contract, "--verify", first.verify, "--json"]);
    assert.equal(started.status, 0, `start failed:\n${started.stderr}`);
    const startedJson = json(started);
    assert.equal(startedJson.status.state, "reviewing");
    assert.equal(startedJson.status.nextAction, "review");
    assert.equal(startedJson.receipt.composition.routerEvidence.works, 0);

    // 2. status reads the Ledger.
    const status = json(cliRun(f, ["status", "--json"]));
    assert.equal(status.schema, "rhiz/operator-status/v1");
    assert.equal(status.works.length, 1);
    assert.equal(status.works[0].workId, firstId);
    assert.deepEqual(status.unreadable, []);

    // 3. a failing review exits 1 and does not unlock acceptance.
    const failing = cliRun(f, ["review", firstId, "--reviewer-command", f.reviewer("review-fail.sh", "fail"), "--json"]);
    assert.equal(failing.status, 1, failing.stderr);
    assert.equal(json(failing).review.verdict.status, "fail");
    assert.notEqual(json(failing).status.nextAction, "accept");

    // 5. accept before any qualifying review, and with no reason, writes nothing.
    const noReason = cliRun(f, ["accept", firstId]);
    assert.notEqual(noReason.status, 0);
    assert.match(noReason.stderr, /--reason/);
    const afterNoReason = json(cliRun(f, ["status", firstId, "--json"]));
    assert.notEqual(afterNoReason.works[0].state, "accepted");
    assert.equal(afterNoReason.works[0].nextAction, "review");

    // 3. a passing review on the current revision qualifies.
    const passing = cliRun(f, ["review", firstId, "--reviewer-command", f.reviewer("review-pass.sh", "pass"), "--json"]);
    assert.equal(passing.status, 0, passing.stderr);
    const passJson = json(passing);
    assert.equal(passJson.review.verdict.status, "pass");
    assert.equal(passJson.status.nextAction, "accept");
    assert.equal(json(cliRun(f, ["status", firstId, "--json"])).works[0].nextAction, "accept");

    // 4. accept hands the outcome to the Refiner and credits the worker in Router evidence.
    const noReasonAgain = cliRun(f, ["accept", firstId]);
    assert.notEqual(noReasonAgain.status, 0);
    const accepted = cliRun(f, ["accept", firstId, "--reason", "verified", "--json"]);
    assert.equal(accepted.status, 0, `accept failed:\n${accepted.stderr}`);
    const acceptedJson = json(accepted);
    assert.equal(acceptedJson.status.state, "accepted");
    assert.equal(acceptedJson.learning.analysis.outcome, "accepted");
    assert.ok(acceptedJson.learning.routerEvidence.length >= 1);
    const credited = acceptedJson.learning.routerEvidence[0];
    assert.equal(credited.successCount, 1);
    assert.match(credited.workerId, /codex/i);

    // 6. a second Work in the same repository sees the first Work's accepted Ledger.
    const second = f.writeWork("work:operator-two", false);
    const startedTwo = cliRun(f, ["start", "--contract", second.contract, "--verify", second.verify, "--json"]);
    assert.equal(startedTwo.status, 0, `second start failed:\n${startedTwo.stderr}`);
    const twoJson = json(startedTwo);
    assert.equal(twoJson.status.state, "ready");
    assert.equal(twoJson.status.nextAction, "accept");
    assert.equal(twoJson.receipt.composition.routerEvidence.works, 1);
    assert.deepEqual(twoJson.receipt.composition.routerEvidence.unreadable, []);

    // The receipt on disk agrees with the --json output.
    const commonDir = git(f.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const receiptPath = join(commonDir, "rhiz-harness", "operator", "work-operator-two", "receipt.json");
    assert.ok(existsSync(receiptPath), receiptPath);
    assert.equal(JSON.parse(readFileSync(receiptPath, "utf8")).composition.routerEvidence.works, 1);

    // Starting the same Work id again is refused.
    const again = cliRun(f, ["start", "--contract", first.contract, "--verify", first.verify, "--json"]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already started/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("operator CLI: --help as the first argument prints usage and exits 0, as an installed binary is first run", () => {
  for (const args of [["--help"], ["-h"], ["help"], []]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /Usage: rhiz-harness <command>/);
  }
});

test("operator CLI: review refuses a diff too large to read whole, and reports a refusal file it did not carry", () => {
  const f = fixture();
  try {
    const id = "work:operator-review-limits";
    const w = f.writeWork(id, true);
    const started = cliRun(f, ["start", "--contract", w.contract, "--verify", w.verify, "--json"]);
    assert.equal(started.status, 0, started.stderr);
    const commonDir = git(f.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const ledgerDir = join(commonDir, "rhiz-harness", "ledgers", "work-operator-review-limits");
    const reviewerPath = f.reviewer("review-pass.sh", "pass");

    // A reviewer that saw only a prefix must not be able to pass the whole.
    const tooLarge = spawnSync(process.execPath, [cli, "review", id, "--reviewer-command", reviewerPath, "--repo", f.repo], {
      encoding: "utf8", env: { ...process.env, RHIZ_CODEX_COMMAND: f.codex, RHIZ_REVIEW_MAX_DIFF_BYTES: "5" },
    });
    assert.notEqual(tooLarge.status, 0);
    assert.match(tooLarge.stderr, /over the 5 byte limit/);
    assert.equal(json(cliRun(f, ["status", id, "--json"])).works[0].review.count, 0, "nothing was recorded");

    // A damaged refusal file is reported to the person and in the receipt, never silently dropped.
    mkdirSync(join(ledgerDir, "verifier-refusals"), { recursive: true });
    writeFileSync(join(ledgerDir, "verifier-refusals", "junk.json"), "{not json");
    const reviewed = cliRun(f, ["review", id, "--reviewer-command", reviewerPath, "--json"]);
    assert.equal(reviewed.status, 0, reviewed.stderr);
    const out = json(reviewed);
    assert.equal(out.review.refusalsRejected.length, 1);
    assert.match(out.review.refusalsRejected[0].reason, /unreadable/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
