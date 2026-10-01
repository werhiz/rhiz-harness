# Lesson 0005: Public research stays evidence until promotion

Status: **Candidate lesson — Level 2**

Evidence: Rhiz Protocol #3314 (private), following the X social-graph audit in Rhiz Protocol #3313 (private) and independent review of the first implementation in Rhiz Protocol #3315 (private).

## Observation

A real Customer Zero relationship-audit task required the organization to combine founder judgment, public social activity, official organization pages, third-party investment records, existing graph evidence, and identity-resolution checks.

The research was useful immediately, but the first execution path risked leaving the synthesis only in an agent conversation. That would preserve the answer while losing the durable chain that explains which claims came from which sources, which statements were the founder's own judgment, which conclusions were inference, and which questions remained unknown.

Independent review of the first durable implementation exposed two additional failure modes. The new contract had been authored in an organization-side Python tool even though TypeScript owned new contract authority, and the first provenance shape identified an `owner_statement` without preserving the asserting Person, governing Context, or inference actor/time. A provenance-aware payload can therefore still be unsafe if it is authored in the wrong authority layer or cannot answer **who asserted/generated this, when, and under what Context?**

## Finding

External research is an **Observation/Evidence source**, not canonical organizational state.

A useful relationship or market-context workflow therefore needs to preserve at least four classes before any projection or durable decision:

1. human/owner judgment;
2. attributable external evidence or source claims;
3. inference grounded in explicit evidence references;
4. unresolved gaps/unknowns.

Each durable judgment, observation, inference, and recommendation also needs enough provenance to reconstruct its actor, governing Context, and time. Attribution such as `owner_statement` is insufficient when it does not identify the owner/actor and permission boundary.

Identity is part of the same boundary. A public handle or matching display name is evidence about a source identity. It is not sufficient authority to create or merge a canonical Person identity. A caller-supplied canonical identifier is also not proof that identity resolution occurred; readiness must come from the identity authority, not from the payload being enriched.

Authority placement matters as much as payload shape. Organization-specific adapters may gather evidence, but durable contract/authority semantics must live in the substrate that canon says owns them.

## Candidate lesson

When Work uses public research to improve organizational context, the smallest safe reusable pattern is:

```text
external source
→ attributable Evidence/Observation
→ epistemic classification
→ actor + Context + time provenance
→ grounded inference
→ unresolved gaps remain explicit
→ identity/authority verification
→ organization-specific projection
```

The Harness should make that path easier to express and preserve. It should not silently turn browser/search output into Board truth, accept a payload's identity claim as resolution proof, or require humans to restate source/actor/Context provenance after the worker has already seen it.

Verification should also ask whether a new durable contract was authored in the correct authority layer. A schema can be internally consistent and still create semantic drift if it lives beside, rather than inside, the canonical contract substrate.

## Why this belongs in Harness learning

This is a One Less Action opportunity. The clerical version of the workflow requires a human to repeatedly copy URLs, restate what was fact versus inference, identify who made each judgment, restate the governing Context, remind the worker not to merge identities, and rebuild context the next time the person appears.

The system-level opportunity is to preserve those distinctions automatically as durable evidence and selected Context while routing durable semantics to the correct authority layer.

## Promotion bar

Do **not** add a new Kernel event, EvidenceKind, canonical state field, or portable person model from this one case.

Promote this lesson only after another independent Work class demonstrates the same need and an experiment shows a concrete mechanism reduces human interventions or prevents provenance/identity/authority errors. Candidate destinations include:

- ContextPack composition/provenance;
- an external-source evidence adapter;
- evidence-kind refinement;
- a Guard preventing ungrounded promotion into canonical state;
- a Guard or review check for new durable contracts authored outside their canonical authority substrate;
- verification that every inference cites durable Evidence and every private judgment/inference retains actor + Context + time provenance.

## Falsifier

This lesson is weakened if a second real external-research workflow can preserve source attribution, human judgment, inference boundaries, actor + Context + time provenance, identity safety, correct authority placement, and later reuse using existing Harness primitives with no repeated human clerical work. In that case the problem belongs in organization-specific integration rather than portable Harness semantics.
