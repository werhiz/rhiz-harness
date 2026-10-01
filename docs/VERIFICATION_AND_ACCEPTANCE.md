# Verification and Acceptance

Status: current reader guide. Exact verification behavior lives in `src/verify.ts`, `src/verify/`, schemas, tests, and accepted ADRs.

## Three different facts

Rhiz treats these as separate lifecycle events:

```text
worker finished
verification passed
Work accepted
```

They have different actors, evidence, and authority.

A worker completion report says an Attempt ended. Verification says independent checks support specified claims about an exact artifact. Acceptance says a valid `work.accepted` decision event became organizational state through Board.

## Exact-target verification

Verify captures a `VerificationTarget` that identifies the exact workspace state under examination. Current target identity includes workspace identity, URI, exact HEAD, a byte-sensitive digest, and deterministic changed paths.

The target is snapshotted around verification checks. Drift during proof fails verification.

This prevents proof from floating from one candidate to another during a verification run.

## Verification plans

A `VerificationPlan` is bound to one Work identity and contract revision. It declares explicit checks and the criteria or evidence requirements each check covers.

A required acceptance criterion or evidence requirement cannot disappear because a worker omitted it from a summary.

Checks execute through a `VerifierProvider`. Verify currently requires providers to declare deterministic, read-only behavior and the evidence kinds they produce.

## Independent verification

When `verificationPolicy.independentActor` is true, the actor that verifies must remain independent from the actor that executed the Work under the policy's rules.

Crew also excludes direct SHIP dependency workers from REVIEW selection. Attempt lease transfer preserves prior executor provenance, so handing execution to a successor does not erase the fact that an earlier actor worked on the candidate.

## Negative controls

A verifier can appear green while proving nothing. Examples include:

- an always-successful command;
- a test suite with no assertions;
- a deleted test command;
- a check pointed at the wrong file.

Rhiz supports negative controls to make proof falsifiable.

A control declares a perturbation against a disposable derivative of the target. The verifier must report failure on that known-bad derivative. If it still passes, the check did not demonstrate discriminatory power.

The canonical candidate is rechecked after the control so the falsifier cannot contaminate the artifact being verified.

## Evidence requirements

A verification check can produce evidence bound to criteria and required evidence entries.

Evidence carries type, identity, and optional URI/digest information. The receipt records which requirements were satisfied and by what checks.

Artifact identity proves which artifact was examined. It does not by itself satisfy a behavioral requirement merely because `artifact-identity` is an allowed evidence kind.

## Falsifiability exemptions

Some required criteria cannot be sensibly proven with the current negative-control mechanism. The schema supports named exemption reasons:

```text
external-receipt
static-analysis
browser-observation
human-judgment
```

An exemption is per criterion, includes justification, and its `authorizedBy` actor must declare `kind: "human"` for the schema to accept it.

That actor kind is a self-declared audit label. The schema does not authenticate the person behind it. A product surface that allows creation of exemptions must enforce the real identity and permission boundary before recording that actor claim.

Exemptions remain visible in the receipt. They waive the relevant falsifiability requirement where the contract allows it. They do not turn missing technical evidence into a technical fact that was proven.

If every required criterion is exempted, the result is an attestation rather than falsifiable verification. Board requires an independent passing review before such a result can reach ready.

## Board ready

When the required checks pass against the exact candidate and other lifecycle preconditions are satisfied, Board may become `ready`.

Ready means:

- execution finished;
- required current-revision verification evidence passed;
- required review/attestation conditions passed;
- no open decision or active lifecycle blocks the path;
- the Work is eligible for an acceptance decision event.

Ready does not mean accepted.

## Acceptance

Current Board acceptance enforces two important classes of precondition:

1. `acceptanceReadiness(board)` must pass for the current Work revision; and
2. an actor that has ever executed the Work cannot accept it.

Board does **not** currently authenticate actor identity from `ActorRef`, and it does not currently consult a separate organization permission registry before projecting `work.accepted`. `ActorRef.kind = "human"` is audit metadata, not proof of human identity or permission.

The current repository Work runner exposes no acceptance command and deliberately stops at `ready` with `accepted: false`.

A product or integration that exposes acceptance must therefore authenticate the decision-maker, apply the organization's permission policy, and only then emit the acceptance event. If the accepted surface can mutate or select a candidate after verification, that surface must also ensure it is acting on the intended verified artifact rather than assuming Board rechecks a live workspace for it.

The accepted event records the organizational state transition. Replaying the Ledger reconstructs that accepted state and the actor claim recorded on the event.

## Repository runner behavior

The current repository Work runner demonstrates the separation directly:

```text
Crew execution
-> candidate preservation
-> independent local-command verification
-> verified candidate ref
-> integration checkpoint
-> Ledger close and reopen
-> Board replay = ready
-> receipt board.accepted = false
```

The runner intentionally does not push, merge, or accept. Those operations require separate product/authority paths.

## Review

Review is independent judgment over artifacts or evidence. `REVIEW` is a Work type, not a synonym for automated verification.

A WorkContract may set `reviewRequired`. Review can contribute findings and recommendations while Board acceptance remains a separate decision event.

## When proof expires

Any condition that breaks the binding between evidence and the artifact a product intends to act on requires fresh verification or an explicit proof-preserving identity check. Examples include:

- candidate HEAD changes;
- workspace digest changes;
- contract revision changes in a way that affects the claim;
- required evidence becomes stale under the governing policy;
- the candidate selected for a later action is not the target that was verified.

The current Verify engine detects drift around its own checks. A later acceptance/publish/merge surface must enforce freshness for its own action boundary.

The safe default is re-verify rather than infer that old proof still applies.

## Design principle

The purpose of verification is to make success independently checkable.

The purpose of acceptance is to preserve a separate organizational decision. Current Board code proves readiness and executor separation; authenticated organizational authority belongs at the product/integration boundary that emits the event.
