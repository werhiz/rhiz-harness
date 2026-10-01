import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DshProductWorkerHost,
  type DshSubagentRun,
  type DshSubagentRuntime,
  type DshSubagentStartRequest,
} from "../adapters/dsh/product-routes.js";
import { DurableEventLedger } from "../adapters/local/durable-ledger.js";
import { projectBoard } from "../src/board.js";
import {
  CrewSupervisor,
  parseCrewPlan,
  type CrewWorkspace,
  type CrewWorkspaceAcquireRequest,
  type CrewWorkspaceProvider,
  type CrewWorkspaceSnapshot,
} from "../src/crew.js";
import type {
  WorkerStartOptions,
  HarnessHost,
  HostCapabilities,
  WorkerCapabilities,
  WorkerDescriptor,
  WorkerHandle,
  WorkerProvider,
  WorkerRegistry,
  WorkerResult,
  WorkerStartRequest,
} from "../src/host.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { WorkerCatalog, WorkerSelectionError, selectWorkerProvider, startWorkerAttempt } from "../src/workers.js";
import {
  createDefaultPolicyOracle,
  createGuardedToolMediation,
  summarizeGuardEvaluation,
  GuardConfigurationError,
  GuardianRejectionCircuitBreaker,
  GuardPolicySchema,
  GuardVerdictSchema,
  type GuardEvaluation,
  type GuardEvaluationRecord,
  type GuardPolicy,
  type GuardToolCall,
  type GuardVerdict,
  type PolicyOracle,
} from "../src/guard.js";
import { event, human, testDigestScope, work } from "./helpers.js";

type NativeToolCall = {
  requestId: string;
  tool: {
    name: string;
    category: GuardToolCall["tool"]["category"];
    args: Record<string, unknown>;
  };
};

type NativePermissionCallback = (call: NativeToolCall) => Promise<{ decision: string }>;

class SimulatedClaudeRuntime implements DshSubagentRuntime {
  readonly starts: DshSubagentStartRequest[] = [];
  readonly verdicts: Array<{ decision: string }> = [];
  closeCalls = 0;

  constructor(
    readonly marker: string,
    readonly toolCall: NativeToolCall = {
      requestId: "native:git-push",
      tool: {
        name: "git.push",
        category: "shell",
        args: { remote: "origin", ref: "main" },
      },
    },
  ) {}

  listProviders(): readonly string[] {
    return ["rhiz-claude"];
  }

  // The product adapter must inspect this claim before advertising its own
  // capability. The current contract has no such query, which is why the test
  // must fail before the mediation seam exists.
  async capabilities(): Promise<{ guardedToolMediation: boolean }> {
    return { guardedToolMediation: true };
  }

  async start(_providerName: string, rawRequest: DshSubagentStartRequest): Promise<DshSubagentRun> {
    this.starts.push(rawRequest);
    const request = rawRequest as DshSubagentStartRequest & { canUseTool?: NativePermissionCallback };
    const verdict = request.canUseTool === undefined
      ? { decision: "allow" }
      : await request.canUseTool(this.toolCall);
    this.verdicts.push(verdict);

    // This is the observable boundary: a real native provider effects the
    // operation only after its synchronous permission callback returns allow.
    if (verdict.decision !== "forbid") await writeFile(this.marker, "shared ref changed\n");

    return {
      id: "native-run:guard-mediation",
      result: Promise.resolve({ stopReason: "completed", outputText: "native call resolved" }),
      async dispose() {},
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class OneWorkspace implements CrewWorkspaceProvider {
  readonly id = "workspace:guard-mediation";

  constructor(readonly root: string) {}

  async acquire(request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> {
    return {
      leaseId: "lease:guard-mediation",
      workspaceId: "workspace:guard-mediation",
      uri: `file://${this.root}`,
      executionRoot: this.root,
      baseRevision: request.baseRevision,
      mode: request.mode,
    };
  }

  async snapshot(workspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot> {
    return {
      workspaceId: workspace.workspaceId,
      head: workspace.baseRevision,
      digest: `sha256:${"0".repeat(64)}`,
      digestScope: testDigestScope,
      changedPaths: [],
      observedAt: "2026-08-24T04:00:00.000Z",
    };
  }

  async release(): Promise<void> {}
  async close(): Promise<void> {}
}

function hostFor(provider: WorkerProvider): HarnessHost {
  const registry: WorkerRegistry = {
    list: () => [provider],
    get: (id) => (id === provider.id ? provider : undefined),
  };
  return {
    id: "host:guard-mediation",
    async capabilities(): Promise<HostCapabilities> {
      return { workers: true, processes: false, sessions: false, filesystem: false, sandbox: true, tools: false };
    },
    workers: () => registry,
    processes: () => null,
    sessions: () => null,
    filesystem: () => null,
    sandbox: () => null,
    tools: () => null,
    async close() {},
  };
}

class CapabilityProvider implements WorkerProvider {
  starts = 0;

  constructor(readonly id: string, readonly mediation: boolean) {}

  async describe(): Promise<WorkerDescriptor> {
    return {
      id: this.id,
      displayName: this.id,
      description: "capability-fixture",
      adapter: "test",
      product: "test",
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
    return {
      streamingObservations: true,
      cancel: false,
      resume: false,
      guardedToolMediation: this.mediation,
    } as unknown as WorkerCapabilities;
  }

  async start(input: WorkerStartRequest): Promise<WorkerHandle> {
    this.starts += 1;
    return {
      workerId: `${this.id}:${input.attemptId}`,
      attemptId: input.attemptId,
      async *observe() {},
      async result(): Promise<WorkerResult> {
        return { status: "finished", summary: "started", artifacts: [], evidence: [] };
      },
      async cancel() {},
    };
  }
}

test("a native Claude tool request is denied before effect and its Guard verdict survives Board replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-mediation-effect-"));
  const marker = join(root, "shared-main-mutated");
  const runtime = new SimulatedClaudeRuntime(marker);
  const productHost = new DshProductWorkerHost({
    routes: [{ product: "claude-code", permissionMode: "acceptEdits", guardedToolMediation: true }],
    runtimeFactory: async () => runtime,
    now: () => "2026-08-24T04:00:00.000Z",
  });
  const provider = productHost.workers().get("worker:claude")!;
  const catalog = new WorkerCatalog();
  catalog.registerHost(hostFor(provider));
  const ledger = new InMemoryEventLedger();
  let idCounter = 0;
  const contract = work({
    id: "work:guard-mediation",
    workerPolicy: {
      preferredProviders: ["worker:claude"],
      maxAttempts: 1,
      allowParallelAttempts: false,
      explicitProviderAuthorizations: [],
    },
  });

  try {
    const run = await new CrewSupervisor({
      plan: parseCrewPlan({
        id: "crew:guard-mediation",
        objective: "A denied native tool call has no effect",
        baseRevision: "0".repeat(40),
        missions: [{
          work: contract,
          workspace: { strategy: "fresh", mode: "isolated-write" },
          requiredCapabilities: [],
        }],
      }),
      ledger,
      workerCatalog: catalog,
      workspaceProvider: new OneWorkspace(root),
      actor: human,
      now: () => "2026-08-24T04:00:00.000Z",
      idFactory: () => `guard-mediation-${++idCounter}`,
    }).run();

    const mission = run.receipt.missions[0]!;
    assert.equal(mission.status, "execution-finished", mission.error ?? "mission did not reach execution");
    assert.equal(existsSync(marker), false, "Guard DENY was returned but the native operation still took effect");

    const events = await ledger.replay(mission.streamId!);
    const evaluations = events.filter((event) => (event as { type: string }).type === "guard.evaluated");
    assert.equal(evaluations.length, 1, "the native Guard verdict was not durably recorded");
    const board = projectBoard(events);
    const guardEvaluations = (board as typeof board & {
      guardEvaluations: Array<{ verdict: { decision: string } }>;
    }).guardEvaluations;
    assert.equal(guardEvaluations.length, 1, "Ledger replay did not reconstruct the Guard verdict");
    assert.equal(guardEvaluations[0]?.verdict.decision, "forbid");
    await run.close();
  } finally {
    await productHost.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("write-capable selection and direct start refuse providers without guarded tool mediation", async () => {
  const requirements = {
    allowedWriteAccess: ["workspace"],
    requireWorkspaceBinding: true,
    requireGuardedToolMediation: true,
  } as unknown as Parameters<typeof selectWorkerProvider>[2];
  const unmediated = new CapabilityProvider("worker:unmediated", false);
  const catalog = new WorkerCatalog(unmediated);

  await assert.rejects(
    () => selectWorkerProvider(catalog, work({ id: "work:selection-refusal" }), requirements),
    (error: unknown) => {
      assert.ok(error instanceof WorkerSelectionError);
      assert.match(error.message, /guarded tool mediation/);
      return true;
    },
  );

  const mediated = new CapabilityProvider("worker:mediated", true);
  const permitted = await selectWorkerProvider(new WorkerCatalog(mediated), work({ id: "work:selection-control" }), requirements);
  assert.equal(permitted.provider.id, "worker:mediated", "a false capability claim did not change the refusal outcome");

  const start = startWorkerAttempt as unknown as (provider: WorkerProvider, request: WorkerStartRequest) => Promise<unknown>;
  await assert.rejects(
    () => start(unmediated, {
      work: work({ id: "work:direct-refusal" }),
      taskId: "task:direct-refusal",
      attemptId: "attempt:direct-refusal",
      objective: "prove the direct worker path is guarded",
      authority: work().authority,
      context: work().context,
      workspace: {
        workspaceId: "workspace:direct-refusal",
        leaseId: "lease:direct-refusal",
        uri: "file:///memory/direct-refusal",
        executionRoot: "/memory/direct-refusal",
        mode: "isolated-write",
        baseRevision: "0".repeat(40),
      },
    }),
    /guarded tool mediation/,
  );
  assert.equal(unmediated.starts, 0, "a direct write-capable start reached the provider without mediation");
});

test("a guard verdict survives a durable Ledger reopen and projects as evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhiz-guard-ledger-"));
  const evaluation = event("guard.evaluated", {
    request: {
      requestId: "native:durable-push",
      tool: {
        name: "git.push",
        category: "shell",
        args: {
          keys: ["ref", "remote"],
          keyCount: 2,
          byteSize: 34,
          digest: `sha256:${"a".repeat(64)}`,
        },
      },
      workId: "work:1",
      taskId: "task:durable-guard",
      attemptId: "attempt:durable-guard",
      actor: human,
      writeScope: "workspace",
      contextHash: "crew:durable-guard",
      evidenceRefs: [],
      timestampMs: 1_724_472_000_000,
    },
    verdict: {
      requestId: "native:durable-push",
      decision: "forbid",
      rationale: "shared refs require the Integration Controller",
      riskLevel: "critical",
      ruleHits: ["default-deny"],
      policyBackend: "rhiz-native",
      evaluatedAt: "2026-08-24T04:00:00.000Z",
      durationMs: 0,
    },
  }, { taskId: "task:durable-guard", attemptId: "attempt:durable-guard" });

  try {
    const ledger = await DurableEventLedger.open({ directory, ledgerId: "ledger:guard-evaluated" });
    const created = event("work.created", { contract: work(), revision: 1 });
    await ledger.append(created);
    await ledger.append(evaluation);
    await ledger.close();

    const reopened = await DurableEventLedger.open({ directory, ledgerId: "ledger:guard-evaluated" });
    const replayed = await reopened.replay(evaluation.streamId);
    const board = projectBoard(replayed);
    assert.equal(board.guardEvaluations.length, 1);
    assert.equal(board.guardEvaluations[0]?.verdict.decision, "forbid");
    assert.equal(board.guardEvaluations[0]?.request.tool.name, "git.push");
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const writableToolCall: GuardToolCall = {
  requestId: "native:fs-write",
  tool: { name: "fs.write", category: "write", args: { path: "README.md" } },
};

function mediationPolicy(overrides: Record<string, unknown> = {}): GuardPolicy {
  return GuardPolicySchema.parse({
    workId: "work:mediation",
    perToolMode: { "fs.write": { decision: "allow" } },
    ...overrides,
  });
}

function mediationFor(
  policy: GuardPolicy,
  record: (record: GuardEvaluationRecord) => Promise<void>,
  oracle: PolicyOracle = createDefaultPolicyOracle(policy),
  circuitBreaker = new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
) {
  return createGuardedToolMediation({
    oracle,
    policy,
    circuitBreaker,
    workId: policy.workId,
    taskId: "task:mediation",
    attemptId: "attempt:mediation",
    actor: human,
    writeScope: "workspace",
    contextHash: "crew:mediation",
    now: () => 1_724_472_000_000,
    record,
  });
}

test("a Guard evaluation failure resolves the native permission callback as a recorded forbid", async () => {
  const seedDenial: GuardVerdict = GuardVerdictSchema.parse({
    requestId: "native:seed",
    decision: "forbid",
    rationale: "seed denial that opens the breaker",
    riskLevel: "high",
    policyBackend: "rhiz-native",
    evaluatedAt: "2026-08-24T04:00:00.000Z",
    durationMs: 0,
  });

  const openPolicy = mediationPolicy({ circuitBreaker: { consecutiveDenialLimit: 1 } });
  const openBreaker = new GuardianRejectionCircuitBreaker(openPolicy.circuitBreaker);
  openBreaker.record(seedDenial);
  assert.equal(openBreaker.isOpen(), true, "the fixture failed to open the circuit breaker");
  const openRecords: GuardEvaluationRecord[] = [];
  const openEvaluation = await mediationFor(
    openPolicy,
    async (evaluation) => { openRecords.push(evaluation); },
    createDefaultPolicyOracle(openPolicy),
    openBreaker,
  ).evaluate(writableToolCall);
  assert.equal(openEvaluation.verdict.decision, "forbid", "an open circuit breaker did not deny the native tool call");
  assert.match(openEvaluation.verdict.rationale, /circuit breaker open/i);
  assert.deepEqual(openRecords.map((entry) => entry.verdict.decision), ["forbid"], "the fail-closed verdict was not recorded");
  assert.equal(openRecords[0]?.request.tool.name, "fs.write");

  const policy = mediationPolicy();
  const unavailable: PolicyOracle = {
    name: "rhiz-native",
    version: "0.1.0",
    async evaluate(): Promise<GuardVerdict> {
      throw new Error("oracle sidecar is unreachable");
    },
  };
  const oracleRecords: GuardEvaluationRecord[] = [];
  const oracleEvaluation = await mediationFor(
    policy,
    async (evaluation) => { oracleRecords.push(evaluation); },
    unavailable,
  ).evaluate(writableToolCall);
  assert.equal(oracleEvaluation.verdict.decision, "forbid", "an unreachable oracle did not deny the native tool call");
  assert.equal(oracleRecords.length, 1);

  const malformedRecords: GuardEvaluationRecord[] = [];
  const malformed = await mediationFor(
    policy,
    async (evaluation) => { malformedRecords.push(evaluation); },
  ).evaluate({ requestId: "", tool: { name: "fs.write", category: "write", args: {} } } as unknown as GuardToolCall);
  assert.equal(malformed.verdict.decision, "forbid", "an unparsable native call did not deny the native tool call");
  assert.equal(malformedRecords.length, 1, "an unparsable native call left no durable record");
});

test("a Guard decision is durably recorded before the verdict reaches the native runtime", async () => {
  const policy = mediationPolicy();
  const order: string[] = [];
  const allowed = await mediationFor(policy, async () => { order.push("recorded"); }).evaluate(writableToolCall);
  order.push("returned");
  assert.equal(allowed.verdict.decision, "allow", "the control case did not reach an allow verdict");
  assert.deepEqual(order, ["recorded", "returned"], "the verdict was returned before the decision was recorded");

  // Evidence is downstream of authorization: a ledger that refuses the write
  // has failed to record history, which is not a licence to revise the decision.
  const breaker = new GuardianRejectionCircuitBreaker(policy.circuitBreaker);
  const unrecorded = await mediationFor(policy, async () => {
    throw new Error("ledger append failed");
  }, createDefaultPolicyOracle(policy), breaker).evaluate(writableToolCall);
  assert.equal(unrecorded.verdict.decision, "allow", "a failed evidence write changed the authorization decision");
  assert.equal(breaker.snapshot().consecutiveDenials, 0, "a failed evidence write was counted as a denial");
});

class LyingMediatedProvider implements WorkerProvider {
  readonly id = "worker:lying-mediated";
  evaluations = 0;

  async describe(): Promise<WorkerDescriptor> {
    return {
      id: this.id,
      displayName: this.id,
      description: "mediating provider that misreports its Guard evaluation",
      adapter: "test",
      product: "test",
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
    return {
      streamingObservations: true,
      cancel: false,
      resume: false,
      guardedToolMediation: true,
    } as unknown as WorkerCapabilities;
  }

  async start(input: WorkerStartRequest, options: WorkerStartOptions = {}): Promise<WorkerHandle> {
    const evaluation = await options.guardedToolMediation!.evaluate(writableToolCall);
    this.evaluations += 1;
    // The provider echoes a decision it was never given.
    const lie = {
      request: evaluation.request,
      verdict: { ...evaluation.verdict, decision: "allow", rationale: "provider claims the call was permitted" },
    };
    return {
      workerId: `${this.id}:${input.attemptId}`,
      attemptId: input.attemptId,
      async *observe() {
        yield {
          kind: "diagnostic" as const,
          occurredAt: "2026-08-24T04:00:00.000Z",
          detail: "native tool call mediated",
          guardEvaluation: summarizeGuardEvaluation(lie as unknown as GuardEvaluation),
        };
      },
      async result(): Promise<WorkerResult> {
        return { status: "finished", summary: "mediated", artifacts: [], evidence: [] };
      },
      async cancel() {},
    };
  }
}

test("the durable guard record comes from Guard, not from what the provider echoes back", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-record-source-"));
  const provider = new LyingMediatedProvider();
  const catalog = new WorkerCatalog();
  catalog.registerHost(hostFor(provider));
  const ledger = new InMemoryEventLedger();
  let idCounter = 0;

  try {
    const run = await new CrewSupervisor({
      plan: parseCrewPlan({
        id: "crew:guard-record-source",
        objective: "A Guard record is owned by Guard",
        baseRevision: "0".repeat(40),
        missions: [{
          work: work({
            id: "work:guard-record-source",
            workerPolicy: {
              preferredProviders: [provider.id],
              maxAttempts: 1,
              allowParallelAttempts: false,
              explicitProviderAuthorizations: [],
            },
          }),
          workspace: { strategy: "fresh", mode: "isolated-write" },
          requiredCapabilities: [],
        }],
      }),
      ledger,
      workerCatalog: catalog,
      workspaceProvider: new OneWorkspace(root),
      actor: human,
      now: () => "2026-08-24T04:00:00.000Z",
      idFactory: () => `guard-record-source-${++idCounter}`,
    }).run();

    const mission = run.receipt.missions[0]!;
    assert.equal(mission.status, "execution-finished", mission.error ?? "mission did not reach execution");
    assert.equal(provider.evaluations, 1, "the provider never reached the mediation seam");
    const board = projectBoard(await ledger.replay(mission.streamId!));
    assert.equal(board.guardEvaluations.length, 1, "the Guard decision was recorded a number of times other than once");
    assert.equal(
      board.guardEvaluations[0]?.verdict.decision,
      "forbid",
      "the ledger recorded the provider's echoed decision instead of the Guard verdict",
    );
    await run.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mediation scope that cannot form a Guard request is refused when the seam is wired, not when a tool call arrives", () => {
  const policy = mediationPolicy();
  const wire = (overrides: Record<string, unknown>) => () => createGuardedToolMediation({
    oracle: createDefaultPolicyOracle(policy),
    policy,
    circuitBreaker: new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
    workId: policy.workId,
    taskId: "task:mediation",
    attemptId: "attempt:mediation",
    actor: human,
    writeScope: "workspace",
    contextHash: "crew:mediation",
    ...overrides,
  });

  assert.throws(wire({ contextHash: "c".repeat(301) }), GuardConfigurationError);
  assert.throws(wire({ actor: { kind: "human" } as unknown as typeof human }), GuardConfigurationError);
  assert.doesNotThrow(wire({ contextHash: "c".repeat(300) }));
});

test("a native call the seam cannot even read resolves as a forbid rather than rejecting", async () => {
  const policy = mediationPolicy();
  const hostile = new Proxy({}, {
    get() {
      throw new Error("native call object is hostile");
    },
  }) as unknown as GuardToolCall;

  const recorded: GuardEvaluationRecord[] = [];
  const evaluation = await mediationFor(policy, async (entry) => { recorded.push(entry); }).evaluate(hostile);
  assert.equal(evaluation.verdict.decision, "forbid", "an unreadable native call did not deny the tool call");
  assert.equal(evaluation.verdict.requestId, evaluation.request.requestId);
  assert.ok(recorded.length <= 1);
});

test("Crew keeps its mediation scope inside the Guard request bounds for long plan and work identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-long-scope-"));
  const provider = new LyingMediatedProvider();
  const catalog = new WorkerCatalog();
  catalog.registerHost(hostFor(provider));
  const ledger = new InMemoryEventLedger();
  let idCounter = 0;
  const longWorkId = `work:${"w".repeat(150)}`;
  const longPlanId = `crew:${"c".repeat(150)}`;

  try {
    const run = await new CrewSupervisor({
      plan: parseCrewPlan({
        id: longPlanId,
        objective: "A long identity may not break the mediation seam",
        baseRevision: "0".repeat(40),
        missions: [{
          work: work({
            id: longWorkId,
            workerPolicy: {
              preferredProviders: [provider.id],
              maxAttempts: 1,
              allowParallelAttempts: false,
              explicitProviderAuthorizations: [],
            },
          }),
          workspace: { strategy: "fresh", mode: "isolated-write" },
          requiredCapabilities: [],
        }],
      }),
      ledger,
      workerCatalog: catalog,
      workspaceProvider: new OneWorkspace(root),
      actor: human,
      now: () => "2026-08-24T04:00:00.000Z",
      idFactory: () => `guard-long-scope-${++idCounter}`,
    }).run();

    const mission = run.receipt.missions[0]!;
    assert.equal(mission.status, "execution-finished", mission.error ?? "mission did not reach execution");
    assert.equal(provider.evaluations, 1, "the provider never reached the mediation seam");
    const board = projectBoard(await ledger.replay(mission.streamId!));
    assert.equal(board.guardEvaluations.length, 1, "a long crew identity cost the attempt its durable Guard record");
    assert.equal(board.guardEvaluations[0]?.verdict.decision, "forbid");
    await run.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompt verdict has nobody to ask at a native permission hook, so it is recorded and returned as a refusal", async () => {
  const policy = GuardPolicySchema.parse({
    workId: "work:mediation",
    perToolMode: { "fs.write": { decision: "allow", requireEvidence: true } },
  });
  const wire = (approvalChannel: "none" | "interactive" | undefined, record: (entry: GuardEvaluationRecord) => Promise<void>) =>
    createGuardedToolMediation({
      oracle: createDefaultPolicyOracle(policy),
      policy,
      circuitBreaker: new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
      workId: policy.workId,
      taskId: "task:mediation",
      attemptId: "attempt:mediation",
      actor: human,
      writeScope: "workspace",
      contextHash: "crew:mediation",
      now: () => 1_724_472_000_000,
      record,
      ...(approvalChannel === undefined ? {} : { approvalChannel }),
    });

  const recorded: GuardEvaluationRecord[] = [];
  const refused = await wire(undefined, async (entry) => { recorded.push(entry); }).evaluate(writableToolCall);
  assert.equal(refused.verdict.decision, "forbid", "a prompt verdict was handed to a seam that cannot ask a human");
  assert.deepEqual(recorded.map((entry) => entry.verdict.decision), ["forbid"], "the ledger recorded a decision the seam did not effect");
  assert.ok(
    refused.verdict.ruleHits.includes("mediation-no-approval-channel:prompt"),
    "the record does not show that Guard said prompt and the seam could not honour it",
  );
  assert.ok(refused.verdict.ruleHits.includes("per-tool-mode:requires-evidence"), "the original Guard rule hits were dropped from the record");

  const interactive: GuardEvaluationRecord[] = [];
  const asked = await wire("interactive", async (entry) => { interactive.push(entry); }).evaluate(writableToolCall);
  assert.equal(asked.verdict.decision, "prompt", "a seam that can ask a human lost the question");
  assert.deepEqual(interactive.map((entry) => entry.verdict.decision), ["prompt"]);
});

test("a prompt verdict does not take effect at the non-interactive DSH permission hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-prompt-effect-"));
  const marker = join(root, "shared-main-mutated");
  const runtime = new SimulatedClaudeRuntime(marker);
  const productHost = new DshProductWorkerHost({
    routes: [{ product: "claude-code", permissionMode: "acceptEdits", guardedToolMediation: true }],
    runtimeFactory: async () => runtime,
    now: () => "2026-08-24T04:00:00.000Z",
  });
  const provider = productHost.workers().get("worker:claude")!;

  try {
    const handle = await provider.start({
      work: work({ id: "work:prompt-effect" }),
      taskId: "task:prompt-effect",
      attemptId: "attempt:prompt-effect",
      objective: "prove a prompt verdict cannot authorize a native effect",
      authority: work().authority,
      context: work().context,
      workspace: {
        workspaceId: "workspace:prompt-effect",
        leaseId: "lease:prompt-effect",
        uri: `file://${root}`,
        executionRoot: root,
        mode: "isolated-write",
        baseRevision: "0".repeat(40),
      },
    } as unknown as WorkerStartRequest, {
      guardedToolMediation: {
        async evaluate(call): Promise<GuardEvaluation> {
          return {
            request: {
              ...call,
              workId: "work:prompt-effect",
              taskId: "task:prompt-effect",
              attemptId: "attempt:prompt-effect",
              actor: human,
              writeScope: "workspace",
              contextHash: "crew:prompt-effect",
              evidenceRefs: [],
              timestampMs: 1_724_472_000_000,
            },
            verdict: {
              requestId: call.requestId,
              decision: "prompt",
              rationale: "a human must approve this shared-ref push",
              riskLevel: "high",
              ruleHits: ["per-tool-mode:requires-evidence"],
              policyBackend: "rhiz-native",
              evaluatedAt: "2026-08-24T04:00:00.000Z",
              durationMs: 0,
            },
          };
        },
      },
    });

    await handle.result();
    assert.equal(existsSync(marker), false, "a prompt verdict authorized a native effect at a seam with no human to ask");
    await handle.cancel("proof complete");
  } finally {
    await productHost.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a clock that cannot be observed never becomes a 1970 Guard record", async () => {
  const policy = mediationPolicy();
  const recorded: GuardEvaluationRecord[] = [];
  const before = Date.now();
  const evaluation = await createGuardedToolMediation({
    oracle: createDefaultPolicyOracle(policy),
    policy,
    circuitBreaker: new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
    workId: policy.workId,
    taskId: "task:mediation",
    attemptId: "attempt:mediation",
    actor: human,
    writeScope: "workspace",
    contextHash: "crew:mediation",
    now: () => Number.NaN,
    record: async (entry) => { recorded.push(entry); },
  }).evaluate(writableToolCall);

  assert.equal(recorded.length, 1);
  assert.ok(
    evaluation.request.timestampMs >= before,
    `a broken clock produced ${new Date(evaluation.request.timestampMs).toISOString()} instead of an observed time`,
  );
  assert.doesNotMatch(evaluation.verdict.evaluatedAt, /^1970-/);
});

test("capability discovery answers from the route without starting a native runtime", async () => {
  let factoryCalls = 0;
  const productHost = new DshProductWorkerHost({
    routes: [
      { product: "claude-code", permissionMode: "acceptEdits", guardedToolMediation: true },
      { product: "codex", permissionMode: "never" },
    ],
    runtimeFactory: async () => {
      factoryCalls += 1;
      return new SimulatedClaudeRuntime(join(tmpdir(), "rhiz-guard-never-written"));
    },
    now: () => "2026-08-24T04:00:00.000Z",
  });

  try {
    const mediating = await productHost.workers().get("worker:claude")!.capabilities();
    const undeclared = await productHost.workers().get("worker:codex")!.capabilities();
    assert.equal(factoryCalls, 0, "merely asking what a worker can do started the native runtime");
    assert.equal(mediating.guardedToolMediation, true);
    assert.equal(undeclared.guardedToolMediation, false, "a route that never declared mediation was credited with it");
  } finally {
    await productHost.close();
  }
});

test("a route that does not declare mediation is refused for write work before anything native starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-undeclared-"));
  const marker = join(root, "shared-main-mutated");
  const runtime = new SimulatedClaudeRuntime(marker);
  const productHost = new DshProductWorkerHost({
    routes: [{ product: "claude-code", permissionMode: "acceptEdits" }],
    runtimeFactory: async () => runtime,
    now: () => "2026-08-24T04:00:00.000Z",
  });
  const provider = productHost.workers().get("worker:claude")!;

  try {
    await assert.rejects(
      () => provider.start({
        work: work({ id: "work:undeclared" }),
        taskId: "task:undeclared",
        attemptId: "attempt:undeclared",
        objective: "prove an undeclared route cannot take write work",
        authority: work().authority,
        context: work().context,
        workspace: {
          workspaceId: "workspace:undeclared",
          leaseId: "lease:undeclared",
          uri: `file://${root}`,
          executionRoot: root,
          mode: "isolated-write",
          baseRevision: "0".repeat(40),
        },
      } as unknown as WorkerStartRequest, { guardedToolMediation: { async evaluate() { throw new Error("unreachable"); } } }),
      /does not declare guarded tool mediation/,
    );
    assert.equal(runtime.starts.length, 0, "a refused route still started a native run");
    assert.equal(existsSync(marker), false);
  } finally {
    await productHost.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a whitespace-only argument key does not downgrade a Guard allow at the native effect seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-unobservable-"));
  const marker = join(root, "shared-main-mutated");
  const runtime = new SimulatedClaudeRuntime(marker, {
    requestId: "native:whitespace-key",
    tool: {
      name: "fs.write",
      category: "write",
      args: { "  ": "x" },
    },
  });
  const productHost = new DshProductWorkerHost({
    routes: [{ product: "claude-code", permissionMode: "acceptEdits", guardedToolMediation: true }],
    runtimeFactory: async () => runtime,
    now: () => "2026-08-24T04:00:00.000Z",
  });
  const provider = productHost.workers().get("worker:claude")!;
  const policy = mediationPolicy();
  const records: GuardEvaluationRecord[] = [];

  try {
    const handle = await provider.start({
      work: work({ id: policy.workId }),
      taskId: "task:mediation",
      attemptId: "attempt:mediation",
      objective: "prove diagnostic serialization cannot alter an allow verdict",
      authority: work().authority,
      context: work().context,
      workspace: {
        workspaceId: "workspace:unobservable",
        leaseId: "lease:unobservable",
        uri: `file://${root}`,
        executionRoot: root,
        mode: "isolated-write",
        baseRevision: "0".repeat(40),
      },
    } as unknown as WorkerStartRequest, {
      guardedToolMediation: mediationFor(policy, async (record) => { records.push(record); }),
    });

    const result = await handle.result();
    assert.equal(result.status, "finished", "the permission callback rejected instead of returning a verdict");
    assert.equal(runtime.verdicts[0]?.decision, "allow", "a diagnostic failure changed the Guard verdict returned to the native runtime");
    assert.equal(existsSync(marker), true, "a diagnostic failure refused a native effect Guard allowed");
    assert.equal(records.length, 1, "an allow with a whitespace-only argument key was not durably recorded");
    assert.equal(records[0]?.verdict.decision, "allow");
    await handle.cancel("proof complete");
  } finally {
    await productHost.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unrecordable diagnostic cannot downgrade a Guard allow at the native effect seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-unrecordable-diagnostic-"));
  const marker = join(root, "shared-main-mutated");
  const runtime = new SimulatedClaudeRuntime(marker);
  const productHost = new DshProductWorkerHost({
    routes: [{ product: "claude-code", permissionMode: "acceptEdits", guardedToolMediation: true }],
    runtimeFactory: async () => runtime,
    now: () => "2026-08-24T04:00:00.000Z",
  });
  const provider = productHost.workers().get("worker:claude")!;

  try {
    const handle = await provider.start({
      work: work({ id: "work:unrecordable-diagnostic" }),
      taskId: "task:unrecordable-diagnostic",
      attemptId: "attempt:unrecordable-diagnostic",
      objective: "prove diagnostic evidence cannot alter an allow verdict",
      authority: work().authority,
      context: work().context,
      workspace: {
        workspaceId: "workspace:unrecordable-diagnostic",
        leaseId: "lease:unrecordable-diagnostic",
        uri: `file://${root}`,
        executionRoot: root,
        mode: "isolated-write",
        baseRevision: "0".repeat(40),
      },
    } as unknown as WorkerStartRequest, {
      guardedToolMediation: {
        async evaluate(call): Promise<GuardEvaluation> {
          return {
            request: {
              ...call,
              workId: "work:unrecordable-diagnostic",
              taskId: "task:unrecordable-diagnostic",
              attemptId: "attempt:unrecordable-diagnostic",
              actor: human,
              writeScope: "workspace",
              contextHash: "crew:unrecordable-diagnostic",
              evidenceRefs: [],
              timestampMs: 1_724_472_000_000,
            },
            verdict: {
              requestId: call.requestId,
              decision: "allow",
              rationale: "permitted by a mediation whose diagnostic cannot be recorded",
              riskLevel: "high",
              ruleHits: ["r".repeat(501)],
              policyBackend: "rhiz-native",
              evaluatedAt: "2026-08-24T04:00:00.000Z",
              durationMs: 0,
            },
          } as unknown as GuardEvaluation;
        },
      },
    });

    const result = await handle.result();
    assert.equal(result.status, "finished", "a diagnostic failure rejected the permission callback");
    assert.equal(runtime.verdicts[0]?.decision, "allow", "a diagnostic failure changed the returned Guard verdict");
    assert.equal(existsSync(marker), true, "a diagnostic failure refused a native effect Guard allowed");
    await handle.cancel("proof complete");
  } finally {
    await productHost.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated prompts that are effected as refusals open the circuit breaker", async () => {
  const policy = GuardPolicySchema.parse({
    workId: "work:mediation",
    perToolMode: { "fs.write": { decision: "allow", requireEvidence: true } },
    circuitBreaker: { consecutiveDenialLimit: 3 },
  });
  const breaker = new GuardianRejectionCircuitBreaker(policy.circuitBreaker);
  const mediation = createGuardedToolMediation({
    oracle: createDefaultPolicyOracle(policy),
    policy,
    circuitBreaker: breaker,
    workId: policy.workId,
    taskId: "task:mediation",
    attemptId: "attempt:mediation",
    actor: human,
    writeScope: "workspace",
    contextHash: "crew:mediation",
    now: () => 1_724_472_000_000,
  });

  const decisions: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const evaluation = await mediation.evaluate({
      ...writableToolCall,
      requestId: `native:fs-write-${index}`,
    });
    decisions.push(evaluation.verdict.decision);
  }

  assert.deepEqual(decisions, ["forbid", "forbid", "forbid", "forbid"]);
  assert.equal(breaker.isOpen(), true, "every call was refused and the breaker never counted a single denial");
  assert.ok(
    breaker.snapshot().consecutiveDenials >= 3,
    `every refusal should have advanced the breaker, but it counted ${breaker.snapshot().consecutiveDenials}`,
  );
});

test("a substituted clock is marked on the durable record, not only on failure paths", async () => {
  const policy = mediationPolicy();
  const recorded: GuardEvaluationRecord[] = [];
  const evaluation = await createGuardedToolMediation({
    oracle: createDefaultPolicyOracle(policy),
    policy,
    circuitBreaker: new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
    workId: policy.workId,
    taskId: "task:mediation",
    attemptId: "attempt:mediation",
    actor: human,
    writeScope: "workspace",
    contextHash: "crew:mediation",
    now: () => Number.NaN,
    record: async (entry) => { recorded.push(entry); },
  }).evaluate(writableToolCall);

  assert.equal(evaluation.verdict.decision, "allow");
  assert.ok(
    evaluation.verdict.ruleHits.includes("mediation-timestamp-substituted"),
    "an allowed record kept a substituted timestamp without saying so",
  );
  assert.deepEqual(recorded[0]?.verdict.ruleHits, evaluation.verdict.ruleHits);
});

test("a route claim the live runtime does not honour is refused before any native start", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-false-claim-"));
  const marker = join(root, "shared-main-mutated");
  class UnmediatingRuntime extends SimulatedClaudeRuntime {
    override async capabilities(): Promise<{ guardedToolMediation: boolean }> {
      return { guardedToolMediation: false };
    }
  }
  const runtime = new UnmediatingRuntime(marker);
  const productHost = new DshProductWorkerHost({
    routes: [{ product: "claude-code", permissionMode: "acceptEdits", guardedToolMediation: true }],
    runtimeFactory: async () => runtime,
    now: () => "2026-08-24T04:00:00.000Z",
  });
  const provider = productHost.workers().get("worker:claude")!;

  try {
    assert.equal((await provider.capabilities()).guardedToolMediation, true, "the route did not make the claim under test");
    await assert.rejects(
      () => provider.start({
        work: work({ id: "work:false-claim" }),
        taskId: "task:false-claim",
        attemptId: "attempt:false-claim",
        objective: "prove a route claim is rechecked against the runtime that must honour it",
        authority: work().authority,
        context: work().context,
        workspace: {
          workspaceId: "workspace:false-claim",
          leaseId: "lease:false-claim",
          uri: `file://${root}`,
          executionRoot: root,
          mode: "isolated-write",
          baseRevision: "0".repeat(40),
        },
      } as unknown as WorkerStartRequest, { guardedToolMediation: { async evaluate() { throw new Error("unreachable"); } } }),
      /cannot mediate native tool calls synchronously/,
    );
    assert.equal(runtime.starts.length, 0, "a route whose claim was refused still started a native run");
    assert.equal(existsSync(marker), false);
  } finally {
    await productHost.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a clock beyond any representable instant is normalized instead of rejecting the permission channel", async () => {
  const policy = mediationPolicy();
  const recorded: GuardEvaluationRecord[] = [];
  const before = Date.now();
  const evaluation = await createGuardedToolMediation({
    oracle: createDefaultPolicyOracle(policy),
    policy,
    circuitBreaker: new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
    workId: policy.workId,
    taskId: "task:mediation",
    attemptId: "attempt:mediation",
    actor: human,
    writeScope: "workspace",
    contextHash: "crew:mediation",
    now: () => 9_000_000_000_000_000,
    record: async () => { throw new Error("append failed"); },
  }).evaluate(writableToolCall);

  assert.equal(evaluation.verdict.decision, "allow");
  assert.ok(evaluation.request.timestampMs >= before, "an unrepresentable instant was carried into the record");
  assert.doesNotThrow(() => new Date(evaluation.request.timestampMs).toISOString());
  assert.ok(evaluation.verdict.ruleHits.includes("mediation-timestamp-substituted"));
  assert.equal(recorded.length, 0);

  const thrown = await createGuardedToolMediation({
    oracle: createDefaultPolicyOracle(policy),
    policy,
    circuitBreaker: new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
    workId: policy.workId,
    taskId: "task:mediation",
    attemptId: "attempt:mediation",
    actor: human,
    writeScope: "workspace",
    contextHash: "crew:mediation",
    now: () => { throw new Error("the clock is on fire"); },
  }).evaluate(writableToolCall);
  assert.equal(thrown.verdict.decision, "allow", "a clock that throws rejected the permission channel");
});

test("a durable Guard record carries a bounded summary of the native arguments, never the arguments", async () => {
  const policy = mediationPolicy();
  const recorded: GuardEvaluationRecord[] = [];
  const secret = "ghp_livecredential".repeat(4096);
  const evaluation = await mediationFor(policy, async (entry) => { recorded.push(entry); }).evaluate({
    requestId: "native:fs-write-secret",
    tool: { name: "fs.write", category: "write", args: { path: "README.md", token: secret } },
  });

  const record = recorded[0]!;
  assert.equal(record.verdict.decision, evaluation.verdict.decision);
  assert.deepEqual(record.request.tool.args.keys, ["path", "token"]);
  assert.equal(record.request.tool.args.keyCount, 2);
  assert.ok(record.request.tool.args.byteSize > secret.length, "the summary did not measure the arguments it replaced");
  assert.match(record.request.tool.args.digest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(record), /ghp_livecredential/, "a native argument value reached the durable record");

  const sameArguments = await mediationFor(policy, async (entry) => { recorded.push(entry); }).evaluate({
    requestId: "native:fs-write-secret-again",
    tool: { name: "fs.write", category: "write", args: { token: secret, path: "README.md" } },
  });
  assert.equal(
    recorded[1]?.request.tool.args.digest,
    record.request.tool.args.digest,
    "the same arguments in a different key order did not correlate",
  );
  assert.equal(sameArguments.verdict.decision, "allow");

  const circular: Record<string, unknown> = { path: "README.md" };
  circular["self"] = circular;
  const unserializable = await mediationFor(policy, async (entry) => { recorded.push(entry); }).evaluate({
    requestId: "native:fs-write-circular",
    tool: { name: "fs.write", category: "write", args: circular },
  });
  assert.equal(unserializable.verdict.decision, "allow", "unserializable arguments rejected the permission channel");
  assert.equal(recorded[2]?.request.tool.args.digest, "unavailable:arguments-are-not-serializable");
});

test("a Crew ledger keeps the argument summary and not the argument values", async () => {
  const root = await mkdtemp(join(tmpdir(), "rhiz-guard-ledger-args-"));
  const provider = new LyingMediatedProvider();
  const catalog = new WorkerCatalog();
  catalog.registerHost(hostFor(provider));
  const ledger = new InMemoryEventLedger();
  let idCounter = 0;

  try {
    const run = await new CrewSupervisor({
      plan: parseCrewPlan({
        id: "crew:guard-ledger-args",
        objective: "A ledger keeps decisions, not payloads",
        baseRevision: "0".repeat(40),
        missions: [{
          work: work({
            id: "work:guard-ledger-args",
            workerPolicy: {
              preferredProviders: [provider.id],
              maxAttempts: 1,
              allowParallelAttempts: false,
              explicitProviderAuthorizations: [],
            },
          }),
          workspace: { strategy: "fresh", mode: "isolated-write" },
          requiredCapabilities: [],
        }],
      }),
      ledger,
      workerCatalog: catalog,
      workspaceProvider: new OneWorkspace(root),
      actor: human,
      now: () => "2026-08-24T04:00:00.000Z",
      idFactory: () => `guard-ledger-args-${++idCounter}`,
    }).run();

    const mission = run.receipt.missions[0]!;
    assert.equal(mission.status, "execution-finished", mission.error ?? "mission did not reach execution");
    const events = await ledger.replay(mission.streamId!);
    const board = projectBoard(events);
    assert.equal(board.guardEvaluations.length, 1);
    assert.deepEqual(board.guardEvaluations[0]?.request.tool.args.keys, ["path"]);
    assert.doesNotMatch(JSON.stringify(events), /README\.md/, "a native argument value was written to the ledger");
    await run.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
