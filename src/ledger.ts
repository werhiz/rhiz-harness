import { z } from "zod";
import type { HarnessEvent } from "./schemas.js";
import { HarnessEventSchema, TimestampSchema, parseHarnessEvent } from "./schemas.js";

export interface EventCursor {
  offset: number;
}

export interface EventAppendProvenance {
  eventId: string;
  streamId: string;
  globalSequence: number;
  streamSequence: number;
  appendedAt: string;
}

export interface EventLedger {
  append(event: HarnessEvent): Promise<void>;
  read(streamId: string, after?: EventCursor): AsyncIterable<HarnessEvent>;
  replay(streamId: string): Promise<readonly HarnessEvent[]>;
  /**
   * Optional cheap lookup for ledgers that can expose their own append
   * provenance directly. Callers requiring authoritative ordering must fail
   * closed when neither this method nor AuditableEventLedger.records() exists.
   */
  provenanceForEvent?(eventId: string): Promise<EventAppendProvenance | null>;
}

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const LedgerRecordSchema = z.object({
  schema: z.literal("rhiz/ledger-record/v1"),
  globalSequence: z.number().int().positive(),
  streamSequence: z.number().int().positive(),
  appendedAt: TimestampSchema,
  previousDigest: digest.nullable(),
  event: HarnessEventSchema,
  digest,
}).strict();
export type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

export const LedgerAppendReceiptSchema = LedgerRecordSchema.pick({
  globalSequence: true,
  streamSequence: true,
  appendedAt: true,
  previousDigest: true,
  digest: true,
}).extend({
  eventId: z.string().trim().min(1).max(200),
  streamId: z.string().trim().min(1).max(200),
}).strict();
export type LedgerAppendReceipt = z.infer<typeof LedgerAppendReceiptSchema>;

export const LedgerIntegrityReportSchema = z.object({
  schema: z.literal("rhiz/ledger-integrity-report/v1"),
  recordCount: z.number().int().nonnegative(),
  streamCount: z.number().int().nonnegative(),
  headDigest: digest.nullable(),
  repairedTailBytes: z.number().int().nonnegative(),
  recoveredStaleLock: z.boolean(),
  verifiedAt: TimestampSchema,
}).strict();
export type LedgerIntegrityReport = z.infer<typeof LedgerIntegrityReportSchema>;

export const LedgerAuditReceiptSchema = z.object({
  schema: z.literal("rhiz/ledger-audit-receipt/v1"),
  ledgerId: z.string().trim().min(1).max(200),
  recordCount: z.number().int().nonnegative(),
  streamCount: z.number().int().nonnegative(),
  firstGlobalSequence: z.number().int().positive().nullable(),
  lastGlobalSequence: z.number().int().positive().nullable(),
  headDigest: digest.nullable(),
  generatedAt: TimestampSchema,
}).strict();
export type LedgerAuditReceipt = z.infer<typeof LedgerAuditReceiptSchema>;

export const LedgerSnapshotSchema = z.object({
  schema: z.literal("rhiz/ledger-snapshot/v1"),
  streamId: z.string().trim().min(1).max(200),
  throughGlobalSequence: z.number().int().positive(),
  throughStreamSequence: z.number().int().positive(),
  throughDigest: digest,
  createdAt: TimestampSchema,
  state: z.unknown(),
  digest,
}).strict();
export type LedgerSnapshot = z.infer<typeof LedgerSnapshotSchema>;

export interface AuditableEventLedger extends EventLedger {
  appendWithReceipt(event: HarnessEvent): Promise<LedgerAppendReceipt>;
  records(afterGlobalSequence?: number): AsyncIterable<LedgerRecord>;
  integrity(): Promise<LedgerIntegrityReport>;
  auditReceipt(): Promise<LedgerAuditReceipt>;
  close(): Promise<void>;
}

export class DuplicateEventError extends Error {
  constructor(readonly eventId: string) {
    super(`event ${eventId} has already been appended`);
    this.name = "DuplicateEventError";
  }
}

export class LedgerIntegrityError extends Error {
  constructor(message: string, readonly recordIndex?: number) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

export class LedgerLockedError extends Error {
  constructor(message: string, readonly ownerPid?: number) {
    super(message);
    this.name = "LedgerLockedError";
  }
}

export class LedgerClosedError extends Error {
  constructor() {
    super("ledger is closed");
    this.name = "LedgerClosedError";
  }
}

export function cloneLedgerEvent(event: HarnessEvent): HarnessEvent {
  return parseHarnessEvent(structuredClone(event));
}

export function validateLedgerCursor(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("event cursor offset must be a non-negative safe integer");
  }
  return offset;
}

export class InMemoryEventLedger implements EventLedger {
  readonly #streams = new Map<string, HarnessEvent[]>();
  readonly #eventIds = new Set<string>();
  readonly #provenance = new Map<string, EventAppendProvenance>();
  readonly #now: () => string;

  constructor(options: { now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async append(event: HarnessEvent): Promise<void> {
    const parsed = cloneLedgerEvent(event);
    if (this.#eventIds.has(parsed.id)) throw new DuplicateEventError(parsed.id);

    const stream = this.#streams.get(parsed.streamId) ?? [];
    const provenance: EventAppendProvenance = {
      eventId: parsed.id,
      streamId: parsed.streamId,
      globalSequence: this.#eventIds.size + 1,
      streamSequence: stream.length + 1,
      appendedAt: this.#now(),
    };
    stream.push(parsed);
    this.#streams.set(parsed.streamId, stream);
    this.#eventIds.add(parsed.id);
    this.#provenance.set(parsed.id, provenance);
  }

  async *read(streamId: string, after: EventCursor = { offset: 0 }): AsyncIterable<HarnessEvent> {
    const offset = validateLedgerCursor(after.offset);
    const stream = this.#streams.get(streamId) ?? [];
    for (const event of stream.slice(offset)) yield cloneLedgerEvent(event);
  }

  async replay(streamId: string): Promise<readonly HarnessEvent[]> {
    return (this.#streams.get(streamId) ?? []).map(cloneLedgerEvent);
  }

  async provenanceForEvent(eventId: string): Promise<EventAppendProvenance | null> {
    const provenance = this.#provenance.get(eventId);
    return provenance ? structuredClone(provenance) : null;
  }
}
