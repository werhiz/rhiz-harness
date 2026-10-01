import assert from "node:assert/strict";
import test from "node:test";
import { HarnessEventSchema, WorkContractSchema } from "../src/schemas.js";
import { event, human, work, worker } from "./helpers.js";

test("WorkContract validates the canonical SHIP contract", () => {
  assert.equal(WorkContractSchema.parse(work()).type, "SHIP");
});

test("SCOUT and REVIEW cannot claim production write scope", () => {
  for (const type of ["SCOUT", "REVIEW"] as const) {
    const parsed = WorkContractSchema.safeParse({ ...work(), type });
    assert.equal(parsed.success, false);
  }
});

test("acceptance criteria and evidence requirement ids must be unique", () => {
  const base = work();
  assert.equal(
    WorkContractSchema.safeParse({
      ...base,
      acceptanceCriteria: [base.acceptanceCriteria[0], base.acceptanceCriteria[0]],
    }).success,
    false,
  );
  assert.equal(
    WorkContractSchema.safeParse({
      ...base,
      requiredEvidence: [base.requiredEvidence[0], base.requiredEvidence[0]],
    }).success,
    false,
  );
});

test("HarnessEvent runtime schema requires observation authority for activity observations", () => {
  const valid = event("attempt.activity-observed", {
    state: "working",
    source: "runtime",
    authority: "observation",
  }, { taskId: "task:1", attemptId: "attempt:1", actor: worker });
  assert.equal(valid.payload.authority, "observation");

  const invalid = HarnessEventSchema.safeParse({
    ...valid,
    payload: { ...valid.payload, authority: "canonical" },
  });
  assert.equal(invalid.success, false);
});

test("WorkContract rejects self-dependency", () => {
  const base = work();
  assert.equal(WorkContractSchema.safeParse({ ...base, dependencies: [base.id] }).success, false);
  assert.equal(base.createdBy.id, human.id);
});

test("task and attempt events require their canonical identities", () => {
  const task = event("task.created", { objective: "Do work" }, { taskId: "task:1" });
  const { taskId: _taskId, ...taskWithoutId } = task;
  assert.equal(HarnessEventSchema.safeParse(taskWithoutId).success, false);

  const attempt = event(
    "attempt.started",
    { worker, contractRevision: 1 },
    { taskId: "task:1", attemptId: "attempt:1", actor: worker },
  );
  const { attemptId: _attemptId, ...attemptWithoutId } = attempt;
  assert.equal(HarnessEventSchema.safeParse(attemptWithoutId).success, false);
});

test("a passing acceptance criterion must carry evidence", () => {
  const valid = event(
    "verification.result",
    {
      verificationId: "verification:proof",
      contractRevision: 1,
      status: "pass",
      criterionResults: [{
        criterionId: "criterion:tests",
        status: "pass",
        evidence: [{ id: "proof:1", kind: "test" }],
      }],
      evidenceSatisfaction: [],
        falsifiability: { provenCriteria: [], exemptedCriteria: [] },
    },
    { actor: worker },
  );
  const parsed = HarnessEventSchema.safeParse({
    ...valid,
    payload: {
      ...valid.payload,
      criterionResults: [{ criterionId: "criterion:tests", status: "pass", evidence: [] }],
    },
  });
  assert.equal(parsed.success, false);
});

test("verification results cannot contain duplicate criterion or requirement claims", () => {
  const valid = event(
    "verification.result",
    {
      verificationId: "verification:unique",
      contractRevision: 1,
      status: "pass",
      criterionResults: [{
        criterionId: "criterion:tests",
        status: "pass",
        evidence: [{ id: "proof:1", kind: "test" }],
      }],
      evidenceSatisfaction: [{
        requirementId: "evidence:tests",
        evidence: [{ id: "proof:1", kind: "test" }],
      }],
      falsifiability: { provenCriteria: [], exemptedCriteria: [] },
    },
    { actor: worker },
  );
  assert.equal(
    HarnessEventSchema.safeParse({
      ...valid,
      payload: { ...valid.payload, criterionResults: [...valid.payload.criterionResults, ...valid.payload.criterionResults] },
    }).success,
    false,
  );
  assert.equal(
    HarnessEventSchema.safeParse({
      ...valid,
      payload: { ...valid.payload, evidenceSatisfaction: [...valid.payload.evidenceSatisfaction, ...valid.payload.evidenceSatisfaction] },
    }).success,
    false,
  );
});
