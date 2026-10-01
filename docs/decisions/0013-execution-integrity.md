# 0013. Execution integrity: bind, deny, identify, falsify

Status: accepted
Date: 2026-08-20
Supersedes nothing. Amends 0003, 0005 and 0006.

## Context

An independent review of the stacked PRs at `feat/ledger-v1` produced four
findings that share one shape: the composed system failed **open**. Each was
turned into a characterization test in `test/defect-proofs.test.ts` so the
findings were mechanical evidence rather than claims in a document.

The four:

- **#9 (P0)** A Worker could not be told where to execute. `WorkerStartRequest`
  had no slot for a workspace, and `DshProductWorkerHost` fixed its `cwd` at
  construction from `options.cwd ?? process.cwd()`. Crew acquired a detached
  worktree, snapshotted it, ran a SHIP mission, snapshotted again, saw
  `changedPaths: []`, and projected Board to `verifying` while the subagent had
  been editing the operator's live checkout.
- **#18 (P1)** `WorkerProvider.describe()` was optional, and a provider that
  omitted it was synthesised as `writeAccess: "host-policy"`, `dangerous: false`.
  Crew allowed `host-policy` for SCOUT and REVIEW. Unknown resolved to permitted.
- **#10 (P0)** Workspace identity was git's opinion of the tree, and every part
  of it honoured `.gitignore`. A write to `node_modules/<dep>/index.js` left the
  digest byte-identical, and the verifier then loaded that module.
- **#13 (P1)** A negative control was satisfied by passing, was not required to
  differ from its primary, and did not run against a mutated target. An
  always-passing verifier satisfied its own control.

## Decision

### Execution location is part of the contract

`WorkspaceBinding` is a portable schema in `src/host.ts` carrying `workspaceId`,
`leaseId`, `uri`, `executionRoot`, `mode`, `baseRevision` and optional
`expectedHead` / `expectedDigest`. It is a deliberate copy of the fields a Crew
workspace exposes rather than an import of `CrewWorkspace`, because `src/` may
not depend on a concrete host and a Worker must be bindable by any supervisor.

`workspace` is **required** on `WorkerStartRequest`. Host-level `cwd` is deleted
rather than defaulted, and no `process.cwd()` fallback survives in `src/` or
`adapters/`. `bindsWorkspace` on `WorkerDescriptor` is the machine-checkable
claim that a provider executes where it was told, and Crew refuses a provider
that cannot make it.

### Unknown authority is denied authority

An undescribed provider is synthesised as `dangerous: true`,
`writeAccess: "unrestricted"`, `bindsWorkspace: false`. `host-policy` is dropped
from the allowed set for every mission type, because it is a synonym for "we do
not know". The only override is `workerPolicy.explicitProviderAuthorizations`,
which names an exact provider and requires a human actor, enforced in a
`superRefine` rather than merely typed.

### Identity covers the bytes that execute

`src/workspace-digest.ts` content-identifies the execution root: streaming
per-file hashing, symlinks hashed as their target and never followed, explicit
limits on entry count, per-file bytes and total bytes that **throw** rather than
truncate, and a narrow recorded exclusion list. The aggregate binds the scope as
well as the contents, so a digest taken with wider exclusions can never compare
equal to a narrower one.

`digestScope` is required on `CrewWorkspaceSnapshot` and `VerificationTarget`,
and `sameTarget` compares it. A receipt can no longer imply more coverage than
the walk provided.

`.git` is excluded because it is the mechanism used to observe the tree, not
execution input. That exclusion is only safe because every git invocation is now
hardened with `core.fsmonitor=`, `core.hooksPath=/dev/null`, `core.pager=cat`,
`protocol.ext.allow=never` and `GIT_CONFIG_NOSYSTEM=1`. All three of those config
keys execute programs during ordinary plumbing, so without the hardening a worker
could plant a hostile config in the one directory the digest declines to cover.

### A control must be able to falsify

A negative control requires a declared `perturbation`, runs against an isolated
throwaway copy of the execution root with that perturbation applied, and is
satisfied **only** when the underlying verifier reports `fail`. Pass means it
cannot distinguish a known failure; error means it proved nothing. Both fail the
verification. The canonical target is re-snapshotted after every control and any
drift is an error.

## Consequences

### Breaking

`workspace` required on `WorkerStartRequest` is a breaking change to the portable
contract. Any supervisor that is not Crew stops compiling until it supplies a
binding. This is intended: the alternative is a contract slot that is optional
in exactly the case where its absence is unsafe.

`digestScope` required on `CrewWorkspaceSnapshot` and `VerificationTarget` breaks
any external provider or fixture that constructs either by hand.

Providers reporting `writeAccess: "host-policy"` are no longer selectable for any
mission type. The DSH routes can honestly report `workspace` **because** #9 binds
them; the two fixes are load-bearing for each other and should not be split.

### Costs

Every negative control copies the execution root once. For a large tree that is
real IO. It is the price of a control that cannot contaminate what the primary
was measured against.

The digest walks the whole execution root including `node_modules`. Limits exist
and fail closed, so a tree past them stops verification rather than silently
producing a narrower identity.

### Not solved

**Issue #11 remains open and is a P0 gate.** There is still no OS-level
enforcement boundary. Authority reaches the worker as prompt text; `sandbox()`
returns `null` on both hosts; nothing confines a process to `executionRoot`.
Everything in this ADR is contract, identity and detection. A worker that decides
to write `~/.ssh/authorized_keys` is still neither prevented nor detected. Do not
read workspace binding as containment: binding says where work is *supposed* to
happen, and nothing yet makes that the only place it *can* happen.
