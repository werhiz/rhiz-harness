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
  expression, and in no key. The automatic `GITHUB_TOKEN` remains available
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

