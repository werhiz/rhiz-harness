# ADR 0016: Every declared guard must be falsifiable

Status: accepted for the Kernel gate

Refines Constitution §10 (mechanical supervision precedes cognitive supervision) and §15 (benchmarks outrank enthusiasm). Applies the repository's own "no seam without a guard" principle reflexively, to the guards.

## Context

Every execution-integrity defect found in the 2026-08-20 review was one shape:

- `GuardPolicy.denyByDefault` returned the same decision in both branches and changed only the audit label.
- A negative control was satisfied by agreement with its primary rather than by falsifying it.
- Dormant DSH composition was proven against a base class that defined no execution methods at all, so the proof held whether or not anything was overridden.
- `LocalCommandVerifierProvider` recorded a verdict while the process it measured was still running.

In every case a test existed, the suite was green, and the property did not hold. A passing test proves the code does *something*. It does not prove the guard is *why*.

The same gap appeared in the review process itself. During this work a mutation intended to neutralise a rule silently failed to apply, the suite passed, and the passing run was very nearly reported as evidence that the guard was proven.

## Decision

Each entry in `scripts/guard-manifest.json` names one safety guard: the file, the exact enforcing code, the test that must fail without it, and why the guard matters.

`npm run check:guards` removes each guard from a disposable derivative of the pinned candidate (`runDisposableProof`, ADR 0019 — a falsifier never writes the candidate it judges), rebuilds there, and runs the named test. The gate passes only when every test **fails** without its guard, and only when that same test **passes** in an unmutated derivative built the same way.

Five outcomes are failures:

- **UNPROVEN.** The test still passes with the guard removed. Nothing establishes the property.
- **DRIFTED.** The declared enforcing code is no longer present. The guard moved or changed, and the manifest must be updated deliberately rather than silently.
- **UNCOMPILABLE.** Removing the snippet broke the build, so the test could not judge it. The declared snippet must be narrowed to the enforcement itself.
- **NO-CONTROL.** The test does not pass in an unmutated derivative, so its red result is about the derivative rather than about the guard.
- **INVALIDATED.** The disposable proof itself was invalidated — candidate drift, an escaped write, a surviving derivative — so no falsifier conclusion drawn from it is valid.

It runs inside `npm run check`, the authority of record, because a gate nobody runs is the ritual this project keeps replacing with guards. It reads the compiled candidate, so `build` precedes it there; `--manifest` and `--only` exist so a disposable proof can point the gate at a mutated manifest.

The gate also names a small set of required guard ids and fails when one is absent from the manifest, so deleting the entry is not a way to make a guard's falsifier stop mattering. That ratchet is itself falsified from a disposable derivative in `test/proofs/`, which `npm run proof:falsifiability` runs inside `npm run check`. Those proofs recompile the whole candidate, so they stay out of the unit glob, and `check:ci-parity` fails if no gate-reachable script executes them or if the unit glob widens to swallow them.

## Consequences

Positive. A guard cannot quietly stop being enforced. Retiring one becomes an explicit manifest edit in the same commit, which is a conversation rather than a silence. On its first run against `main` it found `verify/passing-check-must-carry-evidence`, an enforcement in the Verify engine with no covering test at all, which is now proven by `test/guard-proofs.test.ts`.

Negative. `npm run check` grows by roughly 22 seconds for 10 guards, since each mutant is a separate build and test run. Cost scales linearly with manifest size; if it becomes painful, shard it rather than sampling it, because a sampled gate re-introduces exactly the silence it removes. That figure predates the move to disposable derivatives: each guard now copies and digests the whole candidate root and each distinct falsifier adds an unmutated control compile, so the real cost is several minutes and is an accepted price for a mutation that cannot touch the candidate and a red result that means something. At 36 guards that cost passed the CI job budget, so the gate now takes the sharding branch of this decision rather than the sampling one: guards are judged concurrently, each in its own derivative, and the compile inside a derivative is incremental against the candidate's own build output. Every guard is still judged, and the report is still ordered by the manifest rather than by which derivative finished first.

The manifest is a curated list, not a coverage metric. It says the named guards are load bearing. It does not say the named guards are all the guards, and it must never be read that way.

## What this does not do

It does not prove a guard is *correct*, only that something depends on it. A guard that enforces the wrong rule passes this gate as easily as one that enforces the right rule. Correctness still needs review.

It does not find guards missing from the manifest, beyond the handful of required ids the gate names explicitly. Adding a safety mechanism without a manifest entry is otherwise invisible here, which is why an entry belongs in the same commit as the guard.

## References

- `scripts/check-guard-falsifiability.mjs`, `scripts/guard-manifest.json`, `test/guard-proofs.test.ts`, `test/proofs/guard-manifest-falsifiability.test.ts`
- `docs/reviews/2026-08-20-stack-review.md`
