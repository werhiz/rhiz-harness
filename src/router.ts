import { createHash } from "node:crypto";
import { acceptanceReadiness, emptyBoard, executionActorIds, projectEvent } from "./board.js";
import type { EventLedger } from "./ledger.js";
import type { HarnessEvent, WorkContract } from "./schemas.js";
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const id = nonEmpty.max(200);
const text = nonEmpty;
const datetime = z.iso.datetime({ offset: true });

export const RouterWorkerRoleSchema = z.enum([
  "general",
  "scout",
  "shipper",
  "reviewer",
  "specialist",
]);
export type RouterWorkerRole = z.infer<typeof RouterWorkerRoleSchema>;

export const RouterWorkerDescriptorSchema = z.object({
  workerId: id,
  role: RouterWorkerRoleSchema,
  displayName: text.max(200),
  model: text.max(200),
  supportedWorkTypes: z.array(z.enum(["SCOUT", "SHIP", "REVIEW"])).min(1),
  languages: z.array(z.string().trim().min(1).max(50)).default([]),
  maxContextTokens: z.number().int().positive(),
  costPer1kTokensUsd: z.number().nonnegative(),
  avgLatencyMs: z.number().int().nonnegative(),
  region: z.string().trim().min(1).max(50).optional(),
  capabilityTags: z.array(z.string().trim().min(1).max(50)).default([]),
  notes: text.max(1000).optional(),
  weight: z.number().positive().default(1),
}).strict();
export type RouterWorkerDescriptor = z.infer<typeof RouterWorkerDescriptorSchema>;

export const DEFAULT_ROUTER_POLICY = Object.freeze({
  kind: "balanced" as const,
  weights: Object.freeze({
    successRate: 0.4,
    costInverse: 0.3,
    durationInverse: 0.3,
    confidence: 0.0,
  }),
});

export const RouterPolicyWeightsSchema = z.object({
  successRate: z.number().min(0).max(1).default(0.4),
  costInverse: z.number().min(0).max(1).default(0.3),
  durationInverse: z.number().min(0).max(1).default(0.3),
  confidence: z.number().min(0).max(1).default(0.0),
}).strict().superRefine((value, ctx) => {
  const sum = value.successRate + value.costInverse + value.durationInverse + value.confidence;
  if (sum === 0) {
    ctx.addIssue({ code: "custom", path: ["weights"], message: "balanced policy weights must sum to a positive value" });
  }
});

const BalancedPolicySchema = z.object({
  kind: z.literal("balanced"),
  weights: RouterPolicyWeightsSchema.optional().default({ ...DEFAULT_ROUTER_POLICY.weights }),
}).strict();

export const RouterPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cheapest-capable") }).strict(),
  z.object({ kind: z.literal("fastest-capable") }).strict(),
  z.object({ kind: z.literal("highest-confidence") }).strict(),
  BalancedPolicySchema,
]).default(() => BalancedPolicySchema.parse({ kind: "balanced" }));
export type RouterPolicy = z.infer<typeof RouterPolicySchema>;
export type RouterPolicyInput = z.input<typeof RouterPolicySchema>;

export const RouterEvidenceSchema = z.object({
  workerId: id,
  attemptCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1).nullable(),
  medianCostUsd: z.number().nonnegative().nullable(),
  p95CostUsd: z.number().nonnegative().nullable(),
  medianDurationMs: z.number().int().nonnegative().nullable(),
  p95DurationMs: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  lastSeenAt: datetime.nullable(),
}).strict();
export type RouterEvidence = z.infer<typeof RouterEvidenceSchema>;

export const RouterDecisionRationaleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("selected"),
    workerId: id,
    reason: text.max(1000),
    score: z.number(),
    policyKind: z.enum(["cheapest-capable", "fastest-capable", "highest-confidence", "balanced"]),
  }).strict(),
  z.object({
    kind: z.literal("no-capable-worker"),
    reason: text.max(1000),
    considered: z.array(id),
  }).strict(),
  z.object({
    kind: z.literal("no-evidence"),
    workerId: id,
    reason: text.max(1000),
    attemptCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("policy-denied"),
    reason: text.max(1000),
  }).strict(),
]);
export type RouterDecisionRationale = z.infer<typeof RouterDecisionRationaleSchema>;

export const RouterConsideredSchema = z.object({
  workerId: id,
  descriptor: RouterWorkerDescriptorSchema,
  evidence: RouterEvidenceSchema.nullable(),
  score: z.number().nullable(),
  matched: z.boolean(),
  excludedReason: text.max(500).nullable(),
}).strict();
export type RouterConsidered = z.infer<typeof RouterConsideredSchema>;

export const RouterDecisionSchema = z.object({
  id: id,
  workId: id,
  taskId: id.optional(),
  attemptId: id.optional(),
  policy: RouterPolicySchema,
  considered: z.array(RouterConsideredSchema),
  selected: RouterConsideredSchema.nullable(),
  rationale: RouterDecisionRationaleSchema,
  evidenceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedCostUsd: z.number().nonnegative(),
  expectedDurationMs: z.number().int().nonnegative(),
  decidedAt: datetime,
}).strict().superRefine((value, ctx) => {
  const matchedCount = value.considered.filter((entry) => entry.matched).length;
  const consideredIds = new Set(value.considered.map((entry) => entry.workerId));
  if (consideredIds.size !== value.considered.length) {
    ctx.addIssue({ code: "custom", path: ["considered"], message: "considered worker ids must be unique" });
  }
  if (value.selected) {
    if (!consideredIds.has(value.selected.workerId)) {
      ctx.addIssue({ code: "custom", path: ["selected"], message: "selected worker must appear in considered" });
    }
    if (value.rationale.kind !== "selected") {
      ctx.addIssue({ code: "custom", path: ["rationale"], message: "selected worker requires 'selected' rationale" });
    }
    if (value.rationale.kind === "selected" && value.rationale.workerId !== value.selected.workerId) {
      ctx.addIssue({
        code: "custom",
        path: ["rationale", "workerId"],
        message: "rationale workerId must match selected workerId",
      });
    }
  } else {
    if (value.rationale.kind === "selected") {
      ctx.addIssue({ code: "custom", path: ["selected"], message: "selected rationale requires non-null selected worker" });
    }
    if (matchedCount > 0 && value.rationale.kind === "no-capable-worker") {
      ctx.addIssue({
        code: "custom",
        path: ["rationale"],
        message: "no-capable-worker rationale is invalid when at least one worker matched",
      });
    }
  }
});
export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

export const RouterDecisionPayloadSchema = z.object({
  decisionId: id,
  policy: z.enum(["cheapest-capable", "fastest-capable", "highest-confidence", "balanced"]),
  selectedWorkerId: id.nullable(),
  consideredCount: z.number().int().nonnegative(),
  evidenceHash: id,
  expectedCostUsd: z.number().nonnegative(),
  expectedDurationMs: z.number().int().nonnegative(),
}).strict();
export type RouterDecisionPayload = z.infer<typeof RouterDecisionPayloadSchema>;

export const RouterRouteOptionsSchema = z.object({
  excludeProviders: z.array(id).default([]),
  streamIds: z.array(id).default([]),
  maxEventsPerStream: z.number().int().positive().max(10_000).default(500),
  expectedTokens: z.number().int().positive().default(8_000),
}).strict();
export type RouterRouteOptionsInput = z.input<typeof RouterRouteOptionsSchema>;
export type RouterRouteOptions = z.infer<typeof RouterRouteOptionsSchema>;

export const RouterWorkerFilterSchema = z.object({
  workType: z.enum(["SCOUT", "SHIP", "REVIEW"]).optional(),
  language: z.string().trim().min(1).max(50).optional(),
  minContextTokens: z.number().int().positive().optional(),
  role: RouterWorkerRoleSchema.optional(),
}).strict();
export type RouterWorkerFilter = z.infer<typeof RouterWorkerFilterSchema>;

export interface RouterWorkerRegistry {
  list(): readonly RouterWorkerDescriptor[];
  get(workerId: string): RouterWorkerDescriptor | undefined;
  query(filter: RouterWorkerFilter): readonly RouterWorkerDescriptor[];
}

export class InMemoryRouterWorkerRegistry implements RouterWorkerRegistry {
  readonly #workers: Map<string, RouterWorkerDescriptor>;

  constructor(workers: readonly RouterWorkerDescriptor[] = []) {
    this.#workers = new Map();
    for (const worker of workers) this.register(worker);
  }

  register(worker: RouterWorkerDescriptor): void {
    const parsed = RouterWorkerDescriptorSchema.parse(worker);
    if (this.#workers.has(parsed.workerId)) {
      throw new DuplicateRouterWorkerError(parsed.workerId);
    }
    this.#workers.set(parsed.workerId, parsed);
  }

  list(): readonly RouterWorkerDescriptor[] {
    return [...this.#workers.values()].sort((left, right) => left.workerId.localeCompare(right.workerId));
  }

  get(workerId: string): RouterWorkerDescriptor | undefined {
    return this.#workers.get(workerId);
  }

  query(filter: RouterWorkerFilter): readonly RouterWorkerDescriptor[] {
    const parsed = RouterWorkerFilterSchema.parse(filter);
    return this.list().filter((worker) => {
      if (parsed.workType && !worker.supportedWorkTypes.includes(parsed.workType)) return false;
      if (parsed.role && worker.role !== parsed.role) return false;
      if (parsed.language && worker.languages.length > 0 && !worker.languages.includes(parsed.language)) return false;
      if (parsed.minContextTokens !== undefined && worker.maxContextTokens < parsed.minContextTokens) return false;
      return true;
    });
  }
}

export class DuplicateRouterWorkerError extends Error {
  readonly code = "rhiz/router/duplicate-worker" as const;
  constructor(readonly workerId: string) {
    super(`worker ${workerId} is already registered in the router registry`);
    this.name = "DuplicateRouterWorkerError";
  }
}

export class RouterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RouterError";
  }
}

export class RouterConfigurationError extends RouterError {
  constructor(message: string) {
    super("rhiz/router/configuration-error", message);
    this.name = "RouterConfigurationError";
  }
}

export class RouterPolicyDeniedError extends RouterError {
  constructor(reason: string) {
    super("rhiz/router/policy-denied", reason);
    this.name = "RouterPolicyDeniedError";
  }
}

interface WorkerOutcomeBucket {
  attempts: number;
  successes: number;
  failures: number;
  durations: number[];
  costs: number[];
  confidenceSignals: number[];
  lastSeenAt: string | null;
}

const emptyBucket = (): WorkerOutcomeBucket => ({
  attempts: 0,
  successes: 0,
  failures: 0,
  durations: [],
  costs: [],
  confidenceSignals: [],
  lastSeenAt: null,
});

function safeMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return sorted[middle]!;
}

function safePercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[rank]!;
}

function elapsedMs(startedAt: string, endedAt: string): number | null {
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
  // Source clocks can disagree; ingestion delay is never execution duration.
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
}

function observeTime(bucket: WorkerOutcomeBucket, occurredAt: string): void {
  if (bucket.lastSeenAt === null || Date.parse(occurredAt) > Date.parse(bucket.lastSeenAt)) {
    bucket.lastSeenAt = occurredAt;
  }
}

function evidenceFromBucket(workerId: string, bucket: WorkerOutcomeBucket): RouterEvidence {
  const successRate = bucket.attempts === 0 ? null : bucket.successes / bucket.attempts;
  const confidence = bucket.confidenceSignals.length === 0
    ? null
    : bucket.confidenceSignals.reduce((sum, value) => sum + value, 0) / bucket.confidenceSignals.length;
  return {
    workerId,
    attemptCount: bucket.attempts,
    successCount: bucket.successes,
    failedCount: bucket.failures,
    successRate,
    medianCostUsd: bucket.costs.length === 0 ? null : safeMedian(bucket.costs),
    p95CostUsd: bucket.costs.length === 0 ? null : safePercentile(bucket.costs, 0.95),
    medianDurationMs: bucket.durations.length === 0 ? null : Math.round(safeMedian(bucket.durations)!),
    p95DurationMs: bucket.durations.length === 0 ? null : safePercentile(bucket.durations, 0.95),
    confidence,
    lastSeenAt: bucket.lastSeenAt,
  };
}

async function collectEvents(
  ledger: EventLedger,
  streamIds: readonly string[],
  maxEventsPerStream: number,
): Promise<HarnessEvent[]> {
  const collected: HarnessEvent[] = [];
  for (const streamId of new Set(streamIds)) {
    let count = 0;
    for await (const event of ledger.read(streamId)) {
      // Board needs the contract, authorship and lifecycle context as well as
      // outcome events. A bounded prefix may be unresolved, never assumed done.
      collected.push(event);
      count += 1;
      if (count >= maxEventsPerStream) break;
    }
  }
  return collected;
}

function deriveEvidenceFromEvents(
  events: readonly HarnessEvent[],
  workerIds: readonly string[] | undefined,
): readonly RouterEvidence[] {
  const buckets = new Map<string, WorkerOutcomeBucket>();
  const allowed = workerIds === undefined ? null : new Set(workerIds);
  const works = new Map<string, {
    events: HarnessEvent[];
    streamIds: Set<string>;
    eventBodies: Map<string, string>;
    conflictingEventIds: Set<string>;
  }>();
  for (const event of events) {
    const work = works.get(event.workId) ?? {
      events: [],
      streamIds: new Set<string>(),
      eventBodies: new Map<string, string>(),
      conflictingEventIds: new Set<string>(),
    };
    work.streamIds.add(event.streamId);
    const body = JSON.stringify(event);
    const previousBody = work.eventBodies.get(event.id);
    if (previousBody === undefined) {
      work.eventBodies.set(event.id, body);
      work.events.push(event);
    } else if (previousBody !== body) {
      work.conflictingEventIds.add(event.id);
    }
    works.set(event.workId, work);
  }

  for (const work of works.values()) {
    // Work has one canonical event stream. If callers supply multiple streams
    // for the same Work, their histories may be partial or conflicting; do
    // not stitch them together or let duplicate stream views earn credit.
    if (work.streamIds.size !== 1 || work.conflictingEventIds.size > 0) continue;
    let board = emptyBoard();
    const admitted: HarnessEvent[] = [];
    for (const event of work.events) {
      const next = projectEvent(board, event);
      if (next.violations.length === board.violations.length) admitted.push(event);
      board = next;
    }

    // Board alone decides acceptance. Learning additionally requires actual
    // independent verification, even if a Work policy permits self-checks or
    // acceptance without verification.
    const readiness = acceptanceReadiness(board);
    const proof = board.verifications.find((item) => item.eventId === readiness.verificationEventId);
    const executors = executionActorIds(board);
    const independentlyAccepted = board.state === "accepted"
      && readiness.ready
      && proof !== undefined
      && proof.contractRevision === board.contractRevision
      && proof.status === "pass"
      && !executors.has(proof.actor.id);
    const latestByTask = new Map<string, string>();
    for (const event of admitted) {
      if (event.type === "attempt.started" && event.taskId && event.attemptId) {
        latestByTask.set(event.taskId, event.attemptId);
      }
    }
    const headCheckpoint = board.integration?.headProof
      ? board.integration.checkpoints[board.integration.headProof.checkpointId]
      : undefined;

    for (const attempt of Object.values(board.attempts)) {
      const timeline = admitted.filter((event) => event.attemptId === attempt.id && event.taskId === attempt.taskId);
      const start = timeline.find((event) => event.type === "attempt.started");
      if (!start) continue;
      const terminal = timeline.find((event) => event.type === "attempt.finished" || event.type === "attempt.failed");
      const isCurrent = attempt.contractRevision === board.contractRevision
        && latestByTask.get(attempt.taskId) === attempt.id;
      const success = independentlyAccepted && isCurrent && attempt.state === "finished"
        && (headCheckpoint === undefined || headCheckpoint.attemptId === attempt.id);
      const failure = attempt.state === "failed"
        || (board.state === "rejected" && isCurrent && attempt.state === "finished");
      const duration = terminal ? elapsedMs(start.occurredAt, terminal.occurredAt) : null;

      // A handed-off Attempt is shared evidence for its unique executors. It
      // cannot establish isolated causal performance for any one participant.
      for (const workerId of new Set(attempt.executionProvenance.map((actor) => actor.id))) {
        if (allowed !== null && !allowed.has(workerId)) continue;
        const bucket = buckets.get(workerId) ?? emptyBucket();
        bucket.attempts += 1;
        if (success) bucket.successes += 1;
        if (failure) bucket.failures += 1;
        if (success || failure) bucket.confidenceSignals.push(success ? 1 : 0);
        if (duration !== null) bucket.durations.push(duration);
        // Only a provider-reported measurement is a cost. The estimate the
        // Router wrote when it chose this worker never enters evidence it
        // will later choose from.
        const usage = terminal?.type === "attempt.finished" || terminal?.type === "attempt.failed" ? terminal.payload.observedUsage : undefined;
        const observed = usage?.complete === false ? undefined : usage?.costUsd;
        if (observed !== undefined && attempt.executionProvenance.length === 1) bucket.costs.push(observed);
        for (const event of timeline) observeTime(bucket, event.occurredAt);
        if (success || failure) {
          for (const event of admitted) {
            if (event.type === "work.accepted" || event.type === "work.rejected") observeTime(bucket, event.occurredAt);
          }
        }
        buckets.set(workerId, bucket);
      }
    }
  }
  return [...buckets.entries()]
    .map(([workerId, bucket]) => evidenceFromBucket(workerId, bucket))
    .sort((left, right) => left.workerId.localeCompare(right.workerId));
}

export async function computeRouterEvidence(
  ledger: EventLedger,
  options: RouterRouteOptionsInput = {},
): Promise<readonly RouterEvidence[]> {
  const parsed = RouterRouteOptionsSchema.parse(options);
  if (parsed.streamIds.length === 0) return [];
  const events = await collectEvents(ledger, parsed.streamIds, parsed.maxEventsPerStream);
  return deriveEvidenceFromEvents(events, undefined);
}

export function computeRouterEvidenceFromEvents(
  events: readonly HarnessEvent[],
  workerIds?: readonly string[],
): readonly RouterEvidence[] {
  return deriveEvidenceFromEvents(events, workerIds);
}

function isWorkerSupported(descriptor: RouterWorkerDescriptor, contract: WorkContract): boolean {
  return descriptor.supportedWorkTypes.includes(contract.type);
}

function isExcluded(workerId: string, excludeProviders: readonly string[]): boolean {
  return excludeProviders.includes(workerId);
}

function preferredWeight(workerId: string, preferred: readonly string[]): number {
  return preferred.includes(workerId) ? 1.5 : 1.0;
}

function preferredBonus(workerId: string, preferred: readonly string[]): number {
  return preferred.includes(workerId) ? 0.1 : 0;
}

function normalizeInverse(value: number, maxValue: number): number {
  if (maxValue <= 0) return 1;
  if (value <= 0) return 1;
  if (value >= maxValue) return 0;
  return 1 - value / maxValue;
}

interface ScoreBundle {
  score: number | null;
  considered: RouterConsidered;
}

interface ScoreContext {
  registry: RouterWorkerRegistry;
  preferred: readonly string[];
  contract: WorkContract;
  options: RouterRouteOptions;
  matched: readonly RouterWorkerDescriptor[];
}

function scoreWorker(
  descriptor: RouterWorkerDescriptor,
  evidence: RouterEvidence | null,
  policy: RouterPolicy,
  context: ScoreContext,
): ScoreBundle {
  const matched = isWorkerSupported(descriptor, context.contract);
  const excluded = isExcluded(descriptor.workerId, context.options.excludeProviders);
  if (!matched || excluded) {
    return {
      score: null,
      considered: {
        workerId: descriptor.workerId,
        descriptor,
        evidence,
        score: null,
        matched: false,
        excludedReason: !matched
          ? `worker does not declare support for ${context.contract.type}`
          : `worker is excluded by router options`,
      },
    };
  }

  let score: number;
  const weight = preferredWeight(descriptor.workerId, context.preferred) * descriptor.weight;
  const bonus = preferredBonus(descriptor.workerId, context.preferred);
  const matchedDescriptors = context.matched;

  switch (policy.kind) {
    case "cheapest-capable": {
      const maxCost = matchedDescriptors.reduce((max, current) => Math.max(max, current.costPer1kTokensUsd), 0);
      score = normalizeInverse(descriptor.costPer1kTokensUsd, maxCost) * weight + bonus;
      break;
    }
    case "fastest-capable": {
      const maxLatency = matchedDescriptors.reduce((max, current) => Math.max(max, current.avgLatencyMs), 0);
      score = normalizeInverse(descriptor.avgLatencyMs, maxLatency) * weight + bonus;
      break;
    }
    case "highest-confidence": {
      const confidence = evidence?.confidence ?? null;
      score = (confidence ?? 0) * weight + bonus;
      break;
    }
    case "balanced": {
      const successRate = evidence?.successRate ?? 0.5;
      const confidence = evidence?.confidence ?? 0;
      const maxCost = matchedDescriptors.reduce((max, current) => Math.max(max, current.costPer1kTokensUsd), 0);
      const maxLatency = matchedDescriptors.reduce((max, current) => Math.max(max, current.avgLatencyMs), 0);
      const costScore = normalizeInverse(descriptor.costPer1kTokensUsd, maxCost);
      const latencyScore = normalizeInverse(descriptor.avgLatencyMs, maxLatency);
      const weights = policy.weights;
      score = (
        weights.successRate * successRate
        + weights.costInverse * costScore
        + weights.durationInverse * latencyScore
        + weights.confidence * confidence
      ) * weight + bonus;
      break;
    }
  }

  return {
    score,
    considered: {
      workerId: descriptor.workerId,
      descriptor,
      evidence,
      score,
      matched: true,
      excludedReason: null,
    },
  };
}

function pickMatchedDescriptors(registry: RouterWorkerRegistry, contract: WorkContract, options: RouterRouteOptions): readonly RouterWorkerDescriptor[] {
  return registry.list().filter((descriptor) => {
    if (!isWorkerSupported(descriptor, contract)) return false;
    if (isExcluded(descriptor.workerId, options.excludeProviders)) return false;
    return true;
  });
}

export interface RouterRouteInput {
  contract: WorkContract;
  policy?: RouterPolicyInput | RouterPolicy;
  options?: RouterRouteOptionsInput;
  evidence?: readonly RouterEvidence[];
}

export async function routeWorker(
  registry: RouterWorkerRegistry,
  ledger: EventLedger | null,
  input: RouterRouteInput,
  now: () => Date = () => new Date(),
): Promise<RouterDecision> {
  const contract = input.contract;
  const policy: RouterPolicy = input.policy !== undefined
    ? RouterPolicySchema.parse(input.policy)
    : RouterPolicySchema.parse(undefined);
  const options = RouterRouteOptionsSchema.parse(input.options ?? {});

  let evidenceList: readonly RouterEvidence[];
  if (input.evidence !== undefined) {
    evidenceList = input.evidence;
  } else if (ledger !== null) {
    evidenceList = await computeRouterEvidence(ledger, options);
  } else {
    evidenceList = [];
  }

  const evidenceMap = new Map<string, RouterEvidence>();
  for (const item of evidenceList) evidenceMap.set(item.workerId, item);

  const preferred = contract.workerPolicy.preferredProviders;
  const matchedDescriptors = pickMatchedDescriptors(registry, contract, options);
  const context: ScoreContext = { registry, preferred, contract, options, matched: matchedDescriptors };
  const scored: RouterConsidered[] = [];
  for (const descriptor of registry.list()) {
    const evidence = evidenceMap.get(descriptor.workerId) ?? null;
    const { considered } = scoreWorker(descriptor, evidence, policy, context);
    scored.push(considered);
  }

  const matchedConsidered = scored.filter((entry) => entry.matched);
  const matchedScored = matchedConsidered.filter((entry) => entry.score !== null);

  const evidenceHash = hashRouterDecisionInputs(contract, policy, options, scored);

  if (matchedConsidered.length === 0) {
    const rationale: RouterDecisionRationale = {
      kind: "no-capable-worker",
      reason: `no worker in the registry declares support for work type ${contract.type}`,
      considered: scored.map((entry) => entry.workerId),
    };
    return RouterDecisionSchema.parse({
      id: `router:${contract.id}:${evidenceHash.slice(0, 16)}`,
      workId: contract.id,
      taskId: undefined,
      attemptId: undefined,
      policy,
      considered: scored,
      selected: null,
      rationale,
      evidenceHash,
      expectedCostUsd: 0,
      expectedDurationMs: 0,
      decidedAt: now().toISOString(),
    });
  }

  const hasPositiveEvidence = matchedConsidered.some((entry) => {
    const confidence = entry.evidence?.confidence ?? null;
    return confidence !== null && confidence > 0;
  });

  if (policy.kind === "highest-confidence" && !hasPositiveEvidence) {
    const fallback = matchedConsidered[0]!;
    const rationale: RouterDecisionRationale = {
      kind: "no-evidence",
      workerId: fallback.workerId,
      reason: `no matched worker has positive confidence signals for the highest-confidence policy`,
      attemptCount: fallback.evidence?.attemptCount ?? 0,
    };
    return RouterDecisionSchema.parse({
      id: `router:${contract.id}:${evidenceHash.slice(0, 16)}`,
      workId: contract.id,
      taskId: undefined,
      attemptId: undefined,
      policy,
      considered: scored,
      selected: null,
      rationale,
      evidenceHash,
      expectedCostUsd: 0,
      expectedDurationMs: 0,
      decidedAt: now().toISOString(),
    });
  }

  const best = pickBestConsidered(matchedScored, policy);
  const selected = best.considered;
  const expectedTokens = options.expectedTokens;
  const expectedCostUsd = Number(((selected.descriptor.costPer1kTokensUsd * expectedTokens) / 1000).toFixed(6));
  const expectedDurationMs = selected.descriptor.avgLatencyMs;

  const rationale: RouterDecisionRationale = {
    kind: "selected",
    workerId: selected.workerId,
    reason: buildSelectedReason(selected, policy, contract),
    score: selected.score ?? 0,
    policyKind: policy.kind,
  };

  return RouterDecisionSchema.parse({
    id: `router:${contract.id}:${evidenceHash.slice(0, 16)}`,
    workId: contract.id,
    taskId: undefined,
    attemptId: undefined,
    policy,
    considered: scored,
    selected,
    rationale,
    evidenceHash,
    expectedCostUsd,
    expectedDurationMs,
    decidedAt: now().toISOString(),
  });
}

function pickBestConsidered(
  matched: readonly RouterConsidered[],
  policy: RouterPolicy,
): { considered: RouterConsidered; reason: string } {
  const sorted = [...matched].sort((left, right) => {
    const leftScore = left.score ?? 0;
    const rightScore = right.score ?? 0;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return left.workerId.localeCompare(right.workerId);
  });
  const winner = sorted[0]!;
  return {
    considered: winner,
    reason: explainSelection(winner, policy),
  };
}

function explainSelection(considered: RouterConsidered, policy: RouterPolicy): string {
  const descriptor = considered.descriptor;
  const evidence = considered.evidence;
  switch (policy.kind) {
    case "cheapest-capable":
      return `${descriptor.workerId} selected: lowest cost per 1k tokens ($${descriptor.costPer1kTokensUsd.toFixed(4)}) among capable workers`;
    case "fastest-capable":
      return `${descriptor.workerId} selected: lowest average latency (${descriptor.avgLatencyMs} ms) among capable workers`;
    case "highest-confidence": {
      const confidence = evidence?.confidence ?? null;
      if (confidence === null) {
        return `${descriptor.workerId} selected: zero confidence signals, fallback to lexicographic tie-breaker`;
      }
      const attemptCount = evidence?.attemptCount ?? 0;
      return `${descriptor.workerId} selected: highest confidence (${confidence.toFixed(3)}) over ${attemptCount} attempts`;
    }
    case "balanced":
      return `${descriptor.workerId} selected: balanced score ${(considered.score ?? 0).toFixed(4)} across success rate, cost, duration, and confidence`;
  }
}

function buildSelectedReason(
  considered: RouterConsidered,
  policy: RouterPolicy,
  contract: WorkContract,
): string {
  void contract;
  return explainSelection(considered, policy);
}

function hashRouterDecisionInputs(
  contract: WorkContract,
  policy: RouterPolicy,
  options: RouterRouteOptions,
  considered: readonly RouterConsidered[],
): string {
  const payload = {
    contractId: contract.id,
    workType: contract.type,
    policy,
    options: {
      excludeProviders: [...options.excludeProviders].sort(),
      streamIds: [...options.streamIds].sort(),
      expectedTokens: options.expectedTokens,
    },
    considered: considered.map((entry) => ({
      workerId: entry.workerId,
      descriptor: entry.descriptor,
      evidence: entry.evidence,
      score: entry.score,
      matched: entry.matched,
      excludedReason: entry.excludedReason,
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function parseRouterWorkerDescriptor(input: unknown): RouterWorkerDescriptor {
  return RouterWorkerDescriptorSchema.parse(input);
}

export function parseRouterPolicy(input: unknown): RouterPolicy {
  return RouterPolicySchema.parse(input);
}

export function parseRouterEvidence(input: unknown): RouterEvidence {
  return RouterEvidenceSchema.parse(input);
}

export function parseRouterDecision(input: unknown): RouterDecision {
  return RouterDecisionSchema.parse(input);
}

export function parseRouterDecisionPayload(input: unknown): RouterDecisionPayload {
  return RouterDecisionPayloadSchema.parse(input);
}

export function routerDecisionToEvent(decision: RouterDecision, eventInput: {
  id: string;
  streamId: string;
  actor: { id: string; kind: "automation" | "agent" | "service"; displayName?: string };
  occurredAt?: string;
  recordedAt?: string;
  taskId?: string;
  attemptId?: string;
  evidence?: readonly { id: string; kind: string; uri?: string; digest?: string }[];
}): unknown {
  const occurredAt = eventInput.occurredAt ?? decision.decidedAt;
  const recordedAt = eventInput.recordedAt ?? decision.decidedAt;
  return z.object({
    schemaVersion: z.literal(1),
    id: z.string().trim().min(1).max(200),
    streamId: z.string().trim().min(1).max(200),
    workId: z.string().trim().min(1).max(200),
    taskId: z.string().trim().min(1).max(200).optional(),
    attemptId: z.string().trim().min(1).max(200).optional(),
    actor: z.object({
      id: z.string().trim().min(1).max(200),
      kind: z.enum(["automation", "agent", "service"]),
      displayName: z.string().trim().min(1).max(200).optional(),
    }).strict(),
    occurredAt: z.iso.datetime({ offset: true }),
    recordedAt: z.iso.datetime({ offset: true }),
    evidence: z.array(z.unknown()).default([]),
    causationId: z.string().trim().min(1).max(200).optional(),
    correlationId: z.string().trim().min(1).max(200).optional(),
    type: z.literal("router.decision-made"),
    payload: RouterDecisionPayloadSchema,
  }).strict().parse({
    schemaVersion: 1,
    id: eventInput.id,
    streamId: eventInput.streamId,
    workId: decision.workId,
    taskId: eventInput.taskId,
    attemptId: eventInput.attemptId,
    actor: eventInput.actor,
    occurredAt,
    recordedAt,
    evidence: eventInput.evidence ?? [],
    type: "router.decision-made",
    payload: {
      decisionId: decision.id,
      policy: decision.policy.kind,
      selectedWorkerId: decision.selected?.workerId ?? null,
      consideredCount: decision.considered.length,
      evidenceHash: decision.evidenceHash,
      expectedCostUsd: decision.expectedCostUsd,
      expectedDurationMs: decision.expectedDurationMs,
    },
  });
}

export function isRouterDecisionEvent(event: { type: string }): event is { type: "router.decision-made" } & Record<string, unknown> {
  return event.type === "router.decision-made";
}
