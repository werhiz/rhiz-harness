# Intelligence Loop

Status: current synthesis of Rules, Context, Router, Refiner, and Benchmark. Exact module behavior lives in shipped code and accepted ADRs.

## Purpose

Rhiz Harness should improve from evidence without turning model output into permanent authority.

The intelligence loop is:

```text
accepted outcomes + failures + corrections
                |
                v
             evidence
                |
       +--------+--------+
       |        |        |
       v        v        v
   Benchmark  Refiner  Router evidence
                |
                v
            proposals
                |
         reviewed promotion
                |
      +---------+----------+
      |         |          |
      v         v          v
    Rules     Guards    verification/context/routing changes
      |
      v
Context selection for future Work
```

Learning proposes. Named authorities promote.

Refiner reads one closed Work. The [Factory Observer](FACTORY_RUNTIME_V1.md) reads the population, meaning all Works and their benchmark runs, and turns patterns into proposals that carry a replay experiment. Historical replay tests a proposal on the same past Work before anyone promotes it ([ADR 0025](decisions/0025-factory-runtime-observer-and-replay.md)).

## Rules

Rules are evidence-backed operating instructions selected for relevant Work.

The portable Harness owns:

- Rule schema;
- deterministic selection semantics;
- binding-mode interpretation;
- integration with Context.

A consuming organization owns its organization-specific Rule catalog.

### Binding modes

`mechanized`
: A named deterministic mechanism can enforce the behavior. The Rule is suppressed from model Context only when that mechanism is proven active for the current execution environment.

`injected`
: The behavior is not fully mechanized and should be supplied to the worker as Context when relevant.

`graded`
: The behavior requires judgment after execution. The Rule may be supplied to the worker while Verify or REVIEW decides whether the output met the bar.

### Selection

Rule selection is deterministic and bounded. Rules may scope to task class, repository path prefix, both, or neither when the Rule is a global hard invariant.

Ordering prioritizes:

1. severity;
2. specificity;
3. newer revision;
4. stable id order.

When context pressure omits otherwise-applicable Rules, the selection result names the omitted Rules so the loss is observable.

## Context

Context is treated as a scarce computational resource.

A `ContextPack` records the selected fragments and their cost rather than dumping all available repository and organizational state into every worker.

Current fragment classes include:

- included files;
- selected symbols;
- history;
- Rules;
- architecture documents;
- skills.

The Context module can:

- compose a deterministic pack;
- classify task type;
- select a strategy;
- enforce total and per-fragment budgets;
- apply bounded edits such as dropping or replacing fragments;
- preserve stable markers so downstream behavior can be attributed to the context that was actually supplied.

Context quality should be measured against outcomes, cost, and intervention rate.

## Tainted context

Not every byte a worker reads belongs inside its instruction channel.

Dependency worker summaries and artifact claims are model-authored or otherwise untrusted. Crew represents them as typed tainted attachments with provenance. Host adapters render them as data, separate from Work objective and authority instructions.

This pattern should guide future context engineering: preserve provenance and role, and keep untrusted data from silently becoming policy.

## Router

Router selects among eligible workers and strategies using typed capabilities and measured evidence.

Current routing concepts include:

- supported Work types;
- language and capability tags;
- context ceilings;
- cost and latency observations;
- historical attempt outcomes;
- preferred provider weighting;
- deterministic tie-breaking.

Policies can optimize for cheapest-capable, fastest-capable, highest-confidence, or balanced selection.

Router recommendations never bypass Guard, Work authority, verification, or acceptance policy.

## Refiner

Refiner turns evidence into proposed durable learning.

A proposal may target:

- Rule changes;
- Guard improvements;
- verification changes;
- context strategies;
- routing policy;
- architecture or operating lessons.

Refiner is intentionally non-self-authorizing. A model noticing a pattern does not directly install permanent organizational law.

Promotion must remain attributable to the Work and evidence that earned it.

## Benchmark

Benchmark answers whether a change made the system better.

The North Star is:

> Human interventions per independently verified successful outcome.

Supporting metrics include verified completion, repair rate, regression rate, repeat mistakes, recovery, cost, latency, context size, verification strength, blocked decisions, and acceptance latency.

Useful Rule and context experiments hold Work, base artifact, provider, and verification constant where practical, then compare outcomes with and without the candidate policy.

## One Less Action Doctrine

The intelligence loop should remove repeated clerical actions that no longer require human judgment.

Examples:

- repeated context re-pasting becomes Context selection;
- obvious worker choice becomes Router policy;
- repeated safety correction becomes a Rule or Guard;
- repeated verification command becomes a verifier profile;
- repeated recovery steps become deterministic Runtime/Crew behavior;
- repeated review learning becomes a promoted organizational Rule.

The goal is not maximum autonomous behavior. The goal is fewer unnecessary human interventions while preserving consequential human judgment.

## Promotion discipline

Before promoting a lesson, ask:

1. Is the evidence repeated or high-value enough to justify permanence?
2. Is this an instruction, a mechanical invariant, a verification criterion, a routing policy, or architecture?
3. Who canonically owns that fact?
4. Can the behavior be mechanized instead of spending context tokens?
5. What benchmark would show the promotion helped?
6. How can the change be reversed if later evidence contradicts it?

The intelligence loop compounds only when learning remains evidence-backed, bounded, and attributable.