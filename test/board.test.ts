import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceReadiness, authorshipUnproven, projectBoard, type BoardProjection } from "../src/board.js";
import type { HarnessEvent } from "../src/schemas.js";
import {
  event,
  guardedWrite,
  human,
  ingestedExecution,
  passingVerification,
  passingVerificationSequence,
  reviewer,
  successfulExecution,
  verifier,
  verificationStart,
  work,
  worker,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Authorship
//
// The defect: a Work whose candidate was produced elsewhere and replayed into
// the Ledger projected to `ready` with zero violations, identical in every
// readable respect to a Work a worker actually executed. These prove the
// Board can now tell them apart. Each fails if `authorshipUnproven` stops
// being consulted by `deriveState`.
// ---------------------------------------------------------------------------

test("an ingested candidate cannot reach ready, however well-formed its events", () => {
  const ingested = [...ingestedExecution(), ...passingVerificationSequence()];
  const board = projectBoard(ingested);

  // Everything else about this Work is impeccable.
  assert.equal(board.violations.length, 0, "the ingested stream is structurally valid");
  assert.equal(board.attempts["attempt:1"]?.state, "finished");

  // And it is still not done.
  assert.equal(board.state, "unverifiable");
  assert.match(authorshipUnproven(board) ?? "", /streamed no execution observation/);
  assert.equal(acceptanceReadiness(board).ready, false, "an unverifiable Work is not acceptable");
});

test("the same Work reaches ready once a worker actually authored it", () => {
  const authored = [...successfulExecution(), ...passingVerificationSequence()];
  const board = projectBoard(authored);
  assert.equal(board.state, "ready");
  assert.equal(authorshipUnproven(board), null);
});

test("naming a worker is a claim, not authorship evidence", () => {
  // task.assigned and attempt.started both name a worker. The adapter that
  // caused this defect wrote exactly those. They must not be enough.
  const claimed = [...ingestedExecution(), ...passingVerificationSequence()];
  const named = projectBoard(claimed);
  assert.equal(named.attempts["attempt:1"]?.worker.id, worker.id, "a worker is named");
  assert.equal(named.state, "unverifiable", "naming one did not make it authorship");
});

test("passing review cannot make an ingested candidate ready", () => {
  const contract = work({
    verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] },
  });
  const board = projectBoard([
    ...ingestedExecution(contract),
    ...passingVerificationSequence(),
    event("review.started", { reviewId: "review:authorship", contractRevision: 1 }, { actor: reviewer }),
    event("review.result", {
      reviewId: "review:authorship",
      contractRevision: 1,
      status: "pass",
      summary: "candidate behavior is sound",
    }, { actor: reviewer }),
  ]);
  assert.equal(board.state, "unverifiable");
});

test("verification-optional Work still requires authorship after execution", () => {
  const contract = work({
    acceptanceCriteria: [{ id: "criterion:tests", description: "Optional test evidence", required: false }],
    requiredEvidence: [{
      id: "evidence:tests",
      description: "Optional passing test evidence",
      acceptedKinds: ["test"],
      required: false,
    }],
    verificationPolicy: { required: false, independentActor: false, reviewRequired: false, falsifiabilityExemptions: [] },
  });
  const board = projectBoard(ingestedExecution(contract));
  assert.equal(board.state, "unverifiable");
});

test("each authorship signal is load-bearing on its own", () => {
  const full = [...successfulExecution(), ...passingVerificationSequence()];
  assert.equal(projectBoard(full).state, "ready");

  // Drop the streamed observations: a worker that ran cannot avoid them.
  const noObservation = full.filter((item) => item.type !== "attempt.activity-observed");
  assert.equal(projectBoard(noObservation).state, "unverifiable");
  assert.match(authorshipUnproven(projectBoard(noObservation)) ?? "", /no execution observation/);

  // Drop the Guard-mediated write: the candidate's content was never
  // authorized through the seam that mediates worker writes.
  const noGuardedWrite = full.filter((item) => item.type !== "guard.evaluated");
  assert.equal(projectBoard(noGuardedWrite).state, "unverifiable");
  assert.match(authorshipUnproven(projectBoard(noGuardedWrite)) ?? "", /no Guard-mediated write/);

  // Drop the lease: the attempt never held a workspace to write into.
  const noLease = full.map((item) => item.type === "attempt.started"
    ? { ...item, payload: { worker: item.payload.worker, contractRevision: item.payload.contractRevision } }
    : item) as HarnessEvent[];
  assert.equal(projectBoard(noLease).state, "unverifiable");
  assert.match(authorshipUnproven(projectBoard(noLease)) ?? "", /never held a workspace/);
});

test("a denied Guard write is not authorship", () => {
  // Guard saw a write and refused it, so nothing was written through the seam.
  const denied = successfulExecution().map((item) => item.type === "guard.evaluated"
    ? { ...item, payload: { ...item.payload, verdict: { ...item.payload.verdict, decision: "deny" as const } } }
    : item) as HarnessEvent[];
  const board = projectBoard([...denied, ...passingVerificationSequence()]);
  assert.equal(board.state, "unverifiable");
  assert.match(authorshipUnproven(board) ?? "", /no Guard-mediated write/);
});

test("RESIDUAL: a determined forger can still mint authorship evidence", () => {
  // This test asserts a WEAKNESS, deliberately, so nobody mistakes the
  // authorship invariant for proof.
  //
  // The Ledger is an unkeyed hash chain (adapters/local/durable-ledger.ts
  // recordDigest). Whoever can write the file can mint any event and
  // recompute the chain. So an operator who wants a green can still write
  // the observation and the Guard record by hand, exactly as the adapter
  // that caused this defect already wrote the lease.
  //
  // What the invariant buys is that this is now DELIBERATE. Honest tooling
  // can no longer reach `ready` by accident, and a forgery has to state, in
  // typed fields, that a worker ran and that Guard authorized its writes.
  //
  // Closing it for real needs authenticated events: a per-run key held by a
  // process that is not the candidate producer, scrubbed from every child
  // environment, as in ADR 0067. When that lands, THIS TEST SHOULD FAIL and
  // whoever lands it should delete it.
  const forged = [
    ...ingestedExecution(),
    event("attempt.activity-observed", {
      state: "working",
      detail: "message: worker edited src/feature.ts",
      source: worker.id,
      authority: "observation",
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    guardedWrite(),
    ...passingVerificationSequence(),
  ];
  const board = projectBoard(forged);
  assert.equal(board.state, "ready", "two hand-written events still defeat the invariant");
  assert.equal(authorshipUnproven(board), null);
});

test("authorship is judged per attempt, not anywhere in the stream", () => {
  // Evidence belonging to some other attempt must not vouch for this one.
  const stray = [
    ...ingestedExecution(),
    guardedWrite("attempt:other", "task:1"),
    ...passingVerificationSequence(),
  ];
  const board = projectBoard(stray);
  assert.equal(board.state, "unverifiable", "another attempt's Guard record is not this attempt's evidence");
});

test("stale checkpoints cannot keep a repaired integrated candidate unverifiable", () => {
  const authored = projectBoard([...successfulExecution(), ...passingVerificationSequence()]);
  const currentAttempt = authored.attempts["attempt:1"]!;
  const staleAttempt = { ...currentAttempt, id: "attempt:stale", observationCount: 0 };
  const checkpoint = (id: string, attemptId: string, effectiveProofState: "passed" | "stale") => ({
    eventId: `event:${id}`,
    taskId: "task:1",
    attemptId,
    checkpoint: {
      id,
      class: "integration-candidate" as const,
      parentIntegrationHead: "a".repeat(40),
      workspaceId: "workspace:1",
      changedResources: [{ kind: "path" as const, resource: "src" }],
      head: "b".repeat(40),
      tree: "c".repeat(40),
      proofState: "passed" as const,
      proofHead: "b".repeat(40),
      verificationEventId: authored.verifications.at(-1)!.eventId,
      remoteRef: `refs/rhiz/checkpoints/${id}`,
      remoteStatus: "pushed" as const,
    },
    effectiveProofState,
  });
  const stale = checkpoint("checkpoint:stale", staleAttempt.id, "stale");
  const current = checkpoint("checkpoint:current", currentAttempt.id, "passed");
  const board: BoardProjection = {
    ...authored,
    attempts: { ...authored.attempts, [staleAttempt.id]: staleAttempt },
    integration: {
      configuration: integrationConfiguration,
      head: current.checkpoint.head,
      checkpoints: { [stale.checkpoint.id]: stale, [current.checkpoint.id]: current },
      queue: [],
      lock: null,
      headProof: {
        eventId: "event:head-current",
        checkpointId: current.checkpoint.id,
        head: current.checkpoint.head,
        tree: current.checkpoint.tree,
        verificationEventId: current.checkpoint.verificationEventId!,
        remoteRef: current.checkpoint.remoteRef!,
      },
      reconciliations: {},
      taskStates: {},
      pullRequests: [],
      merge: { authority: "pending", status: "not-requested", detail: "not requested" },
      cleanups: {},
      failures: [],
      latestExecutionObservation: null,
      divergences: [],
    },
  };
  assert.equal(authorshipUnproven(board), null);
});

test("worker completion never means organizational acceptance", () => {
  const board = projectBoard(successfulExecution());
  assert.equal(board.state, "verifying");
  assert.equal(board.acceptedBy, null);
});

test("passing verification still requires an explicit acceptance event", () => {
  const events = [...successfulExecution(), ...passingVerificationSequence()];
  const board = projectBoard(events);
  assert.equal(acceptanceReadiness(board).ready, true);
  assert.equal(board.state, "ready");

  const accepted = projectBoard([
    ...events,
    event("work.accepted", { reason: "Evidence satisfies the contract", contractRevision: 1 }),
  ]);
  assert.equal(accepted.state, "accepted");
});

test("acceptance without required proof is rejected by the projection", () => {
  const board = projectBoard([
    ...successfulExecution(),
    event("work.accepted", { reason: "Premature", contractRevision: 1 }),
  ]);
  assert.notEqual(board.state, "accepted");
  assert.equal(board.violations.at(-1)?.code, "acceptance-preconditions-not-met");
});

test("the execution worker cannot satisfy an independent verification requirement", () => {
  const board = projectBoard([...successfulExecution(), ...passingVerificationSequence(worker)]);
  const readiness = acceptanceReadiness(board);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.some((reason) => reason.includes("independent") || reason.includes("verification")));

  const independentlyVerified = projectBoard([...successfulExecution(), ...passingVerificationSequence(verifier)]);
  assert.equal(acceptanceReadiness(independentlyVerified).ready, true);
});

test("a contract amendment invalidates proof from the prior revision", () => {
  const initial = [...successfulExecution(), ...passingVerificationSequence()];
  const amended = projectBoard([
    ...initial,
    event("work.amended", {
      changes: { objective: "Implement the revised bounded change" },
      revision: 2,
      reason: "Objective changed",
    }),
  ]);
  assert.equal(amended.contractRevision, 2);
  assert.equal(acceptanceReadiness(amended).ready, false);
});

test("terminal Board state outranks late contradictory runtime observations without rejecting observation evidence", () => {
  const base = [...successfulExecution(), ...passingVerificationSequence()];
  const acceptedEvent = event("work.accepted", { reason: "Accepted", contractRevision: 1 });
  const noisyObservation = event(
    "attempt.activity-observed",
    { state: "working", detail: "runtime still sees a process", source: "runtime", authority: "observation" },
    { taskId: "task:1", attemptId: "attempt:1", actor: worker },
  );
  const board = projectBoard([...base, acceptedEvent, noisyObservation]);
  assert.equal(board.state, "accepted");
  assert.equal(board.lastEventId, noisyObservation.id);
  assert.equal(board.violations.length, 0);
});

test("terminal Work records Refiner learning without reopening or violating the Board", () => {
  const rejected = event("work.rejected", {
    reason: "Independent verification exhausted the attempt budget",
    contractRevision: 1,
  });
  const proposal = event("refiner.proposed", {
    proposal: {
      id: "proposal:post-outcome-learning",
      workId: "work:1",
      kind: "guard-tuning",
      title: "Learn from the rejected Work",
      summary: "Preserve the failure as a reviewable improvement proposal.",
      reasoning: "The learning loop begins after the Work outcome is known.",
      classification: "verification-gap",
      evidenceRefs: [{
        ledgerEventId: rejected.id,
        reasoning: "The rejection is the exact outcome this proposal explains.",
      }],
      draft: {
        summary: "Permit post-terminal learning events without changing Work state.",
        rationale: "Refiner proposals are evidence about an outcome, not Work lifecycle mutations.",
        reversibleUntil: "2099-01-01T00:00:00.000Z",
        draftPayload: {},
      },
      status: "proposed",
      proposedBy: { id: "service:refiner", kind: "service" },
      proposedAt: "2026-08-20T04:02:00.000Z",
      supersedes: [],
    },
  }, { actor: { id: "service:refiner", kind: "service" } });
  const accepted = event("refiner.accepted", {
    proposalId: "proposal:post-outcome-learning",
    workId: "work:1",
    acceptedBy: human,
    rationale: "The rejected Work proves the learning is relevant.",
  });
  const promoted = event("refiner.promoted", {
    proposalId: "proposal:post-outcome-learning",
    workId: "work:1",
    promotedBy: human,
    appliedSurface: "kernel:board",
    irreversible: false,
  });
  const proposalRejected = event("refiner.rejected", {
    proposalId: "proposal:post-outcome-learning",
    workId: "work:1",
    rejectedBy: human,
    rationale: "Independent review may reject learning without rewriting Work.",
  });

  const board = projectBoard([
    ...successfulExecution(),
    rejected,
    proposal,
    accepted,
    promoted,
  ]);
  assert.equal(board.state, "rejected");
  assert.equal(board.lastEventId, promoted.id);
  assert.equal(board.violations.length, 0);

  const rejectedLearning = projectBoard([
    ...successfulExecution(),
    rejected,
    proposal,
    proposalRejected,
  ]);
  assert.equal(rejectedLearning.state, "rejected");
  assert.equal(rejectedLearning.lastEventId, proposalRejected.id);
  assert.equal(rejectedLearning.violations.length, 0);
});

test("failed attempt can be superseded by a new attempt without losing Work identity", () => {
  const contract = work();
  const events = [
    event("work.created", { contract, revision: 1 }),
    event("task.created", { objective: "Implement" }, { taskId: "task:1" }),
    event("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    event("attempt.failed", { reason: "process died", recoverable: true }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
  ];
  assert.equal(projectBoard(events).state, "failed");

  const retried = projectBoard([
    ...events,
    event("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:1", attemptId: "attempt:2", actor: worker }),
  ]);
  assert.equal(retried.workId, contract.id);
  assert.equal(retried.state, "running");
});

test("replay is deterministic and follows Ledger order rather than source timestamp", () => {
  const events = successfulExecution();
  const first = projectBoard(events);
  const second = projectBoard(events);
  assert.deepEqual(first, second);

  const lateRecorded = event(
    "decision.requested",
    { decisionId: "decision:1", question: "Proceed?", choices: [] },
    { occurredAt: "2020-01-01T00:00:00.000Z", recordedAt: "2030-01-01T00:00:00.000Z" },
  );
  const resolved = event(
    "decision.resolved",
    { decisionId: "decision:1", resolution: "Proceed" },
    { occurredAt: "2010-01-01T00:00:00.000Z", recordedAt: "2011-01-01T00:00:00.000Z" },
  );
  const board = projectBoard([...events, lateRecorded, resolved]);
  assert.equal(Object.keys(board.openDecisions).length, 0);
});

test("an execution actor cannot accept its own work", () => {
  const board = projectBoard([
    ...successfulExecution(),
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "Self-accept", contractRevision: 1 }, { actor: worker }),
  ]);
  assert.notEqual(board.state, "accepted");
  assert.equal(board.violations.at(-1)?.code, "acceptance-preconditions-not-met");
});

test("duplicate and unknown task or attempt identities fail closed", () => {
  const contract = work();
  const created = event("work.created", { contract, revision: 1 });
  const task = event("task.created", { objective: "Implement" }, { taskId: "task:1" });
  const duplicateTask = event("task.created", { objective: "Overwrite" }, { taskId: "task:1" });
  let board = projectBoard([created, task, duplicateTask]);
  assert.equal(board.violations.at(-1)?.code, "duplicate-task");
  assert.equal(board.tasks["task:1"]?.objective, "Implement");

  const unknownAssignment = event("task.assigned", { worker }, { taskId: "task:missing" });
  board = projectBoard([created, unknownAssignment]);
  assert.equal(board.violations.at(-1)?.code, "unknown-task");

  const attempt = event("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:1", attemptId: "attempt:1", actor: worker });
  const duplicateAttempt = event("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:1", attemptId: "attempt:1", actor: worker });
  board = projectBoard([created, task, attempt, duplicateAttempt]);
  assert.equal(board.violations.at(-1)?.code, "duplicate-attempt");

  const unknownFinish = event("attempt.finished", { resultSummary: "ghost", artifactRefs: [] }, { taskId: "task:1", attemptId: "attempt:missing", actor: worker });
  board = projectBoard([created, task, unknownFinish]);
  assert.equal(board.violations.at(-1)?.code, "unknown-attempt");
});

test("verification and review start events project active lifecycle state", () => {
  const execution = successfulExecution();
  const verificationStarted = verificationStart(verifier, 1, "verification:live");
  let board = projectBoard([...execution, verificationStarted]);
  assert.equal(board.state, "verifying");
  assert.equal(board.activeVerification?.id, "verification:live");

  board = projectBoard([
    ...execution,
    ...passingVerificationSequence(),
    event("review.started", { reviewId: "review:live", contractRevision: 1 }, { actor: reviewer }),
  ]);
  assert.equal(board.state, "reviewing");
  assert.equal(board.activeReview?.id, "review:live");
});

test("open decision identities cannot be silently overwritten or resolved when unknown", () => {
  const base = [event("work.created", { contract: work(), revision: 1 })];
  const decision = event("decision.requested", { decisionId: "decision:1", question: "Proceed?", choices: [] });
  const duplicate = event("decision.requested", { decisionId: "decision:1", question: "Different question", choices: [] });
  let board = projectBoard([...base, decision, duplicate]);
  assert.equal(board.violations.at(-1)?.code, "duplicate-decision");
  assert.equal(board.openDecisions["decision:1"], "Proceed?");

  const unknownResolution = event("decision.resolved", { decisionId: "decision:missing", resolution: "Yes" });
  board = projectBoard([...base, unknownResolution]);
  assert.equal(board.violations.at(-1)?.code, "unknown-decision");
});

test("duplicate Event IDs fail closed even when Board is called without Ledger", () => {
  const created = event("work.created", { contract: work(), revision: 1 });
  const board = projectBoard([created, created]);
  assert.equal(board.violations.at(-1)?.code, "duplicate-event");
});

test("terminal Attempts cannot be rewritten by late terminal events", () => {
  const events = successfulExecution();
  const lateFailure = event("attempt.failed", { reason: "late failure", recoverable: true }, { taskId: "task:1", attemptId: "attempt:1", actor: worker });
  const board = projectBoard([...events, lateFailure]);
  assert.equal(board.attempts["attempt:1"]?.state, "finished");
  assert.equal(board.violations.at(-1)?.code, "invalid-attempt-transition");
});

test("verification result requires a matching active lifecycle", () => {
  let board = projectBoard([...successfulExecution(), passingVerification()]);
  assert.equal(board.violations.at(-1)?.code, "verification-not-active");
  assert.equal(board.verifications.length, 0);

  board = projectBoard([
    ...successfulExecution(),
    verificationStart(verifier, 1, "verification:expected"),
    passingVerification(verifier, 1, "verification:other"),
  ]);
  assert.equal(board.violations.at(-1)?.code, "verification-not-active");
  assert.equal(board.activeVerification?.id, "verification:expected");
});

test("a second concurrent verification fails closed", () => {
  const board = projectBoard([
    ...successfulExecution(),
    verificationStart(verifier, 1, "verification:1"),
    verificationStart(reviewer, 1, "verification:2"),
  ]);
  assert.equal(board.activeVerification?.id, "verification:1");
  assert.equal(board.violations.at(-1)?.code, "verification-already-active");
});

test("contract amendments cannot silently race active work", () => {
  const contract = work();
  const board = projectBoard([
    event("work.created", { contract, revision: 1 }),
    event("task.created", { objective: "Implement" }, { taskId: "task:1" }),
    event("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:1", attemptId: "attempt:active", actor: worker }),
    event("work.amended", { changes: { objective: "Changed while running" }, revision: 2, reason: "race" }),
  ]);
  assert.equal(board.contractRevision, 1);
  assert.equal(board.violations.at(-1)?.code, "amendment-during-active-work");
});

test("assigned Tasks reject an Attempt from a different worker", () => {
  const other = { id: "agent:other", kind: "agent" as const };
  const board = projectBoard([
    event("work.created", { contract: work(), revision: 1 }),
    event("task.created", { objective: "Implement" }, { taskId: "task:1" }),
    event("task.assigned", { worker }, { taskId: "task:1" }),
    event("attempt.started", { worker: other, contractRevision: 1 }, { taskId: "task:1", attemptId: "attempt:1", actor: other }),
  ]);
  assert.equal(board.violations.at(-1)?.code, "worker-assignment-mismatch");
});

const integrationConfiguration = {
  ref: "refs/rhiz/work/work-1",
  head: "a".repeat(40),
  horizonPolicyId: "provisional-converge-on-private-advancement",
  provisionalHorizon: true as const,
};

test("a terminal Work still records a ghost worker as recorded-versus-execution divergence", () => {
  const board = projectBoard([
    ...successfulExecution(),
    ...passingVerificationSequence(),
    event("integration.initialized", { configuration: integrationConfiguration }),
    event("work.rejected", { reason: "Operator stopped the Work", contractRevision: 1 }),
    event("integration.execution-observed", {
      observation: { state: "running", source: "runtime:worker", observedAt: "2026-08-20T05:00:00.000Z" },
    }),
  ]);

  assert.equal(board.state, "rejected");
  assert.equal(board.integration?.latestExecutionObservation?.state, "running");
  assert.equal(board.integration?.divergences.at(-1)?.kind, "recorded-inactive-execution-active");
  assert.equal(board.violations.length, 0);
});

test("a parked Work refuses to start a verification or a review", () => {
  const parked = [
    ...successfulExecution(),
    event("work.parked", { reason: "waiting for a ruling" }),
  ];

  const withVerification = projectBoard([...parked, verificationStart()]);
  assert.equal(withVerification.state, "parked");
  assert.equal(withVerification.activeVerification, null);
  assert.equal(withVerification.violations.at(-1)?.code, "invalid-work-lifecycle-transition");

  const withReview = projectBoard([
    ...parked,
    event("review.started", { reviewId: "review:parked", contractRevision: 1 }, { actor: reviewer }),
  ]);
  assert.equal(withReview.state, "parked");
  assert.equal(withReview.activeReview, null);
  assert.equal(withReview.violations.at(-1)?.code, "invalid-work-lifecycle-transition");

  const released = projectBoard([
    ...parked,
    event("work.released", { reason: "ruling delivered" }),
    verificationStart(),
  ]);
  assert.equal(released.state, "verifying");
  assert.equal(released.activeVerification?.id, "verification:1");
});
