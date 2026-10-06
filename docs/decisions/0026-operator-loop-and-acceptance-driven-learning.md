# ADR 0026: The operator loop, and acceptance as the start of learning

Status: accepted

Refines `0015-inline-cli-and-proof-first-developer-experience.md` for the first shipped human
surface. It does not supersede 0015; where this ADR is silent, 0015 governs.

## Context

Three defects, each reproduced on `main` at `3092409`, meant that no accepted outcome had ever
reached Router or Refiner through a path a person could use.

1. **No human path to acceptance.** `scripts/run-repository-work.mjs` stops at `ready` by design
   ("It never merges a PR, deploys, publishes, or accepts the Work"). `acceptVerifiedWork` exists
   but requires a live `CrewWorkspace` that the runner's scratch directory no longer holds once the
   process exits. A verified Work could therefore never be accepted by anyone.
2. **The Refiner never sees success.** Crew hands a stream to the Refiner only when it is closed at
   attempt end, and `ready` is not closed. The runner receipt says so (`refiner: null`, "no outcome
   analysis until acceptance"), and nothing ran the analysis at acceptance. When it was run, every
   accepted Work was classified `high-quality-first-attempt`, including Work that needed a repair
   attempt.
3. **The Router learns from nothing.** `RouterBridge.route` passes no `streamIds`, and
   `computeRouterEvidence` returns `[]` for an empty list. Each repository Work also owns a separate
   Ledger, so even a correct stream list would only contain the Work about to be routed. PR #2 made
   Router evidence credit only independently verified, accepted attempts. No acceptance ever
   reached it.

## Decision

### D1. Operator verbs, one owner of each fact

`rhiz-harness start | status | resume | review | accept | reject | harvest` operate on repository Work.

| Verb | What it does | What owns the fact |
| --- | --- | --- |
| `start` | Runs SHIP Work in an isolated worktree until it is verified or its attempt budget is spent | Runner, Crew, Verify, Ledger |
| `status` | Projects every Work Ledger: state, attempts, verification, review, readiness, next action, metrics | Board projection, read-only |
| `resume` | Closes an attempt whose process ended without a terminal event as a recoverable failure, then spends the remaining budget on the same Work | Ledger attempt history |
| `review` | Records one complete independent review lifecycle against the verified candidate diff | Board review lifecycle |
| `accept` | Records the Board decision for a human actor, then hands the closed stream to Refiner and Router | Board acceptance |
| `reject` | Records a human rejection with attributable cause, requested repair, current criteria and evidence, then requests Harvest | Board rejection, Refiner proposals |
| `harvest` | Resumes proposal creation from a valid closed canonical stream, preserving existing proposals | Refiner, Ledger |

The portable logic lives in `src/operator.ts` and imports no host. The CLI
(`scripts/rhiz-harness.mjs`) is a local adapter. It keeps only the inputs needed to run the same
Work again, plus the last run receipt, under `<git-common-dir>/rhiz-harness/operator/`.

`start` names Work being started, which 0015 permits ("Work is started, attempts are run"). It is
not process vocabulary. The command is the generic over WorkType that 0015 reserves as `run`. Only
SHIP is wired today, because the repository runner accepts only SHIP. `scout` and `ship` remain the
intended surface once a read-only runner exists.

The binary is `rhiz-harness`, not `rhiz`. Rhiz Protocol already ships a `rhiz` binary for members
(`tools/rhiz-cli`). Two packages claiming one command name would make the name ambiguous wherever
both are installed.

### D2. Every write is admitted by the Board before it reaches the Ledger

`review`, `accept`, and orphan closure project the candidate events in memory first. An event the
Board would record as a violation raises an error before the append, so the append-only Ledger
never holds a refused decision. Acceptance also requires:

- a human `ActorRef`, taken from the repository's `git config user.email`;
- a non-empty reason;
- the Board's own `acceptanceReadiness`;
- a target check, which verifies the candidate commit still exists and the verified ref has not
  moved.

### D2a. The latest independent review speaks for the revision

Repeated review is now routine, so the Board must not act on "a passing review ever happened".
`latestIndependentReview` returns the newest current-revision review by an actor who did not
execute the Work. Acceptance readiness, attestation, and the derived state all read it.

- A passing review followed by a failing one is not ready, whether or not the contract requires
  review.
- A newer independent pass speaks for the revision again.
- A review lifecycle left open by a crashed run is closed as a failed, interrupted review by the
  same reviewer before that reviewer's next review. A different reviewer cannot close it.

The verified target that `review` diffs and `accept` re-checks is the Board's integration head proof
(`verifiedTarget`). It is never the operator's receipt file. Decisions are written to the Ledger in
which the Work was discovered.

### D3. Acceptance starts learning

When `accept` succeeds, it calls `RefinerBridge.consume` on the accepted stream and returns the
Router evidence derived from that stream. The Refiner now distinguishes a recovery from a
first-attempt success:

- `successful-recovery` applies when there was more than one attempt, a failed attempt, or a failed
  verification. It proposes `recovery-behavior`.
- `high-quality-first-attempt` applies otherwise.
- `zero-human-intervention` applies when no intervention event was recorded.

Proposals stay reviewable `refiner.proposed` events. Nothing is promoted automatically.

A typed human correction on `work.rejected` records an asserted cause, never an
automatically proven diagnosis. The rejection commits before Refiner runs. Proposal
identities bind Work, closure event and proposal kind, so interrupted Harvest can
resume without duplicating its durable prefix. Refiner reads the canonical Ledger
and rejects caller histories that are not its prefix. Proposal evidence excludes
Refiner's own events, preventing self-referential learning on retry.

A consumer correlation reference propagates from `work.created` through execution
and learning. Resume inherits the original reference and refuses an explicit
conflicting one before changing the Ledger. Correlation conveys no approval,
identity, deduplication or Outcome authority.

### D4. The Router reads accepted outcomes from every Work in the repository

`RouterBridge` accepts an `evidenceEvents` source. The runner supplies every other Work Ledger in
the repository, read without the writer lock by `readDurableLedgerEvents`, which also verifies the
hash chain. The current Ledger is excluded. Router evidence still comes only from the canonical
Board history, so raw history cannot reward a self-report.

A Ledger that cannot be read is reported in two places: on stderr, and in
`receipt.composition.routerEvidence.unreadable`. It is never counted as history that does not
exist. Benchmark arm Ledgers are measurement runs, not organizational Work, so they are not
discovered.

### D5. Human effort is counted by decision, not by actor

The Crew supervisor legitimately records routine lifecycle events, such as task creation and
assignment, under the ActorRef of the human who created the Work. Counting events by actor would
therefore report automation as human effort.

`HUMAN_INTERVENTION_EVENT_TYPES` lists the human decisions a run can ask for, beyond the two
judgment calls of stating the Work and accepting it:

- amendment
- decision resolution
- authority grant or denial
- starting a review
- park and release
- cancel and reject

`status` reports each Work's intervention count and the North Star, human interventions per accepted
outcome. It also reports `humanDecisions`, which counts every human decision including the two
judgment calls, and decisions per accepted outcome, so a reader can see that acceptance still needs a
person.

Cost appears in two places that are never merged. The sum of Router `expectedCostUsd` is an
estimate. A provider that reports its spend, such as the Claude reviewer's `total_cost_usd`, records
it on the Ledger as `observedUsage` on `review.result` (or `attempt.finished`); `status` and the
Refiner's Work record read it from there, show `not reported` when nothing was reported, and never
turn a tokens-only report into a cost of zero. The Refiner owns the one derivation of the Work
record (`deriveWorkRecord`): first-attempt success, recovery (a failed attempt, verification, or
independent review that the Work got past), human interventions, estimated cost, observed cost.

## Consequences

- Accepted outcomes now reach Router and Refiner through a command a person can type.
- `status` exit code `2` means at least one Ledger was unreadable. Callers must not read a partial
  answer as a complete one.
- `review` defaults to Claude Code (`claude -p`, plan mode, no tools beyond reading the prompt).
  `--reviewer-command` runs any executable that reads the prompt on stdin and prints the verdict
  JSON, so the reviewer stays replaceable. A reviewer is independent only if it did not execute the
  Work, and the Board enforces that.
- Accept does not merge. Integrating an accepted candidate stays a separate, consequential step.

## What is not claimed

- Resume does not carry the prior attempt's verifier refusal into the next attempt. The in-process
  repair loop does carry it.
- Cost is an estimate unless a worker or reviewer reports actual spend.
- The Router's cross-Work evidence is per repository. There is no organization-wide evidence store.
