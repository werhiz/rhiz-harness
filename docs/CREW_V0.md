# Crew v0

Crew v0 is the first portable orchestration layer above Rhiz Workers.

It turns a validated acyclic set of `WorkContract`s into a deterministic execution sequence while preserving the constitutional boundaries:

- Board owns canonical Work state.
- Workers execute Attempts; they do not verify or accept Work.
- Workspaces are explicit owned resources.
- SCOUT and REVIEW are read-only and fail if their workspace drifts.
- SHIP runs in a fresh isolated-write workspace and fails when changes escape `writeScope`.
- REVIEW inherits the exact SHIP workspace it examines and excludes the SHIP worker from selection.
- Workspace output remains available after execution until the caller explicitly closes the Crew run handle.

## Mission forms

| Work type | Workspace | Worker policy |
|---|---|---|
| `SCOUT` | fresh, read-only | dangerous workers rejected; `none` write classification |
| `SHIP` | fresh, isolated-write | dangerous workers rejected; `workspace` write classification; guarded tool mediation required |
| `REVIEW` | inherited from a direct SHIP dependency, read-only | direct dependency workers excluded |

Crew v0 is sequential by design: `maxParallel` is fixed at `1`, `maxAttempts` must be `1`, and parallel attempts are rejected. This keeps workspace reset, retry, and merge semantics explicit rather than accidental.

## Execution path

```text
CrewPlan
  -> validate unique Work identities and acyclic dependencies
  -> acquire or inherit a workspace
  -> snapshot before execution
  -> select a policy-compatible WorkerProvider
  -> append Work / Task / Attempt events
  -> execute one bounded Attempt
  -> append observations
  -> snapshot after execution
  -> enforce read-only or writeScope policy
  -> project Board state
  -> return an execution receipt
  -> retain workspace until explicit cleanup
```

Direct dependency execution reports are passed forward as clearly labeled, unverified context. They do not become evidence, verification, or expanded authority.

A successful mission ends at Board state `verifying`. Crew completion means execution completed and is ready for Verify. It never means organizational acceptance.

## Git worktree provider

`GitWorktreeWorkspaceProvider` creates detached worktrees from one exact base revision. It:

- resolves and records the exact commit;
- owns one stable workspace identity across SHIP-to-REVIEW handoff;
- captures HEAD, Git status, binary diffs, staged diffs, and untracked file bytes in a digest;
- reports changed paths deterministically;
- removes only worktrees it owns;
- leaves the source working tree unchanged.

Read-only enforcement in v0 is fail-closed drift detection after execution. Preventive filesystem/tool enforcement belongs to Guard.

## Acceptance gate

Crew v0 is proven when:

- plan cycles, missing dependencies, ambiguous REVIEW workspaces, retries, and parallel attempts fail closed;
- SCOUT, SHIP, and REVIEW execute in dependency order;
- dependency reports are forwarded as unverified context;
- REVIEW uses the SHIP workspace and a different worker;
- read-only drift fails and blocks downstream missions;
- SHIP paths outside `writeScope` fail;
- worker completion projects Board to `verifying`, never accepted;
- workspaces survive the run for inspection and are removed only by explicit close;
- the real Git worktree provider preserves source-repository cleanliness;
- all prior Kernel, DSH, and Workers proof remains green.

## Deferred

- OS-level containment of a worker process (issue #11, a P0 gate; workspace
  binding says where work is supposed to happen, not where it can happen);
- retry/reset semantics;
- parallel missions;
- branch/commit publication;
- merge conflict resolution;
- persistent Crew state across process restarts;
- Verify and acceptance;
- learned routing;
- preventive write guards beyond the Guard mediation seam an `isolated-write` mission now requires of its worker (`docs/decisions/0008-policy-oracle.md`).
