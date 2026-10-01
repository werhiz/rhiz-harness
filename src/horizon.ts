/**
 * The calibrated integration horizon.
 *
 * `src/integration.ts` has carried a horizon since the #77 controller landed,
 * and it never ran: no non-test caller, and nothing anywhere that measured a
 * real repository into `IntegrationHorizonSignals`. Its own comment said it was
 * waiting for dogfood to supply a calibrated limit.
 *
 * That evidence arrived on 2026-09-13. In the rhizprotocol checkout: 176 local
 * branches ahead of the integration ref, 2,020 commits on them, of which only
 * 29 were already in the integration ref by content — the drift was real work,
 * not a squash-merge accounting artifact. 110 of those branches held unique
 * bytes with no remote copy of any kind.
 *
 * This module owns the number and the law and nothing else. It has no
 * knowledge of Git, of branches, of files, or of storage: `check-portable-
 * boundary` forbids a concrete host here, and "branch" is host vocabulary.
 * A host adapter measures; this decides. See ADR 0023.
 */

import {
  IntegrationHorizonExceededError,
  type IntegrationHorizonPolicy,
  type IntegrationHorizonSignals,
} from "./integration.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Inclusive thresholds. ADR 0023 states them as `>=`, once, so the boundary is
 * not left to whoever writes the next caller.
 *
 * The volume numbers follow trunk-based integration practice and the review
 * range past which comprehension measurably degrades. `commitsBehind` is in the
 * set because volume alone would not have caught the branch that hurt most:
 * 196 ahead and 321 behind. Divergence, not size, is what made it unrecoverable.
 */
export const HORIZON_THRESHOLDS = Object.freeze({
  commitsAhead: 10,
  commitsBehind: 50,
  diffLines: 400,
  divergenceAgeMs: 24 * HOUR_MS,
});

/** The volume signals a baseline may forgive. Durability is deliberately absent. */
export interface IntegrationHorizonBaseline {
  commitsAhead: number;
  commitsBehind: number;
  elapsedMs: number;
  diffLines: number;
}

export type HorizonSignalName = "commitsAhead" | "commitsBehind" | "diffLines" | "divergenceAgeMs" | "upstreamState";

export interface HorizonReason {
  readonly signal: HorizonSignalName;
  readonly observed: number | string;
  readonly limit: number | string;
  readonly detail: string;
}

/**
 * A change that is already under review. `anchorDiffLines` is its size when it
 * was first observed in review, recorded once by the host and never raised.
 * See ADR 0024.
 */
export interface IntegrationHorizonReview {
  readonly anchorDiffLines: number;
}

/**
 * How far a change under review may grow past its anchor while answering its
 * review. Fixes, tests for them, and the documentation they touch fit well
 * inside a quarter; a second feature does not.
 */
export const HORIZON_REVIEW_GROWTH = 0.25;

export type HorizonDecision =
  | { readonly kind: "clear" }
  | { readonly kind: "grandfathered"; readonly within: IntegrationHorizonBaseline }
  | { readonly kind: "in_review"; readonly anchorDiffLines: number; readonly limit: number }
  | { readonly kind: "tripped"; readonly reasons: readonly HorizonReason[] };

/**
 * Unique local bytes with no remote copy. Losing the machine loses the work,
 * so no baseline forgives this and no threshold applies to it.
 */
function durabilityReason(signals: IntegrationHorizonSignals): HorizonReason | undefined {
  if (signals.upstreamState === "pushed") return undefined;
  return {
    signal: "upstreamState",
    observed: signals.upstreamState,
    limit: "pushed",
    detail: "unique local bytes have no remote copy; push before doing more work",
  };
}

function volumeReasons(
  signals: IntegrationHorizonSignals,
  baseline: IntegrationHorizonBaseline | undefined,
): HorizonReason[] {
  // Two of these signals are ACTIVE: they move only when an author adds work.
  // Two are PASSIVE: they move on their own, through nobody's action.
  // `commitsBehind` grows every time the integration ref advances, and
  // `divergenceAgeMs` grows with the clock.
  //
  // Freezing a passive signal is meaningless. A branch exceeds a frozen
  // `elapsedMs` one second later, and exceeds a frozen `commitsBehind` the next
  // time anybody else merges. Baselining them left 172 of 176 branches tripped
  // immediately after a freeze, which is the day-one wall the baseline exists
  // to prevent.
  //
  // So a grandfathered branch is judged on what its author does. Passive drift
  // on an already-forgiven branch does not block work; one more commit or one
  // more line past the baseline does.
  //
  // The exemption is keyed to what the baseline RECORDED, never to the mere
  // existence of a row. Keying it on existence made the pass permanent and
  // transferable: a branch that fully converged kept its row and kept the
  // exemption, and a branch name deleted and recreated before the next freeze
  // was born exempt. A signal is forgiven only where the inherited value was
  // itself already past the bar — which is exactly the population the day-one
  // wall consisted of, and nobody else.
  const forgive = (recorded: number | undefined, threshold: number): number =>
    (recorded ?? 0) >= threshold ? Number.POSITIVE_INFINITY : threshold;

  const limits = {
    commitsAhead: Math.max(HORIZON_THRESHOLDS.commitsAhead, (baseline?.commitsAhead ?? 0) + 1),
    diffLines: Math.max(HORIZON_THRESHOLDS.diffLines, (baseline?.diffLines ?? 0) + 1),
    commitsBehind: forgive(baseline?.commitsBehind, HORIZON_THRESHOLDS.commitsBehind),
    divergenceAgeMs: forgive(baseline?.elapsedMs, HORIZON_THRESHOLDS.divergenceAgeMs),
  };

  const reasons: HorizonReason[] = [];
  const check = (signal: Exclude<HorizonSignalName, "upstreamState">, detail: string): void => {
    const observed = signals[signal];
    if (observed >= limits[signal]) {
      reasons.push({ signal, observed, limit: limits[signal], detail });
    }
  };

  check("commitsAhead", "too much private history; converge it");
  check("commitsBehind", "diverged too far from the integration ref to reconcile cheaply");
  check("diffLines", "too large to review as one change");
  check("divergenceAgeMs", "private work has been accumulating too long");
  return reasons;
}

/**
 * The whole decision. A baseline forgives inherited volume drift and nothing
 * else; `decideHorizon` without one judges against the calibrated thresholds.
 */
export function decideHorizon(
  signals: IntegrationHorizonSignals,
  baseline?: IntegrationHorizonBaseline,
  review?: IntegrationHorizonReview,
): HorizonDecision {
  const durability = durabilityReason(signals);
  const volume = volumeReasons(signals, baseline);

  // GUARD integration/durability-is-never-grandfathered
  // Missing durability trips before any baseline is consulted. A baseline
  // exists to let inherited drift shrink safely; it must never legalize bytes
  // that exist on exactly one machine. Deleting these two lines makes an
  // unpushed branch inside its baseline read as grandfathered.
  if (durability !== undefined) return { kind: "tripped", reasons: [durability, ...volume] };

  if (volume.length > 0) {
    const allowance = reviewAllowance(signals, volume, review);
    return allowance ?? { kind: "tripped", reasons: volume };
  }
  if (baseline !== undefined && isBeyondNothing(baseline)) return { kind: "grandfathered", within: baseline };
  return { kind: "clear" };
}

/**
 * The one way past a tripped size signal: answering the review of a change
 * that is already under review. The horizon exists to force convergence, and a
 * change under review IS converging, but only while it stays the change that
 * was put up for review.
 *
 * Durability was already decided before this is consulted, so an unpushed
 * change never reaches here.
 */
function reviewAllowance(
  signals: IntegrationHorizonSignals,
  volume: readonly HorizonReason[],
  review: IntegrationHorizonReview | undefined,
): HorizonDecision | undefined {
  if (review === undefined || !(review.anchorDiffLines > 0)) return undefined;
  // GUARD integration/review-forgives-only-size
  // Review answers the question "is this too large to review?" and nothing
  // else. Private history, divergence, and age still trip a change under
  // review, because review does not reconcile them.
  if (volume.some((reason) => reason.signal !== "diffLines")) return undefined;
  const limit = Math.ceil(review.anchorDiffLines * (1 + HORIZON_REVIEW_GROWTH));
  // GUARD integration/review-growth-is-bounded
  // Past the bound, the change is no longer the one under review.
  if (signals.diffLines >= limit) return undefined;
  return { kind: "in_review", anchorDiffLines: review.anchorDiffLines, limit };
}

/** A review anchor only ever falls: a smaller observation replaces a larger one. */
export function ratchetReviewAnchor(
  previous: IntegrationHorizonReview,
  observed: IntegrationHorizonReview,
): IntegrationHorizonReview {
  return { anchorDiffLines: Math.min(previous.anchorDiffLines, observed.anchorDiffLines) };
}

function isBeyondNothing(baseline: IntegrationHorizonBaseline): boolean {
  return baseline.commitsAhead > 0 || baseline.commitsBehind > 0 || baseline.diffLines > 0 || baseline.elapsedMs > 0;
}

/**
 * The monotonic ratchet that makes grandfathering safe. Each field takes the
 * better of the two, independently: inherited mess may shrink, and a worse
 * observation never raises the bar it is measured against.
 */
export function ratchetBaseline(
  previous: IntegrationHorizonBaseline,
  observed: IntegrationHorizonBaseline,
): IntegrationHorizonBaseline {
  return {
    commitsAhead: Math.min(previous.commitsAhead, observed.commitsAhead),
    commitsBehind: Math.min(previous.commitsBehind, observed.commitsBehind),
    elapsedMs: Math.min(previous.elapsedMs, observed.elapsedMs),
    diffLines: Math.min(previous.diffLines, observed.diffLines),
  };
}

/**
 * The enforcement. Kept separate from `decideHorizon` so the guard manifest can
 * bind to the bytes that refuse rather than the bytes that compute, and so
 * deleting the refusal leaves a candidate that still compiles — ADR 0016
 * classifies an uncompilable mutation as a gate failure, not a proof.
 */
export function assertHorizonAllowsWrite(
  decision: HorizonDecision,
  policyId: string = CALIBRATED_INTEGRATION_HORIZON.id,
): void {
  // GUARD integration/horizon-blocks-write-work
  // Deleting this refusal lets work advance past a tripped horizon, which is
  // the drift that produced 2,020 unmerged commits and 110 branches with no
  // remote copy.
  if (decision.kind === "tripped") {
    throw new IntegrationHorizonExceededError(policyId, decision.reasons.map((reason) => reason.signal));
  }
}

/** The calibrated policy, admissible wherever the provisional one was required. */
export const CALIBRATED_INTEGRATION_HORIZON: IntegrationHorizonPolicy = Object.freeze({
  id: "calibrated-integration-horizon-0023",
  status: "calibrated" as const,
  requiresConvergence(signals: IntegrationHorizonSignals): boolean {
    return decideHorizon(signals).kind === "tripped";
  },
});
