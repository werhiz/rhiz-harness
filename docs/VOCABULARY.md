# Canonical Vocabulary

These terms are part of the public architecture. Use them consistently in code, schemas, documentation, events, and UI.

## Core organizational nouns

### Work
A durable unit of human or organizational intent. Work survives individual attempts, workers, processes, sessions, and retries.

### WorkContract
The immutable-at-creation contract describing objective, work type, scope, non-goals, authority, acceptance criteria, evidence requirements, context policy, dependencies, worker policy, and verification policy. Amendments are explicit events rather than silent mutation.

### Task
A bounded executable part of Work. A Work item may contain one task or a graph of tasks.

### Attempt
One execution attempt for a Task. Retries create new attempts. Attempt identity must never be confused with Work identity.

### AttemptLease
The revocable, bounded authority an Attempt holds over one workspace and an explicit set of logical resource claims. A lease expires, may be transferred to a successor worker through a checkpointed handoff, and its release frees only the Attempt, never the Work.

### IntegrationCheckpoint
Durable evidence of an Attempt's workspace state at a point in time, classified either as a Harness-owned WIP rescue or as an integration candidate eligible for the Work's single integration head. Candidate eligibility requires passed verification bound to that exact checkpoint. See `docs/KERNEL_0_1.md` for the event ownership and replay rules.

### WorkType
The initial canonical work modes are:

- `SCOUT`: investigate, read, analyze, or produce evidence without production mutation.
- `SHIP`: implement a bounded change within an explicit write scope and produce verification evidence.
- `REVIEW`: independently evaluate work or evidence. A REVIEW actor does not silently repair the same finding it is certifying.

Additional work types require evidence that the distinction changes policy or execution semantics.

### Actor
Any entity capable of participating in Work: human, agent, service, verifier, or organization-controlled automation.

### Worker
An Actor assigned to execute a Task or Attempt.

### Supervisor
An Actor or deterministic subsystem responsible for observing, coordinating, escalating, or routing work without becoming the canonical owner of the Work state.

### Crew
A bounded set of workers and supervisors coordinated for one Work graph or organizational objective.

## State and truth

### Board
The canonical organizational projection of Work, Tasks, Attempts, dependencies, authority, decisions, verification, and accepted outcomes.

### Canonical State
State owned by the subsystem designated as authority for that fact. Canonical does not mean infallible; contradictory evidence can trigger correction, but correction is explicit.

### Observation
A timestamped external fact or heuristic from a runtime, process, model, terminal, CI system, filesystem, or service. An Observation is never automatically canonical.

### Event
An immutable typed durable fact appended to an event stream.

### Ledger
The durable append-only history of typed events and evidence references used for reconstruction, audit, learning, and measurement.

### Projection
Derived state computed from durable events. Projections may be rebuilt.

## Intent, authority, and evidence

### Objective
The desired change in the world expressed by Work.

### Scope
The resources, code, systems, or domains that a Task is expected to consider.

### WriteScope
The resources a Worker may mutate for a Task.

### NonGoal
An explicit boundary describing what the Work should not attempt.

### AuthorityPolicy
Machine-readable rights and restrictions for reading, writing, executing, approving, publishing, spending, or mutating external systems.

### AcceptanceCriterion
A specific condition that must be accounted for before Work can be accepted.

### Evidence
A durable, attributable basis for a claim. Examples: exact-tree test results, browser proof, static analysis, diff identity, logs, screenshots, external receipts, or independent review results.

### EvidenceRequirement
The type, strength, scope, and freshness of Evidence required for acceptance.

### Artifact
A durable object produced or changed by Work, such as code, a document, configuration, binary, schema, report, deployment, or dataset.

### Decision
A durable choice that changes authority, scope, direction, acceptance, or another consequential Work property.

### Outcome
The accepted organizational result of Work. Worker completion is not an Outcome until acceptance occurs.

## Intelligence modules

### Rule
An evidence-backed instruction or operating principle selected for relevant work.

### Guard
A mechanized boundary that constrains or blocks behavior independently of prompt compliance.

### ContextPack
The selected set of task-relevant instructions, code knowledge, history, evidence, constraints, and references supplied to an Actor.

### Verification
A process that tests claims against acceptance criteria and produces Evidence.

### Review
Independent judgment over artifacts, behavior, or Evidence. Review and implementation should remain distinguishable even when the same provider type can perform both.

### Lesson
A durable candidate insight derived from repeated or high-value evidence that may improve Rules, Guards, Context, Verification, routing, or architecture.

### Route
A recorded selection of worker/provider/model/host/context/verification strategy for a Task.

## Execution nouns

### Host
A replaceable execution framework that supplies capabilities used by Rhiz. DSH is the first Host.

### HostAdapter
The Rhiz-owned anti-corruption layer that translates a concrete Host into portable Rhiz capability interfaces.

### Provider
A replaceable implementation of one capability, such as a worker, filesystem, process, sandbox, terminal, or model provider.

### Runtime
The subsystem responsible for processes, sessions, execution environments, and related observations. Runtime does not own organizational truth.

### Session
A durable or resumable interaction/execution context owned by a Host or Runtime.

### Process
An operating-system or remote execution process. Process liveness is an Observation, not proof of useful progress.

### Sandbox
An execution boundary that constrains filesystem, network, process, credential, or other capabilities.

## Terms to avoid conflating

- **Work** is not an Attempt.
- **Worker finished** is not **verified**.
- **Verified** is not **accepted**.
- **Process alive** is not **making progress**.
- **Observation** is not **canonical state**.
- **Attempt lease released** is not **Work failed**.
- **Context available** is not **context selected**.
- **Model/provider** is not **Worker identity**.
- **Host** is not **Rhiz Harness**.
- **Rhiz Protocol** is a consumer of Rhiz Harness, not a dependency of the portable core.
