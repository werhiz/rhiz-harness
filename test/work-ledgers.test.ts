import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DurableEventLedger, readDurableLedgerEvents } from "../adapters/local/durable-ledger.js";
import { readRepositoryWorkEvents, readRepositoryWorkLedgers, workLedgersRoot } from "../adapters/local/work-ledgers.js";
import { passingVerificationSequence, successfulExecution } from "./helpers.js";

async function writeLedger(directory: string) {
  const ledger = await DurableEventLedger.open({ directory, ledgerId: "ledger:test" });
  try {
    for (const event of [...successfulExecution(), ...passingVerificationSequence()]) await ledger.append(event);
  } finally {
    await ledger.close();
  }
}

test("readDurableLedgerEvents reads a Ledger another writer holds open, without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-work-ledgers-"));
  try {
    const directory = join(root, "ledger");
    await writeLedger(directory);
    const writer = await DurableEventLedger.open({ directory, ledgerId: "ledger:test" });
    try {
      const events = await readDurableLedgerEvents(directory);
      assert.equal(events.length, successfulExecution().length + 2);
    } finally {
      await writer.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readDurableLedgerEvents ignores a torn tail and leaves the file untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-work-ledgers-"));
  try {
    const directory = join(root, "ledger");
    await writeLedger(directory);
    const file = join(directory, "events.jsonl");
    appendFileSync(file, '{"schema":"rhiz/ledger-record/v1","glob');
    const before = readFileSync(file);
    const events = await readDurableLedgerEvents(directory);
    assert.equal(events.length, successfulExecution().length + 2);
    assert.deepEqual(readFileSync(file), before, "a reader never repairs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Ledger with a broken chain is reported unreadable, never read as empty history", async () => {
  const commonDir = mkdtempSync(join(tmpdir(), "rhiz-work-ledgers-"));
  try {
    const good = join(workLedgersRoot(commonDir), "work-good");
    const bad = join(workLedgersRoot(commonDir), "work-bad");
    await writeLedger(good);
    await writeLedger(bad);
    const file = join(bad, "events.jsonl");
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    writeFileSync(file, `${[lines[0], ...lines.slice(2)].join("\n")}\n`);
    mkdirSync(join(workLedgersRoot(commonDir), "not-a-ledger"));

    const { ledgers, unreadable } = await readRepositoryWorkLedgers(commonDir);
    assert.deepEqual(ledgers.map((ledger) => ledger.directory), [good]);
    assert.deepEqual(ledgers[0]?.workIds, ["work:1"]);
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0]?.directory, bad);

    const excluded = await readRepositoryWorkEvents(commonDir, { excludeDirectories: [good] });
    assert.equal(excluded.events.length, 0);
    assert.equal(excluded.unreadable.length, 1);
  } finally {
    rmSync(commonDir, { recursive: true, force: true });
  }
});

test("a repository with no Work Ledgers has no history and nothing unreadable", async () => {
  const commonDir = mkdtempSync(join(tmpdir(), "rhiz-work-ledgers-"));
  try {
    assert.deepEqual(await readRepositoryWorkLedgers(commonDir), { ledgers: [], unreadable: [] });
  } finally {
    rmSync(commonDir, { recursive: true, force: true });
  }
});

test("a Ledger directory that cannot be inspected is unreadable, not absent", { skip: process.getuid?.() === 0 ? "root bypasses permissions" : false }, async () => {
  const commonDir = mkdtempSync(join(tmpdir(), "rhiz-work-ledgers-"));
  const locked = join(workLedgersRoot(commonDir), "work-locked");
  try {
    await writeLedger(locked);
    chmodSync(locked, 0o000);
    const { ledgers, unreadable } = await readRepositoryWorkLedgers(commonDir);
    assert.equal(ledgers.length, 0);
    assert.deepEqual(unreadable.map((item) => item.directory), [locked]);
  } finally {
    chmodSync(locked, 0o700);
    rmSync(commonDir, { recursive: true, force: true });
  }
});
