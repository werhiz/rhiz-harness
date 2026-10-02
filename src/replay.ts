// Historical replay: the experiment half of the Factory Runtime (ADR 0025).
//
// An Observer finding is a hypothesis. A replay experiment tests it by
// re-running the same historical cases, from the same base and the same
// WorkContract, under a baseline arm and a candidate arm that differ only in
// the dimensions the experiment names. This module turns the paired runs that
// come back into one result a person can publish and another person can
// reproduce.
//
// Every pair passes through compareBenchmarkRuns, which owns the controls. A
// pair that fails it is reported, never dropped: an experiment that silently
// discards its awkward trials can prove anything. Missing trials make the
// result insufficient rather than smaller. The verdict is descriptive. It
// computes no significance and claims none.
import { z } from "zod";
import {
  BenchmarkComparisonSchema,
  compareBenchmarkRuns,
  type BenchmarkComparison,
  type BenchmarkRun,
} from "./benchmark.js";
import {
  InterventionCoverageSchema,
  ReplayExperimentSpecSchema,
  interventionCoverageOf,
  median,
  northStarOf,
  type ReplayExperimentSpec,
} from "./observer.js";

const id = z.string().trim().min(1).max(200);

export const REPLAY_RESULT_SCHEMA = "rhiz-harness-replay-result/v1" as const;

export const ReplayArmSummarySchema = z.object({
  trials: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  verifiedCompletionRate: z.number().min(0).max(1).nullable(),
  humanInterventions: z.number().int().nonnegative(),
  interventionsPerVerifiedOutcome: z.number().nonnegative().nullable(),
  interventionCoverage: InterventionCoverageSchema,
  medianCostUsd: z.number().nonnegative().nullable(),
  costReportedTrials: z.number().int().nonnegative(),
  medianElapsedMs: z.number().nonnegative().nullable(),
}).strict();
export type ReplayArmSummary = z.infer<typeof ReplayArmSummarySchema>;

export const ReplayVerdictSchema = z.enum([
  /** At least one pair was refused. Nothing may be claimed until it is explained. */
  "invalid",
  /** Some case has fewer accepted pairs than the experiment asked for. */
  "insufficient-evidence",
  "improved",
  "regressed",
  "no-difference",
  /** Verified completion and interventions moved in opposite directions. */
  "mixed",
]);
export type ReplayVerdict = z.infer<typeof ReplayVerdictSchema>;

export const ReplayResultSchema = z.object({
  schema: z.literal(REPLAY_RESULT_SCHEMA),
  experiment: ReplayExperimentSpecSchema,
  verdict: ReplayVerdictSchema,
  /** Always descriptive. A significance claim needs a method this module does not run. */
  claim: z.literal("descriptive"),
  reasons: z.array(z.string().min(1).max(1000)),
  baseline: ReplayArmSummarySchema,
  candidate: ReplayArmSummarySchema,
  trialsByCase: z.array(z.object({
    benchmarkCaseId: id,
    accepted: z.number().int().nonnegative(),
    required: z.number().int().min(1),
  }).strict()),
  refusedPairs: z.array(z.object({
    index: z.number().int().nonnegative(),
    benchmarkCaseId: id,
    reason: z.string().min(1).max(1000),
  }).strict()),
  /** What each arm actually ran on the experiment's dimensions, observed from accepted pairs. Null until a pair is accepted. */
  armControls: z.object({
    baseline: z.record(z.string(), z.string().nullable()).nullable(),
    candidate: z.record(z.string(), z.string().nullable()).nullable(),
  }).strict(),
  comparisons: z.array(BenchmarkComparisonSchema),
}).strict();
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export interface ReplayTrialPair {
  baseline: BenchmarkRun;
  candidate: BenchmarkRun;
}

function summarizeArm(runs: readonly BenchmarkRun[]): ReplayArmSummary {
  const star = northStarOf(runs);
  const costs = runs.flatMap((run) => (run.usage?.costUsd === undefined ? [] : [run.usage.costUsd]));
  return {
    trials: runs.length,
    verified: star.verifiedOutcomes,
    verifiedCompletionRate: runs.length === 0 ? null : Math.round((star.verifiedOutcomes / runs.length) * 10_000) / 10_000,
    humanInterventions: star.humanInterventions,
    interventionsPerVerifiedOutcome: star.interventionsPerVerifiedOutcome,
    interventionCoverage: interventionCoverageOf(runs),
    medianCostUsd: median(costs),
    costReportedTrials: costs.length,
    medianElapsedMs: median(runs.map((run) => Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)))),
  };
}

function controlValue(run: BenchmarkRun, field: string): string | null {
  const value = (run as Record<string, unknown>)[field];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Why a pair cannot count toward this experiment, or null when it can. */
function refusal(spec: ReplayExperimentSpec, pair: ReplayTrialPair): { reason: string } | { comparison: BenchmarkComparison } {
  if (!spec.benchmarkCaseIds.includes(pair.baseline.benchmarkCaseId)) {
    return { reason: `case ${pair.baseline.benchmarkCaseId} is not part of this experiment` };
  }
  for (const [field, expected] of Object.entries(spec.candidateControls)) {
    // An empty value means the operator chose the candidate setting at run time.
    if (expected === "") continue;
    const actual = controlValue(pair.candidate, field);
    if (actual !== expected) {
      return { reason: `candidate arm ran ${field}=${actual ?? "unobserved"}, not the experiment's ${expected}` };
    }
  }
  try {
    return { comparison: compareBenchmarkRuns(pair.baseline, pair.candidate, { permittedDifferences: spec.permittedDifferences }) };
  } catch (error) {
    return { reason: error instanceof Error ? error.message.slice(0, 1000) : "comparison refused the pair" };
  }
}

function verdictOf(baseline: ReplayArmSummary, candidate: ReplayArmSummary, reasons: string[]): ReplayVerdict {
  const rateB = baseline.verifiedCompletionRate ?? 0;
  const rateC = candidate.verifiedCompletionRate ?? 0;
  // Intervention ratios decide a verdict only when both arms are a complete
  // census and both verified something. A runner-observed count is a floor:
  // a candidate that moves work onto checks the runner cannot see would read
  // as an improvement. compareBenchmarkRuns withholds the pairwise count for
  // the same reason.
  const ratiosComparable =
    baseline.interventionCoverage === "complete" &&
    candidate.interventionCoverage === "complete" &&
    baseline.interventionsPerVerifiedOutcome !== null &&
    candidate.interventionsPerVerifiedOutcome !== null;
  if (!ratiosComparable) {
    reasons.push("interventions per verified outcome is not comparable between arms; the verdict rests on verified completion alone");
  }
  const ratioDelta = ratiosComparable
    ? candidate.interventionsPerVerifiedOutcome! - baseline.interventionsPerVerifiedOutcome!
    : 0;
  if (rateC < rateB) return "regressed";
  if (rateC === rateB && ratioDelta > 0) return "regressed";
  if (rateC > rateB && ratioDelta <= 0) return "improved";
  if (rateC === rateB && ratioDelta < 0) return "improved";
  if (rateC > rateB && ratioDelta > 0) {
    reasons.push("the candidate verified more often but needed more human interventions per verified outcome");
    return "mixed";
  }
  return "no-difference";
}

export function summarizeReplayExperiment(
  rawSpec: ReplayExperimentSpec,
  pairs: readonly ReplayTrialPair[],
): ReplayResult {
  const spec = ReplayExperimentSpecSchema.parse(rawSpec);
  const reasons: string[] = [];
  const refusedPairs: ReplayResult["refusedPairs"] = [];
  const comparisons: BenchmarkComparison[] = [];
  const baselineRuns: BenchmarkRun[] = [];
  const candidateRuns: BenchmarkRun[] = [];
  const accepted = new Map<string, number>(spec.benchmarkCaseIds.map((caseId) => [caseId, 0]));

  const countedAttempts = new Set<string>();
  const armControls: { baseline: Record<string, string | null> | null; candidate: Record<string, string | null> | null } =
    { baseline: null, candidate: null };
  const controlsOf = (run: BenchmarkRun): Record<string, string | null> => ({
    variantId: run.variantId ?? null,
    ...Object.fromEntries(spec.permittedDifferences.map((field) => [field, controlValue(run, field)])),
  });

  pairs.forEach((pair, index) => {
    const refuse = (reason: string) => {
      refusedPairs.push({ index, benchmarkCaseId: pair.baseline.benchmarkCaseId, reason });
    };
    const outcome = refusal(spec, pair);
    if ("reason" in outcome) return refuse(outcome.reason);

    // A trial is an execution, named by its attempts. Each attempt counts once
    // across both arms and every pair, so neither a copied receipt with one
    // field changed nor one execution relabelled as the other arm can pass as
    // a second trial. An arm that never executed is not a trial of its
    // configuration at all.
    for (const arm of ["baseline", "candidate"] as const) {
      if (pair[arm].attemptIds.length === 0) return refuse(`the ${arm} arm never executed (no attempts)`);
    }
    const attempts = [...pair.baseline.attemptIds, ...pair.candidate.attemptIds];
    if (new Set(attempts).size !== attempts.length || attempts.some((attempt) => countedAttempts.has(attempt))) {
      return refuse("an attempt in this pair is already counted, in this pair or an earlier one");
    }

    // The experiment names the dimensions it varies. A pair that leaves any of
    // them unchanged does not test the stated change, and an A/A pair tests
    // nothing.
    const unchanged = spec.permittedDifferences.filter((field) =>
      controlValue(pair.baseline, field) === controlValue(pair.candidate, field));
    if (unchanged.length > 0) {
      return refuse(`the pair changes nothing on ${unchanged.join(", ")}, which the experiment says it varies`);
    }

    // Each arm is one configuration across every pair. An arm that drifts,
    // or arms that swap, compare nothing.
    for (const arm of ["baseline", "candidate"] as const) {
      const observed = controlsOf(pair[arm]);
      const established = armControls[arm];
      if (established !== null && JSON.stringify(established) !== JSON.stringify(observed)) {
        return refuse(`${arm} arm ran ${JSON.stringify(observed)}, but earlier pairs' ${arm} arm ran ${JSON.stringify(established)}`);
      }
    }
    armControls.baseline ??= controlsOf(pair.baseline);
    armControls.candidate ??= controlsOf(pair.candidate);
    for (const attempt of attempts) countedAttempts.add(attempt);
    comparisons.push(outcome.comparison);
    baselineRuns.push(pair.baseline);
    candidateRuns.push(pair.candidate);
    accepted.set(pair.baseline.benchmarkCaseId, (accepted.get(pair.baseline.benchmarkCaseId) ?? 0) + 1);
  });

  const trialsByCase = spec.benchmarkCaseIds.map((benchmarkCaseId) => ({
    benchmarkCaseId,
    accepted: accepted.get(benchmarkCaseId) ?? 0,
    required: spec.trialsPerArm,
  }));
  const baseline = summarizeArm(baselineRuns);
  const candidate = summarizeArm(candidateRuns);

  let verdict: ReplayVerdict;
  if (refusedPairs.length > 0) {
    verdict = "invalid";
    reasons.push(`${refusedPairs.length} pair(s) failed the experiment's controls; explain or rerun them before claiming a result`);
  } else if (trialsByCase.some((entry) => entry.accepted < entry.required)) {
    verdict = "insufficient-evidence";
    const short = trialsByCase.filter((entry) => entry.accepted < entry.required);
    reasons.push(`${short.length} case(s) have fewer than ${spec.trialsPerArm} paired trials`);
  } else {
    verdict = verdictOf(baseline, candidate, reasons);
  }

  return ReplayResultSchema.parse({
    schema: REPLAY_RESULT_SCHEMA,
    experiment: spec,
    verdict,
    claim: "descriptive",
    reasons,
    baseline,
    candidate,
    trialsByCase,
    refusedPairs,
    armControls,
    comparisons,
  });
}

/**
 * The one-line, publishable form of an arm:
 * `label: 86% verified completion, 0.8 interventions/outcome, $4.21 median cost (n=12, interventions complete)`.
 * Every number it prints states its own coverage, so a line cannot outrun its evidence.
 */
export function formatReplayArm(label: string, arm: ReplayArmSummary): string {
  const rate = arm.verifiedCompletionRate === null ? "no trials" : `${Math.round(arm.verifiedCompletionRate * 100)}% verified completion`;
  const ratio = arm.interventionsPerVerifiedOutcome === null
    ? "interventions/outcome undefined"
    : `${arm.interventionsPerVerifiedOutcome} interventions/outcome`;
  const cost = arm.medianCostUsd === null
    ? "cost unreported"
    : `$${arm.medianCostUsd.toFixed(2)} median cost${arm.costReportedTrials < arm.trials ? ` (${arm.costReportedTrials}/${arm.trials} reported)` : ""}`;
  return `${label}: ${rate}, ${ratio}, ${cost} (n=${arm.trials}, interventions ${arm.interventionCoverage})`;
}

export function formatReplayResult(result: ReplayResult): string {
  const lines = [
    `Replay ${result.experiment.id}: ${result.verdict} (${result.claim}).`,
    `Hypothesis: ${result.experiment.hypothesis}`,
    `Varied: ${result.experiment.permittedDifferences.join(", ")}.`,
    `  baseline  ran ${JSON.stringify(result.armControls.baseline)}`,
    `  candidate ran ${JSON.stringify(result.armControls.candidate)}`,
    formatReplayArm("  baseline ", result.baseline),
    formatReplayArm("  candidate", result.candidate),
  ];
  for (const reason of result.reasons) lines.push(`  note: ${reason}`);
  for (const refused of result.refusedPairs) lines.push(`  refused pair ${refused.index} (${refused.benchmarkCaseId}): ${refused.reason}`);
  return lines.join("\n");
}
