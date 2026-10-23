import assert from "node:assert/strict";
import test from "node:test";
import { CrewSupervisor, parseCrewPlan, type CrewWorkspaceProvider } from "../src/crew.js";
import { FollowThroughAssignmentSchema, inspectFollowThrough } from "../src/follow-through.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import type { HarnessEvent } from "../src/schemas.js";
import { WorkerCatalog } from "../src/workers.js";
import { event, human, passingVerificationSequence, reviewer, successfulExecution, verificationStart, verifier, work } from "./helpers.js";

const observedAt = "2026-08-20T16:00:00.000Z";
function fixture(reviewRequired = false) {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired, falsifiabilityExemptions: [] } });
  const assignment = FollowThroughAssignmentSchema.parse({
    ownerRef: "account:review-fixture", sourceRef: "message:review-fixture", dueAt: "2026-08-20T15:00:00.000Z",
    priority: 50, baseRevision: "base", mission: { work: contract, workspace: { strategy: "fresh", mode: "isolated-write" } },
  });
  return { contract, assignment };
}

async function inspect(events: readonly HarnessEvent[], reviewRequired = false) {
  const ledger = new InMemoryEventLedger();
  for (const item of events) await ledger.append(item);
  const result = await inspectFollowThrough(ledger, [fixture(reviewRequired).assignment], observedAt);
  assert.equal(result.length, 1);
  return result[0]!;
}

test("follow-through separates finished execution, active verification, and verified readiness", async () => {
  const { contract } = fixture();
  const executed = successfulExecution(contract);
  assert.equal((await inspect(executed)).action, "verify");
  assert.equal((await inspect([...executed, verificationStart()])).action, "active");
  const ready = await inspect([...executed, ...passingVerificationSequence()]);
  assert.equal(ready.action, "accept");
  assert.notEqual(ready.state, "accepted");
  assert.equal(ready.overdue, true, "verification alone does not close an overdue promise");
});

test("failed verification requires repair rather than redispatch or acceptance", async () => {
  const { contract } = fixture();
  const result = await inspect([
    ...successfulExecution(contract), verificationStart(),
    event("verification.result", {
      verificationId: "verification:1", contractRevision: 1, status: "fail",
      criterionResults: [{ criterionId: "criterion:tests", status: "fail", evidence: [] }],
      evidenceSatisfaction: [], falsifiability: { provenCriteria: ["criterion:tests"], exemptedCriteria: [] },
    }, { actor: verifier }),
  ]);
  assert.equal(result.action, "resolve");
  assert.match(result.reason, /failed/);
});

test("review-required Work remains open through review and closes only on Board acceptance", async () => {
  const { contract } = fixture(true);
  const verified = [...successfulExecution(contract), ...passingVerificationSequence()];
  assert.equal((await inspect(verified, true)).action, "review");
  const reviewing = [...verified, event("review.started", { reviewId: "review:1", contractRevision: 1 }, { actor: reviewer })];
  assert.equal((await inspect(reviewing, true)).action, "active");
  const passed = [...reviewing, event("review.result", {
    reviewId: "review:1", contractRevision: 1, status: "pass", summary: "Independent review passed",
  }, { actor: reviewer })];
  assert.equal((await inspect(passed, true)).action, "accept");
  const closed = await inspect([...passed, event("work.accepted", { reason: "Independent proof accepted", contractRevision: 1 })], true);
  assert.equal(closed.action, "closed");
  assert.equal(closed.state, "accepted");
  assert.equal(closed.overdue, false);
});

test("failed independent review remains a repair decision", async () => {
  const { contract } = fixture(true);
  const result = await inspect([
    ...successfulExecution(contract), ...passingVerificationSequence(),
    event("review.started", { reviewId: "review:1", contractRevision: 1 }, { actor: reviewer }),
    event("review.result", { reviewId: "review:1", contractRevision: 1, status: "fail", summary: "Independent review found a defect" }, { actor: reviewer }),
  ], true);
  assert.equal(result.action, "resolve");
  assert.match(result.reason, /failed/);
});

test("Crew refuses a stale dispatch cursor before workspace acquisition or worker admission", async () => {
  const { contract, assignment } = fixture();
  const ledger = new InMemoryEventLedger();
  await ledger.append(event("work.created", { contract, revision: 1 }));
  let acquisitions = 0;
  const spaces: CrewWorkspaceProvider = {
    id: "workspace:cursor-fixture",
    async acquire() { acquisitions++; throw new Error("cursor failure must happen before acquisition"); },
    async snapshot() { throw new Error("unexpected snapshot"); },
    async release() {}, async close() {},
  };
  const run = await new CrewSupervisor({
    plan: parseCrewPlan({ id: "crew:cursor", objective: contract.objective, baseRevision: "base",
      missions: [{ ...assignment.mission, continuesWork: true, expectedLastEventId: null }] }),
    ledger, workspaceProvider: spaces, workerCatalog: new WorkerCatalog(), actor: human,
  }).run();
  try {
    assert.equal(acquisitions, 0);
    assert.equal(run.receipt.missions[0]!.status, "failed");
    assert.match(run.receipt.missions[0]!.error!, /changed after dispatch inspection/);
    const events = await ledger.replay("stream:work:1");
    assert.equal(events.length, 1, "cursor refusal must not append assignment or execution facts");
  } finally { await run.close(); }
});
