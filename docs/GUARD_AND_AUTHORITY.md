# Guard and Authority

Status: current concept and operator guide. Exact behavior lives in `src/guard.ts`, `src/contract-bound-authority.ts`, worker adapters, tests, and accepted ADRs.

## Purpose

Guard exists to turn Work authority into a mechanical decision at consequential execution seams.

A model can receive instructions about policy. That is useful context. It is not enforcement.

Guard is where supported tool effects are evaluated outside model compliance.

## Authority begins in the WorkContract

`AuthorityPolicy` defines grants for named action classes and may mark selected actions in `requiresHumanApproval`.

Current action classes:

```text
read
write
execute
approve
publish
spend
external-mutate
```

Authority grants can name resource scopes and constraints.

Guard does not invent broader authority. It evaluates the effect against authority already granted by the Work and the execution environment.

`requiresHumanApproval` is portable policy data. A concrete product/host surface still has to authenticate the person and enforce the approval interaction for that requirement to become a real identity boundary.

## Tool categories

Guard normalizes native tool calls into portable categories:

```text
read
write
shell
network
credential
external-mutate
other
```

A provider-specific operation must be translated into one of these categories before the portable policy can reason about it.

## Decision model

A Guard verdict is one of:

- `allow`: the effect may proceed under the evaluated policy;
- `prompt`: policy requires a decision path rather than automatic execution;
- `forbid`: the effect must not occur.

Verdicts carry:

- request id;
- rationale;
- risk level;
- Rules hit;
- policy backend and version when available;
- evaluation timestamp;
- duration.

The request id must match the request being evaluated.

## Native mediation

Write-capable worker routes must advertise `guardedToolMediation` to be eligible for an isolated-write Crew mission.

The provider receives a runtime-only mediation callback through worker start options. It must await the Guard decision at its native permission/tool seam before executing the effect.

This design matters because:

```text
prompt says "do not write"
```

and

```text
native write call is denied before effect
```

are different security properties.

Rhiz relies on the second where the host can expose it.

## Contract-bound authority

The contract-bound authority layer connects Work resources and execution effects. It derives what an Attempt may do from the Work rather than from a worker-authored interpretation.

The worker can request an effect. The worker cannot rewrite the authority envelope that judges the request.

## Write-scope defense in depth

Guard mediation is preventive. Crew workspace comparison is detective.

For SHIP Work:

1. Work declares write scope.
2. provider executes in the bound isolated workspace;
3. Guard mediates supported native writes;
4. Crew snapshots actual changed paths;
5. changes outside the allowed scope fail the mission.

Keeping both layers prevents a single provider integration defect from becoming the only line of defense.

## Durable Guard records

Crew requires its admission record before returning permission to perform a native
effect. A failed Ledger append therefore returns `forbid` with
`guard-record:required-write-failed`. Callers using advisory recording retain their
existing behavior; they must not claim reconstructible effect admission.

### Bound HTTP effects

An isolated worker may receive an optional host broker port through Crew. It names
an immutable HTTPS method, target and nonsecret headers. The Work must independently
grant `http-effect:<METHOD>:<URL>` with `read` for GET or `external-mutate` for POST.
Filesystem category authority grants no network or external-mutation permission.
Guard checks the exact binding; the broker performs the request only after durable
admission and a current Attempt lease. Human approval requirements remain refusals.

Credentials stay in a host callback. The sandboxed worker has no direct network
access and may invoke only the named effect. Redirects and automatic retries are
disabled. A lost response after dispatch means unknown outcome, never evidence that
no write happened. The contained HTTP worker reserves its private response artifact
under Guard before mutation. Independent Verify and human acceptance remain separate
from a successful HTTP response, and software acceptance asserts no customer Outcome.

The live Guard decision may inspect raw arguments. Durable evidence stores a bounded summary:

- argument keys;
- key count;
- byte size;
- digest.

This preserves correlation and auditability while reducing the chance that file bodies, diffs, or credentials become permanent append-only log contents.

## Rules and Guard

A Rule with binding mode `mechanized` names a Guard or equivalent deterministic mechanism.

The Rule catalog saying a Guard should enforce something is not proof that the Guard is active. Rule selection receives the set of guard ids proven active in the current execution environment.

If the named Guard is not proven active, the Rule remains in Context. The system pays the context cost rather than silently pretending enforcement exists.

## Falsifiable guards

The guard manifest ties declared safety properties to falsifiers. The repository gate verifies that removing or breaking the named mechanism makes a corresponding proof fail.

A guard without a discriminating failure test is a weaker claim than a guard whose absence is mechanically detected.

Current local checks include:

```bash
npm run check:guards
npm run proof:falsifiability
```

The full authority proof remains:

```bash
npm run check
```

## Human approval and audit labels

The portable schemas use `ActorRef` to record actor id and kind. Some exception paths require the recorded actor kind to equal `human`, including explicit provider authorization and falsifiability exemptions.

That check is an audit constraint, not authentication. `ActorRef.kind` is self-declared data. The source explicitly warns that a `kind: "human"` record claims who acted but does not grant permission to act.

Consequential product paths therefore need two layers:

1. the portable record saying which human approval or exception was claimed; and
2. a concrete authenticated identity/permission mechanism that proves the person was allowed to make that decision before the record is emitted.

Even a properly authenticated approval cannot create a technical capability the provider lacks. In particular, approval cannot create `bindsWorkspace: true`, guarded tool mediation, or a physical containment primitive.

Organizational authorization and technical capability proof remain separate facts.

## Adding a new Guard rule

A change should include:

1. the threatened effect or invariant;
2. the exact decision point where the effect can be intercepted;
3. typed request data sufficient to evaluate the effect;
4. a fail-closed default when required facts are missing;
5. bounded durable evidence of the evaluation;
6. a falsifier that fails when the mechanism is removed;
7. an ADR when the change creates a new architecture or authority boundary.

## Operational rule

Never fix an authority defect only by adding stronger prompt wording. If the risk is consequential enough to constrain, move the constraint to a mechanical seam and keep the prompt as explanation.
