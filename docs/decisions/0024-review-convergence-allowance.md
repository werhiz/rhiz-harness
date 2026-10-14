# ADR 0024: A change under open review may answer its review past the size horizon

Status: accepted

Refines ADR 0023. Accepted by founder ruling, 2026-09-24 and 2026-10-14.

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

## Effect-bound convergence after the ordinary review horizon

On October12,2026, the genuine reviewed #4370 change reached more than48 hours and an actual fresh-main merge required conflict resolution. Ordinary permission remains tripped. `converge --artifact-request <request.json>` is a distinct software convergence effect, not general permission to advance that branch.

The host captures the exact source head, current branch, index/stage identities, working bytes and fresh forge main/OPEN pushed head. A merge resolution includes every actual conflict and explicitly names any necessary preservation/repair adapters already in the reviewed or accepted-main change. Terminal repair instead requires a clean, zero-behind target. Missing durability and the inclusive ten-ahead boundary are never forgiven. One complete reviewed reconciliation may include its terminal correction before one integration commit; subsequent ordinary writes remain tripped at ten.

The proposed packet is an immutable Git artifact. The owning command creates one genuine bounded Work with exact source/manifest scope and starts the existing native producer, falsifiable Verify and controlled independent Review itself. The producer writes a small manifest referencing the packet; it does not claim authorship of operator-proposed source bytes. The independent reviewer must inspect the whole packet, original/main evidence and repair semantics, not merely the manifest hash. Raw review diff evidence must match the current canonical integration proof. Existing Work receipts, user-supplied pass flags, cached sizes or formatted forge headers cannot skip actual execution.

Artifact parents are provisioned as empty directories through existing trusted workspace preparation before baseline. This was isolated on installed Codex0.154/Harness182dab: the missing-parent attempt made no artifact, whereas the same scoped operation with only empty-parent preparation produced c937d7b, passed actual Verify and controlled Review, and retained exact remote/file/Ledger readback. Neither probe accepted a Work or authorized an application effect. No provider or sandbox widening is introduced.

Before the effect, the host revalidates source, scope, immutable artifact, actual raw proof, fresh forge and the existing125% bound recomputed from attributable correction evidence. A four-hour bounded window never changes actual divergence age. The command applies only its exact reviewed text patch, stages only declared resolution paths, reads back projected bytes and records artifact evidence in the existing Work Ledger. It neither commits, accepts, lands nor deploys. The caller must preserve exclusive workspace ownership; source changes during execution refuse the effect. Dry run is unsupported for this real-execution operation and refuses before changes.

Real Git/index fixtures exercise old age, actual MERGE_HEAD and9→10 history. Scripted provider transports in those fixtures prove structural control flow only; the separate operator probe is actual provider evidence. Every declared admission guard must fail its disposable removal test. SDK integration still requires independent exact-candidate and hosted Kernel proof before installation.


Independent source review exposed three defects before integration: the small manifest did not make its packet/tree Git objects remotely reachable, a nested Context link could redirect custody, and interruption after source staging could lose the effect receipt. The owning repair retains complete packet and projected objects through existing immutable Work checkpoint refs, binds the input checkpoint in the native manifest, validates every custody ancestor, and records a full retrievable intent in the same Work Ledger before applying source. Complete intent and receipt artifacts survive a fresh fetch. Service artifact commit metadata is deterministic; this does not alter the application branch, its historical timestamps, or any drift measurement.

`converge --recover-effect <WorkId>` is observation-only recovery. It requires the single unfinished canonical intent and its exact independent Verify/Review binding, refuses a live custody owner, and compares the actual source head, branch, merge/index tree, projected bytes and unrelated dirty state. It neither re-runs a worker nor re-applies source. Divergent or unapplied state refuses; an exact applied state receives a durable observed receipt. A late interruption after remote receipt preservation reuses identical artifact bytes and pinned service identity even if operator Git identity changed. Recovery does not imply acceptance or a general source-write allowance. Real Git fixtures kill the disposable operator before apply, after staging, and after receipt push; they check refusal, fresh-remote reconstruction and no-repeat observation. Guards bind remote artifact durability, in-root custody and intent-before-effect to watched disposable failures.


The first actual model-backed orchestration proof of candidate a208a856 failed safely before artifact production: the producer interpreted the shared objective’s reviewer inspection/refusal requirement as its own, attempted a forbidden shell read of the packet and truthfully reported no files changed. The real Work and token observations remain failure evidence; scripted fixtures and hosted success do not establish actual orchestration. Producer input is now explicitly the complete small manifest, with packet references intentional and native file-change packaging only. The separate reviewer still must inspect the whole immutable packet and source legs after Verify. No provider, sandbox or authority permission changes. A role-aware agent-boundary fixture watched the old controller fail before this clarification; its guard removal must fail again. A new immutable candidate requires fresh independent, hosted and actual-provider proof.


A fresh genuine READY review can supersede the last NOT READY comment while a branch still needs accepted-main conflict resolution. For `resolve-integration` only, the latest attributable exact-head canonical READY or NOT READY comment is review context. It grants no source effect, skips no actual Work/Verify/independent Review, and changes no ordinary or terminal correction receipt rule. Those remain NOT READY-only.

Actual forge readback also exposed that a PR comparison base can remain historical while repository main advances. Convergence now reads the same repository’s actual `git/ref/heads/main` commit and binds local integration/MERGE_HEAD to it. The forge-provided historical PR base remains the source of the reviewed diff/growth measurement; cached receipt bases/numbers remain non-authoritative. Real Git fixtures watched READY resolution rejected, historical comparison bases rejected, and mismatched current-main refs incorrectly accepted before repair. Their corrected proofs retain actual-execution and no-effect controls. Cancelled intermediate-head validation is incomplete evidence, never reused as final-head proof.


### Whole semantic review material

The actual `689caa9` provider run produced its native artifact, passed identity
Verify, and exercised fictional effect/recovery. Its real reviewer judged only
manifest references and explicitly lacked the source Context. This is observed
mechanical proof and a semantic-review failure, never qualifying effect proof.

The generic operator Review now resolves immutable supplemental Git evidence,
validates exact Work/revision/verified-head binding, whole UTF-8 content, digests,
path/tree membership and typed historical absence, and bounds the entire input
before invoking its independent reviewer. Source content is untrusted data.
Horizon supplies its complete packet and actual original/main/projected legs
through existing retained Work artifacts. Raw review material identity accompanies
the existing candidate diff and is required by effect admission, intent and
recovery. Packaging and deterministic Verify establish identity only; actual
independent review must judge preservation and repair semantics on supplied bytes.

## Founder-approved READY anchor for integration effects (2026-10-14)

Authority record: in response to the question, “Approve the narrow Harness
amendment allowing a fresh exact-head READY review to establish the size anchor
for a governed integration resolution, retaining the existing 125% bound,
independent artifact review, current-main checks, and all merge gates?”, the
founder replied, “Approve the bounded READY-review amendment” on 2026-10-14.
The direct response item is
`call_20d74309a0eb429e9f838660f12c40d0`; the contemporaneous transcription is
`/tmp/rhiz-landing-decisions-20261014.md`.

Within that scope, for `resolve-integration` only, the latest attributable
canonical READY verdict for the exact durable OPEN source head may establish
the effect-only growth anchor as that head's full committed diff against the
forge review base. This does not create or change a correction receipt and
grants no ordinary write permission. The complete projected integration tree
must remain strictly below the existing inclusive 125% growth bound and still
pass fresh controlled Work, Verify, and independent whole-packet Review before
the one exact resolution effect.

Persisted NOT READY correction receipts remain unchanged and continue to be
preferred when an attributable receipt exists. An unrecorded NOT READY comment
does not establish an anchor. READY does not authorize `repair-reviewed-target`,
`converge --review-receipt`, or ordinary writes. Fresh exact-head and upstream
durability, OPEN state, current accepted-main binding, four-hour review context,
less-than-ten-ahead boundary, complete conflict scope, unchanged source state,
and revalidation before effect remain required. No clock, 125% threshold,
main binding, review work, or verification requirement changes.

Reconsider or disable this fallback if a falsifier shows that another purpose,
NOT READY or stale/foreign review, ordinary check, terminal correction, or
receipt write can use it; re-enable only after the owning controls prove the
same bounded behavior on an exact candidate.
