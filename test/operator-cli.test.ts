import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { human } from "./helpers.js";
import { readDurableLedgerEvents } from "../adapters/local/durable-ledger.js";

import { cli, git, contractFor, planFor, fixture, cliRun, json } from "./operator-cli-fixture.js";

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

test("operator CLI binds a build before execution and retains a correction across Harvest retries", async () => {
  const f = fixture();
  try {
    const workId = "work:corrected";
    const work = f.writeWork(workId, false);
    const started = cliRun(f, ["start", "--contract", work.contract, "--verify", work.verify, "--correlation-id", "build:studio:1", "--json"]);
    assert.equal(started.status, 0, started.stderr);
    const correctionPath = join(f.root, "correction.json");
    writeFileSync(correctionPath, JSON.stringify({
      correction: { cause: "verification-gap", requestedRepair: "Check the actual arm content", criterionIds: ["criterion:tests"] },
      evidence: [{ id: "observation:wrong-arm", kind: "review", uri: "private://review/1" }],
    }));
    const rejected = cliRun(f, ["reject", workId, "--reason", "The technical check missed the wrong content", "--correction", correctionPath]);
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.equal(json(rejected).status.state, "rejected");
    const directory = join(git(f.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "rhiz-harness", "ledgers", "work-corrected");
    const before = await readDurableLedgerEvents(directory);
    assert.equal(before.find((e) => e.type === "work.created")?.correlationId, "build:studio:1");
    assert.equal(before.find((e) => e.type === "work.rejected")?.correlationId, "build:studio:1");
    const harvested = cliRun(f, ["harvest", workId]);
    assert.equal(harvested.status, 0, harvested.stderr);
    assert.deepEqual(await readDurableLedgerEvents(directory), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
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
