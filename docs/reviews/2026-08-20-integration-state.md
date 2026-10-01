# Integration state: what is between here and a Harness we can code with

Date: 2026-08-20
Author: independent review pass, read-only against every branch
Companion to: `2026-08-20-stack-review.md` (defect findings)

The prior review asked whether this Harness is safe to point at a production repository. This one asks a different question: what stands between the code that exists today and a Harness the team can actually use to build and improve Rhiz.

The answer is not a missing module. Every module needed for the first useful loop already exists. The gap is that none of them call each other, and none of them are on a single line.

## Finding 1: five modules, zero call sites

Measured across every branch, ignoring each module's own file and its own test:

| Module | Branch | Lines shipped | Call sites outside `src/index.ts` |
| --- | --- | --- | --- |
| Guard | `feat/guard-v0` (#8) | 429 src, 486 test | 0 |
| Refiner | `feat/refiner-v1` (#24) | 584 src, 640 test | 0 |
| Context | `feat/context-v0` (#25) | 651 src, 560 test | 0 |
| Router | `feat/router-v0` (#26) | 860 src, 538 test | 0 |

Roughly 5,300 lines of well-typed, well-tested, ADR-backed capability, and the only thing any of it is connected to is a barrel export. `CrewSupervisor` is the sole orchestrator in the repository, and it calls none of them: it does not select context, does not route, does not consult an authority oracle, and does not emit anything a Refiner could learn from.

Each module is individually good. Collectively they are inventory, not a system.

## Finding 2: nothing has landed

`main` contains eight documents and a stray empty file named `tmp`. It contains no source code at all.

Twelve pull requests are open. Zero are merged. The dependency shape is a seven-deep chain with four siblings hanging off its tip:

```text
main
 └─ #1  kernel + DSH host adapter
     └─ #2  workers
         └─ #3  DSH product routes
             └─ #5  crew
                 └─ #6  verify
                     └─ #7  durable ledger
                         ├─ #8   guard
                         ├─ #24  refiner
                         ├─ #25  context
                         ├─ #26  router
                         └─ #27  defect proofs
```

Every day this holds, the cost of assembling it rises, and every new module is authored against a base that is itself unlanded.

## Finding 3: the siblings already collide

Measured with `git merge-tree` against the shared base, four of six sibling pairs conflict:

| Pair | Result | File |
| --- | --- | --- |
| guard x refiner | conflict | `src/index.ts` |
| guard x context | conflict | `src/index.ts` |
| refiner x context | conflict | `src/index.ts` |
| refiner x router | conflict | `src/schemas.ts` |
| guard x router | clean | |
| context x router | clean | |

Three of the four are the same trivial cause: every module appends one `export * from "./<module>.js"` line to the end of one barrel file, so any two modules touch the same last line. That is a mechanical problem with a mechanical fix, and it will recur on every future module until the fix lands.

`refiner x router` is a real one. Both extend `src/schemas.ts`, which is the shared kernel vocabulary, and that conflict needs a human decision about the merged event vocabulary rather than a textual resolution.

## Finding 4: the human surface is designed and unbuilt

`docs/decisions/0006-inline-cli-and-proof-first-developer-experience.md` on `docs/developer-experience-v1` is a 707-line architecture for the CLI, superseding ADR 0005, with a five-minute first-run promise, `rhiz init` as detect/prove/propose/commit, and acceptance tests an implementation must pass. It is careful, and it is explicit that no CLI, rendering layer, config loader, or human surface exists on any stream.

That ADR is the correct target. Nothing currently implements any of it. Until something does, the Harness has no entry point: there is no `bin`, no command, and no way for a person to run one Work item without writing TypeScript against the library.

## Why this is structural, not accidental

Five agents are working this repository in parallel, each on its own module branch. That structure optimizes hard for module production and has nobody accountable for composition. The incentive at every step is to add a new stream, because a new stream is clean, self-contained, testable, and mergeable in isolation. Integration is none of those things, so it never gets picked up.

The visible symptom is that the repository grew four new modules while carrying two unfixed P0 defects that make the one existing execution path unsafe to run.

## The sequence

Ordered by what unblocks the most. Steps 1 and 2 are prerequisites for everything else.

### S1. Get one canonical line

Land the seven-deep chain to `main`, then the siblings. `docs/decision-record` already assembles most of this locally and is now pushed, which makes it a useful reference for what the merged tree looks like, but the chain should land through its PRs so the review history survives.

Before the siblings land, fix the barrel pattern once: replace the single appended export list in `src/index.ts` with either one export line per module added in sorted position, or a generated barrel with a check that fails when it drifts. Three of the four current conflicts disappear and future modules stop colliding by construction.

`refiner x router` in `src/schemas.ts` needs an owner to reconcile the event vocabulary before both land.

### S2. Fix issue #9, workspace binding

This is the keystone for the stated goal. Today a Worker cannot be told which workspace to execute in, so the Harness edits whatever directory the host was constructed with while the Board reports on a pristine worktree. A Harness that cannot reliably edit the intended tree cannot be used to improve this system, whatever else it does. Proven mechanically as `PROOF #9` in #27.

Issue #10, the git-scoped identity digest, should land with it. The two together are what make an execution result trustworthy.

### S3. Wire one execution path end to end

One path, not a framework. Concretely, `CrewSupervisor.#runMission` becomes the composition point:

1. **Context** selects a `ContextPack` for the mission and records what it selected, instead of the current raw objective string.
2. **Router** chooses the worker from measured evidence, replacing the current first-eligible-provider walk in `CatalogCrewWorkerResolver`.
3. **Guard** evaluates tool calls at the adapter's permission callback, which requires the mediation seam described in #11 and in the Guard review on #8. This is the only step of the four that needs new adapter surface rather than a call site.
4. **Verify** already runs after execution; the missing piece is Crew handing the exact target forward automatically rather than a caller assembling it.
5. **Ledger** already records everything, and needs the `guard.evaluated` event type so authority decisions survive replay.
6. **Refiner** consumes the finished stream and proposes lessons.

Each of those is a call site plus an event type. None requires a new module.

### S4. Build the CLI to ADR 0006

With S1 through S3 done, the CLI is a surface over a spine that works, and the five-minute promise is testable. Built before them, it is a surface over inventory.

### S5. Dogfood the fix list

The first real Work item the Harness runs should be a fix from its own issue tracker. Issues #9 through #22 are a ready-made backlog with reproductions and regression tests already written. That is the shortest path from "the Harness runs" to "the Harness improves Rhiz", and every fix it lands is evidence for the benchmark the Constitution actually cares about.

## What not to do next

Do not add a sixth module. Context, Router, Guard, and Refiner are the complete set needed for the first useful loop, and none of them is connected. A new stream would add capability the system still cannot reach, deepen the merge debt, and collide with the same two shared files.

The next merge should reduce the number of unconnected modules, not raise it.
