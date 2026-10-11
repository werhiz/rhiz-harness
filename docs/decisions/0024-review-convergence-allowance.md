# ADR 0024: A change under open review may answer its review past the size horizon

Status: proposed

Refines ADR 0023. Authorized by founder ruling, 2026-09-24.

## Context

ADR 0023 blocks write work on any branch at or past 400 changed lines. The rule is "converge before advancing". On 2026-09-24 it blocked the convergence itself.

`rhizprotocol` PR #3665 is a single shared capability: a pure module, its tests, one caller, one guard with a self-test, and its contract document. It was 1,574 lines, pushed, and open for review. An independent review found two HIGH defects, and its probes confirmed both. The horizon refused every edit to that branch, including the fixes the review asked for. The branch could not converge without being fixed, and it could not be fixed without writing. Splitting it would not help, because the module alone is over 400 lines.

A size horizon measures whether a change is too large to review. Once a change is actually under review, answering that review is the convergence the horizon exists to force.

## Decision

A branch whose only tripped signals are `diffLines` and/or `divergenceAgeMs`, which is durably pushed, and which is the exact head of an OPEN review, is `in_review`. Review corrections are allowed while `diffLines < ceil(anchor × 1.25)` and `divergenceAgeMs < 48 hours`. The ordinary divergence threshold remains 24 hours.

- **The anchor** is the change's `diffLines` when the host first observes it under review, keyed by review number. It only falls (`ratchetReviewAnchor`). An actual later review may establish a separate correction round as described below; it never rewrites this first anchor. A second feature cannot ride on the first one's review.
- **Durability is decided first**, unchanged from ADR 0023. An unpushed branch never reaches the allowance. After each commit, the author must push before writing again.
- **Review corrections have one bounded second day.** On October 11, 2026, `rhizprotocol` #4370 / PR #4375 was durably pushed at `2893ac2514dde4863e498575e2490b71be1d145e`, with an open review and roughly 25.6 hours of divergence. The clock blocked corrections needed for ownership and real-job proof. Founder direction to finish and get it live authorizes this refinement: review evidence may answer age below 48 hours. At 48 hours, convergence is still required. Guard: `integration/review-age-is-bounded`.
- **Review never forgives history or integration divergence.** `commitsAhead` and `commitsBehind` still trip. The existing `integration/review-forgives-only-size` guard retains its identifier and now excludes every reason except size and bounded age.
- **The bound is enforced.** Past 125% of the anchor, the branch trips again. Guard: `integration/review-growth-is-bounded`.
- **The host asks the forge, never assumes.** `scripts/horizon.mjs` calls `gh pr view` only when the remaining reasons are size and/or bounded age. It requires `state: OPEN` and a review head equal to the branch's pushed upstream. Anchors are kept in `.rhiz-horizon-reviews.json`, separate from the baseline. Any failure to ask means no allowance, so the branch stays tripped.

The portable core knows "review" and "anchor", never "pull request" or "branch". The host adapter maps those.

## Consequences

- An oversized change that is already under review can be fixed and landed, which is what the horizon wanted.
- Opening a pull request is not an exemption. The allowance requires only size and/or bounded age to remain, and expires at +25% or 48 hours.
- Residual risk: a closed and reopened review gets a new review number and a new anchor at the current size. That takes a deliberate act on the forge, which is visible in its history. It is recorded here rather than silently accepted.

## Regression evidence

`test/horizon.test.ts` binds the 25.6-hour case, the inclusive 48-hour refusal, unchanged 24-hour nonreviewed refusal, missing durability, history/divergence thresholds, and the existing growth bound. `test/horizon-host-review.test.ts` uses real Git history and a local bare remote, with controlled forge responses proving OPEN and exact pushed head are required; unavailable, closed, mismatched and unpushed cases fail closed. The enforcement tests and disposable guard mutations prove both the reason filter and the age limit remain load-bearing. These fixtures do not certify the production release or acceptance of #4370.

## Explicit exact-head correction rounds (2026-10-11)

PR #4375 grew from the first 4,177-line observation to a pushed 7,871-line candidate. The canonical independent reviewer actually reviewed that whole new head and posted NOT READY findings, but the first anchor still blocked every requested repair. Merely pushing or opening a review must not raise the allowance.

`horizon.mjs converge --review-receipt <comment-url>` records a distinct correction receipt only after fresh forge readback proves an OPEN PR, local/upstream/forge head equality, a same-PR attributable OWNER/MEMBER/COLLABORATOR comment in the canonical reviewer format, and that exact candidate head. The original anchor remains unchanged. The receipt retains the comment URL, body digest, reviewer login, head, integration head, measured committed diff and recording time. Identical replay is idempotent; dry run changes nothing. This is evidence permitting correction, never a READY or acceptance claim; forge attribution alone does not establish reviewer independence.

Every use rechecks the actual comment and its digest, verifies the reviewed head remains an ancestor, and recomputes its size against the fresh forge PR base. Recording requires the local integration ref to equal that forge base. The cached integration head remains historical metadata and never grants authority; changing it together with a cached size cannot enlarge the allowance. Mutable local numbers cannot enlarge it. A missing, altered, foreign, untrusted or unavailable receipt grants no larger allowance. The separate round still has the same inclusive 125% refusal and the overall 48-hour/history/divergence/durability boundaries. No clock is reset. Guards: `integration/review-receipt-binds-forge-head`, `integration/review-receipt-binds-forge-base`, and `integration/review-receipt-size-uses-forge-base`; each disposable falsifier must observe rejection of invalid receipts. The host test preserves the first anchor, watches an exact new receipt permit correction, and rejects altered receipts, inflated cached sizes, and a simultaneously forged older base plus its matching larger diff. The latter was independently reproduced on the first candidate, then watched fail in the owning regression before repair.
