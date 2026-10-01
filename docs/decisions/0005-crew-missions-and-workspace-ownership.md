# ADR 0005: Crew missions and explicit workspace ownership

Status: accepted for Crew v0

## Context

Rhiz now has portable Work, Board, Ledger, Host, and Worker contracts plus proven Codex and Claude Code routes through DSH. Launching multiple workers without explicit dependency, workspace, and independence semantics would multiply coordination ambiguity.

First Mate and related systems demonstrate the value of bounded crew missions and disposable worktrees. Rhiz needs those mechanics under its own authority, evidence, and Board model.

## Decision

1. A Crew plan is a validated directed acyclic graph of canonical `WorkContract`s. Work dependencies remain the single dependency source of truth.
2. Crew v0 executes sequentially. Retry and parallel behavior are rejected until workspace reset and merge semantics are designed.
3. Every mission owns an explicit workspace lease:
   - SCOUT receives a fresh read-only workspace;
   - SHIP receives a fresh isolated-write workspace;
   - REVIEW inherits the exact workspace of one direct SHIP dependency in read-only mode.
4. Direct dependency execution reports are forwarded as labeled, unverified context. They do not become evidence or authority.
5. Read-only missions fail if the workspace digest changes.
6. SHIP fails if HEAD moves or any changed path falls outside `WorkContract.writeScope`.
7. REVIEW excludes the worker that executed each direct dependency. Independence is structural selection policy, not prompt language.
8. Workspace binding belongs between Crew and the Host adapter. Generic Worker contracts do not carry local filesystem paths.
9. Crew emits ordinary Work, Task, Attempt, and observation events into the existing Ledger. It does not create a parallel organizational truth system.
10. A successful mission ends at Board state `verifying`. Crew never emits verification or acceptance.
11. Workspaces remain available after execution. The returned run handle owns explicit, idempotent cleanup.

## Consequences

- Multiple workers can form a disciplined execution sequence without gaining authority over Work truth.
- SHIP output can be inspected by an independent REVIEW worker in the exact same workspace.
- Source repositories remain separate from disposable execution state.
- Failures block dependent missions but do not erase independent completed work or workspace evidence.
- DSH-specific workspace binding can be added behind a Crew worker resolver without changing CrewPlan or WorkContract.
- Preventive Guard enforcement remains a later layer; v0 detects and rejects unauthorized workspace change.
