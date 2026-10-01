# Execution Lifecycle

Status: current lifecycle synthesis. Exact transition rules live in shipped schemas, Board projection, Crew, Verify, Integration Controller, and accepted ADRs.

## The lifecycle

```text
intent
  |
  v
WorkContract
  |
  +--> Rules selected
  +--> Context selected
  +--> capable worker route selected
  |
  v
Crew mission
  |
  v
workspace acquired
  |
  v
Attempt starts under bounded authority
  |
  +--> Guard mediates supported native tool effects
  +--> Runtime emits observations
  +--> Ledger records durable facts
  |
  v
Attempt finishes
  |
  v
candidate identity captured
  |
  v
independent Verify
  |
  +--> exact-target checks
  +--> required evidence
  +--> negative controls / falsifiability
  |
  v
verified integration checkpoint
  |
  v
Board ready
  |
  +--> acceptance / rejection decision
  +--> park / amend / retry when policy allows
  |
  v
Outcome + durable receipt
  |
  v
benchmark + Refiner learning
```

Each arrow is a boundary. Rhiz avoids collapsing multiple meanings into one event.

## 1. Intent becomes a WorkContract

Human or organizational intent is converted into a durable contract containing objective, type, scope, authority, criteria, evidence, context, dependencies, worker policy, and verification policy.

The contract is the stable reference for downstream execution. A worker may report uncertainty or request a decision. It may not silently broaden the contract because the task looks larger than expected.

## 2. Rules and Context are selected

Relevant Rules are selected deterministically. Context composes the smallest sufficient task-specific pack within declared budgets.

A Rule may be:

- mechanized by a proven active Guard or deterministic mechanism;
- injected into Context because the mechanism is not proven active;
- graded later because the requirement needs judgment.

Failing to prove an active mechanism costs context tokens rather than silently suppressing the instruction.

## 3. A worker route is selected

Worker/provider selection is capability-aware and deterministic. Routing can use declared capabilities, Work preferences, evidence from prior outcomes, and policy.

Selection never widens Work authority. A highly capable provider still receives only the authority the Work grants.

Provider uncertainty is treated conservatively. Missing descriptors or unsupported safety seams can make a provider ineligible.

## 4. Crew acquires a workspace

Crew turns Work into one bounded mission. Workspace policy depends on Work type:

| Work type | Current Crew workspace behavior |
| --- | --- |
| SCOUT | fresh read-only |
| SHIP | fresh isolated-write |
| REVIEW | exact inherited dependency workspace, read-only |

For repository work, Git worktrees currently provide the isolation boundary from the source working tree.

## 5. An Attempt executes

An Attempt is one execution of a Task. It receives:

- the Work contract;
- task and attempt identity;
- objective;
- authority;
- selected context;
- workspace binding;
- supported tainted attachments as data;
- runtime-only Guard mediation when required.

The worker owns execution, not organizational truth.

## 6. Guard mediates effects

Where a provider exposes the required native permission seam, Guard evaluates tool calls before effects occur.

Guard receives structured information about the tool category, arguments, Work and Attempt identity, actor, write scope, context hash, evidence references, and time. It returns `allow`, `prompt`, or `forbid` with risk, rationale, rules hit, and policy backend information.

Write-capable Crew missions require guarded tool mediation. A `forbid` is an enforcement decision, not a suggestion to the model.

## 7. Runtime observations are recorded

Processes, sessions, workers, filesystems, CI, and external tools produce observations. Observations may report activity, errors, drift, or completion.

A process being alive does not prove useful progress. A worker reporting completion does not prove verification. Runtime observations do not silently overwrite Board state.

Consequential events and evidence are recorded in the Ledger so the sequence can be reconstructed after failure.

## 8. Attempt completion produces a candidate, not success

A finished SHIP Attempt yields a changed workspace. Crew checks read-only or write-scope policy and records an execution receipt.

The candidate is then captured by exact identity. Current repository work can preserve the candidate under Harness-owned Git refs so the verified tree remains recoverable even after temporary workspace cleanup.

At this point the Work is still unaccepted.

## 9. Verify tests the exact candidate

Verify captures the exact target before checks, runs independent deterministic verifier providers, rechecks the target around checks, evaluates criteria and evidence requirements, and fails on drift.

Negative controls can perturb a disposable derivative to prove that a verifier recognizes a known failure. A control must fail on the perturbation to count as useful.

Verification is tied to the exact candidate identity examined by that verification run. Proof does not establish facts about another candidate.

## 10. Integration Controller records the checkpoint

A passed verification can be represented as an integration candidate checkpoint on the Work's existing stream. The checkpoint binds:

- Work and Attempt identity;
- workspace;
- parent integration head;
- candidate HEAD and tree;
- changed resources;
- proof state;
- verification event;
- preserved candidate ref when available.

There is one Work stream and one Board. Integration does not create a parallel truth system.

## 11. Board becomes ready

A passed verification can leave Board state `ready`. Ready means the projection's acceptance preconditions are satisfied for the current Work revision.

Ready is not accepted.

The current repository runner explicitly emits a receipt with `accepted: false` after passed verification and durable replay. That behavior is intentional.

## 12. Acceptance is a separate decision

Current Board projection accepts a `work.accepted` event only when acceptance readiness passes and the accepting actor has never executed the Work. Board therefore enforces executor separation and current-revision proof requirements.

The portable `ActorRef.kind` field is self-declared audit metadata. Board does not currently authenticate that an actor claiming `kind: "human"` is a real human, and it does not currently evaluate a separate organization-level acceptance permission registry. The repository Work runner exposes no acceptance command and stops at `ready`.

A product or integration that emits `work.accepted` must supply the real identity and permission boundary around that event. Authenticated human approval is an intended organizational control, not a property proven by the current `ActorRef` schema.

Rejected, cancelled, parked, and accepted states remain durable facts once valid events project them.

## 13. Ledger preserves the result

The durable event history records what happened, who was claimed as actor, what evidence existed, what the Board derived, and what decision event was recorded.

Reopening the Ledger and replaying the stream must reconstruct the same organizational state. Durability is part of the product contract, not an optional audit feature.

## 14. Learning compounds

Outcomes feed the learning loop:

```text
Outcome evidence
-> benchmark measurements
-> Refiner proposal
-> reviewed promotion
-> Rule / Guard / verifier / context / routing / architecture improvement
-> future Work
```

Learning may propose changes. It does not self-authorize permanent policy or architecture changes.

## Dependency Work and tainted data

A dependency worker's free-text summary may contain untrusted repository content, issue text, or model-authored instructions. Rhiz therefore separates downstream objective from dependency data.

The objective remains Work intent only. Dependency reports and artifact claims travel as typed `TaintedAttachment` values with provenance and bounded size. Adapters render them as fenced untrusted data, outside the contract instruction section.

This prevents worker output from becoming authority simply because another model sees it later.

## Failure and retry

Failure does not erase Work.

Depending on policy, the system may:

- create a new Attempt;
- transfer a bounded Attempt lease;
- park Work;
- preserve a WIP rescue checkpoint;
- request a decision;
- rerun verification;
- reject or cancel Work.

The failure evidence should follow the Work so a later Attempt does not repeat the same mistake blindly.

## The invariant to remember

```text
execution is an attempt
verification is evidence
acceptance is a decision event with separate readiness rules
outcome is accepted organizational truth once that event is validly projected
```

That separation is the core of the Harness lifecycle.
