import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceReadiness, projectBoard } from "../src/board.js";
import { withDesignContinuity } from "../src/design-intelligence.js";
import { FollowThroughAssignmentSchema } from "../src/follow-through.js";
import { passingVerificationSequence, successfulExecution, work } from "./helpers.js";

const design = {
  baselineUri: "artifact://selected-interface/v3",
  baselineDigest: `sha256:${"a".repeat(64)}`,
  protectedFeatures: [
    "Operational map supports selecting a driver and assigning a real job",
    "Preserve selected typography, image scale and spatial composition",
    "Keep route animation and usable mobile navigation",
  ],
};
function job(contract = work()) {
  return { ownerRef: "account:fixture", sourceRef: "message:fixture", dueAt: "2026-08-20T15:00:00.000Z", priority: 50, baseRevision: "base", deliveryKind: "interface", designContinuity: design,
    mission: { work: contract, workspace: { strategy: "fresh", mode: "isolated-write" } } };
}

test("interface assignments refuse absent baseline and unbound visual requirements", () => {
  assert.throws(() => FollowThroughAssignmentSchema.parse({ ...job(), designContinuity: undefined }));
  assert.throws(() => FollowThroughAssignmentSchema.parse(job()));
  assert.doesNotThrow(() => FollowThroughAssignmentSchema.parse(job(withDesignContinuity(work(), design))));
});

test("design contract preserves approved reference and every protected feature without granting authority", () => {
  const original = work();
  const bound = withDesignContinuity(original, design);
  assert.deepEqual(bound.authority, original.authority);
  assert.deepEqual(bound.writeScope, original.writeScope);
  assert.equal(original.acceptanceCriteria.length, 1, "input is unchanged");
  assert.ok(bound.context.resources.some(item => item.uri === design.baselineUri));
  assert.ok(bound.acceptanceCriteria.some(item => item.description.includes(design.baselineDigest)));
  for (const feature of design.protectedFeatures) assert.ok(bound.acceptanceCriteria.some(item => item.required && item.description.includes(feature)));
  assert.equal(bound.verificationPolicy.reviewRequired, true);
  assert.equal(bound.verificationPolicy.independentActor, true);
  assert.deepEqual(withDesignContinuity(bound, design), bound);
});

test("passing code tests cannot certify a flattened interface without rendered and interaction proof", () => {
  const contract = withDesignContinuity(work(), design);
  const board = projectBoard([...successfulExecution(contract), ...passingVerificationSequence()]);
  assert.equal(board.violations.length, 0);
  assert.equal(acceptanceReadiness(board).ready, false);
  assert.equal(board.state === "accepted", false);
  for (const viewport of ["desktop", "mobile"]) {
    const requirement = contract.requiredEvidence.find(item => item.id === `design:screenshot:${viewport}`)!;
    assert.equal(requirement.required, true);
    assert.deepEqual(requirement.acceptedKinds, ["screenshot"]);
  }
  assert.deepEqual(contract.requiredEvidence.find(item => item.id === "design:interaction")!.acceptedKinds, ["browser"]);
});
