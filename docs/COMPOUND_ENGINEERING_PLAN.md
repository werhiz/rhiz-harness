# Rhiz Harness Compound Engineering Plan

## Purpose

Rhiz Harness is a self-improving engineering system. The objective is not merely to complete work. Every consequential piece of work should leave the Harness more capable, reliable, observable, easier to use, and less dependent on human clerical intervention.

The core flywheel is:

```text
Work
→ Evidence
→ Outcome
→ Lesson
→ System Improvement
→ Better Next Work
```

DSH is the initial execution framework. Rhiz owns the portable organizational layer, contracts, evidence, learning system, benchmarks, and long-term architecture.

## 1. The two loops

### Execution loop

```text
Intent
→ WorkContract
→ Context
→ Authority
→ Route
→ Execute
→ Observe
→ Verify
→ Review
→ Accept / Reject
→ Outcome
```

### Learning loop

```text
Outcome
→ Ledger
→ Compare expectation vs reality
→ Extract Lesson
→ Classify failure/success
→ Propose improvement
→ Test improvement
→ Promote if proven
→ Benchmark
→ Better future execution
```

The second loop is what turns normal engineering into compound engineering.

## 2. Permanent compound engineering rule

Every consequential Work item should answer:

1. What happened?
2. What evidence proves it?
3. What surprised us?
4. What should the system learn from it?
5. What should permanently change, if anything?

Possible permanent outputs include:

- Rule
- Guard
- Test
- Verifier
- Context strategy
- Routing policy
- Worker profile
- Tool
- Capability
- Documentation
- Benchmark
- Architecture decision
- UX improvement
- Recovery behavior

A completed feature that produces no reusable learning is valid. A recurring mistake that produces no system improvement is a Harness failure.

## 3. Learning promotion ladder

```text
Observation
→ Finding
→ Lesson Candidate
→ Evidence accumulation
→ Improvement Proposal
→ independent REVIEW
→ Experiment / negative control
→ Benchmark
→ Promoted Lesson
→ Rule / Guard / Verify / Context / Router / Architecture
```

Promotion strength depends on evidence:

- Level 0, Observation: something happened once.
- Level 1, Finding: we understand why it happened.
- Level 2, Candidate Lesson: the explanation appears reusable.
- Level 3, Proven Lesson: reproduction, comparison, or repeated evidence supports it.
- Level 4, Mechanized Learning: the lesson becomes a guard, test, verifier, routing rule, or other code-level mechanism.

Prefer mechanization over accumulating prompt text whenever the behavior can be made deterministic.

## 4. Failure taxonomy

Classify failures so Refiner knows where improvement belongs:

```text
wrong-understanding
missing-context
too-much-context
bad-routing
worker-capability
authority-error
coordination-error
concurrency-conflict
implementation-error
verification-gap
false-verification
runtime-failure
dependency-failure
environment-drift
process-stall
recovery-failure
human-friction
architecture-confusion
repeated-mistake
```

Examples:

- Agent edits the wrong subsystem → Context or WorkContract failure.
- Agent knows a rule and ignores it → Guard opportunity.
- Tests pass but product is broken → Verify opportunity.
- One worker repeatedly outperforms another → Router evidence.
- Human repeatedly checks worker liveness → Board/Runtime observability opportunity.
- Human repeatedly performs a copy action → One Less Action opportunity.

Do not solve every failure by adding more instructions.

## 5. Success taxonomy

Compound engineering learns from success too:

```text
high-quality-first-attempt
low-context-success
cheap-model-success
fast-verification
successful-recovery
useful-parallelization
effective-rule
effective-guard
strong-context-selection
zero-human-intervention
excellent-review
high-value-tool
```

If a cheaper worker reliably succeeds for a task class, Router should learn it. If a Context strategy lowers token use without lowering quality, Context should learn it. If one verification strategy catches defects others miss, Verify should strengthen it.

## 6. Phase A: Kernel 0.1

Finish the portable foundation before advanced compounding:

- WorkContract runtime schemas
- typed HarnessEvent schemas
- deterministic Board replay
- Authority schemas
- Evidence schemas
- WorkerProvider interface
- HostAdapter interface
- EventLedger interface
- Benchmark identity

Kernel acceptance requirements include:

- Board reconstructs completely from durable events.
- Work survives worker/process failure.
- Duplicate or unknown identities fail closed.
- Stale verification cannot certify amended Work.
- Worker finish cannot become organizational acceptance.
- Execution actors cannot certify their own Work when independence is required.
- Runtime observations cannot overwrite canonical Board state.
- Verification is tied to the exact Work revision.
- Schemas validate at runtime.
- Tests execute on a clean runner.

## 7. Phase B: Ledger v1

The Ledger becomes the durable evidence source from which compounding occurs.

Capture, when available:

```text
Work identity
Task identity
Attempt identity
contract revision
actor
worker provider
model
host
ContextPack
selected Rules
AuthorityPolicy
tool activity
artifact identity
changed paths
decisions
verification
review
human interventions
usage/cost
duration
outcome
corrections
lessons
```

The Ledger is append-only. Board state, dashboards, reports, routing intelligence, and learning are projections.

## 8. Phase C: DSH Host

DSH is the first execution Host. Build a Rhiz-owned anti-corruption layer that maps DSH capabilities into portable Rhiz interfaces without leaking DSH types into the core.

The adapter should expose only the capabilities Rhiz requires and preserve evidence references for debugging and measurement.

## 9. Phase D: Workers

At least two worker implementations must satisfy the same WorkerProvider contract.

Workers are replaceable. Their native products, models, sessions, and process semantics remain provider-local.

## 10. Phase E: Crew

Canonical work modes:

```text
SCOUT
SHIP
REVIEW
```

Absorb the strongest lessons from systems such as First Mate:

- liaison/supervisor model
- disposable worktrees
- bounded crew tasks
- mechanical watcher
- durable wake events
- subordinate coordinators
- supervision without constant model polling

Rhiz adds:

- AuthorityPolicy
- EvidenceRequirements
- WorkContract
- typed events
- canonical Board truth
- independent Review
- Ledger
- Refiner
- Router

Crew semantics belong to Rhiz. Workers remain replaceable.

## 11. Phase F: Verify

Every escaped defect should make that defect class harder to repeat.

Potential permanent improvements:

- unit test
- integration test
- browser proof
- environment proof
- negative control
- schema check
- security check
- exact-artifact binding
- independent REVIEW
- verification plugin

A worker claiming completion is evidence. Verification is evidence. Acceptance is a separate organizational decision.

## 12. Phase G: Refiner

Refiner analyzes closed Work and produces evidence-backed improvement proposals.

Example shape:

```text
Finding:
Repeated SHIP attempts modified files outside intended scope.

Likely cause:
writeScope was advisory rather than enforced.

Proposed improvement:
mechanize write-scope enforcement at filesystem/tool execution.

Evidence:
linked Work/Attempt/Event ids.

Validation:
replay failing cases against the proposed Guard.

Destination:
Guard
```

Refiner proposes. It does not silently rewrite permanent policy.

## 13. Phase H: Context

Every ContextPack should have an identity and measurable composition:

```text
included files
selected symbols
history
rules
architecture docs
token estimate
retrieval strategy
task class
outcome
```

Measure:

- which context produced success;
- what information was unnecessary;
- what missing information caused failure;
- which context repeatedly matters for each task class.

Context selection should become empirical.

## 14. Phase I: Router

Initially record routing decisions before making aggressive automatic choices.

Capture:

```text
task class
worker
model
effort
host
Context strategy
cost
duration
verification result
human interventions
repair required
```

Later optimize against policy such as:

```text
cheapest-capable
fastest-capable
highest-confidence
balanced
```

Routing must be evidence-based rather than reputation-based.

## 15. Phase J: Runtime

Study and selectively derive the best generic runtime primitives from Herdr and other permissively licensed systems.

Needed capabilities:

```text
persistent processes
persistent terminals
session identity
detach / reattach
output observation
process trees
remote execution
resume
typed process events
worker ↔ process association
```

Rhiz-specific associations include Work, Task, Attempt, Worker, write scope, ContextPack, Board state, meaningful activity, and verification state.

Runtime reports observations. Board remains canonical truth.

## 16. Phase K: Experience

Build the operator experience only after the underlying contracts are trustworthy:

- Board UI
- terminal/workspace surface
- diff and review surfaces
- notifications
- command system
- copy-on-highlight
- One Less Action automation

### One Less Action Doctrine

Whenever a human repeatedly performs a clerical action that does not require judgment, record it as friction.

Examples:

```text
copy text manually
poll process status
switch terminal
find worktree
paste output
rerun obvious tests
restate context
route obvious review
check CI manually
resume interrupted worker
find changed files
ask what happened
```

Rank friction by frequency × time × interruption cost and remove the highest-value actions first.

## 17. Phase L: Ecosystem

Build the public extension ecosystem:

- plugin SDK
- ACP/MCP boundaries
- provider ecosystem
- public docs
- benchmarks
- community extensions

The mechanism is open. Organization-specific private state remains private.

## 18. Upstream intelligence loop

Maintain a registry for important upstream systems including DSH, Herdr, First Mate, HAR, Aider, OpenCode, Goose, OpenHands, E2B, SWE-agent, and emerging harnesses.

Track:

```text
repository
license
pinned revision
latest revision
capabilities
architecture
known strengths
known weaknesses
Rhiz relevance
integration strategy
last reviewed
```

Process:

```text
upstream changes
→ SCOUT
→ classify relevance
→ inspect provenance/license impact
→ compare against Rhiz
→ compatibility experiment
→ benchmark when relevant
→ REVIEW
→ adopt / reject / defer
```

Rhiz should continuously learn from the ecosystem without becoming an uncontrolled pile of upstream code.

## 19. Dogfood everything

Rhiz Harness builds itself. Rhiz Protocol becomes the first major external Customer Zero.

```text
Harness weakness
→ experienced in real work
→ evidence captured
→ Harness improves
→ next task becomes easier
```

No major Harness capability should be considered mature until exercised by real engineering work.

## 20. Benchmark every generation

Permanent comparison:

```text
same WorkContract
same repository state
same model where possible

agent alone
vs
Rhiz Harness previous release
vs
Rhiz Harness candidate release
```

North Star:

> Human interventions per independently verified successful outcome.

Supporting metrics:

- verified completion rate
- human repair rate
- regression rate
- repeat-mistake rate
- recovery rate
- wall-clock time
- model cost
- token/usage cost
- context size
- verification strength
- autonomous continuation
- wasted/redundant work

A release should make evidence-backed claims, not intuitive superiority claims.

## 21. Release intelligence with the software

Each meaningful release should include a Harness Intelligence Report containing:

```text
what improved
what evidence motivated it
what benchmarks changed
what rules were added
what rules were mechanized
what lessons were promoted
what lessons were rejected
what upstream innovations were adopted
known weaknesses
next experiments
```

## 22. Guard against self-corruption

A self-improving Harness can compound bad ideas too. Permanent safeguards:

- no automatic Constitution modification;
- no automatic weakening of security/authority boundaries;
- no permanent Rule from one low-confidence event;
- no routing optimization across incomparable tasks;
- no benchmark improvement through weaker acceptance criteria;
- no worker self-certification;
- all promoted learning must be attributable to evidence;
- improvements must be reversible;
- regression benchmarks must remain available;
- stale rules/lessons may be retired;
- humans retain authority over consequential policy.

Compounding requires selection, not accumulation.

## Development sequence

1. **Kernel 0.1**: executable Work/Event/Board contracts and clean CI proof.
2. **Ledger v1**: durable typed event storage, replay, querying, evidence references.
3. **DSH Host**: map DSH behind `HarnessHost` without leaking DSH types.
4. **Workers**: at least two WorkerProviders behind one contract.
5. **Crew**: SCOUT / SHIP / REVIEW, isolated worktrees, dependencies, supervision.
6. **Verify**: exact artifact identity, acceptance criteria, independent review, negative controls.
7. **Refiner**: evidence-backed improvement proposals.
8. **Context**: ContextPack generation and outcome measurement.
9. **Router**: evidence-based worker/model/context selection.
10. **Runtime**: selective Herdr-derived persistent execution infrastructure.
11. **Experience**: Board UI, terminals, review, copy-on-highlight, One Less Action automation.
12. **Ecosystem**: plugin SDK, open protocols, providers, docs, community extensions.

## Definition of success

The Harness succeeds when a high-level request can reliably cause the system to:

```text
understand intent
→ establish WorkContract
→ select context
→ establish authority
→ plan Work graph
→ choose workers
→ execute in isolation
→ observe progress
→ recover failures
→ verify independently
→ request only genuine decisions
→ accept an evidence-backed outcome
→ explain what changed
→ learn from the run
→ improve future execution
```

with progressively fewer human clerical actions.

The long-term objective is:

> **Every verified outcome makes the organization that produced it more capable of producing the next one.**
