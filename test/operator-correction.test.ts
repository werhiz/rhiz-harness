import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEventLedger } from "../src/ledger.js";
import { rejectOperatorWork, summarizeOperatorWork } from "../src/operator.js";
import { RefinerBridge } from "../src/refiner-bridge.js";
import { human, worker, passingVerificationSequence, successfulExecution } from "./helpers.js";

const streamId = "stream:work:1";
const correction = { cause: "verification-gap" as const, requestedRepair: "Bind production proof to the exact generated artifact and add a stale-artifact negative control.", criterionIds: ["criterion:tests"] };
const evidence = [{ id: "capture:rejected", kind: "screenshot" as const, uri: "private://review/rejected.png", digest: "sha256:rejected-artifact" }];

async function fixture(active = false) {
  const ledger = new InMemoryEventLedger();
  const execution = successfulExecution();
  execution[0] = { ...execution[0]!, correlationId: "build:studio:real-request" };
  for (const event of [...execution.filter((e) => !active || e.type !== "attempt.finished"), ...(!active ? passingVerificationSequence() : [])]) await ledger.append(event);
  return ledger;
}

test("a human correction survives rejection and yields attributable, replayable proposals exactly once", async () => {
  const ledger = await fixture();
  // The production contract's criterion is read, never invented by the caller.
  const created = (await ledger.replay(streamId)).find((e) => e.type === "work.created")!;
  assert.equal(created.type, "work.created");
  const actual = { ...correction, criterionIds: [created.payload.contract.acceptanceCriteria[0]!.id] };
  const refiner = new RefinerBridge({ ledger });
  const result = await rejectOperatorWork({ ledger, streamId, actor: human, reason: "Technical pass missed the observed defect", correction: actual, evidence, refiner });
  assert.equal(result.status.state, "rejected");
  assert.equal(result.status.violations, 0);
  assert.ok(result.learning?.analysis.classifications.includes("verification-gap"));
  assert.ok(result.learning?.proposals.some((p) => p.kind === "test"));
  const saved = await ledger.replay(streamId);
  const rejection = saved.find((e) => e.type === "work.rejected")!;
  assert.equal(rejection.correlationId, "build:studio:real-request");
  for (const event of saved.filter((e) => e.type === "refiner.proposed")) {
    assert.equal(event.causationId, rejection.id);
    assert.equal(event.correlationId, rejection.correlationId);
    assert.ok(event.payload.proposal.evidenceRefs.some((ref) => ref.ledgerEventId === rejection.id));
    assert.deepEqual(event.payload.proposal.draft.draftPayload.correction, actual);
  }
  await new RefinerBridge({ ledger }).consume({ workId: "work:1", events: saved });
  assert.deepEqual(await ledger.replay(streamId), saved);
  assert.equal(saved.some((e) => e.type === "work.accepted" || e.type === "refiner.promoted"), false);
});

test("rejection refuses a worker, unknown criterion, missing evidence and active execution without appending", async () => {
  for (const scenario of ["worker", "criterion", "evidence", "active"] as const) {
    const ledger = await fixture(scenario === "active");
    const before = await ledger.replay(streamId);
    const created = before.find((e) => e.type === "work.created")!;
    assert.equal(created.type, "work.created");
    await assert.rejects(rejectOperatorWork({ ledger, streamId, actor: scenario === "worker" ? worker : human, reason: "rejected", correction: { ...correction, criterionIds: [scenario === "criterion" ? "foreign" : created.payload.contract.acceptanceCriteria[0]!.id] }, evidence: scenario === "evidence" ? [] : evidence }));
    assert.deepEqual(await ledger.replay(streamId), before);
  }
});

test("Harvest resumes after a partial durable proposal batch without duplicating earlier proposals", async () => {
  const ledger = await fixture();
  const original = ledger.append.bind(ledger);
  let proposals = 0;
  ledger.append = async (event) => {
    if (event.type === "refiner.proposed" && ++proposals === 2) throw new Error("simulated storage interruption");
    await original(event);
  };
  const created = (await ledger.replay(streamId)).find((e) => e.type === "work.created")!;
  assert.equal(created.type, "work.created");
  await assert.rejects(rejectOperatorWork({ ledger, streamId, actor: human, reason: "rejected", correction: { ...correction, criterionIds: [created.payload.contract.acceptanceCriteria[0]!.id] }, evidence, refiner: new RefinerBridge({ ledger }) }), /storage interruption/);
  assert.equal(summarizeOperatorWork(await ledger.replay(streamId)).state, "rejected");
  const beforeRetry = (await ledger.replay(streamId)).filter((e) => e.type === "refiner.proposed");
  assert.equal(beforeRetry.length, 1);
  const resumed = await new RefinerBridge({ ledger }).consume({ workId: "work:1", events: await ledger.replay(streamId) });
  assert.ok(resumed.proposals.length > 0);
  assert.equal((await ledger.replay(streamId)).filter((e) => e.type === "work.rejected").length, 1);
  const afterRetry = (await ledger.replay(streamId)).filter((e) => e.type === "refiner.proposed");
  assert.equal(afterRetry.length, resumed.proposals.length);
  assert.deepEqual(afterRetry[0], beforeRetry[0]);
});
