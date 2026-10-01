# Verify v1

Verify v1 converts a Worker completion report into independently checkable evidence tied to one exact workspace state.

## Core rule

Worker completion is an execution fact. Verification is a separate lifecycle. Acceptance is a separate authorized decision.

```text
Attempt finished
  -> exact VerificationTarget captured
  -> deterministic checks run by an independent actor
  -> criterion and evidence requirements evaluated
  -> Board becomes ready or remains verifying
  -> exact target is rechecked
  -> authorized acceptance may occur
```

## Exact target

A `VerificationTarget` contains:

- workspace identity;
- workspace URI;
- exact HEAD;
- byte-sensitive workspace digest;
- deterministic changed-path list.

Verify snapshots the workspace before every check and immediately after every check. Any drift fails the verification. The receipt carries `artifact-identity` evidence with the target URI and digest. Acceptance snapshots the workspace again and refuses stale proof.

Artifact identity is the Harness-generated statement of which artifact was examined. It appears in more than one place: verification events, negative-control and error-path check results, passing criterion results, and the receipt. It never counts toward satisfying a required evidence requirement, in Verify or at the Board acceptance gate, even when the requirement lists `artifact-identity` among its accepted kinds. In the Verify engine, requirement satisfaction is computed only from evidence emitted by a passing primary check bound to that requirement. The Board acceptance reader applies the same kind rule to the `evidenceSatisfaction` the verification event carries, but does not check who produced that evidence or that a bound check emitted it (issue #62).

## Verification plans

A `VerificationPlan` is revision-bound and lists explicit checks. Every required acceptance criterion and required evidence requirement must be covered by at least one primary check.

Checks may declare `negativeControlFor`. Negative controls:

- exercise the same VerifierProvider as the primary check;
- cannot directly satisfy Work criteria or evidence requirements;
- MUST declare a `perturbation`: what to break, where, and why the check should notice it;
- run against an isolated throwaway copy of the execution root, never against the canonical target;
- are satisfied ONLY when the underlying verifier reports `fail` on that perturbed copy.

A control whose verifier returns `pass` has shown it cannot distinguish a known failure, and a control that errors has shown nothing at all. Both fail the whole verification.

### What changed and why (issue #13)

Until 2026-08-20 a control was satisfied by PASSING, nothing forced its config to differ from the primary's, and nothing ran it against a mutated target. A verifier wired to `/usr/bin/true`, a suite with zero assertions, or a deleted `npm test` script therefore satisfied primary and control identically. The mechanism built to catch false greens could not catch the most common false green in this repository's own history, which `docs/lessons/0001-smoke-gates-must-assert-intended-outcome.md` already records.

`perturbation` is `{ kind: "overwrite-file", path, content, description }`. `path` is relative to the execution root; absolute paths and `..` are rejected by the schema and again at the point of the write. A primary check may not declare a perturbation, and a control may not omit one, so the vacuous shape cannot be expressed in a valid plan.

Isolation is a real copy under the OS temp directory, made with symlinks preserved as links. After every control the canonical target is re-snapshotted; any drift is an error. The perturbation description is carried in the control's result summary so a reader of the receipt can see exactly what was falsified.

Cost, stated plainly: every negative control copies the execution root once. For a large tree that is real IO, and it is the price of a control that cannot contaminate what the primary was measured against.

## Verifier providers

Verify v1 accepts only providers that declare themselves:

- deterministic;
- read-only;
- explicit about the evidence kinds they emit.

A provider result fails closed when its identity, check identity, evidence kind, or result schema disagrees with its declaration.

## Local command verifier

`LocalCommandVerifierProvider` runs one explicit executable and argv array:

- no shell interpolation;
- bounded stdout and stderr;
- timeout with termination escalation;
- expected exit-code policy;
- digest-addressed evidence;
- conservative environment forwarding;
- no raw command output in the canonical summary.

Workspace immutability is enforced by the Verify engine around the command.

## Board behavior

A passing verification projects Work to:

- `ready` when no additional review is required;
- `reviewing` when the WorkContract requires review.

A failed verification leaves Work at `verifying`.

Verify never emits `work.accepted`. `acceptVerifiedWork` is a separate seam that:

1. requires a passing canonical verification receipt;
2. rechecks the exact target;
3. rechecks the canonical Work revision and Board readiness;
4. appends the authorized acceptance event;
5. proves the Board reached `accepted` without new projection violations.

## Acceptance gate

Verify v1 is proven when:

- stale targets fail before verification starts;
- execution actors cannot verify their own Work;
- non-deterministic or workspace-mutating providers fail before lifecycle start;
- required criteria and evidence requirements require primary coverage;
- negative controls are provider-bound and cannot satisfy requirements directly;
- passing checks must emit declared evidence;
- wrong evidence kinds fail required evidence satisfaction;
- artifact identity alone never satisfies a required evidence requirement;
- workspace drift during verification fails;
- passing verification produces `ready`, never `accepted`;
- post-verification drift blocks acceptance;
- local command checks and expected-failure controls work without a shell;
- all prior Kernel, DSH, Workers, and Crew proof remains green.

## Deferred

- sandboxed or remote verifier environments;
- durable storage of full stdout/stderr evidence objects;
- browser and deployment verifiers;
- automatic review result synthesis;
- policy-controlled acceptance actors;
- multi-artifact verification subjects;
- Board-level stale-artifact invalidation independent of the acceptance helper;
- cost and duration telemetry;
- learned verifier selection.
