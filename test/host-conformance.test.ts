import assert from "node:assert/strict";
import test from "node:test";
import type {
  HarnessHost,
  HostCapabilities,
  WorkerCapabilities,
  WorkerHandle,
  WorkerObservation,
  WorkerProvider,
  WorkerRegistry,
  WorkerResult,
  WorkerStartRequest,
} from "../src/host.js";
import { assertHostCapabilitiesMatch, HostCapabilitiesSchema } from "../src/host.js";
import { boundWorkspace, work } from "./helpers.js";

class FakeHandle implements WorkerHandle {
  readonly workerId: string;
  readonly attemptId: string;
  cancelledReason: string | null = null;

  constructor(readonly providerId: string, request: WorkerStartRequest) {
    this.workerId = `${providerId}:worker`;
    this.attemptId = request.attemptId;
  }

  async *observe(): AsyncIterable<WorkerObservation> {
    yield {
      kind: "activity",
      occurredAt: "2026-08-20T05:00:00.000Z",
      detail: `${this.providerId} started`,
    };
  }

  async result(): Promise<WorkerResult> {
    return {
      status: this.cancelledReason ? "cancelled" : "finished",
      summary: this.cancelledReason ?? `${this.providerId} completed`,
      artifacts: [],
      evidence: [],
    };
  }

  async cancel(reason: string): Promise<void> {
    this.cancelledReason = reason;
  }
}

class FakeWorkerProvider implements WorkerProvider {
  constructor(readonly id: string) {}

  async capabilities(): Promise<WorkerCapabilities> {
    return { streamingObservations: true, cancel: true, resume: false, guardedToolMediation: false };
  }

  async start(input: WorkerStartRequest): Promise<WorkerHandle> {
    return new FakeHandle(this.id, input);
  }
}

class FakeRegistry implements WorkerRegistry {
  readonly #providers: WorkerProvider[];

  constructor(...providers: WorkerProvider[]) {
    this.#providers = providers;
  }

  list(): readonly WorkerProvider[] {
    return [...this.#providers];
  }

  get(id: string): WorkerProvider | undefined {
    return this.#providers.find((provider) => provider.id === id);
  }
}

class FakeHost implements HarnessHost {
  readonly id = "host:fake";
  readonly #workers = new FakeRegistry(new FakeWorkerProvider("worker:a"), new FakeWorkerProvider("worker:b"));
  closed = false;

  async capabilities(): Promise<HostCapabilities> {
    return HostCapabilitiesSchema.parse({
      workers: true,
      processes: false,
      sessions: false,
      filesystem: false,
      sandbox: false,
      tools: false,
    });
  }

  workers(): WorkerRegistry { return this.#workers; }
  processes(): null { return null; }
  sessions(): null { return null; }
  filesystem(): null { return null; }
  sandbox(): null { return null; }
  tools(): null { return null; }
  async close(): Promise<void> { this.closed = true; }
}

function request(attemptId: string): WorkerStartRequest {
  const contract = work();
  return {
    work: contract,
    taskId: "task:1",
    attemptId,
    objective: "Implement",
    authority: contract.authority,
    context: contract.context,
    workspace: boundWorkspace,
  };
}

async function assertWorkerConforms(provider: WorkerProvider, attemptId: string): Promise<void> {
  const capabilities = await provider.capabilities();
  assert.equal(typeof capabilities.cancel, "boolean");
  const handle = await provider.start(request(attemptId));
  assert.equal(handle.attemptId, attemptId);

  const observations: WorkerObservation[] = [];
  for await (const observation of handle.observe()) observations.push(observation);
  assert.ok(observations.length > 0);

  const result = await handle.result();
  assert.equal(result.status, "finished");
}

test("a Host exposes capabilities honestly and absent providers remain absent", async () => {
  const host = new FakeHost();
  await assert.doesNotReject(() => assertHostCapabilitiesMatch(host));
  const capabilities = await host.capabilities();
  assert.equal(capabilities.workers, true);
  assert.equal(capabilities.sandbox, false);
  assert.equal(host.sandbox(), null);
  assert.equal(host.processes(), null);
  await host.close();
  assert.equal(host.closed, true);
});

test("Host conformance fails when capability claims disagree with providers", async () => {
  class DishonestHost extends FakeHost {
    override async capabilities(): Promise<HostCapabilities> {
      return HostCapabilitiesSchema.parse({
        workers: true,
        processes: false,
        sessions: false,
        filesystem: false,
        sandbox: true,
        tools: false,
      });
    }
  }
  await assert.rejects(() => assertHostCapabilitiesMatch(new DishonestHost()), /sandbox/);
});

test("two WorkerProviders satisfy the same portable contract", async () => {
  const host = new FakeHost();
  const providers = host.workers().list();
  assert.equal(providers.length, 2);
  await assertWorkerConforms(providers[0]!, "attempt:a");
  await assertWorkerConforms(providers[1]!, "attempt:b");
});

test("Worker cancellation is represented through the portable handle", async () => {
  const provider = new FakeWorkerProvider("worker:cancel");
  const handle = await provider.start(request("attempt:cancel"));
  await handle.cancel("operator cancelled");
  const result = await handle.result();
  assert.equal(result.status, "cancelled");
  assert.equal(result.summary, "operator cancelled");
});
