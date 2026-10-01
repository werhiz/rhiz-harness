import assert from "node:assert/strict";
import test from "node:test";

import { proveContractBoundCategoryAuthority } from "../src/contract-bound-authority.js";
import type {
  HarnessHost,
  HostCapabilities,
  WorkerCapabilities,
  WorkerDescriptor,
  WorkerProvider,
  WorkerRegistry,
} from "../src/host.js";
import type { WorkContract } from "../src/schemas.js";
import { WorkerCatalog, type WorkerSelection } from "../src/workers.js";
import { work } from "./helpers.js";

interface ProviderShape {
  bindsWorkspace?: boolean;
  writeAccess?: WorkerDescriptor["writeAccess"];
  guardedToolMediation?: boolean;
}

class ProofProvider implements WorkerProvider {
  constructor(readonly id: string, readonly shape: ProviderShape = {}) {}

  async describe(): Promise<WorkerDescriptor> {
    return {
      id: this.id,
      displayName: this.id,
      description: "Contract-bound authority proof fixture",
      adapter: "proof",
      product: "proof",
      execution: "one-shot",
      context: "standalone",
      authorityMode: "proof",
      writeAccess: this.shape.writeAccess ?? "workspace",
      dangerous: false,
      bindsWorkspace: this.shape.bindsWorkspace ?? true,
      credentialEnv: [],
    };
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return {
      streamingObservations: true,
      cancel: true,
      resume: false,
      guardedToolMediation: this.shape.guardedToolMediation ?? true,
    };
  }

  async start(): Promise<never> {
    throw new Error("proof fixture never starts a worker");
  }
}

class ProofHost implements HarnessHost {
  readonly #registry: WorkerCatalog;

  constructor(
    readonly id: string,
    provider: WorkerProvider,
    readonly sandboxCapable: boolean,
    readonly sandboxSurface: boolean,
  ) {
    this.#registry = new WorkerCatalog(provider);
  }

  async capabilities(): Promise<HostCapabilities> {
    return {
      workers: true,
      processes: false,
      sessions: false,
      filesystem: false,
      sandbox: this.sandboxCapable,
      tools: false,
    };
  }

  workers(): WorkerRegistry { return this.#registry; }
  processes(): null { return null; }
  sessions(): null { return null; }
  filesystem(): null { return null; }
  sandbox(): { id: string } | null { return this.sandboxSurface ? { id: "sandbox:proof" } : null; }
  tools(): null { return null; }
  async close(): Promise<void> {}
}

async function fixture(options: {
  providerShape?: ProviderShape;
  sandboxCapable?: boolean;
  sandboxSurface?: boolean;
  contract?: WorkContract;
} = {}) {
  const provider = new ProofProvider("worker:proof", options.providerShape);
  const host = new ProofHost(
    "host:proof",
    provider,
    options.sandboxCapable ?? true,
    options.sandboxSurface ?? true,
  );
  const registry = new WorkerCatalog();
  registry.registerHost(host);
  const descriptor = await provider.describe();
  const capabilities = await provider.capabilities();
  const selection: WorkerSelection = {
    provider,
    hostId: host.id,
    capabilities,
    descriptor,
    preferred: true,
    rejections: [],
  };
  const contract = options.contract ?? work();
  return { provider, host, registry, selection, work: contract };
}

test("contract-bound category authority activates only when every physical gate is proven", async () => {
  const value = await fixture();
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.deepEqual(proof, {
    canonicalProvider: true,
    workspaceBinding: true,
    workspaceWriteAuthority: true,
    sandboxCapableHost: true,
    guardMediation: true,
    active: true,
  });
});

test("missing workspace binding keeps contract-bound category authority dormant", async () => {
  const value = await fixture({ providerShape: { bindsWorkspace: false } });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.workspaceBinding, false);
  assert.equal(proof.active, false);
});

test("missing workspace write authority keeps contract-bound category authority dormant", async () => {
  const value = await fixture({ providerShape: { writeAccess: "none" } });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.workspaceWriteAuthority, false);
  assert.equal(proof.active, false);
});

test("an empty Work writeScope cannot activate category authority", async () => {
  const value = await fixture({ contract: work({ writeScope: [] }) });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.workspaceWriteAuthority, false);
  assert.equal(proof.active, false);
});

test("missing sandbox-capable host keeps contract-bound category authority dormant", async () => {
  const value = await fixture({ sandboxCapable: false });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.sandboxCapableHost, false);
  assert.equal(proof.active, false);
});

test("a sandbox capability claim with no sandbox provider surface keeps authority dormant", async () => {
  const value = await fixture({ sandboxCapable: true, sandboxSurface: false });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.sandboxCapableHost, false);
  assert.equal(proof.active, false);
});

test("missing Guard mediation keeps contract-bound category authority dormant", async () => {
  const value = await fixture({ providerShape: { guardedToolMediation: false } });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.guardMediation, false);
  assert.equal(proof.active, false);
});

test("a resolver wrapper cannot inherit a host's sandbox proof by reusing its provider id", async () => {
  const value = await fixture();
  const wrapper = new ProofProvider(value.provider.id);
  const proof = await proveContractBoundCategoryAuthority({
    registry: value.registry,
    selection: { ...value.selection, provider: wrapper },
    provider: wrapper,
    work: value.work,
  });
  assert.equal(proof.canonicalProvider, false);
  assert.equal(proof.active, false);
});

test("a forged same-id selection cannot vouch for the canonical execution provider", async () => {
  const value = await fixture();
  const forgedSelectionProvider = new ProofProvider(value.provider.id);
  const proof = await proveContractBoundCategoryAuthority({
    registry: value.registry,
    selection: { ...value.selection, provider: forgedSelectionProvider },
    provider: value.provider,
    work: value.work,
  });
  assert.equal(proof.canonicalProvider, false);
  assert.equal(proof.active, false);
});

test("a provider workspace claim cannot substitute for missing Work write authority", async () => {
  const contract = work({
    authority: {
      grants: [{ action: "read", resources: [{ uri: "repo://example", kind: "repository" }], constraints: [] }],
      requiresHumanApproval: ["publish"],
    },
  });
  const value = await fixture({ contract });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.workspaceWriteAuthority, false);
  assert.equal(proof.active, false);
});

test("a narrow write grant cannot activate a broader Work writeScope", async () => {
  const contract = work({
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    authority: {
      grants: [
        { action: "read", resources: [{ uri: "repo://example", kind: "repository" }], constraints: [] },
        { action: "write", resources: [{ uri: "repo://example/src/only.ts", kind: "file" }], constraints: [] },
      ],
      requiresHumanApproval: [],
    },
  });
  const value = await fixture({ contract });
  const proof = await proveContractBoundCategoryAuthority(value);
  assert.equal(proof.workspaceWriteAuthority, false);
  assert.equal(proof.active, false);
});
