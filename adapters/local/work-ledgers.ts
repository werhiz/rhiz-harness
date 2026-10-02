import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { HarnessEvent } from "../../src/schemas.js";
import { readDurableLedgerEvents } from "./durable-ledger.js";

/**
 * Where the repository runner keeps one durable Ledger per Work:
 * `<git-common-dir>/rhiz-harness/ledgers/<work segment>/events.jsonl`.
 *
 * This module only discovers and reads them. It owns no fact: every answer is
 * the Ledger's own events, and a Ledger that cannot be read is reported as
 * unreadable rather than silently treated as a Ledger with no history.
 * Benchmark arms (`benchmark-runs/`) are measurement runs, not organizational
 * Work, and are not discovered here.
 */

export interface WorkLedgerSnapshot {
  directory: string;
  events: readonly HarnessEvent[];
  /** Work ids present in this Ledger, in first-seen order. */
  workIds: readonly string[];
}

export interface UnreadableWorkLedger {
  directory: string;
  error: string;
}

export interface RepositoryWorkLedgers {
  ledgers: readonly WorkLedgerSnapshot[];
  unreadable: readonly UnreadableWorkLedger[];
}

export function workLedgersRoot(gitCommonDir: string): string {
  return join(resolve(gitCommonDir), "rhiz-harness", "ledgers");
}

export async function readRepositoryWorkLedgers(gitCommonDir: string): Promise<RepositoryWorkLedgers> {
  const root = workLedgersRoot(gitCommonDir);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ledgers: [], unreadable: [] };
    throw error;
  }
  const ledgers: WorkLedgerSnapshot[] = [];
  const unreadable: UnreadableWorkLedger[] = [];
  for (const name of names) {
    const directory = join(root, name);
    try {
      await stat(join(directory, "events.jsonl"));
    } catch {
      continue;
    }
    try {
      const events = await readDurableLedgerEvents(directory);
      const workIds = [...new Set(events.map((event) => event.workId))];
      ledgers.push({ directory, events, workIds });
    } catch (error) {
      unreadable.push({ directory, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ledgers, unreadable };
}

/** Every event of every discovered Work Ledger except the excluded directories. */
export async function readRepositoryWorkEvents(
  gitCommonDir: string,
  options: { excludeDirectories?: readonly string[] } = {},
): Promise<{ events: readonly HarnessEvent[]; unreadable: readonly UnreadableWorkLedger[] }> {
  const excluded = new Set((options.excludeDirectories ?? []).map((directory) => resolve(directory)));
  const { ledgers, unreadable } = await readRepositoryWorkLedgers(gitCommonDir);
  return {
    events: ledgers.filter((ledger) => !excluded.has(resolve(ledger.directory))).flatMap((ledger) => ledger.events),
    unreadable,
  };
}
