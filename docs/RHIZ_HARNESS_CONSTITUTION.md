# Rhiz Harness Constitution

Status: Founding architecture authority

## Purpose

Rhiz Harness exists to turn collections of humans, agents, models, tools, runtimes, and repositories into a disciplined, observable, learning organization that produces increasingly better outcomes with decreasing clerical management from humans.

The project is **coding-first and organization-native**. Software engineering is Customer Zero. The domain contracts are intentionally broader than any current coding agent so they can survive changes in models, vendors, runtimes, and development workflows.

The North Star is:

> **Reduce human interventions per independently verified successful outcome while improving reliability, learning, and organizational capability over time.**

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative requirements. A change that violates a MUST requires a constitutional amendment, not a local exception hidden in code.

## Constitutional invariants

### 1. Standalone by design

Rhiz Harness MUST be usable without Rhiz Protocol. Rhiz Protocol is Customer Zero and MAY provide organization-specific plugins, rules, context, graph data, and verification profiles. Rhiz Harness MUST NOT depend on Rhiz Protocol to function.

### 2. Hosts are replaceable

DeepSeek Harness (DSH) is the first execution host, not the Rhiz domain model. Portable Rhiz contracts MUST NOT import DSH-specific types. DSH-specific behavior belongs behind a host adapter. The same rule applies to any future host.

### 3. One fact, one canonical owner

Every consequential organizational fact MUST have one canonical owner. Board owns organizational work state. Runtime, terminal, model, process, CI, filesystem, and external services produce observations and evidence. Observations MAY challenge canonical state but MUST NOT silently overwrite it.

### 4. Work survives workers

Workers and processes are ephemeral. Work, tasks, authority, decisions, evidence, and outcomes MUST be durable independently of the process or model that acted on them. Killing a worker MUST NOT erase the organization's knowledge of what remains to be done.

### 5. Consequential behavior is reconstructible

Substantial state transitions and consequential actions MUST emit typed durable events or durable evidence references sufficient to reconstruct what happened. Derived views SHOULD be projections of durable facts rather than independent mutable truths.

### 6. Completion, verification, and acceptance are different

A worker MAY report that its attempt is finished. That report MUST NOT by itself make work successful. Verification establishes evidence against explicit acceptance criteria. Board acceptance is the organizational decision that the work succeeded. These are separate events and authorities.

### 7. Workers are interchangeable

Codex, Claude, DeepSeek, OpenCode, Goose, local models, remote services, and future agents MUST sit behind Rhiz-owned worker/provider contracts. Worker-specific capabilities MAY be exposed explicitly, but core work semantics MUST NOT depend on one vendor.

### 8. Context is engineered

Context is a scarce computational resource. Rhiz SHOULD select the smallest sufficient context for the work, record what was selected, and measure whether context strategies improve outcomes. Dumping all available state into every worker is not a default strategy.

### 9. Authority is explicit and bounded

Every substantial task MUST have an explicit authority policy defining what an actor may read, write, execute, approve, publish, or mutate externally. Prompt text alone is not an enforcement boundary. High-consequence capabilities SHOULD be guarded mechanically.

### 10. Mechanical supervision precedes cognitive supervision

PID checks, process health, filesystem state, Git state, deterministic validation, queue handling, timeouts, and other machine-readable supervision SHOULD consume zero model tokens whenever possible. Models are reserved for judgment, synthesis, ambiguity, and work that requires cognition.

### 11. Humans handle judgment, not clerical coordination

The system SHOULD continuously remove repeated human actions that do not require human judgment. Status polling, context re-pasting, log copying, worktree discovery, obvious routing, repeated corrections, and routine follow-up are product debt when they can be safely automated.

This is the **One Less Action Doctrine**.

### 12. Learning compounds

Failures, corrections, successful patterns, verification results, and routing outcomes MUST have a path into durable learning. Repeated evidence SHOULD be promotable into rules, guards, verifiers, context strategies, routing policies, or other organizational improvements. Promotion itself remains reviewable and evidence-backed.

### 13. Open protocols at boundaries

Rhiz SHOULD prefer open, documented, replaceable protocols at integration boundaries. ACP, MCP, and future interoperable standards are preferred over avoidable vendor lock-in when they satisfy the required capability.

### 14. Dogfood determines permanence

Rhiz MAY study broadly, but permanent abstractions SHOULD be justified by real work, recurring failure, measured improvement, or a necessary architectural seam. A feature existing in another harness is not sufficient reason to copy it.

### 15. Benchmarks outrank enthusiasm

Claims of improvement SHOULD be measured. The primary benchmark is human interventions per independently verified successful outcome. Reliability, repair rate, cost, latency, context consumption, recovery, and repeat-mistake rate are supporting measures.

### 16. Provenance is a product feature

Code or design substantially derived from another project MUST retain machine-readable provenance, upstream identity, license classification, and the Rhiz adaptation strategy. The project MUST be able to explain what was invented, adapted, derived, vendored, or merely integrated.

## Initial non-goals

Kernel 0.1 is not a commitment to build:

- a new terminal emulator;
- a cloud execution platform;
- a marketplace;
- a replacement for every DSH capability;
- a general-purpose organizational SaaS product;
- hundreds of autonomous agents;
- autonomous self-modification without review;
- a graphical organizational knowledge product.

The Kernel should create seams for future capabilities without prematurely implementing them.

## Architectural authority

This Constitution is the repository's highest architectural authority. The canonical vocabulary and system-boundary documents interpret it. Architecture Decision Records MAY refine decisions within these boundaries.

## Amendment rule

A constitutional amendment MUST include:

1. the problem or evidence motivating the change;
2. the invariant being added, removed, or modified;
3. compatibility and migration impact;
4. security/authority implications;
5. benchmark implications where measurable;
6. provenance implications when upstream code or architecture is involved.

Constitutional changes should be rare. Implementation should evolve rapidly behind stable contracts.
