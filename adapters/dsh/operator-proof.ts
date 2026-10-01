import { z } from "zod";
import { TimestampSchema } from "../../src/schemas.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().trim().min(1).max(200);

export const DshProductOperatorWorkerProofSchema = z.object({
  workerId: z.enum(["worker:codex", "worker:claude"]),
  product: z.enum(["codex", "claude-code"]),
  productVersion: z.string().trim().min(1).max(100),
  authorityMode: z.string().trim().min(1).max(200),
  credentialSource: z.enum(["explicit-env", "native-account-or-settings"]),
  credentialEnvNames: z.array(z.string().trim().min(1).max(200)),
  attemptId: id,
  contractDigest: digest,
  outcome: z.enum(["finished", "failed", "cancelled", "error"]),
  summaryDigest: digest,
  summaryLength: z.number().int().nonnegative(),
  nonceEchoed: z.boolean(),
  headEchoed: z.boolean(),
  observationCount: z.number().int().nonnegative(),
  boardState: z.string().trim().min(1).max(100),
  violationCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  workspaceBefore: digest,
  workspaceAfter: digest,
  workspaceUnchanged: z.boolean(),
  error: z.string().trim().min(1).max(4000).optional(),
}).strict();
export type DshProductOperatorWorkerProof = z.infer<typeof DshProductOperatorWorkerProofSchema>;

export const DshProductOperatorProofSchema = z.object({
  schema: z.literal("rhiz/dsh-product-operator-proof/v0"),
  generatedAt: TimestampSchema,
  source: z.object({
    repository: z.string().trim().min(1).max(200),
    branch: z.string().trim().min(1).max(300),
    head: gitSha,
    workspaceBefore: digest,
    workspaceAfter: digest,
    workspaceUnchanged: z.boolean(),
  }).strict(),
  nonce: z.string().trim().min(8).max(200),
  contractDigest: digest,
  workers: z.array(DshProductOperatorWorkerProofSchema).length(2),
}).strict();
export type DshProductOperatorProof = z.infer<typeof DshProductOperatorProofSchema>;

export interface DshProductOperatorProofEvaluation {
  ok: boolean;
  failures: string[];
  proof: DshProductOperatorProof;
}

const expectedProducts: Readonly<Record<DshProductOperatorWorkerProof["workerId"], DshProductOperatorWorkerProof["product"]>> = {
  "worker:codex": "codex",
  "worker:claude": "claude-code",
};

export function evaluateDshProductOperatorProof(rawProof: unknown): DshProductOperatorProofEvaluation {
  const proof = DshProductOperatorProofSchema.parse(rawProof);
  const failures: string[] = [];

  if (!proof.source.workspaceUnchanged || proof.source.workspaceBefore !== proof.source.workspaceAfter) {
    failures.push("the source workspace changed during the operator proof");
  }

  const seen = new Set<string>();
  for (const worker of proof.workers) {
    if (seen.has(worker.workerId)) {
      failures.push(`duplicate worker proof for ${worker.workerId}`);
      continue;
    }
    seen.add(worker.workerId);

    if (worker.product !== expectedProducts[worker.workerId]) {
      failures.push(`${worker.workerId} is attributed to ${worker.product} instead of ${expectedProducts[worker.workerId]}`);
    }
    if (worker.contractDigest !== proof.contractDigest) {
      failures.push(`${worker.workerId} did not execute the shared WorkContract digest`);
    }
    if (worker.outcome !== "finished") {
      failures.push(`${worker.workerId} ended with ${worker.outcome}`);
    }
    if (worker.summaryLength === 0) {
      failures.push(`${worker.workerId} returned no final summary`);
    }
    if (!worker.nonceEchoed) {
      failures.push(`${worker.workerId} did not echo the exact proof nonce`);
    }
    if (!worker.headEchoed) {
      failures.push(`${worker.workerId} did not echo the exact repository HEAD`);
    }
    if (worker.observationCount < 2) {
      failures.push(`${worker.workerId} produced fewer than two validated observations`);
    }
    if (worker.boardState !== "verifying") {
      failures.push(`${worker.workerId} left Board in ${worker.boardState} instead of verifying`);
    }
    if (worker.violationCount !== 0) {
      failures.push(`${worker.workerId} produced ${worker.violationCount} Board projection violation(s)`);
    }
    if (worker.artifactCount !== 0 || worker.evidenceCount !== 0) {
      failures.push(`${worker.workerId} claimed artifacts or evidence during a read-only proof`);
    }
    if (!worker.workspaceUnchanged || worker.workspaceBefore !== worker.workspaceAfter) {
      failures.push(`${worker.workerId} changed its disposable proof workspace`);
    }
    if (worker.error !== undefined) {
      failures.push(`${worker.workerId} reported an operator-proof error`);
    }
  }

  for (const workerId of Object.keys(expectedProducts)) {
    if (!seen.has(workerId)) failures.push(`missing worker proof for ${workerId}`);
  }

  return { ok: failures.length === 0, failures, proof };
}

export function assertDshProductOperatorProof(rawProof: unknown): DshProductOperatorProof {
  const evaluation = evaluateDshProductOperatorProof(rawProof);
  if (!evaluation.ok) {
    throw new Error(`DSH product operator proof failed: ${evaluation.failures.join("; ")}`);
  }
  return evaluation.proof;
}
