# Work Integration Controller

Status: current architecture and operator contract for Issue #77.

The Integration Controller is the Harness-owned convergence seam between disposable worker workspaces and one durable Work candidate. Workers produce bytes. They never push, merge, rebase, update the Work ref, or create a competing PR. The controller owns those mutations through a replaceable Git adapter and records every decision on the existing Work Ledger stream.

## Lifecycle

```text
Attempt workspace at recorded Work head
  -> Harness checkpoint commit
  -> immutable remote rescue ref observed
  -> exact candidate verification
  -> automatic Work queue
  -> one durable integration lock
  -> reconcile against latest Work head
  -> final exact-head proof
  -> compare-and-swap remote Work ref
  -> integration.head-advanced on the Work Ledger
  -> stale task reconciliation
  -> one Work PR
  -> explicitly authorized merge
  -> cleanup only after integrated, remotely rescued, or human-discarded
```

Board is reconstructed from Ledger events. The Git remote is durable artifact truth. Neither an in-memory queue nor a local ref is sufficient proof of shared state.

## Twelve invariants and falsifiers

| ID | Invariant | Falsifier |
| --- | --- | --- |
| `integration/one-work-one-ref` | One Work owns one durable integration ref and mutable head. | Create or advance a shadow Work ref without a split decision. |
| `integration/task-base-is-explicit` | Every Attempt records the Work head from which its workspace derives. | Project an integrated Attempt without a base head. |
| `integration/checkpoint-is-remote` | Candidate bytes are pushed and read back before queueing. | Queue a local-only checkpoint. |
| `integration/eligibility-queues-automatically` | An eligible candidate enters the Work queue automatically. | Record an eligible candidate and observe no queue entry. |
| `integration/one-serialized-lock` | Only the queue head integrates under one durable lock. | Run two executors concurrently or integrate out of order. |
| `integration/proof-binds-exact-head` | Shared head movement requires proof for those exact bytes. | Supply a different `proofHead` or stale verification event. |
| `integration/head-movement-stales-proof` | Older task proof becomes stale when the Work head moves. | Keep old proof current after advancement. |
| `integration/stale-task-reconciles` | A stale task resumes only after clean reconciliation and fresh proof. | Mark it current without reconciliation evidence. |
| `integration/conflict-preserves-both` | A semantic conflict preserves both remote states and stops advancement. | Drop either state or move the Work ref. |
| `integration/restart-replays-lock` | Restart resumes the durable Ledger lock and idempotent remote operation. | Depend on an unrecorded in-memory lock or lose the candidate. |
| `integration/one-pr-unless-split` | One Work has one PR unless an explicit split decision exists. | Associate a second PR without that decision. |
| `integration/cleanup-proves-disposition` | Cleanup requires integration, remote rescue, or human-authorized discard. | Remove the final unique bytes without a durable disposition. |

The typed source of truth is `INTEGRATION_CONTROLLER_INVARIANTS` in `src/integration.ts`. `test/integration-controller-v77.test.ts` and `test/git-integration-controller.test.ts` exercise the controller, Board projection, Guard boundary, remote ref behavior, process restart, and both clean and conflicting reconciliation.

## Replaceable Git seam

`GitWorkIntegrationExecutor` implements the current Git mechanics behind the portable `WorkIntegrationExecutor` interface:

- immutable checkpoint push and remote read-back;
- disposable reconciliation worktrees;
- semantic-proof callback on the exact reconciled commit;
- conflict refs preserving the Work base and task candidate;
- compare-and-swap advancement of the remote Work ref;
- idempotent success when restart observes the intended remote target already present.

The adapter does not decide acceptance or merge authority. Those remain explicit Board events and human decisions.

## Board projection

The Work integration projection exposes:

- current head and integration ref;
- queue and active lock;
- per-task base and checkpoint heads;
- remote checkpoint status;
- resource leases;
- integration eligibility and queue position;
- proof status and exact head-proof receipt;
- reconciliation/conflict refs;
- associated PRs;
- merge authority and status;
- cleanup dispositions and failures.

This is a projection of the existing Work stream, not a second truth system.
