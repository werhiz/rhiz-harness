import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CrewWorkspace,
  CrewWorkspaceAcquireRequest,
  CrewWorkspaceProvider,
  CrewWorkspaceSnapshot,
} from "../src/crew.js";
import { acceptanceReadiness, projectBoard } from "../src/board.js";
import { InMemoryEventLedger, type EventLedger } from "../src/ledger.js";
import type { ActorRef, EvidenceRef, HarnessEvent, WorkContract } from "../src/schemas.js";
import { parseHarnessEvent, parseWorkContract } from "../src/schemas.js";
import {
  acceptVerifiedWork,
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
import { testDigestScope } from "./helpers.js";

const human: ActorRef = { id: "human:owner", kind: "human" };
const worker: ActorRef = { id: "agent:shipper", kind: "agent" };
const unrelatedWorker: ActorRef = { id: "agent:unrelated", kind: "agent" };
const verifier: ActorRef = { id: "verifier:independent", kind: "verifier" };

/**
 * A real directory, because a negative control now runs against an isolated copy
 * of the execution root. A fixture rooted at a path that does not exist would
 * make every control fail for want of bytes to copy, which is a true failure but
 * not the one these tests are about.
 */
const verifyRoot = mkdtempSync(join(tmpdir(), "rhiz-verify-fixture-"));
mkdirSync(join(verifyRoot, "src"), { recursive: true });
writeFileSync(join(verifyRoot, "src/feature.ts"), "export const feature = \"intact\";\n");
process.on("exit", () => { rmSync(verifyRoot, { recursive: true, force: true }); });

class MutableWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:mutable";
  readonly workspace: CrewWorkspace = {
    leaseId: "lease:verify",
    workspaceId: "workspace:verify",
    uri: `file://${verifyRoot}`,
    executionRoot: verifyRoot,
    baseRevision: "abc123",
    mode: "isolated-write",
  };
  snapshotValue: CrewWorkspaceSnapshot = {
    workspaceId: "workspace:verify",
    head: "abc123",
    digest: "sha256:target",
    digestScope: testDigestScope,
    changedPaths: ["src/feature.ts"],
    observedAt: "2026-08-20T17:00:00.000Z",
  };

  async acquire(_request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> { return this.workspace; }
  async snapshot(_workspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot> { return structuredClone(this.snapshotValue); }
  mutate(digest = "sha256:mutated", path = "src/mutated.ts"): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      digest,
      changedPaths: [...this.snapshotValue.changedPaths, path].sort(),
      observedAt: "2026-08-20T17:00:01.000Z",
    };
  }
  async release(_workspaceId: string): Promise<void> {}
  async close(): Promise<void> {}
}

interface Behavior {
  status?: VerificationCheckResult["status"];
  evidenceKind?: EvidenceRef["kind"];
  mutate?: () => void;
  deterministic?: boolean;
  readOnly?: boolean;
}

class ScriptedVerifier implements VerifierProvider {
  readonly calls: string[] = [];
  constructor(readonly id: string, readonly behavior: Behavior = {}) {}

  async describe(): Promise<VerifierDescriptor> {
    return {
      id: this.id,
      displayName: this.id,
      description: `Verifier ${this.id}`,
      deterministic: this.behavior.deterministic ?? true,
      readOnly: this.behavior.readOnly ?? true,
      evidenceKinds: [this.behavior.evidenceKind ?? "test"],
    };
  }

  async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
    this.calls.push(request.check.id);
    this.behavior.mutate?.();
    // An honest verifier reads the target. When the isolated copy carries the
    // control's perturbation this must fail, which is what makes the control
    // meaningful rather than decorative.
    const source = readFileSync(join(request.workspace.executionRoot, "src/feature.ts"), "utf8");
    const status = source.includes("broken") ? "fail" as const : this.behavior.status ?? "pass";
    return VerificationCheckResultSchema.parse({
      checkId: request.check.id,
      providerId: this.id,
      status,
      summary: `${request.check.id} ${status}`,
      evidence: status === "pass"
        ? [{ id: `evidence:${request.check.id}`, kind: this.behavior.evidenceKind ?? "test", digest: `sha256:${request.check.id}` }]
        : [],
      startedAt: "2026-08-20T17:00:02.000Z",
      finishedAt: "2026-08-20T17:00:03.000Z",
    });
  }

  async close(): Promise<void> {}
}

function work(overrides: Partial<WorkContract> = {}): WorkContract {
  return parseWorkContract({
    id: "work:verify",
    objective: "Verify the exact SHIP workspace",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [
        { action: "read", resources: [{ uri: "repo://example", kind: "repository" }], constraints: [] },
        { action: "write", resources: [{ uri: "repo://example/src", kind: "directory" }], constraints: [] },
      ],
      requiresHumanApproval: ["publish"],
    },
    acceptanceCriteria: [{ id: "criterion:behavior", description: "Behavior is proven", required: true }],
    requiredEvidence: [{ id: "requirement:test", description: "Passing test output", acceptedKinds: ["test"], required: true }],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [worker.id], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-08-20T17:00:00.000Z",
    ...overrides,
  });
}

async function seed(ledger: EventLedger, contract: WorkContract, handoffTo?: ActorRef): Promise<string> {
  const streamId = "stream:verify";
  let counter = 0;
  const append = async (type: HarnessEvent["type"], payload: unknown, extra: Partial<HarnessEvent> = {}) => {
    counter += 1;
    await ledger.append(parseHarnessEvent({
      id: `event:seed:${counter}`,
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
  await append("task.created", { objective: contract.objective }, { taskId: "task:verify" });
  await append("task.assigned", { worker }, { taskId: "task:verify" });
  // A SHIP attempt always holds a workspace lease; the handoff case only
  // changes who holds it next.
  const startedLease = {
    lease: {
      id: "lease:verify-one",
      workspaceId: "workspace:verify",
      resourceClaims: [{ kind: "path" as const, resource: "src" }],
      acquiredAt: "2026-08-20T16:00:00.000Z",
      expiresAt: "2026-08-21T00:00:00.000Z",
    },
  };
  await append("attempt.started", { worker, contractRevision: 1, ...startedLease }, { taskId: "task:verify", attemptId: "attempt:verify", actor: worker });
  // Execution evidence: the Board will not call a Work done without proof a
  // worker actually ran. See authorshipUnproven in board.ts.
  await append("attempt.activity-observed", {
    state: "working",
    detail: "message: worker edited src/feature.ts",
    source: "agent:worker",
    authority: "observation",
  }, { taskId: "task:verify", attemptId: "attempt:verify", actor: worker });
  await append("guard.evaluated", {
    request: {
      requestId: "guard:attempt:verify:write",
      workId: contract.id,
      taskId: "task:verify",
      attemptId: "attempt:verify",
      actor: worker,
      writeScope: "workspace" as const,
      contextHash: "ctx:attempt:verify",
      evidenceRefs: [],
      timestampMs: 1787000000000,
      tool: { name: "worker:file-change", category: "write" as const, args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } },
    },
    verdict: {
      requestId: "guard:attempt:verify:write",
      decision: "allow" as const,
      rationale: "fixture write authorized",
      riskLevel: "medium" as const,
      ruleHits: ["per-category-mode:write:allow"],
      evaluatedAt: "2026-08-20T16:30:00.500Z",
      durationMs: 1,
      policyBackend: "rhiz-native",
      policyBackendVersion: "0.1.0",
    },
  }, { taskId: "task:verify", attemptId: "attempt:verify", actor: worker });
  if (handoffTo !== undefined) {
    await append("attempt.lease-transferred", {
      fromLeaseId: "lease:verify-one",
      worker: handoffTo,
      lease: {
        id: "lease:verify-two",
        workspaceId: "workspace:verify",
        resourceClaims: [{ kind: "path" as const, resource: "src" }],
        acquiredAt: "2026-08-20T16:30:00.000Z",
        expiresAt: "2026-08-21T00:00:00.000Z",
      },
      reason: "checkpointed handoff to a successor executor",
    }, { taskId: "task:verify", attemptId: "attempt:verify", actor: human });
  }
  await append("attempt.finished", { resultSummary: "implementation complete", artifactRefs: [] }, { taskId: "task:verify", attemptId: "attempt:verify", actor: handoffTo ?? worker });
  assert.equal(projectBoard(await ledger.replay(streamId)).state, "verifying");
  return streamId;
}

function plan(providerId = "verifier:test", requirementId = "requirement:test") {
  return parseVerificationPlan({
    id: "plan:verify",
    workId: "work:verify",
    contractRevision: 1,
    checks: [
      {
        id: "check:primary",
        providerId,
        description: "Run the primary deterministic check",
        criterionIds: ["criterion:behavior"],
        requirementIds: [requirementId],
        config: {},
      },
      {
        id: "check:negative-control",
        providerId,
        description: "Prove the verifier can detect a known failure",
        negativeControlFor: "check:primary",
        perturbation: {
          kind: "overwrite-file",
          path: "src/feature.ts",
          content: "export const broken = true;\n",
          description: "src/feature.ts replaced with content the check must reject",
        },
        config: {},
      },
    ],
  });
}

async function setup(behavior: Behavior = {}, actor: ActorRef = verifier, contract = work(), handoffTo?: ActorRef) {
  const ledger = new InMemoryEventLedger();
  const streamId = await seed(ledger, contract, handoffTo);
  const workspaceProvider = new MutableWorkspaceProvider();
  const provider = new ScriptedVerifier("verifier:test", behavior);
  let counter = 0;
  const engine = new VerificationEngine({
    ledger,
    workspaceProvider,
    verifierCatalog: new VerifierCatalog(provider),
    verifier: actor,
    now: () => "2026-08-20T17:00:04.000Z",
    idFactory: () => `id-${++counter}`,
  });
  return { ledger, contract, streamId, workspaceProvider, provider, engine };
}

test("Verify binds deterministic evidence to the exact target and acceptance remains separate", async () => {
  const value = await setup();
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: plan(),
  });
  assert.equal(receipt.status, "pass");
  assert.equal(receipt.boardState, "ready");
  assert.equal(receipt.projectionViolationCount, 0);
  assert.equal(receipt.target.digest, "sha256:target");
  assert.equal(receipt.artifactIdentityEvidence.kind, "artifact-identity");
  assert.deepEqual(value.provider.calls, ["check:primary", "check:negative-control"]);
  assert.equal(projectBoard(await value.ledger.replay(value.streamId)).state, "ready");

  const state = await acceptVerifiedWork({
    receipt,
    work: value.contract,
    ledger: value.ledger,
    workspace: value.workspaceProvider.workspace,
    workspaceProvider: value.workspaceProvider,
    actor: human,
    reason: "Exact target and required evidence were independently verified",
    now: () => "2026-08-20T17:00:05.000Z",
    idFactory: () => "accept-1",
  });
  assert.equal(state, "accepted");
});

test("a worker cannot cross the acceptance seam, while a human acceptance authority can", async () => {
  const value = await setup();
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: plan(),
  });

  await assert.rejects(() => acceptVerifiedWork({
    receipt,
    work: value.contract,
    ledger: value.ledger,
    workspace: value.workspaceProvider.workspace,
    workspaceProvider: value.workspaceProvider,
    actor: unrelatedWorker,
    reason: "worker attempts to accept independently verified Work",
  }), /human acceptance authority/);
  assert.equal(projectBoard(await value.ledger.replay(value.streamId)).state, "ready");

  const state = await acceptVerifiedWork({
    receipt,
    work: value.contract,
    ledger: value.ledger,
    workspace: value.workspaceProvider.workspace,
    workspaceProvider: value.workspaceProvider,
    actor: human,
    reason: "human accepts independently verified Work",
    now: () => "2026-08-20T17:00:05.000Z",
    idFactory: () => "accept-human-only",
  });
  assert.equal(state, "accepted");
});

test("stale target fails before a verification lifecycle is appended", async () => {
  const value = await setup();
  const expected = structuredClone(value.workspaceProvider.snapshotValue);
  value.workspaceProvider.mutate();
  await assert.rejects(() => value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: expected,
    plan: plan(),
  }), /changed before verification started/);
  const board = projectBoard(await value.ledger.replay(value.streamId));
  assert.equal(board.activeVerification, null);
  assert.equal(board.verifications.length, 0);
});

test("workspace mutation during a check forces failed verification", async () => {
  const value = await setup({ mutate: () => undefined });
  value.provider.behavior.mutate = () => value.workspaceProvider.mutate();
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: structuredClone(value.workspaceProvider.snapshotValue),
    plan: plan(),
  });
  assert.equal(receipt.status, "fail");
  assert.equal(receipt.boardState, "verifying");
  assert.match(receipt.checks[0]!.summary, /changed the exact target workspace/);
  await assert.rejects(() => acceptVerifiedWork({
    receipt,
    work: value.contract,
    ledger: value.ledger,
    workspace: value.workspaceProvider.workspace,
    workspaceProvider: value.workspaceProvider,
    actor: human,
    reason: "invalid",
  }), /failed verification/);
});

test("wrong evidence kind cannot satisfy a required evidence requirement", async () => {
  const value = await setup({ evidenceKind: "log" });
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: plan(),
  });
  assert.equal(receipt.status, "fail");
  assert.equal(receipt.boardState, "verifying");
});

test("artifact identity alone never satisfies a required evidence requirement", async () => {
  const contract = work({
    requiredEvidence: [{
      id: "e1",
      description: "A passing primary check proves the examined artifact",
      acceptedKinds: ["artifact-identity"],
      required: true,
    }],
  });
  const value = await setup({ status: "fail" }, verifier, contract);
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: plan("verifier:test", "e1"),
  });

  assert.equal(receipt.status, "fail");
  assert.deepEqual(
    projectBoard(await value.ledger.replay(value.streamId)).verifications[0]?.evidenceSatisfaction,
    [],
    "a failed bound primary check must not leave its requirement satisfied by Harness identity",
  );

  await value.ledger.append(parseHarnessEvent({
    id: "event:identity-only:started",
    type: "verification.started",
    schemaVersion: 1,
    streamId: value.streamId,
    workId: contract.id,
    actor: verifier,
    occurredAt: "2026-08-20T17:00:05.000Z",
    recordedAt: "2026-08-20T17:00:05.000Z",
    evidence: [receipt.artifactIdentityEvidence],
    payload: { verificationId: "verification:identity-only", contractRevision: 1 },
  }));
  await value.ledger.append(parseHarnessEvent({
    id: "event:identity-only:result",
    type: "verification.result",
    schemaVersion: 1,
    streamId: value.streamId,
    workId: contract.id,
    actor: verifier,
    occurredAt: "2026-08-20T17:00:06.000Z",
    recordedAt: "2026-08-20T17:00:06.000Z",
    evidence: [receipt.artifactIdentityEvidence],
    payload: {
      verificationId: "verification:identity-only",
      contractRevision: 1,
      status: "pass",
      criterionResults: [{
        criterionId: "criterion:behavior",
        status: "pass",
        evidence: [receipt.artifactIdentityEvidence],
      }],
      evidenceSatisfaction: [{
        requirementId: "e1",
        evidence: [receipt.artifactIdentityEvidence],
      }],
      falsifiability: { provenCriteria: ["criterion:behavior"], exemptedCriteria: [] },
    },
  }));

  const readiness = acceptanceReadiness(projectBoard(await value.ledger.replay(value.streamId)));
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.some((reason) => reason.includes("required evidence e1")));

  // The same rule at the other reader: a provider may legitimately declare
  // artifact-identity among its evidence kinds, and a passing bound check that
  // returns only identity still proves nothing about the artifact. The engine
  // must refuse it at verification time rather than emitting a passing receipt
  // that acceptance will silently refuse forever.
  const declared = await setup({ evidenceKind: "artifact-identity" }, verifier, work({
    requiredEvidence: [{
      id: "e1",
      description: "A passing primary check proves the examined artifact",
      acceptedKinds: ["artifact-identity"],
      required: true,
    }],
  }));
  const declaredReceipt = await declared.engine.verify({
    streamId: declared.streamId,
    work: declared.contract,
    contractRevision: 1,
    workspace: declared.workspaceProvider.workspace,
    expectedSnapshot: declared.workspaceProvider.snapshotValue,
    plan: plan("verifier:test", "e1"),
  });

  assert.equal(declaredReceipt.checks.every((check) => check.status === "pass"), true);
  assert.equal(
    declaredReceipt.status,
    "fail",
    "a passing check carrying only artifact identity must not produce a passing receipt",
  );
  assert.equal(declaredReceipt.boardState, "verifying");
  assert.deepEqual(
    projectBoard(await declared.ledger.replay(declared.streamId)).verifications[0]?.evidenceSatisfaction,
    [],
  );
});

test("execution actor cannot verify its own Work", async () => {
  const value = await setup({}, { ...worker, kind: "verifier" });
  await assert.rejects(() => value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: plan(),
  }), /cannot verify its own Work/);
});

test("acceptance refuses post-verification target drift", async () => {
  const value = await setup();
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: plan(),
  });
  value.workspaceProvider.mutate("sha256:after-verification", "src/after.ts");
  await assert.rejects(() => acceptVerifiedWork({
    receipt,
    work: value.contract,
    ledger: value.ledger,
    workspace: value.workspaceProvider.workspace,
    workspaceProvider: value.workspaceProvider,
    actor: human,
    reason: "stale proof",
  }), /changed before acceptance/);
});

test("plan coverage and negative controls fail closed", () => {
  const contract = work();
  const missing = parseVerificationPlan({
    id: "plan:missing",
    workId: contract.id,
    contractRevision: 1,
    checks: [{ id: "check:only", providerId: "verifier:test", description: "no coverage", config: {} }],
  });
  assert.throws(() => validateVerificationPlan(missing, contract, 1), /has no primary verification check/);
  assert.throws(() => parseVerificationPlan({
    id: "plan:bad-control",
    workId: contract.id,
    contractRevision: 1,
    checks: [
      { id: "check:primary", providerId: "verifier:a", description: "primary", criterionIds: ["criterion:behavior"], requirementIds: ["requirement:test"], config: {} },
      { id: "check:control", providerId: "verifier:b", description: "wrong provider", negativeControlFor: "check:primary", perturbation: { kind: "overwrite-file", path: "src/feature.ts", content: "broken\n", description: "content the check must reject" }, config: {} },
    ],
  }), /same VerifierProvider/);
});

test("non-deterministic or mutating providers fail before lifecycle start", async () => {
  for (const behavior of [{ deterministic: false }, { readOnly: false }]) {
    const value = await setup(behavior);
    await assert.rejects(() => value.engine.verify({
      streamId: value.streamId,
      work: value.contract,
      contractRevision: 1,
      workspace: value.workspaceProvider.workspace,
      expectedSnapshot: value.workspaceProvider.snapshotValue,
      plan: plan(),
    }), /Verify v1 refuses/);
    const board = projectBoard(await value.ledger.replay(value.streamId));
    assert.equal(board.activeVerification, null);
    assert.equal(board.verifications.length, 0);
  }
});

const successorWorker: ActorRef = { id: "agent:successor", kind: "agent" };

test("a lease handoff never launders the original executor into an independent verifier", async () => {
  const outgoing = await setup({}, { ...worker, kind: "verifier" }, work(), successorWorker);
  await assert.rejects(() => outgoing.engine.verify({
    streamId: outgoing.streamId,
    work: outgoing.contract,
    contractRevision: 1,
    workspace: outgoing.workspaceProvider.workspace,
    expectedSnapshot: outgoing.workspaceProvider.snapshotValue,
    plan: plan(),
  }), /cannot verify its own Work/);

  const incoming = await setup({}, { ...successorWorker, kind: "verifier" }, work(), successorWorker);
  await assert.rejects(() => incoming.engine.verify({
    streamId: incoming.streamId,
    work: incoming.contract,
    contractRevision: 1,
    workspace: incoming.workspaceProvider.workspace,
    expectedSnapshot: incoming.workspaceProvider.snapshotValue,
    plan: plan(),
  }), /cannot verify its own Work/);

  const uninvolved = await setup({}, verifier, work(), successorWorker);
  const receipt = await uninvolved.engine.verify({
    streamId: uninvolved.streamId,
    work: uninvolved.contract,
    contractRevision: 1,
    workspace: uninvolved.workspaceProvider.workspace,
    expectedSnapshot: uninvolved.workspaceProvider.snapshotValue,
    plan: plan(),
  });
  assert.equal(receipt.status, "pass");
  assert.equal(receipt.boardState, "ready");
});

test("evidence of an unaccepted kind cannot satisfy a required evidence requirement at acceptance", async () => {
  const contract = work({
    requiredEvidence: [{
      id: "requirement:test",
      description: "Test evidence",
      acceptedKinds: ["test"],
      required: true,
    }],
  });
  const value = await setup({ status: "pass", evidenceKind: "log" }, verifier, contract);
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: plan(),
  });

  await value.ledger.append(parseHarnessEvent({
    id: "event:unaccepted-kind:started",
    type: "verification.started",
    schemaVersion: 1,
    streamId: value.streamId,
    workId: contract.id,
    actor: verifier,
    occurredAt: "2026-08-20T17:00:05.000Z",
    recordedAt: "2026-08-20T17:00:05.000Z",
    evidence: [],
    payload: { verificationId: "verification:unaccepted-kind", contractRevision: 1 },
  }));
  await value.ledger.append(parseHarnessEvent({
    id: "event:unaccepted-kind:result",
    type: "verification.result",
    schemaVersion: 1,
    streamId: value.streamId,
    workId: contract.id,
    actor: verifier,
    occurredAt: "2026-08-20T17:00:06.000Z",
    recordedAt: "2026-08-20T17:00:06.000Z",
    evidence: [{ id: "evidence:log", kind: "log", digest: "sha256:log" }],
    payload: {
      verificationId: "verification:unaccepted-kind",
      contractRevision: 1,
      status: "pass",
      criterionResults: [{
        criterionId: "criterion:behavior",
        status: "pass",
        evidence: [{ id: "evidence:log", kind: "log", digest: "sha256:log" }],
      }],
      evidenceSatisfaction: [{
        requirementId: "requirement:test",
        evidence: [{ id: "evidence:log", kind: "log", digest: "sha256:log" }],
      }],
      falsifiability: { provenCriteria: ["criterion:behavior"], exemptedCriteria: [] },
    },
  }));

  const readiness = acceptanceReadiness(projectBoard(await value.ledger.replay(value.streamId)));
  assert.equal(readiness.ready, false, "acceptance must reject evidence of unaccepted kind");
  assert.ok(readiness.reasons.some((reason) => reason.includes("not satisfied by an accepted evidence kind")));
});

test("a passing check bound to another requirement cannot satisfy this requirement", async () => {
  const contract = work({
    requiredEvidence: [
      { id: "requirement:a", description: "Requirement A", acceptedKinds: ["test"], required: true },
      { id: "requirement:b", description: "Requirement B", acceptedKinds: ["test"], required: true },
    ],
  });
  const value = await setup({ evidenceKind: "test" }, verifier, contract);
  const planAB = parseVerificationPlan({
    id: "plan:ab",
    workId: contract.id,
    contractRevision: 1,
    checks: [
      {
        id: "check:a",
        providerId: "verifier:test",
        description: "Check for requirement A",
        criterionIds: ["criterion:behavior"],
        requirementIds: ["requirement:a"],
        config: {},
      },
      {
        id: "check:a:control",
        providerId: "verifier:test",
        description: "Control for check:a",
        negativeControlFor: "check:a",
        perturbation: {
          kind: "overwrite-file",
          path: "src/feature.ts",
          content: "export const broken = true;\n",
          description: "content the check must reject",
        },
        config: {},
      },
      {
        id: "check:b",
        providerId: "verifier:test",
        description: "Check for requirement B",
        criterionIds: ["criterion:behavior"],
        requirementIds: ["requirement:b"],
        config: {},
      },
      {
        id: "check:b:control",
        providerId: "verifier:test",
        description: "Control for check:b",
        negativeControlFor: "check:b",
        perturbation: {
          kind: "overwrite-file",
          path: "src/feature.ts",
          content: "export const broken = true;\n",
          description: "content the check must reject",
        },
        config: {},
      },
    ],
  });
  const receipt = await value.engine.verify({
    streamId: value.streamId,
    work: value.contract,
    contractRevision: 1,
    workspace: value.workspaceProvider.workspace,
    expectedSnapshot: value.workspaceProvider.snapshotValue,
    plan: planAB,
  });
  assert.equal(receipt.status, "pass", "both checks pass");

  const board = projectBoard(await value.ledger.replay(value.streamId));
  const verification = board.verifications[0];
  const satA = verification?.evidenceSatisfaction.find((e) => e.requirementId === "requirement:a");
  const satB = verification?.evidenceSatisfaction.find((e) => e.requirementId === "requirement:b");

  assert.ok(satA?.evidence.length === 1, "requirement A should have evidence from check:a");
  assert.ok(satB?.evidence.length === 1, "requirement B should have evidence from check:b");
  assert.equal(satA?.evidence[0]?.id, "evidence:check:a", "requirement A evidence comes from check:a");
  assert.equal(satB?.evidence[0]?.id, "evidence:check:b", "requirement B evidence comes from check:b");
});

test("evidence from a check that did not pass cannot satisfy a required evidence requirement", async () => {
  const contract = parseWorkContract({
    id: "work:verify",
    objective: "Verify the exact SHIP workspace",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [
        { action: "read", resources: [{ uri: "repo://example", kind: "repository" }], constraints: [] },
        { action: "write", resources: [{ uri: "repo://example/src", kind: "directory" }], constraints: [] },
      ],
      requiresHumanApproval: ["publish"],
    },
    acceptanceCriteria: [{ id: "criterion:behavior", description: "Behavior is proven", required: true }],
    requiredEvidence: [
      { id: "requirement:a", description: "Requirement A", acceptedKinds: ["test"], required: true },
      { id: "requirement:b", description: "Requirement B", acceptedKinds: ["test"], required: true },
    ],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [worker.id], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false, falsifiabilityExemptions: [{ criterionId: "criterion:behavior", reason: "human-judgment", justification: "test exemption for status-pass-filter test", authorizedBy: human }] },
    createdBy: human,
    createdAt: "2026-08-20T17:00:00.000Z",
  });

  class FailingWithEvidenceVerifier implements VerifierProvider {
    readonly id = "verifier:failing-with-evidence";

    async describe(): Promise<VerifierDescriptor> {
      return {
        id: this.id,
        displayName: this.id,
        description: "Always fails but returns evidence",
        deterministic: true,
        readOnly: true,
        evidenceKinds: ["test"],
      };
    }

    async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
      return VerificationCheckResultSchema.parse({
        checkId: request.check.id,
        providerId: this.id,
        status: "fail",
        summary: `${request.check.id} fail`,
        evidence: [{ id: `evidence:${request.check.id}`, kind: "test", digest: `sha256:${request.check.id}` }],
        startedAt: "2026-08-20T17:00:02.000Z",
        finishedAt: "2026-08-20T17:00:03.000Z",
      });
    }

    async close(): Promise<void> {}
  }

  const provider = new FailingWithEvidenceVerifier();
  const ledger = new InMemoryEventLedger();
  const streamId = await seed(ledger, contract);
  const workspaceProvider = new MutableWorkspaceProvider();

  let counter = 0;
  const engine = new VerificationEngine({
    ledger,
    workspaceProvider,
    verifierCatalog: new VerifierCatalog(provider),
    verifier,
    now: () => "2026-08-20T17:00:04.000Z",
    idFactory: () => `id-fail-ev-${++counter}`,
  });

  const planMixed = parseVerificationPlan({
    id: "plan:mixed",
    workId: contract.id,
    contractRevision: 1,
    checks: [
      {
        id: "check:a",
        providerId: "verifier:failing-with-evidence",
        description: "Check for requirement A",
        criterionIds: ["criterion:behavior"],
        requirementIds: ["requirement:a"],
        config: {},
      },
      {
        id: "check:b",
        providerId: "verifier:failing-with-evidence",
        description: "Check for requirement B",
        criterionIds: ["criterion:behavior"],
        requirementIds: ["requirement:b"],
        config: {},
      },
    ],
  });

  await engine.verify({
    streamId,
    work: contract,
    contractRevision: 1,
    workspace: workspaceProvider.workspace,
    expectedSnapshot: workspaceProvider.snapshotValue,
    plan: planMixed,
  });

  const board = projectBoard(await ledger.replay(streamId));
  const verification = board.verifications[0];
  const satA = verification?.evidenceSatisfaction.find((e) => e.requirementId === "requirement:a");
  const satB = verification?.evidenceSatisfaction.find((e) => e.requirementId === "requirement:b");

  assert.equal(verification?.status, "fail", "verification should fail because all checks fail");

  assert.ok(!satA || satA.evidence.length === 0, "failing check should NOT provide evidence for requirement:a");
  assert.ok(!satB || satB.evidence.length === 0, "failing check should NOT provide evidence for requirement:b");
});
