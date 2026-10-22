import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs, { appendFile, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { DurableEventLedger, readDurableLedgerEvents } from "../adapters/local/durable-ledger.js";
import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import { requireProven, runDisposableProof, TempDirectoryDerivativeFactory } from "../src/disposable.js";
import { nativeReviewCandidate } from "./fixtures/native-review.js";
import { event, work } from "./helpers.js";

type Fault = "open" | "sync" | "close" | "sync-and-close";

// All failure injection is scoped to a disposable derivative, never candidate
// source or operator data. Actual FileHandles and all non-target IO stay real.
async function withDirectoryFault<T>(path: string, fault: Fault, action: () => Promise<T>, code = "EIO", ordinal = 1): Promise<T> {
  const original = fs.open;
  let injected = false;
  let barriers = 0;
  const error = Object.assign(new Error(`injected directory ${fault}`), { code });
  const closeError = Object.assign(new Error("injected directory close"), { code: "EIO" });
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (args[0] !== path || args[1] !== constants.O_RDONLY || injected || ++barriers !== ordinal) return original(...args);
    injected = true;
    if (fault === "open") throw error;
    const handle = await original(...args);
    const close = handle.close.bind(handle);
    if (fault === "sync" || fault === "sync-and-close") handle.sync = async () => { throw error; };
    if (fault === "close" || fault === "sync-and-close") handle.close = async () => { await close(); throw closeError; };
    return handle;
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try {
    const result = await action();
    assert(injected, "the actual directory barrier was exercised");
    return result;
  } finally {
    fs.open = original;
    syncBuiltinESMExports();
  }
}

async function disposable(proof: (root: string) => Promise<void>): Promise<void> {
  const candidate = await nativeReviewCandidate({ "marker.txt": "Ledger IO fault fixture\n" });
  try {
    requireProven(await runDisposableProof({
      candidateRoot: candidate,
      probe: new GitCandidateIdentityProbe(),
      factory: new TempDirectoryDerivativeFactory(),
      proof: (derivative) => proof(derivative.root),
    }));
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof AggregateError
    ? error.errors.some((item: unknown) => hasCode(item, code))
    : error !== null && typeof error === "object" && "code" in error && error.code === code;
}

test("directory publication rejects open, sync, close and unsupported barriers and releases its own lock", async () => {
  await disposable(async (root) => {
    for (const [fault, code] of [["open", "EIO"], ["sync", "ENOSPC"], ["close", "EIO"], ["sync", "ENOTSUP"], ["sync-and-close", "ENOSPC"]] as const) {
      const directory = join(root, `${fault}-${code}`);
      await withDirectoryFault(directory, fault, async () => {
        await assert.rejects(DurableEventLedger.open({ directory }), (error: unknown) => {
          assert(hasCode(error, code));
          if (fault === "sync-and-close") {
            assert(error instanceof AggregateError);
            assert.equal(error.errors.length, 2, "sync and close failures both survive");
          }
          return true;
        });
      }, code);
      const reopened = await DurableEventLedger.open({ directory });
      await reopened.close();
    }
  });
});

test("new Ledger file creation refuses an unsynced directory entry before returning a writer", async () => {
  await disposable(async (root) => {
    const directory = join(root, "live");
    await withDirectoryFault(directory, "sync", async () => {
      await assert.rejects(DurableEventLedger.open({ directory }), (error: unknown) => hasCode(error, "EIO"));
    }, "EIO", 2);
    assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), "");
    const ledger = await DurableEventLedger.open({ directory });
    try {
      const created = event("work.created", { contract: work(), revision: 1 });
      await ledger.append(created);
      assert.deepEqual(await readDurableLedgerEvents(directory), [created]);
    } finally { await ledger.close(); }
  });
});

test("new Ledger file fsync failure returns no writer and leaves existing records untouched", async () => {
  await disposable(async (root) => {
    const directory = join(root, "live"), file = join(directory, "events.jsonl");
    const original = fs.open;
    let injected = false;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[0] === file && args[1] === "wx") {
        handle.sync = async () => { injected = true; throw Object.assign(new Error("injected new file sync"), { code: "EIO" }); };
      }
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    try { await assert.rejects(DurableEventLedger.open({ directory }), (error: unknown) => hasCode(error, "EIO")); }
    finally { fs.open = original; syncBuiltinESMExports(); }
    assert(injected);
    assert.equal(await readFile(file, "utf8"), "");
    const ledger = await DurableEventLedger.open({ directory });
    await ledger.close();
  });
});

test("failed snapshot and archive directory barriers publish no success and preserve committed history", async () => {
  await disposable(async (root) => {
    const directory = join(root, "live"), archive = join(root, "archive");
    const created = event("work.created", { contract: work(), revision: 1 });
    const ledger = await DurableEventLedger.open({ directory });
    try {
      const receipt = await ledger.appendWithReceipt(created);
      const committed = await readFile(ledger.filePath, "utf8");
      await withDirectoryFault(ledger.snapshotsDirectory, "sync", async () => {
        await assert.rejects(ledger.saveSnapshot(created.streamId, { progress: "committed" }), (error: unknown) => hasCode(error, "EIO"));
      });
      assert.equal(await readFile(ledger.filePath, "utf8"), committed);
      assert.equal((await ledger.loadSnapshot(created.streamId))?.throughDigest, receipt.digest,
        "an uncertain durability barrier must not roll back a completed rename");
      await withDirectoryFault(archive, "sync", async () => {
        await assert.rejects(ledger.exportArchive(archive), (error: unknown) => hasCode(error, "EIO"));
      });
      assert.equal(await readFile(ledger.filePath, "utf8"), committed);
      assert.deepEqual(await readDurableLedgerEvents(archive), [created]);
      assert.equal(JSON.parse(await readFile(join(archive, "audit-receipt.json"), "utf8")).headDigest, receipt.digest);
      assert.deepEqual(await ledger.replay(created.streamId), [created]);
      await ledger.append(event("task.created", { objective: "continue" }, { taskId: "task:after-failed-export" }));
    } finally { await ledger.close(); }
    const reopened = await DurableEventLedger.open({ directory });
    try { assert.equal((await reopened.replay(created.streamId)).length, 2); } finally { await reopened.close(); }
  });
});

test("lock release surfaces its directory failure without discarding acknowledged appends", async () => {
  await disposable(async (root) => {
    const directory = join(root, "live");
    const ledger = await DurableEventLedger.open({ directory });
    const created = event("work.created", { contract: work(), revision: 1 });
    await ledger.append(created);
    await withDirectoryFault(directory, "sync", async () => {
      await assert.rejects(ledger.close(), (error: unknown) => hasCode(error, "EIO"));
    });
    const reopened = await DurableEventLedger.open({ directory });
    try { assert.deepEqual(await reopened.replay(created.streamId), [created]); } finally { await reopened.close(); }
  });
});

test("torn-tail repair refuses a failed directory barrier and retains the entire committed prefix", async () => {
  await disposable(async (root) => {
    const directory = join(root, "live");
    const created = event("work.created", { contract: work(), revision: 1 });
    const ledger = await DurableEventLedger.open({ directory });
    await ledger.append(created);
    await ledger.close();
    const file = join(directory, "events.jsonl"), committed = await readFile(file, "utf8");
    await appendFile(file, "{partial");
    // Acquisition is the first directory barrier; the repair is the second.
    await withDirectoryFault(directory, "sync", async () => {
      await assert.rejects(DurableEventLedger.open({ directory }), (error: unknown) => hasCode(error, "EIO"));
    }, "EIO", 2);
    assert.equal(await readFile(file, "utf8"), committed);
    const reopened = await DurableEventLedger.open({ directory });
    try { assert.deepEqual(await reopened.replay(created.streamId), [created]); } finally { await reopened.close(); }
  });
});
