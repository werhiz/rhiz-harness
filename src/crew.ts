import { z } from "zod";
import { HttpEffectBroker, getHttpEffectPolicyBindings, type HttpEffectBinding } from "./http-effects.js";

import { DigestScopeSchema } from "./workspace-digest.js";
import { projectBoard } from "./board.js";
import { proveContractBoundCategoryAuthority } from "./contract-bound-authority.js";
import type { EventLedger } from "./ledger.js";
import { streamIdForWork } from "./refiner.js";
import type {
  ActorRef,
  GuardToolCall,
  HarnessEvent,
  ResourceRef,
  WorkContract,
  WorkState,
} from "./schemas.js";
import {
  ActorRefSchema,
  parseHarnessEvent,
  TAINTED_ATTACHMENT_MAX,
  TaintedAttachmentSchema,
  TimestampSchema,
  WorkContractSchema,
  WorkStateSchema,
} from "./schemas.js";
import type { TaintedAttachment } from "./schemas.js";
import {
  createDefaultPolicyOracle,
  createGuardedToolMediation,
  guardPolicyFromWorkContract,
  GuardianRejectionCircuitBreaker,
  GuardEvaluationSchema,
  GuardRequestSchema,
  GuardToolCallSchema,
} from "./guard.js";
import type {
  WorkerDescriptor,
  WorkerObservation,
  WorkerProvider,
  WorkerResult,
} from "./host.js";
import {
  parseWorkspaceBinding,
  WorkerDescriptorSchema,
  WorkerResultSchema,
} from "./host.js";
import type {
  WorkerSelection,
  WorkerSelectionRequirements,
} from "./workers.js";
import {
  selectWorkerProvider,
  startWorkerAttempt,
  WorkerCapabilityNameSchema,
  WorkerCatalog,
  WorkerSelectionRequirementsSchema,
} from "./workers.js";
import type { RouterBridge } from "./router-bridge.js";
import type { ContextBridge } from "./context-bridge.js";
import type { RefinerBridge } from "./refiner-bridge.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);
const digest = z.string().trim().min(1).max(300);

export const CrewWorkspaceModeSchema = z.enum(["read-only", "isolated-write"]);
export type CrewWorkspaceMode = z.infer<typeof CrewWorkspaceModeSchema>;

export const CrewWorkspaceSchema = z.object({
  leaseId: id,
  workspaceId: id,
  uri: text.max(2048),
  executionRoot: text.max(4096),
  baseRevision: text.max(300),
  mode: CrewWorkspaceModeSchema,
  sourceWorkId: id.optional(),
}).strict();
export type CrewWorkspace = z.infer<typeof CrewWorkspaceSchema>;

export const CrewWorkspaceSnapshotSchema = z.object({
  workspaceId: id,
  head: text.max(300),
  digest,
  /**
   * What the digest actually covers. Required, so a snapshot can never be read
   * as exact without saying what it was exact about. See issue #10.
   */
  digestScope: DigestScopeSchema,
  changedPaths: z.array(text.max(4096)),
  observedAt: TimestampSchema,
}).strict();
export type CrewWorkspaceSnapshot = z.infer<typeof CrewWorkspaceSnapshotSchema>;

export const CrewWorkspaceAcquireRequestSchema = z.object({
  crewId: id,
  work: WorkContractSchema,
  baseRevision: text.max(300),
  mode: CrewWorkspaceModeSchema,
  sourceWorkspace: CrewWorkspaceSchema.optional(),
  sourceWorkId: id.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.sourceWorkspace === undefined) !== (value.sourceWorkId === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceWorkspace"],
      message: "sourceWorkspace and sourceWorkId must be supplied together",
    });
  }
  if (value.sourceWorkId !== undefined && !value.work.dependencies.includes(value.sourceWorkId)) {
    ctx.addIssue({
      code: "custom",
      path: ["sourceWorkId"],
      message: "inherited workspace source must be a direct Work dependency",
    });
  }
});
export type CrewWorkspaceAcquireRequest = z.infer<typeof CrewWorkspaceAcquireRequestSchema>;

export interface CrewWorkspaceProvider {
  readonly id: string;
  acquire(request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace>;
  snapshot(workspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot>;
  release(workspaceId: string): Promise<void>;
  close(): Promise<void>;
}

const FreshWorkspaceStrategySchema = z.object({
  strategy: z.literal("fresh"),
  mode: CrewWorkspaceModeSchema,
}).strict();

const InheritedWorkspaceStrategySchema = z.object({
  strategy: z.literal("inherit"),
  mode: z.literal("read-only"),
  fromWorkId: id,
}).strict();

export const CrewWorkspaceStrategySchema = z.discriminatedUnion("strategy", [
  FreshWorkspaceStrategySchema,
  InheritedWorkspaceStrategySchema,
]);
export type CrewWorkspaceStrategy = z.infer<typeof CrewWorkspaceStrategySchema>;

export const CrewMissionSchema = z.object({
  work: WorkContractSchema,
  workspace: CrewWorkspaceStrategySchema,
  requiredCapabilities: z.array(WorkerCapabilityNameSchema).default([]),
  allowDangerousWorker: z.boolean().default(false),
  /**
   * This mission is a repair attempt on a Work already open on this stream.
   *
   * `work.created` may occur only once per projection, so a second Crew run
   * against the same Work must not re-declare the contract. Setting this says
   * the caller has already opened the Work and is spending one more attempt
   * from its budget. It is opt-in and typed because a mission that skips
   * `work.created` against a fresh stream must fail closed on
   * `event-before-work-created` rather than silently inventing a Work.
   */
  continuesWork: z.boolean().default(false),
  /**
   * Evidence from earlier attempts on this Work, carried to the worker as
   * DATA. Verifier output is untrusted bytes: it renders under the provider's
   * untrusted-content rules and can never become instruction.
   */
  priorAttemptEvidence: z.array(TaintedAttachmentSchema).max(TAINTED_ATTACHMENT_MAX).default([]),
}).strict().superRefine((value, ctx) => {
  const { work, workspace } = value;
  // Crew executes exactly ONE attempt per mission. `maxAttempts` is the
  // Work-level budget owned by whoever drives the repair loop, so Crew reads
  // it as a ceiling rather than as a retry instruction it performs itself.
  if (work.workerPolicy.maxAttempts < 1) {
    ctx.addIssue({
      code: "custom",
      path: ["work", "workerPolicy", "maxAttempts"],
      message: "maxAttempts must leave at least one attempt for this mission",
    });
  }
  if (value.priorAttemptEvidence.length > 0 && !value.continuesWork) {
    ctx.addIssue({
      code: "custom",
      path: ["priorAttemptEvidence"],
      message: "prior attempt evidence is only meaningful on a mission that continues an open Work",
    });
  }
  if (work.workerPolicy.allowParallelAttempts) {
    ctx.addIssue({
      code: "custom",
      path: ["work", "workerPolicy", "allowParallelAttempts"],
      message: "Crew v0 does not permit parallel attempts",
    });
  }
  if (work.type === "SHIP") {
    if (workspace.strategy !== "fresh" || workspace.mode !== "isolated-write") {
      ctx.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "SHIP missions require a fresh isolated-write workspace in Crew v0",
      });
    }
  } else if (work.type === "SCOUT") {
    if (workspace.strategy !== "fresh" || workspace.mode !== "read-only") {
      ctx.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "SCOUT missions require a fresh read-only workspace in Crew v0",
      });
    }
  } else {
    if (!work.verificationPolicy.independentActor) {
      ctx.addIssue({
        code: "custom",
        path: ["work", "verificationPolicy", "independentActor"],
        message: "REVIEW missions require independentActor=true",
      });
    }
    if (workspace.strategy !== "inherit") {
      ctx.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "REVIEW missions must inherit the workspace of a direct dependency",
      });
    } else if (!work.dependencies.includes(workspace.fromWorkId)) {
      ctx.addIssue({
        code: "custom",
        path: ["workspace", "fromWorkId"],
        message: "REVIEW workspace source must be a direct Work dependency",
      });
    }
  }
});
export type CrewMission = z.infer<typeof CrewMissionSchema>;

export const CrewPlanSchema = z.object({
  id,
  objective: text.max(4000),
  baseRevision: text.max(300),
  maxParallel: z.literal(1).default(1),
  missions: z.array(CrewMissionSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const byId = new Map<string, CrewMission>();
  for (const [index, mission] of value.missions.entries()) {
    if (byId.has(mission.work.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["missions", index, "work", "id"],
        message: `duplicate Crew mission Work id ${mission.work.id}`,
      });
    }
    byId.set(mission.work.id, mission);
  }

  for (const [index, mission] of value.missions.entries()) {
    for (const dependency of mission.work.dependencies) {
      if (!byId.has(dependency)) {
        ctx.addIssue({
          code: "custom",
          path: ["missions", index, "work", "dependencies"],
          message: `dependency ${dependency} is not present in this Crew plan`,
        });
      }
    }
    if (mission.work.type === "REVIEW") {
      if (mission.work.dependencies.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["missions", index, "work", "dependencies"],
          message: "Crew v0 REVIEW missions require exactly one direct dependency",
        });
      }
      if (mission.workspace.strategy === "inherit") {
        const source = byId.get(mission.workspace.fromWorkId);
        if (source !== undefined && source.work.type !== "SHIP") {
          ctx.addIssue({
            code: "custom",
            path: ["missions", index, "workspace", "fromWorkId"],
            message: "Crew v0 REVIEW missions must inherit a SHIP workspace",
          });
        }
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (workId: string): boolean => {
    if (visiting.has(workId)) return false;
    if (visited.has(workId)) return true;
    visiting.add(workId);
    const mission = byId.get(workId);
    if (mission) {
      for (const dependency of mission.work.dependencies) {
        if (!visit(dependency)) return false;
      }
    }
    visiting.delete(workId);
    visited.add(workId);
    return true;
  };

  for (const [index, mission] of value.missions.entries()) {
    visiting.clear();
    if (!visit(mission.work.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["missions", index, "work", "dependencies"],
        message: "Crew mission dependencies must form an acyclic graph",
      });
      break;
    }
  }
});
export type CrewPlan = z.infer<typeof CrewPlanSchema>;

export interface CrewWorkerResolutionRequest {
  registry: WorkerCatalog;
  mission: CrewMission;
  workspace: CrewWorkspace;
  requirements: WorkerSelectionRequirements;
  /** A preferred worker id from the Router; ignored when the contract names explicit preferred providers. */
  routerHint?: string;
}

export interface CrewWorkerResolution {
  provider: WorkerProvider;
  selection: WorkerSelection;
  close(): Promise<void>;
}

export interface CrewWorkerResolver {
  resolve(request: CrewWorkerResolutionRequest): Promise<CrewWorkerResolution>;
}

export class CatalogCrewWorkerResolver implements CrewWorkerResolver {
  async resolve(request: CrewWorkerResolutionRequest): Promise<CrewWorkerResolution> {
    // The contract's preferredProviders always wins: the human/operator who
    // wrote the Work knows what they want. The Router's hint kicks in only
    // when no preferred providers were named, and only when the Router
    // actually selected someone (otherwise we fall through to the regular
    // selection).
    const hint = request.routerHint;
    const shouldUseHint = hint !== undefined
      && hint !== ""
      && request.mission.work.workerPolicy.preferredProviders.length === 0;
    if (shouldUseHint) {
      const hintedEntry = request.registry.getEntry(hint);
      if (hintedEntry !== undefined) {
        // Let the registry select the hinted worker if requirements allow.
        // We do this by re-running selectWorkerProvider against a virtual
        // preferred list of [hint]; if requirements filter it out we fall
        // through to ordinary selection.
        const hinted = await selectWorkerProvider(
          request.registry,
          { ...request.mission.work, workerPolicy: { ...request.mission.work.workerPolicy, preferredProviders: [hint] } },
          request.requirements,
        );
        if (hinted.provider.id === hint) {
          return {
            provider: hinted.provider,
            selection: hinted,
            async close() {},
          };
        }
        // The hint is in the registry but did not pass requirements (e.g.,
        // missing a required capability). Fall through to ordinary selection.
      }
    }
    const selection = await selectWorkerProvider(
      request.registry,
      request.mission.work,
      request.requirements,
    );
    return {
      provider: selection.provider,
      selection,
      async close() {},
    };
  }
}

export const CrewMissionStatusSchema = z.enum(["execution-finished", "failed", "blocked"]);
export type CrewMissionStatus = z.infer<typeof CrewMissionStatusSchema>;

const CrewWorkspaceReceiptSchema = z.object({
  leaseId: id,
  workspaceId: id,
  mode: CrewWorkspaceModeSchema,
  baseRevision: text.max(300),
  sourceWorkId: id.optional(),
}).strict();

export const CrewMissionReceiptSchema = z.object({
  workId: id,
  workType: z.enum(["SCOUT", "SHIP", "REVIEW"]),
  dependencyIds: z.array(id),
  status: CrewMissionStatusSchema,
  streamId: id.optional(),
  taskId: id.optional(),
  attemptId: id.optional(),
  workerProviderId: id.optional(),
  workerDescriptor: WorkerDescriptorSchema.optional(),
  /** The human exception that admitted this provider, when one did. */
  authorization: z.object({
    providerId: id,
    reason: text.max(1000),
    authorizedBy: ActorRefSchema,
  }).strict().optional(),
  selectionRejections: z.array(z.object({ providerId: id, reason: text.max(2000) }).strict()).default([]),
  workspace: CrewWorkspaceReceiptSchema.optional(),
  workspaceBefore: CrewWorkspaceSnapshotSchema.optional(),
  workspaceAfter: CrewWorkspaceSnapshotSchema.optional(),
  changedPaths: z.array(text.max(4096)).default([]),
  changeViolations: z.array(text.max(2000)).default([]),
  observationCount: z.number().int().nonnegative().default(0),
  workerResult: WorkerResultSchema.optional(),
  boardState: WorkStateSchema.optional(),
  projectionViolationCount: z.number().int().nonnegative().default(0),
  error: text.max(4000).optional(),
}).strict();
export type CrewMissionReceipt = z.infer<typeof CrewMissionReceiptSchema>;

export const CrewRunReceiptSchema = z.object({
  schema: z.literal("rhiz/crew-run/v0"),
  crewId: id,
  objective: text.max(4000),
  baseRevision: text.max(300),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  state: z.enum(["execution-complete", "failed"]),
  missions: z.array(CrewMissionReceiptSchema),
}).strict();
export type CrewRunReceipt = z.infer<typeof CrewRunReceiptSchema>;

export interface CrewRunHandle {
  readonly receipt: CrewRunReceipt;
  readonly workspaces: readonly CrewWorkspace[];
  close(): Promise<void>;
}

export interface CrewSupervisorOptions {
  plan: CrewPlan;
  ledger: EventLedger;
  workerCatalog: WorkerCatalog;
  workspaceProvider: CrewWorkspaceProvider;
  workerResolver?: CrewWorkerResolver;
  /**
   * Optional Router bridge. When present, Crew calls the bridge at every
   * mission start to compute an evidence-driven RouterDecision, persists
   * the decision as a `router.decision-made` event in the ledger, and
   * uses the selected worker id as a hint that the resolver prefers when
   * the Work contract does not name explicit preferred providers.
   */
  router?: RouterBridge;
  /**
   * Optional Context bridge. When present, Crew calls the bridge after
   * `task.created` to compose a ContextPack for the mission, persists
   * the selection as a `context.pack-selected` event, and hands the
   * returned pack's identity to the resolver path.
   */
  context?: ContextBridge;
  /**
   * Optional Refiner bridge. When present, Crew calls the bridge after
   * a terminal attempt event (success or failure) to emit
   * `refiner.proposed` events for any candidate improvement kinds the
   * analysis flagged.
   */
  refiner?: RefinerBridge;
  /** Consumer's build/job identity. It is evidence linkage, never authority. */
  correlationId?: string;
  /** Explicit host bindings; Work authority must independently grant each exact resource. */
  httpEffects?: readonly HttpEffectBinding[];
  actor: ActorRef;
  now?: () => string;
  idFactory?: () => string;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 4000);
}

/**
 * Serialize one Work stream for every CrewSupervisor sharing an EventLedger.
 *
 * The Board can reject a duplicate `attempt.started`, but projection happens
 * after the effect. Without this process-local gate, two supervisors can both
 * replay an open Work, acquire workspaces, and start workers before either sees
 * the other's Attempt. DurableEventLedger separately excludes a second process
 * with its file lock; this gate closes the same-process seam for every Ledger
 * implementation, including the in-memory Ledger used by embedders and tests.
 *
 * The gate covers the complete mission rather than only the append. That is
 * intentionally conservative: the next supervisor replays the terminal event
 * before it may decide whether the canonical Work and its attempt budget allow
 * another execution.
 */
const crewStreamQueues = new WeakMap<EventLedger, Map<string, Promise<void>>>();

async function acquireCrewStream(ledger: EventLedger, streamId: string): Promise<() => void> {
  let queues = crewStreamQueues.get(ledger);
  if (queues === undefined) {
    queues = new Map();
    crewStreamQueues.set(ledger, queues);
  }

  const predecessor = queues.get(streamId) ?? Promise.resolve();
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = predecessor.then(() => held);
  queues.set(streamId, tail);
  await predecessor;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    void tail.then(() => {
      if (queues!.get(streamId) === tail) queues!.delete(streamId);
    });
  };
}

/**
 * Compute the wall-clock deadline for an Attempt. The contract may
 * declare a budget via `workerPolicy.attemptBudgetMs`; otherwise a
 * conservative default derived from the Work kind is used. The deadline
 * is the contract's authority on attempt duration, not a suggestion;
 * Crew will fail the Attempt if the worker does not return by then (#16).
 */
const DEFAULT_ATTEMPT_BUDGET_MS: Readonly<Record<WorkContract["type"], number>> = Object.freeze({
  SCOUT: 10 * 60 * 1000,        // 10 min
  REVIEW: 15 * 60 * 1000,      // 15 min
  SHIP: 60 * 60 * 1000,        // 60 min
});

export function computeAttemptDeadline(work: WorkContract, startedAtIso: string): string {
  const budgetMs = (work.workerPolicy as { attemptBudgetMs?: number }).attemptBudgetMs
    ?? DEFAULT_ATTEMPT_BUDGET_MS[work.type];
  const startedAtMs = Date.parse(startedAtIso);
  if (Number.isNaN(startedAtMs)) {
    throw new Error(`computeAttemptDeadline received an invalid startedAtIso: ${startedAtIso}`);
  }
  return new Date(startedAtMs + budgetMs).toISOString();
}

/** Race an arbitrary Crew lifecycle operation against its absolute deadline. */
async function awaitDeadline<T>(
  promise: Promise<T>,
  deadlineIso: string,
  now: () => string,
): Promise<{ kind: "completed"; value: T } | { kind: "deadline"; observedAt: string }> {
  const deadlineMs = Date.parse(deadlineIso);
  const remaining = deadlineMs - Date.parse(now());
  if (remaining <= 0) {
    return { kind: "deadline", observedAt: now() };
  }
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), remaining);
    // The timer must not keep the process alive past the lifecycle race.
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      promise.then((value) => ({ kind: "completed" as const, value })),
      deadline.then(() => ({ kind: "deadline" as const, observedAt: now() })),
    ]);
    // Timer callbacks can be delayed behind an I/O or microtask completion.
    // The absolute wall-clock cutoff remains authoritative even in that race.
    if (outcome.kind === "completed" && Date.parse(now()) >= deadlineMs) {
      return { kind: "deadline", observedAt: now() };
    }
    return outcome;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Keep teardown hooks from extending a Crew receipt indefinitely. */
async function awaitCleanupGrace(promise: Promise<unknown>, milliseconds = 100): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Cancellation and cleanup are best-effort after the Attempt is closed.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function awaitOptionalGrace<T>(promise: Promise<T>, milliseconds = 100): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

function resourcePath(resource: ResourceRef): string | null {
  const uri = resource.uri;
  if (resource.kind === "repository") return "";
  if (uri.startsWith("repo://")) {
    const rest = uri.slice("repo://".length);
    const slash = rest.indexOf("/");
    return slash === -1 ? "" : normalizePath(rest.slice(slash + 1));
  }
  for (const prefix of ["file://", "dir://", "path://"]) {
    if (uri.startsWith(prefix)) return normalizePath(uri.slice(prefix.length));
  }
  return null;
}

function pathAllowed(path: string, scope: readonly ResourceRef[]): boolean {
  const normalized = normalizePath(path);
  if (normalized === null) return false;
  return scope.some((resource) => {
    const base = resourcePath(resource);
    if (base === null) return false;
    if (resource.kind === "repository") return true;
    if (base === "") return false;
    if (resource.kind === "file") return normalized === base;
    if (resource.kind === "directory") return normalized === base || normalized.startsWith(`${base}/`);
    return false;
  });
}

/**
 * The logical resources an attempt's lease claims, derived from the Work's
 * own writeScope.
 *
 * These are the paths the Work is permitted to change, so they are exactly
 * what a concurrent attempt must not be allowed to hold at the same time.
 * Anything whose path cannot be resolved contributes no claim rather than a
 * wildcard: a lease must never claim more than the contract granted.
 */
export function dedupeResourceClaims(
  writeScope: readonly ResourceRef[],
): { kind: "path"; resource: string }[] {
  const seen = new Set<string>();
  const claims: { kind: "path"; resource: string }[] = [];
  for (const resource of writeScope) {
    const base = resourcePath(resource);
    if (base === null) continue;
    const claim = resource.kind === "repository" && base === "" ? "." : base;
    if (claim === "" || seen.has(claim)) continue;
    seen.add(claim);
    claims.push({ kind: "path", resource: claim });
  }
  return claims;
}

export function workspaceChangeViolations(
  work: WorkContract,
  workspace: CrewWorkspace,
  before: CrewWorkspaceSnapshot,
  after: CrewWorkspaceSnapshot,
): string[] {
  const violations: string[] = [];
  if (before.workspaceId !== workspace.workspaceId || after.workspaceId !== workspace.workspaceId) {
    violations.push("workspace snapshot identity does not match the active lease");
    return violations;
  }
  if (workspace.mode === "read-only") {
    if (before.digest !== after.digest) {
      violations.push("read-only Crew mission changed its workspace");
    }
    return violations;
  }
  if (before.head !== after.head) {
    violations.push("Crew v0 workers may modify files but may not move or commit workspace HEAD");
  }
  for (const path of after.changedPaths) {
    if (!pathAllowed(path, work.writeScope)) {
      violations.push(`changed path ${path} is outside Work writeScope`);
    }
  }
  return violations;
}

/**
 * Render the Work objective and the dependency-report attachments that travel
 * alongside it.
 *
 * The objective MUST contain the Work's intent only. Free-text dependency
 * reports are returned separately as `TaintedAttachment` values, each with
 * provenance and a stable label. The adapter is responsible for rendering
 * those attachments as data (fenced content), never as part of the
 * instruction string. A SHIP worker's summary cannot reach a REVIEW
 * worker's prompt through this seam: the type system refuses the
 * concatenation.
 */
export function renderCrewMissionContext(
  work: WorkContract,
  dependencyReceipts: readonly CrewMissionReceipt[],
  priorAttemptEvidence: readonly TaintedAttachment[] = [],
): { objective: string; taintedAttachments: TaintedAttachment[] } {
  // Evidence from earlier attempts on THIS Work leads, because a repair
  // attempt's first question is what the verifier already refused. It stays
  // tainted: it travels in the attachment channel, never in the objective.
  const taintedAttachments: TaintedAttachment[] = [...priorAttemptEvidence];
  for (const receipt of dependencyReceipts) {
    const summary = receipt.workerResult?.summary ?? receipt.error;
    if (summary !== undefined && summary !== null && summary !== "") {
      taintedAttachments.push(TaintedAttachmentSchema.parse({
        id: `attachment:${receipt.workId}:report`,
        label: "dependency-report",
        source: {
          value: summary.slice(0, 4000),
          provenance: {
            kind: "worker-report",
            workId: receipt.workId,
            workType: receipt.workType,
            providerId: receipt.workerProviderId,
          },
        },
      }));
    }
    const artifactUris = receipt.workerResult?.artifacts.map((artifact) => artifact.uri) ?? [];
    if (artifactUris.length > 0) {
      taintedAttachments.push(TaintedAttachmentSchema.parse({
        id: `attachment:${receipt.workId}:claims`,
        label: "claimed-artifact",
        source: {
          value: artifactUris.join(", ").slice(0, 4000),
          provenance: {
            kind: "artifact-claim",
            workId: receipt.workId,
            artifactUri: artifactUris[0] ?? "",
          },
        },
      }));
    }
  }
  return { objective: work.objective.slice(0, 2000), taintedAttachments };
}

/**
 * @deprecated Use `renderCrewMissionContext` instead. Returns a string only,
 * preserved as a typed sentinel so any caller that still concatenates
 * dependency reports into the objective fails at the call site.
 */
export function renderCrewMissionObjective(work: WorkContract): string {
  return work.objective.slice(0, 2000);
}

function observationState(observation: WorkerObservation): "working" | "waiting" | "unknown" {
  if (observation.kind === "blocked") return "waiting";
  if (observation.kind === "activity" || observation.kind === "message" || observation.kind === "artifact") return "working";
  return "unknown";
}

class CrewRunHandleImpl implements CrewRunHandle {
  readonly receipt: CrewRunReceipt;
  readonly workspaces: readonly CrewWorkspace[];
  readonly #workspaceProvider: CrewWorkspaceProvider;
  #closePromise: Promise<void> | undefined;

  constructor(receipt: CrewRunReceipt, workspaces: readonly CrewWorkspace[], provider: CrewWorkspaceProvider) {
    this.receipt = CrewRunReceiptSchema.parse(receipt);
    this.workspaces = workspaces.map((workspace) => CrewWorkspaceSchema.parse(workspace));
    this.#workspaceProvider = provider;
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      const failures: unknown[] = [];
      const workspaceIds = [...new Set(this.workspaces.map((workspace) => workspace.workspaceId))];
      for (const workspaceId of workspaceIds.reverse()) {
        try {
          await this.#workspaceProvider.release(workspaceId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Crew workspace cleanup failed");
    })();
    return this.#closePromise;
  }
}

export class CrewSupervisor {
  readonly plan: CrewPlan;
  readonly #ledger: EventLedger;
  readonly #workerCatalog: WorkerCatalog;
  readonly #workspaceProvider: CrewWorkspaceProvider;
  readonly #workerResolver: CrewWorkerResolver;
  readonly #router: RouterBridge | undefined;
  readonly #context: ContextBridge | undefined;
  readonly #refiner: RefinerBridge | undefined;
  readonly #actor: ActorRef;
  readonly #correlationId: string | undefined;
  readonly #httpEffects: readonly HttpEffectBinding[];
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(options: CrewSupervisorOptions) {
    this.plan = CrewPlanSchema.parse(options.plan);
    this.#ledger = options.ledger;
    this.#workerCatalog = options.workerCatalog;
    this.#workspaceProvider = options.workspaceProvider;
    this.#workerResolver = options.workerResolver ?? new CatalogCrewWorkerResolver();
    this.#router = options.router;
    this.#context = options.context;
    this.#refiner = options.refiner;
    this.#actor = ActorRefSchema.parse(options.actor);
    this.#correlationId = options.correlationId === undefined ? undefined : id.parse(options.correlationId);
    this.#httpEffects = (options.httpEffects ?? []).map(binding => Object.freeze({ ...binding }));
    getHttpEffectPolicyBindings(this.#httpEffects);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  async run(): Promise<CrewRunHandle> {
    const startedAt = this.#now();
    const receipts = new Map<string, CrewMissionReceipt>();
    const workspaces = new Map<string, CrewWorkspace>();
    const pending = new Set(this.plan.missions.map((mission) => mission.work.id));

    while (pending.size > 0) {
      let progressed = false;
      for (const mission of this.plan.missions) {
        if (!pending.has(mission.work.id)) continue;
        const dependencyReceipts = mission.work.dependencies.map((dependency) => receipts.get(dependency));
        if (dependencyReceipts.some((receipt) => receipt?.status === "failed" || receipt?.status === "blocked")) {
          const receipt = CrewMissionReceiptSchema.parse({
            workId: mission.work.id,
            workType: mission.work.type,
            dependencyIds: mission.work.dependencies,
            status: "blocked",
            selectionRejections: [],
            changedPaths: [],
            changeViolations: [],
            observationCount: 0,
            projectionViolationCount: 0,
            error: "one or more Crew mission dependencies did not finish successfully",
          });
          receipts.set(mission.work.id, receipt);
          pending.delete(mission.work.id);
          progressed = true;
          continue;
        }
        if (dependencyReceipts.some((receipt) => receipt === undefined)) continue;

        const receipt = await this.#runMission(mission, receipts, workspaces);
        receipts.set(mission.work.id, receipt);
        pending.delete(mission.work.id);
        progressed = true;
      }
      if (!progressed) {
        throw new Error("Crew plan made no progress despite passing dependency validation");
      }
    }

    const ordered = this.plan.missions.map((mission) => receipts.get(mission.work.id)!);
    const state = ordered.every((receipt) => receipt.status === "execution-finished")
      ? "execution-complete"
      : "failed";
    const receipt = CrewRunReceiptSchema.parse({
      schema: "rhiz/crew-run/v0",
      crewId: this.plan.id,
      objective: this.plan.objective,
      baseRevision: this.plan.baseRevision,
      startedAt,
      finishedAt: this.#now(),
      state,
      missions: ordered,
    });
    return new CrewRunHandleImpl(receipt, [...workspaces.values()], this.#workspaceProvider);
  }

  async #runMission(
    mission: CrewMission,
    receipts: ReadonlyMap<string, CrewMissionReceipt>,
    workspaces: Map<string, CrewWorkspace>,
  ): Promise<CrewMissionReceipt> {
    const work = mission.work;
    // Work lifecycle, Router, Context, Refiner, and Integration Controller
    // events must converge on one replayable stream. A per-Crew stream leaves
    // the Integration Controller unable to find the Work it is integrating.
    const streamId = streamIdForWork(work.id);
    const taskId = `task:crew:${this.#idFactory()}`;
    const attemptId = `attempt:crew:${this.#idFactory()}`;
    const sourceWorkId = mission.workspace.strategy === "inherit" ? mission.workspace.fromWorkId : undefined;
    const sourceWorkspace = sourceWorkId === undefined ? undefined : workspaces.get(sourceWorkId);
    let workspace: CrewWorkspace | undefined;
    let before: CrewWorkspaceSnapshot | undefined;
    let after: CrewWorkspaceSnapshot | undefined;
    let resolution: CrewWorkerResolution | undefined;
    let result: WorkerResult | undefined;
    let observations = 0;
    let attemptStarted = false;
    let terminalAttemptEvent = false;
    let activeAttemptDeadlineAt: string | undefined;
    // Once closed, no late worker observation or Guard callback may append
    // evidence that changes the terminal Attempt's story.
    let workerClosed = false;
    const httpEffectsAbort = new AbortController();
    let boardState: WorkState | undefined;
    let projectionViolationCount = 0;
    let changeViolations: string[] = [];
    let errorMessage: string | undefined;
    let contractRevision = 1;
    let deadlineObservedAt: string | undefined;
    let correlationId = this.#correlationId;
    const attemptClosed = (): boolean => {
      if (workerClosed) return true;
      if (activeAttemptDeadlineAt !== undefined && Date.parse(this.#now()) >= Date.parse(activeAttemptDeadlineAt)) {
        workerClosed = true;
      }
      return workerClosed;
    };

    const append = async (
      type: HarnessEvent["type"],
      payload: unknown,
      extra: Partial<HarnessEvent> = {},
      observedAt: string | null = null,
    ): Promise<void> => {
      const timestamp = observedAt ?? this.#now();
      const event = parseHarnessEvent({
        id: `event:crew:${this.#idFactory()}`,
        type,
        schemaVersion: 1,
        streamId,
        workId: work.id,
        actor: this.#actor,
        occurredAt: timestamp,
        recordedAt: timestamp,
        evidence: [],
        payload,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...extra,
      });
      await this.#ledger.append(event);
    };

    const releaseCrewStream = await acquireCrewStream(this.#ledger, streamId);
    try {
      const existingEvents = await this.#ledger.replay(streamId);
      if (existingEvents.length > 0) {
        const originalCorrelationId = existingEvents.find((event) => event.type === "work.created")?.correlationId;
        if (correlationId !== undefined && correlationId !== originalCorrelationId) {
          throw new Error("continued Work must preserve its original correlation identity");
        }
        correlationId = originalCorrelationId;
        const existing = projectBoard(existingEvents);
        if (!mission.continuesWork) {
          throw new Error(`Work ${work.id} already exists; an existing stream must be continued explicitly`);
        }
        if (existing.contract === null) {
          throw new Error(`continued Work ${work.id} has no canonical contract`);
        }
        if (existing.violations.length > 0) {
          throw new Error(`continued Work ${work.id} has ${existing.violations.length} canonical projection violation(s)`);
        }
        if (JSON.stringify(existing.contract) !== JSON.stringify(work)) {
          throw new Error(`continued Work ${work.id} does not match its canonical contract`);
        }
        const continuableStates: ReadonlySet<WorkState> = new Set([
          "proposed",
          "verifying",
          "unverifiable",
          "failed",
        ]);
        if (!continuableStates.has(existing.state) || existing.activeVerification !== null || existing.activeReview !== null) {
          throw new Error(`continued Work ${work.id} is not open for another attempt (state=${existing.state})`);
        }
        const attemptsUsed = Object.keys(existing.attempts).length;
        const maxAttempts = existing.contract.workerPolicy.maxAttempts;
        if (attemptsUsed >= maxAttempts) {
          throw new Error(`continued Work ${work.id} exhausted its attempt budget (${attemptsUsed}/${maxAttempts})`);
        }
        contractRevision = existing.contractRevision;
      } else if (mission.continuesWork) {
        throw new Error(`continued Work ${work.id} has no canonical contract`);
      }
      if (sourceWorkId !== undefined && sourceWorkspace === undefined) {
        throw new Error(`Crew workspace source ${sourceWorkId} is unavailable`);
      }
      workspace = CrewWorkspaceSchema.parse(await this.#workspaceProvider.acquire(CrewWorkspaceAcquireRequestSchema.parse({
        crewId: this.plan.id,
        work,
        baseRevision: this.plan.baseRevision,
        mode: mission.workspace.mode,
        ...(sourceWorkspace === undefined ? {} : { sourceWorkspace, sourceWorkId }),
      })));
      if (workspace.mode !== mission.workspace.mode) {
        throw new Error(`workspace provider returned mode ${workspace.mode}, expected ${mission.workspace.mode}`);
      }
      if (sourceWorkspace === undefined) {
        if (workspace.sourceWorkId !== undefined) {
          throw new Error("fresh Crew workspace unexpectedly claims an inherited source");
        }
        if ([...workspaces.values()].some((active) => active.workspaceId === workspace!.workspaceId)) {
          throw new Error(`fresh Crew workspace identity ${workspace.workspaceId} is already active`);
        }
      } else {
        if (workspace.workspaceId !== sourceWorkspace.workspaceId) {
          throw new Error("inherited Crew workspace must preserve the source workspace identity");
        }
        if (workspace.sourceWorkId !== sourceWorkId) {
          throw new Error("inherited Crew workspace did not preserve the source Work identity");
        }
      }
      workspaces.set(work.id, workspace);
      before = CrewWorkspaceSnapshotSchema.parse(await this.#workspaceProvider.snapshot(workspace));

      const directDependencyReceipts = work.dependencies
        .map((dependency) => receipts.get(dependency))
        .filter((receipt): receipt is CrewMissionReceipt => receipt !== undefined);
      const missionContext = renderCrewMissionContext(
        work,
        directDependencyReceipts,
        mission.priorAttemptEvidence,
      );
      // A repair attempt joins a Work that is already open on this stream.
      // Re-declaring the contract would be a `duplicate-work-created`
      // violation, so the continuation says so explicitly rather than
      // letting the projection discover a second Work.
      if (!mission.continuesWork) {
        await append("work.created", { contract: work, revision: 1 });
      }
      await append(
        "task.created",
        { objective: missionContext.objective, attachmentIds: missionContext.taintedAttachments.map((a) => a.id) },
        { taskId },
      );

      // Context wiring: when a bridge is configured, compose a ContextPack
      // for this mission and persist the selection. The pack's identity
      // travels with the worker (the bridge returns it; we record the
      // event so replays can reconstruct what was selected).
      const contextPack = this.#context === undefined
        ? undefined
        : await this.#context.select({
          work,
          taskId,
          attemptId,
          streamId,
          actor: this.#actor,
        });

      const dependencyWorkerIds = work.type === "REVIEW"
        ? work.dependencies
          .map((dependency) => receipts.get(dependency)?.workerProviderId)
          .filter((value): value is string => value !== undefined)
        : [];
      // "host-policy" means the provider will not say what it can write.
      // Unknown authority is denied authority, for every mission type.
      const allowedWriteAccess = work.type === "SHIP"
        ? ["workspace"] as const
        : ["none"] as const;
      const requirements = WorkerSelectionRequirementsSchema.parse({
        requiredCapabilities: mission.requiredCapabilities,
        excludedProviders: dependencyWorkerIds,
        allowDangerous: mission.allowDangerousWorker,
        allowedWriteAccess,
        requireWorkspaceBinding: true,
        // A write-capable worker must hand every Rhiz-brokered native tool call
        // to Guard before its product effects it. Providers without that
        // synchronous return channel are refused, not prompted (#40).
        requireGuardedToolMediation: mission.workspace.mode === "isolated-write",
        // A write-enabled attempt is only reachable through a host that
        // imposes OS containment; prompt text is not a write boundary (#11).
        requireSandboxCapableHost: mission.workspace.mode === "isolated-write",
        explicitProviderAuthorizations: work.workerPolicy.explicitProviderAuthorizations,
      });
      // Router wiring: when present, ask the bridge for an evidence-driven
      // selection. The decision is appended as a `router.decision-made`
      // event so replays see what the route considered, not just what won.
      // The resolver still picks the actual provider — this gives the
      // contract's explicit `preferredProviders` priority over the route.
      let routerHint: string | undefined;
      if (this.#router !== undefined) {
        const decision = await this.#router.route({
          work,
          taskId,
          attemptId,
          streamId,
          actor: this.#actor,
        });
        if (decision.selected !== null && work.workerPolicy.preferredProviders.length === 0) {
          routerHint = decision.selected.workerId;
        }
      }
      resolution = await this.#workerResolver.resolve({
        registry: this.#workerCatalog,
        mission,
        workspace,
        requirements,
        ...(routerHint === undefined ? {} : { routerHint }),
      });
      const workerActor: ActorRef = { id: resolution.selection.provider.id, kind: "agent" };
      await append("task.assigned", {
        worker: workerActor,
        ...(resolution.selection.authorization === undefined
          ? {}
          : { authorization: resolution.selection.authorization }),
      }, { taskId });
      // The Attempt deadline is the Work contract's declared wall-clock
      // budget plus the moment the attempt started. If the contract names
      // none, Crew computes a default from the attempt kind so a mission
      // cannot hang forever (#16). It is computed here, once, because both
      // the lease below and the worker request further down are bounded by
      // the same instant; two calls could disagree.
      const attemptStartedAt = this.#now();
      const attemptDeadlineAt = computeAttemptDeadline(work, attemptStartedAt);
      activeAttemptDeadlineAt = attemptDeadlineAt;
      // Crew is the only actor that knows which workspace and lease this
      // attempt actually holds, so Crew is the only actor that can record
      // it. Without this the Board carries an attempt with no workspace,
      // and the Integration Controller cannot checkpoint the candidate it
      // just verified. The lease expires with the attempt: a dead worker
      // stops holding these paths.
      const leaseClaims = dedupeResourceClaims(work.writeScope);
      await append(
        "attempt.started",
        {
          worker: workerActor,
          contractRevision,
          ...(leaseClaims.length === 0 ? {} : {
            lease: {
              id: workspace.leaseId,
              workspaceId: workspace.workspaceId,
              resourceClaims: leaseClaims,
              acquiredAt: attemptStartedAt,
              expiresAt: attemptDeadlineAt,
            },
          }),
        },
        { taskId, attemptId, actor: workerActor },
      );
      attemptStarted = true;

      const binding = parseWorkspaceBinding({
        workspaceId: workspace.workspaceId,
        leaseId: workspace.leaseId,
        uri: workspace.uri,
        executionRoot: workspace.executionRoot,
        mode: workspace.mode,
        baseRevision: workspace.baseRevision,
        expectedHead: before.head,
        expectedDigest: before.digest,
      });
      let categoryAuthorityProof;
      if (workspace.mode === "isolated-write") {
        const authorityProofOutcome = await awaitDeadline(proveContractBoundCategoryAuthority({
          registry: this.#workerCatalog,
          selection: resolution.selection,
          provider: resolution.provider,
          work,
        }), attemptDeadlineAt, this.#now);
        if (authorityProofOutcome.kind === "deadline") {
          deadlineObservedAt = authorityProofOutcome.observedAt;
          workerClosed = true;
          throw new Error(`attempt deadline ${attemptDeadlineAt} exceeded during Guard authority preflight at ${deadlineObservedAt}`);
        }
        categoryAuthorityProof = authorityProofOutcome.value;
      }
      const guardPolicy = guardPolicyFromWorkContract(work, {
        contractBoundCategoryAuthority: categoryAuthorityProof?.active ?? false,
        httpEffects: [...getHttpEffectPolicyBindings(this.#httpEffects)],
      });
      const guardedToolMediation = createGuardedToolMediation({
        oracle: createDefaultPolicyOracle(guardPolicy),
        policy: guardPolicy,
        circuitBreaker: new GuardianRejectionCircuitBreaker(guardPolicy.circuitBreaker),
        workId: work.id,
        taskId,
        attemptId,
        actor: workerActor,
        writeScope: resolution.selection.descriptor.writeAccess,
        contextHash: `crew:${this.plan.id}:${work.id}:${taskId}`.slice(0, 300),
        requireRecordBeforeEffect: true,
        // The decision becomes durable evidence here, from Guard's own result,
        // before the verdict reaches the native runtime. A record derived from
        // what a provider later echoes back could misreport or omit a decision
        // that has already taken effect (#40).
        record: async (evaluation) => {
          if (attemptClosed()) return;
          await append(
            "guard.evaluated",
            evaluation,
            { taskId, attemptId, actor: workerActor },
          );
        },
      });
      const attemptGuardedToolMediation = {
        evaluate: async (call: GuardToolCall) => {
          const closedEvaluation = () => {
            const request = GuardRequestSchema.parse({
              ...GuardToolCallSchema.parse(call),
              workId: work.id,
              taskId,
              attemptId,
              actor: workerActor,
              writeScope: resolution!.selection.descriptor.writeAccess,
              contextHash: `crew:${this.plan.id}:${work.id}:${taskId}`.slice(0, 300),
              evidenceRefs: [],
              timestampMs: Date.parse(this.#now()),
            });
            return GuardEvaluationSchema.parse({
              request,
              verdict: {
                requestId: request.requestId,
                decision: "forbid",
                rationale: "Crew Attempt is closed; the tool call is refused.",
                riskLevel: "critical",
                ruleHits: ["attempt-closed"],
                policyBackend: "crew-attempt-lifecycle",
                evaluatedAt: new Date(request.timestampMs).toISOString(),
                durationMs: 0,
              },
            });
          };
          if (attemptClosed()) return closedEvaluation();
          const evaluation = await guardedToolMediation.evaluate(call);
          if (!attemptClosed()) return evaluation;
          // The provider effects a tool call only after this result returns.
          // Even a Guard evaluation already in flight at closure gets a
          // refusal at the native boundary.
          return closedEvaluation();
        },
      };
      // The Attempt deadline is the Work contract's declared wall-clock
      // budget for the attempt plus the CrewStarted time. If the contract
      // does not name one, Crew computes a sensible default from the
      // attempt kind so the mission cannot hang forever (#16). Either
      // way, the deadline is recorded in the request so the worker can
      // honor it locally as well as a hard ceiling.
      const startup = startWorkerAttempt(resolution.provider, {
        work,
        taskId,
        attemptId,
        objective: missionContext.objective,
        taintedAttachments: missionContext.taintedAttachments,
        authority: work.authority,
        context: work.context,
        contextPack,
        workspace: binding,
        attemptDeadlineAt,
      }, workspace.mode === "isolated-write" ? {
        guardedToolMediation: attemptGuardedToolMediation,
        ...(this.#httpEffects.length === 0 ? {} : {
          httpEffects: new HttpEffectBroker({
            bindings: this.#httpEffects, work, guard: attemptGuardedToolMediation,
            signal: AbortSignal.any([httpEffectsAbort.signal,
              AbortSignal.timeout(Math.max(1, Date.parse(attemptDeadlineAt) - Date.parse(this.#now())))]),
            isActive: () => !attemptClosed(),
          }).port(),
        }),
      } : {});
      // Provider capability discovery and startup are part of the same
      // Attempt budget as result production and the observation stream.
      // If startup resolves after timeout, cancel its handle without letting
      // that late completion reopen the Attempt.
      const startupOutcome = await awaitDeadline(startup, attemptDeadlineAt, this.#now);
      if (startupOutcome.kind === "deadline") {
        deadlineObservedAt = startupOutcome.observedAt;
        workerClosed = true;
        void startup.then(({ handle }) => {
          void handle.cancel(`attempt deadline ${attemptDeadlineAt} exceeded`).catch(() => {});
        }, () => {});
      } else {
        const started = startupOutcome.value;
        const collecting = (async () => {
          for await (const observation of started.handle.observe()) {
            if (attemptClosed()) return;
            observations += 1;
            // An authority report is only valid from a real enforcement seam:
            // the provider that imposed the boundary reports what it enforces
            // and what the OS refused. Crew turns that typed report into ledger
            // evidence at the moment it arrives, not after the fact (#11).
            if (observation.authority !== undefined) {
              if (attemptClosed()) return;
              await append(
                observation.authority.decision === "granted" ? "authority.granted" : "authority.denied",
                {
                  policy: work.authority,
                  reason: `${observation.authority.reason} [boundary: ${observation.authority.boundary}]`,
                },
                { taskId, attemptId, actor: workerActor },
              );
            }
            if (attemptClosed()) return;
            await append(
              "attempt.activity-observed",
              {
                state: observationState(observation),
                detail: `${observation.kind}: ${observation.detail}`.slice(0, 1000),
                source: resolution!.selection.provider.id,
                authority: "observation",
              },
              { taskId, attemptId, actor: workerActor },
            );
          }
        })();
        const lifecycle = Promise.all([started.handle.result(), collecting]);
        // Observe a rejected detached stream even if the deadline wins first.
        void collecting.catch(() => {});
        const lifecycleOutcome = await awaitDeadline(lifecycle, attemptDeadlineAt, this.#now);
        if (lifecycleOutcome.kind === "deadline") {
          deadlineObservedAt = lifecycleOutcome.observedAt;
          workerClosed = true;
          await awaitCleanupGrace(Promise.resolve().then(() => started.handle.cancel(`attempt deadline ${attemptDeadlineAt} exceeded`)));
        } else {
          [result] = lifecycleOutcome.value;
          workerClosed = true;
        }
      }
      if (deadlineObservedAt === undefined) {
        const snapshotOutcome = await awaitDeadline(
          this.#workspaceProvider.snapshot(workspace),
          attemptDeadlineAt,
          this.#now,
        );
        if (snapshotOutcome.kind === "deadline") {
          deadlineObservedAt = snapshotOutcome.observedAt;
          workerClosed = true;
        } else {
          after = CrewWorkspaceSnapshotSchema.parse(snapshotOutcome.value);
          changeViolations = workspaceChangeViolations(work, workspace, before, after);
        }
      }
      if (deadlineObservedAt !== undefined) {
        // Close the latch before publishing failure. Late Guard/observation
        // callbacks and late startup handles are now cleanup-only.
        await append(
          "attempt.failed",
          { reason: `attempt deadline ${attemptDeadlineAt} exceeded at ${deadlineObservedAt}`, recoverable: false },
          { taskId, attemptId, actor: workerActor },
          deadlineObservedAt,
        );
        terminalAttemptEvent = true;
        errorMessage = `attempt deadline ${attemptDeadlineAt} exceeded`;
        // Snapshot is useful evidence, but must not turn a bounded attempt
        // into an unbounded wait on a slow workspace provider.
        try {
          const snapshot = await awaitOptionalGrace(this.#workspaceProvider.snapshot(workspace));
          if (snapshot !== undefined) {
            after = CrewWorkspaceSnapshotSchema.parse(snapshot);
            changeViolations = workspaceChangeViolations(work, workspace, before, after);
          }
        } catch {
          // Snapshot failure remains represented by the original error.
        }
      }
      if (deadlineObservedAt === undefined && result !== undefined && result.status === "finished" && changeViolations.length === 0) {
        await append(
          "attempt.finished",
          // WorkerResult deliberately admits a fuller operator-facing summary
          // than the durable event vocabulary. Preserve the complete result
          // in the mission receipt, but bound the projection input at the
          // adapter boundary so a verbose worker cannot prevent the Attempt
          // from reaching its terminal Ledger event.
          { resultSummary: result.summary.slice(0, 2000), artifactRefs: result.artifacts },
          { taskId, attemptId, actor: workerActor },
        );
      } else if (deadlineObservedAt === undefined && result !== undefined) {
        const reason = changeViolations.length > 0
          ? changeViolations.join("; ")
          : result.summary;
        await append(
          "attempt.failed",
          { reason: reason.slice(0, 2000), recoverable: false },
          { taskId, attemptId, actor: workerActor },
        );
      }
      // When `result` is undefined (deadline-exceeded branch), the
      // attempt.failed event was already emitted with the timeout reason.
      terminalAttemptEvent = true;

      // Refiner wiring: hand the closed stream to the Refiner so it can
      // propose concrete improvements. Proposals are typed events that
      // travel through the same gate as everything else; nothing here is
      // auto-promoted.
      if (this.#refiner !== undefined) {
        const events = await this.#ledger.replay(streamId);
        const state = projectBoard(events).state;
        if (["accepted", "rejected", "cancelled", "failed"].includes(state)) {
          await this.#refiner.consume({ workId: work.id, events });
        }
      }
    } catch (error) {
      workerClosed = true;
      errorMessage = safeError(error);
      if (attemptStarted && !terminalAttemptEvent) {
        try {
          const workerActor: ActorRef = {
            id: resolution?.selection.provider.id ?? "service:crew-supervisor",
            kind: resolution === undefined ? "service" : "agent",
          };
          await append(
            "attempt.failed",
            { reason: errorMessage, recoverable: false },
            { taskId, attemptId, actor: workerActor },
          );
          terminalAttemptEvent = true;
        } catch {
          // Preserve the original execution error in the Crew receipt.
        }
      }
      if (workspace !== undefined && after === undefined) {
        try {
          let snapshot: CrewWorkspaceSnapshot | undefined;
          if (activeAttemptDeadlineAt === undefined) {
            snapshot = await awaitOptionalGrace(this.#workspaceProvider.snapshot(workspace));
          } else {
            const snapshotOutcome = await awaitDeadline(
              this.#workspaceProvider.snapshot(workspace),
              activeAttemptDeadlineAt,
              this.#now,
            );
            if (snapshotOutcome.kind === "completed") snapshot = snapshotOutcome.value;
          }
          if (snapshot !== undefined) {
            after = CrewWorkspaceSnapshotSchema.parse(snapshot);
            if (before !== undefined) changeViolations = workspaceChangeViolations(work, workspace, before, after);
          }
        } catch {
          // Snapshot failure remains represented by the original error.
        }
      }
    } finally {
      httpEffectsAbort.abort();
      if (resolution !== undefined) {
        await awaitCleanupGrace(resolution.close().catch((error) => {
          errorMessage ??= safeError(error);
        }));
      }
      releaseCrewStream();
    }

    const events = await this.#ledger.replay(streamId);
    if (events.length > 0) {
      const board = projectBoard(events);
      boardState = board.state;
      projectionViolationCount = board.violations.length;
    }

    const finished =
      result?.status === "finished"
      && changeViolations.length === 0
      && projectionViolationCount === 0
      && boardState === "verifying"
      && errorMessage === undefined;
    if (!finished && errorMessage === undefined) {
      if (projectionViolationCount > 0) errorMessage = "Crew mission produced Board projection violations";
      else if (boardState !== undefined && boardState !== "verifying") errorMessage = `Crew mission ended in Board state ${boardState}`;
      else if (result !== undefined) errorMessage = result.summary;
      else errorMessage = "Crew mission did not produce a terminal Worker result";
    }

    const receipt = CrewMissionReceiptSchema.parse({
      workId: work.id,
      workType: work.type,
      dependencyIds: work.dependencies,
      status: finished ? "execution-finished" : "failed",
      streamId,
      taskId,
      attemptId,
      ...(resolution === undefined ? {} : {
        workerProviderId: resolution.selection.provider.id,
        workerDescriptor: resolution.selection.descriptor,
        ...(resolution.selection.authorization === undefined
          ? {}
          : { authorization: resolution.selection.authorization }),
        selectionRejections: resolution.selection.rejections,
      }),
      ...(workspace === undefined ? {} : {
        workspace: {
          leaseId: workspace.leaseId,
          workspaceId: workspace.workspaceId,
          mode: workspace.mode,
          baseRevision: workspace.baseRevision,
          ...(workspace.sourceWorkId === undefined ? {} : { sourceWorkId: workspace.sourceWorkId }),
        },
      }),
      ...(before === undefined ? {} : { workspaceBefore: before }),
      ...(after === undefined ? {} : { workspaceAfter: after }),
      changedPaths: after?.changedPaths ?? [],
      changeViolations,
      observationCount: observations,
      ...(result === undefined ? {} : { workerResult: result }),
      ...(boardState === undefined ? {} : { boardState }),
      projectionViolationCount,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    });
    return receipt;
  }
}

export function parseCrewPlan(input: unknown): CrewPlan {
  return CrewPlanSchema.parse(input);
}

export function parseCrewRunReceipt(input: unknown): CrewRunReceipt {
  return CrewRunReceiptSchema.parse(input);
}
