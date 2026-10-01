import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerStartRequest } from "../src/host.js";
import { startWorkerAttempt } from "../src/workers.js";
import type {
  DshProductRoute,
  DshSubagentResult,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
} from "../adapters/dsh/product-routes.js";
import {
  createDefaultDshProductRoutes,
  DshProductWorkerHost,
  resolveDshProductRoutes,
} from "../adapters/dsh/product-routes.js";
import { boundWorkspace, work } from "./helpers.js";

interface StartReceipt {
  providerName: string;
  request: DshSubagentStartRequest;
  run: FakeRun;
}

class FakeRun implements DshSubagentRun {
  readonly id: string;
  readonly result: Promise<DshSubagentResult>;
  disposeCalls = 0;
  readonly #resolve?: (result: DshSubagentResult) => void;

  constructor(id: string, result?: DshSubagentResult) {
    this.id = id;
    if (result) {
      this.result = Promise.resolve(result);
    } else {
      let resolveResult!: (value: DshSubagentResult) => void;
      this.result = new Promise((resolve) => { resolveResult = resolve; });
      this.#resolve = resolveResult;
    }
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.#resolve?.({ stopReason: "aborted", outputText: "", diagnostic: "operator cancelled" });
  }
}

class FakeRuntime implements DshSubagentRuntime {
  readonly starts: StartReceipt[] = [];
  closeCalls = 0;

  constructor(
    readonly providers: readonly string[],
    readonly results: Readonly<Record<string, DshSubagentResult | undefined>> = {},
  ) {}

  async capabilities(): Promise<{ guardedToolMediation: boolean }> {
    return { guardedToolMediation: false };
  }

  listProviders(): readonly string[] {
    return [...this.providers];
  }

  async start(providerName: string, request: DshSubagentStartRequest): Promise<DshSubagentRun> {
    const result = this.results[providerName];
    const run = new FakeRun(
      `run:${providerName}:${this.starts.length + 1}`,
      result ?? { stopReason: "completed", outputText: `${providerName} completed` },
    );
    this.starts.push({ providerName, request, run });
    return run;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function request(attemptId: string): WorkerStartRequest {
  const contract = work({
    type: "SCOUT",
    writeScope: [],
    workerPolicy: {
      preferredProviders: [],
      maxAttempts: 2,
      allowParallelAttempts: false,
      explicitProviderAuthorizations: [],
    },
  });
  return {
    work: contract,
    taskId: `task:${attemptId}`,
    attemptId,
    objective: "Execute the same bounded portable contract",
    authority: contract.authority,
    workspace: { ...boundWorkspace, executionRoot: "/workspace", mode: "read-only" },
    context: contract.context,
    contextPack: {
      id: `pack:${attemptId}`,
      workId: contract.id,
      taskId: `task:${attemptId}`,
      attemptId,
      strategy: "minimal",
      taskClass: "scout",
      fragments: [{
        kind: "included-file",
        marker: "file:src/context-proof.ts",
        tokenEstimate: 5,
        path: "src/context-proof.ts",
        content: "export const selectedContextProof = true;",
      }],
      totalTokens: 5,
      composedAt: "2026-08-20T16:00:00.000Z",
      markers: ["file:src/context-proof.ts"],
    },
  };
}

function defaultProviders(): string[] {
  return ["rhiz-codex", "rhiz-claude"];
}

test("default routes expose Codex and Claude as distinct truthful workers", async () => {
  const runtime = new FakeRuntime(defaultProviders());
  const host = new DshProductWorkerHost({
    routes: createDefaultDshProductRoutes(),
    runtimeFactory: async () => runtime,
    now: () => "2026-08-20T07:00:00.000Z",
  });

  const codex = host.workers().get("worker:codex")!;
  const claude = host.workers().get("worker:claude")!;
  const codexDescriptor = await codex.describe!();
  const claudeDescriptor = await claude.describe!();

  assert.equal(codexDescriptor.product, "codex");
  assert.equal(codexDescriptor.productVersion, "0.147.0");
  assert.equal(codexDescriptor.authorityMode, "codex:never");
  assert.equal(codexDescriptor.context, "standalone");
  assert.equal(codexDescriptor.dangerous, false);

  assert.equal(claudeDescriptor.product, "claude-code");
  assert.equal(claudeDescriptor.productVersion, "2.1.220");
  assert.equal(claudeDescriptor.authorityMode, "claude-code:dontAsk");
  assert.equal(claudeDescriptor.context, "standalone");
  assert.equal(claudeDescriptor.dangerous, false);

  await host.close();
  assert.equal(runtime.closeCalls, 0, "the dormant runtime is never constructed merely to describe workers");
});

test("Codex and Claude execute through the same portable WorkerProvider contract", async () => {
  const runtime = new FakeRuntime(defaultProviders());
  const host = new DshProductWorkerHost({
    routes: createDefaultDshProductRoutes(),
    runtimeFactory: async () => runtime,
    now: () => "2026-08-20T07:01:00.000Z",
  });

  for (const [index, provider] of host.workers().list().entries()) {
    const started = await startWorkerAttempt(provider, request(`attempt:route:${index}`));
    const result = await started.handle.result();
    const observations = [];
    for await (const observation of started.handle.observe()) observations.push(observation);
    assert.equal(result.status, "finished");
    assert.ok(result.summary.includes("completed"));
    assert.ok(observations.length >= 2);
  }

  assert.deepEqual(
    runtime.starts.map((receipt) => receipt.providerName).sort(),
    defaultProviders().sort(),
  );
  for (const receipt of runtime.starts) {
    assert.match(receipt.request.prompt, /RHIZ WORK CONTRACT/);
    assert.match(receipt.request.prompt, /Do not claim verification or organizational acceptance/);
    assert.match(receipt.request.prompt, /At the point you would otherwise mark work ready or integrate it, stop and report/);
    assert.match(receipt.request.prompt, /Do not claim integration; the operator must independently verify and explicitly accept the Work/);
    assert.match(receipt.request.prompt, /selectedContextProof/);
    assert.equal(receipt.run.disposeCalls, 1);
  }
  await host.close();
  assert.equal(runtime.closeCalls, 1);
});

test("route prompts and descriptors expose credential names without exposing values", async () => {
  const secretCodex = "codex-secret-value";
  const secretClaude = "claude-secret-value";
  const routes: DshProductRoute[] = [
    { product: "codex", env: { OPENAI_API_KEY: secretCodex } },
    { product: "claude-code", env: { ANTHROPIC_API_KEY: secretClaude } },
  ];
  const runtime = new FakeRuntime(defaultProviders());
  const host = new DshProductWorkerHost({
    routes,
    runtimeFactory: async () => runtime,
    now: () => "2026-08-20T07:02:00.000Z",
  });

  for (const [index, provider] of host.workers().list().entries()) {
    const descriptor = await provider.describe!();
    assert.equal(descriptor.credentialEnv.length, 1);
    assert.ok(descriptor.credentialEnv[0]!.endsWith("API_KEY"));
    const handle = await provider.start(request(`attempt:secret:${index}`));
    await handle.result();
  }

  const prompts = runtime.starts.map((receipt) => receipt.request.prompt).join("\n");
  assert.doesNotMatch(prompts, new RegExp(secretCodex));
  assert.doesNotMatch(prompts, new RegExp(secretClaude));
  assert.doesNotMatch(JSON.stringify(host.routes.map((route) => route.descriptor)), new RegExp(secretCodex));
  assert.doesNotMatch(JSON.stringify(host.routes.map((route) => route.descriptor)), new RegExp(secretClaude));
  await host.close();
});

test("native bypass and plan modes are explicit in portable authority metadata", () => {
  const routes = resolveDshProductRoutes([
    {
      product: "codex",
      permissionMode: "dangerously-bypass-approvals-and-sandbox",
    },
    {
      product: "claude-code",
      permissionMode: "plan",
    },
  ]);
  assert.equal(routes[0]!.descriptor.dangerous, true);
  assert.equal(routes[0]!.descriptor.writeAccess, "unrestricted");
  assert.equal(routes[1]!.descriptor.dangerous, false);
  assert.equal(routes[1]!.descriptor.writeAccess, "none");
});

test("product stop reasons map into portable worker outcomes", async () => {
  const runtime = new FakeRuntime(defaultProviders(), {
    "rhiz-codex": { stopReason: "error", outputText: "partial", diagnostic: "safe Codex error" },
    "rhiz-claude": { stopReason: "aborted", outputText: "", diagnostic: "safe Claude cancellation" },
  });
  const host = new DshProductWorkerHost({
    routes: createDefaultDshProductRoutes(),
    runtimeFactory: async () => runtime,
    now: () => "2026-08-20T07:03:00.000Z",
  });
  const codex = await host.workers().get("worker:codex")!.start(request("attempt:error"));
  const claude = await host.workers().get("worker:claude")!.start(request("attempt:aborted"));
  assert.deepEqual(await codex.result(), {
    status: "failed",
    summary: "safe Codex error",
    artifacts: [],
    evidence: [],
  });
  assert.deepEqual(await claude.result(), {
    status: "cancelled",
    summary: "safe Claude cancellation",
    artifacts: [],
    evidence: [],
  });
  await host.close();
});

test("portable cancellation aborts and disposes the exact DSH product run", async () => {
  class PendingRuntime extends FakeRuntime {
    override async start(providerName: string, value: DshSubagentStartRequest): Promise<DshSubagentRun> {
      const run = new FakeRun(`run:${providerName}:pending`);
      this.starts.push({ providerName, request: value, run });
      return run;
    }
  }
  const runtime = new PendingRuntime(defaultProviders());
  const host = new DshProductWorkerHost({
    routes: createDefaultDshProductRoutes(),
    runtimeFactory: async () => runtime,
    now: () => "2026-08-20T07:04:00.000Z",
  });
  const handle = await host.workers().get("worker:codex")!.start(request("attempt:cancel"));
  await handle.cancel("operator stopped work");
  const receipt = runtime.starts[0]!;
  assert.equal(receipt.request.signal.aborted, true);
  assert.equal(receipt.run.disposeCalls, 1);
  assert.equal((await handle.result()).status, "cancelled");
  await host.close();
});

test("the Host owns one lazy runtime and closes it once", async () => {
  const runtime = new FakeRuntime(defaultProviders());
  let factoryCalls = 0;
  const host = new DshProductWorkerHost({
    routes: createDefaultDshProductRoutes(),
    runtimeFactory: async () => {
      factoryCalls += 1;
      return runtime;
    },
    now: () => "2026-08-20T07:05:00.000Z",
  });
  await host.workers().get("worker:codex")!.start(request("attempt:lazy:1"));
  await host.workers().get("worker:claude")!.start(request("attempt:lazy:2"));
  assert.equal(factoryCalls, 1);
  await host.close();
  await host.close();
  assert.equal(runtime.closeCalls, 1);
});

test("missing DSH providers fail before a worker handle is published", async () => {
  const runtime = new FakeRuntime(["rhiz-codex"]);
  const host = new DshProductWorkerHost({
    routes: createDefaultDshProductRoutes(),
    runtimeFactory: async () => runtime,
  });
  await assert.rejects(
    () => host.workers().get("worker:claude")!.start(request("attempt:missing")),
    /missing providers: rhiz-claude/,
  );
  assert.equal(runtime.closeCalls, 1);
});

test("duplicate worker and DSH provider identities fail closed", () => {
  assert.throws(() => resolveDshProductRoutes([
    { product: "codex", workerId: "worker:same" },
    { product: "claude-code", workerId: "worker:same" },
  ]), /duplicate DSH product worker id/);
  assert.throws(() => resolveDshProductRoutes([
    { product: "codex", providerName: "provider:same" },
    { product: "claude-code", providerName: "provider:same" },
  ]), /duplicate DSH subagent provider name/);
});
