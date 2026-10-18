import assert from "node:assert/strict";
import test from "node:test";

import { acceptanceReadiness, authorshipUnproven, projectBoard } from "../src/board.js";
import { summarizeOperatorWork } from "../src/operator.js";
import type { HarnessEvent } from "../src/schemas.js";
import { event, guardedWrite, passingVerificationSequence, successfulExecution, work, worker } from "./helpers.js";

// ---------------------------------------------------------------------------
// A worker that ran and changed nothing produced no candidate.
//
// The defect: three of twelve real repository Works (among them
// work:recognition-temporal-basis-3019-r6 and -r7) stopped in `verifying` with
// "authorship is unproven: attempt attempt:crew:... produced no Guard-mediated
// write". The worker had run, held its workspace, streamed observations and
// then told us, in its own words, that it could not do the Work: its Context
// pack lacked the files it was asked to change. It made no write. Nothing was
// ever going to be verified.
//
// "Authorship is unproven" answers a question nobody asked. There was no
// candidate whose author was in doubt. The operator retried the same Work as
// new Works (r1 through r9) against the same missing Context, because the one
// reason the harness gave named the wrong fault.
//
// The fixture is the exact event shape the Codex App Server path emitted for
// -r7: a lease with a workspace, the adapter's authority report, three streamed
// observations, and attempt.finished with no artifacts and no Guard record.
// ---------------------------------------------------------------------------

const workerWords = "I can't complete this safely from the material actually attached here. No files were edited.";

function workerChangedNothing(contract = work()): HarnessEvent[] {
  return [
    event("work.created", { contract, revision: 1 }),
    event("task.created", { objective: "Fix the projector" }, { taskId: "task:1" }),
    event("task.assigned", { worker }, { taskId: "task:1" }),
    event("attempt.started", {
      worker,
      contractRevision: 1,
      lease: {
        id: "lease:1",
        workspaceId: "workspace:1",
        resourceClaims: [{ kind: "path", resource: "src" }],
        acquiredAt: "2026-08-20T04:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    event("authority.granted", {
      policy: contract.authority,
      reason: "native sandbox is read-only with network disabled; file mutation requires client approval [boundary: codex-app-server:read-only-baseline]",
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    event("attempt.activity-observed", {
      state: "working",
      detail: "activity: Codex thread started in exact WorkspaceBinding",
      source: worker.id,
      authority: "observation",
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    event("attempt.activity-observed", {
      state: "working",
      detail: "message: Codex returned a final agent message",
      source: worker.id,
      authority: "observation",
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
    event("attempt.finished", { resultSummary: workerWords, artifactRefs: [] }, { taskId: "task:1", attemptId: "attempt:1", actor: worker }),
  ] as HarnessEvent[];
}

test("a worker that ran and wrote nothing is reported as producing no candidate, not as unproven authorship", () => {
  const board = projectBoard(workerChangedNothing());
  assert.equal(board.violations.length, 0, "the fixture is a structurally valid Ledger");
  const readiness = acceptanceReadiness(board);
  assert.equal(readiness.ready, false, "a Work with no candidate is never acceptable");
  for (const reason of readiness.reasons) {
    assert.doesNotMatch(reason, /authorship is unproven/, `readiness still blames authorship: ${reason}`);
  }
  assert.match(readiness.reasons[0] ?? "", /attempt:1 finished without a Guard-allowed write, so it produced no candidate/);
});

test("operator status names the worker's own account as the reason to act, not authorship", () => {
  const status = summarizeOperatorWork(workerChangedNothing());
  assert.equal(status.nextAction, "resume");
  assert.doesNotMatch(status.nextActionReason, /authorship/);
  assert.match(status.nextActionReason, /produced no candidate/);
  assert.match(status.nextActionReason, /No files were edited/, "the worker's own words travel to the operator");
});

test("an attempt Crew recorded as failed for producing nothing reports that failure, not authorship", () => {
  // The write side now records a no-change attempt as failed. The operator
  // must carry that failure's reason, not the generic "no finished Attempt".
  const failed = workerChangedNothing().map((item) => item.type === "attempt.finished"
    ? event("attempt.failed", {
      reason: `worker finished without changing its workspace, so the attempt produced no candidate: ${workerWords}`,
      recoverable: false,
    }, { taskId: "task:1", attemptId: "attempt:1", actor: worker })
    : item);
  const board = projectBoard(failed);
  assert.equal(board.state, "failed");
  for (const reason of acceptanceReadiness(board).reasons) assert.doesNotMatch(reason, /authorship is unproven/);
  const status = summarizeOperatorWork(failed);
  assert.equal(status.nextAction, "resume");
  assert.match(status.nextActionReason, /attempt:1 failed: worker finished without changing its workspace/);
});

// The authorship refusal itself must not weaken. Each of these is a Work where
// something claims a candidate exists, so who wrote it is exactly the question.

test("once a candidate is verified, a worker that made no Guard-allowed write still has unproven authorship", () => {
  const board = projectBoard([...workerChangedNothing(), ...passingVerificationSequence()]);
  assert.equal(board.state, "unverifiable");
  assert.match(authorshipUnproven(board) ?? "", /produced no Guard-mediated write/);
  assert.ok(acceptanceReadiness(board).reasons.some((reason) => /authorship is unproven/.test(reason)));
});

test("an attempt that streamed nothing is still an authorship question, not an empty attempt", () => {
  const silent = workerChangedNothing().filter((item) => item.type !== "attempt.activity-observed");
  const reasons = acceptanceReadiness(projectBoard(silent)).reasons;
  assert.ok(reasons.some((reason) => /authorship is unproven: attempt attempt:1 streamed no execution observation/.test(reason)));
});

test("a worker that did write through Guard is unaffected", () => {
  const board = projectBoard([...successfulExecution(), ...passingVerificationSequence()]);
  assert.equal(board.state, "ready");
  assert.deepEqual(acceptanceReadiness(board).reasons, []);
  const written = [...workerChangedNothing().slice(0, -1), guardedWrite(), workerChangedNothing().at(-1)!];
  for (const reason of acceptanceReadiness(projectBoard(written)).reasons) {
    assert.doesNotMatch(reason, /produced no candidate/);
  }
});
