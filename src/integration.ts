import { z } from "zod";

import { findResourceLeaseConflict, projectBoard, type BoardProjection } from "./board.js";
import type { EventLedger } from "./ledger.js";
import { streamIdForWork } from "./refiner.js";
import type {
  ActorRef,
  AttemptLease,
  HarnessEvent,
  IntegrationCheckpoint,
  IntegrationPullRequest,
  WorkExecutionObservation,
  WorkIntegrationConfiguration,
} from "./schemas.js";
import {
  ActorRefSchema,
  AttemptLeaseSchema,
  EvidenceRefSchema,
  IntegrationCheckpointSchema,
  IntegrationPullRequestSchema,
  TimestampSchema,
  WorkExecutionObservationSchema,
  WorkIntegrationConfigurationSchema,
  parseHarnessEvent,
} from "./schemas.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);

export class IntegrationControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationControllerError";
  }
}

export class IntegrationHorizonExceededError extends IntegrationControllerError {
  constructor(readonly policyId: string, readonly signals: readonly string[] = []) {
    super(signals.length === 0
      ? `integration horizon ${policyId} requires a durable checkpoint and convergence before more write work`
      : `integration horizon ${policyId} requires convergence before more write work (${signals.join(", ")})`);
    this.name = "IntegrationHorizonExceededError";
  }
}

/**
 * Durability of a candidate's unique bytes. `pushed` is the only state in which
 * losing this machine loses nothing. The other three all mean unique local
 * bytes with no remote copy, which ADR 0023 refuses to grandfather.
 */
export type UpstreamState = "pushed" | "ahead-of-remote" | "no-upstream" | "upstream-gone";

export interface IntegrationHorizonSignals {
  commitsAhead: number;
  /** Commits on the integration ref that this candidate does not have. */
  commitsBehind: number;
  /**
   * Time since the *last convergence*. For a candidate that has never
   * converged this is not divergence age; see `divergenceAgeMs`.
   */
  elapsedMsSinceConvergence: number;
  /**
   * Time since divergence began: the age of the oldest candidate-only commit
   * after the merge base. The merge base's own age says nothing about how long
   * private work has been accumulating.
   */
  divergenceAgeMs: number;
  /** Added plus deleted lines against the merge base. Lines, not bytes. */
  diffLines: number;
  /** Binary files are counted, never coerced into a line count of zero. */
  binaryFilesChanged: number;
  upstreamState: UpstreamState;
  overlappingResourceClaims: number;
  integrationHeadMoved: boolean;
  proofInvalidationRisk: boolean;
}

/**
 * `provisional` was a literal `true` while no calibration existed. ADR 0023
 * supplies one, so the field becomes a lifecycle rather than an assertion that
 * calibration is permanently absent.
 */
export type HorizonPolicyStatus = "provisional" | "calibrated";

export interface IntegrationHorizonPolicy {
  readonly id: string;
  readonly status: HorizonPolicyStatus;
  requiresConvergence(signals: IntegrationHorizonSignals): boolean;
}

/**
 * The policy deliberately uses no fixed numeric cap. Until dogfood supplies a
 * calibrated limit, any observed private advancement requires a safe checkpoint
 * and convergence rather than allowing unbounded history to accumulate.
 */
export const PROVISIONAL_INTEGRATION_HORIZON: IntegrationHorizonPolicy = Object.freeze({
  id: "provisional-converge-on-private-advancement",
  status: "provisional" as const,
  requiresConvergence(signals: IntegrationHorizonSignals): boolean {
    return signals.commitsAhead > 0
      || signals.diffLines > 0
      || signals.overlappingResourceClaims > 0
      || signals.integrationHeadMoved
      || signals.proofInvalidationRisk;
  },
});

export function integrationCheckpointIsEligible(
  checkpoint: IntegrationCheckpoint,
  integrationHead: string,
): boolean {
  return checkpoint.class === "integration-candidate"
    && checkpoint.parentIntegrationHead === integrationHead
    && checkpoint.proofState === "passed"
    && checkpoint.proofHead === checkpoint.head
    && checkpoint.verificationEventId !== undefined;
}

export const StartIntegratedAttemptRequestSchema = z.object({
  taskId: id,
  attemptId: id,
  worker: ActorRefSchema,
  lease: AttemptLeaseSchema,
}).strict();
export type StartIntegratedAttemptRequest = z.infer<typeof StartIntegratedAttemptRequestSchema>;

export const TakeOverIntegratedAttemptRequestSchema = z.object({
  taskId: id,
  attemptId: id,
  worker: ActorRefSchema,
  lease: AttemptLeaseSchema,
  reason: text.max(2000),
}).strict();
export type TakeOverIntegratedAttemptRequest = z.infer<typeof TakeOverIntegratedAttemptRequestSchema>;

export const RecordIntegrationCheckpointRequestSchema = z.object({
  taskId: id,
  attemptId: id,
  checkpoint: IntegrationCheckpointSchema,
}).strict();
export type RecordIntegrationCheckpointRequest = z.infer<typeof RecordIntegrationCheckpointRequestSchema>;

export const AssociateIntegrationPullRequestSchema = IntegrationPullRequestSchema;
export type AssociateIntegrationPullRequest = z.infer<typeof AssociateIntegrationPullRequestSchema>;

export const AuthorizeIntegrationCleanupRequestSchema = z.object({
  attemptId: id,
  disposition: z.enum(["integrated", "rescue-preserved", "discarded"]),
  checkpointId: id.optional(),
  authorityDecisionId: id.optional(),
}).strict();
export type AuthorizeIntegrationCleanupRequest = z.infer<typeof AuthorizeIntegrationCleanupRequestSchema>;

export interface IntegrationExecutionRequest {
  readonly purpose: "integrate-candidate" | "reconcile-stale-attempt";
  readonly workId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly checkpoint: IntegrationCheckpoint;
  readonly integrationRef: string;
  readonly integrationHead: string;
}

const IntegratedExecutionResultSchema = z.object({
  status: z.literal("integrated"),
  head: text.max(300),
  tree: text.max(300),
  proofHead: text.max(300),
  verificationEventId: id,
  remoteRef: text.max(500),
}).strict();
const ReconciledExecutionResultSchema = z.object({
  status: z.literal("reconciled"),
  head: text.max(300),
  tree: text.max(300),
  proofHead: text.max(300),
  evidence: z.array(EvidenceRefSchema).min(1),
  remoteRef: text.max(500),
}).strict();
const ConflictExecutionResultSchema = z.object({
  status: z.literal("conflict"),
  reason: text.max(4000),
  preservedRefs: z.array(text.max(500)).min(2),
}).strict();
const FailedExecutionResultSchema = z.object({
  status: z.literal("failed"),
  reason: text.max(4000),
  preservedRefs: z.array(text.max(500)).default([]),
}).strict();
export const IntegrationExecutionResultSchema = z.discriminatedUnion("status", [
  IntegratedExecutionResultSchema,
  ReconciledExecutionResultSchema,
  ConflictExecutionResultSchema,
  FailedExecutionResultSchema,
]);
export type IntegrationExecutionResult = z.infer<typeof IntegrationExecutionResultSchema>;

export interface WorkIntegrationExecutor {
  reconcile(request: IntegrationExecutionRequest): Promise<IntegrationExecutionResult>;
}

export interface IntegrationControllerInvariant {
  readonly id: `integration/${string}`;
  readonly invariant: string;
  readonly falsifier: string;
}

/** Issue #77's executable safety contract, kept beside the controller it binds. */
export const INTEGRATION_CONTROLLER_INVARIANTS = [
  { id: "integration/one-work-one-ref", invariant: "One Work owns one durable integration ref and one mutable head.", falsifier: "Create or advance a shadow Work ref without a split decision." },
  { id: "integration/task-base-is-explicit", invariant: "Every Attempt records the Work integration head from which its workspace derives.", falsifier: "Start an integrated Attempt whose Board projection has no base head." },
  { id: "integration/checkpoint-is-remote", invariant: "Candidate bytes are pushed and read back before entering the integration queue.", falsifier: "Queue an integration candidate whose remote status is local-only or whose remote ref is absent." },
  { id: "integration/eligibility-queues-automatically", invariant: "A current, passing, remotely durable candidate enters the Work queue automatically.", falsifier: "Record an eligible candidate and observe an empty queue." },
  { id: "integration/one-serialized-lock", invariant: "At most one queue head is integrated under one durable Work lock.", falsifier: "Run two integration executors concurrently or integrate a non-head checkpoint." },
  { id: "integration/proof-binds-exact-head", invariant: "The Work head advances only with passing proof bound to the exact integrated artifact.", falsifier: "Advance the Work head with a proofHead or verification event for different bytes." },
  { id: "integration/head-movement-stales-proof", invariant: "Work-head movement marks every older active task proof stale.", falsifier: "Advance the Work head and retain an older task's passed proof as current." },
  { id: "integration/stale-task-reconciles", invariant: "A stale task resumes only after clean reconciliation and fresh exact-head proof.", falsifier: "Mark a stale task current without reconciliation evidence bound to its reconciled head." },
  { id: "integration/conflict-preserves-both", invariant: "Semantic conflict preserves both remote states and never advances shared truth.", falsifier: "Discard either side of a conflict or move the Work ref across it." },
  { id: "integration/restart-replays-lock", invariant: "An interrupted integration resumes from Ledger state and idempotent remote truth.", falsifier: "Lose a queued candidate or require an unrecorded in-memory lock after restart." },
  { id: "integration/one-pr-unless-split", invariant: "One Work owns one PR unless an explicit split decision authorizes another.", falsifier: "Associate a second PR with the same Work and no split decision." },
  { id: "integration/cleanup-proves-disposition", invariant: "Cleanup occurs only after integration, remote rescue, or explicit human discard.", falsifier: "Delete the last unique local bytes without one of the three durable dispositions." },
] as const satisfies readonly IntegrationControllerInvariant[];

interface ControllerBaseOptions {
  ledger: EventLedger;
  actor: ActorRef;
  now?: () => string;
  idFactory?: () => string;
}

export interface OpenIntegrationControllerOptions extends ControllerBaseOptions {
  workId: string;
  streamId?: string;
}

export interface InitializeIntegrationOptions extends ControllerBaseOptions {
  workId: string;
  configuration: WorkIntegrationConfiguration;
  streamId?: string;
}

/** Existing Work stream identity; integration never creates a parallel stream. */
export function integrationWorkStreamId(workId: string): string {
  return streamIdForWork(id.parse(workId));
}

const ledgerTurns = new WeakMap<EventLedger, Promise<void>>();

function inLedgerTurn<T>(ledger: EventLedger, operation: () => Promise<T>): Promise<T> {
  const prior = ledgerTurns.get(ledger) ?? Promise.resolve();
  const result = prior.then(operation);
  ledgerTurns.set(ledger, result.then(() => undefined, () => undefined));
  return result;
}

export class IntegrationController {
  readonly workId: string;
  readonly streamId: string;
  readonly #ledger: EventLedger;
  readonly #actor: ActorRef;
  readonly #now: () => string;
  readonly #idFactory: () => string;
  #board: BoardProjection | null = null;

  private constructor(options: OpenIntegrationControllerOptions) {
    this.workId = id.parse(options.workId);
    const canonicalStreamId = integrationWorkStreamId(this.workId);
    if (options.streamId !== undefined && id.parse(options.streamId) !== canonicalStreamId) {
      throw new IntegrationControllerError(`Work ${this.workId} must use the canonical Work stream ${canonicalStreamId}`);
    }
    this.streamId = canonicalStreamId;
    this.#ledger = options.ledger;
    this.#actor = ActorRefSchema.parse(options.actor);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  static async open(options: OpenIntegrationControllerOptions): Promise<IntegrationController> {
    const controller = new IntegrationController(options);
    await controller.#inTurn(async () => {
      const board = controller.#requireBoard();
      if (board.integration === null) throw new IntegrationControllerError(`Work ${controller.workId} has no integration configuration`);
    });
    return controller;
  }

  static async initialize(options: InitializeIntegrationOptions): Promise<IntegrationController> {
    const configuration = WorkIntegrationConfigurationSchema.parse(options.configuration);
    const controller = new IntegrationController(options);
    await controller.#inOperatorTurn(async () => {
      const board = controller.#requireBoard();
      if (board.integration !== null) throw new IntegrationControllerError(`Work ${controller.workId} already owns integration ${board.integration.configuration.ref}`);
      if (
        Object.values(board.attempts).some((attempt) => attempt.state === "running" || attempt.state === "blocked")
        || board.activeVerification !== null
        || board.activeReview !== null
      ) {
        throw new IntegrationControllerError(`Work ${controller.workId} integration requires an idle Work with no active Attempt or proof`);
      }
      await controller.#append("integration.initialized", { configuration });
    });
    return controller;
  }

  get board(): BoardProjection {
    return structuredClone(this.#requireBoard());
  }

  async refresh(): Promise<BoardProjection> {
    return this.#inTurn(async () => this.board);
  }

  async startAttempt(input: StartIntegratedAttemptRequest): Promise<BoardProjection> {
    const request = StartIntegratedAttemptRequestSchema.parse(input);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      if (board.tasks[request.taskId] === undefined) throw new IntegrationControllerError(`Task ${request.taskId} does not exist`);
      if (board.attempts[request.attemptId] !== undefined) throw new IntegrationControllerError(`Attempt ${request.attemptId} already exists`);
      if (board.parkedReason !== null) {
        throw new IntegrationControllerError(`Work ${this.workId} is parked and must be released before an Attempt starts`);
      }
      if (Date.parse(request.lease.expiresAt) <= Date.parse(this.#timestamp())) {
        throw new IntegrationControllerError(`Attempt lease ${request.lease.id} is already expired`);
      }
      const conflict = findResourceLeaseConflict(board, request.lease);
      if (conflict !== null) {
        throw new IntegrationControllerError(`logical resource lease conflicts with active Attempt ${conflict.id}`);
      }
      await this.#append("attempt.started", {
        worker: request.worker,
        contractRevision: board.contractRevision,
        lease: request.lease,
      }, { taskId: request.taskId, attemptId: request.attemptId, actor: request.worker });
      return this.board;
    });
  }

  /**
   * A handoff keeps the same Work/Task/Attempt identity but replaces the
   * temporary executor only after a durable checkpoint exists for its lease.
   */
  async takeOverAttempt(input: TakeOverIntegratedAttemptRequest): Promise<BoardProjection> {
    const request = TakeOverIntegratedAttemptRequestSchema.parse(input);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const attempt = board.attempts[request.attemptId];
      if (attempt === undefined || attempt.taskId !== request.taskId || attempt.state !== "running" || attempt.lease === undefined) {
        throw new IntegrationControllerError(`Attempt ${request.attemptId} has no live lease to transfer`);
      }
      if (Date.parse(attempt.lease.expiresAt) <= Date.parse(this.#timestamp())) {
        throw new IntegrationControllerError(`Attempt lease ${attempt.lease.id} has expired and must be released before a successor starts`);
      }
      const checkpoint = Object.values(board.integration!.checkpoints)
        .filter((item) => item.attemptId === attempt.id)
        .at(-1);
      if (checkpoint?.checkpoint.workspaceId !== attempt.lease.workspaceId) {
        throw new IntegrationControllerError("attempt takeover requires a durable checkpoint from its current workspace lease");
      }
      if (Date.parse(request.lease.expiresAt) <= Date.parse(this.#timestamp())) {
        throw new IntegrationControllerError(`takeover lease ${request.lease.id} is already expired`);
      }
      const conflict = findResourceLeaseConflict(board, request.lease, attempt.id);
      if (conflict !== null) throw new IntegrationControllerError(`takeover logical resource lease conflicts with active Attempt ${conflict.id}`);
      await this.#append("attempt.lease-transferred", {
        fromLeaseId: attempt.lease.id,
        worker: request.worker,
        lease: request.lease,
        reason: request.reason,
      }, { taskId: request.taskId, attemptId: request.attemptId, actor: this.#actor });
      return this.board;
    });
  }

  /** Record worker death or a bounded expiry; Board clears the attempt lease. */
  async releaseExpiredAttempt(attemptId: string, observedAt = this.#timestamp()): Promise<BoardProjection> {
    const parsedAttemptId = id.parse(attemptId);
    const timestamp = TimestampSchema.parse(observedAt);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const attempt = board.attempts[parsedAttemptId];
      if (attempt === undefined || attempt.lease === undefined || (attempt.state !== "running" && attempt.state !== "blocked")) {
        throw new IntegrationControllerError(`Attempt ${parsedAttemptId} has no active lease to release`);
      }
      if (Date.parse(attempt.lease.expiresAt) > Date.parse(timestamp)) {
        throw new IntegrationControllerError(`Attempt lease ${attempt.lease.id} has not expired`);
      }
      await this.#append("attempt.failed", {
        reason: `attempt lease ${attempt.lease.id} expired at ${attempt.lease.expiresAt}`,
        recoverable: true,
      }, { taskId: attempt.taskId, attemptId: attempt.id, actor: this.#actor }, timestamp);
      return this.board;
    });
  }

  /**
   * A dead executor loses only its temporary lease. The recoverable Attempt
   * failure is durable evidence; it never removes the Work, Task, checkpoint,
   * or integration configuration a successor needs to continue.
   */
  async releaseAttemptForWorkerDeath(attemptId: string, detail: string): Promise<BoardProjection> {
    const parsedAttemptId = id.parse(attemptId);
    const reason = text.max(2000).parse(detail);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const attempt = board.attempts[parsedAttemptId];
      if (attempt === undefined || attempt.lease === undefined || (attempt.state !== "running" && attempt.state !== "blocked")) {
        throw new IntegrationControllerError(`Attempt ${parsedAttemptId} has no active lease to release after worker death`);
      }
      await this.#append("attempt.failed", {
        reason: `worker holding attempt lease ${attempt.lease.id} died: ${reason}`,
        recoverable: true,
      }, { taskId: attempt.taskId, attemptId: attempt.id, actor: this.#actor });
      return this.board;
    });
  }

  async recordCheckpoint(input: RecordIntegrationCheckpointRequest): Promise<BoardProjection> {
    const request = RecordIntegrationCheckpointRequestSchema.parse(input);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const attempt = board.attempts[request.attemptId];
      if (attempt === undefined || attempt.taskId !== request.taskId || attempt.state === "failed" || attempt.workspaceId === undefined) {
        throw new IntegrationControllerError(`checkpoint requires a recoverable Attempt ${request.attemptId} workspace`);
      }
      if (request.checkpoint.workspaceId !== attempt.workspaceId) {
        throw new IntegrationControllerError("checkpoint workspace must equal the Attempt workspace identity");
      }
      if (request.checkpoint.parentIntegrationHead !== board.integration!.head) {
        if (request.checkpoint.class === "integration-candidate") {
          throw new IntegrationControllerError("integration candidate parent must equal the current Work integration head");
        }
      }
      if (board.integration!.checkpoints[request.checkpoint.id] !== undefined) {
        throw new IntegrationControllerError(`checkpoint ${request.checkpoint.id} already exists`);
      }
      if (request.checkpoint.class === "integration-candidate" && !integrationCheckpointIsEligible(request.checkpoint, board.integration!.head)) {
        throw new IntegrationControllerError("integration candidate does not satisfy the declared eligibility predicate");
      }
      if (request.checkpoint.class === "integration-candidate") {
        if (request.checkpoint.remoteStatus !== "pushed" || request.checkpoint.remoteRef === undefined) {
          throw new IntegrationControllerError("integration candidate must be durably pushed before queueing");
        }
        const proof = board.verifications.find((item) => item.eventId === request.checkpoint.verificationEventId);
        if (proof?.status !== "pass" || proof.contractRevision !== board.contractRevision) {
          throw new IntegrationControllerError("integration candidate must reference a passing verification for the current Work revision");
        }
      }
      await this.#append("integration.checkpoint-recorded", { checkpoint: request.checkpoint }, {
        taskId: request.taskId,
        attemptId: request.attemptId,
      });
      if (request.checkpoint.class === "integration-candidate") {
        await this.#append("integration.candidate-queued", { checkpointId: request.checkpoint.id });
      }
      return this.board;
    });
  }

  /**
   * Serialize the first eligible checkpoint, reconcile it onto the latest Work
   * head through a replaceable adapter, and advance shared truth only when the
   * exact reconciled artifact has current passing proof.
   */
  async integrateNext(executor: WorkIntegrationExecutor): Promise<BoardProjection> {
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const existingLock = board.integration!.lock;
      const checkpointId = existingLock?.checkpointId ?? board.integration!.queue[0];
      if (checkpointId === undefined) return this.board;
      const projected = board.integration!.checkpoints[checkpointId];
      if (projected === undefined) throw new IntegrationControllerError(`queued checkpoint ${checkpointId} does not exist`);
      if (existingLock !== null && existingLock.expectedHead !== board.integration!.head) {
        throw new IntegrationControllerError(`interrupted integration lock ${existingLock.id} targets stale head ${existingLock.expectedHead}`);
      }
      const lockId = existingLock?.id ?? `integration-lock:${this.#idFactory()}`;
      if (existingLock === null) {
        await this.#append("integration.lock-acquired", {
          lockId,
          checkpointId,
          expectedHead: board.integration!.head,
        });
      }

      let result: IntegrationExecutionResult;
      try {
        result = IntegrationExecutionResultSchema.parse(await executor.reconcile({
          purpose: "integrate-candidate",
          workId: this.workId,
          taskId: projected.taskId,
          attemptId: projected.attemptId,
          checkpoint: projected.checkpoint,
          integrationRef: board.integration!.configuration.ref,
          integrationHead: board.integration!.head,
        }));
      } catch (cause) {
        const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        await this.#append("integration.failed", {
          lockId,
          checkpointId,
          reason: `integration executor failed: ${reason}`,
          semanticConflict: false,
          preservedRefs: [],
        });
        throw cause;
      }

      if (result.status === "conflict" || result.status === "failed") {
        await this.#append("integration.failed", {
          lockId,
          checkpointId,
          reason: result.reason,
          semanticConflict: result.status === "conflict",
          preservedRefs: result.preservedRefs,
        });
        return this.board;
      }
      if (result.status !== "integrated") {
        await this.#append("integration.failed", {
          lockId,
          checkpointId,
          reason: `integration executor returned ${result.status} for an integration candidate`,
          semanticConflict: false,
          preservedRefs: [],
        });
        throw new IntegrationControllerError("integration executor returned a task-reconciliation result for Work integration");
      }
      await this.#reload();
      const proof = this.#requireIntegratedBoard().verifications.find((item) => item.eventId === result.verificationEventId);
      if (result.proofHead !== result.head || proof?.status !== "pass" || proof.contractRevision !== this.#requireBoard().contractRevision) {
        await this.#append("integration.failed", {
          lockId,
          checkpointId,
          reason: "integrated artifact lacks passing proof bound to its exact head",
          semanticConflict: false,
          preservedRefs: [projected.checkpoint.remoteRef].filter((value): value is string => value !== undefined),
        });
        throw new IntegrationControllerError("integrated artifact lacks passing proof bound to its exact head");
      }
      await this.#append("integration.head-advanced", {
        lockId,
        checkpointId,
        previousHead: board.integration!.head,
        head: result.head,
        tree: result.tree,
        proofHead: result.proofHead,
        verificationEventId: result.verificationEventId,
        remoteRef: result.remoteRef,
      });
      return this.board;
    });
  }

  async reconcileStaleAttempt(attemptId: string, executor: WorkIntegrationExecutor): Promise<BoardProjection> {
    const parsedAttemptId = id.parse(attemptId);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const attempt = board.attempts[parsedAttemptId];
      if (attempt === undefined || attempt.integrationBaseHead === undefined || attempt.integrationBaseHead === board.integration!.head) {
        throw new IntegrationControllerError(`Attempt ${parsedAttemptId} is not stale against the Work integration head`);
      }
      const checkpoint = Object.values(board.integration!.checkpoints).filter((item) => item.attemptId === attempt.id).at(-1);
      if (checkpoint === undefined || checkpoint.checkpoint.remoteStatus !== "pushed") {
        throw new IntegrationControllerError("stale Attempt must preserve its bytes remotely before reconciliation");
      }
      const result = IntegrationExecutionResultSchema.parse(await executor.reconcile({
        purpose: "reconcile-stale-attempt",
        workId: this.workId,
        taskId: attempt.taskId,
        attemptId: attempt.id,
        checkpoint: checkpoint.checkpoint,
        integrationRef: board.integration!.configuration.ref,
        integrationHead: board.integration!.head,
      }));
      if (result.status === "conflict") {
        await this.#append("integration.task-reconciled", {
          checkpointId: checkpoint.checkpoint.id,
          previousBaseHead: attempt.integrationBaseHead,
          newBaseHead: board.integration!.head,
          status: "conflict",
          preservedRefs: result.preservedRefs,
          reason: result.reason,
        }, { taskId: attempt.taskId, attemptId: attempt.id });
        return this.board;
      }
      if (result.status !== "reconciled") {
        throw new IntegrationControllerError(`stale Attempt reconciliation returned ${result.status}`);
      }
      if (result.proofHead !== result.head) throw new IntegrationControllerError("reconciled Attempt proof is not bound to its exact head");
      await this.#append("integration.task-reconciled", {
        checkpointId: checkpoint.checkpoint.id,
        previousBaseHead: attempt.integrationBaseHead,
        newBaseHead: board.integration!.head,
        status: "clean",
        head: result.head,
        tree: result.tree,
        proofHead: result.proofHead,
        remoteRef: result.remoteRef,
        preservedRefs: [],
      }, { taskId: attempt.taskId, attemptId: attempt.id, evidence: result.evidence });
      return this.board;
    });
  }

  async recoverInterruptedIntegration(reason: string, preservedRefs: readonly string[] = []): Promise<BoardProjection> {
    const detail = text.max(4000).parse(reason);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const lock = board.integration!.lock;
      if (lock === null) throw new IntegrationControllerError("Work has no interrupted integration lock to recover");
      await this.#append("integration.failed", {
        lockId: lock.id,
        checkpointId: lock.checkpointId,
        reason: detail,
        semanticConflict: false,
        preservedRefs: [...preservedRefs],
      });
      return this.board;
    });
  }

  async associatePullRequest(input: AssociateIntegrationPullRequest): Promise<BoardProjection> {
    const pullRequest = AssociateIntegrationPullRequestSchema.parse(input);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const existing = board.integration!.pullRequests[0];
      if (existing !== undefined && pullRequest.splitDecisionId === undefined) {
        throw new IntegrationControllerError(`Work ${this.workId} already owns pull request ${existing.id}; a second requires an explicit split decision`);
      }
      await this.#append("integration.pull-request-associated", { pullRequest });
      return this.board;
    });
  }

  async updateMerge(input: {
    authority: "pending" | "authorized" | "denied";
    status: "not-requested" | "blocked" | "ready" | "merged" | "failed";
    decisionId?: string;
    detail: string;
  }): Promise<BoardProjection> {
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      if (input.authority === "authorized" && input.decisionId === undefined) {
        throw new IntegrationControllerError("merge authorization requires a durable decision identity");
      }
      if (input.authority === "authorized"
        && (input.decisionId === undefined || board.resolvedDecisions[input.decisionId]?.actor.kind !== "human")) {
        throw new IntegrationControllerError("merge authorization requires a durable human-resolved decision");
      }
      if (input.status === "merged" && (input.authority !== "authorized" || input.decisionId === undefined)) {
        throw new IntegrationControllerError("merged status requires authorized merge authority and a durable decision identity");
      }
      await this.#append("integration.merge-updated", input);
      return this.board;
    });
  }

  async authorizeCleanup(input: AuthorizeIntegrationCleanupRequest): Promise<BoardProjection> {
    const request = AuthorizeIntegrationCleanupRequestSchema.parse(input);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      const attempt = board.attempts[request.attemptId];
      if (attempt === undefined) throw new IntegrationControllerError(`Attempt ${request.attemptId} does not exist`);
      const checkpoint = request.checkpointId === undefined
        ? Object.values(board.integration!.checkpoints).filter((item) => item.attemptId === attempt.id).at(-1)
        : board.integration!.checkpoints[request.checkpointId];
      const integrated = checkpoint !== undefined && board.integration!.headProof?.checkpointId === checkpoint.checkpoint.id;
      const rescued = checkpoint?.checkpoint.remoteStatus === "pushed";
      const discarded = request.disposition === "discarded" && this.#actor.kind === "human" && request.authorityDecisionId !== undefined;
      if ((request.disposition === "integrated" && !integrated)
        || (request.disposition === "rescue-preserved" && !rescued)
        || (request.disposition === "discarded" && !discarded)) {
        throw new IntegrationControllerError("unique work is neither integrated, remotely preserved, nor explicitly discarded");
      }
      await this.#append("integration.cleanup-recorded", {
        disposition: request.disposition,
        ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.checkpoint.id }),
        ...(request.authorityDecisionId === undefined ? {} : { authorityDecisionId: request.authorityDecisionId }),
      }, { taskId: attempt.taskId, attemptId: attempt.id });
      return this.board;
    });
  }

  async park(reason: string): Promise<BoardProjection> {
    const parsed = text.max(2000).parse(reason);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      if (Object.values(board.attempts).some((attempt) => attempt.state === "running" || attempt.state === "blocked")) {
        throw new IntegrationControllerError("cannot park Work while an Attempt still holds execution state");
      }
      await this.#append("work.parked", { reason: parsed });
      return this.board;
    });
  }

  async release(reason: string): Promise<BoardProjection> {
    const parsed = text.max(2000).parse(reason);
    return this.#inOperatorTurn(async () => {
      const board = this.#requireIntegratedBoard();
      if (board.parkedReason === null) throw new IntegrationControllerError("only a parked Work may be released");
      await this.#append("work.released", { reason: parsed });
      return this.board;
    });
  }

  async observeExecution(observation: WorkExecutionObservation): Promise<BoardProjection> {
    const parsed = WorkExecutionObservationSchema.parse(observation);
    return this.#inOperatorTurn(async () => {
      this.#requireIntegratedBoard();
      await this.#append("integration.execution-observed", { observation: parsed });
      return this.board;
    });
  }

  enforceHorizon(signals: IntegrationHorizonSignals, policy: IntegrationHorizonPolicy = PROVISIONAL_INTEGRATION_HORIZON): void {
    if (policy.requiresConvergence(signals)) throw new IntegrationHorizonExceededError(policy.id);
  }

  async #inTurn<T>(operation: () => Promise<T>): Promise<T> {
    return inLedgerTurn(this.#ledger, async () => {
      await this.#reload();
      return operation();
    });
  }

  /**
   * Workers may inspect Work through their own execution contracts, but they
   * cannot mutate its integration lifecycle. A service is permitted here
   * because a Runtime/CLI integration operator performs durable mutations on a
   * human's behalf; acceptance itself remains human-only at its own seam.
   */
  async #inOperatorTurn<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#actor.kind !== "human" && this.#actor.kind !== "service") {
      throw new IntegrationControllerError(`actor ${this.#actor.id} lacks integration operator authority`);
    }
    return this.#inTurn(operation);
  }

  async #reload(): Promise<void> {
    const board = projectBoard(await this.#ledger.replay(this.streamId));
    if (board.workId !== this.workId) throw new IntegrationControllerError(`stream ${this.streamId} does not bind Work ${this.workId}`);
    this.#board = board;
  }

  #requireBoard(): BoardProjection {
    if (this.#board === null || this.#board.contract === null) throw new IntegrationControllerError(`Work ${this.workId} does not exist in ${this.streamId}`);
    return this.#board;
  }

  #requireIntegratedBoard(): BoardProjection {
    const board = this.#requireBoard();
    if (board.integration === null) throw new IntegrationControllerError(`Work ${this.workId} has no integration configuration`);
    return board;
  }

  async #append(
    type: HarnessEvent["type"],
    payload: unknown,
    extra: Partial<HarnessEvent> = {},
    timestamp = this.#timestamp(),
  ): Promise<void> {
    const event = parseHarnessEvent({
      id: `event:integration:${this.#idFactory()}`,
      type,
      schemaVersion: 1,
      streamId: this.streamId,
      workId: this.workId,
      actor: this.#actor,
      occurredAt: timestamp,
      recordedAt: timestamp,
      evidence: [],
      payload,
      ...extra,
    });
    await this.#ledger.append(event);
    await this.#reload();
    const rejected = this.#board?.violations.find((item) => item.eventId === event.id);
    if (rejected !== undefined) {
      throw new IntegrationControllerError(`Board rejected ${type} (${rejected.code}): ${rejected.detail}`);
    }
  }

  #timestamp(): string {
    return TimestampSchema.parse(this.#now());
  }
}
