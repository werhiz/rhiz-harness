# Agent proof and GitHub Actions spend

**Decision (2026-10-01), superseding 2026-09-28 for this repository:** the
repository is public, so GitHub-hosted Linux minutes cost nothing and outside
contributors need hosted proof on their pull requests. Kernel CI therefore runs
on every pull request and every push to `main`, and it still accepts manual
dispatch. A newer push to the same pull request cancels its unfinished run.

The Codex App Server canary stays manual-only. It needs a self-hosted machine
holding operator credentials. Because no self-hosted runner is available to
this public repository, the workflow cannot currently run here. The canary is
proven by the operator running `npm run canary:codex` against the exact
candidate, as the check agent below records.

**What actually protects that machine from a fork.** On a `pull_request` event
GitHub runs the workflow files from the pull request itself, so a fork can
edit any workflow, and no check inside the repository can stop that. Two
settings carry the guarantee instead:

- Fork pull request workflows require maintainer approval for **all**
  external contributors (`all_external_contributors`, set 2026-10-01). No
  outside code runs until a maintainer has read it.
- No self-hosted runner is registered to this repository. An
  organization runner group must keep "allow public repositories" off. That
  setting needs organization-admin access to read, and it has to be confirmed
  there.

`scripts/check-ci-trigger-budget.mjs`, run first by `npm run check`, prevents
the other failure: a maintainer merging an unsafe workflow by accident. It
judges the decoded YAML, not the raw text, so flow-style mappings, quoted or
escaped keys, and complex keys are checked by what they decode to. Duplicate
keys, aliases, custom tags, and multi-document files are refused. It holds each workflow to its recorded triggers.
Every automatic workflow must also:

- run only on free standard GitHub-hosted labels, as one label. Larger runners
  bill even on a public repository, and matrix-chosen runners are refused.
- set top-level permissions to exactly `contents: read`, with no job-level
  permissions.
- mention `secrets`, in any letter case, in no string that evaluates an
  expression, and declare no key named `secrets` (as in `secrets: inherit`). The automatic `GITHUB_TOKEN` remains available
  to every job, limited to read access by the permissions above.
- call no reusable workflow.

`test/ci-trigger-budget.test.ts` plants each known bypass and requires the
gate to refuse it for the stated reason.

**Decision (2026-09-28), now historical:** while the repository was private, the
organization exhausted its included Actions minutes, so every workflow ran by
manual dispatch only.

Hosted Kernel CI now runs the build, the full test suite, the guard falsifiers,
and the DSH SDK and product smoke runs. The check agent below remains the proof
for what hosted CI cannot run: the darwin containment suites and the Codex
canary.

**Execution placement decision (2026-10-12), owner: #4370 release integrator.**
Exact candidate `689caa9860b83015250a7375f6bc145bccff24db`, run
[38235058054](https://github.com/werhiz/rhiz-harness/actions/runs/38235058054),
passed 889 hosted unit tests with ten declared platform skips and all 88 guard
falsifiers. The guards took 25m37s; the aggregate job then reached its existing
30-minute bound during disposable proofs. Hosted proof/parity did not finish,
and dependent DSH execution was skipped. That run is incomplete evidence.

Verdict: **change execution placement**, not the proof or the ceiling. The
complete manifest-backed guard lane runs in its own parallel standard Ubuntu
job with the same 30-minute limit. The existing check lane retains every other
stage from local `npm run check`, including unit tests, disposable proofs and
CI parity. DSH requires both jobs. Local `npm run check` is unchanged, and the
workflow completeness test compares its stages with both hosted lanes and
refuses missing, narrowed, duplicated or bypassed proof stages. This adds one
free public hosted job and one dependency install/build; it adds no paid runner,
credential or model traffic. Raising the limit or guessing at worker concurrency
would retain the observed aggregate bottleneck. Inspect the exact replacement
run on 2026-10-12 before integration; require all three jobs to finish successfully.

**Guard-job timeout follow-up (2026-10-15), owner: #4183 author.** On exact
candidate `a6d313d5d4d678d6e01429bd124590a4f5d6ab9e`, hosted run
[38680907664](https://github.com/werhiz/rhiz-harness/actions/runs/38680907664)
completed the check job successfully. The separate guard job built the exact
candidate and emitted passing results for all 91 declared guard proofs, but
GitHub canceled the guard step at its 30-minute job bound, 17 ms after the
final passing result. The dependent DSH job was skipped, so this run is not a
complete hosted pass.

This is evidence to extend only the guard job's timeout: its proof lane now
runs separately, but checkout, setup, dependency installation and build still
consume part of the same 30-minute bound. The guard timeout is 40 minutes;
the check job remains at 30 minutes, the DSH job at 10, and every proof stage,
dependency and failure condition is unchanged. The upper bound adds at most
10 minutes on the free public Ubuntu runner for a run that needs the time. It
adds no paid runner, job, trigger, credential or model traffic. Require a new
exact-head hosted run to finish all three jobs before integration.

**Studio stack timeout evidence (2026-10-17), owner: Studio integration.** Exact
candidate `fd5bb9298571ab1470d7b28dfb8b7e7527ff3827`, hosted run
[39072566857](https://github.com/werhiz/rhiz-harness/actions/runs/39072566857),
passed the build lane but its guard job was cancelled. Check annotation
`117513030654` states that the job exceeded 40m0s; DSH was consequently skipped.
Guard execution started at 21:50:18 UTC and was cancelled at 22:30:04 UTC.
The runner buffers individual proof results until all finish, so the completed
proof count and any individual failure are unknown. This is incomplete proof,
not a green result or evidence of a specific failed guard.

Increase only the guard job bound from 40 to 50 minutes for the reconciled
Studio candidate. Keep every manifest proof, refusal, check-lane stage and DSH
dependency unchanged. This adds at most ten free public standard Ubuntu minutes
per run, no paid runner, model call, permission or new job. Require all three
hosted lanes on the new exact combined head plus independent local proof before
landing; inspect observed duration on the successor run. The original worker
and bridge commits remain ancestors rather than being rewritten.

## The check agent

Before integration, a checker other than the author inspects the exact candidate
and records:

1. Candidate commit SHA and base SHA, changed files, and the reason for the change.
2. `npm ci --ignore-scripts --no-audit --no-fund` and `npm run check` on a
   clean checkout of that candidate. The check includes the build, tests,
   portable boundaries, guard falsifiers, and CI parity.
3. The DSH SDK closure and `smoke:dsh-products` / `smoke:dsh` from
   `.github/workflows/kernel.yml` when proving the former hosted DSH job.
   Record any unavailable package, fixture, platform, or credential as an
   unproven area. A partial run is never called a full pass.
4. The relevant host or canary proof for code that changes a host-specific
   boundary, on a machine that can actually exercise it.
5. Command, exit code, platform, Node/npm versions, failures and skips, plus
   the final candidate identity and whether the worktree remained clean.

The checker posts a concise receipt on the PR. The integrator compares its
candidate SHA with the current PR head and main before landing. A changed head
invalidates the receipt. Fix a failing proof, or record an explicit founder
exception that names the failed or unrun proof and the consequence of landing.
Do not turn an agent's opinion or an empty GitHub check into a green test claim.

One full proof per exact candidate is the default. Rerun a failed portion to
diagnose a specific failure, and rerun after a code change. Hosted Kernel CI
on the exact head is part of the merge gate; it does not replace the darwin and
canary proof above.

## Cost and friction decisions

For every recurring charge or repeated delay, the cost owner maintains a decision with
the observed spend or time, the work or outcome it actually produced, evidence
of a defect caught or progress accelerated, a cheaper alternative, an owner,
and a date to inspect the result again. The verdict is **keep**, **change**, or
**retire**. Claims of possible future value do not count as observed value.

First case: in September 2026 hosted GitHub Actions minutes for this repository
were measured against the proof they produced. A hosted check on PR #124
failed before any job step, supplying no proof for that candidate at real
cost. The decision then was to retire automatic Actions for rhiz-harness and use
the independent check agent; the 2026-10-01 public-repository decision above
superseded it. Other repositories need their own review
before a production deploy or payment audit is retired.



**Multipart review capacity decision (2026-10-12), owner: #4370 release integrator.**
The real 22-conflict integration requires more than 1.18 MB of original/main/base
Source before its projection. The existing 200 KB complete-input refusal caught
that mismatch without model traffic. Use the same operator-signed local Claude
subscription for bounded semantic parts and one actual integration review; do
not use a hosted API, new credential or paid runner. This consumes local
subscription capacity, not a verified dollar charge. Keep the 200 KB per-input
ceiling, 64-part maximum, 45-minute total deadline and actual provider-reported
usage. Every production-sized proof names its specific call/time budget before
execution and retains partial failures. Review the measured actual proof and
usage against the exact candidate before landing; until then, the new capability
has no observed model-success or saving claim. The prior smaller single-input
proof and public CI success cannot establish this larger semantic admission.

The #4370 complete-review lane observed the 6df3d9b guard job cancel at its
unchanged 30-minute ceiling (run 38316378225), with four available CPUs and
three resolved workers; build succeeded and DSH skipped. Physical test grouping
now routes each declared predicate to its nearest complete owning cases. Every
original case and assertion remains in the full unit glob; neither concurrency
nor the workflow ceiling changes. The original stalled local stdin control is
retained as failure. Local extracted timings are observations, not a claimed
hosted per-guard timing or identical green baseline. Owner: #4370 release lead;
review date: 2026-10-12. All exact-head hosted gates remain mandatory.
