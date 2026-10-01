import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerDescriptor } from "../src/host.js";
import type {
  HarnessHost,
  HostCapabilities,
  WorkerCapabilities,
  WorkerDescriptor,
  WorkerHandle,
  WorkerObservation,
  WorkerProvider,
  WorkerRegistry,
  WorkerResult,
  WorkerStartRequest,
} from "../src/host.js";
import {
  DuplicateWorkerProviderError,
  selectWorkerProvider,
  startWorkerAttempt,
  WorkerBoundaryError,
  WorkerCatalog,
  WorkerSelectionError,
} from "../src/workers.js";
import { readOnlyWorkspace, work } from "./helpers.js";

class TestHandle implements WorkerHandle {
  readonly workerId: string;
  readonly attemptId: string;
  cancelCalls: string[] = [];

  constructor(
    providerId: string,
    input: WorkerStartRequest,
    readonly observation: unknown = {
      kind: "activity",
      occurredAt: "2026-08-20T06:00:00.000Z",
      detail: "working",
    },
    readonly outcome: unknown = {
      status: "finished",
      summary: "done",
      artifacts: [],
      evidence: [],
    },
  ) {
    this.workerId = `${providerId}:instance`;
    this.attemptId = input.attemptId;
  }

  async *observe(): AsyncIterable<WorkerObservation> {
    yield this.observation as WorkerObservation;
  }

  async result(): Promise<WorkerResult> {
    return this.outcome as WorkerResult;
  }

  async cancel(reason: string): Promise<void> {
    this.cancelCalls.push(reason);
  }
}

class TestProvider implements WorkerProvider {
  starts = 0;
  lastHandle: TestHandle | undefined;

  constructor(
    readonly id: string,
    readonly declared: WorkerCapabilities = {
      streamingObservations: true,
      cancel: true,
      resume: false,
      guardedToolMediation: false,
    },
    readonly handleFactory: (input: WorkerStartRequest) => TestHandle = (input) => new TestHandle(id, input),
  ) {}

  async capabilities(): Promise<WorkerCapabilities> {
    return this.declared;
  }

  async describe(): Promise<WorkerDescriptor> {
    return parseWorkerDescriptor({
      id: this.id,
      displayName: this.id,
      description: `Test worker ${this.id}`,
      adapter: "test",
      product: "test",
      execution: "one-shot",
      context: "standalone",
      authorityMode: "test",
      writeAccess: "workspace",
      dangerous: false,
      bindsWorkspace: true,
      credentialEnv: [],
    });
  }

  async start(input: WorkerStartRequest): Promise<WorkerHandle> {
    this.starts += 1;
    this.lastHandle = this.handleFactory(input);
    return this.lastHandle;
  }
}

function request(attemptId = "attempt:workers"): WorkerStartRequest {
  const contract = work();
  return {
    work: contract,
    taskId: "task:workers",
    attemptId,
    objective: "Exercise worker selection",
    authority: contract.authority,
    context: contract.context,
    workspace: readOnlyWorkspace(),
  };
}

class Host implements HarnessHost {
  readonly id: string;
  readonly #registry: WorkerCatalog;

  constructor(id: string, ...providers: WorkerProvider[]) {
    this.id = id;
    this.#registry = new WorkerCatalog(...providers);
  }

  async capabilities(): Promise<HostCapabilities> {
    return { workers: true, processes: false, sessions: false, filesystem: false, sandbox: false, tools: false };
  }

  workers(): WorkerRegistry { return this.#registry; }
  processes(): null { return null; }
  sessions(): null { return null; }
  filesystem(): null { return null; }
  sandbox(): null { return null; }
  tools(): null { return null; }
  async close(): Promise<void> {}
}

test("WorkerCatalog rejects duplicate identity and supports idempotent disposal", () => {
  const provider = new TestProvider("worker:a");
  const catalog = new WorkerCatalog();
  const dispose = catalog.register(provider, "host:a");
  assert.throws(() => catalog.register(new TestProvider("worker:a")), DuplicateWorkerProviderError);
  assert.equal(catalog.require("worker:a"), provider);
  dispose();
  dispose();
  assert.equal(catalog.get("worker:a"), undefined);
});

test("registerHost is transactional when one contributed worker collides", () => {
  const catalog = new WorkerCatalog(new TestProvider("worker:existing"));
  const host = new Host(
    "host:incoming",
    new TestProvider("worker:new"),
    new TestProvider("worker:existing"),
  );
  assert.throws(() => catalog.registerHost(host), DuplicateWorkerProviderError);
  assert.equal(catalog.get("worker:new"), undefined);
  assert.equal(catalog.entries().length, 1);
});

test("selection follows Work preference order before stable fallback", async () => {
  const first = new TestProvider("worker:first");
  const preferred = new TestProvider("worker:preferred");
  const catalog = new WorkerCatalog(first, preferred);
  const contract = work({
    workerPolicy: {
      preferredProviders: ["worker:preferred"],
      maxAttempts: 3,
      allowParallelAttempts: false,
      explicitProviderAuthorizations: [],
    },
  });
  const selected = await selectWorkerProvider(catalog, contract);
  assert.equal(selected.provider, preferred);
  assert.equal(selected.preferred, true);
});

test("selection rejects incapable preferred workers and records why fallback won", async () => {
  const preferred = new TestProvider("worker:preferred", {
    streamingObservations: true,
    cancel: false,
    resume: false,
    guardedToolMediation: false,
  });
  const fallback = new TestProvider("worker:fallback", {
    streamingObservations: true,
    cancel: true,
    resume: false,
    guardedToolMediation: false,
  });
  const catalog = new WorkerCatalog(preferred, fallback);
  const contract = work({
    workerPolicy: {
      preferredProviders: ["worker:preferred"],
      maxAttempts: 3,
      allowParallelAttempts: false,
      explicitProviderAuthorizations: [],
    },
  });
  const selected = await selectWorkerProvider(catalog, contract, { requiredCapabilities: ["cancel"] });
  assert.equal(selected.provider, fallback);
  assert.equal(selected.preferred, false);
  assert.deepEqual(selected.rejections, [{
    providerId: "worker:preferred",
    reason: "missing capabilities: cancel",
  }]);
});

test("selection fails loud with provider-specific diagnostics", async () => {
  const catalog = new WorkerCatalog(new TestProvider("worker:weak", {
    streamingObservations: false,
    cancel: false,
    resume: false,
    guardedToolMediation: false,
  }));
  await assert.rejects(
    () => selectWorkerProvider(catalog, work(), { requiredCapabilities: ["streamingObservations", "cancel"] }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerSelectionError);
      assert.match(error.message, /streamingObservations, cancel/);
      return true;
    },
  );
});

test("startWorkerAttempt validates observations and memoizes the result", async () => {
  const provider = new TestProvider("worker:valid");
  const started = await startWorkerAttempt(provider, request());
  const observations = [];
  for await (const observation of started.handle.observe()) observations.push(observation);
  assert.equal(observations.length, 1);
  const first = await started.handle.result();
  const second = await started.handle.result();
  assert.deepEqual(first, second);
  assert.equal(provider.starts, 1);
});

test("startWorkerAttempt rejects a handle attached to the wrong Attempt", async () => {
  const provider = new TestProvider(
    "worker:wrong-attempt",
    undefined,
    (input) => {
      const handle = new TestHandle("worker:wrong-attempt", input);
      Object.defineProperty(handle, "attemptId", { value: "attempt:other" });
      return handle;
    },
  );
  await assert.rejects(() => startWorkerAttempt(provider, request()), WorkerBoundaryError);
});

test("malformed provider output fails at the portable boundary", async () => {
  const provider = new TestProvider(
    "worker:malformed",
    undefined,
    (input) => new TestHandle(
      "worker:malformed",
      input,
      { kind: "activity", occurredAt: "not-a-time", detail: "bad" },
      { status: "finished", summary: "", artifacts: [], evidence: [] },
    ),
  );
  const started = await startWorkerAttempt(provider, request());
  await assert.rejects(async () => {
    for await (const _observation of started.handle.observe()) void _observation;
  });
  await assert.rejects(() => started.handle.result());
});

test("cancellation truth follows the advertised capability", async () => {
  const unavailable = new TestProvider("worker:no-cancel", {
    streamingObservations: true,
    cancel: false,
    resume: false,
    guardedToolMediation: false,
  });
  const unavailableStarted = await startWorkerAttempt(unavailable, request("attempt:no-cancel"));
  await assert.rejects(() => unavailableStarted.handle.cancel("stop"), WorkerBoundaryError);
  assert.deepEqual(unavailable.lastHandle?.cancelCalls, []);

  const available = new TestProvider("worker:cancel");
  const availableStarted = await startWorkerAttempt(available, request("attempt:cancel"));
  await availableStarted.handle.cancel("operator stop");
  assert.deepEqual(available.lastHandle?.cancelCalls, ["operator stop"]);
});
