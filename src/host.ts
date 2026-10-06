import { z } from "zod";
import {
  ActorRefSchema,
  AuthorityPolicySchema,
  ContextRequestSchema,
  EvidenceRefSchema,
  GuardEvaluationRecordSchema,
  ResourceRefSchema,
  TAINTED_ATTACHMENT_MAX,
  TaintedAttachmentSchema,
  TimestampSchema,
  WorkContractSchema,
} from "./schemas.js";
import type { GuardedToolMediation } from "./guard.js";
import type { HttpEffectsPort } from "./http-effects.js";
import { ContextPackSchema } from "./context.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);

export const WorkspaceModeSchema = z.enum(["read-only", "isolated-write"]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/**
 * The minimum execution identity a Worker needs in order to run in the exact
 * place the organization believes it is running. Portable by construction: it
 * names a filesystem root and the revision identity behind it, and nothing
 * about any concrete host.
 */
export const WorkspaceBindingSchema = z.object({
  workspaceId: id,
  leaseId: id,
  uri: text.max(2048),
  executionRoot: text.max(4096),
  mode: WorkspaceModeSchema,
  baseRevision: text.max(300),
  expectedHead: text.max(300).optional(),
  expectedDigest: text.max(300).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.executionRoot.startsWith("/")) {
    ctx.addIssue({
      code: "custom",
      path: ["executionRoot"],
      message: "workspace executionRoot must be an absolute path",
    });
  }
  if (value.executionRoot.includes("\u0000")) {
    ctx.addIssue({ code: "custom", path: ["executionRoot"], message: "workspace executionRoot must not contain NUL" });
  }
});
export type WorkspaceBinding = z.infer<typeof WorkspaceBindingSchema>;

export class WorkspaceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBindingError";
  }
}

export const WorkerCapabilitiesSchema = z.object({
  streamingObservations: z.boolean(),
  cancel: z.boolean(),
  resume: z.boolean(),
  /** The provider invokes an awaited native permission callback before effect. */
  guardedToolMediation: z.boolean().default(false),
}).strict();
export type WorkerCapabilities = z.infer<typeof WorkerCapabilitiesSchema>;

export const WorkerDescriptorSchema = z.object({
  id,
  displayName: text.max(200),
  description: text.max(2000),
  adapter: id,
  product: id,
  productVersion: z.string().trim().min(1).max(200).optional(),
  execution: z.enum(["one-shot", "session", "continuable"]),
  context: z.enum(["standalone", "inherits-parent"]),
  authorityMode: text.max(200),
  writeAccess: z.enum(["none", "workspace", "unrestricted", "host-policy"]),
  dangerous: z.boolean(),
  /**
   * True only when this provider guarantees that execution happens inside the
   * WorkspaceBinding.executionRoot it is handed. Providers that resolve their
   * own working directory MUST declare false; Crew refuses them.
   */
  bindsWorkspace: z.boolean(),
  credentialEnv: z.array(id).max(20),
}).strict();
export type WorkerDescriptor = z.infer<typeof WorkerDescriptorSchema>;

export const WorkerStartRequestSchema = z.object({
  work: WorkContractSchema,
  taskId: id,
  attemptId: id,
  /**
   * The Work objective, only. Free-text dependency reports and other
   * model-authored content must arrive as `taintedAttachments`, never as
   * part of this string.
   */
  objective: text.max(2000),
  /**
   * Data the worker must read as data, not instruction. Adapters render these
   * in fenced blocks under the provider's own untrusted-content rules; Crew
   * never splices them into `objective`.
   */
  taintedAttachments: z.array(TaintedAttachmentSchema).max(TAINTED_ATTACHMENT_MAX).optional(),
  authority: AuthorityPolicySchema,
  context: ContextRequestSchema,
  /**
   * The exact ContextBridge selection for this Attempt. `context` remains the
   * declarative request from the Work contract; this pack is the material the
   * bridge actually selected and the provider must carry to the worker.
   */
  contextPack: ContextPackSchema.optional(),
  workspace: WorkspaceBindingSchema,
  /**
   * Optional wall-clock deadline after which the Attempt is forcibly
   * failed. Constitution §10 requires "timeouts" alongside PID checks;
   * without this, a hung worker hangs the mission indefinitely because
   * Crew awaits `started.handle.result()` with no deadline (#16).
   * ISO-8601 with timezone offset.
   */
  attemptDeadlineAt: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.work.type !== "SHIP" && value.workspace.mode !== "read-only") {
    ctx.addIssue({
      code: "custom",
      path: ["workspace", "mode"],
      message: `${value.work.type} work must be bound to a read-only workspace`,
    });
  }
});
export type WorkerStartRequest = z.infer<typeof WorkerStartRequestSchema>;

export const WorkerObservationSchema = z.object({
  kind: z.enum(["activity", "message", "artifact", "blocked", "diagnostic"]),
  occurredAt: TimestampSchema,
  detail: text.max(4000),
  actor: ActorRefSchema.optional(),
  evidence: z.array(EvidenceRefSchema).optional(),
  /**
   * A decision made at a real enforcement seam, reported by the provider that
   * imposed it. This is the only channel through which authority becomes
   * evidence: a label applied elsewhere is exactly the prompt-text boundary
   * issue #11 rejects. `granted` accompanies the imposition of an OS boundary
   * (the seam states what it now enforces); `denied` accompanies the seam's
   * observation that the OS refused the worker.
   */
  authority: z.object({
    decision: z.enum(["granted", "denied"]),
    boundary: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(1000),
  }).strict().optional(),
  /** The bounded request summary and verdict from an awaited native permission hook. */
  guardEvaluation: GuardEvaluationRecordSchema.optional(),
}).strict();
export type WorkerObservation = z.infer<typeof WorkerObservationSchema>;

export const WorkerResultSchema = z.object({
  status: z.enum(["finished", "failed", "cancelled"]),
  summary: text.max(4000),
  artifacts: z.array(ResourceRefSchema),
  evidence: z.array(EvidenceRefSchema),
  /**
   * Provider-observed execution identity that is safe to compare across runs.
   * This is evidence about execution configuration, never Work authority.
   */
  runtime: z.object({
    model: z.string().trim().min(1).max(300).optional(),
    effortLevel: z.string().trim().min(1).max(100).optional(),
  }).strict().optional(),
}).strict();
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export const HostCapabilitiesSchema = z.object({
  workers: z.literal(true),
  processes: z.boolean(),
  sessions: z.boolean(),
  filesystem: z.boolean(),
  sandbox: z.boolean(),
  tools: z.boolean(),
}).strict();
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

export interface WorkerHandle {
  readonly workerId: string;
  readonly attemptId: string;
  observe(): AsyncIterable<WorkerObservation>;
  result(): Promise<WorkerResult>;
  cancel(reason: string): Promise<void>;
}

/**
 * Runtime-only attempt options. They are deliberately separate from the
 * serializable WorkerStartRequest: a permission callback is not ledger data.
 */
export interface WorkerStartOptions {
  readonly guardedToolMediation?: GuardedToolMediation;
  /** Optional host-owned exact-resource broker. Contains no credentials or target overrides. */
  readonly httpEffects?: HttpEffectsPort;
}

export interface WorkerProvider {
  readonly id: string;
  describe?(): Promise<WorkerDescriptor>;
  capabilities(): Promise<WorkerCapabilities>;
  start(input: WorkerStartRequest, options?: WorkerStartOptions): Promise<WorkerHandle>;
}

export interface WorkerRegistry {
  list(): readonly WorkerProvider[];
  get(id: string): WorkerProvider | undefined;
}

export interface CapabilityProvider {
  readonly id: string;
}

export interface ProcessProvider extends CapabilityProvider {}
export interface SessionProvider extends CapabilityProvider {}
export interface FilesystemProvider extends CapabilityProvider {}
export interface SandboxProvider extends CapabilityProvider {}
export interface ToolProvider extends CapabilityProvider {}

export interface HarnessHost {
  readonly id: string;
  capabilities(): Promise<HostCapabilities>;
  workers(): WorkerRegistry;
  processes(): ProcessProvider | null;
  sessions(): SessionProvider | null;
  filesystem(): FilesystemProvider | null;
  sandbox(): SandboxProvider | null;
  tools(): ToolProvider | null;
  close(): Promise<void>;
}

export function parseWorkerDescriptor(input: unknown): WorkerDescriptor {
  return WorkerDescriptorSchema.parse(input);
}

export function parseWorkerStartRequest(input: unknown): WorkerStartRequest {
  return WorkerStartRequestSchema.parse(input);
}

export function parseWorkspaceBinding(input: unknown): WorkspaceBinding {
  return WorkspaceBindingSchema.parse(input);
}

/**
 * Fail-closed gate used by every provider that claims bindsWorkspace. Throws
 * before any process starts when the binding is absent, malformed, or points
 * somewhere other than where the provider is about to execute.
 */
export function requireBoundExecutionRoot(
  providerId: string,
  request: WorkerStartRequest,
): string {
  const binding = WorkspaceBindingSchema.parse(request.workspace);
  if (binding.executionRoot.trim().length === 0) {
    throw new WorkspaceBindingError(`worker ${providerId} received an empty executionRoot`);
  }
  return binding.executionRoot;
}

export function parseWorkerObservation(input: unknown): WorkerObservation {
  return WorkerObservationSchema.parse(input);
}

export function parseWorkerResult(input: unknown): WorkerResult {
  return WorkerResultSchema.parse(input);
}

export function parseHostCapabilities(input: unknown): HostCapabilities {
  return HostCapabilitiesSchema.parse(input);
}

export async function assertHostCapabilitiesMatch(host: HarnessHost): Promise<void> {
  const capabilities = HostCapabilitiesSchema.parse(await host.capabilities());
  const pairs: Array<[keyof Omit<HostCapabilities, "workers">, CapabilityProvider | null]> = [
    ["processes", host.processes()],
    ["sessions", host.sessions()],
    ["filesystem", host.filesystem()],
    ["sandbox", host.sandbox()],
    ["tools", host.tools()],
  ];

  if (host.workers().list().length === 0) {
    throw new Error(`host ${host.id} claims workers capability but exposes no WorkerProviders`);
  }

  for (const [name, provider] of pairs) {
    if (capabilities[name] !== (provider !== null)) {
      throw new Error(`host ${host.id} capability ${name} does not match provider availability`);
    }
  }
}
