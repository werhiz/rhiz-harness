import assert from "node:assert/strict";
import test from "node:test";

import { CrewSupervisor, type CrewWorkspace, type CrewWorkspaceAcquireRequest, type CrewWorkspaceProvider, type CrewWorkspaceSnapshot, parseCrewPlan } from "../src/crew.js";
import type { GuardVerdict } from "../src/guard.js";
import type { HarnessHost, HostCapabilities, SandboxProvider, WorkerCapabilities, WorkerDescriptor, WorkerHandle, WorkerObservation, WorkerProvider, WorkerRegistry, WorkerResult, WorkerStartOptions, WorkerStartRequest } from "../src/host.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { parseWorkContract } from "../src/schemas.js";
import { WorkerCatalog } from "../src/workers.js";
import { human, testDigestScope } from "./helpers.js";

class StableWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:stable";
  readonly workspace: CrewWorkspace = {
    leaseId: "lease:stable",
    workspaceId: "workspace:stable",
    uri: "file:///tmp/rhiz-contract-bound-authority",
    executionRoot: "/tmp/rhiz-contract-bound-authority",
    baseRevision: "a".repeat(40),
    mode: "isolated-write",
  };

  async acquire(_request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> {
    return this.workspace;
  }

  async snapshot(workspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot> {
    return {
      workspaceId: workspace.workspaceId,
      head: workspace.baseRevision,
      digest: `sha256:${"b".repeat(64)}`,
      digestScope: testDigestScope,
      changedPaths: [],
      observedAt: "2026-08-27T06:00:00.000Z",
    };
  }

  async release(_workspaceId: string): Promise<void> {}
  async close(): Promise<void> {}
}

class EmptyHandle implements WorkerHandle {
  readonly workerId: string;
  readonly attemptId: string;

  constructor(providerId: string, input: WorkerStartRequest) {
    this.workerId = `${providerId}:${input.attemptId}`;
    this.attemptId = input.attemptId;
  }

  async *observe(): AsyncIterable<WorkerObservation> {}

  async result(): Promise<WorkerResult> {
    return { status: "finished", summary: "authority probe finished", artifacts: [], evidence: [] };
  }

  async cancel(_reason: string): Promise<void> {}
}

class AuthorityProbeProvider implements WorkerProvider {
  readonly id = "worker:authority-probe";
  verdict: GuardVerdict | null = null;

  async describe(): Promise<WorkerDescriptor> {
    return {
      id: this.id,
      displayName: "Authority Probe",
      description: "Exercises Crew's real Guard mediation seam",
      adapter: "authority-probe",
      product: "authority-probe",
      execution: "one-shot",
      context: "standalone",
      authorityMode: "test",
      writeAccess: "workspace",
      dangerous: false,
      bindsWorkspace: true,
      credentialEnv: [],
    };
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return { streamingObservations: false, cancel: true, resume: false, guardedToolMediation: true };
  }

  async start(input: WorkerStartRequest, options: WorkerStartOptions = {}): Promise<WorkerHandle> {
    assert.ok(options.guardedToolMediation, "Crew did not wire Guard mediation for isolated-write Work");
    const evaluation = await options.guardedToolMediation.evaluate({
      requestId: "request:crew-contract-bound-write",
      tool: { name: "future-provider:patch", category: "write", args: { path: "src/example.ts" } },
    });
    this.verdict = evaluation.verdict;
    return new EmptyHandle(this.id, input);
  }
}

class ProbeHost implements HarnessHost {
  readonly id = "host:authority-probe";
  readonly #registry: WorkerCatalog;

  constructor(provider: WorkerProvider, readonly exposeSandbox: boolean) {
    this.#registry = new WorkerCatalog(provider);
  }

  async capabilities(): Promise<HostCapabilities> {
    return { workers: true, processes: false, sessions: false, filesystem: false, sandbox: true, tools: false };
  }

  workers(): WorkerRegistry { return this.#registry; }
  processes(): null { return null; }
  sessions(): null { return null; }
  filesystem(): null { return null; }
  sandbox(): SandboxProvider | null { return this.exposeSandbox ? { id: "sandbox:authority-probe" } : null; }
  tools(): null { return null; }
  async close(): Promise<void> {}
}

function shipWork(options: { narrowGrant?: boolean } = {}) {
  return parseWorkContract({
    id: "work:crew-contract-bound-authority",
    objective: "Exercise contract-bound category authority",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [
        { action: "read", resources: [{ uri: "repo://example", kind: "repository" }], constraints: [] },
        {
          action: "write",
          resources: [{
            uri: options.narrowGrant ? "repo://example/src/only.ts" : "repo://example/src",
            kind: options.narrowGrant ? "file" : "directory",
          }],
          constraints: [],
        },
      ],
      requiresHumanApproval: [],
    },
    acceptanceCriteria: [{ id: "criterion:authority", description: "Crew reaches the execution boundary", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: false },
    dependencies: [],
    workerPolicy: {
      preferredProviders: ["worker:authority-probe"],
      maxAttempts: 1,
      allowParallelAttempts: false,
      explicitProviderAuthorizations: [],
    },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-08-27T06:00:00.000Z",
  });
}

async function runProbe(options: { exposeSandbox?: boolean; narrowGrant?: boolean } = {}) {
  const provider = new AuthorityProbeProvider();
  const host = new ProbeHost(provider, options.exposeSandbox ?? true);
  const catalog = new WorkerCatalog();
  catalog.registerHost(host);
  const workspaceProvider = new StableWorkspaceProvider();
  const work = shipWork(options.narrowGrant === undefined ? {} : { narrowGrant: options.narrowGrant });
  const run = await new CrewSupervisor({
    plan: parseCrewPlan({
      id: "crew:contract-bound-authority",
      objective: "Exercise category authority admission",
      baseRevision: workspaceProvider.workspace.baseRevision,
      maxParallel: 1,
      missions: [{
        work,
        workspace: { strategy: "fresh", mode: "isolated-write" },
        requiredCapabilities: ["guardedToolMediation"],
        allowDangerousWorker: false,
      }],
    }),
    ledger: new InMemoryEventLedger(),
    workerCatalog: catalog,
    workspaceProvider,
    actor: human,
    now: () => "2026-08-27T06:00:00.000Z",
    idFactory: (() => {
      let counter = 0;
      return () => String(++counter);
    })(),
  }).run();
  return { run, provider };
}

test("Crew activates Work write-category authority after every physical admission gate passes", async () => {
  const { run, provider } = await runProbe();
  try {
    assert.equal(run.receipt.missions[0]?.status, "execution-finished");
    assert.equal(provider.verdict?.decision, "allow");
    assert.ok(provider.verdict?.ruleHits.includes("per-category-mode:write:allow"));
  } finally {
    await run.close();
  }
});

test("Crew keeps category authority dormant when a host claims sandbox capability but exposes no sandbox", async () => {
  const { run, provider } = await runProbe({ exposeSandbox: false });
  try {
    assert.equal(run.receipt.missions[0]?.status, "execution-finished");
    assert.equal(provider.verdict?.decision, "forbid");
    assert.ok(provider.verdict?.ruleHits.includes("default-deny:no-per-tool-mode-match"));
  } finally {
    await run.close();
  }
});

test("Crew keeps category authority dormant when the Work write grant does not cover writeScope", async () => {
  const { run, provider } = await runProbe({ narrowGrant: true });
  try {
    assert.equal(run.receipt.missions[0]?.status, "execution-finished");
    assert.equal(provider.verdict?.decision, "forbid");
  } finally {
    await run.close();
  }
});
