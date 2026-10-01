# Independent architecture review: Kernel 0.1 through Durable Ledger v1

Date: 2026-08-20
Reviewer: independent principal-engineer pass, read-only
Scope: the stacked pull requests #1, #2, #3, #5, #6, #7 at `feat/ledger-v1` @ `c79d27a`, plus an addendum on #8 `feat/guard-v0` @ `9c65dfa`
Standard applied: what this codebase would need to survive as critical infrastructure used by thousands of developers
Constraint: no source changes were made during this review

## How to read this

Findings are ranked P0 (catastrophic), P1 (must fix before public alpha), P2 (should fix), P3 (improvement). Every P0 and P1 carries a failure scenario, the affected components with file and line references, a reproduction, an architectural correction, and the regression test that should permanently prevent recurrence.

Each P0 and P1 is also filed as a GitHub issue. The index is at the end of this document. This file is the durable record; the issues are the work queue.

This is a point-in-time review. Line references are accurate against the commits named above and will drift.

## Verdict

The epistemics of this design are stronger than most systems in this category. The separation of worker completion from verification from acceptance, revision-bound verification, drift detection bracketing every check, the acceptance-readiness gate, and a real `SIGKILL` crash-recovery proof are all genuinely good, and the Constitution names the right invariants.

The physics are not yet there. Two things fail in the same direction, silently, on the success path:

1. Nothing binds a worker to the workspace the Board believes it is judging.
2. "Exact workspace identity" is defined by what git can see, which is not what executes.

Both fail open. A harness whose failure mode is "everything reports green while the wrong tree was edited by an unconfined process" is more dangerous on a production repository than no harness, because it manufactures confidence.

**Would I trust this Harness to modify my production repository today? No. Confidence: 3.5 / 10.** The path to 9.5 is at the end of this document.

---

## P0. Catastrophic

### P0-1. A Worker cannot be bound to the Crew workspace. The portable contract has no place to put it.

**Components.** `src/host.ts:38-46` (`WorkerStartRequestSchema` has no workspace field). `adapters/dsh/product-routes.ts:451-529` (`cwd` is fixed at host construction, defaulting to `process.cwd()` at line 521). `adapters/dsh/index.ts:300-326` (`DshSdkWorkerProvider.start()` receives no workspace at all). `src/crew.ts:640-660` (`CatalogCrewWorkerResolver` is handed `workspace` and discards it).

**Failure scenario.** Crew acquires a detached worktree, snapshots it, runs a SHIP mission, snapshots again, finds `changedPaths: []` and `changeViolations: []`, and projects Board to `verifying`. Meanwhile the Codex or Claude subagent has been editing the operator's live checked-out repository. Verify runs its checks against the pristine worktree, passes, and emits `artifact-identity` evidence for a digest describing a tree nobody touched. Acceptance succeeds. Board truth and physical reality decouple completely, without a single error.

`scripts/dsh-product-operator-proof.mjs:237-249` is the tell: it hand-builds a worktree and passes `cwd: proofWorkspace` itself, precisely because the Crew path cannot.

**Reproduction.** Compose `CrewSupervisor` with `GitWorktreeWorkspaceProvider` and a catalog built from `createDshProductWorkerHost()` with no `cwd`. Run a SHIP mission that creates a file. Assert `receipt.changedPaths` is empty, then observe `git status` dirty in the source repository.

**Correction.** `WorkerStartRequest` carries the workspace. `WorkerProvider.start` executes inside it or throws `WorkerBoundaryError`. Host-level `cwd` is removed, not defaulted. `WorkerDescriptor` gains `bindsWorkspace`, and `selectWorkerProvider` refuses non-binding providers for any mission that owns a workspace.

`docs/CREW_V0.md` lists production DSH workspace binding under Deferred. Deferring the implementation is reasonable. Deferring the contract slot is what makes this P0, because the composed system fails open instead of refusing to run.

**Regression test.** A provider fixture records the `executionRoot` it was handed and writes a sentinel there. Assert the sentinel lands inside the workspace, appears in `receipt.changedPaths`, and that the source repository stays clean. Negative case: a non-binding provider is rejected at selection.

### P0-2. "Exact workspace identity" is git-scoped, so it is not exact.

**Components.** `adapters/git/worktrees.ts:55-65` (`changedPaths`), `:67-91` (`workspaceDigest`), consumed by `src/verify/util.ts:25-39` and `src/crew.ts:390-420`.

**Failure scenario.** The digest is HEAD plus `git status` plus `git diff` plus `ls-files --others --exclude-standard`. All of those honour `.gitignore`, so `node_modules/`, `dist/`, `.env`, build caches, and `.git` itself lie outside the identity Verify calls exact.

A SHIP worker rewrites `node_modules/<dep>/index.js`. The digest is unchanged, `changeViolations` is empty, `sameTarget` reports no drift, and `LocalCommandVerifierProvider` then runs `npm test` inside that workspace and loads the poisoned module. The compromised artifact escapes detection and executes inside the verifier, while the receipt attests identity for a digest that does not cover the bytes that ran.

The same blindness makes read-only drift detection vacuous, since a SCOUT can write freely to any ignored path.

**Reproduction.** Temp repo ignoring `node_modules/`. Snapshot, write `node_modules/x/index.js`, snapshot again. The digests match and `changedPaths` is empty.

**Correction.** Identity must be a content digest of the execution root as it will be executed: a bounded, streaming, symlink-aware walk with a small explicit exclusion list recorded in the target, or a hash of the exact inputs the checks will load. Alternatively, run checks against a freshly materialised tree built only from git-visible content so nothing outside the digest can influence the result. `VerificationTarget` should carry its digest scope explicitly so a receipt can never imply more coverage than it has.

**Regression test.** The digest changes when an ignored file changes. Read-only missions flag ignored-path writes. End to end, verification fails when the workspace changed outside git's view.

### P0-3. There is no enforcement boundary. Authority is prose; containment is post-hoc and one directory wide.

**Components.** `adapters/dsh/index.ts:162-206` and `adapters/dsh/product-routes.ts:253-298` (authority rendered into the prompt). `src/schemas.ts:51-69` (`AuthorityPolicy` never consulted). `src/board.ts:306-531` (`authority.granted` and `authority.denied` fall through `default: break`). `src/crew.ts:390-420` (writeScope checked only afterwards, only inside `executionRoot`). `adapters/dsh/index.ts:381` and `adapters/dsh/product-routes.ts:544` (both hosts return `null` from `sandbox()`).

**Failure scenario.** Codex at `permissionMode: "never"` and Claude at `"dontAsk"` both classify as `writeAccess: "host-policy"`, meaning unknown, and are accepted for every mission type. Nothing confines the process: no sandbox, no seccomp or Landlock, no container, no per-mission uid. A worker that writes `~/.ssh/authorized_keys`, `~/.claude/settings.json`, or the parent repository's `.git/config` (`core.fsmonitor`, `core.pager`, hooks, all of which the harness later triggers by running git in that repository) is neither prevented nor detected.

Constitution §9 states that prompt text alone is not an enforcement boundary. The shipped system has nothing else.

**Reproduction.** A SCOUT mission instructed to `touch ~/rhiz-escape` and to append a hostile `[core] pager` to the parent repository's config. Board reaches `verifying` with no violations and both markers exist.

**Correction.** Ship a real boundary before public alpha, or ship the honest claim instead. Minimum viable: OS-level confinement whose allow-list derives from `scope` and `writeScope`; `HostCapabilities.sandbox` required true for any non-plan write access; `authority.granted` and `authority.denied` emitted as real projection events at the enforcement seam; every git subcommand run with `-c core.fsmonitor= -c core.hooksPath=/dev/null -c core.pager=cat` and `GIT_CONFIG_NOSYSTEM=1`; `writeAccess: "host-policy"` treated as deny.

**Regression test.** A fixture worker attempting writes to the temp directory, the parent `.git/config`, and `$HOME` fails at the OS boundary and produces `authority.denied`. Git subcommands ignore repository-supplied config.

---

## P1. Must fix before public alpha

### P1-1. The durable ledger is corruption-evident, not tamper-evident.

`adapters/local/durable-ledger.ts:83-85`, `:556-583`. An unkeyed SHA-256 chain over public data in a file writable by the same uid as the workers it adjudicates. Rewrite the log, recompute digests forward, and `validateRecordChain` passes. Board is purely a projection of that file, so forged acceptance is indistinguishable from real acceptance. `actor` (`src/schemas.ts:186-199`) is an attacker-chosen string never authenticated at append, which makes "an execution actor cannot accept its own work" (`src/board.ts:512-516`) a labelling convention rather than a control.

Correction: HMAC under a key workers cannot read, or per-writer signatures; anchor the head digest outside the machine; authenticate actor identity at append; store the ledger outside any repository a worker can reach.

Regression test: a rewritten ledger with a recomputed chain fails `open()`.

### P1-2. Negative controls cannot falsify.

`src/verify/schema.ts:32-63`, `src/verify/engine.ts:240`. Nothing requires a control's config to differ from its primary, nothing requires it to run against a perturbed target, and the engine requires it to pass. An always-passing verifier satisfies its own control, which is visible in `test/ledger-crash-recovery.test.ts:56-85`. The one mechanism built to catch vacuous passes cannot catch the most common vacuous pass in this repository's own recorded history.

Correction: run the control against a deliberately perturbed target and require `fail`; enforce config divergence; record the perturbation in the receipt.

Regression test: an always-pass provider produces an overall failed verification because its control did not fail.

### P1-3. Required evidence can be satisfied by the harness's own identity evidence.

`src/verify/engine.ts:225-239`, `src/board.ts:205-212`. `identity` is prepended unconditionally before filtering by `acceptedKinds`, so any requirement accepting `artifact-identity` is satisfied with zero passing checks. The system's own observation becomes proof that the observed thing is correct. `adapters/local/command-verifier.ts:15` forbids a command from impersonating identity evidence, showing the risk was seen; the engine then emits it for free.

Correction: attach identity once at the event level; requirement satisfaction comes only from passing primary checks bound to that requirement.

### P1-4. Dependency worker output is injected into the next worker's prompt.

`src/crew.ts:423-445`, `:661-663`. Untrusted model output derived from untrusted repository content is spliced into the downstream objective, mitigated only by a sentence of prose. This is the enforcement mechanism the Constitution forbids. The same channel writes attacker-controlled text into durable events consumed by every later replay.

Correction: pass dependency reports as data through a structurally separated channel, never in the same string as the contract. Treat model-authored strings as tainted in the type system.

### P1-5. No liveness reconciliation. Board tracks attempts by label, never by process.

`src/crew.ts:700-706` (no timeout, no process handle), `src/host.ts:99` (`ProcessProvider` is an empty marker), both hosts return `null` from `processes()`. If the harness dies and the worker does not, recovery appends `attempt.failed` and starts a replacement while the original is still writing to the same workspace. If the worker dies and the harness does not, Board reports `running` forever. Constitution §10 promises exactly this supervision.

Correction: durable execution identity (pid, pgid, start time) written before spawn; reconciliation on reopen; exclusive workspace leases; wall-clock deadlines.

### P1-6. The verifier leaks the operator environment into untrusted repository code, and leaks the process tree on timeout.

`adapters/local/command-verifier.ts:40-48` forwards `NODE_OPTIONS` and `NODE_PATH`, both code-execution vectors, plus `PATH`, `HOME`, and `SHELL`, into what is typically the repository's own test command. `:91-98` kills only the direct child, so a forked test process survives the recorded timeout and keeps mutating the workspace after Verify moved on.

Correction: detached spawn with process-group kill, or container teardown; drop `NODE_OPTIONS`, `NODE_PATH`, `SHELL`; scratch `HOME`; run under the same confinement as workers. `execa` already does this correctly.

### P1-7. Worker selection fails open for providers without a descriptor.

`src/host.ts:85`, `src/workers.ts:157-181`, `src/crew.ts:610-616`. A provider omitting the optional `describe()` is synthesised as `dangerous: false` with `writeAccess: "host-policy"` and is eligible for read-only missions. Unknown resolves to permitted, which for this system must be inverted. It is also internally inconsistent, since SCOUT and REVIEW contracts may not carry any `writeScope` at all (`src/schemas.ts:127-133`).

### P1-8. Dormant subprocess mode is a subclass override of DSH internals, and fails open.

`adapters/dsh/product-runtime.ts:75-95`. Safety is three overridden methods on a vendored base class pinned to a prerelease line. An upstream rename turns the overrides into dead code and silently restores spawning, with no test failing. `parentFor` (`:180-190`) forges a private `session.header.cwd` shape, which is simultaneously the only thing binding execution location and the most likely thing to break.

Correction: enforce dormancy outside the class hierarchy, assert at mount time that spawn throws, and verify the base class shape at load.

### P1-9. Unbounded ledger growth with full in-memory load.

`adapters/local/durable-ledger.ts:515-554`, `:130-180`, `:286-288`; `src/ledger.ts:111-113`; `src/crew.ts:684-700`; `src/board.ts:91`. The whole log is read and parsed on open and held resident forever, every worker observation is an uncapped durable event, and the read path clones and re-parses per call while `seenEventIds` grows per stream. A long-lived install eventually cannot reopen its own history, which inverts the property this layer exists to provide.

Correction: segment and rotate with snapshot-backed truncation and a cross-segment chain link; stream on open; cap observations per attempt; drop the redundant re-parse. This is the strongest candidate in the codebase for replacing hand-rolled machinery with SQLite in WAL mode.

---

## P2. Should fix

Recorded in full as a single rollup issue. Summary:

1. PID-based stale-lock recovery (PID reuse, shared volumes) can produce two writers and permanent chain corruption; `loadRecords` also truncates an append-only file on open by default, before validating.
2. TOCTOU inside verification: mutate-during-check-then-restore is invisible.
3. Snapshot reads whole untracked files into memory and shells out synchronously with a 64MB cap, so large files OOM and large diffs fail the mission rather than reporting drift.
4. Workspaces leak when `run()` throws before the handle is constructed, and worktrees live inside the repository under `.context/`.
5. Terminal states cannot be contradicted: post-acceptance `artifact.changed` is a violation rather than a signal.
6. Projection violations are advisory; callers that do not read `violations.length` consume a plausible state derived from an illegal stream.
7. Unbounded, unredacted worker and error text is written durably, a secret-leakage path.
8. `deterministic` and `readOnly` are self-declared; determinism is never tested.
9. Acceptance is possible when every attempt failed.
10. A repository-kind `writeScope` disables path checking entirely.
11. CI triggers on both push and pull_request, and the DSH job installs eleven prerelease packages with no lockfile while executing a third-party binary.
12. `exactContract` is key-order-sensitive `JSON.stringify` equality, and duplicates a stable serialiser that already exists.
13. Hand-rolled ledger, lock, spawn handling, and a twice-implemented observation queue, where mature libraries exist.

## P3. Improvement

1. Duplicated authority: `ObservationQueue` twice, `workspaceDigest` twice, stable JSON twice. The digest duplication matters most, since the operator proof could drift from production's definition of "unchanged".
2. Board is one Work per stream, so there is no organizational board across a plan.
3. `schemaVersion` is pinned to a literal with no migration path; the first version 2 event makes older ledgers unreadable.
4. Silent truncation of objectives at 4000 and 2000 characters.
5. `scope` is validated and then never read or enforced anywhere.
6. Adoption friction: private package, no CLI, no quickstart, no API reference, no LICENSE, SECURITY.md, or CONTRIBUTING; duplicate lesson numbering; a stray `tmp` file on `main`.

---

## Addendum: Guard v0 (#8, `feat/guard-v0` @ `9c65dfa`)

Reviewed separately because it is the module intended to answer P0-3. It does not yet, and it should not merge in its current state.

- **G-1 (P0).** Guard has zero call sites. The whole diff is `src/guard.ts`, its test, ADR 0008, provenance, and one re-export line in `src/index.ts:8`. ADR 0008's compliance table nonetheless marks Constitution §9 as satisfied, stating that tool calls are evaluated before the worker surfaces them. No tool call is evaluated anywhere in that commit. That is a self-certified compliance claim in a governance document.
- **G-2 (P0).** Guard is architecturally unreachable, not merely unwired. DSH notifications arrive already flattened to display strings (`adapters/dsh/index.ts:139-156`) with no request identity, no args, and no return channel, so there is nowhere for a verdict to be enforced. The interception point has to be the product's own permission callback or an OS boundary, and `WorkerCapabilities` needs to declare whether a provider supports guarded mediation.
- **G-3 (P1, merge blocker).** `denyByDefault` does not deny. `src/guard.ts:291-297` returns the identical `policy.defaultDecision` in both branches, changing only the audit label, so a deny-by-default policy can allow everything while recording `default-deny`. `guardPolicyFromWorkContract:378-395` then derives `defaultDecision: "allow"` for any contract with no `requiresHumanApproval`, so ordinary contracts derive to allow-everything. Any regression test asserting on `ruleHits` rather than `verdict.decision` will pass against this bug.
- **G-4 (P1).** Forbidden patterns are substring tests over `JSON.stringify(args)` (`:420-427`), defeated by trivial spacing or path variation, and sourced from `grant.constraints`, which are human prose. A factory-built policy has no effective patterns at all.
- **G-5 (P2).** The circuit breaker latches open permanently and surfaces as a thrown error rather than a recordable verdict, and calls `Date.now()` directly while the oracle accepts an injectable clock.
- **G-6 (P2).** Verdicts are not durable; `guard.evaluated` is deferred, so authority decisions do not survive the process that made them.
- **G-7 (P2).** A `prompt` verdict has no consumer, although Board already carries `decision.requested` and `decision.resolved`.

---

## What must happen to reach 9.5 / 10

1. Bind execution to the workspace in the contract (P0-1). Providers that cannot bind are refused; `process.cwd()` is never a default.
2. Make workspace identity mean the bytes that execute (P0-2), with the digest scope recorded in the target.
3. Ship Guard as a real OS boundary (P0-3, G-1, G-2), with authority events emitted at the enforcement seam and hardened git invocation.
4. Make durable truth unforgeable by the actors it judges (P1-1): keyed chain or signatures, authenticated actors, external anchoring.
5. Make negative controls falsify (P1-2), and stop letting harness-generated identity satisfy requirements (P1-3).
6. Close the untrusted-text channel (P1-4): worker output never enters another worker's instruction stream.
7. Supervise processes mechanically (P1-5, P1-6): durable execution identity, reconciliation, leases, deadlines, process-group kill.
8. Bound every resource (P1-9): log segmentation, streaming open, observation budgets, streaming digests.
9. Fail closed on host drift (P1-8): dormancy proven at runtime, version shape assertions.
10. Prove all of the above with an adversarial suite in CI, gating merge: an escape test, a poisoned-ignored-path test, a forged-ledger test, an always-pass-verifier test, an injection test, an orphan-process test.

The current suite proves the system does what it intends. It does not yet prove the system resists what it does not intend.

Completing items 1 through 3 would move this to roughly 6.5 and make it safe against a scratch clone. All ten, with the adversarial suite gating merge, reaches 9.5. The design is capable of carrying that, which is the strongest thing that can be said about a stack this young.

## Filed issues

| Finding | Issue |
| --- | --- |
| P0-1 worker not bound to workspace | #9 |
| P0-2 git-scoped identity digest | #10 |
| P0-3 no enforcement boundary | #11 |
| P1-1 forgeable ledger chain | #12 |
| P1-2 negative controls cannot falsify | #13 |
| P1-3 self-satisfied required evidence | #14 |
| P1-4 prompt injection via dependency reports | #15 |
| P1-5 no liveness reconciliation | #16 |
| P1-6 verifier environment and process leak | #17 |
| P1-7 selection fails open | #18 |
| P1-8 dormant mode fails open | #19 |
| P1-9 unbounded ledger growth | #20 |
| P2 rollup | #21 |
| P3 rollup | #22 |
| Guard v0 addendum | posted on #8 |
