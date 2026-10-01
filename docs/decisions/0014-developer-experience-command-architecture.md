# ADR 0014: Developer Experience command architecture

Status: superseded by `0015-inline-cli-and-proof-first-developer-experience.md`

Superseded on 2026-08-20. ADR 0015 carries every decision below forward without loss and extends
them to the full human surface. This file is retained for rationale only and is no longer
authority. Two ADRs governing the same surface would violate Constitution invariant 3.

Supersedes nothing. Refines the Constitution's One Less Action Doctrine (invariant 11) into a
concrete human-facing surface. The full design narrative, transcripts, failure copy, and
competitive read live in `docs/DEVELOPER_EXPERIENCE_V1.md`. This ADR holds the parts that are
canonical architecture rather than presentation.

## Context

Kernel 0.1, Workers v0, and the DSH product worker routes give Rhiz a portable WorkContract, a
deterministic Worker catalog, typed durable events, and a replayable Board. None of that is
reachable by a human today. The first developer-facing surface will decide, permanently, which of
those distinctions people can feel and which stay internal.

Three facts make this a load-bearing architectural decision rather than a presentation decision.

First, the CLI vocabulary teaches the ontology. A developer who learns the commands has learned
the domain model, and a command named after the wrong noun re-imports exactly the confusion
`VOCABULARY.md` exists to remove.

Second, the North Star is human interventions per independently verified successful outcome. That
metric is defined at the human boundary, so the human boundary is where it is won or lost. A
surface that asks one unnecessary question per run makes the project's primary measurement worse
by construction, no matter how good the Kernel is.

Third, several safety properties are only real if the interface is shaped to carry them. Isolation,
authority ceilings, the separation of finished from verified from accepted, and the refusal to
treat process liveness as progress are all invariants that a careless CLI would silently discard.

The five-minute goal is the forcing function: a developer who has never heard of Rhiz installs it
and reaches an accepted Outcome in five minutes, on a repository Rhiz has never seen.

## Decision

### Doctrine

1. Every human action that is not judgment is a defect, not a missing feature. Any interactive
   prompt in the codebase must name which approval class in decision 8 it belongs to. No class,
   no prompt.
2. The interventions-per-outcome count is printed to the human at every acceptance. The North Star
   is a visible product surface, not an internal metric.

### Initialization

3. `rhiz init` follows detect, prove, propose, commit. It is not a wizard and MUST NOT ask the
   human for a fact the machine can read.
   - **Detect** the repository, toolchain, package manager, instruction files, and available
     Workers, using capability probes rather than name matching.
   - **Prove** two things by execution, not inference: Worker authentication, through one
     cheapest-possible live round trip per provider with a timeout; and the verification path, by
     actually running the fastest discovered verification command once and reporting its real
     result and timing.
   - **Propose** a complete derived configuration and print it as facts.
   - **Commit** it, writing the minimum durable configuration and creating the Ledger.
4. `init` asks at most one question, and only in one situation: zero healthy Workers exist, which
   requires a credential and is therefore genuine human judgment. A degraded secondary provider is
   never a blocker; it is a recorded routing reason.
5. `init` is idempotent and non-destructive. It never resets human-edited configuration and never
   destroys a Ledger. Re-running `init` on an initialized repository is definitionally the same
   operation as `doctor`.
6. Grounding output is a ContextPack seed keyed by a hash of its inputs, so it invalidates and
   rebuilds itself. Manual re-grounding is available but is never a required human action.

### Work execution and isolation

7. SHIP Work MUST NOT mutate the operator's working tree. It executes in an isolated worktree on
   its own branch, and the operator's tree is contacted only at acceptance. This is a safety seam,
   not a convenience: it makes blast radius zero until an explicit organizational decision, which
   is what allows most mid-run approval prompts to be deleted rather than merely tolerated.
   Isolation mode is configurable, and worktree is the default.
8. Approval is required in exactly four classes. Anything else that prompts a human is a defect.
   1. Effects that leave the sandbox and are hard to reverse: push to a protected branch, deploy,
      publish, send, spend, mutate an external system, delete data outside the worktree.
   2. Authority expansion: writing outside WriteScope, reading a secret, or exceeding declared
      network policy.
   3. Genuine ambiguity where two readings produce materially different work, raised only after
      Rhiz has tried to resolve it from grounding, history, and rules, and stated both readings
      plus the assumption it would otherwise make.
   4. Acceptance, always, because Acceptance is the organizational decision and belongs to a human
      by constitutional design.
9. A pending Decision MUST NOT block the system. The affected Attempt pauses, the Board records
   the Decision, other Work continues, and the human is notified. Modal mid-run prompts that halt
   everything until a human returns are prohibited.
10. Work continuation carries context by reference. `ship --from <work>` inherits the prior Work
    item's ContextPack and evidence rather than requiring the human to restate findings. Re-stating
    context to a second Worker is a clerical action and is therefore a defect.
11. REVIEW Work defaults to a different provider than the Worker that authored the artifact under
    review, per Constitution invariant 6. A reviewer that can silently repair its own finding is
    not a reviewer.

### Progress, liveness, and stall policy

12. Progress reporting MUST distinguish process liveness from durable progress, per Constitution
    invariant 3 and the Vocabulary rule that process alive is not making progress. The surface
    shows two clocks: Attempt age, and time since the last durable event. A spinner alone is
    prohibited, because it asserts progress the system has not observed.
13. A stall is defined as an Attempt whose process is alive while no durable event has been
    recorded for longer than a threshold. Stall handling is a **configurable policy**, not a
    constant. The policy declares the durable-event threshold, the action taken (warn, then
    cancel), and whether the action is automatic.
14. **The default threshold is unproven and MUST NOT be frozen in this ADR.** The initial
    implementation ships a provisional default, records every stall event and every operator
    override in the Ledger, and the permanent default is set by a later ADR that cites dogfood
    evidence: observed distribution of durable-event gaps in real Work, false-cancel rate, and
    recovered-work rate. Per Constitution invariant 14, a threshold is an abstraction and needs
    evidence before it becomes permanent.
15. Recovery from a dead Attempt, orphaned process, or terminal death is automatic and silent. The
    next invocation of any command reconciles, emits the failure event, returns the Work to a
    runnable state, and reports one line. Asking a human whether they would like to not lose their
    work is prohibited.

### Vocabulary and surfaces

16. Command names are the Vocabulary's nouns and verbs. Specifically: `accept` rather than
    `approve`, because Acceptance is the Board decision and approval is a permission gesture;
    `board` rather than `list` or `ps`, because Board is the canonical projection; `scout`, `ship`,
    and `review` as the three commands because they are the three WorkTypes, so the verb a human
    types selects an authority envelope. Process vocabulary (`start`, `stop`, `kill`) MUST NOT be
    used for organizational actions.
17. `rhiz why <work>` is a required command, not an optional nicety. It reconstructs intent,
    contract, routing, activity, decisions, evidence, verification, and acceptance from the Ledger.
    It is the human-facing proof of Constitution invariant 5, and if it cannot be built the
    reconstructibility claim is not true.
18. `rhiz undo` is a forward operation. It produces a revert and a Decision event. It MUST NOT
    rewrite history and MUST NOT mutate the Ledger. The Ledger stays append-only, including about
    its own mistakes.
19. The plain, machine-readable interface is the contract; the rich interface is a projection of
    it. Every command supports `--json` with a versioned schema and returns meaningful exit codes.
    The `--json` schema and exit codes are specified before any rendering work begins.
20. The inline rich CLI is the primary human experience. A fullscreen TUI MUST NOT be the default
    and MUST NOT be the only route to any fact. Every fact shown in any surface is reachable from a
    plain command.
21. Configuration is layered, and precedence is standard with one asymmetry: **an authority ceiling
    may be narrowed by a higher-precedence layer and MUST NOT be widened by one.** Widening
    requires editing the committed repository configuration, which means review. This asymmetry is
    what makes committed configuration a policy rather than a suggestion.
22. Notification fires on judgment and never on progress. Notifications are suppressed for Work the
    human is actively watching and for runs that complete inside the attention threshold.

### Alpha scope

23. The public alpha is deliberately and aggressively cut. The following limits are intentional
    architecture, not unfinished work, and reversing one requires evidence rather than preference:

```text
10 commands
one binary
inline CLI
no TUI
no web
no accounts
no Router
no Refiner
Crew hidden behind simple commands where needed
```

24. Crew, Router, Context strategies, Guard authoring, Refiner, team Ledger sync, and any hosted
    surface are deferred and gated on dogfood evidence per Constitution invariant 14 and measured
    against the benchmark contract per invariant 15. Where Crew capability is needed before it has
    a surface, it stays hidden behind an existing simple command rather than acquiring its own.
25. The alpha states its limits out loud, never reports a verification it did not run, and grounds
    narrowly with a stated boundary rather than guessing widely.

### Enforcement

26. The five-minute promise is a CI fixture, not an aspiration: a scripted fresh-environment run
    against a fixture repository, timed, asserting the human-action count. A change that adds a
    human action fails the build and requires an explicit justification.
27. Stall events, approval prompts by class, overrides of failed verification, and
    interventions-per-outcome are recorded in the Ledger from the first release, because they are
    the evidence that later ADRs will need to set defaults and to prove the North Star is moving.

## Consequences

- The command surface becomes a stable public contract. Renaming a command later is a breaking
  change to the ontology, not a cosmetic change, so the names in decision 16 are worth defending.
- Worktree isolation makes cancellation free, `undo` trivial, and most mid-run approval prompts
  deletable rather than merely reducible. It also concentrates every merge conflict at acceptance,
  which is where the human already is.
- Specifying `--json` and exit codes before rendering means other harnesses, CI, and supervising
  agents can drive Rhiz from the first release. Rhiz being driven by another harness is a supported
  use case rather than an accident.
- The four approval classes give every future prompt a review test. This will make some features
  harder to ship, which is the intent.
- Leaving the stall threshold unfrozen means the first release will occasionally cancel healthy
  Attempts or wait too long on dead ones. That cost is accepted in exchange for setting the
  permanent default from measured behavior instead of intuition.
- `rhiz why` and the interventions-per-outcome counter are only constructible on top of the
  event-sourced Kernel. They are therefore the two commands that demonstrate the architecture to a
  stranger, and they are also a standing test of it: if either becomes hard to build, an invariant
  has drifted.
- The alpha cut in decision 23 will read as underpowered next to hosted agent platforms. That is
  the trade. Local truth, reconstructible history, and a low human-action count are the claims;
  surface area is not.

## Deferred to later ADRs

- The permanent stall threshold and stall action, set from dogfood evidence per decision 14.
- The `--json` schema version 1 and the exit code table, as a contract ADR before implementation.
- Auto-acceptance policy for repositories that explicitly opt in when every AcceptanceCriterion is
  satisfied by fresh Evidence and review is clean. Off by default, and not part of the alpha.
- Evidence freshness semantics and the re-verification rule at acceptance after a rebase.
- Crew surface, Router surface, Refiner promotion review flow, and any hosted or account-bearing
  experience.
