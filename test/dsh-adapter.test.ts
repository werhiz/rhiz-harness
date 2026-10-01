import assert from "node:assert/strict";
import test from "node:test";
import {
  createDshSdkClientFactory,
  DshSdkHost,
  DshSdkWorkerProvider,
  type DshSdkClient,
  type DshSdkNotification,
  renderDshWorkPrompt,
} from "../adapters/dsh/index.js";
import { assertHostCapabilitiesMatch, type WorkerObservation, type WorkerStartRequest } from "../src/host.js";
import { boundWorkspace, work } from "./helpers.js";

function request(attemptId = "attempt:1"): WorkerStartRequest {
  const contract = work({
    nonGoals: ["Do not change deployment configuration"],
    context: {
      strategy: "minimal",
      resources: [{ uri: "repo://example/src", kind: "directory" }],
      includeHistory: true,
    },
  });
  return {
    work: contract,
    taskId: "task:1",
    attemptId,
    objective: "Implement the bounded change",
    authority: contract.authority,
    workspace: boundWorkspace,
    context: contract.context,
    contextPack: {
      id: "pack:dsh-sdk",
      workId: contract.id,
      taskId: "task:1",
      attemptId,
      strategy: "minimal",
      taskClass: "ship",
      fragments: [{
        kind: "included-file",
        marker: "file:src/context-proof.ts",
        tokenEstimate: 5,
        path: "src/context-proof.ts",
        content: "export const selectedContextProof = true;",
      }],
      totalTokens: 5,
      composedAt: "2026-08-20T05:00:00.000Z",
      markers: ["file:src/context-proof.ts"],
    },
  };
}

class FakeDshClient implements DshSdkClient {
  runCount = 0;
  closeCount = 0;
  prompts: string[] = [];
  sessionIds: Array<string | undefined> = [];
  failWith: Error | null = null;
  malformedNotification = false;
  malformedResult = false;

  async run(
    input: string,
    options?: { sessionId?: string; onNotification?: (notification: DshSdkNotification) => void },
  ): Promise<unknown> {
    this.runCount += 1;
    this.prompts.push(input);
    this.sessionIds.push(options?.sessionId);
    if (this.failWith) throw this.failWith;

    options?.onNotification?.({
      method: "session.status",
      params: { sessionId: options.sessionId ?? "unknown", status: "running" },
    });
    options?.onNotification?.({
      method: "session.event",
      params: { sessionId: options.sessionId ?? "unknown", event: { type: "assistant/message" } },
    });
    if (this.malformedNotification) {
      options?.onNotification?.({ method: "", params: {} } as DshSdkNotification);
    }
    options?.onNotification?.({
      method: "session.status",
      params: { sessionId: options.sessionId ?? "unknown", status: "idle" },
    });

    if (this.malformedResult) return { nope: true };
    return {
      sessionId: options?.sessionId ?? "unknown",
      finalResponse: "Implemented and ran the requested checks.",
      events: [],
      notifications: [],
    };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

async function collect(handle: Awaited<ReturnType<DshSdkWorkerProvider["start"]>>): Promise<WorkerObservation[]> {
  const observations: WorkerObservation[] = [];
  for await (const observation of handle.observe()) observations.push(observation);
  return observations;
}

test("DSH SDK Host honestly exposes only the capabilities reachable through the SDK", async () => {
  const client = new FakeDshClient();
  const host = new DshSdkHost({ bindsWorkspace: true, clientFactory: async () => client });
  await assert.doesNotReject(() => assertHostCapabilitiesMatch(host));
  const capabilities = await host.capabilities();
  assert.deepEqual(capabilities, {
    workers: true,
    processes: false,
    sessions: true,
    filesystem: false,
    sandbox: false,
    tools: false,
  });
  const worker = host.workers().list()[0]!;
  assert.deepEqual(await worker.capabilities(), {
    streamingObservations: true,
    cancel: false,
    resume: false,
    guardedToolMediation: false,
  });
  await host.close();
});

test("DSH worker translates one SDK activity interval into portable observations and a WorkerResult", async () => {
  const client = new FakeDshClient();
  const provider = new DshSdkWorkerProvider({
    bindsWorkspace: true,
    getClient: async () => client,
    sessionPrefix: "rhiz-test-",
    now: () => "2026-08-20T05:30:00.000Z",
  });
  const input = request("attempt:dsh:1");
  const handle = await provider.start(input);
  const observationsPromise = collect(handle);
  const result = await handle.result();
  const observations = await observationsPromise;

  assert.equal(result.status, "finished");
  assert.match(result.summary, /Implemented/);
  assert.equal(result.evidence.length, 0);
  assert.equal(client.runCount, 1);
  assert.equal(client.sessionIds[0], "rhiz-test-attempt-dsh-1");
  assert.ok(observations.some((observation) => observation.detail.includes("running")));
  assert.ok(observations.some((observation) => observation.detail.includes("assistant/message")));

  const prompt = client.prompts[0]!;
  assert.match(prompt, /RHIZ WORK CONTRACT/);
  assert.match(prompt, /Work: work:1/);
  assert.match(prompt, /Attempt: attempt:dsh:1/);
  assert.match(prompt, /Allowed write scope/);
  assert.match(prompt, /Actions requiring human approval/);
  assert.match(prompt, /Do not claim organizational acceptance/);
});

test("rendered DSH Work prompt carries the portable contract rather than DSH-specific instructions", () => {
  const prompt = renderDshWorkPrompt(request());
  assert.match(prompt, /Acceptance criteria:/);
  assert.match(prompt, /Required evidence:/);
  assert.match(prompt, /Context strategy: minimal/);
  assert.match(prompt, /selectedContextProof/);
  assert.doesNotMatch(prompt, /Cordis|ctx\.subagents|SessionEvent/);
});

test("DSH SDK execution failures become failed WorkerResults with diagnostic observations", async () => {
  const client = new FakeDshClient();
  client.failWith = new Error("transport disconnected");
  const provider = new DshSdkWorkerProvider({
    bindsWorkspace: true,
    getClient: async () => client,
    now: () => "2026-08-20T05:31:00.000Z",
  });
  const handle = await provider.start(request("attempt:failure"));
  const observationsPromise = collect(handle);
  const result = await handle.result();
  const observations = await observationsPromise;

  assert.equal(result.status, "failed");
  assert.match(result.summary, /transport disconnected/);
  assert.ok(observations.some((observation) => observation.kind === "diagnostic"));
});

test("malformed DSH notification or result fails closed instead of leaking host data into portable state", async () => {
  const notificationClient = new FakeDshClient();
  notificationClient.malformedNotification = true;
  let provider = new DshSdkWorkerProvider({
    bindsWorkspace: true,
    getClient: async () => notificationClient,
    now: () => "2026-08-20T05:32:00.000Z",
  });
  let handle = await provider.start(request("attempt:bad-notification"));
  assert.equal((await handle.result()).status, "failed");

  const resultClient = new FakeDshClient();
  resultClient.malformedResult = true;
  provider = new DshSdkWorkerProvider({
    bindsWorkspace: true,
    getClient: async () => resultClient,
    now: () => "2026-08-20T05:33:00.000Z",
  });
  handle = await provider.start(request("attempt:bad-result"));
  assert.equal((await handle.result()).status, "failed");
});

test("DSH SDK cancel capability fails loud because rc.8 has no mid-turn cancel", async () => {
  const provider = new DshSdkWorkerProvider({ bindsWorkspace: true, getClient: async () => new FakeDshClient() });
  assert.equal((await provider.capabilities()).cancel, false);
  const handle = await provider.start(request("attempt:no-cancel"));
  await assert.rejects(() => handle.cancel("stop"), /does not expose mid-turn cancellation/);
  await handle.result();
});

test("DSH Host reuses one owned SDK client and closes it exactly once", async () => {
  const client = new FakeDshClient();
  let factoryCount = 0;
  const host = new DshSdkHost({
    bindsWorkspace: true,
    clientFactory: async () => {
      factoryCount += 1;
      return client;
    },
  });
  const provider = host.workers().list()[0]!;
  await (await provider.start(request("attempt:reuse:1"))).result();
  await (await provider.start(request("attempt:reuse:2"))).result();
  assert.equal(factoryCount, 1);
  await host.close();
  await host.close();
  assert.equal(client.closeCount, 1);
  await assert.rejects(() => host.client(), /closed/);
});

test("DSH SDK factory validates the public client surface without importing DSH into the portable core", async () => {
  let constructedWith: unknown;
  class FakeHarness {
    constructor(options: unknown) { constructedWith = options; }
    async run(): Promise<unknown> {
      return { sessionId: "session:1", finalResponse: "ok", events: [], notifications: [] };
    }
    async close(): Promise<void> {}
  }

  const factory = createDshSdkClientFactory(
    { launch: { command: "node", args: ["dsh-runtime.js"] }, provider: "test", model: "mock" },
    async () => ({ DeepSeekHarness: FakeHarness }),
  );
  const client = await factory();
  assert.equal(typeof client.run, "function");
  assert.deepEqual(constructedWith, {
    launch: { command: "node", args: ["dsh-runtime.js"] },
    provider: "test",
    model: "mock",
  });

  const broken = createDshSdkClientFactory(
    { launch: { command: "node" } },
    async () => ({}),
  );
  await assert.rejects(() => broken(), /DeepSeekHarness export is unavailable/);
});

test("an SDK worker that has not proven its working directory refuses to start", async () => {
  // The default is refusal. The SDK client resolves its cwd once, at Host
  // construction, so one client cannot be repointed per attempt; a Host that has
  // not been built for a single workspace cannot honour a per-attempt binding
  // and must say so rather than run somewhere else.
  //
  // This is not hypothetical. CI caught scripts/dsh-smoke.mjs starting this
  // provider with the default and dying on WorkspaceBindingError, because the
  // adapter tests all construct it with bindsWorkspace: true and nothing
  // exercised the default. See issue #9.
  const unbound = new DshSdkWorkerProvider({
    getClient: async () => new FakeDshClient(),
    now: () => "2026-08-20T05:34:00.000Z",
  });
  assert.equal((await unbound.describe()).bindsWorkspace, false);
  await assert.rejects(
    () => unbound.start(request("attempt:unbound")),
    /cannot bind a per-attempt workspace/,
  );

  // Control: the same provider constructed for one workspace accepts the
  // binding, so the refusal above is a property of the claim rather than of the
  // provider being broken.
  const bound = new DshSdkWorkerProvider({
    bindsWorkspace: true,
    getClient: async () => new FakeDshClient(),
    now: () => "2026-08-20T05:35:00.000Z",
  });
  assert.equal((await bound.describe()).bindsWorkspace, true);
  const handle = await bound.start(request("attempt:bound"));
  await handle.result();
});
