import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryEventLedger } from "../src/ledger.js";
import {
  acceptOperatorWork,
  closeOrphanedAttempts,
  OperatorError,
  recordOperatorReview,
  summarizeOperatorWork,
  summarizeOperatorWorks,
} from "../src/operator.js";
import { RefinerBridge } from "../src/refiner-bridge.js";
import { RouterBridge, defaultRouterWorkerDescriptor } from "../src/router-bridge.js";
import { InMemoryRouterWorkerRegistry } from "../src/router.js";
import type { HarnessEvent } from "../src/schemas.js";
import { event, guardedWrite, human, passingVerificationSequence, reviewer, successfulExecution, work, worker } from "./helpers.js";

const STREAM = "stream:work:1";

async function ledgerWith(events: readonly HarnessEvent[]) {
  const ledger = new InMemoryEventLedger();
  for (const item of events) await ledger.append(item);
  return ledger;
}

function verifiedWork(contract = work()) {
  return [...successfulExecution(contract), ...passingVerificationSequence()];
}

let ids = 0;
const idFactory = () => `op-${++ids}`;
const now = () => "2026-08-20T05:00:00.000Z";

test("status names accept as the next action once the Work is independently verified", () => {
  const status = summarizeOperatorWork(verifiedWork());
  assert.equal(status.state, "ready");
  assert.equal(status.nextAction, "accept");
  assert.equal(status.verification.latest, "pass");
  assert.equal(status.attempts.total, 1);
  assert.equal(status.metrics.outcome, "open");
  assert.equal(status.metrics.repairAttempts, 0);
});

test("status asks for review, not acceptance, when the contract requires an independent review", () => {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] } });
  const status = summarizeOperatorWork(verifiedWork(contract));
  assert.equal(status.nextAction, "review");
  assert.equal(status.review.required, true);
});

test("status names resume for an attempt whose process left no terminal event", () => {
  const status = summarizeOperatorWork(successfulExecution().filter((item) => item.type !== "attempt.finished"));
  assert.equal(status.attempts.active, 1);
  assert.equal(status.nextAction, "resume");
});

test("accept refuses a non-human actor and writes nothing", async () => {
  const ledger = await ledgerWith(verifiedWork());
  const before = (await ledger.replay(STREAM)).length;
  await assert.rejects(
    acceptOperatorWork({ ledger, streamId: STREAM, actor: worker, reason: "done", now, idFactory }),
    /lacks human acceptance authority/,
  );
  assert.equal((await ledger.replay(STREAM)).length, before);
});

test("accept refuses Work the Board does not call ready and writes nothing", async () => {
  const ledger = await ledgerWith(successfulExecution());
  await assert.rejects(
    acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "looks fine", now, idFactory }),
    (error: unknown) => error instanceof OperatorError && /not ready for acceptance/.test(error.message),
  );
  assert.equal((await ledger.replay(STREAM)).some((item) => item.type === "work.accepted"), false);
});

test("accept refuses when the verified target cannot be confirmed, before any write", async () => {
  const ledger = await ledgerWith(verifiedWork());
  await assert.rejects(
    acceptOperatorWork({
      ledger, streamId: STREAM, actor: human, reason: "ok", now, idFactory,
      confirmTarget: async () => { throw new Error("verified head is gone"); },
    }),
    /verified head is gone/,
  );
  assert.equal((await ledger.replay(STREAM)).some((item) => item.type === "work.accepted"), false);
});

test("accept records the Board decision and hands the closed Work to Router evidence and the Refiner", async () => {
  const ledger = await ledgerWith(verifiedWork());
  const refiner = new RefinerBridge({ ledger, idFactory, now });
  const result = await acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "Independently verified", now, idFactory, refiner });
  assert.equal(result.status.state, "accepted");
  assert.equal(result.status.metrics.outcome, "accepted");
  assert.equal(result.status.metrics.humanInterventions, 0);
  assert.equal(result.learning.analysis?.outcome, "accepted");
  assert.deepEqual(result.learning.analysis?.classifications, ["high-quality-first-attempt", "zero-human-intervention"]);
  const credited = result.learning.routerEvidence.find((item) => item.workerId === worker.id);
  assert.equal(credited?.successCount, 1, "the executor is credited only after acceptance");
  const stored = await ledger.replay(STREAM);
  assert.equal(stored.filter((item) => item.type === "work.accepted").length, 1);
});

test("accepting a recovered Work produces a reviewable recovery proposal, never a promotion", async () => {
  const failedFirst = [
    event("task.created", { objective: "First try" }, { taskId: "task:0" }),
    event("attempt.started", { worker, contractRevision: 1 }, { taskId: "task:0", attemptId: "attempt:0", actor: worker }),
    event("attempt.failed", { reason: "tests failed", recoverable: true }, { taskId: "task:0", attemptId: "attempt:0", actor: worker }),
  ];
  const execution = successfulExecution();
  const ledger = await ledgerWith([execution[0]!, ...failedFirst, ...execution.slice(1), ...passingVerificationSequence()]);
  const refiner = new RefinerBridge({ ledger, idFactory, now });
  const result = await acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "Recovered and verified", now, idFactory, refiner });
  assert.equal(result.status.metrics.recovered, true);
  assert.equal(result.status.metrics.repairAttempts, 1);
  assert.deepEqual(result.learning.proposals.map((proposal) => proposal.kind), ["recovery-behavior"]);
  const stored = await ledger.replay(STREAM);
  assert.equal(stored.filter((item) => item.type === "refiner.proposed").length, 1);
  assert.equal(stored.some((item) => item.type === "refiner.promoted" || item.type === "refiner.accepted"), false);
});

test("review refuses a reviewer who executed the Work", async () => {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] } });
  const ledger = await ledgerWith(verifiedWork(contract));
  await assert.rejects(
    recordOperatorReview({ ledger, streamId: STREAM, reviewer: worker, status: "pass", summary: "fine", now, idFactory }),
    /cannot review it independently/,
  );
});

test("an independent passing review makes review-required Work ready to accept", async () => {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] } });
  const ledger = await ledgerWith(verifiedWork(contract));
  const status = await recordOperatorReview({
    ledger, streamId: STREAM, reviewer, status: "pass", summary: "Diff matches the objective",
    findings: [{ severity: "info", summary: "naming is consistent" }], now, idFactory,
  });
  assert.equal(status.review.latest, "pass");
  assert.equal(status.nextAction, "accept");
});

test("resume closes an orphaned attempt as recoverable, once", async () => {
  const ledger = await ledgerWith(successfulExecution().filter((item) => item.type !== "attempt.finished"));
  const closed = await closeOrphanedAttempts({ ledger, streamId: STREAM, now, idFactory });
  assert.deepEqual(closed, ["attempt:1"]);
  const status = summarizeOperatorWork(await ledger.replay(STREAM));
  assert.equal(status.attempts.active, 0);
  assert.equal(status.attempts.failed, 1);
  assert.equal(status.violations, 0);
  assert.deepEqual(await closeOrphanedAttempts({ ledger, streamId: STREAM, now, idFactory }), []);
});

test("the digest reports interventions per accepted outcome", async () => {
  const ledger = await ledgerWith(verifiedWork());
  await acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "ok", now, idFactory });
  const accepted = summarizeOperatorWork(await ledger.replay(STREAM));
  const open = summarizeOperatorWork(successfulExecution());
  const digest = summarizeOperatorWorks([accepted, open]);
  assert.equal(digest.accepted, 1);
  assert.equal(digest.open, 1);
  assert.equal(digest.interventionsPerAcceptedOutcome, 0);
});

test("RouterBridge credits accepted outcomes from prior Work when given an evidence source", async () => {
  const prior = [...verifiedWork(), event("work.accepted", { reason: "Independently verified", contractRevision: 1 })];
  const registry = new InMemoryRouterWorkerRegistry();
  registry.register(defaultRouterWorkerDescriptor(worker.id, { adapter: "test", supportedWorkTypes: ["SHIP"], writeAccess: "workspace" }));
  const ledger = new InMemoryEventLedger();
  const next = work({ id: "work:2" });
  const route = (bridge: RouterBridge) => bridge.route({ work: next, taskId: "task:2", attemptId: "attempt:2", streamId: "stream:work:2", actor: human });

  const blind = await route(new RouterBridge({ registry, ledger, idFactory, now: () => new Date(now()) }));
  assert.equal(blind.considered.find((item) => item.workerId === worker.id)?.evidence, null);

  const informed = await route(new RouterBridge({ registry, ledger, idFactory, now: () => new Date(now()), evidenceEvents: async () => prior }));
  const evidence = informed.considered.find((item) => item.workerId === worker.id)?.evidence;
  assert.equal(evidence?.successCount, 1);
});

test("a failing independent review after a passing one blocks acceptance and writes nothing", async () => {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] } });
  const ledger = await ledgerWith(verifiedWork(contract));
  const second = { id: "agent:reviewer-two", kind: "verifier" as const, displayName: "Second reviewer" };
  await recordOperatorReview({ ledger, streamId: STREAM, reviewer, status: "pass", summary: "fine", now, idFactory });
  const status = await recordOperatorReview({
    ledger, streamId: STREAM, reviewer: second, status: "fail", summary: "breaks the contract",
    findings: [{ severity: "critical", summary: "src/feature.ts drops the error path" }], now, idFactory,
  });
  assert.equal(status.review.latest, "fail");
  assert.equal(status.readiness.ready, false);
  assert.equal(status.nextAction, "review");
  await assert.rejects(
    acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "ok", now, idFactory }),
    /latest independent review of the current contract revision failed/,
  );
  assert.equal((await ledger.replay(STREAM)).some((item) => item.type === "work.accepted"), false);

  const third = await recordOperatorReview({ ledger, streamId: STREAM, reviewer, status: "pass", summary: "fixed on re-read", now, idFactory });
  assert.equal(third.nextAction, "accept", "a newer passing independent review speaks for the revision again");
});

test("a failing review blocks acceptance even when the contract does not require review", async () => {
  const ledger = await ledgerWith(verifiedWork());
  const status = await recordOperatorReview({ ledger, streamId: STREAM, reviewer, status: "fail", summary: "wrong file", now, idFactory });
  // State and acceptance readiness must agree: a refused Work never reads ready.
  assert.equal(status.state, "reviewing");
  assert.equal(status.readiness.ready, false);
  assert.equal(status.nextAction, "review");
  await assert.rejects(
    acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "ok", now, idFactory }),
    /review of the current contract revision failed/,
  );
});

test("an interrupted review by the same reviewer is closed as failed before a new one; another reviewer's is refused", async () => {
  const contract = work({ verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] } });
  const ledger = await ledgerWith([
    ...verifiedWork(contract),
    event("review.started", { reviewId: "review:dangling", contractRevision: 1 }, { actor: reviewer }),
  ]);
  const other = { id: "agent:reviewer-two", kind: "verifier" as const };
  await assert.rejects(
    recordOperatorReview({ ledger, streamId: STREAM, reviewer: other, status: "pass", summary: "fine", now, idFactory }),
    /review:dangling by agent:reviewer is still open/,
  );
  const status = await recordOperatorReview({ ledger, streamId: STREAM, reviewer, status: "pass", summary: "complete review", now, idFactory });
  assert.equal(status.violations, 0);
  assert.equal(status.review.count, 2);
  assert.equal(status.nextAction, "accept");
  const results = (await ledger.replay(STREAM)).filter((item) => item.type === "review.result");
  assert.equal(results[0]?.type === "review.result" && results[0].payload.status, "fail");
});

test("status names the Board's verified head, never a side file", () => {
  const status = summarizeOperatorWork(verifiedWork());
  assert.equal(status.verifiedTarget, null, "no integration proof, no target");
});

test("a second attempt that succeeds counts as recovered in status, as the Refiner counts it", async () => {
  const execution = successfulExecution();
  const extra = [
    event("task.created", { objective: "First try" }, { taskId: "task:0" }),
    event("attempt.started", {
      worker,
      contractRevision: 1,
      lease: {
        id: "lease:0",
        workspaceId: "workspace:0",
        resourceClaims: [{ kind: "path", resource: "src" }],
        acquiredAt: "2026-08-20T04:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }, { taskId: "task:0", attemptId: "attempt:0", actor: worker }),
    event("attempt.activity-observed", {
      state: "working", detail: "message: worker edited src/feature.ts", source: "agent:worker", authority: "observation",
    }, { taskId: "task:0", attemptId: "attempt:0", actor: worker }),
    guardedWrite("attempt:0", "task:0"),
    event("attempt.finished", { resultSummary: "first candidate", artifactRefs: [] }, { taskId: "task:0", attemptId: "attempt:0", actor: worker }),
  ];
  const ledger = await ledgerWith([execution[0]!, ...extra, ...execution.slice(1), ...passingVerificationSequence()]);
  const refiner = new RefinerBridge({ ledger, idFactory, now });
  const result = await acceptOperatorWork({ ledger, streamId: STREAM, actor: human, reason: "ok", now, idFactory, refiner });
  assert.equal(result.status.metrics.recovered, true);
  assert.equal(result.learning.analysis?.classifications.includes("successful-recovery"), true);
  assert.equal(result.status.metrics.humanDecisions, 2, "stating the Work and accepting it");
});
