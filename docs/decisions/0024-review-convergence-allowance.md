# ADR 0024: A change under open review may answer its review past the size horizon

Status: proposed

Refines ADR 0023. Authorized by founder ruling, 2026-09-24.

## Context

ADR 0023 blocks write work on any branch at or past 400 changed lines. The rule is "converge before advancing". On 2026-09-24 it blocked the convergence itself.

`rhizprotocol` PR #3665 is a single shared capability: a pure module, its tests, one caller, one guard with a self-test, and its contract document. It was 1,574 lines, pushed, and open for review. An independent review found two HIGH defects, and its probes confirmed both. The horizon refused every edit to that branch, including the fixes the review asked for. The branch could not converge without being fixed, and it could not be fixed without writing. Splitting it would not help, because the module alone is over 400 lines.

A size horizon measures whether a change is too large to review. Once a change is actually under review, answering that review is the convergence the horizon exists to force.

## Decision

A branch whose ONLY tripped signal is `diffLines`, which is durably pushed, and which is the head of an OPEN review, is `in_review`. Write work is allowed while `diffLines < ceil(anchor × 1.25)`.

- **The anchor** is the change's `diffLines` when the host first observes it under review, keyed by review number. It only falls (`ratchetReviewAnchor`). A second feature cannot ride on the first one's review.
- **Durability is decided first**, unchanged from ADR 0023. An unpushed branch never reaches the allowance. After each commit, the author must push before writing again.
- **Review forgives size only.** `commitsAhead`, `commitsBehind`, and divergence age still trip, because review does not reconcile them. Guard: `integration/review-forgives-only-size`.
- **The bound is enforced.** Past 125% of the anchor, the branch trips again. Guard: `integration/review-growth-is-bounded`.
- **The host asks the forge, never assumes.** `scripts/horizon.mjs` calls `gh pr view` only when size alone tripped. It requires `state: OPEN` and a review head equal to the branch's pushed upstream. Anchors are kept in `.rhiz-horizon-reviews.json`, separate from the baseline. Any failure to ask means no allowance, so the branch stays tripped.

The portable core knows "review" and "anchor", never "pull request" or "branch". The host adapter maps those.

## Consequences

- An oversized change that is already under review can be fixed and landed, which is what the horizon wanted.
- Opening a pull request is not an exemption. The exemption requires size to be the only problem, and it expires at +25%.
- Residual risk: a closed and reopened review gets a new review number and a new anchor at the current size. That takes a deliberate act on the forge, which is visible in its history. It is recorded here rather than silently accepted.
