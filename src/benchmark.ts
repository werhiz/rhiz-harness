import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_CONTEXT_CONFIG,
  type ContextConfig,
  type ContextStrategy,
} from "./context.js";
import { ObservedUsageSchema, TimestampSchema, type ObservedUsage, type WorkContract } from "./schemas.js";

const id = z.string().trim().min(1).max(200);
const identity = z.string().trim().min(1).max(500);

export const HumanInterventionSchema = z.object({
  id,
  occurredAt: TimestampSchema,
  kind: z.enum([
    "follow-up-prompt",
    "status-check",
    "context-refeed",
    "manual-routing",
    "manual-verification",
    "manual-recovery",
    "repair",
    "clerical",
    "judgment-decision",
    "other",
  ]),
  detail: z.string().trim().min(1).max(2000),
  clerical: z.boolean(),
}).strict();
export type HumanIntervention = z.infer<typeof HumanInterventionSchema>;

export const BenchmarkRunSchema = z.object({
  benchmarkCaseId: id,
  taskIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  preparationIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),
  harnessMode: z.enum(["agent-alone", "reference-harness", "rhiz-harness"]),
  harnessVersion: z.string().trim().min(1).max(200).optional(),
  variantId: id.optional(),
  capabilityExposureDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  workId: id.optional(),
  attemptIds: z.array(id),
  attemptRuntimeControls: z.array(z.object({
    attemptId: id,
    workerProviderId: id.optional(),
    model: z.string().trim().min(1).max(300).optional(),
    effortLevel: z.string().trim().min(1).max(100).optional(),
  }).strict()).optional(),
  baseIdentity: identity.optional(),
  resultIdentity: identity.optional(),
  hostId: id.optional(),
  workerProviderId: id.optional(),
  model: z.string().trim().min(1).max(300).optional(),
  effortLevel: z.string().trim().min(1).max(100).optional(),
  contextStrategy: z.string().trim().min(1).max(300).optional(),
  verificationPolicyId: z.string().trim().min(1).max(300).optional(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  humanInterventions: z.array(HumanInterventionSchema),
  outcome: z.enum(["verified", "accepted", "rejected", "cancelled", "failed", "interrupted"]),
  verified: z.boolean(),
  repairRequired: z.boolean(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }).strict().optional(),
  measurementCoverage: z.object({
    wallClock: z.enum(["runner-measured", "external"]),
    humanInterventions: z.enum(["complete", "runner-observed"]),
    usage: z.enum(["provider-reported", "unavailable"]),
  }).strict().optional(),
  evidenceRefs: z.array(id),
}).strict().superRefine((value, ctx) => {
  const started = Date.parse(value.startedAt);
  const ended = Date.parse(value.endedAt);
  if (ended < started) {
    ctx.addIssue({ code: "custom", path: ["endedAt"], message: "benchmark run cannot end before it starts" });
  }
  if (value.measurementCoverage?.usage === "unavailable" && value.usage !== undefined) {
    ctx.addIssue({ code: "custom", path: ["usage"], message: "unavailable usage cannot contain reported values" });
  }
  if (value.measurementCoverage?.usage === "provider-reported" &&
      (!value.usage || Object.keys(value.usage).length === 0)) {
    ctx.addIssue({ code: "custom", path: ["usage"], message: "provider-reported usage requires at least one reported value" });
  }
  if ((value.outcome === "verified" || value.outcome === "accepted") && !value.verified) {
    ctx.addIssue({
      code: "custom",
      path: ["verified"],
      message: `${value.outcome} benchmark outcome must be independently verified`,
    });
  }
  if ((value.outcome === "verified" || value.outcome === "accepted") && value.attemptIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["attemptIds"],
      message: `${value.outcome} benchmark outcome requires at least one execution attempt`,
    });
  }
  if (
    (value.outcome === "verified" || value.outcome === "accepted") &&
    (!value.workId || !value.baseIdentity || !value.resultIdentity || !value.hostId || !value.workerProviderId)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome"],
      message:
        "verified/accepted benchmark outcomes require resolved Work, base, result, host, and worker identities",
    });
  }
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

export function clericalInterventionCount(run: BenchmarkRun): number {
  return run.humanInterventions.filter((intervention) => intervention.clerical).length;
}

export function parseBenchmarkRun(input: unknown): BenchmarkRun {
  return BenchmarkRunSchema.parse(input);
}

/** A run total exists only for directions every included attempt reported. */
export function aggregateAttemptUsage(
  attemptIds: readonly string[],
  reports: ReadonlyMap<string, ObservedUsage | undefined>,
): RepositoryBenchmarkRunInput["usage"] {
  if (new Set(attemptIds).size !== attemptIds.length) throw new Error("duplicate usage attempt identity");
  if (attemptIds.length === 0) return undefined;
  const values = attemptIds.map((id) => {
    const value = reports.get(id);
    return value === undefined ? undefined : ObservedUsageSchema.parse(value);
  });
  const usage: NonNullable<RepositoryBenchmarkRunInput["usage"]> = {};
  for (const field of ["inputTokens", "outputTokens", "costUsd"] as const) {
    if (values.some((value) => value === undefined || value.complete === false || value[field] === undefined)) continue;
    const total = values.reduce((sum, value) => sum + value![field]!, 0);
    if (field === "costUsd" ? Number.isFinite(total) : Number.isSafeInteger(total)) usage[field] = total;
  }
  return Object.keys(usage).length ? usage : undefined;
}


export interface RepositoryBenchmarkRunInput {
  benchmarkCaseId: string;
  taskIdentity?: string;
  preparationIdentity?: string | null;
  variantId?: string;
  capabilityExposureDigest?: string | null;
  workId?: string;
  attemptIds: string[];
  attemptRuntimeControls?: Array<{
    attemptId: string;
    workerProviderId?: string;
    model?: string;
    effortLevel?: string;
  }>;
  baseIdentity?: string;
  resultIdentity?: string;
  hostId?: string;
  workerProviderId?: string;
  harnessVersion?: string;
  model?: string;
  effortLevel?: string;
  contextStrategy?: string;
  verificationPolicyId?: string;
  startedAt: string;
  endedAt: string;
  humanInterventions?: HumanIntervention[];
  outcome: "verified" | "accepted" | "rejected" | "cancelled" | "failed" | "interrupted";
  verified: boolean;
  repairRequired: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    costUsd?: number;
  };
  evidenceRefs: string[];
}

export function createRepositoryBenchmarkRun(
  input: RepositoryBenchmarkRunInput,
): BenchmarkRun {
  return BenchmarkRunSchema.parse({
    benchmarkCaseId: input.benchmarkCaseId,
    taskIdentity: input.taskIdentity,
    preparationIdentity: input.preparationIdentity,
    harnessMode: "rhiz-harness",
    harnessVersion: input.harnessVersion,
    variantId: input.variantId,
    capabilityExposureDigest: input.capabilityExposureDigest,
    workId: input.workId,
    attemptIds: input.attemptIds,
    attemptRuntimeControls: input.attemptRuntimeControls,
    baseIdentity: input.baseIdentity,
    resultIdentity: input.resultIdentity,
    hostId: input.hostId,
    workerProviderId: input.workerProviderId,
    model: input.model,
    effortLevel: input.effortLevel,
    contextStrategy: input.contextStrategy,
    verificationPolicyId: input.verificationPolicyId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    humanInterventions: input.humanInterventions ?? [],
    outcome: input.outcome,
    verified: input.verified,
    repairRequired: input.repairRequired,
    usage: input.usage,
    measurementCoverage: {
      wallClock: "runner-measured",
      humanInterventions: "runner-observed",
      usage: input.usage ? "provider-reported" : "unavailable",
    },
    evidenceRefs: input.evidenceRefs,
  });
}


export const BENCHMARK_CONTROL_DIMENSIONS = [
  "capabilityExposureDigest",
  "preparationIdentity",
  "harnessMode",
  "harnessVersion",
  "hostId",
  "workerProviderId",
  "model",
  "effortLevel",
  "contextStrategy",
  "verificationPolicyId",
  "measurementCoverage",
] as const;
export type BenchmarkControlDimension =
  (typeof BENCHMARK_CONTROL_DIMENSIONS)[number];

export interface BenchmarkComparisonOptions {
  permittedDifferences?: readonly BenchmarkControlDimension[];
}

export const BenchmarkComparisonSchema = z.object({
  schema: z.literal("rhiz-harness-benchmark-comparison/v1"),
  benchmarkCaseId: id,
  taskIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  baseIdentity: identity,
  baselineVariantId: id,
  candidateVariantId: id,
  baselineResultIdentity: identity.optional(),
  candidateResultIdentity: identity.optional(),
  comparable: z.literal(true),
  controlDifferences: z.array(
    z.object({
      field: z.enum(BENCHMARK_CONTROL_DIMENSIONS),
      baseline: z.string().nullable(),
      candidate: z.string().nullable(),
    }).strict(),
  ),
  metrics: z.object({
    elapsedMs: z.object({
      baseline: z.number().nonnegative(),
      candidate: z.number().nonnegative(),
      delta: z.number(),
    }).strict(),
    attemptCount: z.object({
      baseline: z.number().int().nonnegative(),
      candidate: z.number().int().nonnegative(),
      delta: z.number().int(),
    }).strict(),
    humanInterventionCount: z.object({
      baseline: z.number().int().nonnegative(),
      candidate: z.number().int().nonnegative(),
      delta: z.number().int(),
    }).strict().optional(),
    clericalInterventionCount: z.object({
      baseline: z.number().int().nonnegative(),
      candidate: z.number().int().nonnegative(),
      delta: z.number().int(),
    }).strict().optional(),
    verified: z.object({
      baseline: z.boolean(),
      candidate: z.boolean(),
    }).strict(),
    repairRequired: z.object({
      baseline: z.boolean(),
      candidate: z.boolean(),
    }).strict(),
    costUsd: z.object({
      baseline: z.number().nonnegative(),
      candidate: z.number().nonnegative(),
      delta: z.number(),
    }).strict().optional(),
    inputTokens: z.object({
      baseline: z.number().int().nonnegative(),
      candidate: z.number().int().nonnegative(),
      delta: z.number().int(),
    }).strict().optional(),
    outputTokens: z.object({
      baseline: z.number().int().nonnegative(),
      candidate: z.number().int().nonnegative(),
      delta: z.number().int(),
    }).strict().optional(),
    reasoningTokens: z.object({
      baseline: z.number().int().nonnegative(),
      candidate: z.number().int().nonnegative(),
      delta: z.number().int(),
    }).strict().optional(),
  }).strict(),
  evidenceRefs: z.array(z.string().trim().min(1).max(210)),
}).strict();
export type BenchmarkComparison = z.infer<typeof BenchmarkComparisonSchema>;

function elapsedMs(run: BenchmarkRun): number {
  return Date.parse(run.endedAt) - Date.parse(run.startedAt);
}

function pairedNumber(
  baseline: number | undefined,
  candidate: number | undefined,
): { baseline: number; candidate: number; delta: number } | undefined {
  if (baseline === undefined || candidate === undefined) return undefined;
  return { baseline, candidate, delta: candidate - baseline };
}

export function compareBenchmarkRuns(
  baseline: BenchmarkRun,
  candidate: BenchmarkRun,
  options: BenchmarkComparisonOptions = {},
): BenchmarkComparison {
  if (baseline.benchmarkCaseId !== candidate.benchmarkCaseId) {
    throw new Error("benchmark comparison requires the same benchmarkCaseId");
  }
  if (!baseline.baseIdentity || !candidate.baseIdentity) {
    throw new Error("benchmark comparison requires resolved baseIdentity on both runs");
  }
  if (baseline.baseIdentity !== candidate.baseIdentity) {
    throw new Error("benchmark comparison requires the same baseIdentity");
  }
  if (!baseline.taskIdentity || !candidate.taskIdentity) {
    throw new Error("benchmark comparison requires observed taskIdentity on both runs");
  }
  if (baseline.taskIdentity !== candidate.taskIdentity) {
    throw new Error("benchmark comparison requires the same taskIdentity");
  }
  if (!baseline.variantId || !candidate.variantId) {
    throw new Error("benchmark comparison requires explicit variantId on both runs");
  }
  if (baseline.variantId === candidate.variantId) {
    throw new Error("benchmark comparison requires distinct variants");
  }

  if (baseline.preparationIdentity === undefined || candidate.preparationIdentity === undefined) {
    throw new Error("benchmark comparison requires observed preparationIdentity on both runs");
  }
  if (baseline.capabilityExposureDigest === undefined || candidate.capabilityExposureDigest === undefined) {
    throw new Error("benchmark comparison requires observed capabilityExposureDigest on both runs");
  }

  for (const run of [baseline, candidate]) {
    const observed = run.attemptRuntimeControls;
    // Legacy single-attempt receipts can use the run-level controls. Once
    // per-attempt observations exist, they must agree at every attempt count.
    if (observed === undefined && run.attemptIds.length <= 1) continue;
    if (!observed || observed.length !== run.attemptIds.length ||
      new Set(run.attemptIds).size !== run.attemptIds.length ||
      new Set(observed.map((attempt) => attempt.attemptId)).size !== run.attemptIds.length ||
      run.attemptIds.some((attemptId) => !observed.some((attempt) => attempt.attemptId === attemptId)) ||
      observed.some((attempt) =>
        !attempt.workerProviderId || !attempt.model || !attempt.effortLevel ||
        attempt.workerProviderId !== run.workerProviderId ||
        attempt.model !== run.model ||
        attempt.effortLevel !== run.effortLevel
      )) {
      throw new Error("benchmark comparison requires consistent observed runtime controls for every attempt");
    }
  }

  const controlValue = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  };
  const controls: Array<
    [BenchmarkControlDimension, string | null, string | null]
  > = [
    ["capabilityExposureDigest", baseline.capabilityExposureDigest, candidate.capabilityExposureDigest],
    ["preparationIdentity", baseline.preparationIdentity, candidate.preparationIdentity],
    ["harnessMode", baseline.harnessMode, candidate.harnessMode],
    [
      "harnessVersion",
      baseline.harnessVersion ?? null,
      candidate.harnessVersion ?? null,
    ],
    ["hostId", baseline.hostId ?? null, candidate.hostId ?? null],
    [
      "workerProviderId",
      baseline.workerProviderId ?? null,
      candidate.workerProviderId ?? null,
    ],
    ["model", baseline.model ?? null, candidate.model ?? null],
    [
      "effortLevel",
      baseline.effortLevel ?? null,
      candidate.effortLevel ?? null,
    ],
    [
      "contextStrategy",
      baseline.contextStrategy ?? null,
      candidate.contextStrategy ?? null,
    ],
    [
      "verificationPolicyId",
      baseline.verificationPolicyId ?? null,
      candidate.verificationPolicyId ?? null,
    ],
    [
      "measurementCoverage",
      controlValue(baseline.measurementCoverage),
      controlValue(candidate.measurementCoverage),
    ],
  ];
  const knownControlDimensions = new Set<string>(
    BENCHMARK_CONTROL_DIMENSIONS,
  );
  const requestedDifferences = options.permittedDifferences ?? [];
  const invalidDifferences = requestedDifferences.filter(
    (field) => !knownControlDimensions.has(field),
  );
  if (invalidDifferences.length > 0) {
    throw new Error(
      `benchmark comparison names unknown experimental dimensions: ${invalidDifferences.join(", ")}`,
    );
  }
  const permitted = new Set(requestedDifferences);
  const requiredKnown = controls.filter(
    ([field]) => field !== "harnessMode" && field !== "capabilityExposureDigest" && field !== "preparationIdentity" &&
      !(field === "harnessVersion" && permitted.has(field) &&
        (baseline.harnessMode === "agent-alone" || candidate.harnessMode === "agent-alone")),
  );
  const unknown = requiredKnown
    .filter(([, left, right]) => left === null || right === null)
    .map(([field]) => field);
  if (unknown.length > 0) {
    throw new Error(
      `benchmark comparison requires observed controlled dimensions; unknown: ${unknown.join(", ")}`,
    );
  }

  const differences = controls
    .filter(([, left, right]) => left !== right)
    .map(([field, left, right]) => ({
      field,
      baseline: left,
      candidate: right,
    }));
  const forbidden = differences
    .filter((difference) => !permitted.has(difference.field))
    .map((difference) => difference.field);
  if (forbidden.length > 0) {
    throw new Error(
      `benchmark comparison has uncontrolled differences: ${forbidden.join(", ")}`,
    );
  }

  return BenchmarkComparisonSchema.parse({
    schema: "rhiz-harness-benchmark-comparison/v1",
    benchmarkCaseId: baseline.benchmarkCaseId,
    taskIdentity: baseline.taskIdentity,
    baseIdentity: baseline.baseIdentity,
    baselineVariantId: baseline.variantId,
    candidateVariantId: candidate.variantId,
    baselineResultIdentity: baseline.resultIdentity,
    candidateResultIdentity: candidate.resultIdentity,
    comparable: true,
    controlDifferences: differences,
    metrics: {
      elapsedMs: {
        baseline: elapsedMs(baseline),
        candidate: elapsedMs(candidate),
        delta: elapsedMs(candidate) - elapsedMs(baseline),
      },
      attemptCount: {
        baseline: baseline.attemptIds.length,
        candidate: candidate.attemptIds.length,
        delta: candidate.attemptIds.length - baseline.attemptIds.length,
      },
      humanInterventionCount: baseline.measurementCoverage?.humanInterventions === "complete" && candidate.measurementCoverage?.humanInterventions === "complete" ? {
        baseline: baseline.humanInterventions.length,
        candidate: candidate.humanInterventions.length,
        delta: candidate.humanInterventions.length - baseline.humanInterventions.length,
      } : undefined,
      clericalInterventionCount: baseline.measurementCoverage?.humanInterventions === "complete" && candidate.measurementCoverage?.humanInterventions === "complete" ? {
        baseline: clericalInterventionCount(baseline),
        candidate: clericalInterventionCount(candidate),
        delta:
          clericalInterventionCount(candidate) -
          clericalInterventionCount(baseline),
      } : undefined,
      verified: {
        baseline: baseline.verified,
        candidate: candidate.verified,
      },
      repairRequired: {
        baseline: baseline.repairRequired,
        candidate: candidate.repairRequired,
      },
      costUsd: pairedNumber(baseline.usage?.costUsd, candidate.usage?.costUsd),
      inputTokens: pairedNumber(
        baseline.usage?.inputTokens,
        candidate.usage?.inputTokens,
      ),
      outputTokens: pairedNumber(
        baseline.usage?.outputTokens,
        candidate.usage?.outputTokens,
      ),
      reasoningTokens: pairedNumber(
        baseline.usage?.reasoningTokens,
        candidate.usage?.reasoningTokens,
      ),
    },
    evidenceRefs: [
      ...baseline.evidenceRefs.map((ref) => `baseline:${ref}`),
      ...candidate.evidenceRefs.map((ref) => `candidate:${ref}`),
    ],
  });
}


/** Verified reusable content enters the existing Context source, never authority. */
export function benchmarkExposureContext(content: string, sha256: string): {
  path: string; content: string; resource: {uri: string; kind: "file"};
} {
  if (content.length > DEFAULT_CONTEXT_CONFIG.perFileHardCap * 4) {
    throw new Error("benchmark exposure exceeds ContextPack per-file hard cap");
  }
  if (!content.trim() || !/^[a-f0-9]{64}$/.test(sha256) || createHash("sha256").update(content).digest("hex") !== sha256) {
    throw new Error("benchmark exposure content digest mismatch");
  }
  const path = `~benchmark_exposure__/${sha256}.txt`;
  return {path, content, resource: {uri: `repo://benchmark/${path}`, kind: "file"}};
}

/**
 * Strategies that include every declared context file. Any other strategy
 * selects a prefix of the sorted file list, so an injected exposure file can
 * displace the task's own context and make the arms differ by more than the
 * exposure itself.
 */
const EXPOSURE_SAFE_STRATEGIES: readonly ContextStrategy[] = ["broad", "explicit"];

export interface RepositoryRunContext {
  files: Record<string, string>;
  resources: WorkContract["context"]["resources"];
  config: ContextConfig;
  /** The strategy the run actually used, recorded on the BenchmarkRun. */
  contextStrategy: ContextStrategy;
}

/**
 * Decide the context a repository run composes from. The Work contract's
 * declared strategy is authoritative; the kernel default is not silently
 * substituted. When a capability exposure is present, the only permitted
 * difference between arms is that one file, so the strategy must keep every
 * declared file.
 */
export function repositoryRunContext(input: {
  work: WorkContract;
  files: Readonly<Record<string, string>>;
  exposure: { content: string; sha256: string } | null;
}): RepositoryRunContext {
  const contextStrategy = input.work.context.strategy;
  const files: Record<string, string> = { ...input.files };
  const resources = [...input.work.context.resources];
  if (input.exposure !== null) {
    if (!EXPOSURE_SAFE_STRATEGIES.includes(contextStrategy)) {
      throw new Error(
        `capability exposure requires a context strategy that keeps every declared file (${EXPOSURE_SAFE_STRATEGIES.join(" or ")}); ${contextStrategy} can drop the task's own context in favour of the exposure`,
      );
    }
    const exposure = benchmarkExposureContext(input.exposure.content, input.exposure.sha256);
    // Context assigns file markers after sorting paths. Keep every original
    // path before the exposure so its marker and rendered prompt stay stable.
    if (Object.keys(files).some((path) => path >= exposure.path)) {
      throw new Error("capability exposure path must sort after every declared context file");
    }
    files[exposure.path] = exposure.content;
    resources.push(exposure.resource);
  }
  return {
    files,
    resources,
    config: { ...DEFAULT_CONTEXT_CONFIG, strategy: contextStrategy },
    contextStrategy,
  };
}
