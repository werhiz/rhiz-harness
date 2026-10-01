import type { WorkContract } from "../schemas.js";
import type { CrewWorkspace } from "../crew.js";
import type { VerificationCheck, VerificationCheckResult, VerificationTarget, VerifierDescriptor } from "./schema.js";

export interface VerifierRequest {
  work: WorkContract;
  contractRevision: number;
  workspace: CrewWorkspace;
  target: VerificationTarget;
  check: VerificationCheck;
}

export interface VerifierProvider {
  readonly id: string;
  describe(): Promise<VerifierDescriptor>;
  verify(request: VerifierRequest): Promise<VerificationCheckResult>;
  close(): Promise<void>;
}

export class DuplicateVerifierProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`verifier provider ${providerId} is already registered`);
    this.name = "DuplicateVerifierProviderError";
  }
}

export class VerifierProviderUnavailableError extends Error {
  constructor(readonly providerId: string) {
    super(`verifier provider ${providerId} is not registered`);
    this.name = "VerifierProviderUnavailableError";
  }
}

export class VerifierCatalog {
  readonly #providers = new Map<string, VerifierProvider>();
  #closed = false;

  constructor(...providers: VerifierProvider[]) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: VerifierProvider): () => void {
    if (this.#closed) throw new Error("VerifierCatalog is closed");
    if (!provider.id.trim()) throw new Error("verifier provider id is required");
    if (this.#providers.has(provider.id)) throw new DuplicateVerifierProviderError(provider.id);
    this.#providers.set(provider.id, provider);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#providers.get(provider.id) === provider) this.#providers.delete(provider.id);
    };
  }

  list(): readonly VerifierProvider[] {
    return [...this.#providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  get(providerId: string): VerifierProvider | undefined {
    return this.#providers.get(providerId);
  }

  require(providerId: string): VerifierProvider {
    const provider = this.get(providerId);
    if (!provider) throw new VerifierProviderUnavailableError(providerId);
    return provider;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const provider of [...this.#providers.values()].reverse()) {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "VerifierProvider cleanup failed");
  }
}
