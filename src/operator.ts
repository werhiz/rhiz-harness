import { acceptanceReadiness, projectBoard, type BoardProjection } from "./board.js";
import type { EventLedger } from "./ledger.js";
import type { RefinerBridge } from "./refiner-bridge.js";
import { countHumanInterventions, type RefinerAnalysis } from "./refiner.js";
import { computeRouterEvidenceFromEvents, type RouterEvidence } from "./router.js";
import {
  ActorRefSchema,
  parseHarnessEvent,
  type ActorRef,
  type EvidenceRef,
  type HarnessEvent,
  type RefinerProposal,
  type WorkState,
} from "./schemas.js";

/**
 * The operator loop: start, status, resume, review, accept.
 *
 * These are the human verbs over one Work item. None of them is a second
 * owner of any fact. Status is a projection of the Board; review and accept
 * append the same typed events every other caller appends, and every write is
 * projected in memory first, so an event the Board would refuse is never
 * written to an append-only Ledger in the first place.
 *
 * Acceptance is where learning starts. The Refiner consumes closed Work and
 * `ready` is not closed, so until this module existed a verified run that a
 * person accepted produced no outcome analysis at all, and the Router, which
 * credits only independently verified accepted attempts, never saw the
 * acceptance because nothing recorded one.
 */

export type OperatorNextAction = "resume" | "review" | "accept" | "none";

export interface OperatorWorkMetrics {
  /** The organizational outcome, or `open` while the Work is not terminal. */
  outcome: "accepted" | "rejected" | "cancelled" | "open";
  attempts: number;
  failedAttempts: number;
  /** Attempts after the first. Each one is a repair the Harness paid for. */
  repairAttempts: number;
  /** A failed attempt or failed verification that the Work later got past. */
  recovered: boolean;
  /** Router estimates recorded at selection time. An estimate, never a bill. */
  estimatedCostUsd: number;
  contextTokens: number;
  /** Human decisions beyond stating the Work and accepting it. See HUMAN_INTERVENTION_EVENT_TYPES. */
  humanInterventions: number;
  /** Every human decision: stating the Work, each intervention, and the acceptance itself. */
  humanDecisions: number;
  /** Start of the stream to its last event, in milliseconds. */
  elapsedMs: number;
}

export interface OperatorWorkStatus {
  workId: string;
  streamId: string;
  state: WorkState;
  contractRevision: number;
  objective: string | null;
  attempts: { total: number; finished: number; failed: number; active: number; budget: number | null };
  verification: { latest: "pass" | "fail" | null; count: number };
  review: { latest: "pass" | "fail" | null; count: number; required: boolean };
  readiness: { ready: boolean; reasons: readonly string[] };
  violations: number;
  /**
   * What verification proved, read from the Board's integration head proof:
   * the base the Work started from and the exact head verified. Null when the
   * Work has no integration proof. Callers name this, never a side file.
   */
  verifiedTarget: { base: string; head: string; ref: string } | null;
  nextAction: OperatorNextAction;
  nextActionReason: string;
  metrics: OperatorWorkMetrics;
}

export interface OperatorDigest {
  works: number;
  accepted: number;
  rejected: number;
  cancelled: number;
  open: number;
  readyToAccept: number;
  recovered: number;
  repairAttempts: number;
  estimatedCostUsd: number;
  humanInterventions: number;
  humanDecisions: number;
  /** The North Star: human interventions per accepted outcome. Null before the first one. */
  interventionsPerAcceptedOutcome: number | null;
  /** All human decisions, the two judgment calls included, per accepted outcome. */
  decisionsPerAcceptedOutcome: number | null;
}

export class OperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorError";
  }
}

function single(events: readonly HarnessEvent[]): { workId: string; streamId: string } {
  const first = events[0];
  if (first === undefined) throw new OperatorError("Work stream is empty");
  for (const event of events) {
    if (event.workId !== first.workId || event.streamId !== first.streamId) {
      throw new OperatorError(`stream ${first.streamId} mixes Work ${first.workId} with ${event.workId}`);
    }
  }
  return { workId: first.workId, streamId: first.streamId };
}

function elapsed(events: readonly HarnessEvent[]): number {
  if (events.length === 0) return 0;
  const times = events.map((event) => Date.parse(event.occurredAt)).filter(Number.isFinite);
  if (times.length === 0) return 0;
  return Math.max(0, Math.max(...times) - Math.min(...times));
}

function latestStatus(items: readonly { status: "pass" | "fail"; contractRevision: number }[], revision: number) {
  const current = items.filter((item) => item.contractRevision === revision);
  return current.length === 0 ? null : current[current.length - 1]!.status;
}

export function summarizeOperatorWork(events: readonly HarnessEvent[]): OperatorWorkStatus {
  const { workId, streamId } = single(events);
  const board = projectBoard(events);
  const attempts = Object.values(board.attempts);
  const finished = attempts.filter((attempt) => attempt.state === "finished").length;
  const failed = attempts.filter((attempt) => attempt.state === "failed").length;
  const active = attempts.length - finished - failed;
  const budget = board.contract?.workerPolicy.maxAttempts ?? null;
  const readiness = acceptanceReadiness(board);
  const verificationFailed = board.verifications.some((item) => item.status === "fail");
  const reviewRequired = board.contract?.verificationPolicy.reviewRequired ?? false;
  const outcome: OperatorWorkMetrics["outcome"] = board.state === "accepted" || board.state === "rejected" || board.state === "cancelled"
    ? board.state
    : "open";
  const metrics: OperatorWorkMetrics = {
    outcome,
    attempts: attempts.length,
    failedAttempts: failed,
    repairAttempts: Math.max(0, attempts.length - 1),
    // The same definition the Refiner uses, so status and learning agree.
    recovered: outcome === "accepted" && (attempts.length > 1 || failed > 0 || verificationFailed),
    estimatedCostUsd: events.reduce(
      (total, event) => total + (event.type === "router.decision-made" ? event.payload.expectedCostUsd : 0),
      0,
    ),
    contextTokens: events.reduce(
      (total, event) => total + (event.type === "context.pack-selected" ? event.payload.totalTokens : 0),
      0,
    ),
    humanInterventions: countHumanInterventions(events),
    humanDecisions: countHumanInterventions(events) + events.filter((event) => event.actor.kind === "human"
      && (event.type === "work.created" || event.type === "work.accepted")).length,
    elapsedMs: elapsed(events),
  };
  const { nextAction, nextActionReason } = nextActionFor(
    board, readiness.ready, readiness.reasons, active, budget, readiness.verificationEventId,
  );
  return {
    workId,
    streamId,
    state: board.state,
    contractRevision: board.contractRevision,
    objective: board.contract?.objective ?? null,
    attempts: { total: attempts.length, finished, failed, active, budget },
    verification: { latest: latestStatus(board.verifications, board.contractRevision), count: board.verifications.length },
    review: { latest: latestStatus(board.reviews, board.contractRevision), count: board.reviews.length, required: reviewRequired },
    readiness: { ready: readiness.ready, reasons: readiness.reasons },
    violations: board.violations.length,
    verifiedTarget: board.integration?.headProof
      ? { base: board.integration.configuration.head, head: board.integration.headProof.head, ref: board.integration.configuration.ref }
      : null,
    nextAction,
    nextActionReason,
    metrics,
  };
}

function nextActionFor(
  board: BoardProjection,
  ready: boolean,
  reasons: readonly string[],
  active: number,
  budget: number | null,
  verificationEventId: string | undefined,
): { nextAction: OperatorNextAction; nextActionReason: string } {
  if (board.state === "accepted" || board.state === "rejected" || board.state === "cancelled") {
    return { nextAction: "none", nextActionReason: `Work is ${board.state}` };
  }
  if (ready) return { nextAction: "accept", nextActionReason: "independently verified and ready for acceptance" };
  if (reasons.some((reason) => reason.includes("latest independent review") && reason.includes("failed"))) {
    return { nextAction: "review", nextActionReason: "the latest independent review failed; obtain a passing independent review, or amend or reject the Work" };
  }
  // A required review is missing even before execution or verification.
  // Only the Board's qualifying verification can make review the next step;
  // otherwise the CLI refuses both review (no target) and resume (wrong action).
  const reviewMissing = reasons.some((reason) => reason.includes("independent passing review"));
  if (reviewMissing && verificationEventId !== undefined && active === 0) {
    return { nextAction: "review", nextActionReason: "verified, waiting on an independent review" };
  }
  if (active > 0) return { nextAction: "resume", nextActionReason: `${active} attempt(s) have no terminal event` };
  const spent = Object.keys(board.attempts).length;
  if (budget !== null && spent >= budget) {
    return { nextAction: "none", nextActionReason: `attempt budget ${budget} is spent; amend or reject the Work` };
  }
  return { nextAction: "resume", nextActionReason: reasons[0] ?? `Work is ${board.state}` };
}

export function summarizeOperatorWorks(statuses: readonly OperatorWorkStatus[]): OperatorDigest {
  const count = (outcome: OperatorWorkMetrics["outcome"]) => statuses.filter((item) => item.metrics.outcome === outcome).length;
  const accepted = count("accepted");
  const humanInterventions = statuses.reduce((total, item) => total + item.metrics.humanInterventions, 0);
  const humanDecisions = statuses.reduce((total, item) => total + item.metrics.humanDecisions, 0);
  return {
    works: statuses.length,
    accepted,
    rejected: count("rejected"),
    cancelled: count("cancelled"),
    open: count("open"),
    readyToAccept: statuses.filter((item) => item.nextAction === "accept").length,
    recovered: statuses.filter((item) => item.metrics.recovered).length,
    repairAttempts: statuses.reduce((total, item) => total + item.metrics.repairAttempts, 0),
    estimatedCostUsd: statuses.reduce((total, item) => total + item.metrics.estimatedCostUsd, 0),
    humanInterventions,
    humanDecisions,
    interventionsPerAcceptedOutcome: accepted === 0 ? null : humanInterventions / accepted,
    decisionsPerAcceptedOutcome: accepted === 0 ? null : humanDecisions / accepted,
  };
}

/**
 * The Board must admit an event before the Ledger may hold it. Projecting the
 * candidate first turns every refusal into an error raised before the
 * irreversible append rather than a violation discovered after it.
 */
async function appendAdmitted(ledger: EventLedger, events: readonly HarnessEvent[], candidates: readonly HarnessEvent[]) {
  const before = projectBoard(events);
  let current = before;
  let history = [...events];
  for (const candidate of candidates) {
    history = [...history, candidate];
    const next = projectBoard(history);
    if (next.violations.length !== current.violations.length) {
      const refused = next.violations[next.violations.length - 1];
      throw new OperatorError(`the Board refuses ${candidate.type}: ${refused ? `${refused.code}: ${refused.detail}` : "unknown violation"}`);
    }
    current = next;
  }
  for (const candidate of candidates) await ledger.append(candidate);
  return current;
}

interface OperatorWriteOptions {
  now?: () => string;
  idFactory?: () => string;
}

export interface OperatorReviewInput extends OperatorWriteOptions {
  ledger: EventLedger;
  streamId: string;
  reviewer: ActorRef;
  status: "pass" | "fail";
  summary: string;
  findings?: readonly { severity: "info" | "low" | "medium" | "high" | "critical"; summary: string }[];
  evidence?: readonly EvidenceRef[];
}

/** Record one complete, independent review lifecycle against the current contract revision. */
export async function recordOperatorReview(input: OperatorReviewInput): Promise<OperatorWorkStatus> {
  const reviewer = ActorRefSchema.parse(input.reviewer);
  const events = await input.ledger.replay(input.streamId);
  const { workId } = single(events);
  const board = projectBoard(events);
  if (board.state === "accepted" || board.state === "rejected" || board.state === "cancelled") {
    throw new OperatorError(`Work ${workId} is ${board.state}; a review can no longer change it`);
  }
  if (Object.values(board.attempts).some((attempt) => attempt.executionProvenance.some((actor) => actor.id === reviewer.id))) {
    throw new OperatorError(`reviewer ${reviewer.id} executed this Work and cannot review it independently`);
  }
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory ?? (() => globalThis.crypto.randomUUID());
  const reviewId = `review:${idFactory()}`;
  const contractRevision = board.contractRevision;
  const base = { schemaVersion: 1, streamId: input.streamId, workId, actor: reviewer };
  const at = () => {
    const timestamp = now();
    return { occurredAt: timestamp, recordedAt: timestamp };
  };
  // A review is several appends. If a previous run by this reviewer died
  // between them, its lifecycle is still open and would block every later
  // decision. Close it as a failed, interrupted review: the record keeps
  // that it happened, and only a fresh complete review can pass.
  const interrupted: HarnessEvent[] = [];
  const active = board.activeReview;
  if (active) {
    if (active.actor.id !== reviewer.id) {
      throw new OperatorError(`review ${active.id} by ${active.actor.id} is still open; only that reviewer can close it`);
    }
    interrupted.push(parseHarnessEvent({
      ...base,
      ...at(),
      id: `event:review:${idFactory()}`,
      type: "review.result",
      evidence: [],
      payload: {
        reviewId: active.id,
        contractRevision: active.contractRevision,
        status: "fail",
        summary: "review interrupted: the previous run ended without recording a result",
      },
    }));
  }
  const candidates: HarnessEvent[] = [
    ...interrupted,
    parseHarnessEvent({ ...base, ...at(), id: `event:review:${idFactory()}`, type: "review.started", evidence: [], payload: { reviewId, contractRevision } }),
    ...(input.findings ?? []).slice(0, 50).map((finding) => parseHarnessEvent({
      ...base,
      ...at(),
      id: `event:review:${idFactory()}`,
      type: "review.finding",
      evidence: [],
      payload: { reviewId, severity: finding.severity, summary: finding.summary.slice(0, 2000) },
    })),
    parseHarnessEvent({
      ...base,
      ...at(),
      id: `event:review:${idFactory()}`,
      type: "review.result",
      evidence: [...(input.evidence ?? [])],
      payload: { reviewId, contractRevision, status: input.status, summary: input.summary.slice(0, 2000) },
    }),
  ];
  await appendAdmitted(input.ledger, events, candidates);
  return summarizeOperatorWork(await input.ledger.replay(input.streamId));
}

export interface OperatorAcceptInput extends OperatorWriteOptions {
  ledger: EventLedger;
  streamId: string;
  actor: ActorRef;
  reason: string;
  evidence?: readonly EvidenceRef[];
  /**
   * Proves the verified artifact still exists and is unchanged. Called after
   * the Board says ready and before anything is written; throwing refuses the
   * acceptance. Acceptance of a target nobody re-checked is a label.
   */
  confirmTarget?: (board: BoardProjection) => Promise<void>;
  /** Learning. When supplied, the accepted stream is handed to the Refiner. */
  refiner?: RefinerBridge;
}

export interface OperatorAcceptResult {
  status: OperatorWorkStatus;
  acceptanceEventId: string;
  learning: {
    analysis: RefinerAnalysis | null;
    proposals: readonly RefinerProposal[];
    /** What the Router now credits from this Work, derived from the canonical stream. */
    routerEvidence: readonly RouterEvidence[];
  };
}

export async function acceptOperatorWork(input: OperatorAcceptInput): Promise<OperatorAcceptResult> {
  const actor = ActorRefSchema.parse(input.actor);
  if (actor.kind !== "human") throw new OperatorError(`actor ${actor.id} lacks human acceptance authority`);
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 2000) throw new OperatorError("acceptance needs a reason of 1 to 2000 characters");
  const events = await input.ledger.replay(input.streamId);
  const { workId } = single(events);
  const board = projectBoard(events);
  const readiness = acceptanceReadiness(board);
  if (!readiness.ready) throw new OperatorError(`Work ${workId} is not ready for acceptance: ${readiness.reasons.join("; ")}`);
  if (input.confirmTarget) await input.confirmTarget(board);
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory ?? (() => globalThis.crypto.randomUUID());
  const timestamp = now();
  const acceptance = parseHarnessEvent({
    id: `event:acceptance:${idFactory()}`,
    type: "work.accepted",
    schemaVersion: 1,
    streamId: input.streamId,
    workId,
    actor,
    occurredAt: timestamp,
    recordedAt: timestamp,
    evidence: [...(input.evidence ?? [])],
    payload: { reason, contractRevision: board.contractRevision },
  });
  const after = await appendAdmitted(input.ledger, events, [acceptance]);
  if (after.state !== "accepted") throw new OperatorError(`acceptance left Work ${workId} ${after.state}`);
  const accepted = await input.ledger.replay(input.streamId);
  const learned = input.refiner ? await input.refiner.consume({ workId, events: accepted }) : null;
  const closed = learned === null ? accepted : await input.ledger.replay(input.streamId);
  return {
    status: summarizeOperatorWork(closed),
    acceptanceEventId: acceptance.id,
    learning: {
      analysis: learned?.analysis ?? null,
      proposals: learned?.proposals ?? [],
      routerEvidence: computeRouterEvidenceFromEvents(closed),
    },
  };
}

/**
 * Recovery for an attempt whose process ended without a terminal event.
 *
 * Process death is an Observation, not an outcome, so the orphan is closed as
 * a recoverable failure by a service actor, which keeps the budget honest and
 * lets the next attempt continue the same Work. Nothing else is touched.
 */
export async function closeOrphanedAttempts(input: OperatorWriteOptions & {
  ledger: EventLedger;
  streamId: string;
  actor?: ActorRef;
  reason?: string;
}): Promise<readonly string[]> {
  const events = await input.ledger.replay(input.streamId);
  const { workId } = single(events);
  const board = projectBoard(events);
  const orphaned = Object.values(board.attempts).filter((attempt) => attempt.state === "running" || attempt.state === "blocked");
  if (orphaned.length === 0) return [];
  const now = input.now ?? (() => new Date().toISOString());
  const idFactory = input.idFactory ?? (() => globalThis.crypto.randomUUID());
  const actor = ActorRefSchema.parse(input.actor ?? { id: "service:operator-resume", kind: "service" });
  const candidates = orphaned.map((attempt) => {
    const timestamp = now();
    return parseHarnessEvent({
      id: `event:resume:${idFactory()}`,
      type: "attempt.failed",
      schemaVersion: 1,
      streamId: input.streamId,
      workId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      actor,
      occurredAt: timestamp,
      recordedAt: timestamp,
      evidence: [],
      payload: {
        reason: (input.reason ?? "operator resume: the attempt's process ended without a terminal event").slice(0, 2000),
        recoverable: true,
      },
    });
  });
  await appendAdmitted(input.ledger, events, candidates);
  return orphaned.map((attempt) => attempt.id);
}
