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


### Complete review beyond one provider input (2026-10-12)

The real #4370 integration at Source `1d354adc` and accepted main `7e1155bd`
had 22 conflicts. Its original, main and existing stage-1 legs alone contained
1,180,098 UTF-8 bytes, before projected Source or the packet. The installed
single-input 200,000-byte Review refused this task correctly. The prior small
actual-provider proof establishes that smaller exercised scope, not admission
of this real merge. No file is dropped, no input is truncated and no application
history or clock is changed to fit review.

The existing operator Review may inspect complete immutable material in ordered
parts. The host supplies an `integrationLabel` pointing to its whole packet,
including the entire proposed patch and exact scope. Every part receives that
complete integration proposal, the existing contract/diff, and its explicitly
identified UTF-8 ranges. The operator derives the ranges itself, checks exact
reconstruction and order before provider admission, and invokes the independent
provider afresh for every semantic part. Source bytes remain untrusted data.
If a part cannot support semantic judgment with the supplied context, it refuses.

After all parts pass, a separate actual integration review receives the whole
proposal and ordered, identity-bound semantic results. It must judge cross-file
interactions and preservation itself. Part statuses are evidence, never an
aggregate verdict. Only all successful parts and that actual final pass can
reach one canonical Review append under the existing exclusive Ledger lock,
which rechecks the original contract revision and verified head/base. No saved
part result or caller-supplied coverage flag can skip execution.

Each actual provider input is at most 200,000 UTF-8 bytes, including metadata;
the existing environment option may reduce that ceiling but cannot enlarge it.
Legacy material without a part-context binding retains its individual input-size
refusal. Complete serialized material is bounded at 8 MiB and 64 parts, with a 45-minute total
review deadline and the existing 15-minute per-provider ceiling. The host wait
for Review is 46 minutes; other invocations retain their prior bound. Complete
inputs, including the final reports, must fit before their provider invocation.
An oversized final report, provider failure, cancellation or timeout refuses
with partial observations retained in the existing operator reviews directory.
Only actually reported usage is aggregated; absent usage stays absent.

The raw canonical Review binds both immutable material identity and a digest
of its ordered range/input identities and final integration input. Horizon
requires that exact coverage, retains it in the existing durable intent, and
rechecks it during effect/recovery. Identity Verify still proves identity only.
The request is bounded at 192 KiB, every actual conflict must be included, and all
ordinary age/history/durability, fresh forge, scope and growth checks remain.

The owning regressions use production-sized UTF-8 evidence, reconstruct the
actual provider inputs, and reject omitted/repeated/reordered/altered ranges,
forged material, provider/part/final failure, exhausted budget and saved-result
reuse. Disposable guard removals must make those controls fail. Scripted
providers establish control flow only; this new size capability requires fresh
independent exact-candidate, hosted and production-sized actual-provider proof
before integration or installation.


Independent review of the first multipart draft found that local part logs alone
could not reconstruct the final semantic input after a fresh fetch. It also
found that slow retained I/O after a successful provider could overrun the total
deadline. Watched regressions reproduced both before correction. Canonical
Review now binds a complete semantic observation containing the exact part and
final prompts and normalized actual semantic decisions, ordered result digests,
revision, head and material identity. Raw transport envelopes and malformed
responses stay in private operator custody; they are never copied to public
checkpoints. Horizon validates and retains the complete semantic observation
through its existing Work artifact/checkpoint, as a parent of durable intent.
An intent-only fresh fetch must reconstruct all semantic inputs and decisions.
The original deadline is rechecked after provider/evidence retention and under
the existing Ledger lock before recording the canonical Review. Expiry retains
the actual provider outcome and authorizes no pass, acceptance or Source effect.


A subsequent independent review found that a linked private reviews ancestor
could receive full prompts before the later host refused its path. The owning
fixture watched the original operator proceed through the link. Review now
proves each ancestor is an unlinked directory under the actual Git-common root
before creating its custody, saving any prompt or invoking the provider. The
negative fixture requires no outside writes and no provider traffic; removing
the enforcing check must fail it in disposable custody.


Exact candidate `42b5c032` hosted proof passed its build/replay/proof/parity lane
and proved 98 of 100 guards, but two early semantic-pass declarations remained
unproven: later observation validation independently enforced the same refusal.
DSH was skipped and the candidate was not installable. Its local gate was
cancelled after 908 passing units; incomplete stages and raw failure receipts
were retained. Live and retained part/final decisions now use one shared strict
semantic-pass predicate with one corresponding watched removal declaration.
No part check, actual final review, refusal or evidence requirement was deleted.
A new head must pass every exact-candidate gate; the failed head is never reused.


### Measured real Source capacity (2026-10-12)

The complete 33-path reconciliation request measured 165,448 UTF-8 bytes even
with standard one-line unified context, preserving all changed bytes. Its
planning packet measured 352,017 bytes and the old repeated whole-packet
integration input exceeded 375 KB before reports. Raising only the request
bound would move the refusal to another stage. The request is now bounded at
192 KiB; ordinary age/history/durability/growth limits do not change.

The generic reader admits at most 8 MiB cumulative unique blob bytes before
reading each body, plus the existing serialized complete-material bound. A
manifest with a bound part-context label may include a larger immutable packet;
legacy single-input material retains its smaller body refusal. All packet,
original/main/projected/base, scope context and entire proposal bytes remain
in ordered complete coverage. Semantic parts receive the full explicit scope,
source identities, criteria and active findings instead of repeating the entire
packet. A part that cannot support judgment refuses. Final integration receives
the raw whole proposal/scope and complete actual ordered normalized semantic
reports, with identities; redundant range metadata need not be repeated there.
No source evidence, finding or semantic report is truncated. Every actual input
still fits 200,000 bytes before its call; overflow retains outcomes and refuses.
Convergence declares at most 20 total reviewer calls and the same 45-minute
review budget before provider execution. Actual context/reports must be measured
before any real-provider claim, not inferred from planning placeholders.

The real app stage snapshot also measured 1,261,006 bytes, exceeding Node's
1 MiB default exec buffer. A real Git/index fixture watched the old snapshot
read fail with ENOBUFS before forge refusal. The owning snapshot now uses the
existing explicit 64 MiB Git read ceiling; the default-buffer removal must fail
that regression. This is complete Source measurement, not a policy waiver.

The complete-material reader also accounts every logical entry, including repeated
blob aliases, metadata, separators, JSON escaping and UTF-8 surrogate handling,
before aggregate serialization. The watched alias negative observes an unread
tail blob being read on the old path and refused before reading on the corrected
path; a unique-object cache alone is not an allocation bound.

The existing convergence artifact retainer writes exact canonical bytes to a
fresh private regular mode-600 temporary file, hashes with Git filters disabled,
and cleans the temporary directory in a finally block. Its Git runner has a
30-second bound. This prevents an unbounded retention boundary after Review;
no production stdin hang is claimed. The observed test-fixture stdin deadlock
and the explicitly scripted old-form refusal remain distinct evidence.
A complete multi-leg scripted review produces an observation above 5 MiB; real
Git digest/readback, temporary custody/cleanup and timeout-before-effect are
required controls. Actual-provider semantic proof remains separate.

The expiry fixture controls its phase with a test-only clock: the actual scripted
provider returns, its complete outcome is persisted, and only then does the
clock advance beyond the declared deadline. Its real subprocess remains bounded
at 30 seconds. The production clock and source-history age are unchanged.
A prior full-run missing-part failure remains unexplained; a separately retained
simulated pre-provider I/O stall shows a possible phase miss, not its cause.
The named deadline-case body is the second explicit preservation exception to
the physical extraction inventory. No acceptance or result is fabricated.

The review admission predicate also runs after the canonical Ledger replay and immediately before each review lifecycle append. A deadline expiring while replay or an earlier append waits cannot admit a later passing result. An interrupted lifecycle remains evidence and is closed as failed by the existing fresh-review recovery path.

## Founder-approved review-context anchor for integration effects (2026-10-14 and 2026-10-15)

Authority record: in response to the question, “Approve the narrow Harness
amendment allowing a fresh exact-head READY review to establish the size anchor
for a governed integration resolution, retaining the existing 125% bound,
independent artifact review, current-main checks, and all merge gates?”, the
founder replied, “Approve the bounded READY-review amendment” on 2026-10-14.
The direct response item is
`call_20d74309a0eb429e9f838660f12c40d0`; the contemporaneous transcription is
`/tmp/rhiz-landing-decisions-20261014.md`.

Within that scope, for `resolve-integration` only, the latest attributable
canonical READY or NOT READY verdict for the exact durable OPEN source head may
establish the effect-only growth anchor as that head's full committed diff
against the forge review base. A NOT READY verdict qualifies only as active
findings context for one governed reconciliation whose projected packet
preserves the reviewed source and addresses those findings; it is not a
correction receipt or acceptance claim. This does not create or change a
correction receipt and grants no ordinary write permission. The complete
projected integration tree must remain strictly below the existing inclusive
125% growth bound and still pass fresh controlled Work, Verify, and independent
whole-packet Review before the one exact resolution effect.

Persisted NOT READY correction receipts remain unchanged and continue to be
preferred when an attributable receipt exists. Unrecorded NOT READY context and
READY do not authorize `repair-reviewed-target`, `converge --review-receipt`, or
ordinary writes. Fresh exact-head and upstream
durability, OPEN state, current accepted-main binding, four-hour review context,
less-than-ten-ahead boundary, complete conflict scope, unchanged source state,
and revalidation before effect remain required. No clock, 125% threshold,
main binding, review work, or verification requirement changes.

Reconsider or disable this fallback if a falsifier shows that another purpose,
stale/foreign/non-latest review, ordinary check, terminal correction, or receipt
write can use it; re-enable only after the owning controls prove the same
bounded behavior on an exact candidate.

**Bounded NOT READY integration context amendment (2026-10-15).** In response to
the proposal “Approve bounded NOT READY integration repair (recommended),” the
founder approved the amendment on 2026-10-15. The direct approval is recorded in
`/tmp/rhiz-landing-decisions-20261014.md`. It permits only the `resolve-integration`
effect-anchor fallback to use a fresh exact-head canonical NOT READY review as
active findings context. It does not widen ordinary writes, correction receipts,
terminal repair, history limits, the growth bound, or any Work/Verify/independent
Review requirement. The required owner tests include real-Git NOT READY positive
and negative controls and the guard falsifier.


### Accepted-main policy as a bounded runtime-only overlay (2026-10-15)

For the exact governed convergence Work, the validated accepted-main hook bytes
may be materialized in its isolated execution workspace as runtime input after
that Work is durably created. This overlay is derived from the same-repository
current `main` commit and is bound to the retained packet, exact source hook
blob/mode, accepted hook blob/mode, and execution-root digest. It does not alter
the source branch, source index, candidate tree, or source hook identity. The
only candidate checkpoint is the direct child of the exact source head that
adds the one Work-specific artifact. The overlay cannot pass through workspace
inheritance to a dependent Work; each acquire validates the single exact Work
identity. This exception is runtime-only and grants no general hook, source,
branch, merge, acceptance, or effect authority. Removal falsifiers cover exact
review admission, inheritance refusal, source hook/index retention, accepted
bytes and mode, and artifact-only candidate lineage.

When both pinned source and accepted-main Git trees prove that the exact hook
path is absent, the same generic convergence may use a derived no-overlay
policy. No caller flag selects this mode. If either tree contains the path,
both sides must instead provide valid regular executable hook blobs and the
full overlay binding applies; one-sided, malformed, non-executable, or linked
paths refuse. The common exact Work, Verify, independent whole-packet Review,
actor, and bounded effect gates remain required in either mode.
