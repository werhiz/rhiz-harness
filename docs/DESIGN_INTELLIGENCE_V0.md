# Design Intelligence v0

Status: portable Harness capability, first dogfood slice

## Purpose

Design Intelligence compounds design judgment without creating one global visual style.

- Rhiz first-party products may share Rhiz expression.
- Independent brands own their visual systems.
- Universal craft may inform any surface.
- Local expression becomes portable only through reviewed abstraction.

This module adds no database, daemon, renderer, network path, model call, or package dependency. It reuses Harness Board acceptance, Refiner promotion, EventLedger evidence, and existing product-owned design policy.

## Four scopes

- `universal`: caller-governed durable craft knowledge. `signature` is excluded because signatures are local expression.
- `rhiz-first-party`: Rhiz-specific expression and interaction learning.
- `brand`: expression local to one explicit `brandId`.
- `abstract`: a reviewed portable principle with local expression removed.

Direct brand-to-brand promotion is forbidden. Rhiz expression cannot enter an independent brand. Local learning can move only to `abstract`.

## Brand genome

`BrandGenome` is compact model context, not persistence and not a template. V0 stores only worldview, audience, principles, signature moves, avoidances, and references. Product repositories remain authoritative for real brand assets and design systems.

## Product-owned taste policy

The portable kernel does not own an anti-slop list. `reviewDesignSignals()` receives caller-governed suspicions. This keeps product taste definitions in their product authority and avoids a second global aesthetic registry.

## Exact receipt attestation

A receipt saying `accepted` has no authority by itself.

An accepted `DesignReceipt` contains the exact local learning candidate: id, kind, statement, expression refs, target, candidate, evidence, rationale, and receipt metadata. Before `work.accepted`, the caller derives two deterministic evidence refs with `designReceiptEvidenceRefs()`:

1. a SHA-256 digest of the complete typed receipt;
2. a SHA-256 digest of the exact scoped local-learning claim.

The exact `work.accepted` event must carry both refs. `learningFromAcceptedReceipt()` then replays the Work, verifies both attestations, projects Board through the named event, requires valid Board acceptance, and derives learning only from the candidate inside the attested receipt.

A different candidate, target, statement, expression, or receipt cannot borrow another accepted event. A later deserialized local-learning object must still match its accepted learning digest before abstraction or prompt selection.

The receipt accepts at most 62 explicit evidence refs so the derived receipt and acceptance refs still fit the 64-ref local-learning bound. The learning-evidence identifier is hash-derived so maximum-length valid receipt ids remain valid Harness evidence.

Rejected receipts remain evidence and cannot create successful learning.

## Refiner-bound abstraction

Local expression does not become global because a caller removed `expressionRefs`.

The reviewed abstraction payload carries both:

- the exact scoped local-learning claim; and
- the exact `DesignAcceptanceRef` that attested that claim.

This lets later replay prove that the abstraction's named source was a real Board-accepted local lesson rather than an arbitrary source ID.

The portable path is:

```text
Board-accepted local learning
-> revalidate exact source acceptance + learning digest
-> designAbstractionDraftPayload()
-> Refiner lesson-fixture proposal containing the accepted source claim
-> replay existing Refiner guards
-> prove referenced ledger evidence existed before proposal
-> independent human/verifier acceptance
-> acceptance remains current through promotion
-> promotion while reversal window is still open
-> human/verifier promotion to design-intelligence:abstract
-> portable abstract learning
```

The abstraction gate fails closed when:

- source acceptance is missing or invalid;
- source learning changed after acceptance;
- the reviewed source claim does not hash to its accepted learning digest;
- the proposal id appears more than once;
- the proposal event actor differs from `proposal.proposedBy`;
- existing Refiner guards fail;
- proposal evidence ids are duplicated, missing, exceed 62 refs, or were not durable before proposal;
- the latest decision before promotion is not `accepted`;
- the proposer accepts its own proposal;
- promotion is missing, duplicated, targets another surface, or is irreversible;
- the durable promotion timestamp is at or after `reversibleUntil`;
- a contradictory accept/reject decision appears after promotion.

The reviewed proposal owns the portable wording. A `signature` cannot itself become abstract learning.

Abstract learning stores the source acceptance reference, but not the source's entire evidence list. Proposal evidence plus accepted/promoted event IDs remain bounded to 64 refs, reducing duplicated context while retaining the chain back to the source receipt.

## Every learned item is revalidated when consumed

A typed learning object is not trusted merely because its schema parses.

`selectDesignContext()` is ledger-backed:

- Rhiz-local and brand-local lessons must still match their accepted learning digest and replay to valid Board acceptance.
- Abstract lessons must replay the exact reviewed source acceptance and the complete Refiner lifecycle.
- A fabricated local lesson, fabricated abstract object, changed source claim, later rejection, stale promotion, or expired-at-promotion abstraction fails before entering model context.

The context filter remains semantically small:

```text
Rhiz target  = universal + validated abstract + validated Rhiz local
Brand target = universal + validated abstract + validated matching brand local
```

Unrelated brand histories never enter the prompt.

## Token and complexity discipline

Deterministic code owns scope, evidence identity, acceptance, promotion, current-validity checks, and cross-brand leakage prevention. Models remain useful for ambiguity, composition, critique, and the reviewed wording of a possible abstraction.

The kernel intentionally reuses Board, Refiner, EventLedger, and product-owned policy instead of building another design lifecycle. If repeated design-context loads later make ledger replay materially expensive, optimize the projection/cache behind this contract rather than weakening the validation boundary.

## V0 proves

- independent brand genomes without another persistence authority;
- smallest-sufficient design context;
- deterministic cross-brand isolation;
- product-injected anti-AI review policy;
- exact receipt-to-Board acceptance binding;
- local-learning tamper detection at abstraction and context selection;
- exact accepted-source binding inside reviewed abstractions;
- replay-safe Refiner proposal validation;
- durable bounded proposal-evidence resolution;
- independent, reversible abstraction promotion;
- portable-learning revalidation at context consumption;
- revocation after promotion prevents later global selection;
- provenance-preserving reuse without local visual expression.

V0 deliberately does not implement visual scoring, screenshot analysis, rendering, token generation, Figma synchronization, a design database, or automatic universal promotion.

## Next dogfood

1. Use the existing Rhiz Operating Surface (`/surface`) as the first-party case.
2. Use one independent venture as the sovereign-brand case.

Do not create a separate product, route, renderer, or architecture called `Rhiz World` for this proof. First-party dogfood must preserve the Operating Surface's existing projection, Oracle runtime ownership, Context authority, approval semantics, reconstruction truth, object identity, and permission boundaries.

Success means both become more distinctive while sharing only design intelligence that survived the governed learning path.
