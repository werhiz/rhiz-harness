# Architecture

Status: reader-facing synthesis of current architecture. Normative authority remains the Constitution, shipped contracts, system boundaries, vocabulary, and accepted ADRs.

## What Rhiz Harness is

Rhiz Harness is a portable organizational runtime for coding work. It binds human intent to explicit Work contracts, gives replaceable workers bounded authority, observes execution, independently verifies exact artifacts, preserves durable evidence, and keeps acceptance as a separate organizational decision.

Software engineering is Customer Zero. The contracts are intentionally broader than any one agent product so the same model can survive changes in vendors, hosts, runtimes, repositories, and interfaces.

## The system in one view

```text
Human / organization intent
          |
          v
      WorkContract
          |
          +---- Rules selection
          +---- Context composition
          +---- Router evidence
          |
          v
        Board  <-------------------------+
          |                              |
          v                              |
        Crew                             |
          |                              |
          +---- WorkerCatalog            |
          +---- HostAdapter              |
          +---- WorkspaceProvider        |
          |                              |
          v                              |
   bounded Worker Attempt                |
          |                              |
          +---- Guard mediation ---------+
          +---- Runtime observations ----+
          |
          v
 exact candidate / artifact identity
          |
          v
        Verify
          |
          +---- independent checks
          +---- negative controls
          +---- evidence requirements
          |
          v
  IntegrationCheckpoint
          |
          v
      Board ready
          |
          v
 acceptance / rejection decision
          |
          v
 durable Outcome + Ledger evidence
          |
          v
 Refiner / Rule / routing / benchmark learning
```

The Ledger records durable facts across the flow. Board is a deterministic projection of those facts. Runtime state and worker self-report are observations, not organizational truth.

## Layering

Rhiz follows a one-way dependency rule:

```text
Product and organization integrations
             |
Experience / CLI / API
             |
Board + Crew + intelligence modules
             |
Portable contracts
             |
Host and provider interfaces
             |
Concrete adapters and runtimes
```

Lower layers do not import upper layers for convenience. Concrete host types do not leak into the portable core.

## Portable core

The main package barrel exports these portable modules:

- `benchmark`
- `board`
- `context`
- `contract-bound-authority`
- `crew`
- `disposable`
- `guard`
- `host`
- `integration`
- `ledger`
- `refiner`
- `router`
- `rules`
- `sandbox`
- `schemas`
- `verify`
- `workers`
- `workspace-digest`

These modules own durable semantics. Adapters translate external systems into those contracts.

## Canonical owners

Rhiz uses one owner for each consequential fact.

| Fact | Canonical owner |
| --- | --- |
| Work contract and organizational state | Board / Work stream |
| Durable event history | Ledger |
| Execution coordination | Crew |
| Authority decision at effect seams | Guard + WorkContract |
| Process/session liveness | Host/Runtime observation |
| Worker/provider capability | Worker/Host descriptor |
| Context selection | Context |
| Rule schema and deterministic selection | Rules |
| Route selection | Router |
| Artifact identity | workspace/artifact evidence layer |
| Verification result | Verify |
| Acceptance state | Board projection over `work.accepted` |
| Integration checkpoint/head | Integration Controller on the Work stream |
| Learning proposals | Refiner |

An external observation can challenge canonical state. It cannot silently overwrite it.

## Work is the durable unit

Work survives workers, attempts, processes, sessions, worktrees, and models. A WorkContract contains:

- objective
- type: `SCOUT`, `SHIP`, or `REVIEW`
- scope and write scope
- non-goals
- authority
- acceptance criteria
- required evidence
- context policy
- dependencies
- worker policy
- verification policy
- creator and creation time

Retries create new Attempts. They do not create a new meaning of the Work unless an explicit amendment changes the contract.

## Board and Ledger

Ledger is append-only durable history. Board is a replayable projection over Work events.

This split produces two critical properties:

1. a process crash does not erase organizational memory;
2. current state can be reconstructed from evidence rather than trusted from an in-memory coordinator.

Board violations are recorded instead of silently applying illegal transitions. Terminal decisions such as accepted, rejected, and cancelled are explicit events.

## Crew and workers

Crew converts a validated Work graph into bounded missions. Current Crew v0 is intentionally conservative:

- one attempt per mission;
- `maxParallel = 1`;
- SCOUT and REVIEW are read-only;
- SHIP uses a fresh isolated-write workspace;
- REVIEW inherits the exact SHIP workspace it evaluates;
- the SHIP worker is excluded from independent REVIEW selection;
- dependency worker output travels as tainted data, separate from the downstream instruction string.

Workers are replaceable providers. The same Work semantics can be executed by Codex, Claude, DSH-native workers, or future providers when they satisfy the required capability and safety contract.

## Workspaces and artifact identity

Git worktrees are the current repository workspace implementation. SHIP changes are isolated from the source working tree. Rhiz records exact base revision, HEAD, changed paths, and a byte-sensitive workspace digest.

Verification binds to the exact candidate. A verified artifact may be preserved under a Harness-owned candidate ref. Verification of one tree does not establish facts about a different tree.

## Guard and authority

Authority is data, not prose. Work carries machine-readable grants and human-approval requirements. Guard evaluates native tool calls at supported enforcement seams.

The central rule is simple:

> Prompt text is never the enforcement boundary.

Write-capable worker routes must expose guarded tool mediation. Unknown or over-privileged provider capability fails closed unless the narrow schema-defined authorization path permits it. A provider-authorization record does not create workspace binding or guarded mediation a provider lacks.

`ActorRef.kind` is currently self-declared audit metadata. A schema check that requires `kind: "human"` records the claimed actor class; it is not an authentication or permission system by itself.

## Verification and acceptance

Execution, verification, and acceptance are separate facts.

```text
worker finished
!= verified
!= accepted
```

Verify captures an exact target, runs deterministic checks through an independent verifier, evaluates criteria and evidence requirements, and uses negative controls where required to prove a check can detect a known failure.

A passing verification can move Board to `ready`. A later `work.accepted` event becomes accepted only if Board readiness passes and the accepting actor has never executed the Work.

### Current acceptance boundary

The portable Board currently proves readiness and executor separation. It does **not** authenticate that an `ActorRef` claiming `kind: "human"` corresponds to a real human, nor does it currently enforce a separate organizational permission registry for acceptance. The repository Work runner deliberately stops at `ready` with `accepted: false`; there is no shipped operator acceptance command in that path.

An experience or integration that exposes acceptance must therefore supply the real identity/permission boundary and emit the event only after that authorization succeeds. Treat authenticated human acceptance as a product/security requirement that is still outside the portable `ActorRef` schema, not as a property already proven by Board.

## Intelligence loop

The intelligence modules are designed to improve the organization without giving learning self-authorizing power.

- **Rules** select evidence-backed operating instructions.
- **Context** selects the smallest sufficient task context.
- **Router** chooses among eligible worker/provider strategies using capability and measured evidence.
- **Refiner** proposes durable lessons and possible promotions.
- **Benchmark** measures whether the system actually improves outcomes.

Promotion into a Rule, Guard, verifier, routing policy, or architectural decision remains reviewable and attributable to evidence.

## Hosts and adapters

DSH is the first Host because it offers useful plugin and execution seams. Codex App Server is also integrated through a Rhiz-owned adapter. Git worktrees and local verification/ledger implementations are adapters beneath portable contracts.

The package can expose adapter-specific entry points without making those dependencies part of the portable core.

## Security architecture

The security model layers controls rather than relying on one mechanism:

```text
WorkContract authority
+ provider capability classification
+ workspace binding
+ OS/process containment where shipped
+ Guard native-tool mediation
+ exact write-scope validation
+ tainted-data separation
+ independent verification
+ exact artifact identity
+ explicit acceptance event + executor exclusion
+ durable replayable evidence
```

Each control proves a specific property. No single control is described as proving more than it actually does.

## Product direction

The intended human experience is a zero-ceremony `rhiz` command surface where ordinary coordination disappears behind one loop. That experience is specified by accepted ADR 0015 and the proposed Developer Experience design, while current dogfood uses operator scripts and exported APIs.

The architectural target remains stable even as the surface simplifies:

```text
intent
-> context + rules
-> capable worker route
-> isolated execution
-> independent verification
-> acceptance
-> durable receipt
-> learning
```

## Where to go deeper

- [System Boundaries](SYSTEM_BOUNDARIES.md)
- [Kernel 0.1](KERNEL_0_1.md)
- [Work Contracts](WORK_CONTRACTS.md)
- [Execution Lifecycle](EXECUTION_LIFECYCLE.md)
- [Security Model](SECURITY_MODEL.md)
- [Architecture Decision Records](decisions/README.md)
