# Lesson 0002: Product proofs belong in disposable workspaces

## Observation

A live coding-agent proof can mutate the repository it is meant to validate, even when the requested task is read-only. Prompt authority alone cannot prove the absence of side effects.

## Reusable lesson

A credentialed worker proof should run from the same immutable base revision in a disposable workspace, fingerprint that workspace before and after execution, and remove it regardless of outcome. The source workspace must receive its own before-and-after fingerprint.

## Mechanized correction

The DSH product operator proof now:

- creates one detached Git worktree per product route;
- runs Codex and Claude Code sequentially against the same HEAD and WorkContract;
- records only hashed summaries and safe proof facts;
- fails when either disposable worktree changes;
- fails when the source workspace changes;
- removes each proof worktree in `finally` cleanup;
- leaves verification and acceptance outside the worker's authority.

## Compound destination

This pattern should become a shared Workspace/Sandbox primitive before SHIP work is enabled. Crew should allocate disposable workspaces mechanically rather than relying on each WorkerProvider to implement isolation correctly.
