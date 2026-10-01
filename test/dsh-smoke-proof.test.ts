import assert from "node:assert/strict";
import test from "node:test";
import {
  DSH_SMOKE_EXPECTED_SUMMARY,
  evaluateDshSmokeProof,
} from "../adapters/dsh/smoke-proof.js";

const passingInput = {
  workerResult: {
    status: "finished" as const,
    summary: DSH_SMOKE_EXPECTED_SUMMARY,
    artifacts: [],
    evidence: [],
  },
  observationCount: 3,
  boardState: "verifying" as const,
  violations: [],
};

test("the DSH smoke proof accepts only the intended successful end state", () => {
  const evaluation = evaluateDshSmokeProof(passingInput);
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failures, []);
});

test("a failed worker cannot produce a green DSH smoke", () => {
  const evaluation = evaluateDshSmokeProof({
    ...passingInput,
    workerResult: {
      ...passingInput.workerResult,
      status: "failed",
      summary: "DSH worker failed: package unavailable",
    },
    boardState: "failed",
  });
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join("; "), /worker status must be finished/);
  assert.match(evaluation.failures.join("; "), /Board must reach verifying/);
});

test("internal consistency is insufficient when proof signals are absent", () => {
  const evaluation = evaluateDshSmokeProof({
    ...passingInput,
    observationCount: 0,
    workerResult: {
      ...passingInput.workerResult,
      summary: "some unrelated successful response",
    },
  });
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join("; "), /keyless DSH replay proof/);
  assert.match(evaluation.failures.join("; "), /validated DSH observation/);
});
