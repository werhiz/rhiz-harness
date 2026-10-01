// Falsifiability is required, exemptions are named, and both are visible.
//
// #30 made a DECLARED negative control impossible to satisfy dishonestly. It
// did not require one, so a plan whose primary check was /usr/bin/true still
// produced a passing receipt and left Board ready. See issue #32.
//
// Every assertion here describes intended behavior.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acceptanceReadiness, projectBoard } from "../src/board.js";
import type { CrewWorkspace, CrewWorkspaceAcquireRequest, CrewWorkspaceProvider, CrewWorkspaceSnapshot } from "../src/crew.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import type { ActorRef, HarnessEvent, WorkContract } from "../src/schemas.js";
import { parseHarnessEvent, parseWorkContract, WorkContractSchema } from "../src/schemas.js";
import {
  parseVerificationPlan,
  validateVerificationPlan,
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

function work(overrides: Record<string, unknown> = {}): WorkContract {
  return parseWorkContract({
    id: "work:falsifiability",
    objective: "Prove that a required criterion is proven by something that could fail",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: { grants: [], requiresHumanApproval: [] },
    acceptanceCriteria: [{ id: "criterion:behavior", description: "Behavior is proven", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false, explicitProviderAuthorizations: [] },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false, falsifiabilityExemptions: [] },
    createdBy: human,
    createdAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  });
}

const PERTURBATION = {
  description: "break the file the check reads",
  kind: "overwrite-file" as const,
  path: "src/index.ts",
  content: "broken",
};

function plan(checks: unknown[]) {
  return parseVerificationPlan({
    id: "plan:falsifiability",
    workId: "work:falsifiability",
    contractRevision: 1,
    checks,
  });
}

const PRIMARY = {
  id: "primary",
  providerId: "verifier:scripted",
  description: "Prove the behavior",
  criterionIds: ["criterion:behavior"],
  config: {},
};
const CONTROL = {
  id: "control",
  providerId: "verifier:scripted",
  description: "Prove the check can detect a known failure",
  negativeControlFor: "primary",
  perturbation: PERTURBATION,
  config: {},
};

// 1
test("a required criterion proven by a check with no negative control is rejected at plan validation", () => {
  assert.throws(
    () => validateVerificationPlan(plan([PRIMARY]), work(), 1),
    /no negative control/,
  );
});

// 2
test("a negative control makes the same plan valid", () => {
  assert.doesNotThrow(() => validateVerificationPlan(plan([PRIMARY, CONTROL]), work(), 1));
});

// 3
test("a named human exemption makes it valid without a control, and only a human may give it", () => {
  const exempted = work({
    verificationPolicy: {
      required: true,
      independentActor: true,
      reviewRequired: false,
      falsifiabilityExemptions: [{
        criterionId: "criterion:behavior",
        reason: "human-judgment",
        justification: "acceptance here is a design call, not a computation",
        authorizedBy: human,
      }],
    },
  });
  assert.doesNotThrow(() => validateVerificationPlan(plan([PRIMARY]), exempted, 1));

  // An agent cannot exempt itself from proof.
  const byAgent = WorkContractSchema.safeParse({
    ...work(),
    verificationPolicy: {
      required: true,
      independentActor: true,
      reviewRequired: false,
      falsifiabilityExemptions: [{
        criterionId: "criterion:behavior",
        reason: "human-judgment",
        justification: "I have decided I am trustworthy",
        authorizedBy: worker,
      }],
    },
  });
  assert.equal(byAgent.success, false);
});

// 4
test("an exemption naming a criterion the Work does not require is rejected", () => {
  const parsed = WorkContractSchema.safeParse({
    ...work(),
    verificationPolicy: {
      required: true,
      independentActor: true,
      reviewRequired: false,
      falsifiabilityExemptions: [{
        criterionId: "criterion:does-not-exist",
        reason: "static-analysis",
        justification: "names a stranger",
        authorizedBy: human,
      }],
    },
  });
  assert.equal(parsed.success, false);
});

class ScriptedVerifier implements VerifierProvider {
  readonly id = "verifier:scripted";
  async describe(): Promise<VerifierDescriptor> {
    return {
      id: this.id,
      displayName: "Scripted",
      description: "Passes the primary and fails against a perturbed copy",
      deterministic: true,
      readOnly: true,
      evidenceKinds: ["test"],
    };
  }
  async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
    // Fails only against the isolated perturbed copy, which is what makes it a
    // check that can detect a known failure rather than one that always passes.
    //
    // It reads the file the perturbation breaks. It used to match the isolated
    // copy's temp-directory NAME, which made the fixture agree with whichever
    // string the engine happened to pass to mkdtemp rather than with the
    // perturbation, and quietly stopped detecting anything when the engine moved
    // to the disposable-derivative machinery (#63).
    const perturbed = readFileSync(join(request.workspace.executionRoot, "src/index.ts"), "utf8") !== "export const value = 1;\n";
    return VerificationCheckResultSchema.parse({
      checkId: request.check.id,
      providerId: this.id,
      status: perturbed ? "fail" : "pass",
      summary: perturbed ? "detected the perturbation" : "behavior proven",
      evidence: perturbed ? [] : [{ id: `evidence:${request.check.id}`, kind: "test", digest: `sha256:${"1".repeat(64)}` }],
      startedAt: "2026-08-21T10:00:01.000Z",
      finishedAt: "2026-08-21T10:00:02.000Z",
    });
  }
  async close(): Promise<void> {}
}

/** A real directory: a negative control copies the execution root to perturb it. */
function realExecutionRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rhiz-fals-")));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), "export const value = 1;\n");
  return root;
}

class StaticWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:falsifiability";
  readonly root = realExecutionRoot();
  readonly workspace: CrewWorkspace = {
    leaseId: "lease:f",
    workspaceId: "workspace:f",
    uri: "memory://workspace:f",
    executionRoot: "",
    baseRevision: "abc123",
    mode: "isolated-write",
  };
  readonly snapshotValue: CrewWorkspaceSnapshot = {
    workspaceId: "workspace:f",
    head: "abc123",
    digest: `sha256:${"a".repeat(64)}`,
    digestScope: {
      algorithm: "sha256",
      strategy: "execution-root-content",
      exclusions: [".git"],
      fileCount: 1,
      totalBytes: 4,
      symlinkCount: 0,
    },
    changedPaths: ["src/index.ts"],
    observedAt: "2026-08-21T10:00:00.000Z",
  };
  constructor() {
    (this.workspace as { executionRoot: string }).executionRoot = this.root;
  }
  dispose(): void { rmSync(this.root, { recursive: true, force: true }); }
  // Honour the requested mode: a SCOUT mission asks for read-only and Crew
  // rejects a provider that hands back something else.
  async acquire(request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> {
    return { ...this.workspace, mode: request.mode };
  }
  async snapshot(_w: CrewWorkspace): Promise<CrewWorkspaceSnapshot> { return structuredClone(this.snapshotValue); }
  async release(_id: string): Promise<void> {}
  async close(): Promise<void> {}
}

async function runVerification(contract: WorkContract, checks: unknown[]) {
  const ledger = new InMemoryEventLedger();
  const streamId = "stream:f";
  let counter = 0;
  const append = async (type: HarnessEvent["type"], payload: unknown, extra: Partial<HarnessEvent> = {}) => {
    counter += 1;
    await ledger.append(parseHarnessEvent({
      id: `event:f:${counter}`,
      type,
      schemaVersion: 1,
      streamId,
      workId: contract.id,
      actor: human,
      occurredAt: "2026-08-21T10:00:00.000Z",
      recordedAt: "2026-08-21T10:00:00.000Z",
      evidence: [],
      payload,
      ...extra,
    }));
  };
  await append("work.created", { contract, revision: 1 });
  await append("task.created", { objective: contract.objective }, { taskId: "task:f" });
  await append("task.assigned", { worker }, { taskId: "task:f" });
  await append("attempt.started", { worker, contractRevision: 1, lease: { id: "lease:f", workspaceId: "workspace:f", resourceClaims: [{ kind: "path" as const, resource: "src" }], acquiredAt: "2026-08-20T04:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" } }, { taskId: "task:f", attemptId: "attempt:f", actor: worker });
  // A worker that ran leaves execution evidence; the Board requires it
  // before it will call this Work done. See authorshipUnproven in board.ts.
  await append("attempt.activity-observed", { state: "working", detail: "message: worker edited src/feature.ts", source: "agent:worker", authority: "observation" }, { taskId: "task:f", attemptId: "attempt:f", actor: worker });
  await append("guard.evaluated", {
    request: { requestId: "guard:attempt:f", workId: contract.id, taskId: "task:f", attemptId: "attempt:f", actor: worker, writeScope: "workspace" as const, contextHash: "ctx:attempt:f", evidenceRefs: [], timestampMs: 1787000000000, tool: { name: "worker:file-change", category: "write" as const, args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } } },
    verdict: { requestId: "guard:attempt:f", decision: "allow" as const, rationale: "fixture write authorized", riskLevel: "medium" as const, ruleHits: ["per-category-mode:write:allow"], evaluatedAt: "2026-08-20T04:00:00.500Z", durationMs: 1, policyBackend: "rhiz-native", policyBackendVersion: "0.1.0" },
  }, { taskId: "task:f", attemptId: "attempt:f", actor: worker });
  await append("attempt.finished", { resultSummary: "done", artifactRefs: [] }, { taskId: "task:f", attemptId: "attempt:f", actor: worker });

  const workspaceProvider = new StaticWorkspaceProvider();
  let ids = 0;
  const receipt = await new VerificationEngine({
    ledger,
    workspaceProvider,
    verifierCatalog: new VerifierCatalog(new ScriptedVerifier()),
    verifier,
    now: () => "2026-08-21T10:00:05.000Z",
    idFactory: () => `f-${++ids}`,
  }).verify({
    streamId,
    work: contract,
    contractRevision: 1,
    workspace: workspaceProvider.workspace,
    expectedSnapshot: workspaceProvider.snapshotValue,
    plan: plan(checks),
  });
  workspaceProvider.dispose();
  return { receipt, board: projectBoard(await ledger.replay(streamId)) };
}

// 5
test("the receipt states which required criteria were proven falsifiably", async () => {
  const { receipt, board } = await runVerification(work(), [PRIMARY, CONTROL]);
  assert.equal(receipt.status, "pass");
  assert.deepEqual(receipt.falsifiability.provenCriteria, ["criterion:behavior"]);
  assert.deepEqual(receipt.falsifiability.exemptedCriteria, []);
  assert.equal(board.state, "ready");
});

// 6, the surfacing test. Mutate by NOT POPULATING the field, never by deleting it.
test("an all-exempt verification is surfaced as such and cannot reach accepted alone", async () => {
  const exempted = work({
    verificationPolicy: {
      required: true,
      independentActor: true,
      reviewRequired: false,
      falsifiabilityExemptions: [{
        criterionId: "criterion:behavior",
        reason: "human-judgment",
        justification: "acceptance here is a design call",
        authorizedBy: human,
      }],
    },
  });
  const { receipt, board } = await runVerification(exempted, [PRIMARY]);

  // Visible without reading the plan: nothing here could have failed.
  assert.equal(receipt.status, "pass");
  assert.deepEqual(receipt.falsifiability.provenCriteria, []);
  assert.deepEqual(
    receipt.falsifiability.exemptedCriteria.map((item) => `${item.criterionId}:${item.reason}:${item.authorizedBy.id}`),
    ["criterion:behavior:human-judgment:human:owner"],
  );

  // And it attests rather than verifies, so a human has to sign.
  assert.equal(board.state, "reviewing");
  const readiness = acceptanceReadiness(board);
  assert.equal(readiness.ready, false);
  assert.ok(
    readiness.reasons.some((reason) => reason.includes("attests rather than verifies")),
    `expected an attestation reason, received: ${readiness.reasons.join("; ")}`,
  );
});

// The second half of #32: an authority exception must survive the process that
// made it. Auditable at the moment of decision and unreconstructible afterwards
// is the worst pairing available.
test("an authorization that admitted a provider reaches both the receipt and the Ledger", async () => {
  const { CrewSupervisor, parseCrewPlan } = await import("../src/crew.js");
  const { WorkerCatalog } = await import("../src/workers.js");

  const scoutWork = parseWorkContract({
    id: "work:authorized-scout",
    objective: "Run a diagnostic on a provider admitted by exception",
    type: "SCOUT",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [],
    nonGoals: [],
    authority: { grants: [], requiresHumanApproval: [] },
    acceptanceCriteria: [{ id: "criterion:read", description: "Diagnostic produced", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: {
      preferredProviders: [],
      maxAttempts: 1,
      allowParallelAttempts: false,
      explicitProviderAuthorizations: [{
        providerId: "worker:unclassified",
        reason: "operator vetted this provider by hand for one diagnostic",
        authorizedBy: human,
      }],
    },
    verificationPolicy: {
      required: true,
      independentActor: true,
      reviewRequired: false,
      falsifiabilityExemptions: [{
        criterionId: "criterion:read",
        reason: "human-judgment",
        justification: "diagnostic output is read by a person",
        authorizedBy: human,
      }],
    },
    createdBy: human,
    createdAt: "2026-08-21T10:00:00.000Z",
  });

  const workspaceProvider = new StaticWorkspaceProvider();
  const ledger = new InMemoryEventLedger();
  // Binds its workspace, so it is supervisable, but declares write access a
  // SCOUT mission does not permit. Admitted ONLY because the contract names it.
  // Note an authorization deliberately cannot buy workspace binding (#18), so
  // an undescribed provider could never reach this point at all.
  const provider = {
    id: "worker:unclassified",
    async capabilities() { return { streamingObservations: true, cancel: false, resume: false }; },
    async describe() {
      return {
        id: "worker:unclassified",
        displayName: "Unclassified",
        description: "Binds its workspace, over-privileged for this mission",
        adapter: "test",
        product: "test",
        execution: "one-shot" as const,
        context: "standalone" as const,
        authorityMode: "test",
        writeAccess: "unrestricted" as const,
        dangerous: false,
        bindsWorkspace: true,
        credentialEnv: [],
      };
    },
    async start(input: { attemptId: string }) {
      return {
        workerId: "worker:unclassified:1",
        attemptId: input.attemptId,
        async *observe() {},
        async result() { return { status: "finished" as const, summary: "diagnostic complete", artifacts: [], evidence: [] }; },
        async cancel() {},
      };
    },
  };

  const run = await new CrewSupervisor({
    plan: parseCrewPlan({
      id: "crew:authorized",
      objective: "Prove an exception is recoverable",
      baseRevision: "abc123",
      missions: [{
        work: scoutWork,
        workspace: { strategy: "fresh", mode: "read-only" },
        requiredCapabilities: [],
      }],
    }),
    ledger,
    workerCatalog: new WorkerCatalog(provider as never),
    workspaceProvider,
    actor: human,
  }).run().catch((error: unknown) => ({ error })) as { receipt?: { missions: Array<Record<string, unknown>> }; error?: unknown };

  workspaceProvider.dispose();
  assert.equal(run.error, undefined, `crew run failed: ${String(run.error)}`);

  const mission = run.receipt!.missions[0] as Record<string, unknown>;
  const authorization = mission["authorization"] as { providerId: string; authorizedBy: { id: string } } | undefined;
  assert.ok(authorization, "the receipt does not record that a provider was admitted by exception");
  assert.equal(authorization.providerId, "worker:unclassified");
  assert.equal(authorization.authorizedBy.id, "human:owner");

  // And it survives the process: replay alone shows the exception.
  const events = await ledger.replay(mission["streamId"] as string);
  const assigned = events.find((event) => event.type === "task.assigned");
  assert.ok(assigned, "no task.assigned event");
  const payload = assigned.payload as { authorization?: { providerId: string } };
  assert.ok(
    payload.authorization,
    "replay cannot reconstruct that the provider was admitted by exception",
  );
  assert.equal(payload.authorization.providerId, "worker:unclassified");
});

// #54: the attestation rule must mean the same thing to both readers.
//
// isAttestationOnly extracted the PREDICATE ("is this attestation-only") but
// each consumer then decided separately what satisfies it, and only
// acceptanceReadiness required the signer to be independent. A self-signed
// attestation therefore made the projection say ready while the gate refused.
// Board state is what people read, so the rule was enforced where it blocks and
// silently not enforced where it reports.
test("a self-signed attestation is not satisfied, in the projection as well as at the gate", async () => {
  const exempted = work({
    id: "work:self-signed",
    verificationPolicy: {
      required: true,
      independentActor: true,
      reviewRequired: false,
      falsifiabilityExemptions: [{
        criterionId: "criterion:behavior",
        reason: "human-judgment",
        justification: "acceptance here is a design call",
        authorizedBy: human,
      }],
    },
  });

  let counter = 0;
  const events: HarnessEvent[] = [];
  const push = (type: HarnessEvent["type"], payload: unknown, extra: Partial<HarnessEvent> = {}) => {
    counter += 1;
    events.push(parseHarnessEvent({
      id: `event:ss:${counter}`,
      type,
      schemaVersion: 1,
      streamId: "stream:ss",
      workId: exempted.id,
      actor: human,
      occurredAt: "2026-08-21T10:00:00.000Z",
      recordedAt: "2026-08-21T10:00:00.000Z",
      evidence: [],
      payload,
      ...extra,
    }));
  };

  push("work.created", { contract: exempted, revision: 1 });
  push("task.created", { objective: exempted.objective }, { taskId: "task:ss" });
  push("task.assigned", { worker }, { taskId: "task:ss" });
  push("attempt.started", { worker, contractRevision: 1, lease: { id: "lease:ss", workspaceId: "workspace:ss", resourceClaims: [{ kind: "path" as const, resource: "src" }], acquiredAt: "2026-08-20T04:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" } }, { taskId: "task:ss", attemptId: "attempt:ss", actor: worker });
  // A worker that ran leaves execution evidence; the Board requires it
  // before it will call this Work done. See authorshipUnproven in board.ts.
  push("attempt.activity-observed", { state: "working", detail: "message: worker edited src/feature.ts", source: "agent:worker", authority: "observation" }, { taskId: "task:ss", attemptId: "attempt:ss", actor: worker });
  push("guard.evaluated", {
    request: { requestId: "guard:attempt:ss", workId: exempted.id, taskId: "task:ss", attemptId: "attempt:ss", actor: worker, writeScope: "workspace" as const, contextHash: "ctx:attempt:ss", evidenceRefs: [], timestampMs: 1787000000000, tool: { name: "worker:file-change", category: "write" as const, args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } } },
    verdict: { requestId: "guard:attempt:ss", decision: "allow" as const, rationale: "fixture write authorized", riskLevel: "medium" as const, ruleHits: ["per-category-mode:write:allow"], evaluatedAt: "2026-08-20T04:00:00.500Z", durationMs: 1, policyBackend: "rhiz-native", policyBackendVersion: "0.1.0" },
  }, { taskId: "task:ss", attemptId: "attempt:ss", actor: worker });
  push("attempt.finished", { resultSummary: "done", artifactRefs: [] }, { taskId: "task:ss", attemptId: "attempt:ss", actor: worker });
  push("verification.started", { verificationId: "v:ss", contractRevision: 1 }, { actor: verifier });
  push("verification.result", {
    verificationId: "v:ss",
    contractRevision: 1,
    status: "pass",
    criterionResults: [{
      criterionId: "criterion:behavior",
      status: "pass",
      evidence: [{ id: "proof:ss", kind: "test", digest: `sha256:${"2".repeat(64)}` }],
    }],
    evidenceSatisfaction: [],
    falsifiability: {
      provenCriteria: [],
      exemptedCriteria: [{ criterionId: "criterion:behavior", reason: "human-judgment", authorizedBy: human }],
    },
  }, { actor: verifier });
  // The review that signs it is the SAME actor that executed the attempt.
  push("review.started", { reviewId: "r:ss", contractRevision: 1 }, { actor: worker });
  push("review.result", { reviewId: "r:ss", contractRevision: 1, status: "pass", summary: "looks fine to me" }, { actor: worker });

  const board = projectBoard(events);
  assert.equal(board.violations.length, 0, `unexpected violations: ${JSON.stringify(board.violations)}`);

  const readiness = acceptanceReadiness(board);
  assert.equal(readiness.ready, false, "a self-signed attestation must not be acceptable");

  // And the projection must agree, because Board state is what a person reads.
  assert.equal(
    board.state,
    "reviewing",
    "the projection reported ready for an attestation signed by its own execution actor",
  );
});
