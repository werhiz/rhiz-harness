import { z } from "zod";
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
  WorkerStartOptions,
} from "./host.js";
import {
  HostCapabilitiesSchema,
  parseWorkerDescriptor,
  parseWorkerObservation,
  parseWorkerResult,
  parseWorkerStartRequest,
  WorkerCapabilitiesSchema,
} from "./host.js";
import type { WorkContract } from "./schemas.js";
import { ActorRefSchema, WorkContractSchema } from "./schemas.js";

const nonEmptyId = z.string().trim().min(1).max(200);

export const WorkerCapabilityNameSchema = z.enum([
  "streamingObservations",
  "cancel",
  "resume",
  "guardedToolMediation",
]);
export type WorkerCapabilityName = z.infer<typeof WorkerCapabilityNameSchema>;

export const WorkerWriteAccessSchema = z.enum([
  "none",
  "workspace",
  "unrestricted",
  "host-policy",
]);
export type WorkerWriteAccess = z.infer<typeof WorkerWriteAccessSchema>;

/**
 * A named, auditable human authorization for one exact provider. This is the
 * only way an undescribed or unbound provider may be selected, and it records
 * who authorized it and why so the decision survives replay.
 */
export const ProviderAuthorizationSchema = z.object({
  providerId: nonEmptyId,
  reason: z.string().trim().min(1).max(1000),
  authorizedBy: ActorRefSchema,
}).strict();
export type ProviderAuthorization = z.infer<typeof ProviderAuthorizationSchema>;

export const WorkerSelectionRequirementsSchema = z.object({
  requiredCapabilities: z.array(WorkerCapabilityNameSchema).default([]),
  excludedProviders: z.array(nonEmptyId).default([]),
  allowDangerous: z.boolean().default(true),
  allowedWriteAccess: z.array(WorkerWriteAccessSchema)
    .min(1)
    .default(["none", "workspace", "unrestricted", "host-policy"]),
  /** Crew sets this true. A provider that cannot bind its workspace is refused. */
  requireWorkspaceBinding: z.boolean().default(false),
  /**
   * Refuse a write-capable provider unless its native tool callback receives an
   * awaited Guard verdict before effect. No authorization overrides this.
   */
  requireGuardedToolMediation: z.boolean().default(false),
  /**
   * Refuse any provider whose host does not impose OS containment
   * (HostCapabilities.sandbox). Crew sets this for isolated-write missions:
   * prompt text is not a write boundary (issue #11), so write-enabled work
   * may only reach providers a sandbox-capable host vouches for. Like
   * requireWorkspaceBinding, no human authorization overrides it.
   */
  requireSandboxCapableHost: z.boolean().default(false),
  explicitProviderAuthorizations: z.array(ProviderAuthorizationSchema).default([]),
}).strict();
export type WorkerSelectionRequirements = z.infer<typeof WorkerSelectionRequirementsSchema>;
export type WorkerSelectionRequirementsInput = z.input<typeof WorkerSelectionRequirementsSchema>;

export interface RegisteredWorker {
  hostId: string | null;
  provider: WorkerProvider;
  /** The host that contributed this provider, when one did. */
  host: HarnessHost | null;
}

export class DuplicateWorkerProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`worker provider ${providerId} is already registered`);
    this.name = "DuplicateWorkerProviderError";
  }
}

export class WorkerProviderUnavailableError extends Error {
  constructor(readonly providerId: string) {
    super(`worker provider ${providerId} is not registered`);
    this.name = "WorkerProviderUnavailableError";
  }
}

export interface WorkerSelectionRejection {
  providerId: string;
  reason: string;
}

export class WorkerSelectionError extends Error {
  constructor(
    readonly workId: string,
    readonly rejections: readonly WorkerSelectionRejection[],
  ) {
    const detail = rejections.length === 0
      ? "no worker providers are registered"
      : rejections.map((item) => `${item.providerId}: ${item.reason}`).join("; ");
    super(`no capable worker provider is available for ${workId}: ${detail}`);
    this.name = "WorkerSelectionError";
  }
}

export class WorkerBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerBoundaryError";
  }
}

export class WorkerCatalog implements WorkerRegistry {
  readonly #entries = new Map<string, RegisteredWorker>();

  constructor(...providers: WorkerProvider[]) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: WorkerProvider, hostId: string | null = null): () => void {
    const providerId = nonEmptyId.parse(provider.id);
    if (this.#entries.has(providerId)) throw new DuplicateWorkerProviderError(providerId);
    const entry = { provider, hostId, host: null as HarnessHost | null };
    this.#entries.set(providerId, entry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#entries.get(providerId) === entry) this.#entries.delete(providerId);
    };
  }

  registerHost(host: HarnessHost): () => void {
    const hostId = nonEmptyId.parse(host.id);
    const disposers: Array<() => void> = [];
    try {
      for (const provider of host.workers().list()) {
        disposers.push(this.register(provider, hostId));
        const entry = this.#entries.get(provider.id);
        if (entry) entry.host = host;
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const dispose of disposers.reverse()) dispose();
    };
  }

  list(): readonly WorkerProvider[] {
    return this.entries().map((entry) => entry.provider);
  }

  entries(): readonly RegisteredWorker[] {
    return [...this.#entries.values()].sort((left, right) => left.provider.id.localeCompare(right.provider.id));
  }

  get(id: string): WorkerProvider | undefined {
    return this.#entries.get(id)?.provider;
  }

  getEntry(id: string): RegisteredWorker | undefined {
    return this.#entries.get(id);
  }

  require(id: string): WorkerProvider {
    const provider = this.get(id);
    if (!provider) throw new WorkerProviderUnavailableError(id);
    return provider;
  }
}

export async function describeWorkerProvider(provider: WorkerProvider): Promise<WorkerDescriptor> {
  const providerId = nonEmptyId.parse(provider.id);
  const descriptor = provider.describe === undefined
    ? parseWorkerDescriptor({
      id: providerId,
      displayName: providerId,
      description: `Worker provider ${providerId} has not published a descriptor`,
      adapter: "unknown",
      product: providerId,
      execution: "one-shot",
      context: "standalone",
      authorityMode: "unspecified",
      // Unknown authority is denied authority. An undescribed provider is
      // assumed to be the most dangerous thing it could be, never the safest.
      writeAccess: "unrestricted",
      dangerous: true,
      bindsWorkspace: false,
      credentialEnv: [],
    })
    : parseWorkerDescriptor(await provider.describe());

  if (descriptor.id !== providerId) {
    throw new WorkerBoundaryError(
      `worker descriptor id ${descriptor.id} does not match provider ${providerId}`,
    );
  }
  return descriptor;
}

export interface WorkerSelection {
  provider: WorkerProvider;
  hostId: string | null;
  capabilities: WorkerCapabilities;
  descriptor: WorkerDescriptor;
  preferred: boolean;
  rejections: readonly WorkerSelectionRejection[];
  /** Present only when an explicit human authorization admitted this provider. */
  authorization?: ProviderAuthorization;
}

function orderedEntries(registry: WorkerCatalog, work: WorkContract): RegisteredWorker[] {
  const entries = registry.entries();
  const byId = new Map(entries.map((entry) => [entry.provider.id, entry] as const));
  const ordered: RegisteredWorker[] = [];
  const seen = new Set<string>();
  for (const providerId of work.workerPolicy.preferredProviders) {
    const entry = byId.get(providerId);
    if (!entry || seen.has(providerId)) continue;
    seen.add(providerId);
    ordered.push(entry);
  }
  for (const entry of entries) {
    if (seen.has(entry.provider.id)) continue;
    seen.add(entry.provider.id);
    ordered.push(entry);
  }
  return ordered;
}

function missingCapabilities(
  capabilities: WorkerCapabilities,
  required: readonly WorkerCapabilityName[],
): WorkerCapabilityName[] {
  return required.filter((name) => capabilities[name] !== true);
}

/**
 * True only when the entry's host both exists and declares the sandbox
 * capability. A provider registered without a host has no host to impose the
 * boundary, and a capabilities failure is a refusal, not a pass.
 */
async function hostImposesContainment(entry: RegisteredWorker): Promise<boolean> {
  if (entry.host === null) return false;
  try {
    const capabilities: HostCapabilities = HostCapabilitiesSchema.parse(await entry.host.capabilities());
    return capabilities.sandbox === true;
  } catch {
    return false;
  }
}

export async function selectWorkerProvider(
  registry: WorkerCatalog,
  rawWork: WorkContract,
  rawRequirements: WorkerSelectionRequirementsInput = {},
): Promise<WorkerSelection> {
  const work = WorkContractSchema.parse(rawWork);
  const requirements = WorkerSelectionRequirementsSchema.parse(rawRequirements);
  const preferred = new Set(work.workerPolicy.preferredProviders);
  const excluded = new Set(requirements.excludedProviders);
  const allowedWriteAccess = new Set(requirements.allowedWriteAccess);
  const authorized = new Map(
    [...requirements.explicitProviderAuthorizations, ...work.workerPolicy.explicitProviderAuthorizations]
      .map((item) => [item.providerId, item] as const),
  );
  const rejections: WorkerSelectionRejection[] = [];

  for (const entry of orderedEntries(registry, work)) {
    if (excluded.has(entry.provider.id)) {
      rejections.push({
        providerId: entry.provider.id,
        reason: "provider is excluded by the Work supervision policy",
      });
      continue;
    }

    let capabilities: WorkerCapabilities;
    try {
      capabilities = WorkerCapabilitiesSchema.parse(await entry.provider.capabilities());
    } catch (error) {
      rejections.push({
        providerId: entry.provider.id,
        reason: `capability discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    let descriptor: WorkerDescriptor;
    try {
      descriptor = await describeWorkerProvider(entry.provider);
    } catch (error) {
      rejections.push({
        providerId: entry.provider.id,
        reason: `descriptor discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const missing = missingCapabilities(capabilities, requirements.requiredCapabilities);
    if (missing.length > 0) {
      rejections.push({
        providerId: entry.provider.id,
        reason: `missing capabilities: ${missing.join(", ")}`,
      });
      continue;
    }
    const authorization = authorized.get(entry.provider.id);
    if (!requirements.allowDangerous && descriptor.dangerous && authorization === undefined) {
      rejections.push({
        providerId: entry.provider.id,
        reason: "dangerous worker authority is not allowed by this supervision policy",
      });
      continue;
    }
    if (!allowedWriteAccess.has(descriptor.writeAccess) && authorization === undefined) {
      rejections.push({
        providerId: entry.provider.id,
        reason: `write access ${descriptor.writeAccess} is not allowed by this supervision policy`,
      });
      continue;
    }
    if (requirements.requireSandboxCapableHost && !(await hostImposesContainment(entry))) {
      // No authorization overrides this one. Prompt text and human trust are
      // not an OS write boundary (issue #11); whoever vouches for the
      // provider, the filesystem is still the filesystem.
      rejections.push({
        providerId: entry.provider.id,
        reason: "work with write access requires a host that imposes OS containment (HostCapabilities.sandbox)",
      });
      continue;
    }
    if (requirements.requireWorkspaceBinding && !descriptor.bindsWorkspace) {
      // No authorization overrides this one. A provider that cannot be told
      // where to execute cannot be supervised, whoever vouches for it.
      rejections.push({
        providerId: entry.provider.id,
        reason: "provider does not guarantee workspace binding",
      });
      continue;
    }
    if (requirements.requireGuardedToolMediation && !capabilities.guardedToolMediation) {
      // No authorization overrides this one. A provider that cannot return a
      // Guard verdict to its native tool loop has no enforcement seam.
      rejections.push({
        providerId: entry.provider.id,
        reason: "provider does not support guarded tool mediation",
      });
      continue;
    }
    return {
      provider: entry.provider,
      hostId: entry.hostId,
      capabilities,
      descriptor,
      preferred: preferred.has(entry.provider.id),
      rejections,
      ...(authorization === undefined ? {} : { authorization }),
    };
  }

  throw new WorkerSelectionError(work.id, rejections);
}

function assertWorkerHandleSurface(handle: WorkerHandle, input: WorkerStartRequest): void {
  if (typeof handle !== "object" || handle === null) {
    throw new WorkerBoundaryError("worker provider returned no handle object");
  }
  if (typeof handle.workerId !== "string" || handle.workerId.trim().length === 0) {
    throw new WorkerBoundaryError("worker handle carries no stable workerId");
  }
  if (handle.attemptId !== input.attemptId) {
    throw new WorkerBoundaryError(
      `worker handle attemptId ${handle.attemptId} does not match request ${input.attemptId}`,
    );
  }
  if (typeof handle.observe !== "function" || typeof handle.result !== "function" || typeof handle.cancel !== "function") {
    throw new WorkerBoundaryError("worker handle does not implement observe(), result(), and cancel()");
  }
}

class ValidatedWorkerHandle implements WorkerHandle {
  readonly workerId: string;
  readonly attemptId: string;
  readonly #delegate: WorkerHandle;
  readonly #capabilities: WorkerCapabilities;
  readonly #resultPromise: Promise<WorkerResult>;

  constructor(delegate: WorkerHandle, capabilities: WorkerCapabilities) {
    this.#delegate = delegate;
    this.#capabilities = capabilities;
    this.workerId = delegate.workerId;
    this.attemptId = delegate.attemptId;
    this.#resultPromise = Promise.resolve(delegate.result()).then(parseWorkerResult);
  }

  async *observe(): AsyncIterable<WorkerObservation> {
    for await (const observation of this.#delegate.observe()) {
      yield parseWorkerObservation(observation);
    }
  }

  result(): Promise<WorkerResult> {
    return this.#resultPromise;
  }

  async cancel(reason: string): Promise<void> {
    const normalized = z.string().trim().min(1).max(1000).parse(reason);
    if (!this.#capabilities.cancel) {
      throw new WorkerBoundaryError(`worker ${this.workerId} does not advertise cancellation`);
    }
    await this.#delegate.cancel(normalized);
  }
}

export interface StartedWorkerAttempt {
  providerId: string;
  capabilities: WorkerCapabilities;
  descriptor: WorkerDescriptor;
  handle: WorkerHandle;
}

export async function startWorkerAttempt(
  provider: WorkerProvider,
  rawInput: WorkerStartRequest,
  options: WorkerStartOptions = {},
): Promise<StartedWorkerAttempt> {
  const input = parseWorkerStartRequest(rawInput);
  const providerId = nonEmptyId.parse(provider.id);
  const [capabilities, descriptor] = await Promise.all([
    Promise.resolve(provider.capabilities()).then((value) => WorkerCapabilitiesSchema.parse(value)),
    describeWorkerProvider(provider),
  ]);
  if (!descriptor.bindsWorkspace) {
    throw new WorkerBoundaryError(
      `worker ${providerId} does not guarantee workspace binding and cannot be started for bound work`,
    );
  }
  if (input.workspace.mode === "isolated-write" && !capabilities.guardedToolMediation) {
    throw new WorkerBoundaryError(
      `worker ${providerId} does not support guarded tool mediation and cannot be started for write-capable work`,
    );
  }
  if (input.workspace.mode === "isolated-write" && options.guardedToolMediation === undefined) {
    throw new WorkerBoundaryError(
      `worker ${providerId} requires guarded tool mediation for write-capable work`,
    );
  }
  const delegate = await provider.start(input, options);
  assertWorkerHandleSurface(delegate, input);
  return {
    providerId,
    capabilities,
    descriptor,
    handle: new ValidatedWorkerHandle(delegate, capabilities),
  };
}
