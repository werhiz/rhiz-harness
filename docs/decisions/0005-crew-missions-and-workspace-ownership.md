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
   - REVIEW inherits the exact workspace of one direct SHIP dependency in read-only mode, or receives a fresh read-only workspace for existing evidence with no dependencies (2026-10-10 amendment below).
4. Direct dependency execution reports are forwarded as labeled, unverified context. They do not become evidence or authority.
5. Read-only missions fail if the workspace digest changes.
6. SHIP fails if HEAD moves or any changed path falls outside `WorkContract.writeScope`.
7. REVIEW excludes the worker that executed each direct dependency. Independence is structural selection policy, not prompt language.
8. Workspace binding belongs between Crew and the Host adapter. Generic Worker contracts do not carry local filesystem paths.
9. Crew emits ordinary Work, Task, Attempt, and observation events into the existing Ledger. It does not create a parallel organizational truth system.
10. A successful mission ends at Board state `verifying`. Crew never emits verification or acceptance.
11. Workspaces remain available after execution. The returned run handle owns explicit, idempotent cleanup.

## Amendment: fresh evidence REVIEW (2026-10-10)

A consumer's prospective review of existing, pinned source was refused before
execution: REVIEW required a SHIP dependency, while the contained local command
provider cannot perform SHIP's synchronous native tool mediation. Inventing a SHIP
dependency or a second consumer runner would misrepresent the work.

REVIEW may use a fresh read-only workspace with no dependencies at the Crew plan's
declared base revision. Git acquisition resolves that base and records the exact HEAD
and content digest before execution. Work scope identifies the source or evidence
being evaluated; the new Work does not claim authorship of the earlier implementation.
Dependency review still inherits exactly one SHIP workspace and excludes its executor.
Both forms require independentActor=true, empty production write scope, normal worker
admission, unchanged workspace identity, and independent Verify/review before acceptance.

The existing local command provider has an opt-in readOnly mode. It declares
writeAccess: none, refuses write-enabled workspace or Work inputs, and permits only
contained scratch HOME writes. Scratch HOME and the execution root must be physically
disjoint after resolving symlinks, in both containment directions. Source writes and
network remain denied by the OS launcher, which fails closed when unavailable. Reads
remain unrestricted as described in ADR 0020. This mode does not claim guarded tool
mediation or relax SHIP admission. Crew remains the lifecycle orchestrator; no new
event vocabulary, runner, or acceptance path is introduced.

The existing Crew and worker-containment suites cover plan admission, a real contained
REVIEW with a durable Ledger, independent Verify with an isolated negative control,
and independent review. They also prove scratch writes, source/outside-write denial,
network denial against a reachable loopback endpoint, unavailable-launcher refusal,
and scratch alias refusal. The actual OS-boundary proof runs on macOS; portable
admission tests do not substitute for it on other hosts.

## Consequences

- Multiple workers can form a disciplined execution sequence without gaining authority over Work truth.
- SHIP output can be inspected by an independent REVIEW worker in the exact same workspace.
- Source repositories remain separate from disposable execution state.
- Failures block dependent missions but do not erase independent completed work or workspace evidence.
- DSH-specific workspace binding can be added behind a Crew worker resolver without changing CrewPlan or WorkContract.
- Preventive Guard enforcement remains a later layer; v0 detects and rejects unauthorized workspace change.
