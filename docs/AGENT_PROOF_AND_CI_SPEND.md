# Agent proof and GitHub Actions spend

**Decision (2026-10-01), superseding 2026-09-28 for this repository:** the
repository is public, so GitHub-hosted Linux minutes cost nothing and outside
contributors need hosted proof on their pull requests. Kernel CI therefore runs
on every pull request and every push to `main`, and it still accepts manual
dispatch. A newer push to the same pull request cancels its unfinished run.

The Codex App Server canary stays manual-only. It runs on a self-hosted machine
that holds operator credentials, and a pull request from a fork must never be
able to schedule code there.

`scripts/check-ci-trigger-budget.mjs`, run first by `npm run check`, holds each
workflow to exactly these triggers. Every automatically triggered workflow must
also stay safe for a fork's pull request: GitHub-hosted runners, top-level
`permissions: contents: read` with no job-level widening, no `secrets`, and no
`pull_request_target`.

**Decision (2026-09-28), now historical:** while the repository was private, the
organization exhausted its included Actions minutes, so every workflow ran by
manual dispatch only.

The check agent below remains the proof for what hosted CI cannot run: the
darwin containment suites, the DSH product smoke runs, and the Codex canary.

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
diagnose a specific failure, and rerun after a code change. Manual Actions
dispatch remains available when its particular host environment is necessary
and the spend is deliberately approved. It is not the routine merge gate.

## Cost and friction decisions

For every recurring charge or repeated delay, the cost owner maintains a decision with
the observed spend or time, the work or outcome it actually produced, evidence
of a defect caught or progress accelerated, a cheaper alternative, an owner,
and a date to inspect the result again. The verdict is **keep**, **change**, or
**retire**. Claims of possible future value do not count as observed value.

First case: in September 2026 hosted GitHub Actions minutes for this repository
were measured against the proof they produced. A hosted check on PR #124
failed before any job step, supplying no proof for that candidate at real
cost. The decision here is to retire automatic Actions for rhiz-harness and
use the independent check agent. Other repositories need their own review
before a production deploy or payment audit is retired.

