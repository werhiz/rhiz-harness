import assert from "node:assert/strict";
import test from "node:test";
import type { BenchmarkRun } from "../src/benchmark.js";
import { ReplayExperimentSpecSchema, type ReplayExperimentSpec } from "../src/observer.js";
import {
  formatReplayArm,
  formatReplayResult,
  ReplayResultSchema,
  summarizeReplayExperiment,
  type ReplayTrialPair,
} from "../src/replay.js";
import { benchRun } from "./helpers.js";

function spec(overrides: Partial<ReplayExperimentSpec> = {}): ReplayExperimentSpec {
  return ReplayExperimentSpecSchema.parse({
    schema: "rhiz-harness-replay-experiment/v1",
    id: "replay:test",
    hypothesis: "Model B verifies more of these cases",
    benchmarkCaseIds: ["case:1", "case:2"],
    permittedDifferences: ["model"],
    candidateControls: { model: "model-b" },
    trialsPerArm: 2,
    ...overrides,
  });
}

function intervention(index: number) {
  return {
    id: `intervention:${index}`,
    occurredAt: "2026-09-01T00:05:00.000Z",
    kind: "status-check",
    detail: "Checked the worker",
    clerical: true,
  };
}

function pair(
  caseId: string,
  trial: number,
  baseline: Record<string, unknown> = {},
  candidate: Record<string, unknown> = {},
): ReplayTrialPair {
  return {
    baseline: benchRun({ benchmarkCaseId: caseId, workId: `${caseId}:work`, variantId: "baseline", attemptIds: [`a:${caseId}:${trial}`], ...baseline }),
    candidate: benchRun({ benchmarkCaseId: caseId, workId: `${caseId}:work`, variantId: "candidate", model: "model-b", attemptIds: [`b:${caseId}:${trial}`], ...candidate }),
  };
}

function fullCorpus(
  baseline: (caseId: string, trial: number) => Record<string, unknown> = () => ({}),
  candidate: (caseId: string, trial: number) => Record<string, unknown> = () => ({}),
): ReplayTrialPair[] {
  return ["case:1", "case:2"].flatMap((caseId) =>
    [0, 1].map((trial) => pair(caseId, trial, baseline(caseId, trial), candidate(caseId, trial))));
}

test("a candidate that verifies more with no more interventions is improved", () => {
  const result = summarizeReplayExperiment(
    spec(),
    fullCorpus((caseId, trial) => ({ verified: !(caseId === "case:2" && trial === 1) })),
  );
  assert.equal(result.verdict, "improved");
  assert.equal(result.claim, "descriptive");
  assert.equal(result.baseline.verifiedCompletionRate, 0.75);
  assert.equal(result.candidate.verifiedCompletionRate, 1);
  assert.equal(result.comparisons.length, 4);
  assert.doesNotThrow(() => ReplayResultSchema.parse(result));
});

test("equal completion with fewer interventions per verified outcome is improved", () => {
  const result = summarizeReplayExperiment(
    spec(),
    fullCorpus((_, trial) => ({ humanInterventions: [intervention(trial)] })),
  );
  assert.equal(result.verdict, "improved");
  assert.equal(result.baseline.interventionsPerVerifiedOutcome, 1);
  assert.equal(result.candidate.interventionsPerVerifiedOutcome, 0);
});

test("lower completion is regressed whatever else improved", () => {
  const result = summarizeReplayExperiment(
    spec(),
    fullCorpus(
      (_, trial) => ({ humanInterventions: [intervention(trial)] }),
      (caseId) => ({ verified: caseId !== "case:1" }),
    ),
  );
  assert.equal(result.verdict, "regressed");
});

test("more verification bought with more interventions is mixed, not improved", () => {
  const result = summarizeReplayExperiment(
    spec(),
    fullCorpus(
      (caseId) => ({ verified: caseId === "case:1" }),
      (_, trial) => ({ humanInterventions: [intervention(trial), intervention(trial + 10)] }),
    ),
  );
  assert.equal(result.verdict, "mixed");
  assert.ok(result.reasons.some((reason) => /more human interventions/.test(reason)));
});

test("a pair whose arms counted interventions differently is refused by the controls", () => {
  const runnerObserved = { wallClock: "runner-measured", humanInterventions: "runner-observed", usage: "provider-reported" };
  const result = summarizeReplayExperiment(spec(), fullCorpus(() => ({}), () => ({ measurementCoverage: runnerObserved })));
  assert.equal(result.verdict, "invalid");
  assert.equal(result.refusedPairs.length, 4);
  assert.match(result.refusedPairs[0]!.reason, /measurementCoverage/);
});

test("arms whose intervention coverage is mixed across cases do not compare ratios", () => {
  const runnerObserved = { wallClock: "runner-measured", humanInterventions: "runner-observed", usage: "provider-reported" };
  const caseTwoObserved = (caseId: string) => (caseId === "case:2" ? { measurementCoverage: runnerObserved } : {});
  const result = summarizeReplayExperiment(
    spec(),
    fullCorpus(
      (caseId, trial) => ({ ...caseTwoObserved(caseId), humanInterventions: [intervention(trial)] }),
      (caseId) => caseTwoObserved(caseId),
    ),
  );
  assert.equal(result.baseline.interventionCoverage, "mixed");
  // Without comparable ratios, equal completion cannot be called an improvement.
  assert.equal(result.verdict, "no-difference");
  assert.ok(result.reasons.some((reason) => /not comparable/.test(reason)));
});

test("a pair that breaks the experiment's controls is refused and reported, never dropped", () => {
  const pairs = fullCorpus();
  // The candidate also changed its context strategy, which this experiment did not permit.
  pairs[1] = pair("case:1", 1, {}, { contextStrategy: "broad" });
  const result = summarizeReplayExperiment(spec(), pairs);
  assert.equal(result.verdict, "invalid");
  assert.equal(result.refusedPairs.length, 1);
  assert.equal(result.refusedPairs[0]!.index, 1);
  assert.equal(result.comparisons.length, 3);
  assert.match(formatReplayResult(result), /refused pair 1/);
});

test("a candidate arm that did not apply the experiment's setting is refused", () => {
  const pairs = fullCorpus();
  pairs[0] = pair("case:1", 0, {}, { model: "model-c" });
  const result = summarizeReplayExperiment(spec(), pairs);
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /model=model-c, not the experiment's model-b/);
});

test("a pair from outside the experiment's cases is refused", () => {
  const result = summarizeReplayExperiment(spec(), [...fullCorpus(), pair("case:other", 0)]);
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /not part of this experiment/);
});

test("too few trials on any case is insufficient evidence, however good the rest looks", () => {
  const result = summarizeReplayExperiment(spec(), fullCorpus().slice(0, 3));
  assert.equal(result.verdict, "insufficient-evidence");
  assert.deepEqual(
    result.trialsByCase.map((entry) => [entry.benchmarkCaseId, entry.accepted]),
    [["case:1", 2], ["case:2", 1]],
  );
});

test("an operator-chosen candidate control is accepted at whatever value the run observed", () => {
  const result = summarizeReplayExperiment(
    spec({ permittedDifferences: ["contextStrategy"], candidateControls: { contextStrategy: "" } }),
    fullCorpus(() => ({}), () => ({ model: "model-a", contextStrategy: "broad" })),
  );
  assert.equal(result.refusedPairs.length, 0);
  assert.equal(result.verdict, "no-difference");
});

test("a candidate control outside the permitted differences is rejected at the spec", () => {
  assert.throws(() => spec({ permittedDifferences: ["model"], candidateControls: { contextStrategy: "broad" } }));
});

const unreportedUsage = {
  usage: undefined,
  measurementCoverage: { wallClock: "runner-measured", humanInterventions: "complete", usage: "unavailable" },
};

test("the publishable line states sample size, cost coverage, and intervention coverage", () => {
  const result = summarizeReplayExperiment(
    spec(),
    fullCorpus(
      (caseId) => (caseId === "case:2" ? unreportedUsage : {}),
      (caseId) => (caseId === "case:2" ? unreportedUsage : { usage: { costUsd: 4.21 } }),
    ),
  );
  assert.equal(
    formatReplayArm("Next.js migration / model-b", result.candidate),
    "Next.js migration / model-b: 100% verified completion, 0 interventions/outcome, $4.21 median cost (2/4 reported) (n=4, interventions complete)",
  );
});

test("an arm with nothing verified prints an undefined ratio rather than zero", () => {
  const runs: BenchmarkRun[] = [];
  assert.match(
    formatReplayArm("empty", {
      trials: 2,
      verified: 0,
      verifiedCompletionRate: 0,
      humanInterventions: 3,
      interventionsPerVerifiedOutcome: null,
      interventionCoverage: "complete",
      medianCostUsd: null,
      costReportedTrials: runs.length,
      medianElapsedMs: null,
    }),
    /interventions\/outcome undefined/,
  );
});

const RUNNER_OBSERVED = { wallClock: "runner-measured", humanInterventions: "runner-observed", usage: "provider-reported" };

test("intervention floors never decide a verdict, even when both arms are floors", () => {
  const result = summarizeReplayExperiment(
    spec({ benchmarkCaseIds: ["case:1"], trialsPerArm: 3 }),
    [0, 1, 2].map((trial) => pair(
      "case:1",
      trial,
      { measurementCoverage: RUNNER_OBSERVED, humanInterventions: [intervention(trial)] },
      { measurementCoverage: RUNNER_OBSERVED },
    )),
  );
  assert.notEqual(result.verdict, "improved");
  assert.equal(result.verdict, "no-difference");
  assert.ok(result.reasons.some((reason) => /not comparable/.test(reason)));
});

test("one trial passed several times is refused, not counted as several trials", () => {
  const once = pair("case:1", 0, { verified: false });
  const result = summarizeReplayExperiment(spec({ benchmarkCaseIds: ["case:1"], trialsPerArm: 3 }), [once, once, once]);
  assert.equal(result.verdict, "invalid");
  assert.equal(result.refusedPairs.length, 2);
  assert.match(result.refusedPairs[0]!.reason, /already counted/);
});

test("a run reused across two pairs is refused", () => {
  const shared = benchRun({ variantId: "baseline", attemptIds: ["a:shared"] });
  const first = pair("case:1", 0);
  const second = pair("case:1", 1);
  const result = summarizeReplayExperiment(spec({ benchmarkCaseIds: ["case:1"] }), [
    { ...first, baseline: shared },
    { ...second, baseline: shared },
  ]);
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /already counted/);
});

test("arms that swap or drift between pairs are refused", () => {
  const operatorChosen = spec({ benchmarkCaseIds: ["case:1"], permittedDifferences: ["contextStrategy"], candidateControls: { contextStrategy: "" }, trialsPerArm: 3 });
  const swapped = [
    pair("case:1", 0, { contextStrategy: "minimal", verified: false }, { model: "model-a", contextStrategy: "broad" }),
    pair("case:1", 1, { contextStrategy: "broad", verified: false }, { model: "model-a", contextStrategy: "minimal" }),
    pair("case:1", 2, { contextStrategy: "minimal", verified: false }, { model: "model-a", contextStrategy: "broad" }),
  ];
  const result = summarizeReplayExperiment(operatorChosen, swapped);
  assert.equal(result.verdict, "invalid");
  assert.equal(result.refusedPairs.length, 1);
  assert.match(result.refusedPairs[0]!.reason, /baseline arm/);
});

test("an A/A pair that changes nothing the experiment varies is refused", () => {
  const result = summarizeReplayExperiment(
    spec({ benchmarkCaseIds: ["case:1"], trialsPerArm: 1 }),
    [pair("case:1", 0, { model: "model-b", verified: false })],
  );
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /changes nothing/);
});

test("a copied receipt with one field changed is still the same trial", () => {
  const first = pair("case:1", 0, { verified: false }, { attemptIds: ["candidate:0"] });
  const copy = pair("case:1", 1, { verified: false }, { attemptIds: ["candidate:0"], evidenceRefs: ["copy"] });
  const result = summarizeReplayExperiment(spec({ benchmarkCaseIds: ["case:1"], trialsPerArm: 2 }), [first, copy]);
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /already counted/);
});

test("one execution relabelled as the other arm is not a pair", () => {
  const result = summarizeReplayExperiment(
    spec({ benchmarkCaseIds: ["case:1"], trialsPerArm: 1 }),
    [pair("case:1", 0, { verified: false, attemptIds: ["shared"] }, { attemptIds: ["shared"] })],
  );
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /already counted/);
});

test("an arm that never executed is not a trial", () => {
  const result = summarizeReplayExperiment(
    spec({ benchmarkCaseIds: ["case:1"], trialsPerArm: 1 }),
    [pair("case:1", 0, { verified: false, outcome: "failed", attemptIds: [] })],
  );
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /never executed/);
});

test("a dimension the experiment claims to vary must actually vary", () => {
  const twoDimensions = spec({
    benchmarkCaseIds: ["case:1"],
    trialsPerArm: 1,
    permittedDifferences: ["workerProviderId", "model"],
    candidateControls: { workerProviderId: "worker:codex", model: "model-b" },
  });
  const result = summarizeReplayExperiment(twoDimensions, [
    pair("case:1", 0, { model: "model-tiny", verified: false }, { workerProviderId: "worker:codex" }),
  ]);
  assert.equal(result.verdict, "invalid");
  assert.match(result.refusedPairs[0]!.reason, /changes nothing on workerProviderId/);
});

test("the result records and prints what each arm actually ran", () => {
  const result = summarizeReplayExperiment(spec(), fullCorpus());
  assert.deepEqual(result.armControls, {
    baseline: { variantId: "baseline", model: "model-a" },
    candidate: { variantId: "candidate", model: "model-b" },
  });
  assert.match(formatReplayResult(result), /baseline {2}ran \{"variantId":"baseline","model":"model-a"\}/);
});
