# ADR 0006: Exact-target independent verification

Status: accepted for Verify v1

## Context

Crew v0 can execute bounded Work in owned workspaces and leave each successful mission at Board state `verifying`. A Worker report, test command, or reviewer statement can still be misleading when it refers to a different revision, runs against a changed workspace, emits unsupported evidence, or certifies its own execution.

## Decision

1. Verification targets one exact workspace identity, HEAD, digest, and changed-path set.
2. The target is re-snapshotted before and after every verifier check.
3. Verification actors must be independent of every execution actor in the Work stream.
4. Verify v1 accepts only deterministic, read-only VerifierProviders.
5. Required acceptance criteria and evidence requirements must be covered by explicit primary checks.
6. A passing check must emit evidence and every evidence kind must be declared by its provider.
7. Negative controls exercise the same provider as a primary check, participate in overall pass/fail, and cannot directly satisfy Work requirements.
8. Verification emits ordinary `verification.started` and `verification.result` events into the existing Ledger.
9. Exact target identity is persisted as `artifact-identity` evidence on verification events and receipts.
10. Passing verification moves Board state to `ready` or `reviewing`; it never accepts Work.
11. Acceptance uses a separate helper that rechecks the exact target, canonical Work revision, canonical verification receipt, and Board readiness immediately before appending `work.accepted`.
12. The first deterministic adapter executes explicit argv commands without a shell and records bounded digest-addressed output.

## Consequences

- A test result cannot silently certify a different workspace.
- Verification cannot pass when a verifier mutates its target.
- Execution workers cannot self-certify.
- New verifiers can carry explicit negative controls against vacuous success.
- Acceptance remains an authorized organizational decision.
- Full evidence-object persistence and Board-native artifact invalidation remain later work, while v1 receipts and acceptance protect the current end-to-end path.
