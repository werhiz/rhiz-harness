import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  ActorRef,
  HarnessEvent,
  RefinerProposal,
  RefinerProposalKind,
} from "./schemas.js";
import {
  ActorRefSchema,
  RefinerProposalSchema,
  TimestampSchema,
  parseHarnessEvent,
} from "./schemas.js";
import type { EventLedger } from "./ledger.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);

export const FAILURE_TAXONOMY = [
  "wrong-understanding",
  "missing-context",
  "too-much-context",
  "bad-routing",
  "worker-capability",
  "authority-error",
  "coordination-error",
  "concurrency-conflict",
  "implementation-error",
  "verification-gap",
  "false-verification",
  "runtime-failure",
  "dependency-failure",
  "environment-drift",
  "process-stall",
  "recovery-failure",
  "human-friction",
  "architecture-confusion",
  "repeated-mistake",
] as const;
export type FailureTaxonomy = typeof FAILURE_TAXONOMY[number];

export const SUCCESS_TAXONOMY = [
  "high-quality-first-attempt",
  "low-context-success",
  "cheap-model-success",
  "fast-verification",
  "successful-recovery",
  "useful-parallelization",
  "effective-rule",
  "effective-guard",
  "strong-context-selection",
  "zero-human-intervention",
  "excellent-review",
  "high-value-tool",
] as const;
export type SuccessTaxonomy = typeof SUCCESS_TAXONOMY[number];

export const RefinerClassificationSchema = z.string().refine(
  (value): value is FailureTaxonomy | SuccessTaxonomy =>
    (FAILURE_TAXONOMY as readonly string[]).includes(value) ||
    (SUCCESS_TAXONOMY as readonly string[]).includes(value),
  { message: "classification must be a member of the failure or success taxonomy" },
);

export const RefinerConfigSchema = z.object({
  minEvidenceCount: z.number().int().positive().default(2),
  minLedgerSpanMs: z.number().int().nonnegative().default(0),
  requireReversibleUntil: z.boolean().default(true),
  forbidWorkerSelfCertification: z.boolean().default(true),
  forbidAuthorityWeakening: z.boolean().default(true),
  forbidRoutingOptimization: z.boolean().default(true),
  forbidBenchmarkAcceptanceWeakening: z.boolean().default(true),
  forbidConstitutionAmendments: z.boolean().default(true),
  forbidWorkerAcceptOwnProposal: z.boolean().default(true),
  requireReviewerEndorsement: z.boolean().default(true),
  allowedKinds: z.array(z.string()).default([]),
}).strict();
export type RefinerConfig = z.infer<typeof RefinerConfigSchema>;

export const DEFAULT_REFINER_CONFIG: RefinerConfig = Object.freeze({
  minEvidenceCount: 2,
  minLedgerSpanMs: 0,
  requireReversibleUntil: true,
  forbidWorkerSelfCertification: true,
  forbidAuthorityWeakening: true,
  forbidRoutingOptimization: true,
  forbidBenchmarkAcceptanceWeakening: true,
  forbidConstitutionAmendments: true,
  forbidWorkerAcceptOwnProposal: true,
  requireReviewerEndorsement: true,
  allowedKinds: [],
});

export const RefinerProposalReviewSchema = z.object({
  proposalId: id,
  reviewer: ActorRefSchema,
  decision: z.enum(["endorse", "object", "request-changes"]),
  reason: text.max(2000),
  reviewedAt: TimestampSchema,
}).strict();
export type RefinerProposalReview = z.infer<typeof RefinerProposalReviewSchema>;

export const RefinerAnalysisSchema = z.object({
  workId: id,
  outcome: z.enum(["accepted", "rejected", "cancelled", "failed"]),
  classifications: z.array(RefinerClassificationSchema),
  candidateProposalKinds: z.array(z.string()),
  ledgerEventCount: z.number().int().nonnegative(),
  ledgerSpanMs: z.number().int().nonnegative(),
}).strict();
export type RefinerAnalysis = z.infer<typeof RefinerAnalysisSchema>;

export class RefinerError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "RefinerError";
  }
}

export class RefinerGuardViolationError extends RefinerError {
  constructor(message: string, readonly guard: RefinerGuard) {
    super(message, "REFINER_GUARD_VIOLATION");
    this.name = "RefinerGuardViolationError";
  }
}

export class RefinerConfigurationError extends RefinerError {
  constructor(message: string) {
    super(message, "REFINER_CONFIGURATION_ERROR");
    this.name = "RefinerConfigurationError";
  }
}

export class RefinerLifecycleError extends RefinerError {
  constructor(message: string) {
    super(message, "REFINER_LIFECYCLE_ERROR");
    this.name = "RefinerLifecycleError";
  }
}

export const RefinerGuard = Object.freeze({
  proposalHasEvidence: "proposalHasEvidence",
  proposalIsReversible: "proposalIsReversible",
  proposalNotFromOneEvent: "proposalNotFromOneEvent",
  proposalDoesNotWeakenAuthority: "proposalDoesNotWeakenAuthority",
  proposalNotRoutingOptimization: "proposalNotRoutingOptimization",
  proposalNotBenchmarkWeakening: "proposalNotBenchmarkWeakening",
  proposalNotConstitutionAmendment: "proposalNotConstitutionAmendment",
  proposalNotWorkerSelfCertification: "proposalNotWorkerSelfCertification",
  reviewerNotProposer: "reviewerNotProposer",
  promotionRequiresAcceptance: "promotionRequiresAcceptance",
  promotionRequiresReviewerEndorsement: "promotionRequiresReviewerEndorsement",
  transitionAllowed: "transitionAllowed",
  statusIsProposed: "statusIsProposed",
  statusIsAccepted: "statusIsAccepted",
} as const);
export type RefinerGuard = typeof RefinerGuard[keyof typeof RefinerGuard];

export function isFailureClassification(value: string): value is FailureTaxonomy {
  return (FAILURE_TAXONOMY as readonly string[]).includes(value);
}

export function isSuccessClassification(value: string): value is SuccessTaxonomy {
  return (SUCCESS_TAXONOMY as readonly string[]).includes(value);
}

export function assertRefinerProposal(
  value: unknown,
  config: RefinerConfig = DEFAULT_REFINER_CONFIG,
): asserts value is RefinerProposal {
  const parsed = RefinerProposalSchema.safeParse(value);
  if (!parsed.success) {
    throw new RefinerConfigurationError(`RefinerProposal validation failed: ${parsed.error.message}`);
  }
  runProposalGuards(parsed.data, config);
}

export function runProposalGuards(proposal: RefinerProposal, config: RefinerConfig = DEFAULT_REFINER_CONFIG): void {
  if (config.forbidConstitutionAmendments && proposal.draft.draftPayload["amendsConstitution"] === true) {
    throw new RefinerGuardViolationError(
      `proposal ${proposal.id} attempts to amend the Constitution; forbidden by §22`,
      RefinerGuard.proposalNotConstitutionAmendment,
    );
  }
  if (config.forbidAuthorityWeakening && proposal.draft.draftPayload["weakensAuthority"] === true) {
    throw new RefinerGuardViolationError(
      `proposal ${proposal.id} would weaken Authority boundaries; forbidden by §22`,
      RefinerGuard.proposalDoesNotWeakenAuthority,
    );
  }
  if (config.forbidRoutingOptimization && proposal.draft.draftPayload["optimizesRoutingAcrossIncomparableTasks"] === true) {
    throw new RefinerGuardViolationError(
      `proposal ${proposal.id} would optimize routing across incomparable tasks; forbidden by §22`,
      RefinerGuard.proposalNotRoutingOptimization,
    );
  }
  if (config.forbidBenchmarkAcceptanceWeakening && proposal.draft.draftPayload["weakensAcceptanceCriteria"] === true) {
    throw new RefinerGuardViolationError(
      `proposal ${proposal.id} would weaken acceptance criteria; forbidden by §22`,
      RefinerGuard.proposalNotBenchmarkWeakening,
    );
  }
  if (config.forbidWorkerSelfCertification && proposal.draft.draftPayload["proposedBySameActorAsExecution"] === true) {
    throw new RefinerGuardViolationError(
      `proposal ${proposal.id} is a worker self-certification; forbidden by §22`,
      RefinerGuard.proposalNotWorkerSelfCertification,
    );
  }
  if (proposal.evidenceRefs.length < config.minEvidenceCount) {
    throw new RefinerGuardViolationError(
      `proposal ${proposal.id} has ${proposal.evidenceRefs.length} evidence refs; required >= ${config.minEvidenceCount}`,
      RefinerGuard.proposalHasEvidence,
    );
  }
  if (config.requireReversibleUntil) {
    const parsed = Date.parse(proposal.draft.reversibleUntil);
    if (Number.isNaN(parsed)) {
      throw new RefinerGuardViolationError(
        `proposal ${proposal.id} has unparsable reversibleUntil; required by §22`,
        RefinerGuard.proposalIsReversible,
      );
    }
    if (parsed <= Date.now()) {
      throw new RefinerGuardViolationError(
        `proposal ${proposal.id} has reversibleUntil=${proposal.draft.reversibleUntil} which is not in the future; required by §22`,
        RefinerGuard.proposalIsReversible,
      );
    }
  }
  if (config.allowedKinds.length > 0 && !config.allowedKinds.includes(proposal.kind)) {
    throw new RefinerGuardViolationError(
      `proposal ${proposal.id} kind=${proposal.kind} is not in the allowed kinds list`,
      RefinerGuard.proposalHasEvidence,
    );
  }
}

export async function analyzeClosedWork(
  workId: string,
  ledger: EventLedger,
  config: RefinerConfig = DEFAULT_REFINER_CONFIG,
): Promise<RefinerAnalysis> {
  const events: HarnessEvent[] = [];
  for await (const event of ledger.read(streamIdForWork(workId))) {
    events.push(event);
  }
  return analyzeClosedWorkFromEvents(workId, events, config);
}

export function streamIdForWork(workId: string): string {
  const direct = `stream:${workId}`;
  if (direct.length <= 200) return direct;
  const digest = createHash("sha256").update(workId).digest("hex");
  return `stream:${workId.slice(0, 120)}:${digest}`;
}

export function analyzeClosedWorkFromEvents(
  workId: string,
  events: readonly HarnessEvent[],
  _config: RefinerConfig = DEFAULT_REFINER_CONFIG,
): RefinerAnalysis {
  const workEvents = events.filter((event) => event.workId === workId);
  const accepted = workEvents.find((event) => event.type === "work.accepted");
  const rejected = workEvents.find((event) => event.type === "work.rejected");
  const cancelled = workEvents.find((event) => event.type === "work.cancelled");
  const failed = workEvents.find((event) => event.type === "attempt.failed");
  const outcome: RefinerAnalysis["outcome"] = accepted
    ? "accepted"
    : rejected
      ? "rejected"
      : cancelled
        ? "cancelled"
        : failed
          ? "failed"
          : "rejected";

  const classifications: (FailureTaxonomy | SuccessTaxonomy)[] = [];
  if (outcome === "accepted") {
    classifications.push("high-quality-first-attempt");
  } else {
    if (workEvents.some((event) => event.type === "attempt.failed")) {
      classifications.push("runtime-failure");
    }
    if (workEvents.some((event) => event.type === "attempt.blocked")) {
      classifications.push("process-stall");
    }
    if (workEvents.some((event) => event.type === "verification.result" && event.payload.status === "fail")) {
      classifications.push("verification-gap");
    }
    if (workEvents.some((event) => event.type === "authority.denied")) {
      classifications.push("authority-error");
    }
  }

  const candidateProposalKinds: string[] = [];
  if (classifications.includes("repeated-mistake")) {
    candidateProposalKinds.push("rule", "test");
  }
  if (classifications.includes("verification-gap")) {
    candidateProposalKinds.push("verifier", "test");
  }
  if (classifications.includes("authority-error")) {
    candidateProposalKinds.push("guard-tuning", "rule");
  }
  if (classifications.includes("process-stall")) {
    candidateProposalKinds.push("recovery-behavior", "worker-profile");
  }
  if (classifications.includes("runtime-failure")) {
    candidateProposalKinds.push("worker-profile", "recovery-behavior");
  }
  if (classifications.includes("low-context-success") || classifications.includes("strong-context-selection")) {
    candidateProposalKinds.push("context-strategy");
  }

  const spanMs = computeLedgerSpanMs(workEvents);
  return {
    workId,
    outcome,
    classifications,
    candidateProposalKinds,
    ledgerEventCount: workEvents.length,
    ledgerSpanMs: spanMs,
  };
}

export function computeLedgerSpanMs(events: readonly HarnessEvent[]): number {
  if (events.length === 0) return 0;
  const first = Date.parse(events[0]!.occurredAt);
  const last = Date.parse(events[events.length - 1]!.occurredAt);
  if (Number.isNaN(first) || Number.isNaN(last)) return 0;
  return Math.max(0, last - first);
}

export function makeRefinerProposal(input: {
  id: string;
  workId: string;
  kind: RefinerProposalKind;
  title: string;
  summary: string;
  reasoning: string;
  classification: FailureTaxonomy | SuccessTaxonomy;
  evidenceRefs: ReadonlyArray<{ ledgerEventId: string; reasoning: string }>;
  draft: { summary: string; rationale: string; reversibleUntil: string; draftPayload?: Record<string, unknown> };
  proposedBy: ActorRef;
  proposedAt: string;
  supersedes?: string[];
}, config: RefinerConfig = DEFAULT_REFINER_CONFIG): RefinerProposal {
  const candidate = RefinerProposalSchema.parse({
    id: input.id,
    workId: input.workId,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    reasoning: input.reasoning,
    classification: input.classification,
    evidenceRefs: input.evidenceRefs,
    draft: input.draft,
    status: "proposed",
    proposedBy: input.proposedBy,
    proposedAt: input.proposedAt,
    supersedes: input.supersedes ?? [],
  });
  runProposalGuards(candidate, config);
  return candidate;
}

export function buildProposedEvent(
  proposal: RefinerProposal,
  ledgerEventId: string,
  streamId: string,
  occurredAt: string,
  recordedAt: string,
): HarnessEvent {
  return parseHarnessEvent({
    id: ledgerEventId,
    schemaVersion: 1,
    type: "refiner.proposed",
    streamId,
    workId: proposal.workId,
    actor: proposal.proposedBy,
    occurredAt,
    recordedAt,
    evidence: [],
    payload: { proposal },
  });
}

export function buildAcceptedEvent(
  proposalId: string,
  workId: string,
  acceptedBy: ActorRef,
  rationale: string,
  ledgerEventId: string,
  streamId: string,
  occurredAt: string,
  recordedAt: string,
): HarnessEvent {
  return parseHarnessEvent({
    id: ledgerEventId,
    schemaVersion: 1,
    type: "refiner.accepted",
    streamId,
    workId,
    actor: acceptedBy,
    occurredAt,
    recordedAt,
    evidence: [],
    payload: { proposalId, workId, acceptedBy, rationale },
  });
}

export function buildRejectedEvent(
  proposalId: string,
  workId: string,
  rejectedBy: ActorRef,
  rationale: string,
  ledgerEventId: string,
  streamId: string,
  occurredAt: string,
  recordedAt: string,
): HarnessEvent {
  return parseHarnessEvent({
    id: ledgerEventId,
    schemaVersion: 1,
    type: "refiner.rejected",
    streamId,
    workId,
    actor: rejectedBy,
    occurredAt,
    recordedAt,
    evidence: [],
    payload: { proposalId, workId, rejectedBy, rationale },
  });
}

export function buildPromotedEvent(
  proposalId: string,
  workId: string,
  promotedBy: ActorRef,
  appliedSurface: string,
  irreversible: boolean,
  ledgerEventId: string,
  streamId: string,
  occurredAt: string,
  recordedAt: string,
): HarnessEvent {
  return parseHarnessEvent({
    id: ledgerEventId,
    schemaVersion: 1,
    type: "refiner.promoted",
    streamId,
    workId,
    actor: promotedBy,
    occurredAt,
    recordedAt,
    evidence: [],
    payload: { proposalId, workId, promotedBy, appliedSurface, irreversible },
  });
}

export async function recordProposal(
  proposal: RefinerProposal,
  ledger: EventLedger,
  ledgerEventId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<HarnessEvent> {
  const event = buildProposedEvent(proposal, ledgerEventId, streamIdForWork(proposal.workId), now(), now());
  await ledger.append(event);
  return event;
}

export async function acceptProposal(
  proposalId: string,
  workId: string,
  acceptedBy: ActorRef,
  rationale: string,
  ledger: EventLedger,
  ledgerEventId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<HarnessEvent> {
  if (!proposalId || !workId || !ledgerEventId) {
    throw new RefinerLifecycleError("acceptProposal requires non-empty proposalId, workId, and ledgerEventId");
  }
  if (acceptedBy.kind === "agent" && rationale === "") {
    throw new RefinerGuardViolationError(
      "agent accept must carry a rationale",
      RefinerGuard.reviewerNotProposer,
    );
  }
  const event = buildAcceptedEvent(proposalId, workId, acceptedBy, rationale, ledgerEventId, streamIdForWork(workId), now(), now());
  await ledger.append(event);
  return event;
}

export async function rejectProposal(
  proposalId: string,
  workId: string,
  rejectedBy: ActorRef,
  rationale: string,
  ledger: EventLedger,
  ledgerEventId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<HarnessEvent> {
  if (!proposalId || !workId || !ledgerEventId) {
    throw new RefinerLifecycleError("rejectProposal requires non-empty proposalId, workId, and ledgerEventId");
  }
  const event = buildRejectedEvent(proposalId, workId, rejectedBy, rationale, ledgerEventId, streamIdForWork(workId), now(), now());
  await ledger.append(event);
  return event;
}

export async function promoteProposal(
  proposalId: string,
  workId: string,
  promotedBy: ActorRef,
  appliedSurface: string,
  irreversible: boolean,
  ledger: EventLedger,
  ledgerEventId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<HarnessEvent> {
  if (!proposalId || !workId || !appliedSurface || !ledgerEventId) {
    throw new RefinerLifecycleError("promoteProposal requires non-empty proposalId, workId, appliedSurface, and ledgerEventId");
  }
  if (promotedBy.kind === "agent") {
    throw new RefinerGuardViolationError(
      "promotion must be initiated by a human or verifier, not an agent",
      RefinerGuard.promotionRequiresAcceptance,
    );
  }
  const event = buildPromotedEvent(proposalId, workId, promotedBy, appliedSurface, irreversible, ledgerEventId, streamIdForWork(workId), now(), now());
  await ledger.append(event);
  return event;
}

export async function findProposalInLedger(
  proposalId: string,
  ledger: EventLedger,
  workId: string,
): Promise<RefinerProposal | null> {
  for await (const event of ledger.read(streamIdForWork(workId))) {
    if (event.type === "refiner.proposed" && event.payload.proposal.id === proposalId) {
      return event.payload.proposal;
    }
  }
  return null;
}

export function parseRefinerProposal(input: unknown): RefinerProposal {
  return RefinerProposalSchema.parse(input);
}

export function parseRefinerConfig(input: unknown): RefinerConfig {
  return RefinerConfigSchema.parse(input);
}

export function parseRefinerAnalysis(input: unknown): RefinerAnalysis {
  return RefinerAnalysisSchema.parse(input);
}

export function parseRefinerProposalReview(input: unknown): RefinerProposalReview {
  return RefinerProposalReviewSchema.parse(input);
}

export function assertRefinerAnalysis(value: unknown): asserts value is RefinerAnalysis {
  const parsed = RefinerAnalysisSchema.safeParse(value);
  if (!parsed.success) {
    throw new RefinerConfigurationError(`RefinerAnalysis validation failed: ${parsed.error.message}`);
  }
}

export function listAllowedKinds(): readonly RefinerProposalKind[] {
  const allowed: RefinerProposalKind[] = [
    "rule",
    "guard-tuning",
    "test",
    "verifier",
    "context-strategy",
    "routing-policy",
    "worker-profile",
    "tool",
    "capability",
    "documentation",
    "benchmark",
    "adr",
    "recovery-behavior",
    "lesson-fixture",
  ];
  return allowed;
}
