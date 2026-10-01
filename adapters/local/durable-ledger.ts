import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { HarnessEvent } from "../../src/schemas.js";
import {
  type AuditableEventLedger,
  cloneLedgerEvent,
  DuplicateEventError,
  LedgerAppendReceiptSchema,
  LedgerAuditReceiptSchema,
  LedgerClosedError,
  LedgerIntegrityError,
  LedgerIntegrityReportSchema,
  LedgerLockedError,
  LedgerRecordSchema,
  LedgerSnapshotSchema,
  type EventCursor,
  type LedgerAppendReceipt,
  type LedgerAuditReceipt,
  type LedgerIntegrityReport,
  type LedgerRecord,
  type LedgerSnapshot,
  validateLedgerCursor,
} from "../../src/ledger.js";

interface LockOwner {
  schema: "rhiz/ledger-lock/v1";
  token: string;
  pid: number;
  createdAt: string;
  ledgerPath: string;
}

export interface DurableLedgerOptions {
  directory: string;
  ledgerId?: string;
  fileName?: string;
  repairTornTail?: boolean;
  syncWrites?: boolean;
  now?: () => string;
}

export interface DurableLedgerArchiveReceipt {
  ledger: LedgerAuditReceipt;
  ledgerFile: string;
  receiptFile: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) output[key] = stableValue(item);
  }
  return output;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function recordDigest(record: Omit<LedgerRecord, "digest">): string {
  return sha256(stableJson(record));
}

function snapshotDigest(snapshot: Omit<LedgerSnapshot, "digest">): string {
  return sha256(stableJson(snapshot));
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Some platforms do not permit directory fsync. The data file itself is still synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeAll(handle: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await handle.write(value, offset, value.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("ledger append wrote zero bytes");
    offset += result.bytesWritten;
  }
}

function snapshotFileName(streamId: string): string {
  return `${sha256(streamId).slice("sha256:".length)}.json`;
}

export class DurableEventLedger implements AuditableEventLedger {
  readonly id: string;
  readonly directory: string;
  readonly filePath: string;
  readonly lockPath: string;
  readonly snapshotsDirectory: string;
  readonly #now: () => string;
  readonly #syncWrites: boolean;
  readonly #records: LedgerRecord[];
  readonly #streamRecords = new Map<string, LedgerRecord[]>();
  readonly #eventIds = new Set<string>();
  readonly #lockToken: string;
  readonly #openReport: LedgerIntegrityReport;
  #handle: FileHandle;
  #accepting = true;
  #closed = false;
  #poisoned = false;
  #closePromise: Promise<void> | undefined;
  #appendQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    id: string;
    directory: string;
    filePath: string;
    lockPath: string;
    snapshotsDirectory: string;
    now: () => string;
    syncWrites: boolean;
    records: LedgerRecord[];
    handle: FileHandle;
    lockToken: string;
    openReport: LedgerIntegrityReport;
  }) {
    this.id = options.id;
    this.directory = options.directory;
    this.filePath = options.filePath;
    this.lockPath = options.lockPath;
    this.snapshotsDirectory = options.snapshotsDirectory;
    this.#now = options.now;
    this.#syncWrites = options.syncWrites;
    this.#records = options.records;
    this.#handle = options.handle;
    this.#lockToken = options.lockToken;
    this.#openReport = options.openReport;
    for (const record of options.records) {
      const stream = this.#streamRecords.get(record.event.streamId) ?? [];
      stream.push(record);
      this.#streamRecords.set(record.event.streamId, stream);
      this.#eventIds.add(record.event.id);
    }
  }

  static async open(rawOptions: DurableLedgerOptions): Promise<DurableEventLedger> {
    const directory = resolve(rawOptions.directory);
    const fileName = rawOptions.fileName ?? "events.jsonl";
    if (fileName.includes("/") || fileName.includes("\\") || fileName === "." || fileName === "..") {
      throw new TypeError("ledger fileName must be one path segment");
    }
    const filePath = join(directory, fileName);
    const lockPath = `${filePath}.lock`;
    const snapshotsDirectory = join(directory, "snapshots");
    const now = rawOptions.now ?? (() => new Date().toISOString());
    const lockToken = randomUUID();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(snapshotsDirectory, { recursive: true, mode: 0o700 });

    const lockResult = await acquireLock(lockPath, filePath, lockToken, now);
    let handle: FileHandle | undefined;
    try {
      const loaded = await loadRecords(filePath, rawOptions.repairTornTail ?? true);
      handle = await open(filePath, "a", 0o600);
      const report = LedgerIntegrityReportSchema.parse({
        schema: "rhiz/ledger-integrity-report/v1",
        recordCount: loaded.records.length,
        streamCount: new Set(loaded.records.map((record) => record.event.streamId)).size,
        headDigest: loaded.records.at(-1)?.digest ?? null,
        repairedTailBytes: loaded.repairedTailBytes,
        recoveredStaleLock: lockResult.recoveredStaleLock,
        verifiedAt: now(),
      });
      return new DurableEventLedger({
        id: rawOptions.ledgerId ?? `ledger:${basename(directory)}`,
        directory,
        filePath,
        lockPath,
        snapshotsDirectory,
        now,
        syncWrites: rawOptions.syncWrites ?? true,
        records: loaded.records,
        handle,
        lockToken,
        openReport: report,
      });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await releaseLock(lockPath, lockToken).catch(() => undefined);
      throw error;
    }
  }

  async append(event: HarnessEvent): Promise<void> {
    await this.appendWithReceipt(event);
  }

  appendWithReceipt(event: HarnessEvent): Promise<LedgerAppendReceipt> {
    if (!this.#accepting || this.#closed) return Promise.reject(new LedgerClosedError());
    const parsed = cloneLedgerEvent(event);
    const operation = this.#appendQueue.then(() => this.appendNow(parsed));
    this.#appendQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async appendNow(event: HarnessEvent): Promise<LedgerAppendReceipt> {
    this.assertWritable();
    if (this.#eventIds.has(event.id)) throw new DuplicateEventError(event.id);
    const stream = this.#streamRecords.get(event.streamId) ?? [];
    const unsigned: Omit<LedgerRecord, "digest"> = {
      schema: "rhiz/ledger-record/v1",
      globalSequence: this.#records.length + 1,
      streamSequence: stream.length + 1,
      appendedAt: this.#now(),
      previousDigest: this.#records.at(-1)?.digest ?? null,
      event,
    };
    const record = LedgerRecordSchema.parse({ ...unsigned, digest: recordDigest(unsigned) });
    const line = Buffer.from(`${stableJson(record)}\n`, "utf8");
    try {
      await writeAll(this.#handle, line);
      if (this.#syncWrites) await this.#handle.sync();
    } catch (error) {
      this.#poisoned = true;
      throw new LedgerIntegrityError(`ledger append failed and requires reopen: ${safeError(error)}`);
    }

    this.#records.push(record);
    stream.push(record);
    this.#streamRecords.set(event.streamId, stream);
    this.#eventIds.add(event.id);
    return LedgerAppendReceiptSchema.parse({
      eventId: event.id,
      streamId: event.streamId,
      globalSequence: record.globalSequence,
      streamSequence: record.streamSequence,
      appendedAt: record.appendedAt,
      previousDigest: record.previousDigest,
      digest: record.digest,
    });
  }

  async *read(streamId: string, after: EventCursor = { offset: 0 }): AsyncIterable<HarnessEvent> {
    const offset = validateLedgerCursor(after.offset);
    for (const record of (this.#streamRecords.get(streamId) ?? []).slice(offset)) {
      yield cloneLedgerEvent(record.event);
    }
  }

  async replay(streamId: string): Promise<readonly HarnessEvent[]> {
    return (this.#streamRecords.get(streamId) ?? []).map((record) => cloneLedgerEvent(record.event));
  }

  async *records(afterGlobalSequence = 0): AsyncIterable<LedgerRecord> {
    const offset = validateLedgerCursor(afterGlobalSequence);
    for (const record of this.#records.slice(offset)) {
      yield LedgerRecordSchema.parse(structuredClone(record));
    }
  }

  async integrity(): Promise<LedgerIntegrityReport> {
    await this.#appendQueue;
    validateRecordChain(this.#records);
    return LedgerIntegrityReportSchema.parse({
      ...this.#openReport,
      recordCount: this.#records.length,
      streamCount: this.#streamRecords.size,
      headDigest: this.#records.at(-1)?.digest ?? null,
      verifiedAt: this.#now(),
    });
  }

  async auditReceipt(): Promise<LedgerAuditReceipt> {
    await this.#appendQueue;
    return this.auditReceiptNow();
  }

  auditReceiptNow(): LedgerAuditReceipt {
    validateRecordChain(this.#records);
    return LedgerAuditReceiptSchema.parse({
      schema: "rhiz/ledger-audit-receipt/v1",
      ledgerId: this.id,
      recordCount: this.#records.length,
      streamCount: this.#streamRecords.size,
      firstGlobalSequence: this.#records[0]?.globalSequence ?? null,
      lastGlobalSequence: this.#records.at(-1)?.globalSequence ?? null,
      headDigest: this.#records.at(-1)?.digest ?? null,
      generatedAt: this.#now(),
    });
  }

  async saveSnapshot(streamId: string, state: unknown): Promise<LedgerSnapshot> {
    this.assertAccepting();
    if (state === undefined) throw new TypeError("snapshot state cannot be undefined");
    await this.#appendQueue;
    const record = this.#streamRecords.get(streamId)?.at(-1);
    if (!record) throw new Error(`cannot snapshot empty stream ${streamId}`);
    const unsigned: Omit<LedgerSnapshot, "digest"> = {
      schema: "rhiz/ledger-snapshot/v1",
      streamId,
      throughGlobalSequence: record.globalSequence,
      throughStreamSequence: record.streamSequence,
      throughDigest: record.digest,
      createdAt: this.#now(),
      state: structuredClone(state),
    };
    const snapshot = LedgerSnapshotSchema.parse({ ...unsigned, digest: snapshotDigest(unsigned) });
    const destination = join(this.snapshotsDirectory, snapshotFileName(streamId));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${stableJson(snapshot)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const temporaryHandle = await open(temporary, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporary, destination);
    await syncDirectory(this.snapshotsDirectory);
    return snapshot;
  }

  async loadSnapshot(streamId: string): Promise<LedgerSnapshot | null> {
    this.assertOpen();
    const path = join(this.snapshotsDirectory, snapshotFileName(streamId));
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new LedgerIntegrityError(`snapshot JSON is invalid: ${safeError(error)}`);
    }
    const snapshot = LedgerSnapshotSchema.parse(parsed);
    const { digest: storedDigest, ...unsigned } = snapshot;
    if (snapshotDigest(unsigned) !== storedDigest) throw new LedgerIntegrityError("snapshot digest does not match its contents");
    if (snapshot.streamId !== streamId) throw new LedgerIntegrityError("snapshot stream identity does not match its file");
    const record = this.#records[snapshot.throughGlobalSequence - 1];
    if (!record || record.digest !== snapshot.throughDigest || record.streamSequence !== snapshot.throughStreamSequence || record.event.streamId !== streamId) {
      throw new LedgerIntegrityError("snapshot does not reference an exact record in this Ledger");
    }
    return snapshot;
  }

  async replayAfterSnapshot(snapshot: LedgerSnapshot): Promise<readonly HarnessEvent[]> {
    const parsed = LedgerSnapshotSchema.parse(snapshot);
    const loaded = await this.loadSnapshot(parsed.streamId);
    if (!loaded || loaded.digest !== parsed.digest) throw new LedgerIntegrityError("snapshot is not the current validated snapshot for this Ledger");
    return (this.#streamRecords.get(parsed.streamId) ?? [])
      .filter((record) => record.streamSequence > parsed.throughStreamSequence)
      .map((record) => cloneLedgerEvent(record.event));
  }

  exportArchive(destinationDirectory: string): Promise<DurableLedgerArchiveReceipt> {
    this.assertAccepting();
    const destination = resolve(destinationDirectory);
    const operation = this.#appendQueue.then(() => this.exportArchiveNow(destination));
    this.#appendQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async exportArchiveNow(destination: string): Promise<DurableLedgerArchiveReceipt> {
    if (destination === this.directory) throw new Error("archive destination must differ from the live Ledger directory");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const ledgerFile = join(destination, "events.jsonl");
    const receiptFile = join(destination, "audit-receipt.json");
    const tempLedger = `${ledgerFile}.${randomUUID()}.tmp`;
    const tempReceipt = `${receiptFile}.${randomUUID()}.tmp`;
    await copyFile(this.filePath, tempLedger, fsConstants.COPYFILE_EXCL);
    const ledgerHandle = await open(tempLedger, "r");
    try { await ledgerHandle.sync(); } finally { await ledgerHandle.close(); }
    const receipt = this.auditReceiptNow();
    await writeFile(tempReceipt, `${stableJson(receipt)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const receiptHandle = await open(tempReceipt, "r");
    try { await receiptHandle.sync(); } finally { await receiptHandle.close(); }
    await rename(tempLedger, ledgerFile);
    await rename(tempReceipt, receiptFile);
    await syncDirectory(destination);
    return { ledger: receipt, ledgerFile, receiptFile };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#accepting = false;
    this.#closePromise = (async () => {
      await this.#appendQueue;
      const failures: unknown[] = [];
      if (!this.#poisoned && this.#syncWrites) {
        try { await this.#handle.sync(); } catch (error) { failures.push(error); }
      }
      try { await this.#handle.close(); } catch (error) { failures.push(error); }
      try { await releaseLock(this.lockPath, this.#lockToken); } catch (error) { failures.push(error); }
      this.#closed = true;
      if (failures.length > 0) throw new AggregateError(failures, "durable Ledger close failed");
    })();
    return this.#closePromise;
  }

  assertOpen(): void {
    if (this.#closed) throw new LedgerClosedError();
  }

  assertAccepting(): void {
    if (!this.#accepting || this.#closed) throw new LedgerClosedError();
  }

  assertWritable(): void {
    this.assertOpen();
    if (this.#poisoned) throw new LedgerIntegrityError("ledger is poisoned after a failed append and must be reopened");
  }
}

async function acquireLock(
  lockPath: string,
  ledgerPath: string,
  token: string,
  now: () => string,
): Promise<{ recoveredStaleLock: boolean }> {
  let recoveredStaleLock = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const owner: LockOwner = {
        schema: "rhiz/ledger-lock/v1",
        token,
        pid: process.pid,
        createdAt: now(),
        ledgerPath,
      };
      try {
        await handle.writeFile(`${stableJson(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(lockPath));
      return { recoveredStaleLock };
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      let owner: unknown;
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch (readError) {
        throw new LedgerLockedError(`ledger lock exists but cannot be validated: ${safeError(readError)}`);
      }
      if (!isRecord(owner) || owner.schema !== "rhiz/ledger-lock/v1" || typeof owner.pid !== "number") {
        throw new LedgerLockedError("ledger lock exists with malformed ownership data");
      }
      if (processAlive(owner.pid)) {
        throw new LedgerLockedError(`ledger is already open by pid ${owner.pid}`, owner.pid);
      }
      await rm(lockPath, { force: false });
      await syncDirectory(dirname(lockPath));
      recoveredStaleLock = true;
    }
  }
  throw new LedgerLockedError("could not acquire ledger lock after recovering a stale owner");
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!isRecord(owner) || owner.token !== token) {
    throw new LedgerLockedError("refusing to remove a lock owned by another Ledger instance");
  }
  await rm(lockPath);
  await syncDirectory(dirname(lockPath));
}

async function loadRecords(
  filePath: string,
  repairTornTail: boolean,
): Promise<{ records: LedgerRecord[]; repairedTailBytes: number }> {
  let value: Buffer;
  try {
    value = await readFile(filePath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
    const handle = await open(filePath, "wx", 0o600);
    await handle.close();
    return { records: [], repairedTailBytes: 0 };
  }

  let repairedTailBytes = 0;
  if (value.byteLength > 0 && value[value.byteLength - 1] !== 0x0a) {
    const lastNewline = value.lastIndexOf(0x0a);
    repairedTailBytes = value.byteLength - (lastNewline + 1);
    if (!repairTornTail) throw new LedgerIntegrityError(`ledger has an incomplete tail of ${repairedTailBytes} bytes`);
    await truncate(filePath, lastNewline + 1);
    const handle = await open(filePath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(dirname(filePath));
    value = value.subarray(0, lastNewline + 1);
  }

  const lines = value.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records: LedgerRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) throw new LedgerIntegrityError("ledger contains a blank interior record", index + 1);
    try {
      records.push(LedgerRecordSchema.parse(JSON.parse(line)));
    } catch (error) {
      throw new LedgerIntegrityError(`ledger record ${index + 1} is invalid: ${safeError(error)}`, index + 1);
    }
  }
  validateRecordChain(records);
  return { records, repairedTailBytes };
}

function validateRecordChain(records: readonly LedgerRecord[]): void {
  const streamSequences = new Map<string, number>();
  const eventIds = new Set<string>();
  let previousDigest: string | null = null;
  for (const [index, record] of records.entries()) {
    const expectedGlobal = index + 1;
    if (record.globalSequence !== expectedGlobal) {
      throw new LedgerIntegrityError(`record ${expectedGlobal} has global sequence ${record.globalSequence}`, expectedGlobal);
    }
    const expectedStream = (streamSequences.get(record.event.streamId) ?? 0) + 1;
    if (record.streamSequence !== expectedStream) {
      throw new LedgerIntegrityError(`record ${expectedGlobal} has stream sequence ${record.streamSequence}, expected ${expectedStream}`, expectedGlobal);
    }
    if (record.previousDigest !== previousDigest) {
      throw new LedgerIntegrityError(`record ${expectedGlobal} does not link to the prior digest`, expectedGlobal);
    }
    if (eventIds.has(record.event.id)) {
      throw new LedgerIntegrityError(`duplicate event identity ${record.event.id} in durable history`, expectedGlobal);
    }
    const { digest: storedDigest, ...unsigned } = record;
    if (recordDigest(unsigned) !== storedDigest) {
      throw new LedgerIntegrityError(`record ${expectedGlobal} digest does not match its contents`, expectedGlobal);
    }
    streamSequences.set(record.event.streamId, expectedStream);
    eventIds.add(record.event.id);
    previousDigest = storedDigest;
  }
}
