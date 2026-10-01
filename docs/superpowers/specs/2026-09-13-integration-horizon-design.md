# Integration horizon: design

Date: 2026-09-13
Decision record: [ADR 0023](../../decisions/0023-calibrated-integration-horizon.md)
Status: approved, not implemented

This document is the implementation-facing companion to ADR 0023. The ADR records *what was decided and why*. This records *what gets built, where, and how it is proven*. Where the two disagree, the ADR is authority.

## Problem

Measured in the `rhizprotocol` checkout on 2026-09-13: 176 local branches ahead of `origin/main`, carrying 2,020 unmerged commits, of which 106 branches have no remote copy of their unique bytes. The harness already defines an integration horizon (`IntegrationHorizonSignals`, `IntegrationHorizonPolicy`, `PROVISIONAL_INTEGRATION_HORIZON`, `IntegrationController.enforceHorizon`) and it has never run: no non-test caller, and no code anywhere that measures a real repository into those types.

The goal is not to report drift. `session-tidy.sh` already reports, and reporting produced the table above. The goal is to make advancing past the horizon refused, and convergence a harness action.

## Scope

In scope: the calibrated policy, a real sensor, the convergence action, one CLI, enforcement wiring in a consuming repository, and the guards that prove the enforcement is load bearing.

Out of scope, deliberately, so this stays one landable change:

- Triaging the 2,020-commit backlog. `baseline freeze` records it so it stops growing; reducing it is separate work.
- Routing all `rhizprotocol` work through the harness. That is a second subsystem with its own design, and it depends on this one existing and being trusted first.

## Architecture

Dependency direction is `scripts/` → `adapters/` → `src/`, never the reverse. `check:portable-boundary` enforces that `src/` imports no concrete host.

### `src/horizon.ts` — portable

Owns the number and the law. No Git, no host, no storage, no `branch` vocabulary.

```ts
type HorizonPolicyStatus = "provisional" | "calibrated";

interface IntegrationHorizonBaseline {
  commitsAhead: number;
  commitsBehind: number;
  elapsedMs: number;
  diffLines: number;
}

type HorizonDecision =
  | { kind: "clear" }
  | { kind: "grandfathered"; within: IntegrationHorizonBaseline }
  | { kind: "tripped"; reasons: readonly HorizonReason[] };

declare function decideHorizon(
  signals: IntegrationHorizonSignals,
  baseline?: IntegrationHorizonBaseline,
): HorizonDecision;

declare function ratchetBaseline(
  previous: IntegrationHorizonBaseline,
  observed: IntegrationHorizonBaseline,
): IntegrationHorizonBaseline;

declare function assertHorizonAllowsWrite(decision: HorizonDecision): void;
```

`CALIBRATED_INTEGRATION_HORIZON` carries `status: "calibrated"` and the inclusive thresholds from ADR 0023: `commitsAhead >= 10`, `divergenceAgeMs >= 24h`, `diffLines >= 400`, `commitsBehind >= 50`.

`assertHorizonAllowsWrite` throws `IntegrationHorizonExceededError` on `tripped`. It is a separate function from `decideHorizon` because the guard manifest binds to enforcing bytes, and a guard whose declared code also computes the decision cannot be deleted without breaking the build — which ADR 0016 classifies as UNCOMPILABLE, a gate failure.

### Contract changes to `src/integration.ts`

- `IntegrationHorizonPolicy.provisional: true` → `status: HorizonPolicyStatus`.
- `IntegrationHorizonSignals` gains `commitsBehind`, `divergenceAgeMs`, `diffLines`, `binaryFilesChanged`, `upstreamState`.
- `diffBytes` is removed rather than kept alongside `diffLines`. Two fields differing by one word is how the wrong one gets read.
- `PROVISIONAL_INTEGRATION_HORIZON` stays, with `status: "provisional"`, so existing callers and tests keep a policy that behaves as before.

`elapsedMsSinceConvergence` is untouched and keeps its meaning. It is not divergence age: for a branch that has never converged it is undefined, which is precisely the case this work is about.

### `adapters/git/drift.ts` — the sensor

Measures one branch against an integration ref and returns `measured | unavailable`:

| Signal | Source |
| --- | --- |
| `commitsAhead`, `commitsBehind` | `git rev-list --left-right --count <base>...<branch>` |
| `divergenceAgeMs` | committer date of the **oldest** branch-only commit after the merge base |
| `diffLines`, `binaryFilesChanged` | `git diff --numstat <merge-base> <branch>`; a `-` count is a binary file, never zero |
| `upstreamState` | `for-each-ref` upstream and track; absent upstream, or ahead of upstream, means unique local bytes |

`unavailable` covers: no `git`, detached HEAD, branch is the integration ref, corrupt repository, unparseable timestamp, failed `rev-list`, unreachable remote. None of these may return `clear`.

### `adapters/git/converge.ts` — the action

- `convergeHarnessWork(...)` — the existing `GitWorkIntegrationExecutor` path, for branches durably associated with Harness Work.
- `convergeRawBranch(...)` — push, then ensure a PR exists. Never merges.
- `converge(...)` — dispatches only after a deterministic lookup of Work association. No heuristic on branch or PR name.

Durability convergence (push only) is available without a PR, because the remedy for missing remote bytes must not be gated on review.

### `scripts/horizon.mjs` — the only surface a consuming repo touches

| Command | Behaviour |
| --- | --- |
| `check [--branch <b>] [--json]` | exit `0` clear/grandfathered, `1` tripped, `2` unavailable |
| `baseline freeze` | records current per-branch drift as the grandfathered baseline |
| `converge [--branch <b>]` | runs the convergence action |

Baseline is stored per-branch, not per-worktree — 31 worktrees share one `.git`, and the same branch must not get different verdicts in different trees. It is committed: a ratchet nobody can see is a ratchet anyone can reset.

## Enforcement in the consuming repository

Three layers, one verdict, zero copied thresholds. Each shells out to `horizon.mjs` and reacts to the exit code.

| Layer | On tripped | On unavailable |
| --- | --- | --- |
| `pre-commit` | report, **exit 0** | warn, exit 0 |
| Session start | report verdict + convergence command | warn |
| Before file modification | **refuse** | **refuse** |

Committing is never blocked. Refusing to commit is how uncommitted work gets lost, which is the outcome this whole mechanism exists to prevent.

## Proof

### Portable unit tests — `test/horizon.test.ts`

- Each threshold trips at its inclusive boundary and not one unit before: 10 trips, 9 does not; 24h trips, 23h59m does not; 400 trips, 399 does not; 50 behind trips, 49 does not.
- `ratchetBaseline` is monotonic in every field: worse-than-baseline never raises, better lowers.
- A branch inside its baseline on every volume signal, with no remote copy, returns `tripped`.
- A `status: "calibrated"` policy is accepted where `"provisional"` was required.

### Adapter tests — `test/git-drift.test.ts`

Throwaway repositories in temp directories. Never a shared checkout.

- Ahead/behind against a real merge base.
- Divergence age tracks the oldest branch-only commit, and does **not** move when the merge base is old but the branch is new.
- A changed binary file appears in `binaryFilesChanged` and never reads as zero drift.
- Detached HEAD, absent upstream, absent `origin`, and branch-is-integration-ref each produce a **defined measurement failure or safety verdict** — `unavailable` or an explicit safe verdict, never `clear`, never a throw.

### Guards — `scripts/guard-manifest.json`

| id | file | remove | testFile |
| --- | --- | --- | --- |
| `integration/horizon-blocks-write-work` | `src/horizon.ts` | the `assertHorizonAllowsWrite` throw | `dist/test/horizon-enforcement.test.js` |
| `integration/durability-is-never-grandfathered` | `src/horizon.ts` | the baseline-bypass clause for absent remote | `dist/test/horizon-enforcement.test.js` |

`npm run check:guards` deletes each snippet in a disposable derivative (ADR 0019) and requires the named test to go red, with an unmutated control that must go green.

### Calibration against reality — not fixtures

Three guards in this organization's recent history passed against fixtures cleaner than the repository they guarded. So calibration is falsified against the real checkout:

1. Enumerate every branch present at run time.
2. Recompute sentinels **independently with raw Git commands**, so the proof cannot be satisfied by the sensor agreeing with itself.
3. Assert the named falsifiers: a branch known to be far past the horizon on volume trips on volume; every branch with no remote copy trips on durability; the integration ref itself is clear.
4. Write a receipt: integration head SHA, timestamp, branch count, policy id, sensor version, sentinel results.

The branch count goes in the receipt as evidence. It is not an invariant — 176 is one day's census.

### Gates

`npm run check` clean: `check:portable-boundary`, `check:barrel` (regenerate with `--write` after adding `src/horizon.ts`), `check:operator-scripts`, `build`, `node --test`, `check:guards`, `proof:falsifiability`, `check:ci-parity`.

## Risks

**The hard gate makes the harness a dependency of doing any work.** Accepted in ADR 0023: an enforcement that fails open can be disabled by deleting a build directory. The cost lands on the day the harness build breaks for an unrelated reason.

**Bypass remains possible.** `--no-verify` defeats the commit hook, and a sufficiently determined agent can ignore a refusal. This design does not claim to stop a deliberate bypass; it stops drift by default and by inattention, which is what produced 2,020 commits.

**Grandfathering could become permanent.** The baseline ratchets down and never up, so nothing worsens — but nothing forces the backlog to shrink either. That pressure is out of scope here and must not be claimed as solved.
