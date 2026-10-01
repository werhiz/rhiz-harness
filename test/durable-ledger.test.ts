import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableEventLedger } from "../adapters/local/durable-ledger.js";
import {
  DuplicateEventError,
  LedgerClosedError,
  LedgerIntegrityError,
  LedgerLockedError,
} from "../src/ledger.js";
import { event, work, worker } from "./helpers.js";

async function temporaryLedger(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rhiz-ledger-v1-"));
}

async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

test("durable Ledger persists hash-chained global and stream order across reopen", async () => {
  const directory = await temporaryLedger();
  try {
    const created = event("work.created", { contract: work(), revision: 1 });
    const task = event("task.created", { objective: "Implement" }, { taskId: "task:durable" });
    const ledger = await DurableEventLedger.open({ directory, ledgerId: "ledger:test" });
    const first = await ledger.appendWithReceipt(created);
    const second = await ledger.appendWithReceipt(task);
    assert.equal(first.globalSequence, 1);
    assert.equal(first.streamSequence, 1);
    assert.equal(first.previousDigest, null);
    assert.equal(second.globalSequence, 2);
    assert.equal(second.streamSequence, 2);
    assert.equal(second.previousDigest, first.digest);
    await ledger.close();

    const reopened = await DurableEventLedger.open({ directory, ledgerId: "ledger:test" });
    assert.deepEqual(await reopened.replay(created.streamId), [created, task]);
    const report = await reopened.integrity();
    assert.equal(report.recordCount, 2);
    assert.equal(report.streamCount, 1);
    assert.equal(report.headDigest, second.digest);
    await assert.rejects(() => reopened.append(created), DuplicateEventError);
    await reopened.close();
  } finally {
    await cleanup(directory);
  }
});

test("durable Ledger enforces one live writer and releases ownership on close", async () => {
  const directory = await temporaryLedger();
  try {
    const first = await DurableEventLedger.open({ directory });
    await assert.rejects(() => DurableEventLedger.open({ directory }), LedgerLockedError);
    await first.close();
    const second = await DurableEventLedger.open({ directory });
    await second.close();
  } finally {
    await cleanup(directory);
  }
});

test("close drains append calls that were already accepted", async () => {
  const directory = await temporaryLedger();
  try {
    const created = event("work.created", { contract: work(), revision: 1 });
    const ledger = await DurableEventLedger.open({ directory });
    const pendingAppend = ledger.append(created);
    const pendingClose = ledger.close();
    await pendingAppend;
    await pendingClose;

    const reopened = await DurableEventLedger.open({ directory });
    assert.deepEqual(await reopened.replay(created.streamId), [created]);
    await reopened.close();
  } finally {
    await cleanup(directory);
  }
});

test("tampering with a complete historical record fails closed", async () => {
  const directory = await temporaryLedger();
  try {
    const ledger = await DurableEventLedger.open({ directory });
    await ledger.append(event("work.created", { contract: work(), revision: 1 }));
    await ledger.close();

    const path = join(directory, "events.jsonl");
    const record = JSON.parse((await readFile(path, "utf8")).trim()) as Record<string, any>;
    record.event.payload.contract.objective = "tampered objective";
    await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
    await assert.rejects(() => DurableEventLedger.open({ directory }), LedgerIntegrityError);
  } finally {
    await cleanup(directory);
  }
});

test("an incomplete final append is repaired without discarding complete records", async () => {
  const directory = await temporaryLedger();
  try {
    const created = event("work.created", { contract: work(), revision: 1 });
    const ledger = await DurableEventLedger.open({ directory });
    await ledger.append(created);
    await ledger.close();
    await appendFile(join(directory, "events.jsonl"), "{\"partial\":", "utf8");

    const reopened = await DurableEventLedger.open({ directory });
    const report = await reopened.integrity();
    assert.ok(report.repairedTailBytes > 0);
    assert.deepEqual(await reopened.replay(created.streamId), [created]);
    await reopened.close();

    await appendFile(join(directory, "events.jsonl"), "broken-tail", "utf8");
    await assert.rejects(
      () => DurableEventLedger.open({ directory, repairTornTail: false }),
      /incomplete tail/,
    );
  } finally {
    await cleanup(directory);
  }
});

test("snapshots accelerate replay without replacing durable history", async () => {
  const directory = await temporaryLedger();
  try {
    const created = event("work.created", { contract: work(), revision: 1 });
    const task = event("task.created", { objective: "Implement" }, { taskId: "task:snapshot" });
    const assigned = event("task.assigned", { worker }, { taskId: "task:snapshot" });
    const ledger = await DurableEventLedger.open({ directory });
    await ledger.append(created);
    await ledger.append(task);
    const snapshot = await ledger.saveSnapshot(created.streamId, { boardState: "ready" });
    await ledger.append(assigned);

    const loaded = await ledger.loadSnapshot(created.streamId);
    assert.equal(loaded?.digest, snapshot.digest);
    assert.deepEqual(loaded?.state, { boardState: "ready" });
    assert.deepEqual(await ledger.replayAfterSnapshot(snapshot), [assigned]);
    assert.equal((await ledger.replay(created.streamId)).length, 3);
    await ledger.close();
  } finally {
    await cleanup(directory);
  }
});

test("portable archive retains the full log and an independently readable audit receipt", async () => {
  const directory = await temporaryLedger();
  const archive = await temporaryLedger();
  try {
    const created = event("work.created", { contract: work(), revision: 1 });
    const ledger = await DurableEventLedger.open({ directory, ledgerId: "ledger:archive-source" });
    await ledger.append(created);
    const receipt = await ledger.exportArchive(archive);
    assert.equal(receipt.ledger.recordCount, 1);
    assert.equal(receipt.ledger.ledgerId, "ledger:archive-source");
    const storedReceipt = JSON.parse(await readFile(receipt.receiptFile, "utf8"));
    assert.equal(storedReceipt.headDigest, receipt.ledger.headDigest);
    await ledger.close();

    const archived = await DurableEventLedger.open({ directory: archive, ledgerId: "ledger:archive-copy" });
    assert.deepEqual(await archived.replay(created.streamId), [created]);
    await archived.close();
  } finally {
    await cleanup(directory);
    await cleanup(archive);
  }
});

test("a closed durable Ledger refuses new writes", async () => {
  const directory = await temporaryLedger();
  try {
    const ledger = await DurableEventLedger.open({ directory });
    await ledger.close();
    await assert.rejects(
      () => ledger.append(event("work.created", { contract: work(), revision: 1 })),
      LedgerClosedError,
    );
  } finally {
    await cleanup(directory);
  }
});
