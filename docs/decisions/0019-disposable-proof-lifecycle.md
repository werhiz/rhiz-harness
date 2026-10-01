# ADR 0019: Proof operations run in a disposable derivative, and the candidate's identity is re-proven

Status: accepted for Kernel 0.1. Addresses issue #63, which stays open until the seam has a second consumer.

## Context

A falsifier has to break something to be worth anything. Mutation tests, negative controls and proof-by-perturbation all work by making the candidate wrong on purpose and watching a check notice. That makes proof machinery the one part of this system whose *job* is to write damage.

On 2026-08-20, during the RH-14 canary, it wrote that damage into the real candidate worktree. A worker mutated `src/board.ts` to `const acceptable = true`, stalled, and was killed. The mutation stayed. The ordinary suite stayed green on the mutated tree, so the only thing between that tree and a commit was somebody noticing.

The protocol that would have prevented it already existed, written down: clone, mutate the clone, prove, destroy, re-check. It was prose. A worker that crashes does not execute prose.

Two smaller versions of the same gap were already in the repository. `runIsolatedControl` in `src/verify/engine.ts` did the right thing — `mkdtemp`, `cp` excluding `.git`, a hand-written prefix check on the perturbation path — but it did it privately, for one caller, and ended in `rm(...).catch(() => undefined)`, so a derivative that survived cleanup was indistinguishable from one that did not. Lesson 0002 had already named the destination: *this pattern should become a shared Workspace/Sandbox primitive*.

## Decision

### D1. The invariant is physical, not procedural

> A falsifier, mutation test, negative control, or proof operation must be physically incapable of leaving modified bytes in the authoritative candidate.

"Physically" rules out the obvious design. A `finally` that restores the file is not a boundary: SIGKILL does not run `finally`, and neither does a stalled model. Anything whose safety depends on the proof behaving is compliance wearing a boundary's clothes.

`src/disposable.ts` carries the invariant with five mechanisms, each of which holds when the caller is careless, crashed, or hostile:

1. **The candidate is not addressable.** `runDisposableProof` hands the mutation and the proof a `DisposableDerivative` and nothing else. The candidate's path is never passed to either callback, and the only write API resolves through `DisposableDerivative.resolve`, which refuses any path landing outside the derivative root.
2. **The derivative is provably elsewhere.** `assertDerivativeIsOutside` realpaths both roots and refuses containment in either direction. Realpath rather than string comparison, because one symlink defeats the string version and that is the trick nobody catches in review.
3. **A crash cannot write what was never writable.** Because 1 and 2 hold for the whole lifetime of the proof, killing the process at any instant leaves the candidate untouched: no code path to it ever existed. What a crash *can* leave is an orphaned derivative, so every derivative writes a lease naming its owner pid **before its first byte exists**, and `sweepAbandoned()` reclaims the ones whose owner is gone.
4. **The conclusion fails closed.** Identity is pinned before and recomputed after, and a receipt that cannot prove equality is `invalidated`.
5. **The derivative's own symlinks are proven contained.** Candidate link target strings are copied verbatim, then every symlink must be witnessed by the kernel to resolve inside the derivative root. Absolute, broken, cyclic, or escaping links refuse derivation rather than being guessed safe. ADR 0022 owns the exact link semantics and falsifiers.

The shipped guarantee is therefore: **the candidate is unchanged, or the proof does not count.**

### D2. Identity is three facts, and none of them is a timestamp

`CandidateIdentity` records `HEAD`, `HEAD^{tree}`, and a content digest of the execution root. Each is blind to something the others see, and the RH-14 mutation was invisible to two of them: an uncommitted edit moves neither `HEAD` nor its tree. Only the content digest saw it.

"I observed it and did not touch it" is not identity, and neither is an mtime. Both are the assertion this ADR exists to stop accepting.

`digestScope` is not compared separately, because the aggregate digest binds the scope — a second comparison over the same fact could only ever disagree with the first.

### D3. An invalidated receipt has no result to read

`DisposableProofReceipt<T>` is a discriminated union, not one shape with a status field. On the `invalidated` branch there is no `result` property at all.

Issue #63 asks that a stale proof "be invalidated, not reported". A status flag would have left the value sitting next to the flag, one careless destructure away from being reported anyway. `requireProven()` exists for callers who want an exception, so that "I forgot to check the outcome" cannot be spelled the same way as "the proof held".

### D4. A derivative that survives cleanup fails the proof closed

If the derivative cannot be fully destroyed, the outcome is `invalidated` with `cleanup-failed`, and `residualPath` names where the surviving bytes are.

This is the case that deserved a deliberate answer, because the candidate is provably intact on this path — only a temp directory is left over. Refusing anyway, for three reasons:

- A surviving derivative **is a mutated copy of the candidate**. That is the object #63 is about. Leaving one on disk while reporting `proven` reintroduces the class of defect one level out: a later run, a path collision, or an operator who `cd`s into it.
- A cleanup that will not complete is usually a symptom, not an inconvenience. The derivative is not where we think it is, or something still holds it open and may still be writing to it. None of those license a conclusion.
- The machinery's own postcondition is "derivative destroyed". Reporting `proven` while its own postcondition failed is exactly the compliance-as-safety this ADR rejects.

The receipt reports **both** halves honestly: `candidateDifferences: []` proves the candidate is intact, and the outcome still refuses. Fail-closed here costs a re-run; the alternative costs the invariant.

### D5. Verify's negative control is the first consumer

`runIsolatedControl` now creates its perturbed copy through `TempDirectoryDerivativeFactory` and applies the perturbation through `DisposableDerivative.mutate`, so the escape check and the residue check are the shared ones. Its `rm(...).catch(() => undefined)` is gone: a destroy that fails now throws onto the caller's existing error path, so the control becomes `error` rather than `pass`.

A seam with no consumer is a library, not machinery. This is the smallest honest consumer available without redesigning the verifier, which was explicitly out of scope.

`scripts/check-guard-falsifiability.mjs` is the second consumer: guard mutations were still made in a hand-staged copy, which is exactly the operation this ADR says may not be written per caller. Every guard removal now happens inside a derivative under `runDisposableProof`, so an invalidated proof retires the falsifier's conclusion instead of reporting it. See ADR 0016.

## Amendment: ADR 0022 adds symlink containment as mechanism 5

ADR 0022 tightens D1 without changing D2 through D5. `TempDirectoryDerivativeFactory` may accept a symlink-bearing candidate only when the copy preserves every link target string verbatim and the kernel proves each link resolves inside the derivative root. Absolute, broken, cyclic, and escaping links refuse derivation with a typed error naming the offending link.

This amendment closes the availability gap found in #72 without weakening the physical invariant. The previous copy behavior rewrote relative symlinks into absolute paths back into the source tree; the digest gate detected that drift and failed closed, which kept the candidate safe but made every symlink-bearing candidate underivable. ADR 0022 is the authority for the exact containment witness, refusal behavior, and eight executed symlink falsifiers.

## Alternatives considered

**OS containment (`SandboxLauncher`) as the boundary.** The strongest available mechanism, and it is already in the repository — but `MacosSandboxExecLauncher` is the only launcher, CI runs Linux, and `requireSandbox` fails closed on a host with none. Containment would have made the invariant hold only on one developer's laptop. It composes with this design rather than replacing it: an out-of-process proof can be wrapped, and the five mechanisms above still hold when it is not.

**`git worktree add` for the derivative.** Rejected. A worktree writes into the candidate repository's shared `.git` on creation and removal, and commits from it land objects in the shared store. "Disposable" would have meant "disposable except for the parts that are not".

**Restore-on-exit handlers.** Rejected, and named here because it is what everyone reaches for first. `process.on("exit")` does not run under SIGKILL, and a stalled worker never reaches it. The reproduction for #63 is exactly this handler, registered and never fired.

**Keeping isolation private to Verify.** Rejected by Lesson 0002 and by #63. Isolation written per caller is isolation written correctly by whichever caller remembered.

## What this does not do

- It does not stop a **concurrent actor** from changing the candidate. Nothing at this layer can. It detects the change and refuses the proof, which is the honest available answer.
- It does not sweep on startup. `sweepAbandoned()` is exported and called by tests; wiring it into a supervisor's boot path is a separate decision about where a supervisor lives.
- It does not bound how long a derivative may live. A live owner's derivative is never reclaimed, so a wedged process leaves litter until it dies. That is deliberate: the alternative failure mode is deleting a running proof's workspace.
- It does not confine reads. A proof can read the candidate if it knows where to look. Reads cannot violate the invariant, which is about bytes written.

## References

- `src/disposable.ts`, `adapters/git/candidate-identity.ts`, `src/verify/engine.ts`, `scripts/check-guard-falsifiability.mjs`
- `test/disposable-proof.test.ts`, `test/disposable-proof-kill.test.ts`, `test/fixtures/disposable-proof-child.ts`
- `scripts/guard-manifest.json` — the falsifiable guard manifest
- Issue #63, Issue #72, Lesson 0002, ADR 0013, ADR 0017, ADR 0022
