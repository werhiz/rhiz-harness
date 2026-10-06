import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessEvent } from "../../src/schemas.js";

/**
 * The verifier's own words about a refused attempt, kept across process death.
 *
 * `verification.result` is deliberately small: it records pass or fail and the
 * criteria, not the check summaries that say what was refused. Those summaries
 * existed only in the runner's memory, so a resumed run started with an empty
 * refusal history and the next attempt repaired blind. This module is the
 * durable seam for them: one file per refused verification, named by the
 * Ledger event it explains and bound to it on read.
 *
 * Nothing here is authority. The Ledger decides that a verification failed; a
 * refusal file only supplies the text. A file that does not match a failing
 * `verification.result` for the same Work is rejected and reported, never
 * carried, and a failed verification with no file is reported as missing,
 * never reconstructed.
 */

export const VERIFIER_REFUSAL_SCHEMA = "rhiz/verifier-refusal/v1" as const;
export const VERIFIER_REFUSALS_DIRECTORY = "verifier-refusals";
const MAX_SUMMARY = 4000;
const MAX_CHECKS = 8;

export interface VerifierRefusalCheck {
  checkId: string;
  status: "fail" | "error";
  summary: string;
}

export interface VerifierRefusal {
  schema: typeof VERIFIER_REFUSAL_SCHEMA;
  workId: string;
  attemptNumber: number;
  attemptId: string;
  verificationId: string;
  verificationResultEventId: string;
  recordedAt: string;
  checks: readonly VerifierRefusalCheck[];
  /** sha256 over the canonical JSON of every other field. Detects a damaged file, not a forger. */
  digest: string;
}

export interface VerifierRefusalInput {
  workId: string;
  attemptNumber: number;
  attemptId: string;
  verificationId: string;
  verificationResultEventId: string;
  recordedAt?: string;
  checks: readonly { checkId: string; status: "pass" | "fail" | "error"; summary: string }[];
}

function digestOf(body: Omit<VerifierRefusal, "digest">): string {
  // JSON.stringify of a fixed-order structure is injective over its string
  // values: every delimiter inside a value is escaped by the encoder.
  const canonical = JSON.stringify([
    body.schema, body.workId, body.attemptNumber, body.attemptId, body.verificationId,
    body.verificationResultEventId, body.recordedAt,
    body.checks.map((check) => [check.checkId, check.status, check.summary]),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function buildVerifierRefusal(input: VerifierRefusalInput): VerifierRefusal {
  const checks = input.checks
    .filter((check): check is VerifierRefusalCheck => check.status !== "pass")
    .slice(0, MAX_CHECKS)
    .map((check) => ({ checkId: check.checkId, status: check.status, summary: check.summary.slice(0, MAX_SUMMARY) }));
  const body = {
    schema: VERIFIER_REFUSAL_SCHEMA,
    workId: input.workId,
    attemptNumber: input.attemptNumber,
    attemptId: input.attemptId,
    verificationId: input.verificationId,
    verificationResultEventId: input.verificationResultEventId,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    checks,
  } as const;
  return { ...body, digest: digestOf(body) };
}

function fileNameFor(eventId: string): string {
  return `${createHash("sha256").update(eventId).digest("hex")}.json`;
}

/** Write atomically: a crash leaves the whole file or none of it. */
export async function writeVerifierRefusal(ledgerDirectory: string, refusal: VerifierRefusal): Promise<string> {
  const directory = join(ledgerDirectory, VERIFIER_REFUSALS_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, fileNameFor(refusal.verificationResultEventId));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(refusal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

export interface VerifierRefusalReading {
  /** Refusals bound to a failing verification of this Work, oldest first. */
  refusals: readonly VerifierRefusal[];
  /** Failing verifications whose refusal text is absent. Reported, never invented. */
  missing: readonly string[];
  /** Files that are damaged or do not match the Ledger. Never carried. */
  rejected: readonly { path: string; reason: string }[];
}

function isRefusal(value: unknown): value is VerifierRefusal {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.schema === VERIFIER_REFUSAL_SCHEMA
    && typeof item.workId === "string"
    && typeof item.attemptId === "string"
    && typeof item.verificationId === "string"
    && typeof item.verificationResultEventId === "string"
    && typeof item.recordedAt === "string"
    && typeof item.digest === "string"
    && Number.isInteger(item.attemptNumber)
    && Array.isArray(item.checks)
    && item.checks.every((check) => check !== null && typeof check === "object"
      && typeof (check as VerifierRefusalCheck).checkId === "string"
      && typeof (check as VerifierRefusalCheck).summary === "string"
      && ((check as VerifierRefusalCheck).status === "fail" || (check as VerifierRefusalCheck).status === "error"));
}

export async function readVerifierRefusals(input: {
  ledgerDirectory: string;
  workId: string;
  events: readonly HarnessEvent[];
}): Promise<VerifierRefusalReading> {
  const failing = new Map<string, string>();
  for (const event of input.events) {
    if (event.workId === input.workId && event.type === "verification.result" && event.payload.status === "fail") {
      failing.set(event.id, event.payload.verificationId);
    }
  }
  const directory = join(input.ledgerDirectory, VERIFIER_REFUSALS_DIRECTORY);
  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const refusals: VerifierRefusal[] = [];
  const rejected: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const path = join(directory, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      rejected.push({ path, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!isRefusal(parsed)) { rejected.push({ path, reason: "not a verifier refusal record" }); continue; }
    const { digest, ...body } = parsed;
    if (digestOf(body) !== digest) { rejected.push({ path, reason: "digest does not match its content" }); continue; }
    if (parsed.workId !== input.workId) continue; // another Work's refusal in a shared directory
    if (failing.get(parsed.verificationResultEventId) !== parsed.verificationId) {
      rejected.push({ path, reason: "does not match a failing verification.result of this Work in the Ledger" });
      continue;
    }
    if (seen.has(parsed.verificationResultEventId)) continue;
    seen.add(parsed.verificationResultEventId);
    refusals.push(parsed);
  }
  refusals.sort((left, right) => left.attemptNumber - right.attemptNumber);
  const missing = [...failing.keys()].filter((eventId) => !seen.has(eventId));
  return { refusals, missing, rejected };
}

/** The refusal as a tainted attachment the next worker may read as data and never as instruction. */
export function refusalAsAttachments(refusals: readonly VerifierRefusal[], workId: string) {
  return refusals.flatMap((refusal) => refusal.checks.map((check) => ({
    id: `attachment:${workId}:attempt-${refusal.attemptNumber}:${check.checkId}`.slice(0, 200),
    label: "error-message" as const,
    source: {
      value: `check ${check.checkId} reported ${check.status}\n${check.summary}`.slice(0, 4000),
      provenance: { kind: "error-message" as const, workId },
    },
  })));
}
