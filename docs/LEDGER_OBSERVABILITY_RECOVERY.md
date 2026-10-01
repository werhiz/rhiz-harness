# Ledger, Observability, and Recovery

Status: current operational synthesis. Exact Ledger contracts live in `src/ledger.ts`, `adapters/local/durable-ledger.ts`, Board projection, tests, and ADR 0007.

## Purpose

Rhiz Harness treats organizational memory as durable infrastructure. A worker, terminal, host, process, or UI may disappear without erasing what the organization knows about the Work.

The Ledger is the append-only durable history. Board is a deterministic projection over that history.

```text
Event producers
     |
     v
   Ledger
     |
     +--> Board projection
     +--> audit / why
     +--> recovery
     +--> benchmark evidence
     +--> Refiner learning
```

## Events are facts

Consequential transitions are recorded as typed events. Examples include:

```text
work.created
work.amended
task.created
attempt.started
attempt.activity-observed
attempt.finished
attempt.failed
guard.evaluated
verification.started
verification.result
review.finding
work.accepted
work.rejected
work.parked
integration.checkpoint-recorded
```

Events record what happened. Projections interpret those events into current state.

A runtime observation is still only an observation. Recording it durably does not promote it to organizational authority.

## Durable local Ledger

`DurableEventLedger` is the current file-backed implementation.

It uses:

- append-only JSONL records;
- global and per-stream sequence numbers;
- duplicate event-id rejection;
- hash chaining through `previousDigest` and record digest;
- synchronous file writes by default;
- a process lock to prevent conflicting writers;
- stale-lock recovery;
- torn-tail repair on open by default;
- stream replay;
- integrity reports;
- audit receipts;
- snapshot support.

The default durable directory is created with restrictive filesystem permissions, and the event file is opened with owner-only permissions where supported.

## Hash chaining

Each durable record includes the digest of the previous record. The current head digest therefore commits to the ordered record history that precedes it.

An integrity check recomputes the chain and fails on corruption or inconsistent sequence data.

The hash chain is tamper-evident storage, not a claim that the local filesystem itself is an authenticated external trust anchor. Stronger remote or signed ledgers can implement the same portable interface later.

## Streams

Work-related events use durable stream identity. Board replay consumes the Work stream to rebuild the same projection.

A single Work owns one stream for its organizational lifecycle. Integration checkpoints remain on that Work stream rather than creating a second Board or parallel state machine.

## Board replay

Board state should be reconstructible from the event sequence.

Illegal transitions are represented as projection violations rather than silently mutating state. That makes replay diagnostic as well as restorative: the record shows both the attempted fact and the fact that Board refused to derive an illegal state from it.

## Observability

Rhiz distinguishes several classes of observable information:

### Durable organizational facts

Examples: Work creation, authority decisions, verification results, acceptance, integration checkpoints.

These belong in the Ledger.

### Runtime observations

Examples: process activity, worker messages, session liveness, provider diagnostics.

These may be recorded, but they do not automatically become canonical state.

### Evidence

Examples: test receipts, static analysis, diffs, artifact identity, logs, screenshots, external receipts.

Evidence supports claims and is referenced from durable events.

### Derived views

Examples: Board, dashboards, CLI status, benchmark summaries.

Derived views can be rebuilt. They are not separate truth stores.

## Recovery model

Recovery follows the rule that Work survives workers.

After a crash or interruption, the system should be able to:

1. reopen the durable Ledger;
2. verify record-chain integrity;
3. replay the Work stream;
4. reconstruct Board state;
5. inspect the latest Attempt and integration checkpoint;
6. determine whether a workspace/candidate was preserved;
7. decide whether to resume, retry, park, reject, or verify again.

A restart should not require a human to reconstruct state from terminal scrollback.

## Candidate recovery

Repository Work can preserve a candidate under Harness-owned Git refs. This makes the artifact durable beyond a temporary worktree lifetime.

Current repository-run receipts may include:

```text
candidate.head
candidate.tree
candidate.rescueRef
candidate.verifiedRef
changedPaths
verification result id
integration checkpoint
ledger head digest
```

The candidate reference preserves the exact code. The Ledger preserves why it exists and what proof was attached to it.

## Crash recovery versus retry

Recovery and retry are different.

Recovery asks:

> What durable Work and artifact state already exists, and can execution continue from it safely?

Retry asks:

> Should a new Attempt execute the same Work contract, carrying forward evidence from the previous failure?

A retry creates a new Attempt identity. It does not overwrite the failed Attempt.

## Liveness

Process liveness is an observation. Rhiz deliberately avoids treating a running PID or open session as proof that useful progress is happening.

Mechanical supervision should monitor machine-readable signals without spending model tokens where possible:

- process existence;
- lease expiration;
- workspace state;
- filesystem drift;
- queue state;
- verifier timeout;
- Git identity;
- deterministic health checks.

Cognitive supervision is reserved for ambiguity and judgment.

## Durability proof in current dogfood

The real Codex canary and repository Work runner both close and reopen the durable Ledger before declaring their durability checks successful.

That distinction matters: successful execution in one process is not proof that organizational evidence survives restart.

## Operational checks

The full repository gate is:

```bash
npm run check
```

For a repository-run receipt, preserve both the verified candidate ref and the receipt when the result matters. The receipt's Ledger head digest is a compact identity for the durable history observed by that run.

## Deeper reference

See:

- [Durable Ledger v1](DURABLE_LEDGER_V1.md)
- [Kernel 0.1](KERNEL_0_1.md)
- [Execution Lifecycle](EXECUTION_LIFECYCLE.md)
- [Verification and Acceptance](VERIFICATION_AND_ACCEPTANCE.md)
- ADR 0007 in [Architecture Decision Records](decisions/README.md)