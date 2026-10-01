import assert from "node:assert/strict";
import test from "node:test";
import { projectBoard } from "../src/board.js";
import type { HarnessEvent } from "../src/schemas.js";
import { parseHarnessEvent } from "../src/schemas.js";
import { event, passingVerificationSequence, successfulExecution, worker } from "./helpers.js";

test("replaying the same event stream 1,000 times produces identical Board state", () => {
  const events = [...successfulExecution(), ...passingVerificationSequence(), event("work.accepted", { reason: "Accepted", contractRevision: 1 })];
  const expected = projectBoard(events);
  for (let index = 0; index < 1_000; index += 1) {
    assert.deepEqual(projectBoard(events), expected);
  }
});

test("source timestamps never reorder Ledger history", () => {
  const events = successfulExecution().map((item, index) => parseHarnessEvent({
    ...item,
    occurredAt: `2020-01-01T00:00:${String(59 - index).padStart(2, "0")}.000Z`,
    recordedAt: `2030-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  })) as HarnessEvent[];
  const board = projectBoard(events);
  assert.equal(board.state, "verifying");
  assert.equal(board.attempts["attempt:1"]?.state, "finished");
});

test("hundreds of late runtime observations cannot overturn accepted Board truth", () => {
  const accepted = [
    ...successfulExecution(),
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "Accepted", contractRevision: 1 }),
  ];
  const observations: HarnessEvent[] = [];
  for (let index = 0; index < 250; index += 1) {
    observations.push(event(
      "attempt.activity-observed",
      { state: index % 2 === 0 ? "working" : "unknown", detail: `late-${index}`, source: "stress-runtime", authority: "observation" },
      {
        taskId: "task:1",
        attemptId: "attempt:1",
        actor: worker,
        occurredAt: "2026-08-20T05:30:00.000Z",
        recordedAt: "2026-08-20T05:30:01.000Z",
      },
    ));
  }
  const board = projectBoard([...accepted, ...observations]);
  assert.equal(board.state, "accepted");
  assert.equal(board.violations.length, 0);
});

test("unknown late runtime observations remain evidence errors even after acceptance", () => {
  const accepted = [
    ...successfulExecution(),
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "Accepted", contractRevision: 1 }),
  ];
  const unknown = event(
    "attempt.activity-observed",
    { state: "working", source: "runtime", authority: "observation" },
    { taskId: "task:1", attemptId: "attempt:ghost", actor: worker },
  );
  const board = projectBoard([...accepted, unknown]);
  assert.equal(board.state, "accepted");
  assert.equal(board.violations.at(-1)?.code, "unknown-attempt");
});
