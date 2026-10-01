// Proofs for guards that had none.
//
// Each test here exists to falsify one entry in scripts/guard-manifest.json:
// remove the guard, this test must go red. `npm run check:guards` enforces that
// relationship mechanically, so a guard can never quietly stop being enforced.
//
// Do not weaken a test in this file to make a change pass. If a guard is
// genuinely being retired, remove its manifest entry in the same commit and say
// why in the message.

import assert from "node:assert/strict";
import test from "node:test";

import { projectBoard } from "../src/board.js";
import type { CrewWorkspace, CrewWorkspaceAcquireRequest, CrewWorkspaceProvider, CrewWorkspaceSnapshot } from "../src/crew.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import type { ActorRef, HarnessEvent, WorkContract } from "../src/schemas.js";
import { parseHarnessEvent, parseWorkContract } from "../src/schemas.js";
import {
  parseVerificationPlan,
  VerificationCheckResultSchema,
  VerificationEngine,
  VerifierCatalog,
  type VerificationCheckResult,
  type VerifierDescriptor,
  type VerifierProvider,
  type VerifierRequest,
} from "../src/verify.js";

const human: ActorRef = { id: "human:owner", kind: "human" };
const worker: ActorRef = { id: "agent:shipper", kind: "agent" };
const verifier: ActorRef = { id: "verifier:independent", kind: "verifier" };

function work(): WorkContract {
  return parseWorkContract({
    id: "work:guard-proof",
    objective: "Prove a guard is load bearing",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: { grants: [], requiresHumanApproval: [] },
    acceptanceCriteria: [{ id: "criterion:behavior", description: "Behavior is proven", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: {
      required: true,
      independentActor: true,
      reviewRequired: false,
      // This proof is about evidence, not falsifiability. The criterion is
      // exempted explicitly so the plan validates and the test keeps its
      // subject, rather than being quietly reshaped by an unrelated rule.
      falsifiabilityExemptions: [{
        criterionId: "criterion:behavior",
        reason: "human-judgment" as const,
        justification: "fixture for the evidence guard; falsifiability is proven elsewhere",
        authorizedBy: { id: "human:owner", kind: "human" as const },
      }],
    },
    createdBy: human,
    createdAt: "2026-08-20T17:00:00.000Z",
  });
}

class StaticWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:guard-proof";
  readonly workspace: CrewWorkspace = {
    leaseId: "lease:guard-proof",
    workspaceId: "workspace:guard-proof",
    uri: "memory://workspace:guard-proof",
    executionRoot: "/memory/guard-proof",
    baseRevision: "abc123",
    mode: "isolated-write",
  };
  readonly snapshotValue: CrewWorkspaceSnapshot = {
    workspaceId: "workspace:guard-proof",
    head: "abc123",
    digest: `sha256:${"a".repeat(64)}`,
    digestScope: {
      algorithm: "sha256" as const,
      strategy: "execution-root-content" as const,
      exclusions: [".git"],
      fileCount: 1,
      totalBytes: 12,
      symlinkCount: 0,
    },
    changedPaths: ["src/feature.ts"],
    observedAt: "2026-08-20T17:00:00.000Z",
  };
  async acquire(_r: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> { return this.workspace; }
  async snapshot(_w: CrewWorkspace): Promise<CrewWorkspaceSnapshot> { return structuredClone(this.snapshotValue); }
  async release(_id: string): Promise<void> {}
  async close(): Promise<void> {}
}

/** Reports success and offers nothing to support it. */
class EvidenceFreeVerifier implements VerifierProvider {
  readonly id = "verifier:evidence-free";
  async describe(): Promise<VerifierDescriptor> {
    return {
      id: this.id,
      displayName: "Evidence-free verifier",
      description: "Claims a pass while producing no evidence at all",
      deterministic: true,
      readOnly: true,
      evidenceKinds: ["test"],
    };
  }
  async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
    return VerificationCheckResultSchema.parse({
      checkId: request.check.id,
      providerId: this.id,
      status: "pass",
      summary: "trust me",
      evidence: [],
      startedAt: "2026-08-20T17:00:01.000Z",
      finishedAt: "2026-08-20T17:00:02.000Z",
    });
  }
  async close(): Promise<void> {}
}

// Falsifies: verify/passing-check-must-carry-evidence
test("a verifier that claims a pass with no evidence cannot verify Work", async () => {
  const ledger = new InMemoryEventLedger();
  const contract = work();
  const streamId = "stream:guard-proof";
  let counter = 0;
  const append = async (type: HarnessEvent["type"], payload: unknown, extra: Partial<HarnessEvent> = {}) => {
    counter += 1;
    await ledger.append(parseHarnessEvent({
      id: `event:guard:${counter}`,
      type,
      schemaVersion: 1,
      streamId,
      workId: contract.id,
      actor: human,
      occurredAt: "2026-08-20T17:00:00.000Z",
      recordedAt: "2026-08-20T17:00:00.000Z",
      evidence: [],
      payload,
      ...extra,
    }));
  };
  await append("work.created", { contract, revision: 1 });
  await append("task.created", { objective: contract.objective }, { taskId: "task:g" });
  await append("task.assigned", { worker }, { taskId: "task:g" });
  await append("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:g", attemptId: "attempt:g", actor: worker });
  await append("attempt.finished", { resultSummary: "done", artifactRefs: [] }, { taskId: "task:g", attemptId: "attempt:g", actor: worker });
  assert.equal(projectBoard(await ledger.replay(streamId)).state, "verifying");

  const workspaceProvider = new StaticWorkspaceProvider();
  let ids = 0;
  const receipt = await new VerificationEngine({
    ledger,
    workspaceProvider,
    verifierCatalog: new VerifierCatalog(new EvidenceFreeVerifier()),
    verifier,
    now: () => "2026-08-20T17:00:05.000Z",
    idFactory: () => `guard-${++ids}`,
  }).verify({
    streamId,
    work: contract,
    contractRevision: 1,
    workspace: workspaceProvider.workspace,
    expectedSnapshot: workspaceProvider.snapshotValue,
    plan: parseVerificationPlan({
      id: "plan:guard-proof",
      workId: contract.id,
      contractRevision: 1,
      checks: [{
        id: "check:evidence-free",
        providerId: "verifier:evidence-free",
        description: "A check whose provider offers nothing to support its claim",
        criterionIds: ["criterion:behavior"],
        config: {},
      }],
    }),
  });

  // The unsupported claim is downgraded to an error, the criterion is not
  // proven, and Work stays in verifying rather than becoming ready.
  assert.equal(receipt.status, "fail");
  assert.equal(receipt.checks[0]?.status, "error");
  assert.match(receipt.checks[0]?.summary ?? "", /no evidence/);
  assert.equal(receipt.boardState, "verifying");
  assert.notEqual(receipt.boardState, "ready");
});
