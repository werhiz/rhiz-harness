# ADR 0015: Inline CLI and proof-first Developer Experience

Status: accepted for the public alpha Developer Experience

Supersedes `0014-developer-experience-command-architecture.md`. ADR 0014 canonicalized the command
architecture alone. This ADR carries every decision in 0014 forward without loss and extends it to
the full human surface: vocabulary, first run, the daily loop, approval policy, status semantics,
recovery, structured output, terminal behavior, and the acceptance tests an implementation must
pass. Two ADRs claiming authority over the same surface would violate Constitution invariant 3, so
0014 is retired rather than left standing beside this one.

> Note on numbering. When this ADR was first authored, the docs branch carried Developer
> Experience ADRs as 0005 and 0006. They were renumbered to 0008 and 0009 before the first
> landing because `origin/main` already owned 0005 (Crew missions) and 0006 (exact-target
> independent verification). After landing, `origin/main` accepted 0008 (Policy Oracle) and 0009
> (Refiner), recreating the invariant 3 violation. This ADR is therefore renumbered again to
> 0015 (and its retired companion to 0014). The renumber is cosmetic; the decisions and
> rationale are unchanged.

The design narrative, transcripts, exact failure copy, and competitive read live in
`docs/DEVELOPER_EXPERIENCE_V1.md`. That document is design input. This ADR is the architecture.

## Authority order

Conflicts resolve in this order:

1. `docs/RHIZ_HARNESS_CONSTITUTION.md`
2. current executable contracts and safety boundaries (`docs/KERNEL_0_1.md`,
   `docs/SYSTEM_BOUNDARIES.md`, `docs/VOCABULARY.md`, and the shipped Kernel, Workers, Crew,
   Verify, Ledger, Guard, and Refiner streams cited under "What exists today")
3. this ADR
4. `docs/DEVELOPER_EXPERIENCE_V1.md`

## Context

### What exists today

Rhiz Harness develops in parallel streams, each on its own feature branch in this repository.
The portable contracts below are implemented in those streams and have not yet been merged to a
single canonical line; this ADR cites them where the human surface depends on them, and treats
their multi-branch status as part of the architecture, not an oversight.

The following streams have shipped implementation as referenced by this ADR:

- **Kernel** (`feat/kernel-0-1-contracts`, `src/schemas.ts`, `src/board.ts`,
  `src/ledger.ts`, `src/host.ts`, `src/workers.ts`, `src/benchmark.ts`): `WorkContract`,
  typed `HarnessEvent` envelope, append-only `EventLedger`, deterministic Board projection,
  `HarnessHost`, `WorkerProvider`, and the typed event vocabulary listed in `docs/KERNEL_0_1.md`.
- **Workers** (`feat/workers-v0`, `src/workers.ts`): a deterministic Worker catalog with recorded
  selection rejections, plus a DSH product-worker-routes layer
  (`feat/dsh-product-worker-routes-v0`, `adapters/dsh/product-routes.ts`) that exercises Codex
  and Claude routes against the Kernel.
- **Crew** (`feat/crew-v0`, `src/crew.ts`): `CrewWorkspaceProvider` with a Git worktree
  implementation (leases, `executionRoot`, `baseRevision`, `mode` of `read-only` or
  `isolated-write`, content-addressed snapshots, explicit release); `workspaceChangeViolations`
  (compares workspace snapshots before and after execution against `writeScope`);
  `CrewWorkspaceStrategy` whose `inherit` variant is schema-constrained to `mode: "read-only"`
  and a declared-dependency source; `renderCrewMissionObjective` (passes dependency execution
  reports forward under an explicit "Unverified report" label, framed as context only and not
  verification, evidence, or expanded authority); `CrewMissionStatus` of `execution-finished`,
  `failed`, or `blocked`; `CrewRunReceipt.state` of `execution-complete` or `failed`. No Crew
  execution path produces acceptance.
- **Verify** (`feat/verify-v1`, `src/verify/`): a Verify module with an accept path separate
  from execution.
- **Ledger** (`feat/ledger-v1`, `adapters/local/durable-ledger.ts`): the durable hash-chained
  recovery path on top of the Kernel EventLedger.
- **Guard** (`feat/guard-v0`, `src/guard.ts`): a `PolicyOracle` interface with at least two
  backends, a Rhiz-native rule-based oracle and an ExecPolicy oracle. The Constitution's
  authority invariant is enforced through this seam.
- **Refiner** (`feat/refiner-v1`, `src/refiner.ts`): a `Refiner` module that emits typed
  `RefinerProposal` events from the Ledger. Promotion remains reviewable and evidence-backed;
  proposals do not self-authorize.

The following do not yet exist on any stream and are NOT assumed by this ADR to exist: a CLI,
a rendering layer, a configuration loader, an authentication health prober, a repository
grounding pass, a stall detector, a notification path, Context strategies, a Router, and any
human-facing surface for any of the streams above. Every command in this ADR is a decision
about a surface to be built. None of the streams above is a CLI command, a screen, a prompt,
or a notification; nothing in this ADR may be cited as a shipped human-facing capability.

### Why this is architecture and not presentation

Three properties make the human surface load bearing.

The CLI vocabulary teaches the ontology. A developer who learns the commands has learned the domain
model. A command named after the wrong noun re-imports precisely the confusion `VOCABULARY.md`
exists to remove, and renaming it later is a breaking change to the ontology rather than a cosmetic
change.

The North Star is defined at the human boundary. Human interventions per independently verified
successful outcome is measured where a person acts, so the surface is where the metric is won or
lost. A design that asks one unnecessary question per run makes the project's primary measurement
worse by construction, whatever the Kernel does underneath.

Several safety properties are only real if the interface carries them. Isolation, bounded
authority, the separation of finished from verified from accepted, and the refusal to treat process
liveness as progress are invariants a careless surface would silently discard while every
underlying contract stayed intact.

The forcing function is a five-minute promise: a developer who has never heard of Rhiz installs it
and reaches an accepted Outcome in five minutes, on a repository Rhiz has never seen.

## Decision

Ten load-bearing decisions, each stated normatively and defended. Supporting decisions appear in
the specification sections that follow and carry the same authority.

### D1. `rhiz init` is detect, prove, propose, commit

`rhiz init` MUST NOT be a wizard and MUST NOT ask a human for a fact the machine can read.

- **Detect.** Repository, toolchain, package manager, instruction files, and available Workers, by
  capability probe rather than name matching. Worker detection MUST use the `WorkerProvider`
  capability surface and record what each Worker can actually do.
- **Prove.** Two things by execution rather than inference. Worker authentication, through one
  cheapest-possible live round trip per provider under a timeout. The verification path, by
  actually running the fastest discovered verification command once and reporting its real result
  and timing.
- **Propose.** A complete derived configuration, printed as facts.
- **Commit.** The minimum durable configuration, the gitignore entries, and the Ledger.

`init` MUST ask at most one question, and only when zero healthy Workers exist. That case requires
a credential and is therefore genuine human judgment. A degraded secondary provider MUST NOT block
initialization; it is recorded as a routing reason.

`init` MUST be idempotent and non-destructive. It MUST NOT reset human-edited configuration and
MUST NOT destroy a Ledger. Re-running `init` on an initialized repository is definitionally the
same operation as `doctor`.

**Defense.** The multi-question scaffolder is the canonical form of the clerical-action defect
named in invariant 11: it asks a human for facts already present on disk. Proving rather than
guessing also produces the single most persuasive line in the first run, a real verification
command with a real duration and a real result, which tells a developer this tool knows how to
check its own work in their repository. Presence of a credential is not health, which is why the
live round trip is required rather than a file existence test.

### D2. SHIP Work never executes in the operator's live working tree

Every Work item with a non-empty `writeScope` MUST execute in an isolated Git workspace on its own
branch, acquired through `CrewWorkspaceProvider` in `isolated-write` mode. The operator's working
tree MUST NOT be read from or written to as an execution root, and MUST be contacted only at
acceptance.

Cancellation, rejection, and cleanup MUST remain safe and inexpensive: releasing a workspace MUST
NOT touch the operator's tree, and MUST NOT be required for the Work item, its branch, its diff, or
its evidence to survive.

Isolation mode is configurable. Worktree isolation is the default and the only mode permitted for
SHIP in the alpha.

**Defense.** This is a safety seam, not a convenience. It makes blast radius zero until an explicit
organizational decision, which is what allows most mid-run approval prompts to be deleted rather
than merely tolerated. It makes cancellation free, makes `undo` trivial, and concentrates every
merge conflict at acceptance, which is the moment a human is already present. The mechanism already
exists in `CrewWorkspaceProvider` and `workspaceChangeViolations`; this decision binds the human
surface to it.

### D3. The default interface is an inline, composable CLI

The primary human experience MUST be an inline rich CLI that renders in place, collapses to a
summary, and preserves scrollback. A fullscreen TUI MUST NOT be the default, MUST NOT ship in the
alpha, and MUST NOT ever be the only route to any fact. A web surface is deferred entirely.

Every graphical or interactive action that is ever added MUST remain reachable through a plain
command and its structured output.

**Defense.** A fullscreen surface takes over the terminal, destroys scrollback, breaks copy and
paste, breaks piping, and turns the tool into an application a developer visits rather than a
command they run. The daily loop must feel like a test runner, not like a cluster browser. The
fullscreen Board is warranted when a developer routinely runs three or more Work items at once, and
that is an evidence gate under invariant 14, not a preference. Keeping every fact reachable from a
plain command is also what keeps a second surface from becoming a second authority.

### D4. `rhiz ship --from <work-id>` carries context forward without granting authority

`ship --from` MUST inherit the prior Work item's ContextPack, decisions, references, and execution
reports by reference. It MUST NOT require a human to restate findings.

Inherited material MUST NOT become instruction text or authority. Specifically:

- The prior workspace MUST be inherited only in `read-only` mode, and the source Work item MUST be
  a declared dependency of the new Work item, as the `inherit` workspace strategy already enforces
  at the schema level.
- Worker prose MUST be passed forward under the existing quarantine framing produced by
  `renderCrewMissionObjective`: labeled as an unverified report, bounded in length, and explicitly
  stated to be context only rather than verification, evidence, or expanded authority.
- Inheritance MUST NOT widen `scope`, `writeScope`, or `AuthorityPolicy`. The new Work item's
  contract is authored fresh and constrained on its own terms.

**Defense.** Restating context to a second Worker is a clerical action and therefore a defect under
invariant 11. It is also the single most common intervention in current agent workflows. The risk
in deleting it is that unverified worker text silently becomes an instruction, which is a prompt
injection surface and an authority laundering path. The Crew implementation already solved this by
labeling and bounding dependency reports; the CLI MUST reuse that path rather than inventing a
second one.

### D5. Progress never relies on a spinner

Any surface that reports an in-flight Attempt MUST display, when the underlying fact is available:

- total Attempt age;
- age of the latest durable event;
- current Board state;
- current step or activity;
- process identity;
- whether the process is alive;
- changed paths.

A field whose fact is unavailable MUST be shown as unknown rather than omitted or inferred. A
spinner, a progress bar, or any animation presented as progress MUST NOT be the sole progress
signal.

A stall is an Attempt whose process is alive while no durable event has been recorded for longer
than a threshold. Stall handling is a **configurable policy, not a constant**. The policy declares
the durable-event threshold, the action taken, whether the action is automatic, and a warning point
before the action.

**The initial default is provisional and MUST NOT be frozen by this ADR.** The implementation ships
a labeled provisional default, records every stall detection, every automatic action, and every
operator override in the Ledger, and a later ADR sets the permanent default from dogfood evidence:
the observed distribution of durable-event gaps in real Work, the false-cancel rate, and the
recovered-work rate. Under invariant 14 a threshold is an abstraction, and it needs evidence before
it becomes permanent.

**Defense.** The Constitution and the Vocabulary both state that process liveness is an Observation
and is not progress. A spinner asserts progress the system has not observed, which makes it a lie
shaped like reassurance and a direct violation of invariant 3 rendered in pixels. Two clocks are
the smallest honest display: they distinguish a Worker that is thinking from a Worker that is
wedged, which is the exact judgment a human otherwise makes by hand and repeatedly. Acting on a
stall rather than asking about one removes that action, and the machine has strictly better
information about it than the human does. A repository with a slow integration suite and a
repository of small pure functions should not be assumed to share a number, which is why the
threshold is policy.

### D6. Human approval is limited to four classes

A human MUST be asked to approve only in these four classes:

1. **Irreversible external effect.** An effect that leaves the sandbox and is hard to reverse:
   push to a protected branch, deploy, publish, send, spend, mutate an external system, or delete
   data outside the isolated workspace.
2. **Authority expansion.** A Worker requires a write outside `writeScope`, a secret read, or
   network reach beyond its declared policy.
3. **Genuine material ambiguity.** Two readings of the objective produce materially different
   work, raised only after Rhiz has attempted resolution from grounding, history, and rules, and
   stating both readings plus the assumption it would otherwise make.
4. **Organizational acceptance.** Always, because Acceptance is the Board decision and belongs to a
   human by constitutional design.

Any other request for human approval is developer-experience friction and MUST be treated as a
defect. Every interactive prompt in the implementation MUST declare its class in code, and a prompt
without a class MUST fail review.

A pending Decision MUST NOT block the system. The affected Attempt pauses, the Board records the
Decision, other Work continues, and the human is notified. Modal mid-run halts that stop all
progress until a human returns are prohibited.

**Defense.** Invariant 11 says the system should continuously remove repeated human actions that do
not require judgment. Without an enumerated list, "does this need a human?" is answered by
whichever engineer is nervous that day, and prompts accumulate one reasonable-sounding addition at
a time until the tool feels like babysitting. Four named classes give every future prompt a review
test. This will make some features harder to ship, which is the intent. Isolation under D2 is what
makes the list this short: when the blast radius is zero until acceptance, most of the questions a
cautious design would ask have nothing left to protect.

### D7. `rhiz why` is an alpha requirement

`rhiz why <work-id>` MUST ship in the public alpha and MUST reconstruct, entirely from the Ledger
and the evidence it references:

- what was requested;
- which contract governed the Work, including amendments;
- which Workers acted, under which provider and route, with recorded selection rejections;
- which decisions were made, by whom, and on what basis;
- what changed, as artifact and workspace identity;
- what evidence was produced;
- what verification proved, against which acceptance criteria;
- who accepted or rejected the result;
- the complete recovery lineage, including failed, orphaned, cancelled, and retried Attempts.

`why` MUST NOT read live process state, ask a Worker, or synthesize narrative that is not derivable
from durable records.

**Defense.** Invariant 5 says consequential behavior must be reconstructible. `why` is the
human-facing proof of that claim, and if it cannot be built then the claim is not true. It is also
a standing test of the architecture: the day `why` becomes hard to build is the day an invariant has
drifted, and the failure surfaces immediately rather than at an audit. It is the one command in
this surface that no tool without a durable typed organizational event stream can offer, which
makes it both the demo and the differentiator. Its first version may be a plain event rendering.

### D8. The North Star is visible after every accepted outcome

Every acceptance MUST print human interventions per independently verified successful outcome for
that Work item, and MUST separate clerical interventions from judgment interventions. `rhiz history`
MUST show the same measure over time, including the override rate for acceptances over failing
evidence.

Interventions MUST be recorded in the Ledger as they happen, classified at the point of occurrence
rather than reconstructed later, following the intervention definition and the anti-gaming rules in
`docs/BENCHMARK_CONTRACT.md`.

**Defense.** The benchmark contract makes this the primary measure of the project. A metric that
only appears in a benchmark harness is a metric nobody feels; printing it at the moment of
acceptance makes the North Star a product surface and makes regressions visible to the person best
placed to complain. Separating clerical from judgment interventions is what stops the number from
being gamed by hiding consequential human decisions, which the benchmark contract already forbids.
The goal is to remove clerical management, not to remove human authority.

### D9. The public-alpha cut is intentionally narrow

The following limits are intentional architecture and not unfinished work. Reversing one requires
evidence rather than preference.

```text
one distributable CLI
approximately ten primary commands
no mandatory account
no web application
no fullscreen TUI
no learned Router
no autonomous Refiner promotion
no requirement that users understand Crew internals
JSON output available for every consequential command
```

Where Crew capability is required before Crew has a surface, it MUST stay hidden behind an existing
simple command rather than acquiring its own.

The alpha MUST state its limits out loud, MUST NOT report a verification it did not run, and MUST
ground narrowly with a stated boundary rather than guessing widely.

**Defense.** Invariant 14 says permanent abstractions should be justified by real work rather than
by the existence of a feature elsewhere. Surface area added before dogfood evidence is surface area
that must be maintained, documented, and defended forever on the strength of an intuition. The
alpha will read as underpowered next to hosted agent platforms, and that is the trade: local truth,
reconstructible history, and a low human-action count are the claims; breadth is not.

### D10. The surface obeys the current safety architecture

The human surface MUST NOT weaken any of the following, and MUST make each visible rather than
merely honoring it silently:

1. **Worker completion is not verification.** An `attempt.finished` event and a Worker's own report
   are evidence. No command output, exit code, state name, or color may present them as a passing
   check. The Crew vocabulary already says `execution-finished` and `execution-complete` rather
   than any success word, and the CLI MUST match.
2. **Verification is not acceptance.** Verified Work is displayed as ready to accept and never as
   done. Acceptance is a separate Decision, a separate event, and a separate command.
3. **Workers are bound to the exact isolated workspace.** A Worker MUST be launched against the
   `executionRoot` of its acquired workspace lease, and workspace identity MUST be checked before
   and after execution. Snapshot identity that does not match the active lease is a violation, not
   a warning. Changed paths outside `writeScope` are reported by `workspaceChangeViolations` and
   MUST surface to the human as a violation rather than as a diff.
4. **Unknown authority fails closed.** An action whose authority cannot be resolved MUST be denied
   and recorded as `authority.denied`, never permitted by default, never inferred from a Worker's
   assertion, and never granted by an adapter beyond what the contract allows.
5. **Untrusted worker output cannot become instruction text.** Worker prose entering any prompt,
   contract, or objective MUST be labeled unverified, bounded, and framed as context that confers
   no authority, per D4.
6. **Durable evidence and recovery lineage are preserved.** Cancellation, rejection, failure, and
   orphan recovery MUST preserve the Work item, its branch, its diff, and its evidence, and MUST
   emit durable events. No command may delete Ledger history, including about its own mistakes.
7. **Guard enforcement stays mechanical where possible.** Boundaries that can be checked by
   snapshot comparison, path matching, process inspection, or schema validation MUST NOT be
   delegated to prompt text or to model judgment, per invariants 9 and 10.

**Defense.** These are the properties most easily lost at the presentation layer while every
underlying contract remains correct. A status column that says "done" after `attempt.finished`
destroys invariant 6 without changing a line of Kernel code. This decision exists so that a future
change to a renderer can be rejected on architectural grounds rather than on taste.

## Command vocabulary

Naming rules, normative:

1. Commands are the Vocabulary's nouns and verbs. The CLI teaches the ontology by being it.
2. Process vocabulary MUST NOT be used for organizational actions. No `start`, `stop`, `kill`, or
   `ps`. The process is the most disposable object in the system.
3. The verb selects the WorkType, and therefore the authority envelope. `scout`, `ship`, and
   `review` are the three WorkTypes and the three primary work commands.
4. One concept, one command. If two commands would show the same fact, one of them is a flag.
5. Every command reads before it writes, and states what it will do before doing it whenever the
   effect leaves the sandbox.

**Primary surface, alpha.** Approximately ten commands, and the only ones in the quickstart.

```text
rhiz init                     detect, prove, propose, commit
rhiz scout   "<intent>"       read-only Work, empty writeScope, structurally cannot mutate
rhiz ship    "<intent>"       writing Work in an isolated workspace, never the operator's tree
rhiz status                   what is happening right now
rhiz diff    [work]           what changed, with evidence attached
rhiz accept  [work]           the organizational decision
rhiz why     <work>           reconstruct the Work from durable records
rhiz board                    all live Work, grouped by state
rhiz resume  [work]           continue non-terminal Work
rhiz doctor                   diagnose, repair what is safe, name what is not
```

**Secondary surface, alpha where cheap.**

```text
rhiz review  [work]           independent REVIEW Work over an artifact or Work item
rhiz verify  [work]           re-run the verification policy, produce fresh Evidence
rhiz reject  [work] <reason>  explicit non-acceptance, recorded, evidence retained
rhiz decide                   answer pending Decisions
rhiz retry   [work]           new Attempt on the same Contract, failure evidence in context
rhiz cancel  [work]           stop Attempts, keep the Work item and everything it learned
rhiz undo    <work>           revert an accepted Outcome by a new commit and a Decision
rhiz show    <id>             full detail of any entity
rhiz log     [work]           raw worker output, with follow
rhiz history                  accepted and rejected Outcomes with intervention counts
rhiz workers                  catalog, health, capabilities, preference order
rhiz auth                     health per provider, with the exact fix line
rhiz ground                   rebuild the ContextPack seed, normally automatic
rhiz config                   read and explain layered configuration
```

**Reserved, later.** Named now so the surface can grow without renaming anything: `rhiz run --type`
as the explicit generic behind the three WorkType verbs, and `crew`, `guard`, `rules`, `context`,
`route`, `bench`, `web`.

Naming calls that MUST hold:

- `accept`, not `approve`. Approval is a permission gesture; Acceptance is the Board decision that
  Work succeeded, and the Vocabulary already separates them.
- `board`, not `list` or `ps`. Board is the canonical projection.
- `why`, not `explain`. The command answers a question about durable history, not about intent.
- `undo` is a forward operation. It produces a revert and a Decision event. It MUST NOT rewrite
  history and MUST NOT mutate the Ledger.
- No `rhiz agent`. Worker identity is not model identity, and naming a command after the vendor
  category re-imports the confusion the architecture removes.

Aliases are permitted only for commands typed many times a day: `s` for status, `b` for board, `d`
for diff, `a` for accept. Short aliases for rare commands are cognitive debt.

## First-run sequence

Normative order for `rhiz init`:

1. **Repository detection.** Git presence, branch, cleanliness, remote. A non-Git directory is a
   clear failure with one fix line, not a prompt.
2. **Toolchain detection.** Language, package manager, lockfile, test runner, typechecker, linter,
   build, and CI configuration, by file and manifest inspection.
3. **Worker detection.** Probe PATH, provider configuration directories, and environment for known
   Workers. For each hit, run the `WorkerProvider` capability probe and record actual capability:
   file write, command execution, cancellation, observation streaming, context ceiling. The result
   is a Worker catalog with provenance, never a guess.
4. **Authentication proof.** One cheapest-possible live round trip per detected Worker under a
   short timeout, cached with an expiry. The check MUST distinguish and report differently for
   absent, malformed, invalid, expired session, out of quota, and rate limited, and MUST print the
   exact fix line for the reported state. A single healthy Worker is sufficient to proceed.
5. **Verification proof.** Identify candidate verification commands, then actually execute the
   fastest one once and report its real result and timing. An unproven command MUST be labeled
   unproven and MUST NOT be written into the verification policy as if it had been proven.
6. **Grounding.** Index instruction files, repository map inputs, and rules into a ContextPack seed,
   keyed by a hash of its inputs so it invalidates and rebuilds itself. Manual re-grounding MUST
   remain available and MUST NOT be a required human action.
7. **Propose and commit.** Print the derived configuration as facts, write the minimum durable
   configuration, write gitignore entries, and create the Ledger.

Worker selection MUST be deterministic and MUST be printed: capability match, then health, then
declared preference, then stable identifier order, with rejections recorded. The human is never
asked which agent to use.

`init --yes --json` MUST run non-interactively for CI and for another harness driving Rhiz.

## Daily operating sequence

The loop the surface is optimized for:

```text
rhiz scout "<question>"        read-only investigation, no approval required
rhiz ship --from <work-id>     implement, isolated, context carried by reference
rhiz status                    two clocks, current step, liveness
rhiz decide                    only if a Decision in one of the four classes is pending
rhiz diff <work-id>            changed paths with evidence attached
rhiz accept <work-id>          the organizational decision, prints interventions per outcome
```

Everything else in that loop happens without asking: writing inside `writeScope`, running tests and
builds, installing dependencies inside the sandbox, creating branches and workspaces, retrying,
choosing and re-routing Workers, re-grounding, opening a draft pull request, recovering from a
crash, and rebuilding a projection.

Bare `rhiz` MUST NOT print a wall of commands. It prints current state plus the next action.

## Approval policy

The four classes in D6 are the complete list. Operational rules:

- Every prompt declares its class in code. No class, no prompt.
- A prompt MUST state what it will do, what it will not do, and what happens if it is denied.
- An ambiguity prompt MUST state both readings and the assumption Rhiz would otherwise make.
- An authority prompt MUST name the exact resource and the exact expansion, and MUST offer a
  narrow grant scoped to one Work item as the default option.
- Denial is a first-class outcome, recorded as a Decision, and MUST leave the Work item in a
  recoverable state rather than failing it.
- Acceptance over failing evidence is permitted, MUST require a stated reason, MUST be recorded as
  a Decision, and MUST be counted in the override rate. Refusing to model this pushes people to
  merge behind the tool's back, which destroys the record.
- Auto-acceptance is not part of the alpha and is off by default if it is ever added.

## Status model

`rhiz status` and `rhiz board` are projections of the Ledger and MUST NOT hold state of their own.

Board grouping order is fixed and reflects what a human should do about each group:

1. waiting on you (pending Decisions, always first, always counted)
2. ready to accept (verified, awaiting the organizational decision)
3. running
4. blocked (including verification failed and authority denied)
5. recent terminal Outcomes

Display rules:

- The count of items waiting on a human is the inverse of the North Star and is always shown.
- State names come from the Kernel Board projection: `proposed`, `ready`, `running`, `blocked`,
  `verifying`, `reviewing`, `accepted`, `rejected`, `cancelled`, `failed`. The surface MUST NOT
  invent a state, and MUST NOT display a success word for any state before `accepted`.
- Every running item shows the fields required by D5.
- Divergence between Attempt age and last-durable-event age is stated in words when it crosses the
  stall warning point, along with the action the policy will take and the time it will take it.

## Recovery behavior

Recovery MUST be automatic and silent, and MUST NOT ask permission.

- Any `rhiz` invocation reconciles first: dead process identity, absent heartbeat, orphaned Attempt,
  workspace lease without a live process.
- Reconciliation emits a durable failure event with a reason, returns the Work item to a runnable
  state, and reports one line stating what was recovered and what survived.
- Work written before a crash remains on the branch and in the diff, because execution was isolated.
- A projection that disagrees with the Ledger is rebuilt from events without asking, because the
  Ledger is append-only and the projection is derived. The rebuild reports the event count and
  duration.
- `resume` continues non-terminal Work. `retry` creates a new Attempt against the same Contract with
  the prior failure evidence in context. `cancel` stops Attempts and keeps the Work item and
  everything it learned.
- Cancellation MUST leave the source repository unchanged.

Asking a human whether they would like to not lose their work is prohibited.

## Structured-output requirements

The plain machine-readable interface is the contract. The rich interface is a projection of it.

- Every consequential command MUST support `--json`, with a versioned schema identifier in the
  payload, following the `schema` field convention already used by the Crew run receipt.
- Every command MUST support `--plain`, and MUST detect a non-TTY and degrade to plain
  automatically.
- Exit codes MUST be meaningful and distinguish at minimum: success, operational error, verification
  failed, decision required, blocked, and authority denied.
- The JSON schema and the exit code table MUST be specified as their own contract ADR before any
  rendering work begins. This ADR deliberately does not fix the field names, because doing so
  without the Verify and Ledger read models in front of the author would guess.
- Human-readable output MUST NOT contain a fact that the JSON output omits.
- Rhiz being driven by another harness, by CI, or by a supervising agent is a supported use case
  from the first release rather than an accident.

## Accessibility and terminal behavior

- Color MUST NOT be the sole carrier of meaning. Every state distinction is also carried by a word.
  `NO_COLOR` and a plain mode are honored.
- Output MUST remain useful when piped, redirected, or read by a screen reader: no animation as the
  sole progress signal, no cursor-addressed redraw in plain mode, no output that only makes sense
  in place.
- Identifiers MUST be short, free of ambiguous characters, and selectable as one token by
  double-click. Long identifiers and paths truncate with the meaningful end preserved rather than
  wrapping.
- Clipboard support MUST use the terminal escape sequence path so that copy works identically over
  SSH and inside a multiplexer, and MUST be an explicit action rather than an ambient one.
- Copy-on-highlight is a property of a future fullscreen or web surface only, and MUST NOT be
  simulated in the plain terminal.
- File paths SHOULD be emitted as terminal hyperlinks into the configured editor, degrading to
  plain text where unsupported.
- Every error block MUST end with exactly one copyable command line, alone on its line.
- Notification fires on judgment and never on progress. Notifications MUST be suppressed for Work
  the human is actively watching and for runs that complete inside a short attention threshold.

## Configuration

Layered, lowest to highest precedence: built-in defaults sufficient for a zero-config repository,
personal machine configuration, committed repository configuration, gitignored local overrides,
environment variables, command flags.

One asymmetry is normative: **an authority ceiling may be narrowed by a higher-precedence layer and
MUST NOT be widened by one.** Widening requires editing the committed repository configuration,
which means review. This asymmetry is what makes committed configuration a policy rather than a
suggestion, and it MUST be enforced in the configuration resolver rather than by convention.

`config get <key> --explain` MUST print the resolved value and the layer it came from. A
configuration system whose values cannot be traced to a layer becomes unusable at the first
disagreement.

Two artifacts are committed and only two: the repository configuration and the promoted rules
directory. Everything else is a cache, a workspace, or a local durable log.

## Consequences

- The command surface becomes a stable public contract. Renaming a command later is a breaking
  change to the ontology, not a cosmetic change.
- Worktree isolation makes cancellation free and `undo` trivial, and concentrates every merge
  conflict at acceptance, which is where the human already is.
- Specifying JSON and exit codes before rendering means CI, other harnesses, and supervising agents
  can drive Rhiz from the first release.
- The four approval classes give every future prompt a review test, which will make some features
  harder to ship. That is the intent.
- Leaving the stall threshold unfrozen means the first release will sometimes cancel a healthy
  Attempt or wait too long on a dead one. That cost is accepted in exchange for setting the
  permanent default from measured behavior rather than intuition.
- `why` and the interventions-per-outcome counter are constructible only on top of the event-sourced
  Kernel. They demonstrate the architecture to a stranger, and they are a standing test of it.
- The alpha will read as underpowered next to hosted agent platforms. Local truth, reconstructible
  history, and a low human-action count are the claims; surface area is not.
- Two decisions in this ADR are currently prose without mechanical enforcement: the approval-class
  declaration in D6 and the authority ratchet in the configuration section. Both are candidates for
  guards, and until guards exist they are review obligations rather than enforced invariants.

## Rejected alternatives

- **A fullscreen TUI as the default surface.** Rejected under D3. It destroys scrollback, breaks
  piping and copy, and makes a command feel like an application. It also invites a second authority
  as soon as one fact is reachable only inside it.
- **A web dashboard in the alpha.** Rejected. It requires hosting, an account, or both, and the
  alpha's claim is local truth. Deferred to a read-first, local-first surface later.
- **An interactive setup wizard.** Rejected under D1. Asking a human for facts on disk is the
  canonical clerical-action defect.
- **Executing SHIP in the operator's working tree with a confirmation prompt.** Rejected under D2.
  A prompt is not a boundary, it makes cancellation expensive, and it forces mid-run approvals that
  isolation deletes outright.
- **A hard-coded stall timeout.** Rejected under D5, on explicit instruction and on invariant 14. A
  constant chosen before evidence would become permanent by inertia.
- **Freeing the human from acceptance by default.** Rejected. Acceptance is the organizational
  decision under invariant 6. Opt-in auto-acceptance may be considered later with fresh evidence
  and clean review, off by default.
- **A generic `rhiz run` as the primary command.** Rejected for humans, reserved for scripts. The
  WorkType verb is what makes the authority envelope visible at the moment of typing.
- **Naming a command after the agent or model.** Rejected. Worker identity is not model identity,
  and vendor-named commands break invariant 7 in the vocabulary the user learns first.
- **Passing prior worker output forward as plain objective text.** Rejected under D4. It launders
  unverified prose into instruction and authority, and the Crew implementation already refuses it.
- **Showing "done" when an Attempt finishes.** Rejected under D10. It collapses completion,
  verification, and acceptance into one word and silently breaks invariant 6.

## Deferred capabilities

Each of these is gated on dogfood evidence under invariant 14 and measured against
`docs/BENCHMARK_CONTRACT.md` under invariant 15.

- The permanent stall threshold and stall action, set from recorded stall evidence.
- The JSON schema version 1 and the exit code table, as their own contract ADR before
  implementation.
- Fullscreen Board, gated on evidence of routine concurrent Work.
- Web and mobile decision answering, read-first and local-first.
- Crew as a named surface, task graphs, and concurrency admission control.
- Router and learned selection, with a required `route --why`.
- Context strategies as a product surface, with benchmark evidence that a smaller selected context
  beat a larger one.
- Guard authoring as a product surface. Guards exist as configuration and mechanical checks first.
- Refiner and automatic Lesson promotion. Lessons are collected in the Ledger from the first
  release and promoted by hand.
- Team Ledger sync, accounts, and any hosted experience.
- Auto-acceptance policy, evidence freshness semantics, and the re-verification rule at acceptance
  after a rebase.

## Acceptance tests for the eventual implementation

These are the tests an implementation MUST pass before the Developer Experience is considered to
satisfy this ADR. Each is stated so it can be automated.

1. **First proven configuration with zero unnecessary questions.** A scripted run of `rhiz init` in
   a fresh fixture repository with at least one healthy Worker completes with zero interactive
   prompts, and the output contains at least one verification command with a real measured duration
   and result. With zero healthy Workers, exactly one prompt appears and it is the credential
   handoff.
2. **Bounded read-only Work needs no approval.** An authenticated Worker completes a SCOUT Work item
   end to end with zero approval prompts, and the Work item's `writeScope` is empty in the recorded
   contract.
3. **SHIP never changes the operator's live working tree.** A test captures the operator tree
   digest before and after a SHIP Work item that writes files, and asserts the digest is unchanged
   while the isolated workspace snapshot shows the changed paths. The same assertion holds for a
   SHIP that fails, one that is cancelled, and one that is rejected.
4. **Every approval maps to one of the four classes.** A static check over the implementation
   asserts that every interactive prompt call site declares one of the four class identifiers, and
   fails the build on an undeclared prompt. A runtime test asserts every emitted
   `decision.requested` event carries a class.
5. **A stalled or dead process is distinguishable without manual process searching.** With a Worker
   process alive but emitting no durable events past the configured threshold, `status --json`
   reports the Attempt as stalled, reports both clocks, and reports process liveness. With the
   process killed, the next invocation reports the Attempt as orphaned and the Work item as
   runnable. Neither case requires the operator to inspect the process table.
6. **`why` reconstructs an accepted outcome entirely from durable records.** With every live process
   terminated, every cache cleared, and every projection deleted, `rhiz why <work-id>` reproduces
   request, contract, Workers, decisions, changes, evidence, verification, acceptor, and recovery
   lineage from the Ledger alone. Removing the caches MUST NOT change the output.
7. **Every primary command supports machine-readable output.** A test enumerates the primary command
   set and asserts each returns schema-valid JSON under `--json`, carries a schema version, and
   exits with the documented code for its outcome. A command whose human output contains a fact
   absent from its JSON fails.
8. **Cancellation leaves the source repository unchanged.** Cancelling a running SHIP Work item
   leaves the operator tree digest unchanged, releases the workspace lease, preserves the Work item,
   its branch, its diff, and its evidence, and emits a durable cancellation event.
9. **No command implies that execution completion equals acceptance.** A test asserts that no
   surface string rendered for a Work item in `running`, `verifying`, `reviewing`, or any
   non-accepted state contains a success word, and that `attempt.finished` alone never produces an
   `accepted` Board state in the projection.
10. **Authority fails closed.** A Work item attempting a write outside `writeScope` produces a
    reported violation and an `authority.denied` event, the write does not land in the workspace,
    and the Attempt pauses rather than failing. An action whose authority cannot be resolved is
    denied rather than permitted.
11. **The five-minute promise is timed.** A scripted fresh-environment run against a fixture
    repository reaches an accepted Outcome, with the wall-clock time and the human-action count
    asserted. A change that adds a human action fails the build and requires explicit justification.
12. **Interventions are recorded and classified.** Every recorded intervention carries a clerical or
    judgment classification at the point of occurrence, and the value printed at acceptance is
    derivable from the Ledger alone.
