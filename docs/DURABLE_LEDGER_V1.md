# Durable Ledger v1

Durable Ledger v1 makes Work, Board state, verification history, and acceptance evidence survive the process that produced them.

## Storage contract

Each durable record contains:

```text
global sequence
stream sequence
append timestamp
previous digest
validated HarnessEvent
record digest
```

The record digest is SHA-256 over a canonical key-sorted representation. The global previous-digest link makes the file one tamper-evident chain across every Work stream.

## Guarantees

- append-only JSONL storage;
- one live writer per Ledger;
- fsync-backed append completion by default;
- duplicate event identity rejection across reopen;
- contiguous global and stream sequence validation;
- complete hash-chain validation on open;
- narrow repair of an incomplete final crash tail;
- fail-closed handling of malformed complete records;
- stale lock recovery after a dead process;
- deterministic stream replay and global record export;
- digest-bound snapshots that retain full history;
- portable archive containing the full log and an audit receipt.

## Crash-recovery proof

The proof deliberately:

1. starts a child Harness process;
2. opens the durable Ledger and appends `work.created`, Task assignment, and a running Attempt;
3. kills the process with `SIGKILL` before it can close the Ledger;
4. reopens the Ledger from a new process;
5. recovers the stale writer lock;
6. rebuilds Board state as `running` from durable history;
7. records the dead Attempt as failed;
8. starts and finishes a replacement Attempt;
9. verifies the exact target with an independent VerifierProvider;
10. accepts Work through a separate authorized event;
11. closes and reopens again;
12. rebuilds final Board state as `accepted` with zero violations.

## Acceptance gate

Durable Ledger v1 is proven when:

- reopen preserves event identity and exact stream order;
- global and stream sequences remain contiguous;
- previous-digest links and record digests validate;
- duplicate events fail after restart;
- concurrent live writers are rejected;
- a dead writer lock is recoverable;
- complete-record tampering fails closed;
- only an incomplete final line is repairable;
- snapshots bind to exact records and replay only later events;
- archives retain the full readable log and audit receipt;
- a killed process can be recovered through verification and acceptance;
- all prior Kernel, DSH, Workers, Crew, and Verify proofs remain green.

## Operational boundary

The local durable Ledger is a filesystem adapter. `src/` owns the portable contracts. Future database, cloud, replicated, or encrypted implementations must satisfy the same `EventLedger` and audit semantics.

## Deferred

- distributed multi-writer consensus;
- encryption at rest;
- cryptographic signatures and key rotation;
- remote replication;
- destructive compaction;
- automatic Board snapshot consumption;
- persistent Crew resumption policy above the Ledger.
