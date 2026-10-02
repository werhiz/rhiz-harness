# Developer Experience v1

Status: proposed design. The first slice ships as `rhiz-harness start | status | resume | review |
accept` under `decisions/0026-operator-loop-and-acceptance-driven-learning.md`; the rest of this
surface is not implemented.

Canonical decisions extracted from this document live in
`decisions/0015-inline-cli-and-proof-first-developer-experience.md`. Where the ADR and this document
differ, the ADR wins; this document is the design narrative, transcripts, and failure copy.

Authority: subordinate to `RHIZ_HARNESS_CONSTITUTION.md` and `VOCABULARY.md`. Where this
document names a noun, it is the noun from the Vocabulary. Where it proposes a behavior that
would violate a constitutional MUST, the Constitution wins and this document is wrong.

## 0. The thesis

The Constitution already contains the design brief for this surface. Invariant 11, the One Less
Action Doctrine, says humans handle judgment and not clerical coordination. Turned into a product
rule for the CLI:

> **Every human action that is not judgment is a bug. File a defect, not a feature request.**

The North Star is human interventions per independently verified successful outcome. That number
is the only DX metric that matters, and it is the number the CLI prints at the end of every
accepted Work item. If the surface is good, the number goes down over weeks of use without anyone
running a survey.

The five-minute promise, with a real time budget:

| Step | Budget | What the human does |
| --- | --- | --- |
| install | 40s | one command |
| `rhiz init` | 70s | reads the summary, presses Enter once at most |
| first `rhiz scout` | 90s | types one sentence |
| `rhiz ship --from` | 100s | types one command |
| `rhiz diff` + `rhiz accept` | 60s | reads a diff, accepts |
| **total** | **~6 min wall, 4 human actions** | |

Four human actions. Three of them are judgment (what to work on, is this diff right, do I accept
it). The fourth, the Enter at init, should be deleted by v1.1.

## 1. Ideal first-run experience

### 1.1 Install

Three paths, one binary.

```
npm  i -g @rhiz/harness      # or pnpm add -g / bun add -g
brew install werhiz/tap/rhiz # macOS and Linuxbrew, wraps a Node SEA, no runtime needed
npx  @rhiz/harness init      # zero-install trial, self-upgrades to a global hint at the end
```

Design rules for install:

- **No postinstall step.** Nothing to configure, no daemon, no login. `rhiz` is useful the second
  it lands on PATH.
- **The brew path must not require Node.** Node 20+ as an install prerequisite is a real
  five-minute killer on a fresh machine. Ship a single-file executable from day one of the public
  alpha; the npm package is for people who already have Node.
- **`npx` must work end to end**, including the first Work item. The trial has to complete, not
  bail at a "please install globally" wall.
- Version and update check happen in the background, printed as one line at most, never blocking.

### 1.2 `rhiz init`

`init` is not a wizard. Wizards are the canonical form of the clerical-action bug: they ask the
human for facts the machine can already read. `init` **detects, proves, proposes, and commits**,
and asks at most one question.

```
$ cd ~/code/acme-api
$ rhiz init

Rhiz Harness 0.1.0

  repo      acme-api   git, on main, clean, remote github.com/acme/api
  stack     TypeScript 5.9, pnpm 10, vitest, tsc, eslint
  verify    pnpm test          proven   8.2s   412 passed
            pnpm typecheck     proven   3.1s   clean
  workers   codex      ready   openai / gpt-5.3-codex        write, exec, cancel
            claude     ready   anthropic / claude-opus-5     write, exec, cancel
            dsh        absent  not installed
  auth      codex      ok      live ping 240ms
            claude     ok      live ping 310ms
  context   AGENTS.md, .cursor/rules/ (4), docs/CONTRIBUTING.md  indexed
  ledger    .rhiz/ledger   created

  Ground pack built in 11s.

Ready. Two things worth typing first:

  rhiz scout "where does rate limiting happen"    read only, cannot touch your tree
  rhiz ship  "add a --json flag to the cli"       writes to a branch, never your tree
```

What just happened, and why each part is non-negotiable:

**Environment and worker detection.** Probe PATH for `codex`, `claude`, `dsh`, `opencode`,
`goose`. Probe config directories (`~/.codex`, `~/.claude`, `~/.config/dsh`). Probe environment
for provider keys. For each hit, run the provider capability probe defined by `WorkerProvider`
and record what it can actually do: write files, execute commands, honor cancellation, stream
observations, context ceiling. The result is a **Worker catalog with provenance**, not a guess.

The human is never asked "which agent do you want to use?". Rhiz ranks deterministically
(capability match, then health, then declared preference, then stable id order) and prints the
ranking. Override is `rhiz workers prefer codex`, and it is a one-liner nobody needs on day one.

**Authentication health check.** Presence of a key is not health. Each detected worker gets one
cheapest-possible live round trip with a 5s timeout, cached in `.rhiz/state/auth.json` for 12
hours. The check distinguishes, and reports differently for, six states: absent, malformed,
invalid, expired session, valid but out of quota, rate limited. Each state prints the exact fix
line. A worker failing auth is not a blocker as long as one worker is healthy; Rhiz says so and
moves on. Blocking the whole init on a broken secondary provider is a bug.

**Repository grounding.** This is where the harness earns its first trust, and it is the part
every competitor skips. Grounding does not just read files. It **proves the verification path**:
it finds the candidate test, typecheck, lint, and build commands, then actually runs the fastest
one once and reports the real timing and result. The line `pnpm test  proven  8.2s  412 passed`
is worth more than a thousand words of onboarding copy, because it tells the developer that this
tool knows how to check its own work in their repo.

Grounding output is a `ContextPack` seed stored at `.rhiz/ground.json`, keyed by a hash of its
inputs (lockfile, package manifests, CI config, instruction files, toolchain versions) so it
invalidates itself and re-grounds silently when the repo changes. Nobody ever runs `rhiz ground`
by hand unless they want to.

**Where the one question lives.** If exactly zero workers are healthy, init cannot proceed and
must hand off:

```
  auth      no healthy worker found

  Rhiz needs one execution worker. The fastest path on this machine:

    codex login                    you have codex on PATH but no session
    claude /login                  you have claude on PATH but no session
    export ANTHROPIC_API_KEY=...   or bring your own key

  Then: rhiz init
```

That is judgment plus a credential, so it is a legitimate human action. Everything else at init
is not.

**Idempotence.** `rhiz init` is safe to run any number of times. It never destroys a ledger, never
resets config a human edited, and prints a diff of what changed if anything did. `rhiz init` on an
already-initialized repo is the same command as `rhiz doctor`, and that is intentional.

**Non-interactive.** `rhiz init --yes --json` for CI and for agents driving Rhiz. Every command
has this property (section 4.5).

## 2. Command architecture

### 2.1 Vocabulary principles

1. **Commands are the domain nouns and verbs.** `accept` exists because Acceptance is a distinct
   organizational decision in the Vocabulary. `board` exists because Board is the canonical
   projection. The CLI teaches the ontology by being it. A developer who learns the CLI has
   learned the architecture.
2. **No process vocabulary for organizational actions.** No `rhiz start`, no `rhiz stop`, no
   `rhiz kill`. Those words imply the process is the thing, and in this system the process is the
   most disposable object present. Work is started, attempts are run, workers are cancelled.
3. **The verb you type is the WorkType.** `scout`, `ship`, and `review` are the three WorkTypes
   and the three commands. That is not sugar, it is the point: choosing a verb selects an
   authority envelope.
4. **One concept, one command.** If two commands would show the same fact, one of them is a flag.
5. **Every command reads before it writes**, and says what it will do before doing it when the
   effect leaves the sandbox.

### 2.2 The full surface

**Tier 1, the five-minute path. These are the only commands in the quickstart.**

```
rhiz init                    detect, prove, ground, ready
rhiz scout   "<intent>"      read-only Work. Cannot mutate anything. Never needs approval.
rhiz ship    "<intent>"      writing Work in an isolated worktree. Your tree is untouched.
rhiz status                  what is happening right now
rhiz diff    [work]          what changed, with evidence attached to hunks
rhiz accept  [work]          the organizational decision. The one that matters.
```

**Tier 2, working the Board.**

```
rhiz board                   all live Work, grouped by state
rhiz review  [work]          independent REVIEW Work over an artifact or another Work item
rhiz verify  [work]          re-run the verification policy, produce fresh Evidence
rhiz reject  [work] <reason> explicit non-acceptance, recorded, keeps the evidence
rhiz decide                  answer pending decisions
rhiz why     <work>          reconstruct the reasoning and event chain from the Ledger
rhiz show    <id>            full detail of a Work, Attempt, Contract, Evidence, or Event
rhiz log     [work]          raw worker output, --follow
rhiz history                 accepted and rejected Outcomes over time, with the intervention count
```

**Tier 3, recovery and control.**

```
rhiz resume  [work]          continue non-terminal Work. No args: the most recent.
rhiz retry   [work]          new Attempt against the same Contract, failure evidence in context
rhiz cancel  [work]          stop attempts, keep the Work item and everything it learned
rhiz undo    <work>          revert an accepted Outcome by a new commit, recorded as a Decision
rhiz doctor                  diagnose, auto-repair what is safe, name what is not
rhiz workers                 catalog, health, capabilities, preference order
rhiz auth                    health per provider, with fixes
rhiz ground                  rebuild the ContextPack seed (normally automatic)
rhiz config                  read and set layered configuration
```

**Tier 4, later. Named now so the surface has room to grow without renaming anything.**

```
rhiz run   --type <T>        the explicit generic behind scout/ship/review. Scripts use this.
rhiz crew  <objective>       a bounded set of Workers on one Work graph
rhiz guard                   inspect and author mechanical boundaries
rhiz rules                   promoted Lessons, their evidence, and their scope
rhiz context                 what was selected for a Task and why
rhiz route                   routing decisions and their outcomes
rhiz bench                   the benchmark contract, baseline versus Rhiz
rhiz web                     local read-first Board and decision surface
```

### 2.3 Naming calls worth defending

- **`accept`, not `approve`.** Approval is a permission gesture. Acceptance is the Board decision
  that Work succeeded. The Vocabulary already made this distinction; the CLI must not blur it.
- **`why`, not `explain`.** `why wk_7f3a` is the single command that no other coding tool can
  offer, because no other coding tool has a durable typed event stream underneath. It should be
  the command people demo. It answers: what was asked, what contract was synthesized, which worker
  ran, what it read, what it decided and on what basis, what evidence exists, who accepted it.
- **`board`, not `list` or `ps`.** `ps` is process vocabulary and would teach the wrong model.
- **`scout` earns its place** because read-only Work with an empty WriteScope is structurally
  incapable of harm, and that fact should be visible in the verb the developer types. It is the
  safe on-ramp for a person who has known this tool for ninety seconds.
- **`undo` is a forward operation.** It creates a revert commit and a Decision event. It never
  rewrites history and never touches the Ledger. The Ledger is append-only, including about its
  own mistakes.
- **No `rhiz agent`.** Worker identity is not model identity (Vocabulary). Naming a command after
  the vendor category would re-import the confusion the architecture removes.

### 2.4 Aliases, on purpose

`rhiz s` = status, `rhiz b` = board, `rhiz d` = diff, `rhiz a` = accept. These four are typed
dozens of times a day. Everything else is spelled out. Short aliases for rare commands are
cognitive debt.

## 3. Information architecture

### 3.1 Four surfaces, one truth

The Ledger is the only source of truth. Everything a human sees is a Projection of it. This is
what makes it possible to have a plain CLI, a rich CLI, a TUI, and a web UI without any of them
becoming a second authority.

| Surface | When | What it is for | Rule |
| --- | --- | --- | --- |
| Plain CLI | not a TTY, or `--plain`, or `--json` | scripting, CI, agents driving Rhiz | every command, no exceptions, stable schema |
| Inline rich CLI | TTY, default | the daily loop | renders in place, collapses to a summary, keeps your scrollback |
| TUI | `rhiz board --tui` | multiple concurrent Work items, Crew | never the only route to a fact |
| Web | `rhiz web`, later | diffs, review threads, history, answering decisions from a phone | read-first, local-first, no account |

**The inline rich CLI is the default, not a fullscreen TUI.** This is the most consequential
interface decision in the document. A fullscreen TUI takes over the terminal, destroys scrollback,
breaks copy and paste, breaks piping, and makes the tool feel like an application you visit rather
than a command you run. The daily loop must feel like `cargo test`, not like `k9s`. The fullscreen
Board is a deliberate second surface for when concurrency actually justifies it.

### 3.2 Output tiers, progressive disclosure

Every command has three depths and picks the shallowest one that is honest.

- **Tier 1, resting state.** Ten lines or fewer. Facts plus the two or three commands you might
  want next. No JSON, no ids you do not need, no explanation of concepts.
- **Tier 2, `-v`.** Adds contract detail, per-step timing, evidence references, worker selection
  reasoning.
- **Tier 3, `-vv` or `rhiz show`.** Everything, including raw event envelopes.

Disclosure also happens over time, not just over flags:

- **Concepts arrive when they are load-bearing.** The word "Contract" is not in the init output.
  It first appears when a `ship` prints its acceptance criteria, because that is the moment it
  explains something the developer needs. "Ledger" first appears in `rhiz why`. "Attempt" first
  appears when a retry happens. Nobody reads an ontology up front.
- **Help adapts to state.** `rhiz` with no arguments is not a wall of commands. It is the current
  state plus the next action.

```
$ rhiz
  acme-api   1 verifying, 1 waiting for you

  wk_9c21  SHIP     verifying    pnpm vitest --repeat 20     1:04
  wk_a180  SHIP     decide       may I add a dependency?     asked 3m ago

  rhiz decide            answer wk_a180
  rhiz status            watch wk_9c21
```

- **Flags hide until relevant.** `--override` does not appear in `rhiz accept --help` until a
  verification has actually failed on that machine. Showing an escape hatch before the failure
  teaches people to reach for it.

### 3.3 On-disk layout

```
.rhiz/
  config.toml        committed. team truth: verification policy, authority ceilings, scope defaults
  rules/             committed. promoted Lessons scoped to this repo
  local.toml         gitignored. machine overrides
  ground.json        gitignored, regenerable. ContextPack seed + input hash
  ledger/*.jsonl     gitignored in alpha. append-only typed events
  evidence/          gitignored. test output, diffs, screenshots, receipts, addressed by hash
  work/<workId>/     gitignored. git worktrees, one per SHIP Work item
  state/             gitignored. caches: auth health, worker capabilities, projections
```

`rhiz init` writes the gitignore entries. Two files are committed and two only: `config.toml` and
`rules/`. Those are the artifacts a team reviews in a pull request. Everything else is either a
cache or a local durable log, and the alpha does not ask anyone to make a decision about syncing.

## 4. CLI examples

### 4.1 First Work: scout

```
$ rhiz scout "why is the login test flaky"

  wk_7f3a   SCOUT   read only
  scope     src/**, test/**              write scope: none
  accept    a named root cause with file level evidence

  codex   read  test/auth/login.test.ts                          0:04
  codex   read  src/auth/session.ts                              0:09
  codex   ran   pnpm vitest test/auth --repeat 20    3/20 failed  0:41
  codex   done                                                    1:12

  Root cause. session.ts:88 seeds the clock from Date.now() at module
  import. The test freezes time in a beforeEach that runs after that
  import. The 3 failures are exactly the runs that crossed a second
  boundary between import and freeze.

  evidence  3 files read, 1 command, 20 runs, 3 reproductions

  rhiz why  wk_7f3a           the full chain
  rhiz ship --from wk_7f3a    turn this into a fix, context carried over
```

`--from` is the single highest-value ergonomic in the tool. It is the deletion of the most common
clerical action in agentic coding: re-explaining to the second agent what the first one found.
The ContextPack, the evidence, and the reproduction command all carry forward as durable
references. The human types eleven characters instead of a paragraph.

### 4.2 Writing Work: ship

```
$ rhiz ship --from wk_7f3a

  wk_9c21   SHIP    from wk_7f3a
  branch    rhiz/fix-login-clock-seed     worktree, your tree untouched
  write     src/auth/**, test/auth/**
  accept    1  pnpm vitest test/auth --repeat 20 passes 20/20
            2  no new type or lint errors
  verify    pnpm vitest test/auth --repeat 20 && pnpm typecheck && pnpm lint

  claude  edit  src/auth/session.ts          +6 -2                0:22
  claude  edit  test/auth/login.test.ts      +3 -0                0:31
  claude  done                                                    0:44

  verify  pnpm vitest test/auth --repeat 20   20/20 passed        0:58
  verify  pnpm typecheck                      clean               1:09
  verify  pnpm lint                           clean               1:12
  review  codex                               2 notes             1:31
          session.ts:88    prefer injecting a Clock port over reading module state
          login.test.ts:44 this assertion duplicates line 40

  wk_9c21  verified, not accepted

  rhiz diff   wk_9c21
  rhiz accept wk_9c21          merge into main, 2 files, +9 -2
```

Three constitutional invariants are visible in that transcript and each one is a feature the
developer can feel:

- **The tree is untouched.** SHIP Work happens in a git worktree on its own branch. This single
  decision removes most of the reasons other tools interrupt you mid-run, because the blast radius
  until `accept` is zero. It also makes `cancel` free and `undo` trivial.
- **Finished, verified, and accepted are three lines.** The worker said done at 0:44. That meant
  nothing. Verification produced evidence at 1:12. That still was not acceptance.
- **The reviewer is not the author.** `claude` wrote it, `codex` reviewed it. Default policy is a
  different provider for REVIEW than for SHIP, because a reviewer that can silently repair its own
  finding is not a reviewer.

### 4.3 Diff with evidence

```
$ rhiz diff wk_9c21

  src/auth/session.ts                                        +6 -2
  covered by  vitest test/auth --repeat 20  (20/20)  fresh 3m ago

   87   export function createSession(user: User) {
   88 - const now = Date.now()
   88 + const now = clock.now()
   89   ...

  review  codex  prefer injecting a Clock port over reading module state
                 rhiz ship "inject a Clock port in session.ts" --from wk_9c21

  test/auth/login.test.ts                                    +3 -0
  covered by  vitest test/auth --repeat 20  (20/20)  fresh 3m ago
  ...

  2 files  +9 -2   all hunks covered by passing evidence
```

Per-hunk evidence coverage is the differentiator. The question a reviewer actually has is not
"what changed" but "what proves this". Since Evidence is already durable and attributable in the
architecture, attaching it to hunks is a projection, not new machinery. An uncovered hunk is
called out loudly, because an uncovered hunk is where the bugs are.

### 4.4 Accept

```
$ rhiz accept wk_9c21

  merged    rhiz/fix-login-clock-seed into main    2 files  +9 -2
  accepted  wk_9c21  by you@example.com
  ledger    17 events, 4 evidence artifacts, 1 review

  1 human action produced this outcome. Today: 4 actions, 3 outcomes.
```

The last line is the North Star, printed. It is not a vanity metric and it is not gamified. It is
the number the Constitution says the project exists to reduce, shown to the person who can feel it
move. Over a month it becomes the reason people trust the tool.

### 4.5 Machine mode, everywhere

```
$ rhiz board --json | jq '.work[] | select(.state=="verifying") | .id'
$ rhiz accept wk_9c21 --json
$ rhiz scout "audit the auth module" --json --quiet
```

`--json` on every command with a versioned schema. Exit codes carry meaning: `0` accepted or
clean, `1` operational error, `2` verification failed, `3` decision required, `4` blocked, `5`
authority denied. A CI job or a supervising agent can drive the entire surface without parsing a
single line of prose. Rhiz is a harness; other harnesses will drive it, and that is a supported
use case rather than an accident.

## 5. Status and Board UX

### 5.1 Progress is evidence, never a spinner

The Constitution says process liveness is an Observation and not proof of progress. The status
line must therefore never be a spinner, because a spinner is a lie shaped like reassurance. Status
shows two clocks: how long the attempt has run, and how long since the last durable event.

```
$ rhiz status

  wk_9c21  SHIP  running  claude  2:14      last event 0:06 ago
           edit src/auth/session.ts, 3 commands, 2 files touched

  wk_a180  SHIP  decide   waiting on you    asked 4m ago
           may I add `@sinonjs/fake-timers` as a devDependency?

  wk_7f3a  SCOUT accepted 12m ago
```

### 5.2 Stall detection

When the two clocks diverge, say so plainly and act on a timer instead of asking.

```
  wk_9c21  SHIP  running  claude  4:12      last event 3:50 ago

  The process is alive. Rhiz has seen no file write, no command, and no
  message since 0:22. Stall policy will cancel this attempt at 6:00.

  rhiz log wk_9c21 --follow      raw worker output
  rhiz cancel wk_9c21            stop now, keep the Work
```

Acting on a stall rather than asking about one is doctrine, not convenience. A human sitting there
deciding whether a hung agent has hung is a clerical action, and the machine has strictly better
information about it than the human does.

The threshold is a **policy, not a constant**. The 6:00 in that transcript is a provisional
default and is deliberately not frozen (ADR 0015, decision D5). Stall policy declares the
durable-event threshold, the action, and whether the action is automatic, and every stall and every
operator override is recorded in the Ledger. The permanent default comes from a later ADR citing
the observed distribution of durable-event gaps, the false-cancel rate, and the recovered-work
rate. A repository with a slow integration suite and a repository of small pure functions should
not be assumed to share a number.

### 5.3 Board

`rhiz board` groups by Work state using the Kernel projection states, in exactly the order that
matches what a person should do about them.

```
$ rhiz board

  waiting on you     1
    wk_a180  SHIP   decide     add a devDependency?             4m

  ready to accept    1
    wk_9c21  SHIP   verified   +9 -2, 3 checks green, 2 notes   3m

  running            2
    wk_b044  SHIP   claude     6 files, last event 0:04 ago     1:31
    wk_b190  SCOUT  codex      reading, last event 0:11 ago     0:52

  blocked            1
    wk_c001  SHIP   verify failed  17/20 passed                 22m

  recent             3 accepted, 1 rejected today
```

"Waiting on you" is always first and always counted, because the count of things blocked on a
human is the inverse of the North Star. `rhiz board --tui` is the same content, fullscreen,
live, with keyboard navigation, and is warranted the moment a developer routinely runs three or
more Work items at once. Not before.

### 5.4 Selection copy and terminal affordances

The clerical action nobody counts is copying an identifier out of a terminal.

- **Copy on highlight.** In the TUI and in `rhiz web`, selecting text copies it immediately, the
  X11 primary-selection behavior, on every platform. No modifier, no menu. In the plain terminal
  Rhiz cannot control selection, so it compensates below.
- **OSC 52 for the clipboard.** Rhiz writes to the system clipboard through the terminal escape
  sequence, which means copy works identically over SSH and inside tmux. `rhiz status --copy`
  puts the most likely next thing on the clipboard: the failing command, the work id, the branch
  name, whichever is the actionable one in the current state.
- **OSC 8 hyperlinks.** Every file path printed is a hyperlink into the configured editor
  (`vscode://`, `cursor://`, `idea://`, or `$EDITOR`). Every work id is a link into `rhiz web`
  when it is running. Clicking a path in a stack trace is the fastest debugging affordance in
  existence and it costs one escape sequence.
- **Ids are selection friendly.** `wk_9c21` is short, has no ambiguous characters, and
  double-click-selects as one token in every terminal. Long ids and paths never wrap; they
  truncate with the meaningful end preserved.
- **Every error block ends with one copyable line.** Not a paragraph containing a command. One
  line, alone, that can be double-clicked and run.

### 5.5 Notifications

The rule: **notify on judgment, never on progress.**

| Event | Bell | OS notification | Web push |
| --- | --- | --- | --- |
| decision requested | yes | yes | yes |
| verification failed | no | yes if run exceeded 60s | yes |
| ready to accept | no | yes if run exceeded 60s | yes |
| accepted, rejected | no | no | no |
| worker progress | never | never | never |

Two suppression rules that matter more than the table. First, **never notify about a run the human
is currently watching**: if the terminal is focused and attached, the screen already said it.
Second, **the attention threshold**: no notification for anything that finished inside 60 seconds,
because the human never left.

`rhiz prompt` emits a shell prompt segment for starship, powerlevel10k, and fish, showing pending
decisions and ready-to-accept counts. It is the lowest-friction notification channel that exists,
because it appears exactly when the human returns to a terminal and never when they do not.

## 6. Failure states

Design rule for every failure: **name what happened, name what is still intact, give one command.**
The middle clause is the one everyone skips and the one that determines whether a developer trusts
the tool after its first bad day.

### 6.1 No healthy worker

```
  auth  no healthy worker

  codex   session expired 2 days ago
  claude  no credentials found
  dsh     not installed

  Nothing was lost. No Work has started.

  codex login
```

### 6.2 A secondary provider is down

Not an error. A line in the init summary and a routing decision recorded in the Ledger. The run
proceeds on the healthy worker with the reason attached, per the Workers v0 fallback contract.

```
  workers  claude unhealthy (401), routed to codex   reason: preferred provider auth failed
```

### 6.3 Verification failed

```
  verify  pnpm vitest test/auth --repeat 20    17/20 passed   FAILED

  wk_9c21 is blocked, not failed. The branch, the diff, and the evidence
  are intact. Your working tree was never touched.

  rhiz diff   wk_9c21                     look first
  rhiz retry  wk_9c21                     new attempt, failure output in context
  rhiz accept wk_9c21 --override "known flake, tracked in acme/api#412"
```

`--override` records a Decision with the stated reason and marks the Outcome as accepted over
failing evidence. It is not hidden and it is not shameful, because refusing to model the real world
just pushes people to `git merge` behind the tool's back. It is, however, counted, and
`rhiz history` shows the override rate.

### 6.4 Worker crash or terminal death

Recovery is automatic and silent. The next `rhiz` invocation of any kind reconciles: dead pid, no
heartbeat, orphaned attempt. It emits `attempt.failed(reason=orphaned)`, returns the Work to
`ready`, and prints one line. It does not ask permission to recover, because "would you like to not
lose your work" is not a question.

```
$ rhiz status

  recovered  wk_9c21  attempt at_3d81 died with its terminal (pid 44120 gone)
             Work is ready again. 2 files written before the crash are on
             the branch and are in the diff.

  rhiz resume wk_9c21
```

### 6.5 Authority denied

```
  authority denied

  wk_b044 tried to write config/production.yaml, which is outside its
  write scope (src/**, test/**). The write did not happen. The attempt
  is paused, not failed.

  rhiz decide wk_b044 --grant config/production.yaml   one file, this Work only
  rhiz decide wk_b044 --deny "use the staging override instead"
```

Note what this is not: a modal prompt in the middle of a run that blocks everything until a human
returns. The attempt pauses, the Board records a pending Decision, other Work continues, and the
notification fires. Blocking the whole system on one question is the failure mode that makes
agentic tools feel like babysitting.

### 6.6 Ledger or projection corruption

```
  doctor  Board projection did not match the Ledger at event 412

  The Ledger is append-only and intact. The projection is derived, so it
  was rebuilt from events. 412 events replayed in 90ms. No Work lost.
```

Rebuilding a projection is safe by construction, so `doctor` just does it. This is the payoff of
the event-sourced design showing up as a UX property: the scary failure class is the cheap one.

### 6.7 Dirty tree, conflicts, and the merge at accept

Because SHIP never touches the working tree, the only moment conflicts can appear is `accept`.
When they do:

```
  accept  cannot fast forward. main moved 6 commits since wk_9c21 branched.

  Nothing merged. The branch is intact.

  rhiz accept wk_9c21 --rebase      replay onto main, re-run verify, then merge
  rhiz accept wk_9c21 --pr          open a draft pull request instead
```

`--rebase` re-runs verification after the rebase before merging, because evidence gathered against
a different tree is stale evidence, and the EvidenceRequirement has a freshness field for exactly
this reason.

## 7. Configuration model

### 7.1 Layers

Lowest to highest precedence:

1. built-in defaults, sufficient for a zero-config repo
2. `~/.rhiz/config.toml`, machine and person: worker preference, notifications, editor, theme
3. `.rhiz/config.toml`, committed, the team artifact
4. `.rhiz/local.toml`, gitignored, personal overrides in a shared repo
5. `RHIZ_*` environment variables
6. command flags

`rhiz config get verify.command --explain` prints the resolved value and the layer it came from.
Configuration systems become unusable at the moment nobody can answer "where did this value come
from", so the answer ships with the feature rather than after the first bug report.

### 7.2 The one asymmetry: authority ratchets down only

Precedence is standard for everything except authority. **A higher-precedence layer may narrow an
authority ceiling and may never widen one.** If the committed `.rhiz/config.toml` says SHIP Work
may never write outside `src/**` and `test/**`, no machine config, no environment variable, and no
flag can widen it. Widening requires editing the committed file, which means a pull request, which
means review.

This is the guard that makes `.rhiz/config.toml` worth committing at all, and it is the difference
between a policy file and a suggestion file.

### 7.3 Shape

```toml
# .rhiz/config.toml   committed

[verify]
command = ["pnpm test", "pnpm typecheck", "pnpm lint"]
timeout = "10m"
freshness = "15m"          # evidence older than this is re-run before accept

[authority]
write_scope   = ["src/**", "test/**", "docs/**"]   # ceiling, cannot be widened downstream
never_write   = ["config/production*", ".env*", "infra/**"]
network       = "install-only"
external      = "deny"     # no deploys, no publishes, no sends, no spend

[work.ship]
isolation = "worktree"     # worktree | branch | tree. worktree is the default and the point.
review    = "different-provider"

[stall]
# Policy, not a constant. The shipped default is provisional until dogfood
# evidence sets it. See ADR 0015, decision D5.
threshold = "3m"           # no durable event for this long, while the process is alive
warn_at   = "50%"          # surface the stall before acting on it
action    = "cancel"       # cancel | warn
automatic = true

[workers]
prefer = ["codex", "claude"]
```

```toml
# ~/.rhiz/config.toml   personal

[notify]
decisions = ["bell", "os"]
threshold = "60s"

[ui]
editor = "cursor"
copy_on_highlight = true
```

Zero configuration must remain a supported state forever. Every key above has a default that
`rhiz init` derived from the repo, and the file it writes is short with the rest commented out.
A configuration file the tool wrote and nobody reads is better than a wizard the human answered.

## 8. Minimum public alpha

The alpha is judged by one question: can a stranger reach an accepted Outcome in five minutes on a
repo Rhiz has never seen? Everything that does not serve that is cut.

**In.**

- single-file binary via brew, plus npm, plus a working `npx` path
- `init` with detection, live auth ping, and proven verification commands
- worker detection for codex and claude, two providers satisfying one portable contract, which is
  also Kernel exit criterion 3
- `scout`, `ship`, `--from`, `status`, `diff`, `accept`
- worktree isolation for all SHIP Work
- automatic verification at attempt end, `verify` to re-run
- automatic crash and orphan recovery, `resume`
- inline rich CLI plus `--json` on every command, meaningful exit codes
- `why`, even if its first version is a plain event dump. It is the demo.
- the interventions-per-outcome line at accept
- `doctor`
- failure copy for the seven states in section 6

**Out of the alpha, deliberately.**

- fullscreen TUI. Ship it when someone runs three Work items at once and complains.
- web UI and any account, login, or hosted anything
- Crew, task graphs, concurrency admission control
- Router, learned routing, cost optimization
- Guard authoring UI. Guards exist as config, not as a product surface.
- Refiner and automatic Lesson promotion. Lessons are collected in the Ledger from day one and
  promoted by hand, because automatic promotion without dogfood evidence violates invariant 14.
- team ledger sync
- anything named "dashboard"

**The alpha's honesty obligations.** It says out loud what it does not do, it never fabricates a
verification it did not run, and when it is uncertain about the repo it grounds narrowly and says
so rather than guessing widely.

## 9. Later premium experience

Premium is not more buttons. Every item below is a further reduction in human actions, which means
the pricing story and the North Star are the same sentence.

**Crew.** One objective, a Work graph, several Workers, mechanical supervision. The human states
an outcome and answers decisions. `rhiz crew "migrate the billing module off stripe-node v11"`.
The fullscreen Board becomes the primary surface here, because now concurrency is real.

**Router.** Learned worker, model, and context selection from recorded Route outcomes. The user
action it deletes is choosing, and then second-guessing, which agent to use. It must always be able
to answer `rhiz route --why`.

**Context.** Measured ContextPack strategies, with the benchmark showing that a smaller selected
context beat a larger one. This is invariant 8 turned into a product feature, and it is the one
most likely to produce a defensible, publishable result.

**Refiner.** Repeated evidence becomes proposed Rules and Guards, presented as a reviewable diff
to `.rhiz/rules/` with the evidence attached. Promotion is always reviewable. The user action it
deletes is correcting the same mistake a third time.

**Web and mobile decisions.** Answering a pending Decision from a phone while the Crew keeps
working. The user action it deletes is being physically at the terminal.

**Team Ledger.** Shared Board across a team, shared rules, shared benchmark history. Now `history`
answers "how many human interventions did this team spend per shipped outcome last month", and
that is a number a VP will pay for.

**Provenance and audit export.** Invariant 16 as a compliance product: a signed reconstruction of
who and what produced a change, with evidence. Regulated teams need this and nothing else on the
market produces it, because nothing else records typed events at the organizational layer.

## 10. Implementation sequence

Sequenced so that each phase is demonstrable on its own and so that nothing is built before the
Kernel seam it depends on. Phase numbering continues the repository's existing plan rather than
competing with it.

**Phase D0. Contract only.** Freeze the command surface in this document as an ADR. Write the
`--json` schema and the exit codes first, before any rendering, so the plain interface is the
contract and the pretty interface is the projection. Write the failure copy for section 6 as
fixtures. Copy written before code is copy that got designed.

**Phase D1. Detect and prove.** `rhiz init`, `doctor`, `workers`, `auth`, `ground`. This phase
ships value with zero Work execution: it tells a developer what their machine and repo can do, and
it proves the verification path by running it. It is independently useful and independently
demoable, which makes it the right first thing.

**Phase D2. One Work end to end.** `scout` and `ship` over the existing Kernel contracts, worktree
isolation, automatic verification, `status`, `diff`, `accept`. Depends on Kernel 0.1 exit criteria
2, 3, 6, and 7. At the end of this phase the five-minute promise is testable, and it should be
tested by handing a laptop to someone who has never seen the project and timing them.

**Phase D3. Durability made visible.** `resume`, `retry`, `cancel`, automatic orphan recovery,
`why`, `history`, and the interventions-per-outcome counter. Depends on Kernel exit criteria 4 and
5. This is the phase where the architecture stops being an internal virtue and becomes something a
developer can feel, and `why` is the moment the product becomes explainable to a stranger in one
screen.

**Phase D4. Decisions without blocking.** `decide`, pending-decision Board grouping, notifications,
the shell prompt segment, authority-denied pause semantics. This is where the One Less Action
Doctrine gets its sharpest test: measure the count of blocking prompts per outcome before and
after, and treat any prompt that survives as a defect with an owner.

**Phase D5. Terminal craft.** OSC 52 clipboard, OSC 8 hyperlinks, `--copy`, copy-on-highlight in
the TUI, output tiering, adaptive help. Small, cheap, and disproportionately responsible for
whether the tool feels expensive.

**Phase D6. Second surface.** `board --tui`, gated on real evidence of concurrent Work. Then
`rhiz web`, read-first and local-first.

Then Crew, Router, Context, Guard, and Refiner, each gated on dogfood evidence per invariant 14,
and each measured against the benchmark contract per invariant 15.

**Two cross-cutting gates, applied every phase.**

1. **The five-minute test is a CI fixture, not a vibe.** A scripted fresh-machine run against a
   fixture repo, timed, with the human-action count asserted. If a change adds a human action,
   the build goes red and the change needs a justification in the commit message.
2. **Every prompt is a defect until proven judgment.** Any interactive prompt in the codebase
   carries a comment naming which of the four approval classes in section 11 it belongs to. No
   class, no prompt.

## 11. Reference: what disappears, what defaults, what needs a human

### 11.1 Actions that disappear

| Action developers do today | Why it exists | What deletes it |
| --- | --- | --- |
| choosing which agent to run | no capability model | deterministic Worker catalog and ranking |
| re-explaining findings to a second agent | context dies with the session | `ship --from <work>` carrying the ContextPack |
| pasting file paths and errors into a prompt | no repo grounding | `ground.json` plus evidence references |
| polling "is it done yet" | no durable progress model | two-clock status, stall detection, notify on judgment only |
| copying a work id or a failing command | terminal friction | OSC 52, `--copy`, copy on highlight |
| running the tests by hand after the agent finishes | verification not modeled | automatic verify at attempt end with an EvidenceRequirement |
| cleaning up after a bad run | the agent wrote to the working tree | worktree isolation, `cancel` is free |
| re-running everything after a crash | state lived in the process | Ledger replay, silent orphan reconciliation |
| repeating the same correction every week | no learning path | Lessons in the Ledger, then Refiner |
| deciding whether a hung process is hung | only liveness was observable | last-durable-event clock and auto-cancel |
| answering "which files may it touch" every run | no policy layer | committed authority ceiling in `.rhiz/config.toml` |
| picking a reviewer | not modeled | different-provider REVIEW by default |

### 11.2 Smart defaults

- WorkType inferred from the verb and the intent, always shown, always overridable with `--type`.
- Scope inferred from grounding; WriteScope is always narrower than Scope and never leaves the repo.
- Verification policy inferred from the proven commands found at init.
- Worker chosen by capability match, health, then declared preference, with the reason recorded.
- Review by a different provider than the author.
- Isolation by worktree for every SHIP.
- Attach when interactive, detach when piped, survive either way.
- Evidence freshness of fifteen minutes, re-verified before accept.
- Stall policy warns and then cancels an attempt with no durable event, on a configurable
  threshold. The shipped default is provisional and set by evidence in a later ADR, not here.
- Auth health cached twelve hours, re-pinged on the first failure rather than on a schedule.

### 11.3 When approval is genuinely required

Exactly four classes. Anything outside them that prompts a human is a defect.

1. **Effects that leave the sandbox and are hard to reverse.** Push to a protected branch, deploy,
   publish, send, spend, mutate an external system, delete data outside the worktree.
2. **Authority expansion.** A Worker needs to write outside its WriteScope, read a secret, or reach
   the network beyond its declared policy.
3. **Genuine ambiguity where two readings produce materially different work**, and only after Rhiz
   has tried to resolve it from grounding, history, and rules. The prompt must state both readings
   and the assumption it would make if it had to choose.
4. **Acceptance.** Always. Acceptance is the organizational decision and belongs to a human by
   constitutional design. The exception is a repo that explicitly opts into auto-accept when every
   AcceptanceCriterion is satisfied by fresh Evidence and review is clean, which is a later
   feature and is off by default.

Everything else happens without asking: writing inside WriteScope, running tests and builds,
installing dependencies inside the sandbox, creating branches and worktrees, retrying, choosing
and re-routing workers, re-grounding, opening a draft pull request, recovering from a crash,
rebuilding a projection.

## 12. Competitive read

| Tool | Steal | Avoid |
| --- | --- | --- |
| `gh` | verb/noun architecture, `--json` on everything, `auth status` and `auth login` as the pattern for health plus fix | it assumes one remote service; Rhiz has to model many replaceable providers |
| `vercel` and `fly launch` | detect the framework, infer the whole config, confirm once, ship. The best init in the industry. | the confirm is still a prompt; Rhiz should be able to delete it entirely because SHIP is sandboxed |
| `stripe` CLI | `login` and `listen`, and the live event log as a first-class debugging surface. Very close to what `rhiz why` and `rhiz log` should feel like. | hosted-only |
| `cargo` and `rustc` | errors that name the fix, the run summary block, zero need for a doctor because the errors are that good | compile-time model does not transfer |
| `turbo` and `nx` | end-of-run summary with timing and cache attribution | task-graph config heaviness |
| `aider` | disciplined diff and commit hygiene, repo map as grounding | state dies with the session, no verification or acceptance separation |
| Claude Code and Codex CLI | inline rich single-agent loop, excellent attach ergonomics, `--from`-style continuation is missing and wanted | closing the terminal loses work; finished, verified, and accepted are one concept; no durable Board |
| `k9s`, `lazygit` | the fullscreen surface done right, once concurrency justifies it | making the TUI the only route to a fact |
| Devin and hosted agent platforms | the Board and the async decision inbox are the right ideas | web-only, opaque, no local truth, no reconstructible history |
| `supabase init`, many scaffolders | nothing | the multi-question wizard. This is the anti-pattern this document exists to prevent. |

The gap none of them fill, and the one this design is built to occupy: **a durable, reconstructible
organizational layer above interchangeable agents, with completion, verification, and acceptance as
three separate facts.** `rhiz why` and the interventions-per-outcome counter are the two commands
that are impossible to build without that architecture, which makes them the right things to put
in front of a stranger in the first five minutes.
