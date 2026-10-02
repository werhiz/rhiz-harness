import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventLedger } from "../src/ledger.js";
import { closeOrphanedAttempts, summarizeOperatorWork } from "../src/operator.js";
import type { HarnessEvent } from "../src/schemas.js";
import {
  event,
  passingVerificationSequence,
  successfulExecution,
  verifier,
  verificationStart,
  work,
} from "./helpers.js";

function reviewedContract(maxAttempts = 3) {
  const contract = work();
  return work({
    workerPolicy: { ...contract.workerPolicy, maxAttempts },
    verificationPolicy: { ...contract.verificationPolicy, reviewRequired: true },
  });
}

function assertUnverifiedAction(events: readonly HarnessEvent[], action: "resume" | "none") {
  const status = summarizeOperatorWork(events);
  assert.equal(status.violations, 0);
  assert.equal(status.readiness.ready, false);
  assert.equal(status.nextAction, action);
  assert.doesNotMatch(status.nextActionReason, /^verified, waiting on an independent review/);
  return status;
}

test("review-required Work with no attempt must execute before it can be reviewed", () => {
  assertUnverifiedAction([event("work.created", { contract: reviewedContract(), revision: 1 })], "resume");
});

test("review-required execution without passing verification remains resumable", () => {
  assertUnverifiedAction(successfulExecution(reviewedContract()), "resume");
});

test("review-required Work with an orphaned attempt offers resume rather than impossible review", () => {
  const events = successfulExecution(reviewedContract()).filter((item) => item.type !== "attempt.finished");
  const status = assertUnverifiedAction(events, "resume");
  assert.equal(status.attempts.active, 1);
});

test("closing a review-required orphan preserves its recovery action", async () => {
  const ledger = new InMemoryEventLedger();
  for (const item of successfulExecution(reviewedContract()).filter((item) => item.type !== "attempt.finished")) {
    await ledger.append(item);
  }
  const closed = await closeOrphanedAttempts({ ledger, streamId: "stream:work:1" });
  assert.deepEqual(closed, ["attempt:1"]);
  const status = assertUnverifiedAction(await ledger.replay("stream:work:1"), "resume");
  assert.equal(status.attempts.failed, 1);
  assert.equal(status.attempts.active, 0);
});

test("a failed verification on review-required Work offers another bounded attempt", () => {
  const events = [
    ...successfulExecution(reviewedContract()),
    verificationStart(),
    event("verification.result", {
      verificationId: "verification:1",
      contractRevision: 1,
      status: "fail",
      criterionResults: [{ criterionId: "criterion:tests", status: "fail", evidence: [] }],
      evidenceSatisfaction: [],
      falsifiability: { provenCriteria: ["criterion:tests"], exemptedCriteria: [] },
    }, { actor: verifier }),
  ];
  const status = assertUnverifiedAction(events, "resume");
  assert.equal(status.verification.latest, "fail");
});

test("exhausted unverified Work reports its budget instead of requesting impossible review", () => {
  const status = assertUnverifiedAction(successfulExecution(reviewedContract(1)), "none");
  assert.match(status.nextActionReason, /attempt budget 1 is spent/);
});

test("qualifying verification still directs review-required Work to review", () => {
  const status = summarizeOperatorWork([
    ...successfulExecution(reviewedContract()),
    ...passingVerificationSequence(),
  ]);
  assert.equal(status.violations, 0);
  assert.equal(status.verification.latest, "pass");
  assert.equal(status.nextAction, "review");
  assert.equal(status.readiness.ready, false);
});

test("verified Work may be reviewed even after its execution budget is spent", () => {
  const status = summarizeOperatorWork([
    ...successfulExecution(reviewedContract(1)),
    ...passingVerificationSequence(),
  ]);
  assert.equal(status.violations, 0);
  assert.equal(status.attempts.total, status.attempts.budget);
  assert.equal(status.nextAction, "review");
});
