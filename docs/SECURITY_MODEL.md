# Security Model

Status: current security synthesis. Exact enforcement authority lives in shipped code, guard proofs, containment code, Work schemas, and accepted ADRs.

## Security objective

Rhiz Harness runs software-writing agents and tools against valuable repositories. The security goal is to ensure that useful autonomy remains inside explicit organizational authority and that claims about safety are backed by mechanisms and evidence rather than prompt wording.

The governing principle is Constitution invariant 9:

> Authority is explicit and bounded. Prompt text alone is not an enforcement boundary.

## Trust model

Treat these inputs as independently fallible or untrusted unless a stronger mechanism proves otherwise:

- model output;
- repository content;
- issue and ticket text;
- dependency documentation;
- worker summaries;
- artifact claims;
- tool output;
- runtime observations;
- external service responses;
- provider self-description until validated through the Harness contract;
- actor-kind labels until a real identity/permission boundary authenticates them.

`ActorRef` records an actor id and declared kind such as `human`, `agent`, or `service`. The portable schema does not authenticate that identity. A schema path that requires `kind: "human"` records and validates the claimed actor class; the source explicitly treats that field as an audit label rather than permission to act.

A real product surface must bind sensitive human decisions to authenticated identity and organizational permission outside the self-declared `ActorRef` field.

## Defense layers

Rhiz uses layered controls:

```text
validated WorkContract
+ explicit AuthorityPolicy
+ capability-aware worker selection
+ exact workspace binding
+ process / OS containment where required and shipped
+ Guard mediation at native tool seams
+ write-scope validation
+ tainted-data separation
+ exact artifact identity
+ independent verification
+ falsifiable proof controls
+ Board acceptance readiness + executor exclusion
+ product/integration identity authority where consequential
+ durable Ledger evidence
```

Each layer covers a different failure class.

## WorkContract authority

Every substantial task carries an explicit authority policy. Current action classes are:

```text
read
write
execute
approve
publish
spend
external-mutate
```

Grants can name resources and constraints. `requiresHumanApproval` can mark action classes that organizational policy intends to reserve for human approval.

That field is machine-readable policy data. It does not, by itself, authenticate a human approver. The concrete product/host integration must supply the identity and approval mechanism that makes the requirement real at the effect seam.

A contract that does not grant an action does not become permissive because a model argues that the action is useful.

## Provider capability classification

Workers declare capabilities and safety properties. Silence is not interpreted as safety.

Provider selection can require:

- supported Work type;
- workspace binding;
- compatible write-access classification;
- guarded native-tool mediation;
- cancellation and other operational capabilities.

The schema can carry a provider authorization record whose `authorizedBy.kind` must be `human`. That record is auditable policy data, not proof that the named actor was authenticated. Even with a valid record, authorization cannot create missing workspace binding or Guard mediation.

## Workspace binding

A worker executes against an explicit `WorkspaceBinding`. Crew-launched work does not fall back to the operator's current working directory.

For Git repository Work, isolated worktrees are the current workspace mechanism. SHIP uses an isolated-write worktree. SCOUT and REVIEW are read-only at the Crew policy layer.

Binding proves where the worker is intended to execute. It is different from OS containment. The architecture keeps those claims separate.

## OS and process containment

Accepted ADRs define containment for verifier and worker paths. Concrete containment mechanisms are tested and documented where shipped.

Containment is treated as a specific property, not a blanket statement that the process is safe. Environment forwarding, process-group ownership, scratch homes, filesystem constraints, and execution boundaries are evaluated independently.

When a required containment property cannot be proven for the current environment, fail-closed behavior is preferred over an optimistic tag.

## Guard native-tool mediation

Guard is the deterministic policy boundary for supported tool calls.

A Guard request includes:

- request id;
- tool name and category;
- arguments for the live decision;
- Work, Task, and Attempt identity;
- actor;
- write classification;
- context hash;
- evidence references;
- time.

Guard returns:

```text
allow
prompt
forbid
```

with rationale, risk, rule hits, policy backend, and timing.

Write-capable Crew missions require a provider that supports guarded tool mediation. The worker must wait for the verdict at the provider's native permission seam. A `forbid` does not become advisory text in the worker prompt.

## Durable Guard evidence and sensitive arguments

Raw tool arguments can contain file bodies, diffs, credentials, or other sensitive bytes. Durable Guard records therefore keep a bounded summary of argument shape and a digest rather than blindly persisting raw arguments forever.

The live authorization decision can use the actual arguments. The durable Ledger keeps enough structure to correlate and audit the decision without turning the event log into an unredactable secret store.

## Write-scope enforcement

SHIP Work declares `writeScope`. Crew snapshots the workspace before and after execution and compares actual changed paths with contract-derived allowed scopes.

A worker that writes outside scope fails the mission even when its model summary claims success.

This post-execution check complements preventive Guard mediation. Preventive controls reduce unauthorized effects. Exact changed-path validation catches drift at the artifact layer.

## Prompt injection and tainted data

Worker-authored dependency output is explicitly treated as untrusted data.

`TaintedString` and `TaintedAttachment` carry bounded bytes plus provenance. Crew keeps the downstream `objective` limited to Work intent and passes dependency reports separately. Codex and DSH adapters render those attachments in fenced untrusted-data sections outside the Work contract instruction channel.

This closes a concrete instruction-splicing path. It should not be generalized into a claim that all prompt injection is solved. Repository content and other external text remain potentially adversarial data and must be handled through the broader authority, tool mediation, context, and verification model.

## Verification as a security boundary

A worker cannot certify its own success merely by saying it finished.

Verify binds checks to the exact candidate it examines, uses independent verifier actors, rejects workspace drift during proof, and supports negative controls that prove a verifier detects a known failure.

This defends against:

- false completion reports;
- vacuous tests;
- checks aimed at the wrong artifact;
- proof copied from an earlier tree;
- self-certification by the executing worker.

The exact-target proof establishes the identity of the candidate at verification time. A later product acceptance surface must ensure the candidate being accepted still corresponds to the intended verified artifact if mutable state exists between those steps.

## Falsifiability

A declared Guard or proof mechanism should have a test that fails when the mechanism is removed or broken.

The repository maintains a guard manifest and a falsifiability gate. The point is stronger than code coverage: a safety claim should have an executable discriminator that demonstrates the system notices when the claim becomes false.

Named exemptions are narrow and visible. The schema requires an exemption record to name an actor claiming `kind: "human"`; that remains an auditable claim rather than authenticated human identity. Exemptions do not silently convert missing proof into proof.

## Acceptance boundary

Verification can establish evidence. It does not make the organizational decision.

Current Board code requires acceptance readiness and refuses a `work.accepted` event from any actor that has executed the Work. This is a real, falsified executor-separation guard.

Board does not currently authenticate actor identity or consult a separate organization-level permission registry before projecting acceptance. The current repository runner stops at `ready` with `accepted: false` and exposes no acceptance command. Authenticated human approval must therefore be supplied by the product/integration surface before it emits the acceptance event.

This distinction is security-significant: `kind: "human"` is not an authentication factor.

## Durable evidence and replay

Ledger history is append-only and replayable. Consequential events survive process death. Board state can be rebuilt from those events.

Durability is a security property because it prevents a crashed or restarted coordinator from silently forgetting denials, violations, evidence, prior executors, or organizational decisions.

## Threats the architecture explicitly considers

- worker writes outside scope;
- provider executes in the wrong directory;
- unclassified provider receives write authority;
- worker or verifier self-certifies success;
- verification targets the wrong tree;
- test suite passes vacuously;
- negative control mutates the canonical candidate;
- dependency worker output becomes downstream instruction;
- raw tool arguments leak into permanent logs;
- runtime liveness is mistaken for Work progress;
- process crash erases Work state;
- a prior executor becomes an independent verifier through lease handoff;
- an execution actor accepts its own Work;
- a self-declared actor-kind label is mistaken for authenticated human authority;
- a worker tries to claim merge, publication, or other authority it does not hold.

## Security review rule

When adding a new capability, answer five questions:

1. What exact authority does it introduce?
2. Where is that authority mechanically enforced?
3. What durable evidence proves the enforcement ran?
4. What executable falsifier turns red if the mechanism disappears?
5. What remains unproven after this change?

A security change should narrow claims to what the mechanism actually establishes.

## Reporting vulnerabilities

Use the repository process in [`SECURITY.md`](../SECURITY.md). Do not disclose exploit details in a public issue once the repository is public.
