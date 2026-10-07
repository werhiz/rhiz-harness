import assert from "node:assert/strict";
import test from "node:test";
import { CrewSupervisor, parseCrewPlan, type CrewWorkspaceProvider, type CrewWorkspaceSnapshot, type CrewWorkerResolver } from "../src/crew.js";
import type { WorkerCapabilities, WorkerHandle, WorkerObservation, WorkerProvider, WorkerStartOptions, WorkerStartRequest } from "../src/host.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { selectWorkerProvider } from "../src/workers.js";
import { human, work, sandboxCapableCatalog, testDigestScope } from "./helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, milliseconds = 1600): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Crew did not return a receipt after its attempt deadline")), milliseconds);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fixture(start: (input: WorkerStartRequest, options?: WorkerStartOptions) => Promise<WorkerHandle>, options: { ship?: boolean; close?: () => Promise<void>; snapshot?: (workspaceId: string, call: number) => Promise<CrewWorkspaceSnapshot>; capabilities?: (call: number) => Promise<WorkerCapabilities> } = {}) {
  const descriptor = {
    id: "worker:deadline", displayName: "Deadline fixture", description: "Controllable lifecycle fixture",
    bindsWorkspace: true, adapter: "test", product: "deadline", execution: "one-shot" as const,
    context: "standalone" as const, authorityMode: "test", writeAccess: options.ship ? "workspace" as const : "none" as const,
    dangerous: false, credentialEnv: [],
  };
  let capabilityCalls = 0;
  const provider: WorkerProvider = {
    id: descriptor.id, describe: async () => descriptor,
    capabilities: async () => {
      capabilityCalls += 1;
      return options.capabilities === undefined
        ? { streamingObservations: true, cancel: true, resume: false, guardedToolMediation: true }
        : options.capabilities(capabilityCalls);
    }, start,
  };
  const contract = work({
    id: "work:deadline", type: options.ship ? "SHIP" : "SCOUT", ...(options.ship ? {} : { writeScope: [] }),
    workerPolicy: { preferredProviders: [provider.id], maxAttempts: 1, allowParallelAttempts: false, explicitProviderAuthorizations: [], attemptBudgetMs: 30 },
  });
  let snapshotCalls = 0;
  const workspaceProvider: CrewWorkspaceProvider = {
    id: "workspace:deadline",
    acquire: async (request) => ({ leaseId: "lease:deadline", workspaceId: "workspace:deadline", uri: "memory://deadline", executionRoot: "/memory/deadline", baseRevision: request.baseRevision, mode: request.mode }),
    snapshot: async (workspace) => {
      snapshotCalls += 1;
      return options.snapshot === undefined
        ? { workspaceId: workspace.workspaceId, head: workspace.baseRevision, digest: "sha256:clean", digestScope: testDigestScope, changedPaths: [], observedAt: new Date().toISOString() }
        : options.snapshot(workspace.workspaceId, snapshotCalls);
    },
    release: async () => {}, close: async () => {},
  };
  const resolver: CrewWorkerResolver = {
    resolve: async (request) => ({ selection: await selectWorkerProvider(request.registry, request.mission.work, request.requirements), provider, close: options.close ?? (async () => {}) }),
  };
  const ledger = new InMemoryEventLedger();
  const supervisor = new CrewSupervisor({
    plan: parseCrewPlan({ id: "crew:deadline", objective: "Bound the worker lifecycle", baseRevision: "abc", maxParallel: 1, missions: [{ work: contract, workspace: { strategy: "fresh", mode: options.ship ? "isolated-write" : "read-only" } }] }),
    ledger, workerCatalog: sandboxCapableCatalog(provider), workspaceProvider, workerResolver: resolver, actor: human,
  });
  return { ledger, run: supervisor.run(), events: () => ledger.replay("stream:work:deadline") };
}

function handle(input: WorkerStartRequest, overrides: Partial<WorkerHandle> = {}): WorkerHandle {
  return {
    workerId: "worker:deadline", attemptId: input.attemptId,
    async *observe() {}, result: async () => ({ status: "finished", summary: "Done", artifacts: [], evidence: [] }), cancel: async () => {},
    ...overrides,
  };
}

for (const phase of ["startup", "cancellation", "observations", "completed-result-observations"] as const) {
  test(`Crew deadline bounds ${phase} and returns one durable failure`, async () => {
    const release = deferred<void>();
    let cancelCalls = 0;
    const setup = fixture(async (input) => {
      if (phase === "startup") await release.promise;
      return handle(input, {
        result: phase === "completed-result-observations" ? async () => ({ status: "finished", summary: "Done", artifacts: [], evidence: [], observedUsage: { source: "provider-reported", inputTokens: 12 } }) : async () => { await release.promise; return { status: "cancelled", summary: "Stopped", artifacts: [], evidence: [] }; },
        cancel: async () => { cancelCalls += 1; if (phase === "cancellation") await release.promise; },
        async *observe() {
          if (phase.endsWith("observations")) {
            await release.promise;
            yield { kind: "activity", detail: "Late observation after timeout", occurredAt: new Date().toISOString() };
          }
        },
      });
    });
    try {
      const run = await within(setup.run);
      assert.equal(run.receipt.missions[0]?.status, "failed");
      assert.equal(run.receipt.missions[0]?.projectionViolationCount, 0);
      assert.match(run.receipt.missions[0]?.error ?? "", /deadline/);
      const events = await setup.events();
      assert.equal(events.filter((event) => event.type === "attempt.failed").length, 1);
      assert.equal(events.filter((event) => event.type === "attempt.finished").length, 0);
      const failed = events.find(event => event.type === "attempt.failed");
      assert.deepEqual(failed?.payload.observedUsage, phase === "completed-result-observations" ? { source: "provider-reported", inputTokens: 12 } : undefined);
      await run.close();
    } finally {
      release.resolve();
      const completed = await setup.run;
      await completed.close();
      const lateEvents = await setup.events();
      assert.equal(lateEvents.filter((event) => event.type === "attempt.failed").length, 1);
      assert.equal(lateEvents.filter((event) => event.type === "attempt.finished").length, 0);
      assert.equal(lateEvents.filter((event) => event.type === "attempt.activity-observed" || event.type === "guard.evaluated").length, 0);
      if (phase === "startup") assert.equal(cancelCalls, 1, "late startup handle was not cancelled");
    }
  });
}

test("Crew refuses a Guard call that arrives after the Attempt deadline", async () => {
  let mediation: WorkerStartOptions["guardedToolMediation"];
  const release = deferred<void>();
  const setup = fixture(async (input, options) => {
    mediation = options?.guardedToolMediation;
    return handle(input, { result: async () => { await release.promise; return { status: "finished", summary: "Late", artifacts: [], evidence: [] }; } });
  }, { ship: true });

  try {
    const run = await within(setup.run);
    assert.equal(run.receipt.missions[0]?.status, "failed");
    assert.ok(mediation, "Crew did not pass Guard mediation to the write-capable worker");
    const evaluation = await mediation.evaluate({
      requestId: "request:after-deadline",
      tool: { name: "fs.write", category: "write", args: { path: "src/example.ts" } },
    });
    assert.equal(evaluation.verdict.decision, "forbid");
    assert.match(evaluation.verdict.rationale, /Attempt is closed/);
    const events = await setup.events();
    assert.equal(events.filter((event) => event.type === "guard.evaluated").length, 0);
    await run.close();
  } finally {
    release.resolve();
    await setup.run.then((run) => run.close());
  }
});

test("Crew deadline also bounds the post-result workspace snapshot", async () => {
  const never = deferred<void>();
  const setup = fixture(async (input) => handle(input, { result: async () => ({ status: "finished", summary: "Done", artifacts: [], evidence: [], observedUsage: { source: "provider-reported", inputTokens: 12 } }) }), {
    snapshot: async (workspaceId, call) => {
      if (call > 1) await never.promise;
      return { workspaceId, head: "abc", digest: "sha256:clean", digestScope: testDigestScope, changedPaths: [], observedAt: new Date().toISOString() };
    },
  });
  const run = await within(setup.run);
  assert.equal(run.receipt.missions[0]?.status, "failed");
  assert.match(run.receipt.missions[0]?.error ?? "", /deadline/);
  const events = await setup.events();
  assert.equal(events.filter((event) => event.type === "attempt.failed").length, 1);
  assert.equal(events.filter((event) => event.type === "attempt.finished").length, 0);
  assert.deepEqual(events.find(event => event.type === "attempt.failed")?.payload.observedUsage, { source: "provider-reported", inputTokens: 12 });
  await run.close();
});

test("Crew preserves resolved usage when observation draining fails", async () => {
  const setup = fixture(async input => handle(input, {
    result: async () => ({ status: "finished", summary: "Done", artifacts: [], evidence: [], observedUsage: { source: "provider-reported", inputTokens: 17 } }),
    async *observe() { await new Promise(resolve => setImmediate(resolve)); throw new Error("observation drain failed"); },
  }));
  const run = await within(setup.run);
  try {
    const failed = (await setup.events()).find(event => event.type === "attempt.failed");
    assert.match(failed?.payload.reason ?? "", /observation drain failed/);
    assert.deepEqual(failed?.payload.observedUsage, { source: "provider-reported", inputTokens: 17 });
  } finally { await run.close(); }
});

test("deadline cleanup retains prompt partial usage and freezes out late results", async () => {
  for (const prompt of [true, false]) {
    const response = deferred<Awaited<ReturnType<WorkerHandle["result"]>>>();
    const partial = { status: "cancelled" as const, summary: "Cancelled", artifacts: [], evidence: [],
      observedUsage: { source: "provider-reported" as const, complete: false, inputTokens: 23 } };
    const setup = fixture(async input => handle(input, {
      result: () => response.promise,
      cancel: async () => { if (prompt) response.resolve(partial); },
    }));
    const run = await within(setup.run);
    try {
      const before = await setup.events();
      const failed = before.find(event => event.type === "attempt.failed");
      assert.equal(before.filter(event => event.type === "attempt.failed").length, 1);
      assert.deepEqual(failed?.payload.observedUsage, prompt ? partial.observedUsage : undefined);
      assert.deepEqual(run.receipt.missions[0]?.workerResult?.observedUsage, prompt ? partial.observedUsage : undefined);
      response.resolve(partial);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(await setup.events(), before);
      assert.deepEqual(run.receipt.missions[0]?.workerResult?.observedUsage, prompt ? partial.observedUsage : undefined);
    } finally { response.resolve(partial); await run.close(); }
  }
});

test("Crew deadline bounds SHIP authority preflight", async () => {
  const never = deferred<void>();
  const setup = fixture(async (input) => handle(input), {
    ship: true,
    capabilities: async (call) => {
      // Selection discovers the provider first; the next capability probe is
      // the contract-bound authority proof performed after attempt.started.
      if (call === 2) await never.promise;
      return { streamingObservations: true, cancel: true, resume: false, guardedToolMediation: true };
    },
  });
  try {
    const run = await within(setup.run);
    assert.equal(run.receipt.missions[0]?.status, "failed");
    assert.match(run.receipt.missions[0]?.error ?? "", /attempt deadline/);
    assert.equal(run.receipt.missions[0]?.projectionViolationCount, 0);
    const events = await setup.events();
    assert.equal(events.filter((event) => event.type === "attempt.failed").length, 1);
    assert.equal(events.filter((event) => event.type === "attempt.finished").length, 0);
    await run.close();
  } finally {
    never.resolve();
    await setup.run.then((run) => run.close());
  }
});
