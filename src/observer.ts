// Factory Observer: the cross-Work stage of the intelligence loop (ADR 0025).
//
// Refiner analyzes one closed Work. The Observer reads many Works at once,
// the Ledger events they left and the BenchmarkRuns measured over them, and
// reports what only a population shows: which worker does better on which
// task class, which verification criteria have never failed, which Context
// keeps being loaded, which corrections keep recurring, where human clerical
// effort and money went.
//
// It is a pure, deterministic projection. It reads evidence and returns a
// report; it appends nothing, promotes nothing, and calls no model. Every
// finding names the Ledger events or benchmark runs it stands on, the Refiner
// proposal kind it would become, and, when run evidence exists, the replay
// experiment that would test it. Learning proposes. Named authorities promote.
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BENCHMARK_CONTROL_DIMENSIONS,
  type BenchmarkControlDimension,
  type BenchmarkRun,
  type HumanIntervention,
} from "./benchmark.js";
import {
  FAILURE_TAXONOMY,
  SUCCESS_TAXONOMY,
  type FailureTaxonomy,
  type SuccessTaxonomy,
} from "./refiner.js";
import {
  RefinerProposalKindSchema,
  type HarnessEvent,
  type RefinerProposalKind,
} from "./schemas.js";

const id = z.string().trim().min(1).max(200);

export const OBSERVATION_SCHEMA = "rhiz-harness-factory-observation/v1" as const;
export const REPLAY_EXPERIMENT_SCHEMA = "rhiz-harness-replay-experiment/v1" as const;
export const UNCLASSIFIED_TASK_CLASS = "unclassified" as const;

export const ObserverConfigSchema = z.object({
  /** Runs a cohort needs before it is compared with another. */
  minimumCohortRuns: z.number().int().min(1).default(3),
  /** Verified-completion gap between two cohorts on one task class that is worth testing. */
  minimumCompletionGap: z.number().min(0).max(1).default(0.2),
  /** Distinct Works a Context marker must be selected in before it is called repeated. */
  minimumRepeatedContextWorks: z.number().int().min(2).default(3),
  /** Evaluations a criterion needs before "never failed" means anything. */
  minimumQuietCriterionEvaluations: z.number().int().min(2).default(5),
  /** Distinct Works a review finding must recur in. */
  minimumRecurringFindingWorks: z.number().int().min(2).default(2),
  /** Runs one clerical intervention kind must appear in. */
  minimumInterventionHotspotRuns: z.number().int().min(2).default(2),
  /** Distinct benchmark cases a capability must be verified in to be a promotion candidate. */
  minimumCapabilityVerifiedCases: z.number().int().min(2).default(3),
  /** Trials per arm a generated replay experiment asks for. */
  replayTrialsPerArm: z.number().int().min(1).default(3),
}).strict();
export type ObserverConfig = z.infer<typeof ObserverConfigSchema>;

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = Object.freeze(ObserverConfigSchema.parse({}));

export const InterventionCoverageSchema = z.enum(["complete", "runner-observed", "mixed", "unreported", "none"]);
export type InterventionCoverage = z.infer<typeof InterventionCoverageSchema>;

export const NorthStarSchema = z.object({
  runs: z.number().int().nonnegative(),
  verifiedOutcomes: z.number().int().nonnegative(),
  humanInterventions: z.number().int().nonnegative(),
  clericalInterventions: z.number().int().nonnegative(),
  /**
   * Human interventions per independently verified successful outcome.
   * Null when nothing was verified: dividing by zero would report either
   * infinity or a flattering zero, and both are lies.
   */
  interventionsPerVerifiedOutcome: z.number().nonnegative().nullable(),
  /**
   * Whether intervention counts are a full census or only what the runner
   * saw. A runner cannot see a human checking a terminal, so a
   * runner-observed count is a floor, never the measure itself.
   */
  interventionCoverage: InterventionCoverageSchema,
}).strict();
export type NorthStar = z.infer<typeof NorthStarSchema>;

export const CohortSchema = z.object({
  taskClass: id,
  workerProviderId: id.nullable(),
  model: z.string().min(1).max(300).nullable(),
  runs: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  verifiedCompletionRate: z.number().min(0).max(1).nullable(),
  interventionsPerVerifiedOutcome: z.number().nonnegative().nullable(),
  interventionCoverage: InterventionCoverageSchema,
  medianCostUsd: z.number().nonnegative().nullable(),
  costReportedRuns: z.number().int().nonnegative(),
  medianElapsedMs: z.number().nonnegative().nullable(),
  benchmarkCaseIds: z.array(id),
}).strict();
export type Cohort = z.infer<typeof CohortSchema>;

export const WasteSchema = z.object({
  unverifiedRuns: z.number().int().nonnegative(),
  unverifiedElapsedMs: z.number().nonnegative(),
  /** Spend on runs that produced no verified outcome. Null when no such run reported cost. */
  unverifiedCostUsd: z.number().nonnegative().nullable(),
  unverifiedCostReportedRuns: z.number().int().nonnegative(),
  failedAttempts: z.number().int().nonnegative(),
  blockedAttempts: z.number().int().nonnegative(),
  /** Works whose verification passed but which the Board never accepted, rejected, or cancelled. */
  verifiedButUndecidedWorks: z.number().int().nonnegative(),
}).strict();
export type Waste = z.infer<typeof WasteSchema>;

export const ObserverFindingKindSchema = z.enum([
  "cohort-gap",
  "quiet-criterion",
  "repeated-context",
  "recurring-review-finding",
  "intervention-hotspot",
  "capability-candidate",
]);
export type ObserverFindingKind = z.infer<typeof ObserverFindingKindSchema>;

export const ObserverEvidenceSchema = z.object({
  ledgerEventIds: z.array(id),
  benchmarkCaseIds: z.array(id),
  workIds: z.array(id),
}).strict();

export const ReplayExperimentSpecSchema = z.object({
  schema: z.literal(REPLAY_EXPERIMENT_SCHEMA),
  id,
  hypothesis: z.string().min(1).max(2000),
  benchmarkCaseIds: z.array(id).min(1),
  /** The control dimensions this experiment may change. Everything else is held. */
  permittedDifferences: z.array(z.enum(BENCHMARK_CONTROL_DIMENSIONS)).min(1),
  /** What the candidate arm sets, by dimension. An empty value is for the operator to choose. */
  candidateControls: z.record(z.string(), z.string()),
  trialsPerArm: z.number().int().min(1),
}).strict().superRefine((value, ctx) => {
  for (const key of Object.keys(value.candidateControls)) {
    if (!(value.permittedDifferences as readonly string[]).includes(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateControls", key],
        message: "a candidate control must be one of the permitted differences",
      });
    }
  }
});
export type ReplayExperimentSpec = z.infer<typeof ReplayExperimentSpecSchema>;

const taxonomyClassification = z.string().refine(
  (value) => (FAILURE_TAXONOMY as readonly string[]).includes(value) ||
    (SUCCESS_TAXONOMY as readonly string[]).includes(value),
  { message: "classification must come from the Refiner taxonomy" },
);

export const ObserverFindingSchema = z.object({
  id,
  kind: ObserverFindingKindSchema,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4000),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  evidence: ObserverEvidenceSchema,
  proposalKind: RefinerProposalKindSchema,
  classification: taxonomyClassification,
  /** Null, with the reason, when no benchmark run exists to replay. */
  replay: ReplayExperimentSpecSchema.nullable(),
  replayUnavailableReason: z.string().min(1).max(500).nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.replay === null) === (value.replayUnavailableReason === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["replay"],
      message: "a finding carries either a replay experiment or the reason it has none",
    });
  }
  if (value.evidence.ledgerEventIds.length === 0 && value.evidence.benchmarkCaseIds.length === 0) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "a finding must name the evidence it stands on" });
  }
});
export type ObserverFinding = z.infer<typeof ObserverFindingSchema>;

export const FactoryObservationSchema = z.object({
  schema: z.literal(OBSERVATION_SCHEMA),
  window: z.object({
    firstOccurredAt: z.string().nullable(),
    lastOccurredAt: z.string().nullable(),
    eventCount: z.number().int().nonnegative(),
    workCount: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    /** Runs supplied more than once. Each is counted once; a repeat is not more evidence. */
    duplicateRunsIgnored: z.number().int().nonnegative(),
    /** Ledger events supplied more than once (same id, same content). Each is counted once. */
    duplicateEventsIgnored: z.number().int().nonnegative(),
  }).strict(),
  northStar: NorthStarSchema,
  /** Judgment decisions are tracked apart from clerical effort, never folded into it. */
  decisions: z.object({
    requested: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }).strict(),
  cohorts: z.array(CohortSchema),
  waste: WasteSchema,
  findings: z.array(ObserverFindingSchema),
  config: ObserverConfigSchema,
}).strict();
export type FactoryObservation = z.infer<typeof FactoryObservationSchema>;

export interface ObserveInput {
  events?: readonly HarnessEvent[];
  runs?: readonly BenchmarkRun[];
  config?: Partial<ObserverConfig>;
}

const INTERVENTION_PROPOSAL: Record<HumanIntervention["kind"], RefinerProposalKind> = {
  "follow-up-prompt": "context-strategy",
  "status-check": "recovery-behavior",
  "context-refeed": "context-strategy",
  "manual-routing": "routing-policy",
  "manual-verification": "verifier",
  "manual-recovery": "recovery-behavior",
  repair: "test",
  clerical: "tool",
  "judgment-decision": "documentation",
  other: "documentation",
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The identity of a supplied run: its full canonical content. */
export function benchmarkRunIdentity(run: BenchmarkRun): string {
  return canonicalJson(run);
}

/** UTF-16 code-unit order. Never locale-aware, so output is identical on every machine. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Chronological order by parsed instant, so offsets such as +05:00 sort correctly; ties by id. */
function compareInstants(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function digestId(prefix: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    // Length-prefix each part so no two part lists share an encoding.
    hash.update(`${Buffer.byteLength(part, "utf8")}:${part}`);
  }
  return `${prefix}:${hash.digest("hex").slice(0, 16)}`;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function elapsedMs(run: BenchmarkRun): number {
  return Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

export function interventionCoverageOf(runs: readonly BenchmarkRun[]): InterventionCoverage {
  if (runs.length === 0) return "none";
  const states = new Set(runs.map((run) => run.measurementCoverage?.humanInterventions ?? "unreported"));
  if (states.size > 1) return "mixed";
  return [...states][0] as InterventionCoverage;
}

/**
 * An independently verified successful outcome, as the Benchmark Contract
 * defines it: verification passed and the run ended verified or accepted. A
 * run that verified and then failed, was interrupted, or was rejected is not
 * a success, and the repository runner does emit that shape.
 */
export function isVerifiedSuccess(run: BenchmarkRun): boolean {
  return run.verified && (run.outcome === "verified" || run.outcome === "accepted");
}

export function northStarOf(runs: readonly BenchmarkRun[]): NorthStar {
  const verifiedOutcomes = runs.filter(isVerifiedSuccess).length;
  const humanInterventions = runs.reduce((sum, run) => sum + run.humanInterventions.length, 0);
  const clericalInterventions = runs.reduce(
    (sum, run) => sum + run.humanInterventions.filter((intervention) => intervention.clerical).length,
    0,
  );
  return {
    runs: runs.length,
    verifiedOutcomes,
    humanInterventions,
    clericalInterventions,
    interventionsPerVerifiedOutcome: verifiedOutcomes === 0 ? null : round(humanInterventions / verifiedOutcomes),
    interventionCoverage: interventionCoverageOf(runs),
  };
}

/** Task class per Work, from the Context selection the Work actually received. */
function taskClassByWork(events: readonly HarnessEvent[]): Map<string, string> {
  const classes = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== "context.pack-selected") continue;
    const set = classes.get(event.workId) ?? new Set<string>();
    set.add(event.payload.taskClass);
    classes.set(event.workId, set);
  }
  const resolved = new Map<string, string>();
  for (const [workId, set] of classes) {
    // A Work selected under two task classes is not silently assigned to either.
    resolved.set(workId, set.size === 1 ? [...set][0]! : UNCLASSIFIED_TASK_CLASS);
  }
  return resolved;
}

function cohortsOf(runs: readonly BenchmarkRun[], taskClasses: Map<string, string>): Cohort[] {
  const groups = new Map<string, BenchmarkRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([
      (run.workId && taskClasses.get(run.workId)) ?? UNCLASSIFIED_TASK_CLASS,
      run.workerProviderId ?? null,
      run.model ?? null,
    ]);
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const cohorts: Cohort[] = [];
  for (const [key, group] of groups) {
    const [taskClass, workerProviderId, model] = JSON.parse(key) as [string, string | null, string | null];
    const star = northStarOf(group);
    const costs = group.flatMap((run) => (run.usage?.costUsd === undefined ? [] : [run.usage.costUsd]));
    cohorts.push({
      taskClass,
      workerProviderId,
      model,
      runs: group.length,
      verified: star.verifiedOutcomes,
      verifiedCompletionRate: round(star.verifiedOutcomes / group.length),
      interventionsPerVerifiedOutcome: star.interventionsPerVerifiedOutcome,
      interventionCoverage: star.interventionCoverage,
      medianCostUsd: median(costs),
      costReportedRuns: costs.length,
      medianElapsedMs: median(group.map(elapsedMs)),
      benchmarkCaseIds: sortedUnique(group.map((run) => run.benchmarkCaseId)),
    });
  }
  return cohorts.sort((a, b) =>
    compareText(a.taskClass, b.taskClass) ||
    compareText(a.workerProviderId ?? "", b.workerProviderId ?? "") ||
    compareText(a.model ?? "", b.model ?? ""));
}

function wasteOf(events: readonly HarnessEvent[], runs: readonly BenchmarkRun[]): Waste {
  const unverified = runs.filter((run) => !isVerifiedSuccess(run));
  const unverifiedCosts = unverified.flatMap((run) => (run.usage?.costUsd === undefined ? [] : [run.usage.costUsd]));
  const verifiedWorks = new Set<string>();
  const decidedWorks = new Set<string>();
  for (const event of events) {
    // Events arrive in chronological order, so the last result seen is the
    // Work's current verification state; a later failure clears an earlier pass.
    if (event.type === "verification.result") {
      if (event.payload.status === "pass") verifiedWorks.add(event.workId);
      else verifiedWorks.delete(event.workId);
    }
    if (event.type === "work.accepted" || event.type === "work.rejected" || event.type === "work.cancelled") {
      decidedWorks.add(event.workId);
    }
  }
  return {
    unverifiedRuns: unverified.length,
    unverifiedElapsedMs: unverified.reduce((sum, run) => sum + elapsedMs(run), 0),
    unverifiedCostUsd: unverifiedCosts.length === 0 ? null : round(unverifiedCosts.reduce((a, b) => a + b, 0)),
    unverifiedCostReportedRuns: unverifiedCosts.length,
    failedAttempts: events.filter((event) => event.type === "attempt.failed").length,
    blockedAttempts: events.filter((event) => event.type === "attempt.blocked").length,
    verifiedButUndecidedWorks: [...verifiedWorks].filter((workId) => !decidedWorks.has(workId)).length,
  };
}

function replaySpec(
  config: ObserverConfig,
  findingId: string,
  hypothesis: string,
  benchmarkCaseIds: readonly string[],
  permittedDifferences: readonly BenchmarkControlDimension[],
  candidateControls: Record<string, string>,
): ReplayExperimentSpec {
  return ReplayExperimentSpecSchema.parse({
    schema: REPLAY_EXPERIMENT_SCHEMA,
    id: findingId.replace(/^finding:/, "replay:"),
    hypothesis,
    benchmarkCaseIds: sortedUnique(benchmarkCaseIds),
    permittedDifferences: [...permittedDifferences],
    candidateControls,
    trialsPerArm: config.replayTrialsPerArm,
  });
}

function caseIdsForWorks(runs: readonly BenchmarkRun[], workIds: ReadonlySet<string>): string[] {
  return sortedUnique(runs.filter((run) => run.workId && workIds.has(run.workId)).map((run) => run.benchmarkCaseId));
}

function finding(input: {
  kind: ObserverFindingKind;
  key: readonly string[];
  title: string;
  summary: string;
  metrics: Record<string, number | string | null>;
  ledgerEventIds?: Iterable<string>;
  benchmarkCaseIds?: Iterable<string>;
  workIds?: Iterable<string>;
  proposalKind: RefinerProposalKind;
  classification: FailureTaxonomy | SuccessTaxonomy;
  replay: (findingId: string) => ReplayExperimentSpec | null;
  replayUnavailableReason: string;
}): ObserverFinding {
  const findingId = digestId("finding", [input.kind, ...input.key]);
  const replay = input.replay(findingId);
  return ObserverFindingSchema.parse({
    id: findingId,
    kind: input.kind,
    title: input.title.slice(0, 200),
    summary: input.summary,
    metrics: input.metrics,
    evidence: {
      ledgerEventIds: sortedUnique(input.ledgerEventIds ?? []),
      benchmarkCaseIds: sortedUnique(input.benchmarkCaseIds ?? []),
      workIds: sortedUnique(input.workIds ?? []),
    },
    proposalKind: input.proposalKind,
    classification: input.classification,
    replay,
    replayUnavailableReason: replay === null ? input.replayUnavailableReason : null,
  });
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

function cohortName(cohort: Pick<Cohort, "workerProviderId" | "model">): string {
  return [cohort.workerProviderId ?? "unknown-worker", cohort.model].filter(Boolean).join(" / ");
}

function cohortGapFindings(cohorts: readonly Cohort[], config: ObserverConfig): ObserverFinding[] {
  const findings: ObserverFinding[] = [];
  const byClass = new Map<string, Cohort[]>();
  for (const cohort of cohorts) {
    if (cohort.runs < config.minimumCohortRuns || cohort.verifiedCompletionRate === null) continue;
    const list = byClass.get(cohort.taskClass) ?? [];
    list.push(cohort);
    byClass.set(cohort.taskClass, list);
  }
  for (const [taskClass, list] of byClass) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) =>
      (b.verifiedCompletionRate! - a.verifiedCompletionRate!) ||
      // Interventions break a completion tie only between two complete
      // censuses; a runner-observed floor must never pick the recommendation.
      (a.interventionCoverage === "complete" && b.interventionCoverage === "complete"
        ? (a.interventionsPerVerifiedOutcome ?? Infinity) - (b.interventionsPerVerifiedOutcome ?? Infinity)
        : 0) ||
      compareText(cohortName(a), cohortName(b)));
    const best = ranked[0]!;
    const worst = ranked.at(-1)!;
    const gap = best.verifiedCompletionRate! - worst.verifiedCompletionRate!;
    if (gap < config.minimumCompletionGap) continue;
    const candidateControls: Record<string, string> = {};
    const permitted: BenchmarkControlDimension[] = [];
    if (best.workerProviderId !== worst.workerProviderId && best.workerProviderId) {
      permitted.push("workerProviderId");
      candidateControls.workerProviderId = best.workerProviderId;
    }
    if (best.model !== worst.model && best.model) {
      permitted.push("model");
      candidateControls.model = best.model;
    }
    findings.push(finding({
      kind: "cohort-gap",
      key: [taskClass, cohortName(best), cohortName(worst)],
      title: `${cohortName(best)} outperforms ${cohortName(worst)} on ${taskClass} Work`,
      summary:
        `On ${taskClass} Work, ${cohortName(best)} reached ${percent(best.verifiedCompletionRate)} verified completion ` +
        `over ${best.runs} runs; ${cohortName(worst)} reached ${percent(worst.verifiedCompletionRate)} over ${worst.runs}. ` +
        "The cohorts ran different cases, so this is an observation, not a controlled result. Replay the weaker " +
        "cohort's cases under the stronger worker before changing routing.",
      metrics: {
        taskClass,
        completionGap: round(gap),
        bestRuns: best.runs,
        worstRuns: worst.runs,
        bestInterventionsPerVerifiedOutcome: best.interventionsPerVerifiedOutcome,
        worstInterventionsPerVerifiedOutcome: worst.interventionsPerVerifiedOutcome,
      },
      benchmarkCaseIds: [...best.benchmarkCaseIds, ...worst.benchmarkCaseIds],
      proposalKind: "routing-policy",
      classification: "bad-routing",
      replay: (findingId) => permitted.length === 0
        ? null
        : replaySpec(
          config,
          findingId,
          `Routing ${taskClass} Work to ${cohortName(best)} raises verified completion without raising interventions per verified outcome.`,
          worst.benchmarkCaseIds,
          permitted,
          candidateControls,
        ),
      replayUnavailableReason: "the cohorts name no worker or model control that differs, so there is nothing to vary",
    }));
  }
  return findings;
}

function quietCriterionFindings(events: readonly HarnessEvent[], runs: readonly BenchmarkRun[], config: ObserverConfig): ObserverFinding[] {
  const stats = new Map<string, { evaluations: number; failures: number; works: Set<string>; eventIds: Set<string>; proven: boolean }>();
  for (const event of events) {
    if (event.type !== "verification.result") continue;
    const proven = new Set(event.payload.falsifiability.provenCriteria);
    for (const result of event.payload.criterionResults) {
      if (result.status === "not-evaluated") continue;
      const entry = stats.get(result.criterionId) ??
        { evaluations: 0, failures: 0, works: new Set<string>(), eventIds: new Set<string>(), proven: false };
      entry.evaluations += 1;
      if (result.status === "fail") entry.failures += 1;
      entry.works.add(event.workId);
      entry.eventIds.add(event.id);
      if (proven.has(result.criterionId)) entry.proven = true;
      stats.set(result.criterionId, entry);
    }
  }
  const findings: ObserverFinding[] = [];
  for (const [criterionId, entry] of [...stats].sort(([a], [b]) => compareText(a, b))) {
    // A criterion with an executed negative control has shown it can fail.
    // Silence from it is a passing system, not an inert check.
    if (entry.failures > 0 || entry.proven) continue;
    if (entry.evaluations < config.minimumQuietCriterionEvaluations || entry.works.size < 2) continue;
    findings.push(finding({
      kind: "quiet-criterion",
      key: [criterionId],
      title: `Verification criterion ${criterionId} has never failed and has no falsifier`,
      summary:
        `${criterionId} passed all ${entry.evaluations} evaluations across ${entry.works.size} Works and no run proved it ` +
        "with a negative control. Either the work never violates it or the check cannot detect a violation. " +
        "Plant the violation in a disposable derivative before trusting it, and do not remove it on this evidence alone.",
      metrics: { criterionId, evaluations: entry.evaluations, works: entry.works.size, failures: 0 },
      ledgerEventIds: entry.eventIds,
      workIds: entry.works,
      benchmarkCaseIds: caseIdsForWorks(runs, entry.works),
      proposalKind: "verifier",
      classification: "verification-gap",
      replay: () => null,
      replayUnavailableReason: "a criterion is tested by a planted negative control, not by replaying Work",
    }));
  }
  return findings;
}

function repeatedContextFindings(events: readonly HarnessEvent[], runs: readonly BenchmarkRun[], config: ObserverConfig): ObserverFinding[] {
  const markers = new Map<string, { works: Set<string>; eventIds: Set<string> }>();
  for (const event of events) {
    if (event.type !== "context.pack-selected") continue;
    for (const marker of new Set(event.payload.markers)) {
      const entry = markers.get(marker) ?? { works: new Set<string>(), eventIds: new Set<string>() };
      entry.works.add(event.workId);
      entry.eventIds.add(event.id);
      markers.set(marker, entry);
    }
  }
  const findings: ObserverFinding[] = [];
  for (const [marker, entry] of [...markers].sort(([a], [b]) => compareText(a, b))) {
    if (entry.works.size < config.minimumRepeatedContextWorks) continue;
    const caseIds = caseIdsForWorks(runs, entry.works);
    findings.push(finding({
      kind: "repeated-context",
      key: [marker],
      title: `Context ${marker} was selected for ${entry.works.size} separate Works`,
      summary:
        `${marker} was assembled into the ContextPack of ${entry.works.size} Works. Context that every Work needs ` +
        "is a candidate for a standing fragment or a Rule, so it stops being rediscovered and paid for per Work.",
      metrics: { marker, works: entry.works.size },
      ledgerEventIds: entry.eventIds,
      workIds: entry.works,
      benchmarkCaseIds: caseIds,
      proposalKind: "context-strategy",
      classification: "strong-context-selection",
      replay: (findingId) => caseIds.length === 0
        ? null
        : replaySpec(
          config,
          findingId,
          `Supplying ${marker} as standing Context keeps verified completion and lowers input tokens.`,
          caseIds,
          ["contextStrategy"],
          { contextStrategy: "" },
        ),
      replayUnavailableReason: "no benchmark run covers the Works that selected this Context",
    }));
  }
  return findings;
}

/** Normalizes a review summary so one correction phrased with different numbers, paths, or code groups together. */
export function normalizeFindingSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/`[^`]*`/g, " code ")
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, " path ")
    .replace(/\d+(?:\.\d+)?/g, " n ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;
type Severity = keyof typeof SEVERITY_RANK;

function recurringReviewFindings(events: readonly HarnessEvent[], runs: readonly BenchmarkRun[], config: ObserverConfig): ObserverFinding[] {
  const groups = new Map<string, { example: string; severity: Severity; works: Set<string>; eventIds: Set<string> }>();
  for (const event of events) {
    if (event.type !== "review.finding" || SEVERITY_RANK[event.payload.severity] < SEVERITY_RANK.medium) continue;
    const key = normalizeFindingSummary(event.payload.summary);
    if (key.length === 0) continue;
    const entry = groups.get(key) ??
      { example: event.payload.summary, severity: event.payload.severity, works: new Set<string>(), eventIds: new Set<string>() };
    if (SEVERITY_RANK[event.payload.severity] > SEVERITY_RANK[entry.severity]) entry.severity = event.payload.severity;
    entry.works.add(event.workId);
    entry.eventIds.add(event.id);
    groups.set(key, entry);
  }
  const findings: ObserverFinding[] = [];
  for (const [key, entry] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    if (entry.works.size < config.minimumRecurringFindingWorks) continue;
    findings.push(finding({
      kind: "recurring-review-finding",
      key: [key],
      title: `The same ${entry.severity} review correction recurred in ${entry.works.size} Works`,
      summary:
        `Review raised "${entry.example.slice(0, 300)}" (or the same finding with different specifics) in ` +
        `${entry.works.size} Works. A correction that recurs is a missing Rule, test, or Guard.`,
      metrics: { severity: entry.severity, works: entry.works.size },
      ledgerEventIds: entry.eventIds,
      workIds: entry.works,
      benchmarkCaseIds: caseIdsForWorks(runs, entry.works),
      proposalKind: "rule",
      classification: "repeated-mistake",
      replay: () => null,
      replayUnavailableReason: "the proposed Rule must exist before its effect can be replayed",
    }));
  }
  return findings;
}

function interventionHotspotFindings(runs: readonly BenchmarkRun[], config: ObserverConfig): ObserverFinding[] {
  const groups = new Map<HumanIntervention["kind"], { runs: Set<number>; cases: Set<string>; count: number }>();
  runs.forEach((run, index) => {
    for (const intervention of run.humanInterventions) {
      if (!intervention.clerical) continue;
      const entry = groups.get(intervention.kind) ?? { runs: new Set<number>(), cases: new Set<string>(), count: 0 };
      entry.runs.add(index);
      entry.cases.add(run.benchmarkCaseId);
      entry.count += 1;
      groups.set(intervention.kind, entry);
    }
  });
  const findings: ObserverFinding[] = [];
  for (const [kind, entry] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    if (entry.runs.size < config.minimumInterventionHotspotRuns) continue;
    findings.push(finding({
      kind: "intervention-hotspot",
      key: [kind],
      title: `Humans performed ${kind} ${entry.count} times across ${entry.runs.size} runs`,
      summary:
        `Clerical ${kind} interventions appeared in ${entry.runs.size} runs. Clerical effort the system could ` +
        "have performed is what the North Star measures; name the mechanism that removes it.",
      metrics: { interventionKind: kind, interventions: entry.count, runs: entry.runs.size },
      benchmarkCaseIds: entry.cases,
      proposalKind: INTERVENTION_PROPOSAL[kind],
      classification: "human-friction",
      replay: () => null,
      replayUnavailableReason: "the mechanism that removes this intervention must exist before it can be replayed",
    }));
  }
  return findings;
}

function capabilityFindings(runs: readonly BenchmarkRun[], config: ObserverConfig): ObserverFinding[] {
  const groups = new Map<string, { verifiedCases: Set<string>; failedCases: Set<string>; runs: number }>();
  for (const run of runs) {
    const digest = run.capabilityExposureDigest;
    if (!digest) continue;
    const entry = groups.get(digest) ?? { verifiedCases: new Set<string>(), failedCases: new Set<string>(), runs: 0 };
    entry.runs += 1;
    (isVerifiedSuccess(run) ? entry.verifiedCases : entry.failedCases).add(run.benchmarkCaseId);
    groups.set(digest, entry);
  }
  const findings: ObserverFinding[] = [];
  for (const [digest, entry] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    if (entry.verifiedCases.size < config.minimumCapabilityVerifiedCases) continue;
    const allCases = sortedUnique([...entry.verifiedCases, ...entry.failedCases]);
    findings.push(finding({
      kind: "capability-candidate",
      key: [digest],
      title: `Capability ${digest.slice(0, 12)} was verified in ${entry.verifiedCases.size} distinct cases`,
      summary:
        `Runs exposed to capability ${digest.slice(0, 12)} were verified in ${entry.verifiedCases.size} of ` +
        `${allCases.length} cases. Reuse alone is not causation: replay the same cases without the exposure ` +
        "before promoting it.",
      metrics: { capabilityExposureDigest: digest, verifiedCases: entry.verifiedCases.size, cases: allCases.length, runs: entry.runs },
      benchmarkCaseIds: allCases,
      proposalKind: "capability",
      classification: "high-value-tool",
      replay: (findingId) => replaySpec(
        config,
        findingId,
        `Exposure to capability ${digest.slice(0, 12)} raises verified completion over the same cases without it.`,
        allCases,
        ["capabilityExposureDigest"],
        { capabilityExposureDigest: digest },
      ),
      replayUnavailableReason: "every capability candidate names its cases, so a replay always exists",
    }));
  }
  return findings;
}

/**
 * Observe a population of Work. Deterministic: the same events and runs, in
 * any order, produce the same observation.
 */
export function observeFactory(input: ObserveInput): FactoryObservation {
  const config = ObserverConfigSchema.parse({ ...DEFAULT_OBSERVER_CONFIG, ...(input.config ?? {}) });
  // An event id names one fact. The same event read twice, from an
  // overlapping Ledger or a backup copy, is one event; two different events
  // claiming one id is corrupt evidence and fails closed.
  const uniqueEvents = new Map<string, HarnessEvent>();
  for (const event of input.events ?? []) {
    const seen = uniqueEvents.get(event.id);
    if (seen === undefined) uniqueEvents.set(event.id, event);
    else if (canonicalJson(seen) !== canonicalJson(event)) {
      throw new Error(`two different Ledger events share id ${event.id}`);
    }
  }
  const duplicateEventsIgnored = (input.events?.length ?? 0) - uniqueEvents.size;
  const events = [...uniqueEvents.values()].sort((a, b) =>
    compareInstants(a.occurredAt, b.occurredAt) || compareText(a.id, b.id));
  // A run is an execution, named by its attempts. The same receipt read twice
  // is one run. Two different receipts claiming one attempt is conflicting
  // evidence and fails closed; otherwise a copied receipt with one field
  // changed would count one execution several times. A run with no attempts
  // never executed and is identified by its full content.
  const uniqueRuns = new Map<string, BenchmarkRun>();
  const runByAttempt = new Map<string, string>();
  for (const run of input.runs ?? []) {
    const identity = benchmarkRunIdentity(run);
    if (uniqueRuns.has(identity)) continue;
    for (const attempt of run.attemptIds) {
      const claimed = runByAttempt.get(attempt);
      if (claimed !== undefined && claimed !== identity) {
        throw new Error(`two different benchmark runs claim attempt ${attempt}`);
      }
    }
    for (const attempt of run.attemptIds) runByAttempt.set(attempt, identity);
    uniqueRuns.set(identity, run);
  }
  const duplicateRunsIgnored = (input.runs?.length ?? 0) - uniqueRuns.size;
  const runs = [...uniqueRuns.values()].sort((a, b) =>
    compareText(a.benchmarkCaseId, b.benchmarkCaseId) ||
    compareText(a.variantId ?? "", b.variantId ?? "") ||
    compareInstants(a.startedAt, b.startedAt) ||
    compareText(a.workId ?? "", b.workId ?? "") ||
    compareText(a.attemptIds.join(","), b.attemptIds.join(",")));

  const taskClasses = taskClassByWork(events);
  const cohorts = cohortsOf(runs, taskClasses);
  const decisionsRequested = new Set<string>();
  const decisionsResolved = new Set<string>();
  for (const event of events) {
    if (event.type === "decision.requested") decisionsRequested.add(JSON.stringify([event.workId, event.payload.decisionId]));
    if (event.type === "decision.resolved") decisionsResolved.add(JSON.stringify([event.workId, event.payload.decisionId]));
  }

  const findings = [
    ...cohortGapFindings(cohorts, config),
    ...interventionHotspotFindings(runs, config),
    ...recurringReviewFindings(events, runs, config),
    ...quietCriterionFindings(events, runs, config),
    ...repeatedContextFindings(events, runs, config),
    ...capabilityFindings(runs, config),
  ];

  return FactoryObservationSchema.parse({
    schema: OBSERVATION_SCHEMA,
    window: {
      firstOccurredAt: events[0]?.occurredAt ?? null,
      lastOccurredAt: events.at(-1)?.occurredAt ?? null,
      eventCount: events.length,
      workCount: new Set([...events.map((event) => event.workId), ...runs.flatMap((run) => (run.workId ? [run.workId] : []))]).size,
      runCount: runs.length,
      duplicateRunsIgnored,
      duplicateEventsIgnored,
    },
    northStar: northStarOf(runs),
    decisions: {
      requested: decisionsRequested.size,
      resolved: [...decisionsResolved].filter((key) => decisionsRequested.has(key)).length,
      unresolved: [...decisionsRequested].filter((key) => !decisionsResolved.has(key)).length,
    },
    cohorts,
    waste: wasteOf(events, runs),
    findings,
    config,
  });
}

/** Plain language for a terminal. The JSON observation is the record. */
export function formatFactoryObservation(observation: FactoryObservation): string {
  const lines: string[] = [];
  const star = observation.northStar;
  lines.push(
    `Observed ${observation.window.workCount} Works, ${observation.window.eventCount} Ledger events, ` +
    `${observation.window.runCount} benchmark runs` +
    (observation.window.duplicateRunsIgnored + observation.window.duplicateEventsIgnored > 0
      ? ` (ignored ${observation.window.duplicateRunsIgnored} duplicate runs and ${observation.window.duplicateEventsIgnored} duplicate events).`
      : "."),
  );
  if (star.runs === 0) {
    lines.push("North Star: no benchmark runs, so interventions per verified outcome cannot be measured.");
  } else {
    const ratio = star.interventionsPerVerifiedOutcome === null
      ? "undefined (nothing verified)"
      : String(star.interventionsPerVerifiedOutcome);
    const floor = star.interventionCoverage === "complete" ? "" : ", so this is a floor";
    lines.push(
      `North Star: ${ratio} human interventions per verified outcome ` +
      `(${star.humanInterventions} interventions, ${star.clericalInterventions} clerical, ` +
      `${star.verifiedOutcomes}/${star.runs} runs verified; coverage ${star.interventionCoverage}${floor}).`,
    );
  }
  for (const cohort of observation.cohorts) {
    const cost = cohort.medianCostUsd === null ? "cost unreported" : `$${cohort.medianCostUsd.toFixed(2)} median cost`;
    const ratio = cohort.interventionsPerVerifiedOutcome === null ? "n/a" : String(cohort.interventionsPerVerifiedOutcome);
    lines.push(
      `  ${cohort.taskClass} / ${cohortName(cohort)}: ${percent(cohort.verifiedCompletionRate)} verified completion, ` +
      `${ratio} interventions/outcome, ${cost} (n=${cohort.runs}).`,
    );
  }
  const waste = observation.waste;
  lines.push(
    `Waste: ${waste.unverifiedRuns} unverified runs (${Math.round(waste.unverifiedElapsedMs / 1000)}s` +
    `${waste.unverifiedCostUsd === null ? "" : `, $${waste.unverifiedCostUsd.toFixed(2)}`}), ` +
    `${waste.failedAttempts} failed and ${waste.blockedAttempts} blocked attempts, ` +
    `${waste.verifiedButUndecidedWorks} verified Works awaiting a Board decision.`,
  );
  if (observation.findings.length === 0) {
    lines.push("No findings crossed their thresholds.");
  } else {
    lines.push(`${observation.findings.length} findings:`);
    for (const item of observation.findings) {
      lines.push(`  [${item.kind}] ${item.title}`);
      lines.push(
        `    -> ${item.proposalKind} proposal` +
        (item.replay ? `; replay ${item.replay.id} ready over ${item.replay.benchmarkCaseIds.length} cases` : `; ${item.replayUnavailableReason}`),
      );
    }
  }
  return lines.join("\n");
}
