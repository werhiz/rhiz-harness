import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceReadiness, projectBoard } from "../src/board.js";
import {
  IntegrationController,
  INTEGRATION_CONTROLLER_INVARIANTS,
  PROVISIONAL_INTEGRATION_HORIZON,
  type IntegrationExecutionRequest,
  type IntegrationExecutionResult,
  type WorkIntegrationExecutor,
  integrationWorkStreamId,
} from "../src/integration.js";
import {
  GuardianRejectionCircuitBreaker,
  RhizNativePolicyOracle,
  assertGuardCanEvaluate,
  guardPolicyFromWorkContract,
  parseGuardRequest,
} from "../src/guard.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import type { ActorRef, HarnessEvent, WorkContract } from "../src/schemas.js";
import { parseHarnessEvent } from "../src/schemas.js";
import { human, work } from "./helpers.js";

const service: ActorRef = { id: "service:integration", kind: "service" };
const workerOne: ActorRef = { id: "agent:one", kind: "agent" };
const workerTwo: ActorRef = { id: "agent:two", kind: "agent" };
const verifier: ActorRef = { id: "verifier:integration", kind: "verifier" };
const initialHead = "a".repeat(40);
const candidateOne = "b".repeat(40);
const candidateTwo = "c".repeat(40);

test("Issue #77 exposes twelve typed invariants with twelve explicit falsifiers", () => {
  assert.equal(INTEGRATION_CONTROLLER_INVARIANTS.length, 12);
  assert.equal(new Set(INTEGRATION_CONTROLLER_INVARIANTS.map((item) => item.id)).size, 12);
  for (const item of INTEGRATION_CONTROLLER_INVARIANTS) {
    assert.match(item.id, /^integration\//);
    assert.ok(item.invariant.length > 20, item.id);
    assert.ok(item.falsifier.length > 20, item.id);
  }
});

function ids(): () => string {
  let next = 0;
  return () => `${++next}`;
}

function now(): string {
  return "2026-08-29T12:00:00.000Z";
}

function contract(): WorkContract {
  return work({ id: "work:integration-v77" });
}

async function appendFoundation(ledger: InMemoryEventLedger): Promise<void> {
  const streamId = integrationWorkStreamId(contract().id);
  await ledger.append(parseHarnessEvent({
    id: "event:work-created:v77",
    type: "work.created",
    schemaVersion: 1,
    streamId,
    workId: contract().id,
    actor: human,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { contract: contract(), revision: 1 },
  }));
  for (const taskId of ["task:one", "task:two"]) {
    await ledger.append(parseHarnessEvent({
      id: `event:${taskId}`,
      type: "task.created",
      schemaVersion: 1,
      streamId,
      workId: contract().id,
      taskId,
      actor: human,
      occurredAt: now(),
      recordedAt: now(),
      evidence: [],
      payload: { objective: `Implement ${taskId}` },
    }));
  }
}

async function initialized(ledger: InMemoryEventLedger): Promise<IntegrationController> {
  return IntegrationController.initialize({
    ledger,
    actor: service,
    workId: contract().id,
    now,
    idFactory: ids(),
    configuration: {
      ref: "refs/rhiz/work/work-integration-v77/candidate",
      head: initialHead,
      horizonPolicyId: PROVISIONAL_INTEGRATION_HORIZON.id,
      provisionalHorizon: true,
    },
  });
}

function lease(id: string, worker: ActorRef, resource: string) {
  return {
    id,
    workspaceId: `workspace:${worker.id}`,
    resourceClaims: [{ kind: "path" as const, resource }],
    acquiredAt: now(),
    expiresAt: "2026-08-29T13:00:00.000Z",
  };
}

async function appendPassingVerification(
  ledger: InMemoryEventLedger,
  suffix: string,
): Promise<string> {
  const streamId = integrationWorkStreamId(contract().id);
  const resultEventId = `event:verification-result:${suffix}`;
  const events: HarnessEvent[] = [
    parseHarnessEvent({
      id: `event:verification-started:${suffix}`,
      type: "verification.started",
      schemaVersion: 1,
      streamId,
      workId: contract().id,
      actor: verifier,
      occurredAt: now(),
      recordedAt: now(),
      evidence: [],
      payload: { verificationId: `verification:${suffix}`, contractRevision: 1 },
    }),
    parseHarnessEvent({
      id: resultEventId,
      type: "verification.result",
      schemaVersion: 1,
      streamId,
      workId: contract().id,
      actor: verifier,
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
  for (const event of events) await ledger.append(event);
  return resultEventId;
}

class RecordingExecutor implements WorkIntegrationExecutor {
  readonly requests: IntegrationExecutionRequest[] = [];
  active = 0;
  maxActive = 0;
  readonly results: IntegrationExecutionResult[];

  constructor(results: IntegrationExecutionResult[]) {
    this.results = results;
  }

  async reconcile(request: IntegrationExecutionRequest): Promise<IntegrationExecutionResult> {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    const result = this.results.shift();
    if (result === undefined) throw new Error("no executor result");
    return result;
  }
}

async function startAndCheckpoint(
  integration: IntegrationController,
  ledger: InMemoryEventLedger,
  input: { taskId: string; attemptId: string; worker: ActorRef; head: string; resource: string },
): Promise<string> {
  await integration.startAttempt({
    taskId: input.taskId,
    attemptId: input.attemptId,
    worker: input.worker,
    lease: lease(`lease:${input.attemptId}`, input.worker, input.resource),
  });
  // Execution evidence for this attempt. The Board will not call a Work done
  // without it: see authorshipUnproven in board.ts.
  await ledger.append(parseHarnessEvent({
    id: `event:observed:${input.attemptId}`,
    type: "attempt.activity-observed",
    schemaVersion: 1,
    streamId: integrationWorkStreamId(contract().id),
    workId: contract().id,
    taskId: input.taskId,
    attemptId: input.attemptId,
    actor: input.worker,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { state: "working", detail: `message: worker edited ${input.resource}`, source: input.worker.id, authority: "observation" },
  }));
  await ledger.append(parseHarnessEvent({
    id: `event:guarded:${input.attemptId}`,
    type: "guard.evaluated",
    schemaVersion: 1,
    streamId: integrationWorkStreamId(contract().id),
    workId: contract().id,
    taskId: input.taskId,
    attemptId: input.attemptId,
    actor: input.worker,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: {
      request: { requestId: `guard:${input.attemptId}`, workId: contract().id, taskId: input.taskId, attemptId: input.attemptId, actor: input.worker, writeScope: "workspace", contextHash: `ctx:${input.attemptId}`, evidenceRefs: [], timestampMs: 1787000000000, tool: { name: "worker:file-change", category: "write", args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } } },
      verdict: { requestId: `guard:${input.attemptId}`, decision: "allow", rationale: "fixture write authorized", riskLevel: "medium", ruleHits: ["per-category-mode:write:allow"], evaluatedAt: now(), durationMs: 1, policyBackend: "rhiz-native", policyBackendVersion: "0.1.0" },
    },
  }));
  await ledger.append(parseHarnessEvent({
    id: `event:finished:${input.attemptId}`,
    type: "attempt.finished",
    schemaVersion: 1,
    streamId: integrationWorkStreamId(contract().id),
    workId: contract().id,
    taskId: input.taskId,
    attemptId: input.attemptId,
    actor: input.worker,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { resultSummary: "candidate ready", artifactRefs: [] },
  }));
  const verificationEventId = await appendPassingVerification(ledger, input.attemptId);
  await integration.recordCheckpoint({
    taskId: input.taskId,
    attemptId: input.attemptId,
    checkpoint: {
      id: `checkpoint:${input.attemptId}`,
      class: "integration-candidate",
      parentIntegrationHead: initialHead,
      workspaceId: `workspace:${input.worker.id}`,
      changedResources: [{ kind: "path", resource: input.resource }],
      head: input.head,
      tree: input.head.replace(/./g, "d"),
      proofState: "passed",
      proofHead: input.head,
      verificationEventId,
      remoteRef: `refs/rhiz/checkpoints/work-integration-v77/${input.attemptId}`,
      remoteStatus: "pushed",
    },
  });
  return verificationEventId;
}

test("integration candidates queue automatically and one serialized lock advances the Work head", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await startAndCheckpoint(integration, ledger, {
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    head: candidateOne,
    resource: "src/one.ts",
  });
  assert.equal(acceptanceReadiness(integration.board).ready, false);
  assert.ok(acceptanceReadiness(integration.board).reasons.includes(
    "required passing verification bound to the exact Work integration head is missing",
  ));

  const finalProof = await appendPassingVerification(ledger, "integrated-one");
  const executor = new RecordingExecutor([{
    status: "integrated",
    head: candidateOne,
    tree: "d".repeat(40),
    proofHead: candidateOne,
    verificationEventId: finalProof,
    remoteRef: "refs/rhiz/work/work-integration-v77/candidate",
  }]);

  await Promise.all([integration.integrateNext(executor), integration.integrateNext(executor)]);
  assert.equal(executor.maxActive, 1);
  assert.equal(executor.requests.length, 1);
  assert.equal(integration.board.integration?.head, candidateOne);
  assert.equal(integration.board.integration?.lock, null);
  assert.deepEqual(integration.board.integration?.queue, []);
  assert.equal(integration.board.integration?.headProof?.verificationEventId, finalProof);
  assert.equal(acceptanceReadiness(integration.board).ready, true);
});

test("an integration candidate cannot enter shared truth before its remote checkpoint is observed", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await integration.startAttempt({
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    lease: lease("lease:one", workerOne, "src/one.ts"),
  });
  await ledger.append(parseHarnessEvent({
    id: "event:finished:remote-refusal",
    type: "attempt.finished",
    schemaVersion: 1,
    streamId: integrationWorkStreamId(contract().id),
    workId: contract().id,
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: workerOne,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: { resultSummary: "candidate ready", artifactRefs: [] },
  }));
  const verificationEventId = await appendPassingVerification(ledger, "remote-refusal");

  await assert.rejects(
    integration.recordCheckpoint({
      taskId: "task:one",
      attemptId: "attempt:one",
      checkpoint: {
        id: "checkpoint:local-only",
        class: "integration-candidate",
        parentIntegrationHead: initialHead,
        workspaceId: `workspace:${workerOne.id}`,
        changedResources: [{ kind: "path", resource: "src/one.ts" }],
        head: candidateOne,
        tree: "d".repeat(40),
        proofState: "passed",
        proofHead: candidateOne,
        verificationEventId,
        remoteRef: "refs/rhiz/rescue/work-integration-v77/local-only",
        remoteStatus: "local-only",
      },
    }),
    /durably pushed/,
  );
  assert.deepEqual(integration.board.integration?.queue, []);

  await ledger.append(parseHarnessEvent({
    id: "event:raw-local-only-checkpoint",
    type: "integration.checkpoint-recorded",
    schemaVersion: 1,
    streamId: integrationWorkStreamId(contract().id),
    workId: contract().id,
    taskId: "task:one",
    attemptId: "attempt:one",
    actor: service,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: {
      checkpoint: {
        id: "checkpoint:raw-local-only",
        class: "integration-candidate",
        parentIntegrationHead: initialHead,
        workspaceId: `workspace:${workerOne.id}`,
        changedResources: [{ kind: "path", resource: "src/one.ts" }],
        head: candidateOne,
        tree: "d".repeat(40),
        proofState: "passed",
        proofHead: candidateOne,
        verificationEventId,
        remoteRef: "refs/rhiz/rescue/work-integration-v77/raw-local-only",
        remoteStatus: "local-only",
      },
    },
  }));
  const rawBoard = projectBoard(await ledger.replay(integrationWorkStreamId(contract().id)));
  assert.equal(rawBoard.integration?.checkpoints["checkpoint:raw-local-only"], undefined);
  assert.equal(rawBoard.violations.at(-1)?.code, "integration-candidate-not-remote");
});

test("integration refuses to advance when final proof names a different head", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await startAndCheckpoint(integration, ledger, {
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    head: candidateOne,
    resource: "src/one.ts",
  });
  const finalProof = await appendPassingVerification(ledger, "wrong-head-proof");

  await assert.rejects(
    integration.integrateNext(new RecordingExecutor([{
      status: "integrated",
      head: candidateOne,
      tree: "d".repeat(40),
      proofHead: candidateTwo,
      verificationEventId: finalProof,
      remoteRef: "refs/rhiz/work/work-integration-v77/candidate",
    }])),
    /lacks passing proof bound to its exact head/,
  );
  assert.equal(integration.board.integration?.head, initialHead);
  assert.equal(integration.board.integration?.failures.at(-1)?.checkpointId, "checkpoint:attempt:one");
});

test("a controller reopened after process interruption resumes the durable lock from the Ledger", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await startAndCheckpoint(integration, ledger, {
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    head: candidateOne,
    resource: "src/one.ts",
  });
  await ledger.append(parseHarnessEvent({
    id: "event:interrupted-lock",
    type: "integration.lock-acquired",
    schemaVersion: 1,
    streamId: integrationWorkStreamId(contract().id),
    workId: contract().id,
    actor: service,
    occurredAt: now(),
    recordedAt: now(),
    evidence: [],
    payload: {
      lockId: "integration-lock:interrupted",
      checkpointId: "checkpoint:attempt:one",
      expectedHead: initialHead,
    },
  }));
  const finalProof = await appendPassingVerification(ledger, "resumed-head-proof");
  const reopened = await IntegrationController.open({
    ledger,
    actor: service,
    workId: contract().id,
    now,
    idFactory: () => "resumed-process",
  });

  await reopened.integrateNext(new RecordingExecutor([{
    status: "integrated",
    head: candidateOne,
    tree: "d".repeat(40),
    proofHead: candidateOne,
    verificationEventId: finalProof,
    remoteRef: "refs/rhiz/work/work-integration-v77/candidate",
  }]));

  assert.equal(reopened.board.integration?.head, candidateOne);
  assert.equal(reopened.board.integration?.lock, null);
  assert.equal(reopened.board.integration?.headProof?.verificationEventId, finalProof);
});

test("a transient executor failure releases the lock without losing the durable candidate", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await startAndCheckpoint(integration, ledger, {
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    head: candidateOne,
    resource: "src/one.ts",
  });

  await assert.rejects(
    integration.integrateNext({
      reconcile: async () => { throw new Error("remote temporarily unavailable"); },
    }),
    /remote temporarily unavailable/,
  );
  assert.equal(integration.board.integration?.lock, null);
  assert.deepEqual(integration.board.integration?.queue, ["checkpoint:attempt:one"]);

  const finalProof = await appendPassingVerification(ledger, "retry-after-transient-failure");
  await integration.integrateNext(new RecordingExecutor([{
    status: "integrated",
    head: candidateOne,
    tree: "d".repeat(40),
    proofHead: candidateOne,
    verificationEventId: finalProof,
    remoteRef: "refs/rhiz/work/work-integration-v77/candidate",
  }]));

  assert.equal(integration.board.integration?.head, candidateOne);
  assert.deepEqual(integration.board.integration?.queue, []);
});

test("head advancement makes older task proof stale and clean reconciliation resumes on the new base", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await integration.startAttempt({
    taskId: "task:two",
    attemptId: "attempt:two",
    worker: workerTwo,
    lease: lease("lease:two", workerTwo, "src/two.ts"),
  });
  await integration.recordCheckpoint({
    taskId: "task:two",
    attemptId: "attempt:two",
    checkpoint: {
      id: "checkpoint:rescue-two",
      class: "wip-rescue",
      parentIntegrationHead: initialHead,
      workspaceId: `workspace:${workerTwo.id}`,
      changedResources: [{ kind: "path", resource: "src/two.ts" }],
      head: candidateTwo,
      tree: "e".repeat(40),
      proofState: "passed",
      proofHead: candidateTwo,
      verificationEventId: "event:task-two-proof",
      remoteRef: "refs/rhiz/rescue/work-integration-v77/attempt-two",
      remoteStatus: "pushed",
    },
  });

  await startAndCheckpoint(integration, ledger, {
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    head: candidateOne,
    resource: "src/one.ts",
  });
  const finalProof = await appendPassingVerification(ledger, "integrated-one");
  await integration.integrateNext(new RecordingExecutor([{
    status: "integrated",
    head: candidateOne,
    tree: "d".repeat(40),
    proofHead: candidateOne,
    verificationEventId: finalProof,
    remoteRef: "refs/rhiz/work/work-integration-v77/candidate",
  }]));

  assert.equal(integration.board.integration?.taskStates["task:two"]?.proofStatus, "stale");
  assert.equal(integration.board.integration?.taskStates["task:two"]?.integrationEligibility, "stale");

  await integration.reconcileStaleAttempt("attempt:two", new RecordingExecutor([{
    status: "reconciled",
    head: "f".repeat(40),
    tree: "1".repeat(40),
    proofHead: "f".repeat(40),
    evidence: [{ id: "evidence:reconciled", kind: "test", digest: "sha256:reconciled" }],
    remoteRef: "refs/rhiz/rescue/work-integration-v77/attempt-two-reconciled",
  }]));

  assert.equal(integration.board.integration?.taskStates["task:two"]?.baseHead, candidateOne);
  assert.equal(integration.board.integration?.taskStates["task:two"]?.proofStatus, "passed");
  assert.equal(integration.board.integration?.taskStates["task:two"]?.integrationEligibility, "wip");
});

test("semantic reconciliation conflict preserves both states and never advances the Work head", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await integration.startAttempt({
    taskId: "task:two",
    attemptId: "attempt:two",
    worker: workerTwo,
    lease: lease("lease:two", workerTwo, "src/two.ts"),
  });
  await integration.recordCheckpoint({
    taskId: "task:two",
    attemptId: "attempt:two",
    checkpoint: {
      id: "checkpoint:rescue-two",
      class: "wip-rescue",
      parentIntegrationHead: initialHead,
      workspaceId: `workspace:${workerTwo.id}`,
      changedResources: [{ kind: "path", resource: "src/two.ts" }],
      head: candidateTwo,
      tree: "e".repeat(40),
      proofState: "not-run",
      remoteRef: "refs/rhiz/rescue/work-integration-v77/attempt-two",
      remoteStatus: "pushed",
    },
  });
  await startAndCheckpoint(integration, ledger, {
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    head: candidateOne,
    resource: "src/one.ts",
  });
  const finalProof = await appendPassingVerification(ledger, "integrated-conflict-base");
  await integration.integrateNext(new RecordingExecutor([{
    status: "integrated",
    head: candidateOne,
    tree: "d".repeat(40),
    proofHead: candidateOne,
    verificationEventId: finalProof,
    remoteRef: "refs/rhiz/work/work-integration-v77/candidate",
  }]));
  await integration.reconcileStaleAttempt("attempt:two", new RecordingExecutor([{
    status: "conflict",
    reason: "both tasks changed the same invariant",
    preservedRefs: [
      "refs/rhiz/conflicts/work-integration-v77/base",
      "refs/rhiz/conflicts/work-integration-v77/candidate",
    ],
  }]));

  assert.equal(integration.board.integration?.head, candidateOne);
  assert.equal(integration.board.integration?.taskStates["task:two"]?.integrationEligibility, "conflict");
  assert.equal(integration.board.integration?.taskStates["task:two"]?.preservedRefs.length, 2);
});

test("one Work refuses a second PR without a split decision and cleanup refuses unique local work", async () => {
  const ledger = new InMemoryEventLedger();
  await appendFoundation(ledger);
  const integration = await initialized(ledger);
  await integration.associatePullRequest({
    id: "pr:77",
    url: "https://github.com/werhiz/rhiz-harness/pull/107",
    headRef: "refs/rhiz/work/work-integration-v77/candidate",
    status: "draft",
  });
  await assert.rejects(
    () => integration.associatePullRequest({
      id: "pr:competing",
      url: "https://github.com/werhiz/rhiz-harness/pull/108",
      headRef: "refs/heads/worker-owned",
      status: "open",
    }),
    /already owns pull request/,
  );
  await assert.rejects(
    () => integration.updateMerge({
      authority: "pending",
      status: "merged",
      detail: "remote reported merged without Harness authority",
    }),
    /merged status requires authorized merge authority/,
  );
  await assert.rejects(
    () => integration.updateMerge({
      authority: "authorized",
      status: "merged",
      decisionId: "decision:invented",
      detail: "invented authority",
    }),
    /durable human-resolved decision/,
  );
  for (const event of [
    parseHarnessEvent({
      id: "event:merge-decision-requested",
      type: "decision.requested",
      schemaVersion: 1,
      streamId: integrationWorkStreamId(contract().id),
      workId: contract().id,
      actor: human,
      occurredAt: now(),
      recordedAt: now(),
      evidence: [],
      payload: { decisionId: "decision:merge", question: "Merge this exact Work head?", choices: ["yes", "no"] },
    }),
    parseHarnessEvent({
      id: "event:merge-decision-resolved",
      type: "decision.resolved",
      schemaVersion: 1,
      streamId: integrationWorkStreamId(contract().id),
      workId: contract().id,
      actor: human,
      occurredAt: now(),
      recordedAt: now(),
      evidence: [],
      payload: { decisionId: "decision:merge", resolution: "yes" },
    }),
  ]) await ledger.append(event);
  await integration.updateMerge({
    authority: "authorized",
    status: "merged",
    decisionId: "decision:merge",
    detail: "authorized exact-head merge",
  });
  assert.equal(integration.board.integration?.merge.status, "merged");

  await integration.startAttempt({
    taskId: "task:one",
    attemptId: "attempt:one",
    worker: workerOne,
    lease: lease("lease:one", workerOne, "src/one.ts"),
  });
  await assert.rejects(
    () => integration.authorizeCleanup({ attemptId: "attempt:one", disposition: "integrated" }),
    /unique work is neither integrated, remotely preserved, nor explicitly discarded/,
  );
});

test("worker Guard requests cannot push, merge, rebase, or open competing PRs", async () => {
  const policy = guardPolicyFromWorkContract(contract(), {
    perToolMode: { exec_command: { decision: "allow", requireEvidence: false } },
  });
  const oracle = new RhizNativePolicyOracle({ now: () => 0, clock: () => new Date(now()) });
  for (const command of [
    "git push origin main",
    "git merge feature",
    "git rebase origin/main",
    "git -C repo push origin main",
    "gh pr create --title competing",
  ]) {
    const verdict = await assertGuardCanEvaluate(
      oracle,
      parseGuardRequest({
        requestId: `request:${command}`,
        workId: contract().id,
        taskId: "task:one",
        attemptId: "attempt:worker",
        actor: workerOne,
        tool: { name: "exec_command", category: "shell", args: { cmd: command } },
        writeScope: "workspace",
        evidenceRefs: [],
        timestampMs: 0,
        contextHash: "sha256:context",
      }),
      policy,
      new GuardianRejectionCircuitBreaker(policy.circuitBreaker),
    );
    assert.equal(verdict.decision, "forbid", command);
    assert.ok(verdict.ruleHits.includes("integration-git-authority:harness-owned"), command);
  }
});
