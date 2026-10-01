import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceReadiness, projectBoard } from "../src/board.js";
import {
  IntegrationController,
  IntegrationControllerError,
  IntegrationHorizonExceededError,
  PROVISIONAL_INTEGRATION_HORIZON,
  integrationCheckpointIsEligible,
  integrationWorkStreamId,
} from "../src/integration.js";
import type { EventCursor, EventLedger } from "../src/ledger.js";
import { analyzeClosedWork, streamIdForWork } from "../src/refiner.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import type { ActorRef, HarnessEvent, WorkContract } from "../src/schemas.js";
import { LogicalResourceClaimSchema, parseHarnessEvent } from "../src/schemas.js";
import { human, work } from "./helpers.js";

const controllerActor: ActorRef = { id: "service:integration-controller", kind: "service" };
const workerOne: ActorRef = { id: "agent:integration-worker-1", kind: "agent" };
const workerTwo: ActorRef = { id: "agent:integration-worker-2", kind: "agent" };
const workerThree: ActorRef = { id: "agent:integration-worker-3", kind: "agent" };

function ids(): () => string {
  let next = 0;
  return () => `${++next}`;
}

function now(): string {
  return "2026-08-24T00:00:00.000Z";
}

function contract(): WorkContract {
  return work({ id: "work:integration" });
}

async function appendWork(ledger: EventLedger, input = contract(), streamId = integrationWorkStreamId(input.id)): Promise<void> {
  await ledger.append(parseHarnessEvent({
    id: `event:work-created:${streamId}`,
    type: "work.created",
    schemaVersion: 1,
    streamId,
    workId: input.id,
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { contract: input, revision: 1 },
  }));
  await ledger.append(parseHarnessEvent({
    id: `event:task-one:${streamId}`,
    type: "task.created",
    schemaVersion: 1,
    streamId,
    workId: input.id,
    taskId: "task:one",
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { objective: "Implement one bounded integration slice" },
  }));
}

async function controller(ledger: EventLedger, idFactory = ids()): Promise<IntegrationController> {
  return IntegrationController.initialize({
    ledger,
    actor: controllerActor,
    workId: "work:integration",
    now,
    idFactory,
    configuration: {
      ref: "refs/rhiz/work/work-integration",
      head: "a".repeat(40),
      horizonPolicyId: PROVISIONAL_INTEGRATION_HORIZON.id,
      provisionalHorizon: true,
    },
  });
}

function initializeAs(ledger: EventLedger, actor: ActorRef, idFactory = ids()): Promise<IntegrationController> {
  return IntegrationController.initialize({
    ledger,
    actor,
    workId: "work:integration",
    now,
    idFactory,
    configuration: {
      ref: "refs/rhiz/work/work-integration",
      head: "a".repeat(40),
      horizonPolicyId: PROVISIONAL_INTEGRATION_HORIZON.id,
      provisionalHorizon: true,
    },
  });
}

function openAs(ledger: EventLedger, actor: ActorRef, idFactory = ids()): Promise<IntegrationController> {
  return IntegrationController.open({ ledger, actor, workId: "work:integration", now, idFactory });
}

function lease(id: string, worker: ActorRef, expiresAt = "2026-08-24T01:00:00.000Z", resource = "src/integration.ts") {
  return {
    id,
    workspaceId: `workspace:${worker.id}`,
    resourceClaims: [{ kind: "path" as const, resource }],
    acquiredAt: now(),
    expiresAt,
  };
}

class FailingLedger implements EventLedger {
  readonly #inner = new InMemoryEventLedger();
  failNextAppend = false;

  async append(event: HarnessEvent): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("simulated durable append failure");
    }
    await this.#inner.append(event);
  }

  read(streamId: string, after?: EventCursor): AsyncIterable<HarnessEvent> {
    return this.#inner.read(streamId, after);
  }

  replay(streamId: string): Promise<readonly HarnessEvent[]> {
    return this.#inner.replay(streamId);
  }
}

test("one Work owns one durable integration head in the existing Ledger and Board", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  assert.equal(integration.board.workId, "work:integration");
  assert.equal(integration.board.integration?.configuration.ref, "refs/rhiz/work/work-integration");
  assert.equal(integration.board.integration?.configuration.head, "a".repeat(40));
  await assert.rejects(
    () => IntegrationController.initialize({
      ledger,
      actor: controllerActor,
      workId: "work:integration",
      now,
      idFactory: ids(),
      configuration: {
        ref: "refs/rhiz/work/competing",
        head: "b".repeat(40),
        horizonPolicyId: "other",
        provisionalHorizon: true,
      },
    }),
    IntegrationControllerError,
  );
  const events = await ledger.replay(integrationWorkStreamId("work:integration"));
  assert.equal(projectBoard(events).integration?.configuration.ref, "refs/rhiz/work/work-integration");
});

test("a worker cannot initialize integration control, while the operator service can", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);

  await assert.rejects(
    () => initializeAs(ledger, workerOne),
    /integration operator authority/,
  );
  assert.equal(projectBoard(await ledger.replay(integrationWorkStreamId("work:integration"))).integration, null);

  const integration = await controller(ledger);
  assert.equal(integration.board.integration?.configuration.ref, "refs/rhiz/work/work-integration");
});

test("a worker cannot start an integrated Attempt, while the operator service can", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  const workerController = await openAs(ledger, workerOne, () => "worker-start");

  await assert.rejects(
    () => workerController.startAttempt({
      taskId: "task:one",
      attemptId: "attempt:worker-start",
      worker: workerOne,
      lease: lease("lease:worker-start", workerOne),
    }),
    /integration operator authority/,
  );
  assert.equal(integration.board.attempts["attempt:worker-start"], undefined);

  await integration.startAttempt({
    taskId: "task:one",
    attemptId: "attempt:operator-start",
    worker: workerOne,
    lease: lease("lease:operator-start", workerOne),
  });
  assert.equal(integration.board.attempts["attempt:operator-start"]?.state, "running");
});

test("a worker cannot self-release a parked Work, while the operator service can", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.park("awaiting operator integration decision");
  const workerController = await openAs(ledger, workerOne, () => "worker-release");

  await assert.rejects(
    () => workerController.release("worker declares the parked Work ready"),
    /integration operator authority/,
  );
  assert.equal(integration.board.state, "parked");

  await integration.release("operator resumes the Work");
  assert.equal(integration.board.state, "ready");
});

test("a caller cannot create a second Work integration spine by choosing a shadow stream", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  await appendWork(ledger, contract(), "stream:shadow-work-integration");

  await assert.rejects(
    () => IntegrationController.initialize({
      ledger,
      actor: controllerActor,
      workId: "work:integration",
      streamId: "stream:shadow-work-integration",
      now,
      idFactory: ids(),
      configuration: {
        ref: "refs/rhiz/work/shadow",
        head: "b".repeat(40),
        horizonPolicyId: PROVISIONAL_INTEGRATION_HORIZON.id,
        provisionalHorizon: true,
      },
    }),
    /must use the canonical Work stream/,
  );
});

test("Board rejects a direct unleased Attempt after Work integration is enabled", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await ledger.append(parseHarnessEvent({
    id: "event:unleased-attempt",
    type: "attempt.started",
    schemaVersion: 1,
    streamId: integrationWorkStreamId("work:integration"),
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:unleased",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { worker: workerOne, contractRevision: 1 },
  }));

  const board = projectBoard(await ledger.replay(integrationWorkStreamId("work:integration")));
  assert.equal(board.attempts["attempt:unleased"], undefined);
  assert.equal(board.violations.at(-1)?.code, "attempt-lease-required");
});

test("integration cannot be enabled around an already-running unleased Attempt", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  await ledger.append(parseHarnessEvent({
    id: "event:attempt-before-integration",
    type: "attempt.started",
    schemaVersion: 1,
    streamId: integrationWorkStreamId("work:integration"),
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:before-integration",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { worker: workerOne, contractRevision: 1 },
  }));

  await assert.rejects(() => controller(ledger), /requires an idle Work/);
});

test("the integration controller never advances Board state when its durable append fails", async () => {
  const ledger = new FailingLedger();
  await appendWork(ledger);
  ledger.failNextAppend = true;
  await assert.rejects(() => controller(ledger), /simulated durable append failure/);
  const board = projectBoard(await ledger.replay(integrationWorkStreamId("work:integration")));
  assert.equal(board.integration, null);
  assert.equal(board.state, "ready");
});

test("Work lifecycle parking and execution observations converge through Board without silent overwrite", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.park("waiting for an integration ruling");
  assert.equal(integration.board.state, "parked");
  await integration.observeExecution({ state: "running", source: "runtime:worker", observedAt: "2026-08-24T00:02:00.000Z" });
  assert.equal(integration.board.state, "parked");
  assert.equal(integration.board.integration?.divergences[0]?.kind, "recorded-inactive-execution-active");

  await integration.release("ruling released the Work");
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  assert.equal(integration.board.state, "running");
  await integration.observeExecution({ state: "parked", source: "runtime:worker", observedAt: "2026-08-24T00:03:00.000Z" });
  assert.equal(integration.board.state, "running");
  assert.equal(integration.board.integration?.divergences[1]?.kind, "recorded-active-execution-inactive");
});

test("Attempt leases prevent logical writer collisions, survive checkpointed takeover, and release on expiry", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const streamId = integrationWorkStreamId("work:integration");
  await ledger.append(parseHarnessEvent({
    id: "event:task-two",
    type: "task.created",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:two",
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { objective: "Competing write" },
  }));
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne, "2026-08-24T00:10:00.000Z") });
  await assert.rejects(
    () => integration.startAttempt({ taskId: "task:two", attemptId: "attempt:two", worker: workerTwo, lease: lease("lease:two", workerTwo) }),
    /logical resource lease conflicts/,
  );

  await integration.recordCheckpoint({
    taskId: "task:one",
    attemptId: "attempt:one",
    checkpoint: {
      id: "checkpoint:rescue",
      class: "wip-rescue",
      parentIntegrationHead: "a".repeat(40),
      workspaceId: `workspace:${workerOne.id}`,
      changedResources: [{ kind: "path", resource: "src/integration.ts" }],
      head: "b".repeat(40),
      tree: "c".repeat(40),
      proofState: "failed",
      remoteRef: "refs/rhiz/rescue/work-integration/attempt-one",
      remoteStatus: "local-only",
    },
  });
  await integration.takeOverAttempt({
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerTwo,
    lease: lease("lease:two", workerTwo, "2026-08-24T00:20:00.000Z"),
    reason: "checkpointed handoff",
  });
  assert.equal(integration.board.attempts["attempt:one"]?.worker.id, workerTwo.id);
  assert.equal(integration.board.attempts["attempt:one"]?.lease?.id, "lease:two");

  await integration.releaseExpiredAttempt("attempt:one", "2026-08-24T00:20:00.000Z");
  assert.equal(integration.board.attempts["attempt:one"]?.state, "failed");
  assert.equal(integration.board.attempts["attempt:one"]?.lease, undefined);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:replacement", worker: workerThree, lease: lease("lease:three", workerThree) });
  assert.equal(integration.board.workId, "work:integration");
  assert.equal(integration.board.attempts["attempt:replacement"]?.worker.id, workerThree.id);
});

test("a confirmed worker death releases only its Attempt lease so Work can continue", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.startAttempt({
    taskId: "task:one",
    attemptId: "attempt:dead-worker",
    worker: workerOne,
    lease: lease("lease:dead-worker", workerOne),
  });

  await integration.releaseAttemptForWorkerDeath("attempt:dead-worker", "worker session ended without a handoff");

  assert.equal(integration.board.state, "failed");
  assert.equal(integration.board.attempts["attempt:dead-worker"]?.lease, undefined);
  await integration.startAttempt({
    taskId: "task:one",
    attemptId: "attempt:successor",
    worker: workerTwo,
    lease: lease("lease:successor", workerTwo),
  });
  assert.equal(integration.board.state, "running");
  assert.equal(integration.board.attempts["attempt:successor"]?.worker.id, workerTwo.id);
});

test("a takeover cannot revive an expired Attempt lease", async () => {
  let currentTime = now();
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await IntegrationController.initialize({
    ledger,
    actor: controllerActor,
    workId: "work:integration",
    now: () => currentTime,
    idFactory: ids(),
    configuration: {
      ref: "refs/rhiz/work/work-integration",
      head: "a".repeat(40),
      horizonPolicyId: PROVISIONAL_INTEGRATION_HORIZON.id,
      provisionalHorizon: true,
    },
  });
  await integration.startAttempt({
    taskId: "task:one",
    attemptId: "attempt:expired-owner",
    worker: workerOne,
    lease: lease("lease:expired-owner", workerOne, "2026-08-24T00:10:00.000Z"),
  });
  await integration.recordCheckpoint({
    taskId: "task:one",
    attemptId: "attempt:expired-owner",
    checkpoint: {
      id: "checkpoint:expired-owner",
      class: "wip-rescue",
      parentIntegrationHead: "a".repeat(40),
      workspaceId: `workspace:${workerOne.id}`,
      changedResources: [{ kind: "path", resource: "src/integration.ts" }],
      head: "b".repeat(40),
      tree: "c".repeat(40),
      proofState: "not-run",
      remoteRef: "refs/rhiz/rescue/work-integration/expired-owner",
      remoteStatus: "local-only",
    },
  });
  currentTime = "2026-08-24T00:20:00.000Z";

  await assert.rejects(
    () => integration.takeOverAttempt({
      taskId: "task:one",
      attemptId: "attempt:expired-owner",
      worker: workerTwo,
      lease: lease("lease:successor", workerTwo, "2026-08-24T00:30:00.000Z"),
      reason: "a transfer after expiry must not resurrect the old lease",
    }),
    /has expired/,
  );

  await ledger.append(parseHarnessEvent({
    id: "event:expired-lease-bypass",
    type: "attempt.lease-transferred",
    schemaVersion: 1,
    streamId: integrationWorkStreamId("work:integration"),
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:expired-owner",
    actor: controllerActor,
    occurredAt: currentTime,
    recordedAt: currentTime,
    evidence: [],
    payload: {
      fromLeaseId: "lease:expired-owner",
      worker: workerTwo,
      lease: lease("lease:raw-bypass", workerTwo, "2026-08-24T00:30:00.000Z"),
      reason: "raw events must not revive expired leases either",
    },
  }));
  const board = projectBoard(await ledger.replay(integrationWorkStreamId("work:integration")));
  assert.equal(board.violations.at(-1)?.code, "attempt-lease-expired");
});

test("WIP rescue and integration-candidate checkpoints are distinct, and the horizon is injectable", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  const streamId = integrationWorkStreamId("work:integration");
  // Execution evidence for this attempt. Without it the Board reports
  // unverifiable rather than ready: see authorshipUnproven in board.ts.
  await ledger.append(parseHarnessEvent({
    id: "event:attempt-observed",
    type: "attempt.activity-observed",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { state: "working", detail: "message: worker edited src/feature.ts", source: workerOne.id, authority: "observation" },
  }));
  await ledger.append(parseHarnessEvent({
    id: "event:attempt-guarded-write",
    type: "guard.evaluated",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: {
      request: { requestId: "guard:attempt:one", workId: "work:integration", taskId: "task:one", attemptId: "attempt:one", actor: workerOne, writeScope: "workspace", contextHash: "ctx:attempt:one", evidenceRefs: [], timestampMs: 1787000000000, tool: { name: "worker:file-change", category: "write", args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } } },
      verdict: { requestId: "guard:attempt:one", decision: "allow", rationale: "fixture write authorized", riskLevel: "medium", ruleHits: ["per-category-mode:write:allow"], evaluatedAt: now(), durationMs: 1, policyBackend: "rhiz-native", policyBackendVersion: "0.1.0" },
    },
  }));
  await ledger.append(parseHarnessEvent({
    id: "event:attempt-finished",
    type: "attempt.finished",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { resultSummary: "candidate ready for independent verification", artifactRefs: [] },
  }));
  const verifier: ActorRef = { id: "verifier:integration", kind: "verifier" };
  await ledger.append(parseHarnessEvent({
    id: "event:verification-started",
    type: "verification.started",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    actor: verifier,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { verificationId: "verification:integration", contractRevision: 1 },
  }));
  await ledger.append(parseHarnessEvent({
    id: "event:independent-proof",
    type: "verification.result",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    actor: verifier,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: {
      verificationId: "verification:integration",
      contractRevision: 1,
      status: "pass",
      criterionResults: [{
        criterionId: "criterion:tests",
        status: "pass",
        evidence: [{ id: "evidence:candidate-proof", kind: "test", digest: "sha256:candidate-proof" }],
      }],
      evidenceSatisfaction: [{
        requirementId: "evidence:tests",
        evidence: [{ id: "evidence:candidate-proof", kind: "test", digest: "sha256:candidate-proof" }],
      }],
      falsifiability: { provenCriteria: ["criterion:tests"], exemptedCriteria: [] },
    },
  }));
  const candidate = {
    id: "checkpoint:candidate",
    class: "integration-candidate" as const,
    parentIntegrationHead: "a".repeat(40),
    workspaceId: `workspace:${workerOne.id}`,
    changedResources: [{ kind: "path" as const, resource: "src/integration.ts" }],
    head: "d".repeat(40),
    tree: "e".repeat(40),
    proofState: "passed" as const,
    proofHead: "d".repeat(40),
    verificationEventId: "event:independent-proof",
    remoteRef: "refs/rhiz/checkpoints/work-integration/attempt-one",
    remoteStatus: "pushed" as const,
  };
  assert.equal(integrationCheckpointIsEligible(candidate, "a".repeat(40)), true);
  await integration.recordCheckpoint({ taskId: "task:one", attemptId: "attempt:one", checkpoint: candidate });
  assert.equal(integration.board.integration?.checkpoints["checkpoint:candidate"]?.checkpoint.class, "integration-candidate");
  assert.equal(integration.board.state, "ready", "a candidate is not acceptance or merge proof");

  assert.throws(
    () => integration.enforceHorizon({
      commitsAhead: 1,
      commitsBehind: 0,
      elapsedMsSinceConvergence: 0,
      divergenceAgeMs: 0,
      diffLines: 0,
      binaryFilesChanged: 0,
      upstreamState: "pushed",
      overlappingResourceClaims: 0,
      integrationHeadMoved: false,
      proofInvalidationRisk: false,
    }),
    IntegrationHorizonExceededError,
  );
  integration.enforceHorizon({
    commitsAhead: 100,
    commitsBehind: 100,
    elapsedMsSinceConvergence: 1_000_000,
    divergenceAgeMs: 1_000_000,
    diffLines: 1_000_000,
    binaryFilesChanged: 0,
    upstreamState: "pushed",
    overlappingResourceClaims: 100,
    integrationHeadMoved: true,
    proofInvalidationRisk: true,
  }, {
    id: "dogfood-policy",
    status: "provisional",
    requiresConvergence: () => false,
  });
});

test("integration events land on the canonical Work stream the Refiner replays", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  await ledger.append(parseHarnessEvent({
    id: "event:work-cancelled",
    type: "work.cancelled",
    schemaVersion: 1,
    streamId: streamIdForWork("work:integration"),
    workId: "work:integration",
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { reason: "closed for refiner analysis", contractRevision: 1 },
  }));

  const analysis = await analyzeClosedWork("work:integration", ledger);
  assert.equal(analysis.outcome, "cancelled");
  assert.ok(analysis.ledgerEventCount >= 4, "the Refiner replays the controller's own integration events");
});

test("a blocked Attempt keeps its lease so an overlapping writer is still rejected", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const streamId = integrationWorkStreamId("work:integration");
  await ledger.append(parseHarnessEvent({
    id: "event:task-two-blocked",
    type: "task.created",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:two",
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { objective: "Competing write while the first Attempt is blocked" },
  }));
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  await ledger.append(parseHarnessEvent({
    id: "event:attempt-blocked",
    type: "attempt.blocked",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { reason: "worker paused on an open decision" },
  }));

  await integration.refresh();
  assert.equal(integration.board.attempts["attempt:one"]?.state, "blocked");
  assert.equal(integration.board.attempts["attempt:one"]?.lease?.id, "lease:one");
  await assert.rejects(
    () => integration.startAttempt({ taskId: "task:two", attemptId: "attempt:two", worker: workerTwo, lease: lease("lease:two", workerTwo) }),
    /logical resource lease conflicts/,
  );

  await ledger.append(parseHarnessEvent({
    id: "event:raw-overlapping-attempt",
    type: "attempt.started",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:two",
    attemptId: "attempt:raw-overlap",
    actor: workerTwo,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { worker: workerTwo, contractRevision: 1, lease: lease("lease:raw-overlap", workerTwo) },
  }));
  const board = projectBoard(await ledger.replay(streamId));
  assert.equal(board.attempts["attempt:raw-overlap"], undefined);
  assert.equal(board.violations.at(-1)?.code, "resource-lease-conflict");

  await integration.releaseAttemptForWorkerDeath("attempt:one", "blocked worker session ended");
  assert.equal(integration.board.attempts["attempt:one"]?.lease, undefined);
});

test("a parked Work cannot start an Attempt through the controller or a raw Board event", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.park("waiting for a ruling");

  await assert.rejects(
    () => integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) }),
    /is parked/,
  );

  const streamId = integrationWorkStreamId("work:integration");
  await ledger.append(parseHarnessEvent({
    id: "event:raw-parked-attempt",
    type: "attempt.started",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:raw-parked",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { worker: workerOne, contractRevision: 1, lease: lease("lease:raw-parked", workerOne) },
  }));
  const board = projectBoard(await ledger.replay(streamId));
  assert.equal(board.attempts["attempt:raw-parked"], undefined);
  assert.equal(board.state, "parked");
  assert.equal(board.violations.at(-1)?.code, "invalid-work-lifecycle-transition");

  await integration.release("ruling released the Work");
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  assert.equal(integration.board.attempts["attempt:one"]?.state, "running");
});

test("an unrelated writer's rejected event never bricks the controller for a dead worker's lease", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  await ledger.append(parseHarnessEvent({
    id: "event:foreign-unleased-attempt",
    type: "attempt.started",
    schemaVersion: 1,
    streamId: integrationWorkStreamId("work:integration"),
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:foreign-unleased",
    actor: workerThree,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { worker: workerThree, contractRevision: 1 },
  }));

  await integration.releaseAttemptForWorkerDeath("attempt:one", "worker session ended without a handoff");
  assert.equal(integration.board.attempts["attempt:one"]?.lease, undefined);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:successor", worker: workerTwo, lease: lease("lease:successor", workerTwo) });
  assert.equal(integration.board.attempts["attempt:successor"]?.worker.id, workerTwo.id);
});

test("the controller still reports a Board-rejected operation it caused itself", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  await assert.rejects(
    () => integration.recordCheckpoint({
      taskId: "task:one",
      attemptId: "attempt:one",
      checkpoint: {
        id: "checkpoint:ineligible",
        class: "integration-candidate",
        parentIntegrationHead: "a".repeat(40),
        workspaceId: `workspace:${workerOne.id}`,
        changedResources: [{ kind: "path", resource: "src/integration.ts" }],
        head: "d".repeat(40),
        tree: "e".repeat(40),
        proofState: "passed",
        proofHead: "d".repeat(40),
        verificationEventId: "event:missing-proof",
        remoteRef: "refs/rhiz/checkpoints/work-integration/ineligible",
        remoteStatus: "pushed",
      },
    }),
    /passing verification/,
  );
  assert.equal(integration.board.integration?.checkpoints["checkpoint:ineligible"], undefined);
});

test("a candidate without its passing verification is reported as candidate ineligibility, not attempt mismatch", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const streamId = integrationWorkStreamId("work:integration");
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  await ledger.append(parseHarnessEvent({
    id: "event:raw-ineligible-candidate",
    type: "integration.checkpoint-recorded",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: controllerActor,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: {
      checkpoint: {
        id: "checkpoint:raw-ineligible",
        class: "integration-candidate",
        parentIntegrationHead: "a".repeat(40),
        workspaceId: `workspace:${workerOne.id}`,
        changedResources: [{ kind: "path", resource: "src/integration.ts" }],
        head: "d".repeat(40),
        tree: "e".repeat(40),
        proofState: "passed",
        proofHead: "d".repeat(40),
        verificationEventId: "event:missing-proof",
        remoteRef: "refs/rhiz/checkpoints/work-integration/raw-ineligible",
        remoteStatus: "pushed",
      },
    },
  }));

  const board = projectBoard(await ledger.replay(streamId));
  assert.equal(board.integration?.checkpoints["checkpoint:raw-ineligible"], undefined);
  assert.equal(board.violations.at(-1)?.code, "checkpoint-candidate-ineligible");
});

test("the provisional horizon separates idle elapsed time from private advancement", async () => {
  const idle = {
    commitsAhead: 0,
    commitsBehind: 0,
    elapsedMsSinceConvergence: 3_600_000,
    divergenceAgeMs: 0,
    diffLines: 0,
    binaryFilesChanged: 0,
    upstreamState: "pushed" as const,
    overlappingResourceClaims: 0,
    integrationHeadMoved: false,
    proofInvalidationRisk: false,
  };
  assert.equal(PROVISIONAL_INTEGRATION_HORIZON.requiresConvergence(idle), false);
  assert.equal(PROVISIONAL_INTEGRATION_HORIZON.requiresConvergence({ ...idle, diffLines: 1 }), true);
  assert.equal(PROVISIONAL_INTEGRATION_HORIZON.requiresConvergence({ ...idle, integrationHeadMoved: true }), true);
});

test("execution observed as running while the Work is verifying is not a ghost-worker divergence", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const streamId = integrationWorkStreamId("work:integration");
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne) });
  await ledger.append(parseHarnessEvent({
    id: "event:attempt-finished-for-verification",
    type: "attempt.finished",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { resultSummary: "ready for verification", artifactRefs: [] },
  }));
  await ledger.append(parseHarnessEvent({
    id: "event:verification-started-divergence",
    type: "verification.started",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    actor: { id: "verifier:integration", kind: "verifier" },
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { verificationId: "verification:divergence", contractRevision: 1 },
  }));

  await integration.refresh();
  assert.equal(integration.board.state, "verifying");
  await integration.observeExecution({ state: "running", source: "runtime:worker", observedAt: "2026-08-24T00:05:00.000Z" });
  assert.equal(integration.board.integration?.divergences.at(-1)?.kind, "work-state-mismatch");
});

test("a delayed execution observation never overwrites a newer recorded observation", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await integration.observeExecution({ state: "running", source: "runtime:worker", observedAt: "2026-08-24T12:00:00.000Z" });
  assert.equal(integration.board.integration?.latestExecutionObservation?.state, "running");
  const divergencesBefore = integration.board.integration?.divergences.length ?? 0;

  await assert.rejects(
    () => integration.observeExecution({ state: "ready", source: "runtime:worker", observedAt: "2026-08-24T11:00:00.000Z" }),
    /stale-execution-observation/,
  );

  const board = projectBoard(await ledger.replay(integrationWorkStreamId("work:integration")));
  assert.equal(board.integration?.latestExecutionObservation?.observedAt, "2026-08-24T12:00:00.000Z");
  assert.equal(board.integration?.latestExecutionObservation?.state, "running");
  assert.equal(board.integration?.divergences.length, divergencesBefore);
  assert.equal(board.violations.at(-1)?.code, "stale-execution-observation");
});

test("logical path claims collide even when written in an equivalent unnormalized form", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const streamId = integrationWorkStreamId("work:integration");
  await ledger.append(parseHarnessEvent({
    id: "event:task-two-paths",
    type: "task.created",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:two",
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { objective: "Competing write in an equivalent path form" },
  }));
  const integration = await controller(ledger);
  await integration.startAttempt({
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    lease: lease("lease:one", workerOne, "2026-08-24T01:00:00.000Z", "src"),
  });

  for (const equivalent of ["src/../src", "/src", "./src/", "src/../src/integration.ts"]) {
    await assert.rejects(
      () => integration.startAttempt({
        taskId: "task:two",
        attemptId: `attempt:${equivalent}`,
        worker: workerTwo,
        lease: lease(`lease:${equivalent}`, workerTwo, "2026-08-24T01:00:00.000Z", equivalent),
      }),
      /logical resource lease conflicts/,
      `claim ${equivalent} must collide with the held claim on src`,
    );
  }

  await ledger.append(parseHarnessEvent({
    id: "event:raw-repo-root-claim",
    type: "attempt.started",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:two",
    attemptId: "attempt:repo-root",
    actor: workerTwo,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: {
      worker: workerTwo,
      contractRevision: 1,
      lease: lease("lease:repo-root", workerTwo, "2026-08-24T01:00:00.000Z", "."),
    },
  }));
  const board = projectBoard(await ledger.replay(streamId));
  assert.equal(board.attempts["attempt:repo-root"], undefined);
  assert.equal(board.violations.at(-1)?.code, "resource-lease-conflict");

  await integration.startAttempt({
    taskId: "task:two",
    attemptId: "attempt:disjoint",
    worker: workerTwo,
    lease: lease("lease:disjoint", workerTwo, "2026-08-24T01:00:00.000Z", "docs/../test"),
  });
  assert.equal(integration.board.attempts["attempt:disjoint"]?.lease?.id, "lease:disjoint");
});

function passingVerificationEvents(streamId: string, actor: ActorRef, suffix: string): HarnessEvent[] {
  return [
    parseHarnessEvent({
      id: `event:verification-started:${suffix}`,
      type: "verification.started",
      schemaVersion: 1,
      streamId,
      workId: "work:integration",
      actor,
      occurredAt: now(),
      recordedAt: now(),
      evidence: [],
      payload: { verificationId: `verification:${suffix}`, contractRevision: 1 },
    }),
    parseHarnessEvent({
      id: `event:verification-result:${suffix}`,
      type: "verification.result",
      schemaVersion: 1,
      streamId,
      workId: "work:integration",
      actor,
      occurredAt: now(),
      recordedAt: now(),
      evidence: [],
      payload: {
        verificationId: `verification:${suffix}`,
        contractRevision: 1,
        status: "pass",
        criterionResults: [{
          criterionId: "criterion:tests",
          status: "pass",
          evidence: [{ id: `evidence:${suffix}`, kind: "test", digest: `sha256:${suffix}` }],
        }],
        evidenceSatisfaction: [{
          requirementId: "evidence:tests",
          evidence: [{ id: `evidence:${suffix}`, kind: "test", digest: `sha256:${suffix}` }],
        }],
        falsifiability: { provenCriteria: ["criterion:tests"], exemptedCriteria: [] },
      },
    }),
  ];
}

test("a checkpointed lease handoff keeps every executor out of verification and acceptance", async () => {
  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const streamId = integrationWorkStreamId("work:integration");
  const integration = await controller(ledger);
  await integration.startAttempt({ taskId: "task:one", attemptId: "attempt:one", worker: workerOne, lease: lease("lease:one", workerOne, "2026-08-24T02:00:00.000Z") });
  await integration.recordCheckpoint({
    taskId: "task:one",
    attemptId: "attempt:one",
    checkpoint: {
      id: "checkpoint:handoff",
      class: "wip-rescue",
      parentIntegrationHead: "a".repeat(40),
      workspaceId: `workspace:${workerOne.id}`,
      changedResources: [{ kind: "path", resource: "src/integration.ts" }],
      head: "b".repeat(40),
      tree: "c".repeat(40),
      proofState: "not-run",
      remoteRef: "refs/rhiz/rescue/work-integration/attempt-one",
      remoteStatus: "local-only",
    },
  });
  await integration.takeOverAttempt({
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerTwo,
    lease: lease("lease:two", workerTwo, "2026-08-24T03:00:00.000Z"),
    reason: "checkpointed handoff",
  });
  assert.equal(integration.board.attempts["attempt:one"]?.worker.id, workerTwo.id);
  assert.deepEqual(
    integration.board.attempts["attempt:one"]?.executionProvenance.map((actor) => actor.id),
    [workerOne.id, workerTwo.id],
  );

  await ledger.append(parseHarnessEvent({
    id: "event:handoff-attempt-finished",
    type: "attempt.finished",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: workerTwo,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { resultSummary: "handed-off work complete", artifactRefs: [] },
  }));

  for (const executor of [workerOne, workerTwo]) {
    for (const event of passingVerificationEvents(streamId, { id: executor.id, kind: "verifier" }, `self-${executor.id}`)) {
      await ledger.append(event);
    }
    const selfVerified = projectBoard(await ledger.replay(streamId));
    const readiness = acceptanceReadiness(selfVerified);
    assert.equal(readiness.ready, false, `${executor.id} must not qualify as its own independent verifier`);

    await ledger.append(parseHarnessEvent({
      id: `event:self-accept:${executor.id}`,
      type: "work.accepted",
      schemaVersion: 1,
      streamId,
      workId: "work:integration",
      actor: executor,
      occurredAt: now(),
      recordedAt: now(),
      evidence: [],
      payload: { reason: "accepting my own executed Work", contractRevision: 1 },
    }));
    const afterSelfAccept = projectBoard(await ledger.replay(streamId));
    assert.notEqual(afterSelfAccept.state, "accepted");
    assert.equal(afterSelfAccept.violations.at(-1)?.code, "acceptance-preconditions-not-met");
  }

  const independent: ActorRef = { id: "verifier:uninvolved", kind: "verifier" };
  for (const event of passingVerificationEvents(streamId, independent, "independent")) {
    await ledger.append(event);
  }
  const verified = projectBoard(await ledger.replay(streamId));
  assert.equal(acceptanceReadiness(verified).ready, false);
  assert.ok(acceptanceReadiness(verified).reasons.includes(
    "required passing verification bound to the exact Work integration head is missing",
  ));

  await ledger.append(parseHarnessEvent({
    id: "event:independent-accept",
    type: "work.accepted",
    schemaVersion: 1,
    streamId,
    workId: "work:integration",
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { reason: "independently verified", contractRevision: 1 },
  }));
  const afterPrematureAccept = projectBoard(await ledger.replay(streamId));
  assert.notEqual(afterPrematureAccept.state, "accepted");
  assert.equal(afterPrematureAccept.violations.at(-1)?.code, "acceptance-preconditions-not-met");
});

test("a logical path claim above the workspace root is rejected at the schema boundary", async () => {
  for (const escaping of ["..", "../elsewhere", "src/../..", "src\\\\..\\\\.."]) {
    assert.throws(
      () => LogicalResourceClaimSchema.parse({ kind: "path", resource: escaping }),
      /within the workspace root/,
      `claim ${escaping} must be refused`,
    );
  }
  assert.equal(LogicalResourceClaimSchema.parse({ kind: "path", resource: "src/../src" }).resource, "src/../src");
  assert.equal(LogicalResourceClaimSchema.parse({ kind: "command", resource: "../anything" }).kind, "command");

  const ledger = new InMemoryEventLedger();
  await appendWork(ledger);
  const integration = await controller(ledger);
  await assert.rejects(
    () => integration.startAttempt({
      taskId: "task:one",
      attemptId: "attempt:escaping",
      worker: workerOne,
      lease: lease("lease:escaping", workerOne, "2026-08-24T01:00:00.000Z", "src/../.."),
    }),
    /within the workspace root/,
  );
  assert.equal(integration.board.attempts["attempt:escaping"], undefined);
});
