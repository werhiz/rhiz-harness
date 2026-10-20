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
   model family or process than the executor. Both the review start and result events must bind
   the repository, candidate commit SHA, candidate tree and contract revision. The Board compares
   those fields with the accepted integration candidate and the verification/CI evidence at
   admission. A changed integration head invalidates the review even when the contract revision
   is unchanged. Existing review events without this binding cannot authorize policy acceptance;
   a passing opinion or a diff reference alone is insufficient.
4. **CI.** It is green on the exact head SHA.
5. **Scope.** The Work's write scope is inside the delegation's globs, and the daily cap has not
   been reached.
6. **Budget.** Paid inference stayed at $0 with no cloud fallback, unless the delegation names a
   budget.

A missing fact refuses acceptance. It never defaults to pass.

The daily cap is enforced through one durable, repository-wide acceptance journal at the trusted
Board persistence boundary, rather than by scanning separate Work ledgers. Before recording a
policy acceptance, the Board atomically compares the delegation identity/version, policy,
repository, UTC day and remaining cap, then durably reserves one slot. The transaction returns a
unique reservation bound to the Work id and exact candidate SHA. Competing processes serialize
through that same journal; a provider that cannot guarantee crash-safe compare-and-reserve must
refuse policy acceptance. Workers cannot write or reset the journal through their write scope.

The reservation is persisted before the Work's acceptance event, which names it. Retrying the
same Work/candidate reuses its reservation and cannot consume a second slot or append a second
acceptance. After a crash, recovery reconciles the reservation with the Work ledger before
continuing. An unresolved reservation still consumes the cap; it is never released merely on a
timeout or process death. Delegation replacement, expiry, revocation and PAUSED are rechecked at
admission. A reservation does not outlive or widen that authority.

### D4. Landing requires a concrete repository adapter

Acceptance does not merge. This Harness checkout currently has no canonical landing command;
the repository Work runner explicitly leaves integration to its owner. Implementation of this
proposal therefore requires a typed landing adapter behind the existing repository integration
boundary. Until a target repository has a configured and verified adapter, automatic landing is
unavailable and the accepted Work stays explicitly awaiting integration.

The adapter receives the repository identity, PR identity, expected base and candidate SHA, the
bound passing review and verification evidence, and exact-head required CI check identities. It
must reread those facts, refuse stale or missing evidence, use the target repository's protected
merge path pinned to the candidate SHA, and independently read back the merged PR and resulting
default-branch commit. An uncertain response is UNKNOWN and must be reconciled before retrying.
The receipt preserves the input candidate, actual merged head and merge commit; acceptance alone
cannot produce that receipt.

For `werhiz/rhizprotocol`, the existing integration owner is its committed `scripts/land.mts`
controller and the exact-head `rhiz/land-verdict` it produces. For `werhiz/rhiz-harness`, the adapter
must be implemented and proven against this repository's required Kernel CI checks before
activation. No nonexistent Harness tool is assumed. The policy gets no force-push,
branch-protection bypass or direct write to the default branch.

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
- A passing review for candidate A cannot authorize candidate B, even at the same contract revision.
- With one daily slot remaining, two concurrent Work acceptances admit at most one; crash/retry
  between reservation and acceptance neither restores the slot nor duplicates acceptance.
- An expired or revoked delegation cannot admit an already reserved acceptance.
- Missing landing adapter, stale review/CI identity and uncertain merge readback cannot report landed.
- A human actor's acceptance path is unchanged.

## Rollback

Delete the delegation record. Existing accepted events stay in the append-only Ledger with their
acceptor kind and can be excluded from Router evidence by kind.
