# bb-supervised Rhiz operator pilot

Status: optional terminal/process supervision. bb 0.47.1 is the initial target, not a security or worker-provider boundary.

## Authority

bb owns the terminal view, process lifecycle visibility and optional diagnostic identifiers. Rhiz owns the WorkContract, Codex App Server host, Guard, exact Git workspace binding, independent verification, Ledger, Board, review and acceptance. The integration grants no bb-native agent SHIP authority. A process exit is not a verified or accepted outcome.

The wrapper `scripts/bb-supervise.mjs` supports only `start` and `status` through the existing `npm run operator --` entrypoint. It intentionally refuses `resume`, `review`, `accept`, `reject`, `harvest`, unknown flags, unpinned bases, symlinked input files, and oversized inputs. It is not a replacement for OS containment or Guard pre-effect mediation.

## Install and use on the Mac laptop

Check out `werhiz/rhiz-harness` and use the repository's pinned Node 24.19.0 and npm 11.17.0. Run `npm ci --ignore-scripts --no-audit --no-fund`. Install bb on Apple Silicon macOS, and open a persistent **terminal** in bb for the harness checkout. Use the terminal, not a bb-native SHIP agent.

Choose an expendable target Git repository and prepare a genuine bounded SHIP contract and exact-candidate verification plan. `TARGET`, `CONTRACT`, and `VERIFY` below must be set to absolute filesystem paths. Inspect the plan first:

```bash
node scripts/bb-supervise.mjs start \
  --repo "$TARGET" \
  --contract "$CONTRACT" \
  --verify "$VERIFY" \
  --base "$(git -C "$TARGET" rev-parse HEAD)" \
  --correlation-id bb:pilot-001 \
  --bb-thread-id pilot-thread-001 \
  --dry-run
```

Once approved, remove `--dry-run` to launch the existing governed operator **once**. Correlation labels are diagnostic strings, not authenticated bb identifiers or permission proofs. The existing operator refuses duplicate Work start and creates durable inputs in the target repository's Git metadata.

Read the Board state through the existing operator projection:

```bash
node scripts/bb-supervise.mjs status --repo "$TARGET"
node scripts/bb-supervise.mjs status --repo "$TARGET" --work-id work:example
```

Both commands return the existing operator's JSON. Review/acceptance still occur at their original authenticated operator boundaries. Do not automate resume while interrupted verification recovery is unresolved (issue #10).

## Retention, failure, and truth

After a process closes, the wrapper attempts to write a diagnostic JSON record under `<target Git common dir>/rhiz-harness/bb-observations/`. It contains process exit/signal, timestamps, opaque bb labels and input digests. This file is outside the Ledger, is not a verification receipt, and may be missing if a daemon or machine is killed. It never asserts success, verification or acceptance.

The existing operator/runner retains candidate and Ledger evidence. Before bb archive, stop, or workspace cleanup, independently read back the exact preserved candidate and verification receipts. Process cancellation and signal forwarding are best-effort diagnostics; verify that the underlying worker is truly stopped before resuming or retrying. No independent bb workspace adapter is active.

## Adoption proof

1. Run the wrapper's no-worker tests, exact-head `npm run check`, and hosted Kernel CI.
2. Compare direct and bb-supervised runs of equivalent bounded Work in disposable fixtures, holding model/effort, base SHA, permissions, provider, WorkContract and verification policy constant. Preserve independent Ledgers and candidate refs for each comparison.
3. Prove pre-effect denials, wrong-directory refusal, symlink escape, mutation race, stale receipt refusal, termination during verification, review independence and candidate retention. Issue #10 is a recovery blocker, not a permission to infer a result.
4. Run the authenticated `npm run canary:codex` and macOS containment proofs on the exact candidate. Hosted Linux CI does not cover them.
5. Only consider a separate bb `WorkerProvider` after supported pre-effect permission mediation and verified cancellation/lease/identity semantics exist.

No client data, production permissions, new worker provider, bb worktree ownership, remote daemon or automatic acceptance is introduced here.
