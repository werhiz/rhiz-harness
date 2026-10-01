# ADR 0023: The integration horizon is calibrated, enforced, and cannot forgive missing durability

Status: proposed

Amended 2026-09-14 (PR #118): the grandfathering rule below distinguishes active from passive signals. The original text forgave all four volume signals against a frozen baseline, which left 172 of 176 branches tripped the moment the baseline was armed. See Lesson 0005.

Refines Constitution §10 (mechanical supervision precedes cognitive supervision). Calibrates the horizon left provisional by the Issue #77 integration controller, and binds it to enforcement under ADR 0016.

## Context

`src/integration.ts` has carried an integration horizon since the #77 controller landed: `IntegrationHorizonSignals`, `IntegrationHorizonPolicy`, `PROVISIONAL_INTEGRATION_HORIZON`, and `IntegrationController.enforceHorizon`. The policy's own comment states the position plainly — it "deliberately uses no fixed numeric cap. Until dogfood supplies a calibrated limit, any observed private advancement requires a safe checkpoint and convergence."

Two things were true of that seam on 2026-09-13.

First, **it had never run.** `enforceHorizon` has no non-test caller. Nothing in the repository computes `commitsAhead`, or any other field of `IntegrationHorizonSignals`, from a real repository. The types, the policy, the error, and the enforcement method all existed and described each other; no byte of real Git state ever entered them. This is the failure shape the Constitution warns about in a different register: a capability is not complete because its type exists.

Second, **the dogfood evidence the comment was waiting for had arrived, and it was severe.** Measured against `origin/main` in the `rhizprotocol` checkout on this machine:

| Signal | Count |
| --- | --- |
| Local branches ahead of `origin/main` | 176 |
| Unmerged commits on them | 2,020 |
| Branches more than 10 commits ahead | 47 |
| Branches with no upstream, or ahead of their upstream | 106 |
| Linked worktrees | 31 |

The distribution matters more than the totals. The worst branch sits 196 ahead and 321 behind, last touched ten days ago. The next sits 144 ahead and 438 behind. Branches in that state are not merge candidates; their merge base is archaeology. The work was not lost to a mistake. It was lost to the absence of a mechanism that notices.

The 106 figure is a different and worse class. Those branches hold unique bytes that exist on exactly one disk, with no remote copy of any kind. Volume drift costs reconciliation effort. Missing durability costs the work itself.

The provisional policy could not have been switched on as written: it trips on `commitsAhead > 0`, so with a real sensor attached every branch in the repository would block immediately. A policy that refuses everything is not enforcement, it is an outage.

## Decision

**The horizon becomes calibrated, measured, and enforced, under one model:**

> Sensor uncertainty fails closed without pretending it is policy drift. Existing drift may be grandfathered and can only shrink. Missing durability is never grandfathered. Threshold boundaries are inclusive. Calibration is pinned to a reproducible repository snapshot, not a transient branch count.

### The policy contract gains a lifecycle

`IntegrationHorizonPolicy.provisional: true` becomes `status: "provisional" | "calibrated"`. A calibrated policy is admissible where the provisional one was required. `IntegrationHorizonSignals` gains the measurable facts the original set could not express: `commitsBehind`, `divergenceAgeMs`, `diffLines`, `binaryFilesChanged`, and `upstreamState`.

`diffLines`, not `diffBytes`. `git diff --numstat` reports added and deleted lines; the threshold is stated in lines; the field is named for what it holds. `--numstat` reports `-` for binary files, so binary changes are counted in `binaryFilesChanged` rather than coerced to zero.

`divergenceAgeMs` is measured from the **oldest branch-only commit after the merge base**, not from the merge base itself. The merge base's age is the age of the common ancestor, which says nothing about how long private work has been accumulating.

### Thresholds are inclusive

`CALIBRATED_INTEGRATION_HORIZON` trips when any one of these holds:

- `commitsAhead >= 10`
- `divergenceAgeMs >= 24h`
- `diffLines >= 400`
- `commitsBehind >= 50`

Inclusive, stated once, here. The boundary tests are therefore 9 commits, 23h59m, 399 lines, and 49 behind — each of which must not trip.

The numbers follow trunk-based integration practice and the review-effectiveness range that puts comprehension loss past a few hundred changed lines. `commitsBehind` is in the set because volume alone would not have caught the branch that hurt most: divergence, not size, is what made 196/321 unrecoverable.

### Two trigger classes, only one of them forgivable

**Volume drift** may be grandfathered against a frozen baseline, but not uniformly, because two of the four signals move without anyone acting.

`commitsAhead` and `diffLines` are **active**: they advance only when an author adds work. A baseline raises their bar to the inherited value, so grandfathered drift does not trip and one more commit or line does. `ratchetBaseline` is monotonic per field: an observation worse than the baseline never raises it, a better one lowers it.

`commitsBehind` and `divergenceAgeMs` are **passive**: the first grows whenever the integration ref advances, the second with the clock. Freezing their instantaneous value is not leniency, it is a bar that rises on its own, and a candidate exceeds it without being touched. They are therefore suspended for a candidate whose baseline **recorded a value already past the threshold** — the population the day-one wall consisted of — and enforced normally for everyone else.

The exemption is keyed to the recorded value, never to the existence of a baseline row. Keying it on existence would make the pass permanent and transferable: a candidate that fully converged would keep its row and its exemption, and a reused name would inherit one. See Lesson 0005.

**Durability** — unique local bytes with no remote copy — is never grandfathered, under any baseline, at any age. A baseline exists to let inherited drift shrink safely. It must never legalize bytes that exist on one machine. The remedy is cheap, non-destructive, and requires no review: push.

### Measurement is separable from decision

The portable decision stays `clear | tripped | grandfathered`. The adapter reports `measured | unavailable`. A detached HEAD, an absent `git`, a corrupt repository, a malformed timestamp, a failed `rev-list`, or an unreachable remote is `unavailable` — never `clear`, and never `tripped` either, because a sensor failure is not a policy verdict and must not be recorded as one.

The CLI contract is therefore three states, not two:

- `0` — measured; clear or grandfathered
- `1` — measured; tripped, with reasons
- `2` — could not establish the facts safely

### Enforcement is layered, and never blocks saving work

A gate on `git commit` would block *saving* work, which causes the loss it intends to prevent. Committing is always permitted. What is refused is advancing further.

- **`pre-commit`** — reports, always exits 0. Tool-agnostic, so it sees Codex, Claude, and hand-typed Git alike.
- **Session start** — reports the verdict and the convergence command before work is planned.
- **Before file modification** — refuses. This is the hard gate.

On `2` (unavailable), the first two degrade to a loud warning and the hard gate refuses. A guard that fails open is a guard that can be disabled by breaking the build.

### Convergence dispatches deterministically

Harness Work and raw Git branches have different authority models, so the adapter keeps them separate: `convergeHarnessWork` drives the existing `GitWorkIntegrationExecutor`; `convergeRawBranch` pushes and ensures a PR. `converge` dispatches only after a deterministic lookup establishes which the branch is — never a heuristic on its name or PR title. Neither path merges to `main`.

### Enforcement is bound to guards, not to intent

Two entries in `scripts/guard-manifest.json`, each naming the exact enforcing bytes — the code that refuses, not the code that computes:

- `integration/horizon-blocks-write-work` — the `assertHorizonAllowsWrite` refusal.
- `integration/durability-is-never-grandfathered` — the clause in `decideHorizon` that bypasses the baseline when a remote copy is absent.

Under ADR 0016 each is proven by deleting those bytes in a disposable derivative (ADR 0019) and requiring the named test to go red.

### Calibration is pinned to a snapshot

The calibration proof enumerates whatever branches exist when it runs and writes a receipt: integration head SHA, timestamp, branch count, policy id, sensor version, and sentinel results. The branch count is evidence, not an invariant — 176 is today's census and will drift.

Sentinels are recomputed independently with raw Git commands rather than read back from the sensor, so the proof cannot be satisfied by the implementation agreeing with itself.

## Consequences

Positive. The horizon stops being a described mechanism and becomes a running one. Drift is measured from real state rather than asserted. Missing durability — the class that can lose work outright — is caught unconditionally and remedied by a push. The threshold has exactly one owner, so a consuming repository cannot hold a second, quietly different copy of the number.

Negative. Every consuming repository takes a dependency on a harness build being present, and the hard gate refuses when it is not. That is the deliberate cost of an enforcement that cannot be switched off by deleting `dist/`, and it will be inconvenient on the day the harness build is broken for an unrelated reason.

The baseline is a ratchet on what an author does: a grandfathered candidate trips the moment it advances at all, which is the intended pressure and will feel abrupt on the oldest ones. It is deliberately not a ratchet on passive drift. A candidate already past the bar for age or behind-ness may fall further behind without being blocked, because blocking it would punish it for other people's merges and for the passage of time, neither of which it can act on. Convergence restores full enforcement: once the baseline ratchets below the thresholds, the passive signals bind again.

This ADR calibrates and enforces the horizon. It does not triage the 2,020 commits already accumulated. `baseline freeze` records that backlog so it stops growing; reducing it is separate work, and pretending otherwise would let a design document take credit for a cleanup nobody has done.
