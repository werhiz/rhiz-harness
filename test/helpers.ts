import type { WorkerProvider } from "../src/host.js";
import { parseBenchmarkRun, type BenchmarkRun } from "../src/benchmark.js";
import type { ActorRef, HarnessEvent, WorkContract } from "../src/schemas.js";
import { parseHarnessEvent, parseWorkContract } from "../src/schemas.js";
import { WorkerCatalog } from "../src/workers.js";

export const human: ActorRef = { id: "human:owner", kind: "human", displayName: "Owner" };
export const worker: ActorRef = { id: "agent:worker", kind: "agent", displayName: "Worker" };
export const verifier: ActorRef = { id: "agent:verifier", kind: "verifier", displayName: "Verifier" };
export const reviewer: ActorRef = { id: "agent:reviewer", kind: "verifier", displayName: "Reviewer" };

export function work(overrides: Partial<WorkContract> = {}): WorkContract {
  return parseWorkContract({
    id: "work:1",
    objective: "Implement the requested bounded change",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [
        { action: "read", resources: [{ uri: "repo://example" }], constraints: [] },
        { action: "write", resources: [{ uri: "repo://example/src" }], constraints: [] },
      ],
      requiresHumanApproval: ["publish"],
    },
    acceptanceCriteria: [{ id: "criterion:tests", description: "Tests prove behavior", required: true }],
    requiredEvidence: [{ id: "evidence:tests", description: "Passing test evidence", acceptedKinds: ["test"], required: true }],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 3, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-08-20T04:00:00.000Z",
    ...overrides,
  });
}

let eventCounter = 0;
export function event<T extends HarnessEvent["type"]>(
  type: T,
  payload: Extract<HarnessEvent, { type: T }>["payload"],
  overrides: Partial<Omit<Extract<HarnessEvent, { type: T }>, "type" | "payload">> = {},
): Extract<HarnessEvent, { type: T }> {
  eventCounter += 1;
  return parseHarnessEvent({
    id: `event:${eventCounter}`,
    type,
    schemaVersion: 1,
    streamId: "stream:work:1",
    workId: "work:1",
    actor: human,
    occurredAt: "2026-08-20T04:00:00.000Z",
    recordedAt: "2026-08-20T04:00:01.000Z",
    evidence: [],
    payload,
    ...overrides,
  }) as Extract<HarnessEvent, { type: T }>;
}

/**
 * A Work a worker actually executed.
 *
 * The lease, the streamed observation, and the Guard-mediated write are not
 * decoration: they are what the Board requires before it will call a Work
 * done. A fixture without them describes a Work that reached completion with
 * nobody having run, which is the fiction `authorshipUnproven` exists to
 * refuse. Use `ingestedExecution` when that is the thing under test.
 */
export function successfulExecution(contract = work()) {
  return [
    event("work.created", { contract, revision: 1 }),
    event("task.created", { objective: "Implement" }, { taskId: "task:1" }),
    event("task.assigned", { worker }, { taskId: "task:1" }),
    event("attempt.started", {
      worker,
      contractRevision: 1,
      lease: {
        id: "lease:1",
        workspaceId: "workspace:1",
        resourceClaims: [{ kind: "path", resource: "src" }],
        acquiredAt: "2026-08-20T04:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    event("attempt.activity-observed", {
      state: "working",
      detail: "message: worker edited src/feature.ts",
      source: "agent:worker",
      authority: "observation",
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    guardedWrite(),
    event("attempt.finished", { resultSummary: "Implementation complete", artifactRefs: [] }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
  ] as HarnessEvent[];
}

/** One Guard-authorized write by the executing worker. */
export function guardedWrite(attemptId = "attempt:1", taskId = "task:1") {
  return event("guard.evaluated", {
    request: {
      requestId: `guard:${attemptId}:write`,
      workId: "work:1",
      taskId,
      attemptId,
      actor: worker,
      writeScope: "workspace",
      contextHash: `ctx:${attemptId}`,
      evidenceRefs: [],
      timestampMs: 1787000000000,
      tool: { name: "worker:file-change", category: "write", args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } },
    },
    verdict: {
      requestId: `guard:${attemptId}:write`,
      decision: "allow",
      rationale: "fixture write authorized",
      riskLevel: "medium",
      ruleHits: ["per-category-mode:write:allow"],
      evaluatedAt: "2026-08-20T04:00:00.500Z",
      durationMs: 1,
      policyBackend: "rhiz-native",
      policyBackendVersion: "0.1.0",
    },
  }, { taskId, attemptId, actor: worker });
}

/**
 * The same Work SHAPE, produced by replaying a candidate made elsewhere: a
 * worker is named, an attempt starts and finishes, and nothing ever ran.
 * This is the sequence the #108 dogfood adapter wrote.
 */
export function ingestedExecution(contract = work()) {
  return [
    event("work.created", { contract, revision: 1 }),
    event("task.created", { objective: "Ingest an existing candidate" }, { taskId: "task:1" }),
    event("task.assigned", { worker }, { taskId: "task:1" }),
    event("attempt.started", {
      worker,
      contractRevision: 1,
      lease: {
        id: "lease:1",
        workspaceId: "workspace:1",
        resourceClaims: [{ kind: "path", resource: "src" }],
        acquiredAt: "2026-08-20T04:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    event("attempt.finished", { resultSummary: "Imported exact candidate produced outside this attempt", artifactRefs: [] }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
  ] as HarnessEvent[];
}

export function verificationStart(actor: ActorRef = verifier, contractRevision = 1, verificationId = "verification:1") {
  return event(
    "verification.started",
    { verificationId, contractRevision },
    { actor },
  );
}

export function passingVerification(actor: ActorRef = verifier, contractRevision = 1, verificationId = "verification:1") {
  return event(
    "verification.result",
    {
      verificationId,
      contractRevision,
      status: "pass",
      criterionResults: [
        {
          criterionId: "criterion:tests",
          status: "pass",
          evidence: [{ id: "proof:test", kind: "test", digest: "sha256:abc" }],
        },
      ],
      evidenceSatisfaction: [
        {
          requirementId: "evidence:tests",
          evidence: [{ id: "proof:test", kind: "test", digest: "sha256:abc" }],
        },
      ],
      falsifiability: { provenCriteria: ["criterion:tests"], exemptedCriteria: [] },
    },
    { actor },
  );
}

export function passingVerificationSequence(actor: ActorRef = verifier, contractRevision = 1, verificationId = "verification:1") {
  return [
    verificationStart(actor, contractRevision, verificationId),
    passingVerification(actor, contractRevision, verificationId),
  ] as HarnessEvent[];
}

export const boundWorkspace = {
  workspaceId: "workspace:test",
  leaseId: "lease:test",
  uri: "file:///memory/test",
  executionRoot: "/memory/test",
  mode: "isolated-write" as const,
  baseRevision: "0".repeat(40),
  expectedHead: "0".repeat(40),
  expectedDigest: `sha256:${"0".repeat(64)}`,
};

export function readOnlyWorkspace() {
  return { ...boundWorkspace, mode: "read-only" as const };
}

/**
 * A digest scope for fixtures that do not walk a real filesystem.
 *
 * Deliberately shaped like a real one rather than a blank: a fixture that
 * declared an empty exclusion list and zero files would let a test pass while
 * describing coverage no walk ever produced.
 */
export const testDigestScope = {
  algorithm: "sha256" as const,
  strategy: "execution-root-content" as const,
  exclusions: [".git"],
  fileCount: 1,
  totalBytes: 32,
  symlinkCount: 0,
};

/**
 * A WorkerCatalog whose providers arrive through a host that declares OS
 * containment.
 *
 * Write-enabled Crew work refuses any provider whose host does not impose a
 * boundary (issue #11, ADR 0020), and a provider registered with no host has no
 * host to impose one. Fixtures that exercise Crew orchestration rather than
 * containment itself register through this so the mission under test is the one
 * the fixture meant to write, not a containment refusal.
 */
export function sandboxCapableCatalog(...providers: WorkerProvider[]): WorkerCatalog {
  const catalog = new WorkerCatalog();
  catalog.registerHost({
    id: "host:test-contained",
    async capabilities() {
      return { workers: true, processes: true, sessions: false, filesystem: false, sandbox: true, tools: false };
    },
    workers() {
      return {
        list: () => providers,
        get: (id: string) => providers.find((provider) => provider.id === id),
      };
    },
    processes: () => null,
    sessions: () => null,
    filesystem: () => null,
    sandbox: () => ({ id: "sandbox:test" }),
    tools: () => null,
    async close() {},
  });
  return catalog;
}

/** A schema-valid BenchmarkRun that passes the comparison controls against a sibling variant. */
export function benchRun(overrides: Record<string, unknown> = {}): BenchmarkRun {
  const verified = overrides.verified ?? true;
  return parseBenchmarkRun({
    benchmarkCaseId: "case:1",
    taskIdentity: `sha256:${"a".repeat(64)}`,
    capabilityExposureDigest: null,
    preparationIdentity: null,
    harnessMode: "rhiz-harness",
    harnessVersion: "0.0.1-kernel.0",
    variantId: "baseline",
    workId: "work:1",
    attemptIds: ["attempt:1"],
    baseIdentity: "git:base",
    resultIdentity: "git:result",
    hostId: "host:local",
    workerProviderId: "worker:codex",
    model: "model-a",
    effortLevel: "medium",
    contextStrategy: "minimal",
    verificationPolicyId: "verify:1",
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:10:00.000Z",
    measurementCoverage: { wallClock: "runner-measured", humanInterventions: "complete", usage: "provider-reported" },
    usage: { costUsd: 1 },
    humanInterventions: [],
    outcome: verified ? "verified" : "failed",
    verified,
    repairRequired: false,
    evidenceRefs: [],
    ...overrides,
  });
}
