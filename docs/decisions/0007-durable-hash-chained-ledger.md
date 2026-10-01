# ADR 0007: Durable hash-chained Ledger and crash recovery

Status: accepted for Durable Ledger v1

## Context

The Kernel, Crew, and Verify layers already treat events as the canonical source of organizational truth, yet the only `EventLedger` implementation stores events in process memory. A worker or Harness crash therefore destroys the history required to reconstruct Board state, continue Work safely, audit verification, or compound lessons across runs.

Durability must preserve the portable `EventLedger` contract while keeping local filesystem mechanics outside `src/`.

## Decision

1. The portable core defines runtime-validated Ledger record, append receipt, integrity report, audit receipt, and snapshot contracts.
2. The local durable implementation stores one canonical JSON record per line in an append-only file.
3. Every record carries:
   - contiguous global sequence;
   - contiguous per-stream sequence;
   - append timestamp;
   - previous-record digest;
   - validated `HarnessEvent`;
   - SHA-256 digest over a canonical key-sorted representation.
4. The Ledger has exactly one live writer. A lock file records token, PID, timestamp, and target path.
5. A dead process leaves a recoverable stale lock. A live process or malformed lock fails closed.
6. Each append is serialized, written as one complete line, and synced before becoming visible in memory.
7. An append error poisons the open instance. The caller must reopen and revalidate from disk.
8. A final incomplete line is treated as a torn crash tail and may be truncated to the last complete newline. Malformed complete records, sequence gaps, duplicate events, broken links, or digest mismatches are never repaired automatically.
9. Snapshots are digest-addressed acceleration artifacts bound to an exact historical record. They never replace or delete the event log.
10. Archives copy the full append-only log and a machine-readable audit receipt. Destructive compaction is deferred until a history-preserving archive protocol is proven.
11. Reopen always validates the complete record chain before exposing events.

## Consequences

- Work and Board state survive process death.
- Replay order is storage order, independent of source timestamps.
- Tampering, complete-record corruption, and chain breaks fail closed.
- Crash-tail repair is narrow, observable, and included in integrity reports.
- Snapshots improve future projection startup while preserving complete history.
- The local adapter is replaceable by database, remote, or distributed Ledger providers without changing Work, Crew, Verify, or Board contracts.

## Deferred

- multi-writer consensus;
- remote replication;
- encrypted records;
- key rotation and signatures;
- history-preserving segment compaction;
- snapshot-driven Board startup in the application layer;
- cross-host PID-independent lease services.
