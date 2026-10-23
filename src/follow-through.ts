import { z } from "zod";
import { projectBoard } from "./board.js";
import { CrewMissionSchema, CrewSupervisor, type CrewRunHandle, type CrewSupervisorOptions } from "./crew.js";
import type { EventLedger } from "./ledger.js";
import { summarizeOperatorWork } from "./operator.js";
import { streamIdForWork } from "./refiner.js";
import { TimestampSchema, type HarnessEvent } from "./schemas.js";
import { DesignContinuityPolicySchema, withDesignContinuity } from "./design-intelligence.js";

/** Organization adapters supply private account/context references, never client data in core. */
export const FollowThroughAssignmentSchema = z.object({
  ownerRef: z.string().trim().min(1).max(200),
  sourceRef: z.string().trim().min(1).max(2048),
  dueAt: TimestampSchema,
  priority: z.number().int().min(0).max(100),
  baseRevision: z.string().trim().min(1).max(300),
  deliveryKind: z.enum(["general", "interface"]).default("general"),
  designContinuity: DesignContinuityPolicySchema.optional(),
  mission: CrewMissionSchema,
}).strict().superRefine((value, ctx) => {
  if (value.deliveryKind === "interface" && value.designContinuity === undefined) {
    ctx.addIssue({ code: "custom", path: ["designContinuity"], message: "Interface delivery requires its selected design reference and protected features" });
  }
  if (value.designContinuity !== undefined && JSON.stringify(withDesignContinuity(value.mission.work, value.designContinuity)) !== JSON.stringify(value.mission.work)) {
    ctx.addIssue({ code: "custom", path: ["mission", "work"], message: "Bind design continuity into the Work contract with withDesignContinuity before dispatch" });
  }
  if (value.mission.work.dependencies.length > 0 || value.mission.workspace.strategy !== "fresh") {
    ctx.addIssue({ code: "custom", path: ["mission"], message: "Follow-through dispatches independent fresh-workspace missions; dependency graphs must use CrewSupervisor as one intact plan" });
  }
  if (value.mission.continuesWork || value.mission.priorAttemptEvidence.length > 0 || value.mission.expectedLastEventId !== undefined) {
    ctx.addIssue({ code: "custom", path: ["mission"], message: "Continuation is derived from the canonical Work stream, not supplied by the caller" });
  }
});
export type FollowThroughAssignment = z.infer<typeof FollowThroughAssignmentSchema>;

export type FollowThroughAction = "dispatch" | "active" | "recover" | "verify" | "review" | "accept" | "resolve" | "closed";
export interface FollowThroughItem {
  ownerRef: string;
  sourceRef: string;
  workId: string;
  dueAt: string;
  overdue: boolean;
  action: FollowThroughAction;
  reason: string;
  /** Assigned only from a durable Attempt, never from a requested route. */
  workerIds: string[];
  state: string;
}

function assignments(input: readonly FollowThroughAssignment[]): FollowThroughAssignment[] {
  const parsed = input.map(item => FollowThroughAssignmentSchema.parse(item));
  const ids = parsed.map(item => item.mission.work.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate follow-through Work identity");
  return parsed.sort((a, b) => b.priority - a.priority || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.mission.work.id.localeCompare(b.mission.work.id));
}

/** A read-only projection: no message sends, acceptance decisions or lease mutations. */
export async function inspectFollowThrough(
  ledger: EventLedger,
  input: readonly FollowThroughAssignment[],
  observedAt: string,
): Promise<FollowThroughItem[]> {
  const now = Date.parse(TimestampSchema.parse(observedAt));
  return Promise.all(assignments(input).map(async assignment => {
    const workId = assignment.mission.work.id;
    const events = await ledger.replay(streamIdForWork(workId));
    return projectFollowThrough(assignment, events, now);
  }));
}

function projectFollowThrough(assignment: FollowThroughAssignment, events: readonly HarnessEvent[], now: number): FollowThroughItem {
    const workId = assignment.mission.work.id;
    const board = projectBoard(events);
    let action: FollowThroughAction = "dispatch";
    let reason = "No Attempt has been dispatched";
    const attempts = Object.values(board.attempts);
    const active = attempts.filter(attempt => attempt.state === "running" || attempt.state === "blocked");
    if (events.some(event => event.workId !== workId || event.streamId !== streamIdForWork(workId)) || board.violations.length > 0) {
      action = "resolve"; reason = "Work stream has identity or projection violations";
    } else if (["accepted", "rejected", "cancelled"].includes(board.state)) {
      action = "closed"; reason = `Work is ${board.state}`;
    } else if (board.contract && JSON.stringify(board.contract) !== JSON.stringify(assignment.mission.work)) {
      action = "resolve"; reason = "Assignment differs from canonical Work; refresh the assignment";
    } else if (board.state === "parked" || Object.keys(board.openDecisions).length > 0) {
      action = "resolve"; reason = board.parkedReason ?? "Work has an unresolved decision";
    } else if (active.length > 0) {
      const stale = active.some(attempt => attempt.lease === undefined || Date.parse(attempt.lease.expiresAt) <= now);
      action = stale ? "recover" : "active";
      reason = stale ? "An unfinished Attempt needs explicit recovery before reassignment" : "A worker holds an active Attempt";
    } else if (board.activeVerification || board.activeReview) {
      action = "active"; reason = "Independent verification or review is active";
    } else if (board.contract !== null) {
      const status = summarizeOperatorWork(events);
      if (status.readiness.ready) {
        action = "accept"; reason = status.nextActionReason;
      } else if (status.verification.latest === "fail" || status.review.latest === "fail") {
        action = "resolve"; reason = "Independent verification or review failed; an explicit repair decision is required";
      } else if (status.nextAction === "review") {
        action = "review"; reason = status.nextActionReason;
      } else if (attempts.some(attempt => attempt.state === "finished" && attempt.contractRevision === board.contractRevision)) {
        action = "verify"; reason = "Worker execution finished; verification or an explicit repair decision is required";
      } else if (attempts.length >= board.contract.workerPolicy.maxAttempts) {
        action = "resolve"; reason = "Attempt budget exhausted";
      } else if (attempts.some(attempt => attempt.state === "failed")) {
        action = "resolve"; reason = "A failed Attempt needs an explicit repair plan before another worker is assigned";
      } else if (attempts.some(attempt => attempt.contractRevision !== board.contractRevision)) {
        action = "resolve"; reason = "Amended Work requires an explicit continuation decision";
      } else if (!["proposed", "verifying", "unverifiable", "failed"].includes(board.state)) {
        action = "resolve"; reason = `Work state ${board.state} requires an explicit continuation decision`;
      } else if (Object.keys(board.tasks).length > 0 && attempts.length === 0) {
        action = "resolve"; reason = "An earlier assignment failed before an Attempt; repair its dispatch configuration";
      }
    } else if (events.length > 0) {
      action = "resolve"; reason = "Work stream has no canonical contract";
    }
    return {
      ownerRef: assignment.ownerRef, sourceRef: assignment.sourceRef, workId,
      dueAt: assignment.dueAt, overdue: action !== "closed" && now > Date.parse(assignment.dueAt),
      action, reason, workerIds: [...new Set(active.map(attempt => attempt.worker.id))],
      state: board.contract === null ? "unstarted" : board.state,
    };
}

// The durable Ledger must enforce one writer across processes. This gate also
// prevents two coordinators in one process from spending the same retry budget.
const queues = new WeakMap<EventLedger, Promise<void>>();
async function exclusive<T>(ledger: EventLedger, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(ledger) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  queues.set(ledger, tail);
  await previous;
  try { return await run(); }
  finally { release(); if (queues.get(ledger) === tail) queues.delete(ledger); }
}

export interface FollowThroughCycle {
  items: FollowThroughItem[];
  /** Live workspace custody stays with the operator for verification/integration. */
  runs: CrewRunHandle[];
  errors: { workId: string; reason: string }[];
}

/**
 * Bounded supervisor over Crew, not a second Board. Each tick rereads durable
 * Work before assigning an actual provider. It never treats finish as acceptance.
 * The host schedules ticks and owns verification, integration, and communication.
 */
export class FollowThroughSupervisor {
  constructor(readonly options: Omit<CrewSupervisorOptions, "plan" | "correlationId">) {}

  async cycle(input: readonly FollowThroughAssignment[], maxDispatches = 1): Promise<FollowThroughCycle> {
    const planned = assignments(input);
    z.number().int().min(1).max(100).parse(maxDispatches);
    return exclusive(this.options.ledger, async () => {
      const runs: CrewRunHandle[] = [];
      const errors: FollowThroughCycle["errors"] = [];
      const now = this.options.now ?? (() => new Date().toISOString());
      const items = await inspectFollowThrough(this.options.ledger, planned, now());
      let dispatched = 0;
      for (const item of items) {
        if (item.action !== "dispatch" || dispatched >= maxDispatches) continue;
        const assignment = planned.find(candidate => candidate.mission.work.id === item.workId)!;
        const events = await this.options.ledger.replay(streamIdForWork(item.workId));
        if (projectFollowThrough(assignment, events, Date.parse(TimestampSchema.parse(now()))).action !== "dispatch") continue;
        const board = projectBoard(events);
        // A caller's old contract must never silently broaden an amended Work.
        if (board.contract && JSON.stringify(board.contract) !== JSON.stringify(assignment.mission.work)) {
          errors.push({ workId: item.workId, reason: "Assignment differs from canonical Work; refresh the assignment" });
          continue;
        }
        dispatched += 1;
        try {
          const correlationId = events.length === 0 ? assignment.ownerRef : events.find(event => event.type === "work.created")?.correlationId;
          const run = await new CrewSupervisor({
            ...this.options,
            ...(correlationId === undefined ? {} : { correlationId }),
            plan: {
              id: `follow-through:${item.workId}`.slice(0, 200),
              objective: assignment.mission.work.objective,
              baseRevision: assignment.baseRevision,
              maxParallel: 1,
              missions: [{ ...assignment.mission, continuesWork: board.contract !== null, expectedLastEventId: events.at(-1)?.id ?? null }],
            },
          }).run();
          runs.push(run);
          for (const receipt of run.receipt.missions) {
            if (receipt.status !== "execution-finished") errors.push({ workId: receipt.workId, reason: receipt.error ?? `Crew reported ${receipt.status}` });
          }
        } catch (error) {
          errors.push({ workId: item.workId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { items: await inspectFollowThrough(this.options.ledger, planned, now()), runs, errors };
    });
  }
}
