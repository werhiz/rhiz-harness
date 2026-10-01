import assert from "node:assert/strict";
import test from "node:test";

import {
  CALIBRATED_INTEGRATION_HORIZON,
  HORIZON_THRESHOLDS,
  assertHorizonAllowsWrite,
  HORIZON_REVIEW_GROWTH,
  decideHorizon,
  ratchetBaseline,
  ratchetReviewAnchor,
} from "../src/horizon.js";
import type { IntegrationHorizonBaseline } from "../src/horizon.js";
import {
  IntegrationHorizonExceededError,
  PROVISIONAL_INTEGRATION_HORIZON,
  type IntegrationHorizonSignals,
} from "../src/integration.js";

const HOUR = 60 * 60 * 1000;

/** A branch that has diverged in no measurable way and is durably on a remote. */
const idle: IntegrationHorizonSignals = {
  commitsAhead: 0,
  commitsBehind: 0,
  elapsedMsSinceConvergence: 0,
  divergenceAgeMs: 0,
  diffLines: 0,
  binaryFilesChanged: 0,
  upstreamState: "pushed",
  overlappingResourceClaims: 0,
  integrationHeadMoved: false,
  proofInvalidationRisk: false,
};

function baseline(over: Partial<IntegrationHorizonBaseline> = {}): IntegrationHorizonBaseline {
  return { commitsAhead: 0, commitsBehind: 0, elapsedMs: 0, diffLines: 0, ...over };
}

test("an idle, durable branch is clear", () => {
  assert.equal(decideHorizon(idle).kind, "clear");
});

// Inclusive boundaries. ADR 0023 states the thresholds as >=, once, so that the
// interpretation is not left to whoever implements the next caller.
test("each threshold trips at its inclusive boundary and not one unit before", () => {
  const cases: readonly [keyof IntegrationHorizonSignals, number, number][] = [
    ["commitsAhead", HORIZON_THRESHOLDS.commitsAhead, HORIZON_THRESHOLDS.commitsAhead - 1],
    ["commitsBehind", HORIZON_THRESHOLDS.commitsBehind, HORIZON_THRESHOLDS.commitsBehind - 1],
    ["diffLines", HORIZON_THRESHOLDS.diffLines, HORIZON_THRESHOLDS.diffLines - 1],
    ["divergenceAgeMs", HORIZON_THRESHOLDS.divergenceAgeMs, HORIZON_THRESHOLDS.divergenceAgeMs - 1],
  ];

  for (const [field, trips, holds] of cases) {
    assert.equal(
      decideHorizon({ ...idle, [field]: trips }).kind,
      "tripped",
      `${field} at ${trips} must trip`,
    );
    assert.equal(
      decideHorizon({ ...idle, [field]: holds }).kind,
      "clear",
      `${field} at ${holds} must not trip`,
    );
  }
});

test("24h is the divergence-age threshold and 23h59m is not", () => {
  assert.equal(HORIZON_THRESHOLDS.divergenceAgeMs, 24 * HOUR);
  assert.equal(decideHorizon({ ...idle, divergenceAgeMs: 24 * HOUR }).kind, "tripped");
  assert.equal(decideHorizon({ ...idle, divergenceAgeMs: 24 * HOUR - 60_000 }).kind, "clear");
});

test("a tripped decision names every reason that tripped it", () => {
  const decision = decideHorizon({ ...idle, commitsAhead: 196, commitsBehind: 321 });
  assert.equal(decision.kind, "tripped");
  if (decision.kind !== "tripped") return;
  const signals = decision.reasons.map((reason) => reason.signal);
  assert.ok(signals.includes("commitsAhead"));
  assert.ok(signals.includes("commitsBehind"));
});

test("volume drift inside a frozen baseline is grandfathered", () => {
  const decision = decideHorizon(
    { ...idle, commitsAhead: 196, commitsBehind: 321 },
    baseline({ commitsAhead: 196, commitsBehind: 321 }),
  );
  assert.equal(decision.kind, "grandfathered");
});

test("advancing past a frozen baseline trips even though the baseline is large", () => {
  const decision = decideHorizon(
    { ...idle, commitsAhead: 197, commitsBehind: 321 },
    baseline({ commitsAhead: 196, commitsBehind: 321 }),
  );
  assert.equal(decision.kind, "tripped");
});

// The law that makes grandfathering safe: inherited mess may shrink, never grow.
test("ratchetBaseline lowers on improvement and never raises on regression", () => {
  const previous = baseline({ commitsAhead: 100, commitsBehind: 200, elapsedMs: 5 * HOUR, diffLines: 900 });

  const improved = ratchetBaseline(previous, baseline({ commitsAhead: 10, commitsBehind: 20, elapsedMs: HOUR, diffLines: 90 }));
  assert.deepEqual(improved, baseline({ commitsAhead: 10, commitsBehind: 20, elapsedMs: HOUR, diffLines: 90 }));

  const regressed = ratchetBaseline(previous, baseline({ commitsAhead: 500, commitsBehind: 900, elapsedMs: 50 * HOUR, diffLines: 9000 }));
  assert.deepEqual(regressed, previous, "a worse observation must never raise the baseline");
});

test("ratchetBaseline is monotonic per field, not all-or-nothing", () => {
  const previous = baseline({ commitsAhead: 100, commitsBehind: 200 });
  const mixed = ratchetBaseline(previous, baseline({ commitsAhead: 5, commitsBehind: 999 }));
  assert.equal(mixed.commitsAhead, 5, "the improved field lowers");
  assert.equal(mixed.commitsBehind, 200, "the regressed field holds");
});

// The correction that matters most. A baseline exists to let inherited drift
// shrink safely. It must never legalize bytes that exist on one machine.
test("missing durability is never grandfathered, at any baseline", () => {
  for (const upstreamState of ["no-upstream", "ahead-of-remote", "upstream-gone"] as const) {
    const generous = baseline({ commitsAhead: 10_000, commitsBehind: 10_000, elapsedMs: 10_000 * HOUR, diffLines: 10_000 });
    const decision = decideHorizon({ ...idle, upstreamState }, generous);
    assert.equal(decision.kind, "tripped", `${upstreamState} must trip under any baseline`);
    if (decision.kind !== "tripped") return;
    assert.ok(
      decision.reasons.some((reason) => reason.signal === "upstreamState"),
      `${upstreamState} must trip for durability, not merely for volume`,
    );
  }
});

test("a branch clear on every volume signal still trips when it has no remote copy", () => {
  const decision = decideHorizon({ ...idle, upstreamState: "no-upstream" });
  assert.equal(decision.kind, "tripped");
  if (decision.kind !== "tripped") return;
  assert.deepEqual(decision.reasons.map((reason) => reason.signal), ["upstreamState"]);
});

test("the calibrated policy is calibrated and the provisional one stays provisional", () => {
  assert.equal(CALIBRATED_INTEGRATION_HORIZON.status, "calibrated");
  assert.equal(PROVISIONAL_INTEGRATION_HORIZON.status, "provisional");
});

test("a calibrated policy is admissible where a provisional one was required", () => {
  assert.equal(CALIBRATED_INTEGRATION_HORIZON.requiresConvergence(idle), false);
  assert.equal(
    CALIBRATED_INTEGRATION_HORIZON.requiresConvergence({ ...idle, commitsAhead: HORIZON_THRESHOLDS.commitsAhead }),
    true,
  );
});

test("the calibrated policy does not trip on the single commit the provisional one refused", () => {
  const oneCommit = { ...idle, commitsAhead: 1, diffLines: 1 };
  assert.equal(PROVISIONAL_INTEGRATION_HORIZON.requiresConvergence(oneCommit), true);
  assert.equal(CALIBRATED_INTEGRATION_HORIZON.requiresConvergence(oneCommit), false);
});

test("assertHorizonAllowsWrite refuses a tripped decision and permits the others", () => {
  assert.throws(
    () => assertHorizonAllowsWrite(decideHorizon({ ...idle, commitsAhead: 10 })),
    IntegrationHorizonExceededError,
  );
  assert.doesNotThrow(() => assertHorizonAllowsWrite(decideHorizon(idle)));
  assert.doesNotThrow(() =>
    assertHorizonAllowsWrite(decideHorizon({ ...idle, commitsAhead: 196 }, baseline({ commitsAhead: 196 }))),
  );
});

test("the refusal carries the reasons, so a caller can say what to converge", () => {
  try {
    assertHorizonAllowsWrite(decideHorizon({ ...idle, commitsAhead: 50, upstreamState: "no-upstream" }));
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof IntegrationHorizonExceededError);
    assert.match(error.message, /commitsAhead/);
    assert.match(error.message, /upstreamState/);
  }
});

// Passive signals move without anyone acting: commitsBehind grows when the
// integration ref advances, divergenceAgeMs grows with the clock. Freezing them
// left 172 of 176 real branches tripped one second after a freeze.
test("a grandfathered branch does not trip on drift nobody caused", () => {
  const frozen = baseline({ commitsAhead: 196, commitsBehind: 321, elapsedMs: 10 * 24 * HOUR, diffLines: 18_710 });

  // main advanced and a week passed. The author did nothing.
  const passive = {
    ...idle,
    commitsAhead: 196,
    commitsBehind: 329,
    divergenceAgeMs: 17 * 24 * HOUR,
    diffLines: 18_710,
  };
  assert.equal(decideHorizon(passive, frozen).kind, "grandfathered");
});

test("a grandfathered branch still trips the moment its author advances it", () => {
  const frozen = baseline({ commitsAhead: 196, commitsBehind: 321, elapsedMs: 10 * 24 * HOUR, diffLines: 18_710 });

  const oneMoreCommit = { ...idle, commitsAhead: 197, commitsBehind: 329, divergenceAgeMs: 17 * 24 * HOUR, diffLines: 18_710 };
  const trippedByCommit = decideHorizon(oneMoreCommit, frozen);
  assert.equal(trippedByCommit.kind, "tripped");
  if (trippedByCommit.kind !== "tripped") return;
  assert.deepEqual(trippedByCommit.reasons.map((reason) => reason.signal), ["commitsAhead"]);

  const oneMoreLine = { ...idle, commitsAhead: 196, commitsBehind: 329, divergenceAgeMs: 17 * 24 * HOUR, diffLines: 18_711 };
  const trippedByLine = decideHorizon(oneMoreLine, frozen);
  assert.equal(trippedByLine.kind, "tripped");
  if (trippedByLine.kind !== "tripped") return;
  assert.deepEqual(trippedByLine.reasons.map((reason) => reason.signal), ["diffLines"]);
});

test("passive signals still trip a branch that was never grandfathered", () => {
  assert.equal(decideHorizon({ ...idle, commitsBehind: 50 }).kind, "tripped");
  assert.equal(decideHorizon({ ...idle, divergenceAgeMs: 24 * HOUR }).kind, "tripped");
});

test("grandfathering never forgives durability, passive signals included", () => {
  const frozen = baseline({ commitsAhead: 196, commitsBehind: 321, elapsedMs: 10 * 24 * HOUR, diffLines: 18_710 });
  const decision = decideHorizon({ ...idle, commitsAhead: 196, commitsBehind: 900, upstreamState: "no-upstream" }, frozen);
  assert.equal(decision.kind, "tripped");
  if (decision.kind !== "tripped") return;
  assert.deepEqual(decision.reasons.map((reason) => reason.signal), ["upstreamState"]);
});

// Review finding 1: the exemption must be keyed to what the baseline RECORDED,
// never to the existence of a row. Keying it on existence made the pass
// permanent and transferable.
test("a branch that converged loses its passive exemption even though its row survives", () => {
  // Frozen while genuinely past the bar, then rebased onto the integration ref.
  // `baseline freeze` ratchets the row down; the row still exists.
  const ratcheted = baseline({ commitsAhead: 2, commitsBehind: 0, elapsedMs: HOUR, diffLines: 50 });

  const driftedAgain = { ...idle, commitsAhead: 2, commitsBehind: 900, divergenceAgeMs: 365 * 24 * HOUR, diffLines: 50 };
  const decision = decideHorizon(driftedAgain, ratcheted);
  assert.equal(decision.kind, "tripped", "a converged branch must not keep a lifetime pass");
  if (decision.kind !== "tripped") return;
  const signals = decision.reasons.map((reason) => reason.signal);
  assert.ok(signals.includes("commitsBehind"));
  assert.ok(signals.includes("divergenceAgeMs"));
});

test("a reused branch name does not inherit an exemption from a stale row", () => {
  // A row left behind by a deleted branch records small values.
  const stale = baseline({ commitsAhead: 1, commitsBehind: 1, elapsedMs: HOUR, diffLines: 10 });
  const freshButStale = { ...idle, commitsBehind: 50, divergenceAgeMs: 24 * HOUR };
  assert.equal(decideHorizon(freshButStale, stale).kind, "tripped");
});

// Review finding 2: an empty baseline must confer nothing anywhere, so the
// census cannot print `clear` for a branch that was silently excused.
test("an empty baseline exempts nothing and is reported honestly", () => {
  const empty = baseline();
  const decision = decideHorizon({ ...idle, commitsBehind: 900, divergenceAgeMs: 365 * 24 * HOUR }, empty);
  assert.equal(decision.kind, "tripped", "an empty baseline must not silently excuse passive signals");
});

test("a baseline still forgives the passive drift it actually recorded", () => {
  const frozen = baseline({ commitsAhead: 196, commitsBehind: 321, elapsedMs: 10 * 24 * HOUR, diffLines: 18_710 });
  const worse = { ...idle, commitsAhead: 196, commitsBehind: 900, divergenceAgeMs: 365 * 24 * HOUR, diffLines: 18_710 };
  assert.equal(decideHorizon(worse, frozen).kind, "grandfathered", "the day-one wall must stay cleared");
});

// ADR 0024: a change under review may answer its review.

test("a change under review may grow while answering review, up to the bound", () => {
  const review = { anchorDiffLines: 1_574 };
  const limit = Math.ceil(1_574 * (1 + HORIZON_REVIEW_GROWTH));
  const within = decideHorizon({ ...idle, diffLines: 1_700 }, undefined, review);
  assert.deepEqual(within, { kind: "in_review", anchorDiffLines: 1_574, limit });
  assert.doesNotThrow(() => assertHorizonAllowsWrite(within));
  assert.equal(decideHorizon({ ...idle, diffLines: limit - 1 }, undefined, review).kind, "in_review");
  assert.equal(decideHorizon({ ...idle, diffLines: limit }, undefined, review).kind, "tripped");
});

test("review forgives size and nothing else", () => {
  const review = { anchorDiffLines: 2_000 };
  for (const over of [
    { commitsAhead: HORIZON_THRESHOLDS.commitsAhead },
    { commitsBehind: HORIZON_THRESHOLDS.commitsBehind },
    { divergenceAgeMs: HORIZON_THRESHOLDS.divergenceAgeMs },
  ]) {
    assert.equal(decideHorizon({ ...idle, diffLines: 1_000, ...over }, undefined, review).kind, "tripped");
  }
});

test("review never forgives missing durability", () => {
  const decision = decideHorizon({ ...idle, diffLines: 500, upstreamState: "ahead-of-remote" }, undefined, {
    anchorDiffLines: 10_000,
  });
  assert.equal(decision.kind, "tripped");
});

test("a change within every threshold stays clear whether or not it is under review", () => {
  assert.equal(decideHorizon({ ...idle, diffLines: 100 }, undefined, { anchorDiffLines: 100 }).kind, "clear");
});

test("a zero or missing anchor grants nothing", () => {
  assert.equal(decideHorizon({ ...idle, diffLines: 500 }, undefined, { anchorDiffLines: 0 }).kind, "tripped");
  assert.equal(decideHorizon({ ...idle, diffLines: 500 }).kind, "tripped");
});

test("a review anchor only falls", () => {
  assert.deepEqual(ratchetReviewAnchor({ anchorDiffLines: 1_500 }, { anchorDiffLines: 1_700 }), { anchorDiffLines: 1_500 });
  assert.deepEqual(ratchetReviewAnchor({ anchorDiffLines: 1_500 }, { anchorDiffLines: 900 }), { anchorDiffLines: 900 });
});
