# Board and Events

Status: current reader guide. Exact event schemas live in `src/schemas.ts`; exact projection semantics live in `src/board.ts` and tests.

## Purpose

Board is the canonical owner of organizational Work state. Ledger owns the durable events from which Board is projected.

```text
append-only Work events
        |
        v
      Board
        |
        v
current organizational projection
```

Board is a projection, not an independent mutable database. Replaying the same valid event stream should reconstruct the same state.

## Why a projection

Workers, processes, sessions, filesystems, and UIs can disagree about what appears to be happening. Rhiz avoids giving any of those observations implicit authority to rewrite organizational truth.

A process can be alive while Work is blocked. A worker can say "done" while verification is absent. A candidate can exist while acceptance is still false.

Typed events preserve those distinctions.

## Work states

The current portable Work states are:

| State | Meaning |
| --- | --- |
| `proposed` | Work exists but is not yet in an execution-ready projection |
| `ready` | Work is eligible for its next lifecycle action; after proof requirements pass this can mean ready for acceptance |
| `running` | an Attempt is executing |
| `blocked` | execution requires a decision or cannot currently proceed |
| `verifying` | execution candidate is awaiting or undergoing verification |
| `reviewing` | independent review is active or required before readiness |
| `parked` | Work is deliberately paused while its durable state is retained |
| `accepted` | a `work.accepted` event passed Board's acceptance gate and is durable |
| `rejected` | the organization recorded a rejection event |
| `cancelled` | Work was explicitly terminated |
| `failed` | the current projection reflects terminal failure under the applicable lifecycle path |

The same label can appear in runtime observations, but observation does not equal Board authority. `integration.execution-observed`, for example, carries an explicit observation source and observed time rather than silently setting Board state.

## Event envelope

Every `HarnessEvent` carries a common envelope:

```text
id
schemaVersion
streamId
workId
optional taskId
optional attemptId
actor
occurredAt
recordedAt
evidence[]
optional causationId
optional correlationId
type
payload
```

Event-specific payloads are strict schemas. Unknown fields are rejected at the contract boundary.

`actor` is an auditable claim. `ActorRef` validates id and declared kind but does not authenticate the actor behind the record.

## Current event vocabulary

### Work

```text
work.created
work.amended
work.accepted
work.rejected
work.cancelled
work.parked
work.released
```

### Task

```text
task.created
task.assigned
```

### Attempt

```text
attempt.started
attempt.lease-transferred
attempt.activity-observed
attempt.blocked
attempt.finished
attempt.failed
```

### Authority and Guard

```text
authority.granted
authority.denied
guard.evaluated
```

### Artifact

```text
artifact.observed
artifact.changed
```

### Decision

```text
decision.requested
decision.resolved
```

### Verification

```text
verification.started
verification.result
```

### Review

```text
review.started
review.finding
review.result
```

### Integration

```text
integration.initialized
integration.checkpoint-recorded
integration.execution-observed
```

### Router

```text
router.decision-made
```

### Refiner

```text
refiner.proposed
refiner.accepted
refiner.rejected
refiner.promoted
```

Adding an event type changes the durable protocol. Treat it as a compatibility decision, not a casual log message.

## Work creation and amendment

`work.created` carries the original `WorkContract` and contract revision 1.

`work.amended` records explicit changes, the new revision, and a reason. The current amendment schema can change objective, scope, write scope, non-goals, authority, criteria, evidence requirements, context, dependencies, and worker policy.

`verificationPolicy` is intentionally excluded from the amendment schema. Changing that verification authority requires new Work rather than allowing a later event to rewrite who may certify the existing Work.

This is an important trust boundary: a mutable verification authority could authorize itself after Work creation.

The source also explicitly warns that `authorizedBy.kind === "human"` is an audit label, not authorization. Any product surface creating a human-only record must authenticate that identity outside the portable ActorRef shape.

## Task and Attempt identity

A Task is a schedulable piece of Work. An Attempt is one execution of a Task.

Attempt events require both `taskId` and `attemptId`. An Attempt can fail while the Work remains recoverable and eligible for another bounded path.

An `attempt.finished` event means execution finished. It does not mean verification passed or Work was accepted.

## Attempt leases

Write-capable execution can carry an `AttemptLease` with:

- lease id;
- workspace id;
- bounded logical resource claims;
- acquisition time;
- expiration time.

Lease transfer mints a new lease identity and preserves the prior executor history. Transfer does not erase independence conflicts for later REVIEW, verification, or acceptance executor-separation decisions.

Logical path claims normalize separators and path segments and reject escapes above the workspace root.

## Activity observations

`attempt.activity-observed` carries:

```text
working
idle
waiting
unknown
```

plus a source and the literal authority classification `observation`.

That field exists to make the limitation explicit. Liveness/progress telemetry informs supervision; it does not own lifecycle truth.

## Authority and Guard events

Authority grant/deny events preserve the policy and reason.

`guard.evaluated` records the bounded durable form of a native tool decision, including argument shape/digest rather than raw sensitive tool bytes.

A Guard event proves the portable policy evaluation was recorded. Provider observations and tests establish whether the verdict was actually enforced at the native effect seam.

## Verification result

`verification.result` records:

- verification id;
- contract revision;
- pass/fail;
- criterion results;
- evidence satisfaction;
- falsifiability report.

The falsifiability report names both mechanically proven required criteria and exemptions recorded under actor claims. A reader can therefore see proof erosion from one event without reconstructing the entire verification plan.

A verification event does not automatically produce acceptance. Board evaluates current-revision proof, review requirements, open decisions, active lifecycles, parking, and executor independence when determining readiness.

## Acceptance readiness

`acceptanceReadiness(board)` currently checks the following before Board can accept Work:

- required passing verification exists for the current contract revision;
- an independent verifier is used when required;
- every required acceptance criterion is proven passing;
- every required evidence requirement is satisfied by an accepted evidence kind;
- artifact-identity evidence alone cannot satisfy a required evidence requirement;
- attestation-only verification has an independent passing review;
- `reviewRequired` has an independent passing current-revision review;
- no decision remains open;
- Work is not parked;
- no Attempt, verification, or review lifecycle remains active.

The `work.accepted` event adds one more gate: the event actor may not be any actor that has ever executed the Work.

This is the current executable acceptance boundary. Board does not additionally authenticate the actor or consult an organization-level permission registry.

## Work decisions

`work.accepted`, `work.rejected`, and `work.cancelled` carry reason and contract revision.

For `work.accepted`, Board validates the acceptance-readiness conditions above and executor separation. If they fail, Board records `acceptance-preconditions-not-met` instead of projecting accepted state.

`work.rejected` and `work.cancelled` require the current contract revision and then become terminal states under the current projection rules.

A product layer may impose stronger organizational identity/permission rules before emitting any of these decision events. Those stronger rules must not be inferred from `ActorRef.kind` alone.

Terminal decisions are not inferred from a worker result.

## Integration events

A Work may own one durable integration configuration and head.

`integration.checkpoint-recorded` requires Task and Attempt identity. Checkpoints are either:

- `wip-rescue`: recoverable Work state preserved under a Harness-owned rescue ref;
- `integration-candidate`: a candidate with passed verification bound to the exact checkpoint head.

An integration candidate cannot claim passed proof unless `proofHead` equals its exact `head` and a verification event is identified.

Current Board acceptance does not require that an integration candidate checkpoint exist. A product flow that makes acceptance, merge, publish, or deployment contingent on a preserved verified candidate must enforce that additional artifact-binding rule at its action boundary.

## Refiner events

Refiner proposals are durable because learning must be attributable to evidence and decisions.

Proposal kinds currently include Rule, Guard tuning, test, verifier, context strategy, routing policy, worker profile, tool, capability, documentation, benchmark, ADR, recovery behavior, and lesson fixture.

Promotion is explicit. A proposal does not become permanent policy merely because it exists.

## Projection violations

Board records projection violations when an event attempts an illegal state transition or violates a lifecycle invariant.

This is preferable to silently dropping the event or silently accepting it. The durable record preserves the attempted fact and the projection explains why it did not become canonical state.

A projection violation should be investigated as a lifecycle, authority, or event-producer defect.

## Event authoring rules

When adding or emitting a consequential event:

1. use the canonical Work stream;
2. identify the actor truthfully and authenticate it at the product boundary when permission depends on identity;
3. preserve Task/Attempt identity where required;
4. attach evidence references rather than unbounded evidence bodies;
5. use causation/correlation ids where they improve reconstructibility;
6. never encode canonical state solely in free-text detail;
7. parse through `HarnessEventSchema` before durable append;
8. add replay/projection tests;
9. consider migration/version impact for durable histories.

## Read deeper

- [Kernel 0.1](KERNEL_0_1.md)
- [Execution Lifecycle](EXECUTION_LIFECYCLE.md)
- [Ledger, Observability, and Recovery](LEDGER_OBSERVABILITY_RECOVERY.md)
- [Verification and Acceptance](VERIFICATION_AND_ACCEPTANCE.md)
- ADR 0001 in [Architecture Decision Records](decisions/README.md)
