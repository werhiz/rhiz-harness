# ADR 0027: Delegated policy acceptance for an unattended Studio

Status: proposed

Refines `0026-operator-loop-and-acceptance-driven-learning.md` (D2: acceptance requires a human
`ActorRef`). It does not change the Constitution: §6 keeps completion, verification and acceptance
as separate events, and acceptance remains the Board's organizational decision.

## Context

On 2026-10-19 the founder decided that Rhiz Studio 01 must build unattended with its own local
models, and that any Work which passes independent verification, independent review and CI should
be accepted and landed without a person in the loop, product code included.

Today that is impossible by design. `acceptOperatorWork` refuses any actor whose `kind` is not
`human`. Every successful Factory candidate therefore waits indefinitely. The Router gets no
credit and the Refiner learns nothing from success, so the Studio cannot improve on its own.

Letting an agent act as a human would erase attribution. A worker that could accept its own output
would collapse §6. The decision is therefore to delegate, not to impersonate.

## Decision

### D1. A policy actor, delegated by a named human

Acceptance may be recorded by an `ActorRef` of the existing kind `automation` whose id is a
delegated policy, for example `policy:studio-auto-accept`. No new actor kind is introduced. Every such event carries `delegatedBy`, the human who issued the
delegation, so the Board decision stays attributable to a person.

A policy actor is not a worker, reviewer or verifier. It can never execute, verify or review the
Work it accepts.

### D2. The delegation is a root-owned record

A policy may act only while a delegation record exists under
`/Library/Application Support/RhizStudio/delegations/`. The record must be:

- owned by uid 0;
- a regular file, not group- or world-writable;
- a single hard link.

These are the same checks as the session-binding records in `STUDIO_DECISION_EVIDENCE.md`.

The record names:

- the policy id, the delegating human and the repository;
- the permitted WorkTypes and write-scope globs;
- a per-day acceptance cap;
- an expiry.

Same-uid processes, including every agent on the host, cannot create or widen it. Deleting it with
`sudo` revokes the delegation immediately. A `PAUSED` file in the Studio activation directory also
halts policy acceptance.

### D3. The gates are conjunctive and exact-candidate

Policy acceptance is admitted by the Board only when all of the following hold for the exact
candidate commit:

1. **Readiness.** `acceptanceReadiness` is true and the target check passes, exactly as in 0026 D2.
2. **Independent verification.** It passed, including every negative control.
3. **Independent review.** The latest independent review (0026 D2a) passes. Its reviewer is
   distinct from the executor, the verifier and the policy, and that review ran on a different
   model family or process than the executor.
4. **CI.** It is green on the exact head SHA.
5. **Scope.** The Work's write scope is inside the delegation's globs, and the daily cap has not
   been reached.
6. **Budget.** Paid inference stayed at $0 with no cloud fallback, unless the delegation names a
   budget.

A missing fact refuses acceptance. It never defaults to pass.

### D4. Landing uses the existing landing path

After acceptance, landing goes only through the repository's existing landing tool, which reads the
review marker at the exact SHA and requires CI. The policy gets no force-push, no branch-protection
bypass and no direct write to the default branch.

### D5. Learning

Policy-accepted Work is credited to the Router and handed to the Refiner exactly as human
acceptance is (0026). Every event records the acceptor kind, so evidence can be weighted or
excluded later. Lesson promotion keeps its existing rules; this ADR does not let the policy promote
lessons.

## Falsifiers

Each must be a test that fails without its guard:

- A delegation record that is same-uid-owned, writable, symlinked, expired, or for another repo or
  policy is refused.
- Acceptance is refused when any one D3 gate is removed: a stale SHA, a failing latest review, a
  reviewer equal to the executor, red CI, scope outside the globs, or the cap exceeded.
- A policy actor that executed, verified or reviewed the same Work is refused.
- A human actor's acceptance path is unchanged.

## Rollback

Delete the delegation record. Existing accepted events stay in the append-only Ledger with their
acceptor kind and can be excluded from Router evidence by kind.
