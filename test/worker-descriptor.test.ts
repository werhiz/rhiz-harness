import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkerCapabilities,
  WorkerDescriptor,
  WorkerHandle,
  WorkerProvider,
  WorkerStartRequest,
} from "../src/host.js";
import {
  describeWorkerProvider,
  selectWorkerProvider,
  startWorkerAttempt,
  WorkerBoundaryError,
  WorkerCatalog,
} from "../src/workers.js";
import { boundWorkspace, work } from "./helpers.js";

class EmptyHandle implements WorkerHandle {
  readonly workerId: string;
  readonly attemptId: string;

  constructor(providerId: string, request: WorkerStartRequest) {
    this.workerId = `${providerId}:run`;
    this.attemptId = request.attemptId;
  }

  async *observe() {}

  async result() {
    return { status: "finished" as const, summary: "done", artifacts: [], evidence: [] };
  }

  async cancel() {}
}

class LegacyProvider implements WorkerProvider {
  constructor(readonly id: string) {}

  async capabilities(): Promise<WorkerCapabilities> {
    return { streamingObservations: false, cancel: false, resume: false, guardedToolMediation: false };
  }

  async start(input: WorkerStartRequest): Promise<WorkerHandle> {
    return new EmptyHandle(this.id, input);
  }
}

class DescribedProvider extends LegacyProvider {
  constructor(id: string, readonly descriptor: WorkerDescriptor) {
    super(id);
  }

  async describe(): Promise<WorkerDescriptor> {
    return this.descriptor;
  }
}

function descriptor(id: string, overrides: Partial<WorkerDescriptor> = {}): WorkerDescriptor {
  return {
    id,
    bindsWorkspace: true,
    displayName: id,
    description: `${id} test worker`,
    adapter: "test",
    product: "test-product",
    productVersion: "1.0.0",
    execution: "one-shot",
    context: "standalone",
    authorityMode: "test:bounded",
    writeAccess: "workspace",
    dangerous: false,
    credentialEnv: [],
    ...overrides,
  };
}

function request(): WorkerStartRequest {
  const contract = work();
  return {
    work: contract,
    taskId: "task:descriptor",
    attemptId: "attempt:descriptor",
    objective: "Test worker descriptors",
    authority: contract.authority,
    context: contract.context,
    workspace: boundWorkspace,
  };
}

test("legacy providers receive a conservative portable descriptor", async () => {
  const described = await describeWorkerProvider(new LegacyProvider("worker:legacy"));
  assert.equal(described.id, "worker:legacy");
  assert.equal(described.adapter, "unknown");
  // Unknown authority is denied authority: an undescribed provider is assumed
  // to be the most dangerous thing it could be. See issue #18.
  assert.equal(described.writeAccess, "unrestricted");
  assert.equal(described.dangerous, true);
  assert.equal(described.bindsWorkspace, false);
});

test("a descriptor cannot claim another provider's identity", async () => {
  const provider = new DescribedProvider(
    "worker:actual",
    descriptor("worker:impostor"),
  );
  await assert.rejects(() => describeWorkerProvider(provider), WorkerBoundaryError);
  await assert.rejects(() => startWorkerAttempt(provider, request()), WorkerBoundaryError);
});

test("selection rejects a malformed preferred descriptor and records the fallback reason", async () => {
  const malformed = new DescribedProvider(
    "worker:preferred",
    { ...descriptor("worker:preferred"), dangerous: "yes" as unknown as boolean },
  );
  const fallback = new DescribedProvider(
    "worker:fallback",
    descriptor("worker:fallback"),
  );
  const selected = await selectWorkerProvider(
    new WorkerCatalog(malformed, fallback),
    work({
      workerPolicy: {
        preferredProviders: ["worker:preferred"],
        maxAttempts: 2,
        allowParallelAttempts: false,
      explicitProviderAuthorizations: [],
      },
    }),
  );
  assert.equal(selected.provider.id, "worker:fallback");
  assert.equal(selected.descriptor.id, "worker:fallback");
  assert.equal(selected.rejections.length, 1);
  assert.match(selected.rejections[0]!.reason, /descriptor discovery failed/);
});

test("dangerous product authority remains explicit in selection evidence", async () => {
  const provider = new DescribedProvider(
    "worker:dangerous",
    descriptor("worker:dangerous", {
      authorityMode: "product:bypass",
      writeAccess: "unrestricted",
      dangerous: true,
    }),
  );
  const selected = await selectWorkerProvider(new WorkerCatalog(provider), work());
  assert.equal(selected.descriptor.dangerous, true);
  assert.equal(selected.descriptor.writeAccess, "unrestricted");
  assert.equal(selected.descriptor.authorityMode, "product:bypass");
});
