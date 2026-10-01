# Work Contracts

Status: current concept and contract guide. Exact schema authority lives in `src/schemas.ts`.

## Work is durable intent

A Work item is the durable unit of organizational intent in Rhiz Harness. Workers, processes, sessions, worktrees, and attempts may disappear. Work remains.

A `WorkContract` binds that intent to the scope, authority, evidence, and acceptance rules under which it may be executed.

## Contract shape

A WorkContract carries:

| Field | Meaning |
| --- | --- |
| `id` | durable Work identity |
| `objective` | desired result expressed as bounded intent |
| `type` | `SCOUT`, `SHIP`, or `REVIEW` |
| `scope` | resources the Work may consider |
| `writeScope` | resources SHIP Work may mutate |
| `nonGoals` | explicit boundaries on what the Work should not attempt |
| `authority` | allowed actions and human-approval requirements |
| `acceptanceCriteria` | conditions that must be accounted for before acceptance |
| `requiredEvidence` | evidence kinds needed to support acceptance |
| `context` | context strategy and resource request |
| `dependencies` | prerequisite Work identities |
| `workerPolicy` | provider preferences, attempt limits, parallelism, explicit provider-authorization records |
| `verificationPolicy` | independence, review, and falsifiability requirements |
| `createdBy` | actor claim that created the contract |
| `createdAt` | creation timestamp |

Schemas are strict. Extra fields, malformed identities, impossible combinations, or invalid exemption shapes fail validation rather than being silently ignored.

## Actor identity is an audit record

`ActorRef` contains an id, a declared kind, and an optional display name. Current kinds include `human`, `agent`, `service`, `automation`, and `verifier`.

The portable schema validates the shape of that record. It does not authenticate the actor. The source explicitly treats `authorizedBy.kind === "human"` as an audit label rather than permission to act.

Any product surface that relies on a human-only action must authenticate the person and enforce organizational permission before it writes the corresponding `ActorRef` into durable Work data or events.

## Work types

### SCOUT

SCOUT investigates, reads, analyzes, or produces evidence. It is structurally read-only.

Policy consequences:

- production `writeScope` is forbidden;
- dangerous or unclassified write-capable providers are not acceptable by default;
- a fresh read-only workspace is used in Crew;
- workspace drift fails the mission.

Use SCOUT for understanding before mutation, evidence gathering, repository mapping, design exploration, and other read-only work.

### SHIP

SHIP implements a bounded change.

Policy consequences:

- explicit `writeScope` defines what may change;
- the current Git implementation uses a fresh isolated-write worktree;
- the worker route must support workspace binding and guarded tool mediation;
- changed paths are compared against contract-derived allowed scopes;
- execution completion still requires independent verification before Board can become ready.

SHIP does not contain implicit permission to push, merge, deploy, publish, or accept the Work. Those actions require their own product/authority paths.

### REVIEW

REVIEW independently evaluates work or evidence.

Policy consequences:

- production `writeScope` is forbidden;
- Crew can inherit the exact SHIP workspace being reviewed;
- workers that executed direct SHIP dependencies are excluded from independent REVIEW selection;
- dependency worker summaries and artifact claims are tainted data, not trusted instructions or evidence.

REVIEW should preserve the distinction between implementation and certification.

## Authority policy

Authority uses named actions:

```text
read
write
execute
approve
publish
spend
external-mutate
```

Each grant may be constrained to specific resources and named constraints. `requiresHumanApproval` names action classes that organizational policy intends to reserve for human approval.

That field is policy data, not an authentication mechanism. The concrete effect surface must authenticate the approver and enforce the decision before a human-only action occurs.

AuthorityPolicy defines what the Work says may happen. It does not prove that a concrete worker or host can enforce that boundary. Provider capabilities, workspace binding, Guard mediation, sandboxing, and post-execution scope checks provide the enforcement layers.

## Scope and write scope

`scope` answers what the Work may reason about.

`writeScope` answers what SHIP Work may mutate.

They are deliberately separate. A worker may need to read an entire repository to safely edit one file. That does not grant write authority over the entire repository.

Repository runner candidate scopes are derived from Work resources and checked against actual changed paths. A write outside the allowed scope is a failed execution path, not an opportunity for the worker to reinterpret the contract.

## Non-goals

Non-goals are first-class boundaries. They make a contract more precise by naming adjacent work that should remain untouched.

Examples:

```text
Do not change public API behavior.
Do not add a dependency.
Do not access the network.
Do not modify generated files.
```

A non-goal is still prose. Where the restriction can be enforced mechanically, a corresponding authority restriction, Guard rule, sandbox control, or verifier should carry the actual enforcement.

## Acceptance criteria

Acceptance criteria describe what success means. Each criterion has a stable id, description, and required flag.

A WorkContract must contain at least one acceptance criterion. Required criteria must be covered by the verification policy and verification plan or by an explicit schema-supported exemption where permitted.

Criteria should be specific enough that another actor can determine whether the result satisfies them.

## Evidence requirements

Evidence requirements specify what kinds of evidence count for a claim. Current evidence kinds include:

```text
test
static-analysis
browser
review
diff
log
screenshot
receipt
artifact-identity
other
```

Evidence is attributable and durable. Artifact identity is especially important for proving what exact candidate was examined, though artifact identity alone does not establish behavioral correctness and cannot satisfy a required evidence requirement by itself at the Board gate.

## Worker policy

Worker policy controls provider selection and execution budget.

Current fields include:

- preferred provider ids;
- maximum attempts;
- whether parallel attempts are allowed;
- explicit provider-authorization records.

The schema requires each explicit provider authorization to name an `authorizedBy` actor declaring `kind: "human"`. This is an auditable record shape. The portable schema does not authenticate that human claim.

Even a valid provider-authorization record is narrow. It does not create capabilities the provider does not have, such as workspace binding or guarded tool mediation.

The current repository Work runner narrows the contract further to `maxAttempts = 1` and SHIP Work only.

## Verification policy

Verification policy separates worker completion from evidence-backed success.

It can require:

- verification at all;
- an independent actor;
- a separate review;
- named falsifiability exemptions for required criteria where the schema permits them.

For an exemption, the schema requires `authorizedBy.kind` to equal `human`. That records the claimed human owner of the exemption; it is not human authentication. A product that creates exemptions must enforce the real identity/permission step before storing the record.

The exemption remains visible in the verification receipt rather than disappearing from the record.

## Contract amendments

The architecture treats the initial contract as durable. Consequential changes to objective, scope, write scope, non-goals, authority, criteria, evidence requirements, context, dependencies, or worker policy belong in explicit amendment events rather than silent in-place mutation.

`verificationPolicy` is deliberately **not amendable**. The source treats verifier authority as fixed at `work.created`; changing who may verify requires creating new Work. This prevents a later amendment from installing a verifier policy that authorizes its own proof path.

An amendment also cannot occur while an Attempt, verification, or review lifecycle is active, and its revision must advance exactly once.

This preserves reconstructibility. A replay can explain what the organization believed the Work meant at each point while keeping the verification-authority boundary fixed for that Work identity.

## Example

```json
{
  "id": "work:add-json-output",
  "objective": "Add a --json output mode to the CLI without changing existing text output.",
  "type": "SHIP",
  "scope": [
    { "uri": "repo://acme", "kind": "repository" }
  ],
  "writeScope": [
    { "uri": "repo://acme/src/cli", "kind": "directory" },
    { "uri": "repo://acme/test/cli", "kind": "directory" }
  ],
  "nonGoals": [
    "Do not change existing text-mode output.",
    "Do not add dependencies."
  ],
  "authority": {
    "grants": [
      {
        "action": "read",
        "resources": [{ "uri": "repo://acme", "kind": "repository" }],
        "constraints": []
      },
      {
        "action": "write",
        "resources": [{ "uri": "repo://acme/src/cli", "kind": "directory" }],
        "constraints": []
      }
    ],
    "requiresHumanApproval": []
  },
  "acceptanceCriteria": [
    {
      "id": "criterion:json-output",
      "description": "--json emits valid machine-readable JSON.",
      "required": true
    },
    {
      "id": "criterion:text-unchanged",
      "description": "Existing text-mode behavior remains green.",
      "required": true
    }
  ],
  "requiredEvidence": [
    {
      "id": "evidence:tests",
      "description": "Automated tests cover JSON and existing text output.",
      "acceptedKinds": ["test"],
      "required": true
    }
  ],
  "context": {
    "strategy": "minimal",
    "resources": [],
    "includeHistory": true
  },
  "dependencies": [],
  "workerPolicy": {
    "preferredProviders": ["worker:codex-app-server"],
    "maxAttempts": 1,
    "allowParallelAttempts": false,
    "explicitProviderAuthorizations": []
  },
  "verificationPolicy": {
    "required": true,
    "independentActor": true,
    "reviewRequired": false,
    "falsifiabilityExemptions": []
  },
  "createdBy": {
    "id": "human:operator",
    "kind": "human"
  },
  "createdAt": "2026-08-28T20:00:00-04:00"
}
```

Treat examples as illustrative. Validate real contracts through `parseWorkContract` so the current schema remains the executable authority.
