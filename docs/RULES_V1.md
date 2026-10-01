# Rules v1

## Purpose

Rules are evidence-backed operating instructions selected for relevant Work.

The portable Harness owns the **Rule contract and deterministic selection semantics**. A consuming organization owns its organization-specific rule catalog. Rhiz Protocol may therefore supply Rhiz-specific Rules without becoming a dependency of the standalone Harness.

This closes the missing seam between Context and Refiner:

```text
Evidence / accepted learning
        ↓
Refiner proposal
        ↓ review + promotion
organization Rule catalog
        ↓ deterministic selection
ContextPack Rule fragments
        ↓
Worker execution
        ↓
Outcome / benchmark evidence
```

## One owner per responsibility

| Responsibility | Owner |
| --- | --- |
| Rule schema and selector | Rhiz Harness `src/rules.ts` |
| Organization-specific rule contents | consuming organization/plugin |
| Context representation of selected rules | Context |
| Proposal to create/change a rule | Refiner |
| Mechanical enforcement | Guard or another named deterministic mechanism |
| Evidence that the mechanism is active for this execution | execution environment / Guard adapter |
| Evidence that a rule helped or hurt | Ledger + Benchmark |

A Rule is not itself authority to mutate Work, accept Work, or broaden a WorkContract.

## Binding modes

### `mechanized`

The Rule declares that the behavior can be enforced outside prompt compliance by a named `guardId` or equivalent deterministic mechanism.

That declaration is **not proof that the mechanism is active**. Selection receives the guard ids proven active for the current execution environment. A mechanized Rule is excluded from model Context only when its named guard appears in that active set. If the guard is missing, stale, misspelled, unavailable on this host, or simply not proven active, the Rule remains in Context and is reported under `inactiveMechanizedRuleIds`.

This is fail-closed behavior: failure to prove mechanization costs prompt tokens rather than silently dropping a hard instruction.

A caller may explicitly include even an actively mechanized Rule when the worker needs it for explanation, planning, or a benchmark control. The selection result continues to record that the guard was active.

### `injected`

The behavior cannot yet be fully enforced mechanically and should be supplied to the worker as Context when relevant.

### `graded`

The behavior requires judgment after the work. The Rule may be supplied to the worker, while independent REVIEW or Verify remains responsible for deciding whether the output met the bar.

A graded Rule is never represented as mechanically enforced merely because a model was instructed to follow it.

## Selection semantics

Selection is deterministic and bounded.

A Rule may constrain itself by:

- task class;
- repository path prefix;
- both;
- neither, only when it is a global hard invariant.

When both task and path constraints are present, **both must match**.

Applicable Rules are ordered by:

1. severity: `hard` → `strong` → `preference`;
2. specificity: task+path → one selector → global;
3. newer Rule revision;
4. locale-independent Rule id code-unit order.

The caller declares a maximum number of Rules supplied to Context. Omitted applicable Rules are named in the selection result so context pressure is observable rather than silent.

Path matching deliberately uses repository-relative literal prefixes in v1. Globs, absolute paths, backslashes, and `..` traversal are refused rather than interpreted differently by different hosts.

## Mechanization evidence

`RuleSelectionRequest.activeGuardIds` is the current execution environment's proof input. It is intentionally separate from the Rule catalog.

The catalog answers:

> Which mechanism is supposed to enforce this Rule?

The execution environment answers:

> Which mechanisms are actually active here?

Only their intersection earns prompt suppression.

The selector does not discover guards by filesystem convention, import presence, or name. A later Guard registry may supply `activeGuardIds` automatically. Until then, an absent active set means no mechanized Rule is trusted as mechanically bound.

## Rule identity and revision

`id` names a durable Rule concept. `revision` changes when the Rule's meaning or applicability changes.

Selection records both. A benchmark or replay can therefore answer which version of which Rule was supplied to a worker.

A future durable Rule registry may add supersession and lifecycle events. V1 does not require a global mutable Rule database in the portable core.

## Relationship to the earlier Continual Harness

Rhiz Protocol currently contains an older `harness/` rule corpus and compiler that provides real internal value. It is an **organization-specific predecessor**, not a second Harness product.

Migration direction:

```text
rhizprotocol/harness/rules
        ↓ translate + preserve evidence
Rhiz Protocol Rule catalog/plugin
        ↓ portable Rule contract
@werhiz/rhiz-harness
        ↓ selected RuleInput[]
ContextPack
```

Do not bulk-copy the old compiler/runtime architecture into this repository. Preserve useful rule content, evidence, mechanized guard links, and selection lessons while letting the standalone Harness own the portable contract.

The old root `harness/` in Rhiz Protocol may be retired only after:

1. its current Rules are inventoried;
2. active organization-specific Rules have a new catalog owner;
3. generated instruction/CI obligations have equivalent or deliberately retired consumers;
4. Rhiz Protocol consumes the standalone Rules contract;
5. the old compiler/select/audit paths have no remaining live callers.

## Refiner relationship

Refiner already supports `kind: "rule"` proposals. Promotion should eventually produce or amend a Rule catalog entry through a reviewed, reversible path.

Refiner does not silently install permanent Rules. A promoted lesson remains attributable to the Work and Evidence that earned it.

## Benchmark relationship

Rules should be measurable where practical.

Useful comparisons include:

```text
same WorkContract
same base artifact
same worker/model

without selected Rule
vs
with selected Rule
```

Measure verified completion, interventions, repairs, cost, context size, and downstream defects. A Rule that repeatedly adds tokens without improving outcomes should be narrowed or retired.

## Acceptance for Rules v1

Rules v1 is complete when:

- a typed portable Rule catalog exists;
- invalid/global/fake-mechanized Rule shapes fail closed;
- task/path selection is deterministic across catalog order and host locale;
- a mechanized Rule is suppressed only when its named guard is proven active;
- unproven mechanized Rules remain in Context;
- selection emits `RuleInput[]` accepted directly by Context;
- a consuming organization can supply Rules without the portable core importing that organization.
