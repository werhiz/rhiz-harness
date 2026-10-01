/**
 * The falsifying tests for the horizon guards in `scripts/guard-manifest.json`.
 *
 * Each test here must go red when its declared enforcement is deleted from a
 * disposable derivative, and green in an unmutated control. Kept in its own
 * small file because every guard costs a full build and test run.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assertHorizonAllowsWrite, decideHorizon } from "../src/horizon.js";
import type { IntegrationHorizonBaseline } from "../src/horizon.js";
import { IntegrationHorizonExceededError, type IntegrationHorizonSignals } from "../src/integration.js";

const clean: IntegrationHorizonSignals = {
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

// Falsifies: integration/horizon-blocks-write-work
test("work cannot advance past a tripped horizon", () => {
  const tripped = decideHorizon({ ...clean, commitsAhead: 196, commitsBehind: 321 });
  assert.equal(tripped.kind, "tripped");

  assert.throws(
    () => assertHorizonAllowsWrite(tripped),
    IntegrationHorizonExceededError,
    "a tripped horizon must refuse further write work",
  );
});

// Falsifies: integration/durability-is-never-grandfathered
test("a baseline never legalizes bytes that exist on one machine", () => {
  // Generous enough to forgive every volume signal many times over.
  const generous: IntegrationHorizonBaseline = {
    commitsAhead: 10_000,
    commitsBehind: 10_000,
    elapsedMs: 10_000 * 60 * 60 * 1000,
    diffLines: 10_000,
  };

  for (const upstreamState of ["no-upstream", "ahead-of-remote", "upstream-gone"] as const) {
    const decision = decideHorizon({ ...clean, upstreamState }, generous);
    assert.equal(
      decision.kind,
      "tripped",
      `${upstreamState} must trip even inside a generous baseline`,
    );
    assert.throws(
      () => assertHorizonAllowsWrite(decision),
      IntegrationHorizonExceededError,
      `${upstreamState} must refuse further write work`,
    );
  }
});

// Falsifies: integration/review-forgives-only-size
test("review never forgives private history, divergence, or age", () => {
  const review = { anchorDiffLines: 10_000 };
  const decision = decideHorizon({ ...clean, diffLines: 1_000, commitsAhead: 196, commitsBehind: 321 }, undefined, review);
  assert.equal(decision.kind, "tripped");
  assert.throws(() => assertHorizonAllowsWrite(decision), IntegrationHorizonExceededError);
});

// Falsifies: integration/review-growth-is-bounded
test("a change under review cannot grow without bound", () => {
  const decision = decideHorizon({ ...clean, diffLines: 50_000 }, undefined, { anchorDiffLines: 1_000 });
  assert.equal(decision.kind, "tripped");
  assert.throws(() => assertHorizonAllowsWrite(decision), IntegrationHorizonExceededError);
});
