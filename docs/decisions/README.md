# Architecture Decision Records

This directory is the complete decision record. An ADR that is not listed below is not authority.

Authority order for any conflict:

1. `../RHIZ_HARNESS_CONSTITUTION.md`
2. current executable contracts and safety boundaries (`../KERNEL_0_1.md`, `../SYSTEM_BOUNDARIES.md`,
   `../VOCABULARY.md`, and the shipped code)
3. the relevant ADR
4. design documents and stream write-ups

## Current record

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-executable-contracts-and-board-replay.md) | Runtime schemas and replayable Board state | accepted |
| [0002](0002-dsh-sdk-first-host-adapter.md) | DSH SDK is the first concrete HostAdapter boundary | accepted |
| [0003](0003-worker-catalog-and-deterministic-selection.md) | Portable Worker catalog and deterministic selection | accepted |
| [0004](0004-dsh-product-worker-routes.md) | Codex and Claude as direct DSH-backed Rhiz workers | accepted |
| [0005](0005-crew-missions-and-workspace-ownership.md) | Crew missions and explicit workspace ownership | accepted |
| [0006](0006-exact-target-independent-verification.md) | Exact-target independent verification | accepted |
| [0007](0007-durable-hash-chained-ledger.md) | Durable hash-chained Ledger and crash recovery | accepted |
| [0008](0008-policy-oracle.md) | Policy Oracle architecture | accepted |
| [0009](0009-refiner.md) | Refiner — proposal/accept/reject/promote lifecycle | accepted |
| [0010](0010-context.md) | Context — typed pack with measurable composition | accepted |
| [0011](0011-router.md) | Router v0.1 — evidence-based worker/model selection | accepted |
| [0012](0012-verifier-and-dormant-containment.md) | Verifier execution containment and checked dormancy | accepted |
| [0013](0013-execution-integrity.md) | Execution integrity: bind, deny, identify, falsify | accepted |
| [0014](0014-developer-experience-command-architecture.md) | Developer Experience command architecture | superseded by 0015 |
| [0015](0015-inline-cli-and-proof-first-developer-experience.md) | Inline CLI and proof-first Developer Experience | accepted |
| [0016](0016-guard-falsifiability.md) | Every declared guard must be falsifiable | accepted |
| [0017](0017-os-containment-for-the-verifier.md) | OS containment for the verifier path | accepted |
| [0018](0018-falsifiability-and-named-exemptions.md) | Falsifiability and named exemptions | accepted |
| [0019](0019-disposable-proof-lifecycle.md) | Proof operations run in a disposable derivative | accepted |
| [0020](0020-os-containment-for-workers.md) | OS containment for the worker path | accepted |
| [0021](0021-proof-admissibility.md) | Admissibility is derived from property, attested environment, executed falsifier, and exact candidate | proposed |
| [0022](0022-symlink-representation-in-disposable-derivatives.md) | Symlink representation in disposable derivatives | accepted |
| [0023](0023-calibrated-integration-horizon.md) | The integration horizon is calibrated, enforced, and cannot forgive missing durability | proposed |
| [0024](0024-review-convergence-allowance.md) | A change under open review may answer its review past the size horizon | proposed |
| [0025](0025-factory-runtime-observer-and-replay.md) | Factory Runtime v1 starts with the Observer and historical replay | proposed |

Lessons derived from real work live in `../lessons/`. Independent reviews and integration analyses
live in `../reviews/`. Both record evidence. Either becomes authority only when an ADR, Rule, or
Guard adopts it.

## Numbering discipline

Parallel streams numbered ADRs independently against a `main` that had received none of them. That
produced four colliding numbers on `main` at once: two 0008s, two 0009s, two 0013s, and two Lesson
0003s. The rules below exist so it does not recur.

1. **A number is claimed from this index on `main`, not from a branch.** The next number is one past
   the highest row here. A number that looks free on your branch is not free.
2. **Collisions resolve by authorship order.** The ADR written first keeps the number; the later one
   moves. That is how 0008, 0009, and 0013 were resolved, and why the Developer Experience ADRs are
   at 0014 and 0015.
3. **One number, one document, forever.** A number is never reused, including after an ADR is
   superseded or withdrawn.
4. **An ADR lands with the work it decides**, so the record cannot drift from the system.
5. **Superseding is explicit.** A superseded ADR keeps its number and its file, gains a
   `Status: superseded by NNNN` header, and stays in this table so the reasoning survives.
6. **This index is updated in the same commit as the ADR.** An ADR the record cannot see is not a
   decision the organization made.
