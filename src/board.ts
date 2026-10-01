import type {
  ActorRef,
  AttemptLease,
  EvidenceRef,
  EvidenceRequirement,
  FalsifiabilityReport,
  GuardEvaluation,
  HarnessEvent,
  IntegrationCheckpoint,
  IntegrationEligibility,
  IntegrationMergeAuthority,
  IntegrationMergeStatus,
  IntegrationPullRequest,
  IntegrationRemoteStatus,
  LogicalResourceClaim,
  WorkExecutionObservation,
  WorkIntegrationConfiguration,
  WorkAmendment,
  WorkContract,
  WorkState,
} from "./schemas.js";
import { WorkContractSchema, normalizeLogicalPath } from "./schemas.js";

export interface AttemptProjection {
  id: string;
  taskId: string;
  worker: ActorRef;
  /** Every actor that has ever executed this Attempt, in acquisition order. */
  executionProvenance: ActorRef[];
  contractRevision: number;
  state: "running" | "blocked" | "finished" | "failed";
  /** Last workspace identity remains after lease release for checkpoint provenance. */
  workspaceId?: string;
  /** Present only while this Attempt holds a revocable execution lease. */
  lease?: AttemptLease;
  /** Work integration head from which this Attempt's writable workspace derives. */
  integrationBaseHead?: string;
  /**
   * How many execution observations this Attempt streamed. A worker that ran
   * produces these as it works; a fabricated attempt has none.
   */
  observationCount: number;
}

export interface IntegrationCheckpointProjection {
  eventId: string;
  taskId: string;
  attemptId: string;
  checkpoint: IntegrationCheckpoint;
  effectiveProofState: IntegrationCheckpoint["proofState"];
}

export interface IntegrationLockProjection {
  eventId: string;
  id: string;
  checkpointId: string;
  expectedHead: string;
}

export interface IntegrationHeadProofProjection {
  eventId: string;
  checkpointId: string;
  head: string;
  tree: string;
  verificationEventId: string;
  remoteRef: string;
}

export interface IntegrationReconciliationProjection {
  eventId: string;
  taskId: string;
  attemptId: string;
  checkpointId: string;
  previousBaseHead: string;
  newBaseHead: string;
  status: "clean" | "conflict";
  head?: string;
  tree?: string;
  proofHead?: string;
  remoteRef?: string;
  preservedRefs: string[];
  reason?: string;
}

export interface IntegrationTaskStateProjection {
  taskId: string;
  attemptId: string;
  baseHead: string;
  checkpointHead: string | null;
  remoteCheckpointStatus: IntegrationRemoteStatus;
  integrationEligibility: IntegrationEligibility;
  queuePosition: number | null;
  resourceLeases: LogicalResourceClaim[];
  proofStatus: IntegrationCheckpoint["proofState"];
  preservedRefs: string[];
}

export interface IntegrationMergeProjection {
  authority: IntegrationMergeAuthority;
  status: IntegrationMergeStatus;
  decisionId?: string;
  detail: string;
}

export interface WorkExecutionDivergence {
  kind: "recorded-inactive-execution-active" | "recorded-active-execution-inactive" | "work-state-mismatch";
  recordedState: WorkState;
  observedState: WorkExecutionObservation["state"];
  source: string;
  observedAt: string;
}

/** Nested Board state, not a second organizational projection. */
export interface WorkIntegrationProjection {
  configuration: WorkIntegrationConfiguration;
  head: string;
  checkpoints: Record<string, IntegrationCheckpointProjection>;
  queue: string[];
  lock: IntegrationLockProjection | null;
  headProof: IntegrationHeadProofProjection | null;
  reconciliations: Record<string, IntegrationReconciliationProjection>;
  taskStates: Record<string, IntegrationTaskStateProjection>;
  pullRequests: IntegrationPullRequest[];
  merge: IntegrationMergeProjection;
  cleanups: Record<string, { eventId: string; disposition: "integrated" | "rescue-preserved" | "discarded"; checkpointId?: string }>;
  failures: Array<{ eventId: string; checkpointId: string; reason: string; semanticConflict: boolean; preservedRefs: string[] }>;
  latestExecutionObservation: WorkExecutionObservation | null;
  divergences: WorkExecutionDivergence[];
}

export interface VerificationProjection {
  eventId: string;
  verificationId: string;
  contractRevision: number;
  actor: ActorRef;
  status: "pass" | "fail";
  criterionResults: Array<{
    criterionId: string;
    status: "pass" | "fail" | "not-evaluated";
  }>;
  evidenceSatisfaction: Array<{
    requirementId: string;
    evidence: EvidenceRef[];
  }>;
  /** How much of the contract this verification could actually have falsified. */
  falsifiability: FalsifiabilityReport;
}

export interface ReviewProjection {
  eventId: string;
  reviewId: string;
  contractRevision: number;
  actor: ActorRef;
  status: "pass" | "fail";
}

export interface ActiveCheckProjection {
  id: string;
  contractRevision: number;
  actor: ActorRef;
}

export interface ProjectionViolation {
  eventId: string;
  code:
    | "duplicate-event"
    | "event-before-work-created"
    | "duplicate-work-created"
    | "work-id-mismatch"
    | "revision-mismatch"
    | "invalid-amendment"
    | "amendment-during-active-work"
    | "event-after-terminal"
    | "duplicate-task"
    | "unknown-task"
    | "duplicate-attempt"
    | "unknown-attempt"
    | "attempt-task-mismatch"
    | "invalid-attempt-transition"
    | "worker-assignment-mismatch"
    | "attempt-lease-required"
    | "attempt-lease-mismatch"
    | "attempt-lease-expired"
    | "resource-lease-conflict"
    | "duplicate-decision"
    | "unknown-decision"
    | "verification-already-active"
    | "verification-not-active"
    | "review-already-active"
    | "review-not-active"
    | "acceptance-preconditions-not-met"
    | "invalid-work-lifecycle-transition"
    | "integration-already-initialized"
    | "integration-initialized-during-active-work"
    | "integration-not-initialized"
    | "stale-execution-observation"
    | "duplicate-integration-checkpoint"
    | "checkpoint-attempt-mismatch"
    | "checkpoint-candidate-ineligible"
    | "checkpoint-integration-head-mismatch"
    | "integration-candidate-not-remote"
    | "integration-candidate-already-queued"
    | "integration-queue-order"
    | "integration-lock-held"
    | "integration-lock-mismatch"
    | "integration-head-mismatch"
    | "integration-proof-mismatch"
    | "integration-task-not-stale"
    | "integration-reconciliation-mismatch"
    | "integration-pr-conflict"
    | "integration-merge-authority-missing"
    | "integration-cleanup-unsafe";
  detail: string;
}

export interface AuthorityDecisionProjection {
  eventId: string;
  decision: "granted" | "denied";
  reason: string;
}

export interface ResolvedDecisionProjection {
  eventId: string;
  resolution: string;
  actor: ActorRef;
}

/** Guard facts are evidence only; they do not create another Work state machine. */
export interface GuardEvaluationProjection extends GuardEvaluation {
  eventId: string;
}

export interface BoardProjection {
  workId: string | null;
  contract: WorkContract | null;
  contractRevision: number;
  state: WorkState;
  tasks: Record<string, { id: string; objective: string; assignedWorker?: ActorRef }>;
  attempts: Record<string, AttemptProjection>;
  openDecisions: Record<string, string>;
  resolvedDecisions: Record<string, ResolvedDecisionProjection>;
  /**
   * Authority decisions emitted at enforcement seams, in arrival order. These
   * are evidence, not state transitions: a denial recorded here is the reason
   * an attempt failed, not a work-state of its own.
   */
  authorityDecisions: AuthorityDecisionProjection[];
  /** Native tool requests and their Guard verdicts, replayed in arrival order. */
  guardEvaluations: GuardEvaluationProjection[];
  activeVerification: ActiveCheckProjection | null;
  activeReview: ActiveCheckProjection | null;
  verifications: VerificationProjection[];
  reviews: ReviewProjection[];
  acceptedBy: ActorRef | null;
  parkedReason: string | null;
  integration: WorkIntegrationProjection | null;
  violations: ProjectionViolation[];
  seenEventIds: Record<string, true>;
  lastEventId: string | null;
}

export function emptyBoard(): BoardProjection {
  return {
    workId: null,
    contract: null,
    contractRevision: 0,
    state: "proposed",
    tasks: {},
    attempts: {},
    openDecisions: {},
    resolvedDecisions: {},
    authorityDecisions: [],
    guardEvaluations: [],
    activeVerification: null,
    activeReview: null,
    verifications: [],
    reviews: [],
    acceptedBy: null,
    parkedReason: null,
    integration: null,
    violations: [],
    seenEventIds: {},
    lastEventId: null,
  };
}

const terminalStates = new Set<WorkState>(["accepted", "rejected", "cancelled"]);
const postTerminalRecordOnlyTypes = new Set<HarnessEvent["type"]>([
  "attempt.activity-observed",
  "artifact.observed",
  // Refiner lifecycle records are ABOUT the closed outcome. They may be
  // appended only after that outcome exists, and Board does not own their
  // projection. Recording them must preserve the terminal Work state without
  // manufacturing an event-after-terminal violation.
  "refiner.proposed",
  "refiner.accepted",
  "refiner.rejected",
  "refiner.promoted",
]);

function violation(
  board: BoardProjection,
  event: HarnessEvent,
  code: ProjectionViolation["code"],
  detail: string,
): BoardProjection {
  return {
    ...board,
    violations: [...board.violations, { eventId: event.id, code, detail }],
    lastEventId: event.id,
  };
}

function applyAmendment(contract: WorkContract, changes: WorkAmendment): WorkContract {
  return WorkContractSchema.parse({ ...contract, ...changes });
}

function activeAttempts(board: BoardProjection): AttemptProjection[] {
  return Object.values(board.attempts).filter((attempt) => attempt.state === "running" || attempt.state === "blocked");
}

function withDerivedIntegrationTaskStates(board: BoardProjection): BoardProjection {
  const integration = board.integration;
  if (integration === null) return board;

  const latestAttemptByTask = new Map<string, AttemptProjection>();
  for (const attempt of Object.values(board.attempts)) latestAttemptByTask.set(attempt.taskId, attempt);
  const latestCheckpointByAttempt = new Map<string, IntegrationCheckpointProjection>();
  for (const checkpoint of Object.values(integration.checkpoints)) latestCheckpointByAttempt.set(checkpoint.attemptId, checkpoint);
  const queuePositionByCheckpoint = new Map(integration.queue.map((checkpointId, index) => [checkpointId, index + 1]));
  const taskStates: Record<string, IntegrationTaskStateProjection> = {};

  for (const attempt of latestAttemptByTask.values()) {
    const checkpoint = latestCheckpointByAttempt.get(attempt.id);
    const reconciliation = integration.reconciliations[attempt.id];
    const queuePosition = checkpoint === undefined ? undefined : queuePositionByCheckpoint.get(checkpoint.checkpoint.id);
    const isIntegrated = integration.headProof?.checkpointId === checkpoint?.checkpoint.id;
    const isIntegrating = integration.lock?.checkpointId === checkpoint?.checkpoint.id;
    const stale = attempt.integrationBaseHead !== undefined && attempt.integrationBaseHead !== integration.head;

    let integrationEligibility: IntegrationEligibility;
    if (reconciliation?.status === "conflict") integrationEligibility = "conflict";
    else if (isIntegrated) integrationEligibility = "integrated";
    else if (isIntegrating) integrationEligibility = "integrating";
    else if (queuePosition !== undefined) integrationEligibility = "queued";
    else if (stale) integrationEligibility = "stale";
    else if (checkpoint?.checkpoint.class === "integration-candidate" && checkpoint.effectiveProofState === "passed") integrationEligibility = "eligible";
    else if (checkpoint?.effectiveProofState === "failed") integrationEligibility = "failed";
    else integrationEligibility = "wip";

    taskStates[attempt.taskId] = {
      taskId: attempt.taskId,
      attemptId: attempt.id,
      baseHead: attempt.integrationBaseHead ?? integration.configuration.head,
      checkpointHead: reconciliation?.status === "clean"
        ? reconciliation.head ?? null
        : checkpoint?.checkpoint.head ?? null,
      remoteCheckpointStatus: checkpoint?.checkpoint.remoteStatus ?? "local-only",
      integrationEligibility,
      queuePosition: queuePosition ?? null,
      resourceLeases: attempt.lease?.resourceClaims ?? [],
      proofStatus: reconciliation?.status === "clean"
        ? "passed"
        : reconciliation?.status === "conflict"
          ? "stale"
          : checkpoint?.effectiveProofState ?? "not-run",
      preservedRefs: reconciliation?.preservedRefs ?? [],
    };
  }

  return { ...board, integration: { ...integration, taskStates } };
}

/** Whether two logical write claims materially overlap. */
export function resourceClaimsOverlap(left: LogicalResourceClaim, right: LogicalResourceClaim): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "path") return left.resource === right.resource;
  const leftPath = normalizeLogicalPath(left.resource);
  const rightPath = normalizeLogicalPath(right.resource);
  if (leftPath === "" || rightPath === "") return true;
  return leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`);
}

export function findResourceLeaseConflict(board: BoardProjection, lease: AttemptLease, excludingAttemptId?: string): AttemptProjection | null {
  for (const attempt of activeAttempts(board)) {
    if (attempt.id === excludingAttemptId || attempt.lease === undefined) continue;
    if (attempt.lease.resourceClaims.some((left) => lease.resourceClaims.some((right) => resourceClaimsOverlap(left, right)))) {
      return attempt;
    }
  }
  return null;
}

const idleWorkStates = new Set<WorkState>([
  "proposed",
  "ready",
  "parked",
  "accepted",
  "rejected",
  "cancelled",
  "failed",
]);
const idleObservedStates = new Set<WorkExecutionObservation["state"]>(["ready", "parked", "failed"]);

function workExecutionDivergence(
  recordedState: WorkState,
  observation: WorkExecutionObservation,
): WorkExecutionDivergence | null {
  if (recordedState === observation.state) return null;
  const recordedIdle = idleWorkStates.has(recordedState);
  const observedIdle = idleObservedStates.has(observation.state);
  const kind = recordedIdle && !observedIdle
    ? "recorded-inactive-execution-active"
    : !recordedIdle && observedIdle
      ? "recorded-active-execution-inactive"
      : "work-state-mismatch";
  return {
    kind,
    recordedState,
    observedState: observation.state,
    source: observation.source,
    observedAt: observation.observedAt,
  };
}

function applyExecutionObservation(board: BoardProjection, event: HarnessEvent & { type: "integration.execution-observed" }): BoardProjection {
  const integration = board.integration;
  if (integration === null) {
    return violation(board, event, "integration-not-initialized", "execution reconciliation requires Work integration configuration");
  }
  const observation = event.payload.observation;
  const latest = integration.latestExecutionObservation;
  if (latest !== null && Date.parse(observation.observedAt) < Date.parse(latest.observedAt)) {
    return violation(
      board,
      event,
      "stale-execution-observation",
      `execution observation from ${observation.observedAt} is older than the recorded observation from ${latest.observedAt}`,
    );
  }
  const divergence = workExecutionDivergence(board.state, observation);
  return {
    ...board,
    integration: {
      ...integration,
      latestExecutionObservation: observation,
      divergences: divergence === null ? integration.divergences : [...integration.divergences, divergence],
    },
  };
}

/**
 * The single independence source: every actor that has ever executed any
 * Attempt of this Work, not merely the current lease holder.
 */
export function executionActorIds(board: BoardProjection): Set<string> {
  const actors = new Set<string>();
  for (const attempt of Object.values(board.attempts)) {
    actors.add(attempt.worker.id);
    for (const executor of attempt.executionProvenance) actors.add(executor.id);
  }
  return actors;
}

function hasActiveLifecycle(board: BoardProjection): boolean {
  return activeAttempts(board).length > 0 || board.activeVerification !== null || board.activeReview !== null;
}

function validateAttemptReference(
  board: BoardProjection,
  event: HarnessEvent,
): AttemptProjection | BoardProjection {
  if (!event.attemptId) return violation(board, event, "unknown-attempt", "attempt identity is missing");
  const attempt = board.attempts[event.attemptId];
  if (!attempt) return violation(board, event, "unknown-attempt", `attempt ${event.attemptId} does not exist`);
  if (event.taskId !== attempt.taskId) {
    return violation(board, event, "attempt-task-mismatch", `attempt ${attempt.id} belongs to ${attempt.taskId}, not ${event.taskId ?? "<missing>"}`);
  }
  return attempt;
}

export interface AcceptanceReadiness {
  ready: boolean;
  reasons: string[];
  verificationEventId?: string;
  reviewEventId?: string;
}

export function acceptanceReadiness(board: BoardProjection): AcceptanceReadiness {
  const contract = board.contract;
  if (!contract) return { ready: false, reasons: ["work contract is unavailable"] };

  const reasons: string[] = [];
  // Acceptance is the other reader that decides a Work is done, so it asks
  // the same question deriveState does. A Work nobody can be shown to have
  // authored is not acceptable, however good its verification.
  const unproven = authorshipUnproven(board);
  if (unproven !== null) reasons.push(`authorship is unproven: ${unproven}`);
  const currentVerifications = board.verifications.filter(
    (verification) => verification.contractRevision === board.contractRevision && verification.status === "pass",
  );
  const executionActors = executionActorIds(board);
  const qualifyingVerification = [...currentVerifications].reverse().find((verification) => {
    if (board.integration !== null && board.integration.headProof === null) return false;
    if (board.integration?.headProof !== null && board.integration?.headProof !== undefined
      && verification.eventId !== board.integration.headProof.verificationEventId) return false;
    if (!contract.verificationPolicy.independentActor) return true;
    return !executionActors.has(verification.actor.id);
  });

  const contractNeedsVerification =
    contract.verificationPolicy.required
    || contract.acceptanceCriteria.some((criterion) => criterion.required)
    || contract.requiredEvidence.some((requirement) => requirement.required);
  if (contractNeedsVerification && !qualifyingVerification) {
    reasons.push(board.integration === null
      ? "required passing verification for the current contract revision is missing"
      : "required passing verification bound to the exact Work integration head is missing");
  }

  if (qualifyingVerification) {
    const criterionStatus = new Map(
      qualifyingVerification.criterionResults.map((result) => [result.criterionId, result.status] as const),
    );
    for (const criterion of contract.acceptanceCriteria) {
      if (criterion.required && criterionStatus.get(criterion.id) !== "pass") {
        reasons.push(`required acceptance criterion ${criterion.id} is not proven passing`);
      }
    }

    const evidenceByRequirement = new Map(
      qualifyingVerification.evidenceSatisfaction.map((item) => [item.requirementId, item.evidence] as const),
    );
    for (const requirement of contract.requiredEvidence) {
      if (!requirement.required) continue;
      const evidence = evidenceByRequirement.get(requirement.id) ?? [];
      const acceptable = evidence.some((item) => evidenceSatisfiesRequirement(requirement, item));
      if (!acceptable) {
        reasons.push(`required evidence ${requirement.id} is not satisfied by an accepted evidence kind`);
      }
    }
  }

  // A verification in which nothing could have failed is an attestation. It may
  // still be the right answer for criteria that are genuinely human judgment,
  // but it cannot carry Work to accepted on its own: a person has to sign.
  if (qualifyingVerification) {
    if (!attestationSatisfied(board, qualifyingVerification)) {
      reasons.push(
        "every required criterion was exempted from falsifiable proof, so this verification attests rather than verifies and requires an independent passing review",
      );
    }
  }

  const currentReviews = board.reviews.filter(
    (review) => review.contractRevision === board.contractRevision && review.status === "pass",
  );
  const qualifyingReview = [...currentReviews].reverse().find((review) => !executionActors.has(review.actor.id));
  if (contract.verificationPolicy.reviewRequired && !qualifyingReview) {
    reasons.push("required independent passing review for the current contract revision is missing");
  }

  if (Object.keys(board.openDecisions).length > 0) reasons.push("open decisions remain unresolved");
  if (board.parkedReason !== null) reasons.push("Work is parked and must be released before acceptance");
  if (activeAttempts(board).length > 0) reasons.push("an execution attempt is still active");
  if (board.activeVerification?.contractRevision === board.contractRevision) reasons.push("verification is still active");
  if (board.activeReview?.contractRevision === board.contractRevision) reasons.push("review is still active");

  return {
    ready: reasons.length === 0,
    reasons,
    ...(qualifyingVerification ? { verificationEventId: qualifyingVerification.eventId } : {}),
    ...(qualifyingReview ? { reviewEventId: qualifyingReview.eventId } : {}),
  };
}

/**
 * Whether one evidence item can satisfy a required EvidenceRequirement.
 *
 * Artifact identity is Harness-generated: it states which artifact was
 * examined, not that anything about it was checked. Accepting it as proof lets
 * the Harness certify its own Work. Both readers of the rule call this, because
 * a rule enforced at the acceptance gate but not at the moment of verification
 * is a rule the receipt disagrees with. See issue #14.
 */
export function evidenceSatisfiesRequirement(
  requirement: Pick<EvidenceRequirement, "acceptedKinds">,
  item: EvidenceRef,
): boolean {
  return item.kind !== "artifact-identity" && requirement.acceptedKinds.includes(item.kind);
}

/**
 * A verification in which every required criterion was exempted from
 * falsifiable proof. It attests; it does not verify.
 */
export function isAttestationOnly(verification: VerificationProjection): boolean {
  return verification.falsifiability.provenCriteria.length === 0
    && verification.falsifiability.exemptedCriteria.length > 0;
}

/**
 * Whether an attestation-only verification has been signed for.
 *
 * This owns BOTH halves: whether the rule applies, and what satisfies it. An
 * earlier version exported only the predicate, and each caller then decided
 * separately what counted as attested. Only one of them required the signer to
 * be independent, so a review signed by the actor that ran the attempt
 * satisfied the projection and was refused at the acceptance gate. Board state
 * is what a person reads, so the rule was enforced where it blocks and silently
 * not enforced where it reports. See issue #54.
 *
 * Extracting a predicate is not enough when the consequence carries its own
 * condition. The condition is the part that drifts.
 */
export function attestationSatisfied(
  board: BoardProjection,
  verification: VerificationProjection,
): boolean {
  if (!isAttestationOnly(verification)) return true;
  const executionActors = executionActorIds(board);
  return board.reviews.some(
    (review) => review.contractRevision === board.contractRevision
      && review.status === "pass"
      && !executionActors.has(review.actor.id),
  );
}

/**
 * Can the Board establish that a worker actually authored the candidate this
 * Work is about to be called done for?
 *
 * The defect this answers: a Work whose candidate was produced elsewhere and
 * replayed into the Ledger by an operator projected to `ready` with zero
 * violations, indistinguishable from a Work a real worker executed. Readiness
 * was derived from the SHAPE of the event sequence, and shape is exactly what
 * a well-meaning adapter reproduces.
 *
 * So readiness now also asks what the attempt LEFT BEHIND while running:
 *
 *   - a workspace it actually held (SHIP only: a lease with a workspaceId),
 *   - at least one Guard-mediated write it was allowed to make (SHIP only),
 *   - at least one execution observation it streamed while working.
 *
 * These are chosen because a worker cannot avoid producing them and an
 * ingest path does not produce them incidentally. `task.assigned` and
 * `attempt.started` are deliberately NOT accepted as authorship: naming a
 * worker is a claim, and the adapter that caused this defect made exactly
 * that claim. Nor is the absence of an "ingest"-shaped event id evidence;
 * that is a naming convention and one rename defeats it.
 *
 * This is containment, not proof. The Ledger is an unkeyed hash chain, so
 * anything here can be minted by whoever writes the file. What it removes is
 * the ability to reach `ready` WITHOUT claiming, in typed fields, that a
 * worker ran. Honest tooling can no longer produce a green by accident, and
 * a forgery has to be deliberate and explicit. Authenticated events are what
 * would make this proof; see the authority boundary in ADR 0067.
 *
 * Returns null when authorship holds, or the reason it does not.
 */
export function authorshipUnproven(board: BoardProjection): string | null {
  const headCheckpoint = board.integration?.headProof === null || board.integration?.headProof === undefined
    ? undefined
    : board.integration.checkpoints[board.integration.headProof.checkpointId];
  if (board.integration?.headProof !== null && board.integration?.headProof !== undefined && headCheckpoint === undefined) {
    return `integrated head proof references missing checkpoint ${board.integration.headProof.checkpointId}`;
  }
  // Readiness rests on whichever attempts produced the integrated candidate;
  // stale checkpoints describe candidates the integration head no longer uses.
  // With no integrated head yet, readiness rests on finished attempts.
  const restingOn = headCheckpoint !== undefined
    ? [headCheckpoint.attemptId]
    : Object.values(board.attempts).filter((attempt) => attempt.state === "finished").map((attempt) => attempt.id);

  if (restingOn.length === 0) return "no finished Attempt carries this Work";

  const requiresCandidate = board.contract?.type === "SHIP";
  for (const attemptId of restingOn) {
    const attempt = board.attempts[attemptId];
    // Absence of evidence is not evidence of authorship.
    if (attempt === undefined) return `attempt ${attemptId} is not on this Board`;
    if (attempt.observationCount === 0) {
      return `attempt ${attemptId} streamed no execution observation`;
    }
    if (!requiresCandidate) continue;
    if (attempt.workspaceId === undefined) {
      return `attempt ${attemptId} never held a workspace`;
    }
    const guardedWrites = board.guardEvaluations.filter((evaluation) =>
      evaluation.request.attemptId === attemptId
      && evaluation.request.tool.category === "write"
      && evaluation.verdict.decision === "allow"
    ).length;
    if (guardedWrites === 0) {
      return `attempt ${attemptId} produced no Guard-mediated write`;
    }
  }
  return null;
}

function deriveState(board: BoardProjection): WorkState {
  if (terminalStates.has(board.state)) return board.state;
  if (board.parkedReason !== null) return "parked";
  if (Object.keys(board.openDecisions).length > 0) return "blocked";

  const attempts = Object.values(board.attempts);
  if (attempts.some((attempt) => attempt.state === "blocked")) return "blocked";
  if (attempts.some((attempt) => attempt.state === "running")) return "running";
  if (board.activeReview?.contractRevision === board.contractRevision) return "reviewing";
  if (board.activeVerification?.contractRevision === board.contractRevision) return "verifying";

  const latestReview = board.reviews.at(-1);
  if (board.contract?.verificationPolicy.reviewRequired && latestReview?.contractRevision === board.contractRevision) {
    if (latestReview.status === "pass") {
      if (authorshipUnproven(board) !== null) return "unverifiable";
      return "ready";
    }
  }

  const latestVerification = board.verifications.at(-1);
  if (attempts.some((attempt) => attempt.state === "finished") && board.contract?.verificationPolicy.required) {
    if (!latestVerification || latestVerification.contractRevision !== board.contractRevision || latestVerification.status !== "pass") {
      return "verifying";
    }
    if (board.contract.verificationPolicy.reviewRequired) return "reviewing";
    // Nothing in this verification could have failed, so an independent person
    // still has to sign before it is ready. Both readers call the same function
    // so neither can drift from the other.
    if (!attestationSatisfied(board, latestVerification)) return "reviewing";
    // Verification proves the candidate is good. It does not prove a worker
    // wrote it. A Work whose authorship cannot be established is unfinished,
    // and must never be readable as done by anyone deciding it is done.
    if (authorshipUnproven(board) !== null) return "unverifiable";
    return "ready";
  }

  if (attempts.length > 0 && attempts.every((attempt) => attempt.state === "failed")) return "failed";
  if (Object.keys(board.tasks).length > 0) {
    if (attempts.some((attempt) => attempt.state === "finished") && authorshipUnproven(board) !== null) {
      return "unverifiable";
    }
    return "ready";
  }
  return "proposed";
}

export function projectEvent(input: BoardProjection, event: HarnessEvent): BoardProjection {
  if (input.seenEventIds[event.id]) {
    return violation(input, event, "duplicate-event", `event ${event.id} was already projected`);
  }

  let board: BoardProjection = {
    ...input,
    seenEventIds: { ...input.seenEventIds, [event.id]: true },
    lastEventId: event.id,
  };

  if (event.type === "work.created") {
    if (board.contract) return violation(board, event, "duplicate-work-created", "work.created may occur only once per projection");
    if (event.payload.contract.id !== event.workId) {
      return violation(board, event, "work-id-mismatch", "event workId differs from WorkContract id");
    }
    board = {
      ...board,
      workId: event.workId,
      contract: event.payload.contract,
      contractRevision: 1,
    };
    return { ...board, state: deriveState(board) };
  }

  if (!board.contract || !board.workId) {
    return violation(board, event, "event-before-work-created", `${event.type} arrived before work.created`);
  }
  if (event.workId !== board.workId) {
    return violation(board, event, "work-id-mismatch", `expected ${board.workId}, received ${event.workId}`);
  }
  if (terminalStates.has(board.state)) {
    if (event.type === "attempt.activity-observed") {
      const attempt = validateAttemptReference(board, event);
      if ("violations" in attempt) return attempt;
      return board;
    }
    if (event.type === "integration.execution-observed") return applyExecutionObservation(board, event);
    if (postTerminalRecordOnlyTypes.has(event.type)) return board;
    return violation(board, event, "event-after-terminal", `${event.type} cannot change terminal work state ${board.state}`);
  }

  switch (event.type) {
    case "work.amended": {
      if (hasActiveLifecycle(board)) {
        return violation(board, event, "amendment-during-active-work", "work cannot be amended while an attempt, verification, or review is active");
      }
      if (event.payload.revision !== board.contractRevision + 1) {
        return violation(board, event, "revision-mismatch", `expected revision ${board.contractRevision + 1}`);
      }
      try {
        board = {
          ...board,
          contract: applyAmendment(board.contract, event.payload.changes),
          contractRevision: event.payload.revision,
        };
      } catch (error) {
        return violation(board, event, "invalid-amendment", error instanceof Error ? error.message : "invalid amendment");
      }
      break;
    }
    case "task.created": {
      if (!event.taskId) break;
      if (board.tasks[event.taskId]) {
        return violation(board, event, "duplicate-task", `task ${event.taskId} already exists`);
      }
      board = {
        ...board,
        tasks: { ...board.tasks, [event.taskId]: { id: event.taskId, objective: event.payload.objective } },
      };
      break;
    }
    case "task.assigned": {
      if (!event.taskId) break;
      const task = board.tasks[event.taskId];
      if (!task) return violation(board, event, "unknown-task", `task ${event.taskId} does not exist`);
      board = {
        ...board,
        tasks: { ...board.tasks, [event.taskId]: { ...task, assignedWorker: event.payload.worker } },
      };
      break;
    }
    case "attempt.started": {
      if (!event.attemptId || !event.taskId) break;
      if (board.parkedReason !== null) {
        return violation(board, event, "invalid-work-lifecycle-transition", "a parked Work must be released before an Attempt starts");
      }
      const task = board.tasks[event.taskId];
      if (!task) return violation(board, event, "unknown-task", `task ${event.taskId} does not exist`);
      if (board.attempts[event.attemptId]) {
        return violation(board, event, "duplicate-attempt", `attempt ${event.attemptId} already exists`);
      }
      if (task.assignedWorker && task.assignedWorker.id !== event.payload.worker.id) {
        return violation(board, event, "worker-assignment-mismatch", `task ${event.taskId} is assigned to ${task.assignedWorker.id}, not ${event.payload.worker.id}`);
      }
      if (event.payload.contractRevision !== board.contractRevision) {
        return violation(board, event, "revision-mismatch", "attempt started against a stale contract revision");
      }
      const lease = event.payload.lease;
      if (board.integration !== null && lease === undefined) {
        return violation(board, event, "attempt-lease-required", "an integrated Work Attempt must carry a revocable lease");
      }
      if (lease !== undefined) {
        if (Date.parse(lease.expiresAt) <= Date.parse(event.recordedAt)) {
          return violation(board, event, "attempt-lease-expired", `attempt lease ${lease.id} is already expired`);
        }
        const conflict = findResourceLeaseConflict(board, lease);
        if (conflict !== null) {
          return violation(board, event, "resource-lease-conflict", `attempt ${event.attemptId} overlaps the active resource lease held by ${conflict.id}`);
        }
      }
      board = {
        ...board,
        attempts: {
          ...board.attempts,
          [event.attemptId]: {
            id: event.attemptId,
            taskId: event.taskId,
            worker: event.payload.worker,
            executionProvenance: [event.payload.worker],
            contractRevision: event.payload.contractRevision,
            state: "running",
            ...(board.integration === null ? {} : { integrationBaseHead: board.integration.head }),
            ...(lease === undefined ? {} : { workspaceId: lease.workspaceId }),
            ...(lease === undefined ? {} : { lease }),
            observationCount: 0,
          },
        },
      };
      break;
    }
    case "attempt.lease-transferred": {
      const attempt = validateAttemptReference(board, event);
      if ("violations" in attempt) return attempt;
      if (attempt.state !== "running" || attempt.lease === undefined || attempt.lease.id !== event.payload.fromLeaseId) {
        return violation(board, event, "attempt-lease-mismatch", "attempt takeover must name a live running attempt lease");
      }
      if (Date.parse(attempt.lease.expiresAt) <= Date.parse(event.recordedAt)) {
        return violation(board, event, "attempt-lease-expired", `attempt takeover names expired lease ${attempt.lease.id}`);
      }
      if (Date.parse(event.payload.lease.expiresAt) <= Date.parse(event.recordedAt)) {
        return violation(board, event, "attempt-lease-expired", `attempt takeover lease ${event.payload.lease.id} is already expired`);
      }
      const conflict = findResourceLeaseConflict(board, event.payload.lease, attempt.id);
      if (conflict !== null) {
        return violation(board, event, "resource-lease-conflict", `attempt takeover overlaps the active resource lease held by ${conflict.id}`);
      }
      board = {
        ...board,
        attempts: {
          ...board.attempts,
          [attempt.id]: {
            ...attempt,
            worker: event.payload.worker,
            executionProvenance: [...attempt.executionProvenance, event.payload.worker],
            workspaceId: event.payload.lease.workspaceId,
            lease: event.payload.lease,
          },
        },
      };
      break;
    }
    case "attempt.activity-observed": {
      const attempt = validateAttemptReference(board, event);
      if ("violations" in attempt) return attempt;
      board = {
        ...board,
        attempts: {
          ...board.attempts,
          [attempt.id]: { ...attempt, observationCount: attempt.observationCount + 1 },
        },
      };
      break;
    }
    case "attempt.blocked":
    case "attempt.finished":
    case "attempt.failed": {
      const attempt = validateAttemptReference(board, event);
      if ("violations" in attempt) return attempt;
      const desired = event.type === "attempt.blocked" ? "blocked" : event.type === "attempt.finished" ? "finished" : "failed";
      const valid = attempt.state === "running" || (attempt.state === "blocked" && desired !== "blocked");
      if (!valid) {
        return violation(board, event, "invalid-attempt-transition", `attempt ${attempt.id} cannot transition from ${attempt.state} to ${desired}`);
      }
      const { lease: _releasedLease, ...withoutLease } = attempt;
      board = {
        ...board,
        attempts: {
          ...board.attempts,
          [attempt.id]: desired === "blocked" ? { ...attempt, state: desired } : { ...withoutLease, state: desired },
        },
      };
      break;
    }
    case "authority.granted":
    case "authority.denied": {
      board = {
        ...board,
        authorityDecisions: [
          ...board.authorityDecisions,
          {
            eventId: event.id,
            decision: event.type === "authority.granted" ? "granted" : "denied",
            reason: event.payload.reason ?? "",
          },
        ],
      };
      break;
    }
    case "guard.evaluated": {
      board = {
        ...board,
        guardEvaluations: [
          ...board.guardEvaluations,
          { eventId: event.id, ...event.payload },
        ],
      };
      break;
    }
    case "decision.requested": {
      if (board.openDecisions[event.payload.decisionId] || board.resolvedDecisions[event.payload.decisionId]) {
        return violation(board, event, "duplicate-decision", `decision ${event.payload.decisionId} already exists`);
      }
      board = {
        ...board,
        openDecisions: { ...board.openDecisions, [event.payload.decisionId]: event.payload.question },
      };
      break;
    }
    case "decision.resolved": {
      if (!board.openDecisions[event.payload.decisionId]) {
        return violation(board, event, "unknown-decision", `decision ${event.payload.decisionId} is not open`);
      }
      const { [event.payload.decisionId]: _removed, ...remaining } = board.openDecisions;
      board = {
        ...board,
        openDecisions: remaining,
        resolvedDecisions: {
          ...board.resolvedDecisions,
          [event.payload.decisionId]: {
            eventId: event.id,
            resolution: event.payload.resolution,
            actor: event.actor,
          },
        },
      };
      break;
    }
    case "verification.started": {
      if (board.parkedReason !== null) {
        return violation(board, event, "invalid-work-lifecycle-transition", "a parked Work must be released before a verification starts");
      }
      if (event.payload.contractRevision !== board.contractRevision) {
        return violation(board, event, "revision-mismatch", "verification started against a stale contract revision");
      }
      if (board.activeVerification) {
        return violation(board, event, "verification-already-active", `verification ${board.activeVerification.id} is already active`);
      }
      board = {
        ...board,
        activeVerification: {
          id: event.payload.verificationId,
          contractRevision: event.payload.contractRevision,
          actor: event.actor,
        },
      };
      break;
    }
    case "verification.result": {
      if (event.payload.contractRevision !== board.contractRevision) {
        return violation(board, event, "revision-mismatch", "verification result references a stale contract revision");
      }
      const active = board.activeVerification;
      if (!active || active.id !== event.payload.verificationId || active.contractRevision !== event.payload.contractRevision || active.actor.id !== event.actor.id) {
        return violation(board, event, "verification-not-active", `verification result ${event.payload.verificationId} does not match the active verification lifecycle`);
      }
      board = {
        ...board,
        activeVerification: null,
        verifications: [
          ...board.verifications,
          {
            eventId: event.id,
            verificationId: event.payload.verificationId,
            contractRevision: event.payload.contractRevision,
            actor: event.actor,
            status: event.payload.status,
            criterionResults: event.payload.criterionResults.map(({ criterionId, status }) => ({ criterionId, status })),
            evidenceSatisfaction: event.payload.evidenceSatisfaction.map((item) => ({
              requirementId: item.requirementId,
              evidence: item.evidence.map((evidence) => ({ ...evidence })),
            })),
            falsifiability: {
              provenCriteria: [...event.payload.falsifiability.provenCriteria],
              exemptedCriteria: event.payload.falsifiability.exemptedCriteria.map((item) => ({ ...item })),
            },
          },
        ],
      };
      break;
    }
    case "review.started": {
      if (board.parkedReason !== null) {
        return violation(board, event, "invalid-work-lifecycle-transition", "a parked Work must be released before a review starts");
      }
      if (event.payload.contractRevision !== board.contractRevision) {
        return violation(board, event, "revision-mismatch", "review started against a stale contract revision");
      }
      if (board.activeReview) {
        return violation(board, event, "review-already-active", `review ${board.activeReview.id} is already active`);
      }
      board = {
        ...board,
        activeReview: {
          id: event.payload.reviewId,
          contractRevision: event.payload.contractRevision,
          actor: event.actor,
        },
      };
      break;
    }
    case "review.finding": {
      const active = board.activeReview;
      if (!active || active.id !== event.payload.reviewId || active.actor.id !== event.actor.id) {
        return violation(board, event, "review-not-active", `review finding ${event.payload.reviewId} does not match the active review lifecycle`);
      }
      break;
    }
    case "review.result": {
      if (event.payload.contractRevision !== board.contractRevision) {
        return violation(board, event, "revision-mismatch", "review result references a stale contract revision");
      }
      const active = board.activeReview;
      if (!active || active.id !== event.payload.reviewId || active.contractRevision !== event.payload.contractRevision || active.actor.id !== event.actor.id) {
        return violation(board, event, "review-not-active", `review result ${event.payload.reviewId} does not match the active review lifecycle`);
      }
      board = {
        ...board,
        activeReview: null,
        reviews: [
          ...board.reviews,
          {
            eventId: event.id,
            reviewId: event.payload.reviewId,
            contractRevision: event.payload.contractRevision,
            actor: event.actor,
            status: event.payload.status,
          },
        ],
      };
      break;
    }
    case "work.accepted": {
      if (event.payload.contractRevision !== board.contractRevision) {
        return violation(board, event, "revision-mismatch", "acceptance references a stale contract revision");
      }
      const readiness = acceptanceReadiness(board);
      const executionActors = executionActorIds(board);
      if (executionActors.has(event.actor.id)) {
        readiness.reasons.push("an execution actor cannot accept its own work");
        readiness.ready = false;
      }
      if (!readiness.ready) {
        return violation(board, event, "acceptance-preconditions-not-met", readiness.reasons.join("; "));
      }
      return { ...board, state: "accepted", acceptedBy: event.actor };
    }
    case "work.rejected":
    case "work.cancelled": {
      if (event.payload.contractRevision !== board.contractRevision) {
        return violation(board, event, "revision-mismatch", `${event.type} references a stale contract revision`);
      }
      return { ...board, state: event.type === "work.rejected" ? "rejected" : "cancelled" };
    }
    case "work.parked": {
      if (board.parkedReason !== null || hasActiveLifecycle(board)) {
        return violation(board, event, "invalid-work-lifecycle-transition", "only an idle, unparked Work may be parked");
      }
      board = { ...board, parkedReason: event.payload.reason };
      break;
    }
    case "work.released": {
      if (board.parkedReason === null) {
        return violation(board, event, "invalid-work-lifecycle-transition", "only a parked Work may be released");
      }
      board = { ...board, parkedReason: null };
      break;
    }
    case "integration.initialized": {
      if (board.integration !== null) {
        return violation(board, event, "integration-already-initialized", "Work integration may be initialized only once");
      }
      if (hasActiveLifecycle(board)) {
        return violation(board, event, "integration-initialized-during-active-work", "Work integration requires an idle Work with no active Attempt or proof");
      }
      board = {
        ...board,
        integration: {
          configuration: event.payload.configuration,
          head: event.payload.configuration.head,
          checkpoints: {},
          queue: [],
          lock: null,
          headProof: null,
          reconciliations: {},
          taskStates: {},
          pullRequests: [],
          merge: { authority: "pending", status: "not-requested", detail: "merge authority has not been granted" },
          cleanups: {},
          failures: [],
          latestExecutionObservation: null,
          divergences: [],
        },
      };
      break;
    }
    case "integration.checkpoint-recorded": {
      const integration = board.integration;
      if (integration === null) {
        return violation(board, event, "integration-not-initialized", "checkpoint requires Work integration configuration");
      }
      const attempt = validateAttemptReference(board, event);
      if ("violations" in attempt) return attempt;
      if (attempt.state === "failed" || attempt.workspaceId === undefined || event.payload.checkpoint.workspaceId !== attempt.workspaceId) {
        return violation(board, event, "checkpoint-attempt-mismatch", "checkpoint must bind to its Attempt workspace identity");
      }
      if (event.payload.checkpoint.class === "integration-candidate" && event.payload.checkpoint.parentIntegrationHead !== integration.head) {
        return violation(board, event, "checkpoint-integration-head-mismatch", "checkpoint parent must equal the current Work integration head");
      }
      if (integration.checkpoints[event.payload.checkpoint.id] !== undefined) {
        return violation(board, event, "duplicate-integration-checkpoint", `checkpoint ${event.payload.checkpoint.id} is already recorded`);
      }
      if (event.payload.checkpoint.class === "integration-candidate") {
        const proof = board.verifications.find((item) => item.eventId === event.payload.checkpoint.verificationEventId);
        if (proof?.status !== "pass" || proof.contractRevision !== board.contractRevision) {
          return violation(board, event, "checkpoint-candidate-ineligible", "integration candidate must reference a passing verification for the current Work revision");
        }
        if (event.payload.checkpoint.remoteStatus !== "pushed" || event.payload.checkpoint.remoteRef === undefined) {
          return violation(board, event, "integration-candidate-not-remote", "integration candidate must be durably pushed before it enters shared Work truth");
        }
      }
      board = {
        ...board,
        integration: {
          ...integration,
          checkpoints: {
            ...integration.checkpoints,
            [event.payload.checkpoint.id]: {
              eventId: event.id,
              taskId: event.taskId!,
              attemptId: event.attemptId!,
              checkpoint: event.payload.checkpoint,
              effectiveProofState: event.payload.checkpoint.proofState,
            },
          },
        },
      };
      break;
    }
    case "integration.candidate-queued": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "candidate queue requires Work integration configuration");
      const checkpoint = integration.checkpoints[event.payload.checkpointId];
      if (checkpoint === undefined || checkpoint.checkpoint.class !== "integration-candidate" || checkpoint.effectiveProofState !== "passed") {
        return violation(board, event, "checkpoint-candidate-ineligible", "only a passing integration candidate may enter the queue");
      }
      if (checkpoint.checkpoint.remoteStatus !== "pushed") {
        return violation(board, event, "integration-candidate-not-remote", "candidate must be remotely preserved before queueing");
      }
      if (checkpoint.checkpoint.parentIntegrationHead !== integration.head) {
        return violation(board, event, "checkpoint-integration-head-mismatch", "queued candidate was derived from a stale integration head");
      }
      if (integration.queue.includes(event.payload.checkpointId)) {
        return violation(board, event, "integration-candidate-already-queued", `checkpoint ${event.payload.checkpointId} is already queued`);
      }
      board = { ...board, integration: { ...integration, queue: [...integration.queue, event.payload.checkpointId] } };
      break;
    }
    case "integration.lock-acquired": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "integration lock requires Work integration configuration");
      if (integration.lock !== null) return violation(board, event, "integration-lock-held", `integration lock ${integration.lock.id} is already held`);
      if (integration.queue[0] !== event.payload.checkpointId) {
        return violation(board, event, "integration-queue-order", "only the first queued candidate may acquire the serialized integration lock");
      }
      if (event.payload.expectedHead !== integration.head) {
        return violation(board, event, "integration-head-mismatch", "integration lock expected a stale Work head");
      }
      board = {
        ...board,
        integration: {
          ...integration,
          lock: {
            eventId: event.id,
            id: event.payload.lockId,
            checkpointId: event.payload.checkpointId,
            expectedHead: event.payload.expectedHead,
          },
        },
      };
      break;
    }
    case "integration.task-reconciled": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "task reconciliation requires Work integration configuration");
      const attempt = validateAttemptReference(board, event);
      if ("violations" in attempt) return attempt;
      const checkpoint = integration.checkpoints[event.payload.checkpointId];
      if (checkpoint === undefined || checkpoint.attemptId !== attempt.id) {
        return violation(board, event, "integration-reconciliation-mismatch", "task reconciliation must name its Attempt checkpoint");
      }
      if (attempt.integrationBaseHead === undefined || attempt.integrationBaseHead === integration.head) {
        return violation(board, event, "integration-task-not-stale", "only an Attempt derived from an older Work head may reconcile");
      }
      if (event.payload.previousBaseHead !== attempt.integrationBaseHead || event.payload.newBaseHead !== integration.head) {
        return violation(board, event, "integration-reconciliation-mismatch", "task reconciliation heads do not match Board truth");
      }
      if (event.payload.status === "clean" && (event.payload.proofHead !== event.payload.head || event.evidence.length === 0)) {
        return violation(board, event, "integration-proof-mismatch", "clean task reconciliation requires affected proof bound to the reconciled head");
      }
      board = {
        ...board,
        attempts: event.payload.status === "clean"
          ? { ...board.attempts, [attempt.id]: { ...attempt, integrationBaseHead: integration.head } }
          : board.attempts,
        integration: {
          ...integration,
          reconciliations: {
            ...integration.reconciliations,
            [attempt.id]: {
              eventId: event.id,
              taskId: attempt.taskId,
              attemptId: attempt.id,
              ...event.payload,
            },
          },
        },
      };
      break;
    }
    case "integration.head-advanced": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "head advancement requires Work integration configuration");
      if (integration.lock?.id !== event.payload.lockId || integration.lock.checkpointId !== event.payload.checkpointId) {
        return violation(board, event, "integration-lock-mismatch", "head advancement must own the active serialized integration lock");
      }
      if (integration.queue[0] !== event.payload.checkpointId) {
        return violation(board, event, "integration-queue-order", "head advancement must consume the first queued candidate");
      }
      if (event.payload.previousHead !== integration.head) {
        return violation(board, event, "integration-head-mismatch", "head advancement expected a stale Work integration head");
      }
      if (event.payload.proofHead !== event.payload.head) {
        return violation(board, event, "integration-proof-mismatch", "final proof must bind to the exact advanced head");
      }
      const proof = board.verifications.find((item) => item.eventId === event.payload.verificationEventId);
      if (proof?.status !== "pass" || proof.contractRevision !== board.contractRevision) {
        return violation(board, event, "integration-proof-mismatch", "head advancement requires passing proof for the current Work revision");
      }
      const checkpoints: Record<string, IntegrationCheckpointProjection> = Object.fromEntries(Object.entries(integration.checkpoints).map(([checkpointId, checkpoint]) => [
        checkpointId,
        {
          ...checkpoint,
          effectiveProofState: checkpointId === event.payload.checkpointId ? "passed" as const : "stale" as const,
        },
      ]));
      board = {
        ...board,
        integration: {
          ...integration,
          head: event.payload.head,
          checkpoints,
          queue: integration.queue.slice(1),
          lock: null,
          headProof: {
            eventId: event.id,
            checkpointId: event.payload.checkpointId,
            head: event.payload.head,
            tree: event.payload.tree,
            verificationEventId: event.payload.verificationEventId,
            remoteRef: event.payload.remoteRef,
          },
        },
      };
      break;
    }
    case "integration.failed": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "integration failure requires Work integration configuration");
      if (event.payload.lockId !== undefined && integration.lock?.id !== event.payload.lockId) {
        return violation(board, event, "integration-lock-mismatch", "integration failure does not own the active lock");
      }
      board = {
        ...board,
        integration: {
          ...integration,
          lock: null,
          queue: event.payload.semanticConflict
            ? integration.queue.filter((checkpointId) => checkpointId !== event.payload.checkpointId)
            : integration.queue,
          failures: [...integration.failures, {
            eventId: event.id,
            checkpointId: event.payload.checkpointId,
            reason: event.payload.reason,
            semanticConflict: event.payload.semanticConflict,
            preservedRefs: event.payload.preservedRefs,
          }],
        },
      };
      break;
    }
    case "integration.pull-request-associated": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "pull request ownership requires Work integration configuration");
      if (integration.pullRequests.length > 0 && event.payload.pullRequest.splitDecisionId === undefined) {
        return violation(board, event, "integration-pr-conflict", `Work already owns pull request ${integration.pullRequests[0]!.id}`);
      }
      board = { ...board, integration: { ...integration, pullRequests: [...integration.pullRequests, event.payload.pullRequest] } };
      break;
    }
    case "integration.merge-updated": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "merge state requires Work integration configuration");
      if (event.payload.authority === "authorized" && event.payload.decisionId === undefined) {
        return violation(board, event, "integration-merge-authority-missing", "merge authorization requires a durable decision identity");
      }
      if (event.payload.authority === "authorized"
        && (event.payload.decisionId === undefined || board.resolvedDecisions[event.payload.decisionId]?.actor.kind !== "human")) {
        return violation(board, event, "integration-merge-authority-missing", "merge authorization requires a durable human-resolved decision");
      }
      if (event.payload.status === "merged" && (event.payload.authority !== "authorized" || event.payload.decisionId === undefined)) {
        return violation(board, event, "integration-merge-authority-missing", "merged status requires authorized merge authority and a durable decision identity");
      }
      board = {
        ...board,
        integration: {
          ...integration,
          merge: {
            authority: event.payload.authority,
            status: event.payload.status,
            detail: event.payload.detail,
            ...(event.payload.decisionId === undefined ? {} : { decisionId: event.payload.decisionId }),
          },
        },
      };
      break;
    }
    case "integration.cleanup-recorded": {
      const integration = board.integration;
      if (integration === null) return violation(board, event, "integration-not-initialized", "cleanup requires Work integration configuration");
      const attempt = validateAttemptReference(board, event);
      if ("violations" in attempt) return attempt;
      const checkpoint = event.payload.checkpointId === undefined ? undefined : integration.checkpoints[event.payload.checkpointId];
      const integrated = checkpoint !== undefined && integration.headProof?.checkpointId === checkpoint.checkpoint.id;
      const rescued = checkpoint?.checkpoint.remoteStatus === "pushed";
      const discarded = event.payload.disposition === "discarded" && event.actor.kind === "human" && event.payload.authorityDecisionId !== undefined;
      if ((event.payload.disposition === "integrated" && !integrated)
        || (event.payload.disposition === "rescue-preserved" && !rescued)
        || (event.payload.disposition === "discarded" && !discarded)) {
        return violation(board, event, "integration-cleanup-unsafe", "unique work is neither integrated, remotely preserved, nor explicitly discarded");
      }
      board = {
        ...board,
        integration: {
          ...integration,
          cleanups: {
            ...integration.cleanups,
            [attempt.id]: {
              eventId: event.id,
              disposition: event.payload.disposition,
              ...(event.payload.checkpointId === undefined ? {} : { checkpointId: event.payload.checkpointId }),
            },
          },
        },
      };
      break;
    }
    case "integration.execution-observed": {
      const observed = applyExecutionObservation(board, event);
      if (observed.violations.length !== board.violations.length) return observed;
      board = observed;
      break;
    }
    default:
      break;
  }

  return { ...board, state: deriveState(board) };
}

export function projectBoard(events: readonly HarnessEvent[]): BoardProjection {
  return withDerivedIntegrationTaskStates(events.reduce(projectEvent, emptyBoard()));
}
