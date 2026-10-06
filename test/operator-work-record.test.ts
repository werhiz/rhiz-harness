import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventLedger } from "../src/ledger.js";
import { acceptOperatorWork, recordOperatorReview, summarizeOperatorWork } from "../src/operator.js";
import { analyzeClosedWorkFromEvents, deriveWorkRecord } from "../src/refiner.js";
import { RefinerBridge } from "../src/refiner-bridge.js";
import { computeRouterEvidenceFromEvents } from "../src/router.js";
import { ObservedUsageSchema, type HarnessEvent } from "../src/schemas.js";
import { event, human, passingVerificationSequence, reviewer, successfulExecution, work, worker } from "./helpers.js";

// The Work record keeps four facts apart, because each answers a different
// question and a Router or Refiner that blurs them learns the wrong thing:
// first-attempt success, repair/recovery, human intervention, and estimated
// versus observed spend.

const STREAM = "stream:work:1";
let ids = 0;
const idFactory = () => `wr-${++ids}`;
const now = () => "2026-08-20T05:00:00.000Z";

async function ledgerWith(events: readonly HarnessEvent[]) {
  const ledger = new InMemoryEventLedger();
  for (const item of events) await ledger.append(item);
  return ledger;
}

function acceptedEvents(extra: readonly HarnessEvent[] = []): HarnessEvent[] {
  return [
    ...successfulExecution(),
    ...extra,
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "verified", contractRevision: 1 }),
  ];
}

function failedFirstAttempt(): HarnessEvent[] {
  return [
    event("task.created", { objective: "First try" }, { taskId: "task:0" }),
    event("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:0", attemptId: "attempt:0", actor: worker }),
    event("attempt.failed", { reason: "tests failed", recoverable: true }, { taskId: "task:0", attemptId: "attempt:0", actor: worker }),
  ];
}

test("record: an accepted Work with one clean attempt is a first-attempt success and not a recovery", () => {
  const record = deriveWorkRecord(acceptedEvents());
  assert.equal(record.firstAttemptSuccess, true);
  assert.equal(record.recovered, false);
  assert.equal(record.attempts, 1);
  const analysis = analyzeClosedWorkFromEvents("work:1", acceptedEvents());
  assert.ok(analysis.classifications.includes("high-quality-first-attempt"));
  assert.equal(analysis.record.firstAttemptSuccess, true);
});

test("record: acceptance after a failed attempt is a recovery and never a first-attempt success", () => {
  const events = [...successfulExecution().slice(0, 1), ...failedFirstAttempt(), ...successfulExecution().slice(1), ...passingVerificationSequence(), event("work.accepted", { reason: "recovered", contractRevision: 1 })];
  const record = deriveWorkRecord(events);
  assert.equal(record.recovered, true);
  assert.equal(record.firstAttemptSuccess, false);
  assert.equal(record.attempts, 2);
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.ok(analysis.classifications.includes("successful-recovery"));
  assert.ok(!analysis.classifications.includes("high-quality-first-attempt"));
});

test("record: a failed verification followed by a pass on the same attempt count is still a recovery", () => {
  const events = acceptedEvents([
    ...passingVerificationSequence(undefined, 1, "verification:0").slice(0, 1),
    event("verification.result", {
      verificationId: "verification:0",
      contractRevision: 1,
      status: "fail",
      criterionResults: [{ criterionId: "criterion:tests", status: "fail", evidence: [{ id: "proof:fail", kind: "test", digest: "sha256:def" }] }],
      evidenceSatisfaction: [],
      falsifiability: { provenCriteria: [], exemptedCriteria: [] },
    }, { actor: { id: "agent:verifier", kind: "verifier" } }),
  ]);
  const record = deriveWorkRecord(events);
  assert.equal(record.recovered, true);
  assert.equal(record.firstAttemptSuccess, false);
});

test("record: human interventions are counted apart from the two judgment calls and from recovery", () => {
  const events = acceptedEvents([
    event("work.parked", { reason: "waiting on a human answer" } as never, { actor: human }),
  ]);
  const record = deriveWorkRecord(events);
  assert.equal(record.humanInterventions, 1);
  // A human intervention does not make the Work a repair: nothing failed.
  assert.equal(record.recovered, false);
  assert.equal(deriveWorkRecord(acceptedEvents()).humanInterventions, 0);
});

test("record: a Router estimate is never reported as observed spend", () => {
  const estimate = event("router.decision-made", {
    decisionId: "decision:1",
    policy: "cheapest-capable",
    selectedWorkerId: worker.id,
    consideredCount: 1,
    evidenceHash: "evidence:none",
    expectedCostUsd: 0.25,
    expectedDurationMs: 1000,
  });
  const record = deriveWorkRecord(acceptedEvents([estimate]));
  assert.equal(record.estimatedCostUsd, 0.25);
  assert.equal(record.observedCostUsd, null, "nothing was reported, so nothing was observed");
  assert.equal(record.observedUsageReports, 0);
});

test("record: provider-reported usage is observed spend, summed, and kept apart from the estimate", async () => {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] } });
  const ledger = await ledgerWith([...successfulExecution(contract), ...passingVerificationSequence()]);
  await recordOperatorReview({
    ledger, streamId: STREAM, reviewer, status: "pass", summary: "fine", now, idFactory,
    observedUsage: { source: "provider-reported", costUsd: 0.4321, inputTokens: 1200, outputTokens: 80 },
  });
  const status = summarizeOperatorWork(await ledger.replay(STREAM));
  assert.equal(status.metrics.observedCostUsd, 0.4321);
  assert.equal(status.metrics.observedUsageReports, 1);
  assert.equal(status.metrics.estimatedCostUsd, 0);

  const refiner = new RefinerBridge({ ledger, idFactory, now });
  const result = await acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "ok", now, idFactory, refiner });
  assert.equal(result.learning.analysis?.record?.observedCostUsd, 0.4321);
  assert.equal(result.learning.analysis?.record?.estimatedCostUsd, 0);
});

test("record: a review that reported nothing leaves observed spend null, not zero", async () => {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] } });
  const ledger = await ledgerWith([...successfulExecution(contract), ...passingVerificationSequence()]);
  await recordOperatorReview({ ledger, streamId: STREAM, reviewer, status: "pass", summary: "fine", now, idFactory });
  const status = summarizeOperatorWork(await ledger.replay(STREAM));
  assert.equal(status.metrics.observedCostUsd, null);
});

test("record: observed usage must carry a reported value, and no estimate can be dressed as one", () => {
  assert.throws(() => ObservedUsageSchema.parse({ source: "provider-reported" }));
  assert.throws(() => ObservedUsageSchema.parse({ source: "router-estimate", costUsd: 1 }));
  assert.throws(() => ObservedUsageSchema.parse({ source: "provider-reported", costUsd: -1 }));
  assert.equal(ObservedUsageSchema.parse({ source: "provider-reported", inputTokens: 5 }).inputTokens, 5);
});

test("router: evidence cost comes only from provider-reported attempt usage, never from the estimate", () => {
  const estimate = event("router.decision-made", {
    decisionId: "decision:1", policy: "cheapest-capable", selectedWorkerId: worker.id, consideredCount: 1,
    evidenceHash: "evidence:none", expectedCostUsd: 9, expectedDurationMs: 1,
  });
  const withoutUsage = computeRouterEvidenceFromEvents([...successfulExecution(), estimate, ...passingVerificationSequence(), event("work.accepted", { reason: "ok", contractRevision: 1 })]);
  const credited = withoutUsage.find((item) => item.workerId === worker.id);
  assert.equal(credited?.successCount, 1);
  assert.equal(credited?.medianCostUsd, null, "an estimate is not evidence");

  const reported = successfulExecution().map((item) => item.type === "attempt.finished"
    ? event("attempt.finished", { resultSummary: "Implementation complete", artifactRefs: [], observedUsage: { source: "provider-reported", costUsd: 0.07 } }, { taskId: "task:1", attemptId: "attempt:1", actor: worker })
    : item);
  const withUsage = computeRouterEvidenceFromEvents([...reported, estimate, ...passingVerificationSequence(), event("work.accepted", { reason: "ok", contractRevision: 1 })]);
  assert.equal(withUsage.find((item) => item.workerId === worker.id)?.medianCostUsd, 0.07);
});
