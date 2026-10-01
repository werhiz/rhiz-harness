import type { ProjectionViolation } from "../../src/board.js";
import type { WorkerResult } from "../../src/host.js";
import { WorkerResultSchema } from "../../src/host.js";
import type { WorkState } from "../../src/schemas.js";

export const DSH_SMOKE_EXPECTED_SUMMARY = "DSH keyless smoke completed and returned control to Rhiz.";

export interface DshSmokeProofInput {
  workerResult: WorkerResult;
  observationCount: number;
  boardState: WorkState;
  violations: readonly ProjectionViolation[];
}

export interface DshSmokeProofEvaluation {
  ok: boolean;
  failures: string[];
}

export function evaluateDshSmokeProof(rawInput: DshSmokeProofInput): DshSmokeProofEvaluation {
  const input = {
    ...rawInput,
    workerResult: WorkerResultSchema.parse(rawInput.workerResult),
  };
  const failures: string[] = [];

  if (input.workerResult.status !== "finished") {
    failures.push(`worker status must be finished, received ${input.workerResult.status}`);
  }
  if (!input.workerResult.summary.includes(DSH_SMOKE_EXPECTED_SUMMARY)) {
    failures.push("worker summary does not contain the keyless DSH replay proof");
  }
  if (!Number.isSafeInteger(input.observationCount) || input.observationCount < 1) {
    failures.push("at least one validated DSH observation is required");
  }
  if (input.boardState !== "verifying") {
    failures.push(`Board must reach verifying after successful execution, received ${input.boardState}`);
  }
  if (input.violations.length > 0) {
    failures.push(`Board replay produced ${input.violations.length} violation(s)`);
  }

  return { ok: failures.length === 0, failures };
}

export function assertDshSmokeProof(input: DshSmokeProofInput): void {
  const evaluation = evaluateDshSmokeProof(input);
  if (!evaluation.ok) {
    throw new Error(`DSH smoke proof failed: ${evaluation.failures.join("; ")}`);
  }
}
