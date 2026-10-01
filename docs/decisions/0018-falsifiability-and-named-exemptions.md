# ADR 0018: Falsifiability is required, exemptions are named and counted

Status: accepted for Verify v1.3. Closes issue #32.

## Context

ADR 0013 made a **declared** negative control impossible to satisfy dishonestly: a control must share its primary's config and falsify a perturbed copy. It did not require one to exist.

`validateVerificationPlan` enforced that every required acceptance criterion is covered by a primary check. It never enforced that the check could fail. So this plan was valid, and produced a passing receipt with Board `ready`:

```js
checks: [{ id: "primary", criterionIds: ["c1"], config: { command: "/usr/bin/true" } }]
```

The gap is between two sentences that read alike:

> a declared control cannot be satisfied dishonestly

> an always-passing verifier cannot produce a passing receipt

The first was true. The second was not, and it is the one a reader assumes.

A parallel defect existed in the authority hatch from ADR 0013. `explicitProviderAuthorizations` admitted a provider by named human exception, and the authorization reached `WorkerSelection` and stopped there. `CrewMissionReceipt` had no field for it and `task.assigned` carried `{ worker }` alone, so replay could not reconstruct that an exception had been used. Auditable at the moment of decision, unrecoverable afterwards.

## Decision

### D1. Coverage is not proof

A required criterion must be covered by a primary check that carries a negative control, or be exempted. `validateVerificationPlan` rejects the plan otherwise, with a message that names both remedies.

### D2. Exemptions are typed, named, and per-criterion

`VerificationPolicy.falsifiabilityExemptions` carries `criterionId`, a typed `reason`, a free-text `justification`, and a human `authorizedBy`.

The reason is an enum of four (`external-receipt`, `static-analysis`, `browser-observation`, `human-judgment`) rather than free text, because free text cannot be counted and a fifth category should require a schema change, which is a conversation. `authorizedBy.kind` must be `human`, enforced in a `superRefine` rather than merely typed. An exemption naming a criterion the Work does not require is a contract error.

**Why not a `requireNegativeControls` policy flag.** `WorkContractSchema` already derives the necessity of proof from criterion requiredness. A second flag over the same fact creates two answers to one question that can disagree, which Constitution §3 exists to prevent. It also has the silhouette of `GuardPolicy.denyByDefault`: a boolean that reads as a safety property, defaults differently by context, and turns out not to enforce.

**Why not require a control everywhere.** Not every criterion has an honest perturbation. Forcing one manufactures fake controls, and a fake control is worse than none because it launders the same vacuous pass through a mechanism that now looks rigorous.

### D3. The exemption is visible where acceptance is decided

Every `verification.result` event and every `VerificationReceipt` carries a `falsifiability` report: which required criteria were proven falsifiably, and which were exempted with their reason and authorizer.

This is the load-bearing half. Without it the scheme has the identical defect it was designed to avoid: an off-state invisible at the point of decision. A reader of one receipt can see "0 of 1 proven" without reading the plan.

### D4. A verification that could not fail attests, it does not verify

When every required criterion is exempted, the verification cannot carry Work to `ready` on its own. It requires a passing independent `review.result` at the same contract revision.

Not a prohibition, because the case is real: a REVIEW item whose criteria are inherently human judgment is legitimately all-exempt. What is wrong is calling it a verification and letting it accept Work with nobody signing. It reuses `verificationPolicy.reviewRequired` and the existing `review.*` vocabulary, so it adds no authority.

`isAttestationOnly` is defined once and used by both `deriveState` and `acceptanceReadiness`, because two readers of one fact are how they come to disagree.

### D5. An authority exception survives its process

`task.assigned` carries the authorization, so replay reconstructs it. `CrewMissionReceipt` carries it, so a reader sees it. Constitution §5.

## The threshold, deliberately not mechanical

D4 triggers at total exemption. That leaves a cliff: four of five criteria exempted, with the fifth proven by one trivially falsifiable check, is full mechanical acceptance with no human involved. That state is nearly the all-exempt one, and it is the shape drift takes, because nobody exempts everything in one commit.

We considered a ratio and rejected it. A threshold at eighty percent is as arbitrary as one at a hundred and harder to defend, and it would mostly teach people what number to stay under. It would also be a second authority over "is this enough proof", which is the objection that sank the policy flag.

The answer is D3 rather than a rule. Partial erosion is visible in the counts or it is visible nowhere, since the categorical rule cannot see it. This is a deliberate choice of a visible failure over a mechanical one, and it should be revisited if the counts turn out not to be read.

## What this does not do

- It does not make a control **good**. A control with a trivial perturbation against a check that ignores it satisfies D1 and proves little. D1 establishes that something could have failed, not that the right thing could have.
- It does not bound how many criteria may be exempted. See above.
- It does not surface exemptions at Crew level, only at verification and acceptance.

## References

- `src/schemas.ts`, `src/verify/schema.ts`, `src/verify/engine.ts`, `src/board.ts`, `src/crew.ts`
- `test/falsifiability.test.ts`, `scripts/guard-manifest.json`
- Issue #32, ADR 0013, ADR 0008
