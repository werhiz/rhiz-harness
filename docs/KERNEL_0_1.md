# Kernel 0.1 Contract

Kernel 0.1 establishes the smallest stable substrate on which the rest of Rhiz Harness can evolve.

## Goal

Prove that one portable WorkContract can be executed through a concrete Host, produce typed durable events, project canonical Board state, invoke a replaceable WorkerProvider, and generate benchmarkable evidence without importing concrete-host semantics into the portable core.

## Required components

Kernel 0.1 contains only:

1. portable identifiers and schemas;
2. `WorkContract`;
3. typed Event envelope and initial event vocabulary;
4. append-only Ledger interface;
5. deterministic Board projection;
6. HostAdapter capability interface;
7. WorkerProvider interface;
8. benchmark instrumentation contract;
9. DSH HostAdapter as the first concrete host implementation.

Crew automation, native Runtime, advanced Context, rich Guard policy, UI, and automatic Refiner/Router behavior come after the Kernel proves these seams.

## WorkContract

Illustrative TypeScript shape:

```ts
export type WorkType = "SCOUT" | "SHIP" | "REVIEW";

export interface WorkContract {
  id: WorkId;
  objective: string;
  type: WorkType;

  scope: ResourceRef[];
  writeScope: ResourceRef[];
  nonGoals: string[];

  authority: AuthorityPolicy;
  acceptanceCriteria: AcceptanceCriterion[];
  requiredEvidence: EvidenceRequirement[];

  context: ContextRequest;
  dependencies: WorkId[];
  workerPolicy: WorkerPolicy;
  verificationPolicy: VerificationPolicy;

  createdBy: ActorRef;
  createdAt: Timestamp;
}
```

The initial contract is durable. Changes to objective, scope, authority, acceptance criteria, or evidence requirements are represented as explicit amendment events.

## Event envelope

```ts
export interface HarnessEvent<TType extends string, TPayload> {
  id: EventId;
  type: TType;
  schemaVersion: number;

  streamId: StreamId;
  workId?: WorkId;
  taskId?: TaskId;
  attemptId?: AttemptId;

  actor: ActorRef;
  occurredAt: Timestamp;
  recordedAt: Timestamp;

  payload: TPayload;
  evidence?: EvidenceRef[];
  causationId?: EventId;
  correlationId?: string;
}
```

`recordedAt` is Ledger time. `occurredAt` is source-reported time. Ordering rules must not assume they are equal.

## Initial event vocabulary

Kernel 0.1 should support the minimum durable spine:

```text
work.created
work.amended

task.created
task.assigned
attempt.started
attempt.lease-transferred
attempt.activity-observed
attempt.blocked
attempt.finished
attempt.failed

authority.granted
authority.denied
guard.evaluated

artifact.observed
artifact.changed

decision.requested
decision.resolved

verification.started
verification.result

review.started
review.finding
review.result

work.accepted
work.rejected
work.cancelled
work.parked
work.released

integration.initialized
integration.checkpoint-recorded
integration.execution-observed
```

Events are facts. Projections interpret them. Adding an event type requires a schema, ownership rationale, and replay semantics.

### Ownership rationale for the Work integration events

| Event | Owner | Rationale |
| --- | --- | --- |
| `attempt.lease-transferred` | Attempt | A lease is Attempt-scoped execution authority, so a handoff keeps the same Work/Task/Attempt identity and replaces only the current lease holder and its bounded lease. The Attempt retains ordered execution provenance for every actor that has ever held the lease, and independence checks read that full provenance, so a prior executor never becomes eligible to verify, review, or accept the Work. |
| `work.parked` / `work.released` | Work | Parking is an organizational decision about the Work itself, not a runtime observation, so Board owns it and refuses it while any Attempt, verification, or review is active. |
| `integration.initialized` | Work | A Work owns exactly one integration ref/head on its existing Work stream; there is no Lane, second Board, or second Ledger. |
| `integration.checkpoint-recorded` | Attempt | A checkpoint is durable evidence produced by one Attempt from its leased workspace; the Board binds it to that Attempt workspace and the current integration head. |
| `integration.execution-observed` | Runtime observation | Runtime is never authoritative over Board state: the observation is recorded and any recorded-versus-execution divergence is appended, but it never changes Work state, including after the Work is terminal. |

Replay semantics: every one of these events is projected by `projectEvent`, and any event the Board refuses is recorded as a `ProjectionViolation` instead of mutating projection state, so a replay of the Work stream reconstructs the same Board.

## Board projection

Board is a deterministic projection of Ledger events.

Initial Work states:

```text
proposed
ready
running
blocked
verifying
reviewing
parked
accepted
rejected
cancelled
failed
```

`parked` is an explicit organizational hold: while a Work is parked no Attempt, verification, or review may start, and it must be released before acceptance.

`accepted`, `rejected`, and `cancelled` are explicit organizational decisions. An `attempt.finished` event never directly means `work.accepted`.

Integration lifecycle mutations are operator-only: the `IntegrationController` accepts a `human` or `service` actor, never an `agent` or `verifier` actor. In particular, a worker cannot initialize integration, start or transfer an Attempt, record a checkpoint, or release a parked Work through that controller. A service may operate the controller on behalf of the organization, while `acceptVerifiedWork` requires a human actor. This class-based boundary is intentionally narrower than authenticated process identity; Runtime identity binding remains the separate prerequisite for proving who supplied an actor reference.

Projection rules must be pure enough to rebuild state from an event stream in tests.

## Portable Host interface

The Kernel should depend on a small capability surface rather than a concrete runtime:

```ts
export interface HarnessHost {
  readonly id: string;
  capabilities(): Promise<HostCapabilities>;
  workers(): WorkerRegistry;
  processes(): ProcessProvider;
  sessions(): SessionProvider;
  filesystem(): FilesystemProvider;
  sandbox(): SandboxProvider | null;
  tools(): ToolProvider;
}
```

Kernel code may ask what capabilities exist. It may not assume DSH's plugin tree, profile format, session-event types, job IDs, or provider implementation details.

## WorkerProvider

```ts
export interface WorkerProvider {
  readonly id: string;
  capabilities(): Promise<WorkerCapabilities>;

  start(input: WorkerStartRequest, options?: WorkerStartOptions): Promise<WorkerHandle>;
}

export interface WorkerHandle {
  readonly workerId: WorkerId;
  readonly attemptId: AttemptId;

  observe(): AsyncIterable<WorkerObservation>;
  result(): Promise<WorkerResult>;
  cancel(reason: string): Promise<void>;
}
```

`WorkerStartOptions` carries runtime-only wiring that is deliberately absent from the serializable `WorkerStartRequest`, such as the synchronous Guard mediation callback a write-capable provider must honour before a native tool effect. See `docs/decisions/0008-policy-oracle.md`.

A provider may represent Codex, Claude, DSH-native agents, OpenCode, Goose, ACP, or future workers. Provider-specific detail can be attached as opaque diagnostics/evidence without becoming portable core semantics.

## DSH HostAdapter

Kernel 0.1 uses DSH as the first Host because it already provides strong plugin composition, durable sessions, tools, jobs, sandboxes, terminals, subprocesses, and subagent providers.

The DSH adapter must:

- translate DSH capabilities into Rhiz interfaces;
- translate DSH observations/errors into portable categories;
- preserve useful DSH evidence references;
- keep DSH types out of portable packages;
- pin and compatibility-test the supported DSH version range;
- fail clearly when an expected DSH capability is absent;
- avoid patching DSH internals when a documented extension seam exists.

## Ledger interface

```ts
export interface EventLedger {
  append(event: HarnessEvent<string, unknown>): Promise<void>;
  read(stream: StreamId, after?: EventCursor): AsyncIterable<HarnessEvent<string, unknown>>;
  replay(stream: StreamId): Promise<readonly HarnessEvent<string, unknown>[]>;
}
```

The first implementation may be local and simple. The interface must permit later durable/remote stores without changing event meaning.

## Benchmark instrumentation

Every Kernel execution must be able to associate:

- Work and Attempt identity;
- code/artifact identity before and after;
- provider/model/host identity;
- ContextPack identity when present;
- human interventions;
- elapsed time;
- worker/model usage when available;
- verification and acceptance evidence;
- terminal outcome.

The benchmark contract is defined in `BENCHMARK_CONTRACT.md`.

## Kernel 0.1 exit criteria

Kernel 0.1 is proven only when all of the following are true:

1. The portable core has zero DSH/Rhiz Protocol imports.
2. A WorkContract can run through the DSH HostAdapter.
3. At least two WorkerProviders can satisfy the same portable WorkerProvider contract.
4. Killing/interruption of a worker does not erase Work state.
5. The complete Board state can be rebuilt from Ledger events.
6. Worker finish, verification, and acceptance are separately demonstrated.
7. A deterministic test proves a contradictory runtime observation cannot silently overwrite Board state.
8. A benchmark fixture compares a baseline execution with a Rhiz execution using the same task/code identity.
9. Provenance exists for every imported/adapted upstream component.
10. Rhiz Protocol can consume the package without the package importing Rhiz Protocol.
