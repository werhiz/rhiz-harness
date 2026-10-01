import assert from "node:assert/strict";
import test from "node:test";
import { DuplicateEventError, InMemoryEventLedger } from "../src/ledger.js";
import { event, work } from "./helpers.js";

test("Ledger appends and replays validated immutable event copies", async () => {
  const ledger = new InMemoryEventLedger();
  const created = event("work.created", { contract: work(), revision: 1 });
  await ledger.append(created);

  const replayed = await ledger.replay(created.streamId);
  assert.equal(replayed.length, 1);
  assert.deepEqual(replayed[0], created);
  assert.notEqual(replayed[0], created);
});

test("Ledger rejects duplicate event identity", async () => {
  const ledger = new InMemoryEventLedger();
  const created = event("work.created", { contract: work(), revision: 1 });
  await ledger.append(created);
  await assert.rejects(() => ledger.append(created), DuplicateEventError);
  assert.equal((await ledger.replay(created.streamId)).length, 1);
});

test("Ledger read cursor is append-order based", async () => {
  const ledger = new InMemoryEventLedger();
  const created = event("work.created", { contract: work(), revision: 1 });
  const task = event("task.created", { objective: "Implement" }, { taskId: "task:1" });
  await ledger.append(created);
  await ledger.append(task);

  const events = [];
  for await (const item of ledger.read(created.streamId, { offset: 1 })) events.push(item);
  assert.deepEqual(events, [task]);
});

test("Ledger rejects invalid cursors", async () => {
  const ledger = new InMemoryEventLedger();
  const iterator = ledger.read("stream:work:1", { offset: -1 })[Symbol.asyncIterator]();
  await assert.rejects(() => iterator.next(), RangeError);
});
