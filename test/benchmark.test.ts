import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  benchmarkExposureContext,
  BenchmarkRunSchema,
  clericalInterventionCount,
  compareBenchmarkRuns,
  createRepositoryBenchmarkRun,
  repositoryRunContext,
} from "../src/benchmark.js";
import { composeContextPack, parseContextCompositionOptions } from "../src/context.js";
import { work } from "./helpers.js";

const REPOSITORY_CONTROLS = {
  taskIdentity: `sha256:${"a".repeat(64)}`,
  capabilityExposureDigest: null,
  preparationIdentity: null,
  harnessVersion: "0.0.1-kernel.0",
  model: "codex-test-model",
  effortLevel: "medium",
  contextStrategy: "minimal",
  verificationPolicyId: "verify:test",
} as const;

function run(overrides: Record<string, unknown> = {}) {
  return {
    benchmarkCaseId: "bench:1",
    taskIdentity: `sha256:${"a".repeat(64)}`,
    capabilityExposureDigest: null,
    preparationIdentity: null,
    harnessMode: "rhiz-harness",
    harnessVersion: "0.0.1-kernel.0",
    workId: "work:1",
    attemptIds: ["attempt:1"],
    baseIdentity: "git:base",
    resultIdentity: "git:result",
    hostId: "host:fake",
    workerProviderId: "worker:a",
    model: "fake-model",
    effortLevel: "medium",
    contextStrategy: "minimal",
    verificationPolicyId: "verify:1",
    startedAt: "2026-08-20T05:00:00.000Z",
    endedAt: "2026-08-20T05:01:00.000Z",
    measurementCoverage: {wallClock: "runner-measured", humanInterventions: "complete", usage: overrides.usage === undefined ? "unavailable" : "provider-reported"},
    humanInterventions: [
      {
        id: "intervention:1",
        occurredAt: "2026-08-20T05:00:30.000Z",
        kind: "status-check",
        detail: "Human checked status manually",
        clerical: true,
      },
      {
        id: "intervention:2",
        occurredAt: "2026-08-20T05:00:45.000Z",
        kind: "judgment-decision",
        detail: "Human chose product direction",
        clerical: false,
      },
    ],
    outcome: "accepted",
    verified: true,
    repairRequired: false,
    evidenceRefs: ["evidence:1"],
    ...overrides,
  };
}

test("benchmark usage coverage rejects contradictory telemetry", () => {
  const coverage = { wallClock: "runner-measured" as const, humanInterventions: "complete" as const };
  assert.equal(BenchmarkRunSchema.safeParse(run({
    measurementCoverage: { ...coverage, usage: "unavailable" },
    usage: { inputTokens: 10 },
  })).success, false);
  assert.equal(BenchmarkRunSchema.safeParse(run({
    measurementCoverage: { ...coverage, usage: "provider-reported" },
    usage: undefined,
  })).success, false);
  assert.equal(BenchmarkRunSchema.safeParse(run({
    measurementCoverage: { ...coverage, usage: "provider-reported" },
    usage: {},
  })).success, false);
});

test("benchmark instrumentation separates clerical intervention from judgment", () => {
  const parsed = BenchmarkRunSchema.parse(run());
  assert.equal(clericalInterventionCount(parsed), 1);
});

test("accepted benchmark outcomes require independent verification", () => {
  assert.equal(BenchmarkRunSchema.safeParse(run({ verified: false })).success, false);
});

test("benchmark time cannot run backwards", () => {
  assert.equal(BenchmarkRunSchema.safeParse(run({ endedAt: "2026-08-20T04:59:00.000Z" })).success, false);
});


test("repository benchmark run records measurement coverage honestly", () => {
  const parsed = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:repo-1",
    workId: "work:repo-1",
    attemptIds: ["attempt:1"],
    baseIdentity: "git:base",
    resultIdentity: "git:result",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T05:00:00.000Z",
    endedAt: "2026-09-23T05:01:00.000Z",
    outcome: "verified",
    verified: true,
    repairRequired: false,
    evidenceRefs: ["event:verification"],
  });
  assert.deepEqual(parsed.measurementCoverage, {
    wallClock: "runner-measured",
    humanInterventions: "runner-observed",
    usage: "unavailable",
  });
  assert.equal(parsed.usage, undefined);
});

test("repository benchmark run marks provider usage only when observed", () => {
  const parsed = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:repo-2",
    workId: "work:repo-2",
    attemptIds: ["attempt:1", "attempt:2"],
    attemptRuntimeControls: [
      { attemptId: "attempt:1", workerProviderId: "worker:codex", model: "codex-test-model", effortLevel: "medium" },
      { attemptId: "attempt:2", workerProviderId: "worker:codex", model: "codex-test-model", effortLevel: "medium" },
    ],
    baseIdentity: "git:base",
    resultIdentity: "git:result",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T05:00:00.000Z",
    endedAt: "2026-09-23T05:02:00.000Z",
    outcome: "verified",
    verified: true,
    repairRequired: true,
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
    evidenceRefs: ["event:verification"],
  });
  assert.equal(parsed.measurementCoverage?.usage, "provider-reported");
  assert.equal(parsed.usage?.costUsd, 0.01);
});


test("benchmark comparison preserves full evidence references", () => {
  const baselineRef = `event:${"a".repeat(194)}`;
  const candidateRef = `event:${"b".repeat(194)}`;
  const comparison = compareBenchmarkRuns(
    BenchmarkRunSchema.parse(run({ variantId: "baseline", evidenceRefs: [baselineRef] })),
    BenchmarkRunSchema.parse(run({ variantId: "candidate", evidenceRefs: [candidateRef] })),
  );
  assert.deepEqual(comparison.evidenceRefs, [`baseline:${baselineRef}`, `candidate:${candidateRef}`]);
});

test("benchmark comparison requires same case and base with distinct variants", () => {
  const baseline = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:same",
    variantId: "baseline",
    workId: "work:baseline",
    attemptIds: ["attempt:1", "attempt:2"],
    attemptRuntimeControls: [
      { attemptId: "attempt:1", workerProviderId: "worker:codex", model: "codex-test-model", effortLevel: "medium" },
      { attemptId: "attempt:2", workerProviderId: "worker:codex", model: "codex-test-model", effortLevel: "medium" },
    ],
    baseIdentity: "git:base",
    resultIdentity: "git:baseline",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T05:00:00.000Z",
    endedAt: "2026-09-23T05:02:00.000Z",
    outcome: "verified",
    verified: true,
    repairRequired: true,
    humanInterventions: [
      {
        id: "intervention:baseline",
        occurredAt: "2026-09-23T05:01:00.000Z",
        kind: "status-check",
        detail: "checked progress",
        clerical: true,
      },
    ],
    usage: { inputTokens: 100, outputTokens: 30, reasoningTokens: 40, costUsd: 0.02 },
    evidenceRefs: ["event:baseline"],
  });
  const candidate = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:same",
    variantId: "candidate",
    workId: "work:candidate",
    attemptIds: ["attempt:1"],
    baseIdentity: "git:base",
    resultIdentity: "git:candidate",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T06:00:00.000Z",
    endedAt: "2026-09-23T06:01:00.000Z",
    outcome: "verified",
    verified: true,
    repairRequired: false,
    usage: { inputTokens: 80, outputTokens: 20, reasoningTokens: 25, costUsd: 0.01 },
    evidenceRefs: ["event:candidate"],
  });

  const comparison = compareBenchmarkRuns(baseline, candidate);
  assert.equal(comparison.metrics.elapsedMs.delta, -60000);
  assert.equal(comparison.metrics.attemptCount.delta, -1);
  assert.equal(comparison.metrics.humanInterventionCount, undefined);
  assert.equal(comparison.metrics.costUsd?.delta, -0.01);
  assert.equal(comparison.metrics.inputTokens?.delta, -20);
  assert.equal(comparison.metrics.reasoningTokens?.delta, -15);
});

test("comparison rejects mixed or missing runtime controls across repairs", () => {
  const baseline = BenchmarkRunSchema.parse(run({
    variantId: "baseline",
    attemptIds: ["attempt:1", "attempt:2"],
    attemptRuntimeControls: [
      { attemptId: "attempt:1", workerProviderId: "worker:a", model: "other-model", effortLevel: "medium" },
      { attemptId: "attempt:2", workerProviderId: "worker:a", model: "fake-model", effortLevel: "medium" },
    ],
  }));
  const candidate = BenchmarkRunSchema.parse(run({ variantId: "candidate" }));
  assert.throws(() => compareBenchmarkRuns(baseline, candidate), /consistent observed runtime controls/);
  const missing = BenchmarkRunSchema.parse(run({
    variantId: "baseline",
    attemptIds: ["attempt:1", "attempt:2"],
  }));
  assert.throws(() => compareBenchmarkRuns(missing, candidate), /consistent observed runtime controls/);
  const consistent = BenchmarkRunSchema.parse(run({
    variantId: "baseline",
    attemptIds: ["attempt:1", "attempt:2"],
    attemptRuntimeControls: [
      { attemptId: "attempt:1", workerProviderId: "worker:a", model: "fake-model", effortLevel: "medium" },
      { attemptId: "attempt:2", workerProviderId: "worker:a", model: "fake-model", effortLevel: "medium" },
    ],
  }));
  assert.equal(compareBenchmarkRuns(consistent, candidate).metrics.attemptCount.delta, -1);
});

test("permitted model variation still requires observed model values", () => {
  const baseline = BenchmarkRunSchema.parse(run({ variantId: "baseline", model: undefined }));
  const candidate = BenchmarkRunSchema.parse(run({ variantId: "candidate", model: undefined }));
  assert.throws(
    () => compareBenchmarkRuns(baseline, candidate, { permittedDifferences: ["model"] }),
    /unknown: model/,
  );
});

test("preparation identity is a controlled and observed comparison dimension", () => {
  const baseline = BenchmarkRunSchema.parse(run({ variantId: "baseline", preparationIdentity: null }));
  const digest = `sha256:${"b".repeat(64)}`;
  const candidate = BenchmarkRunSchema.parse(run({ variantId: "candidate", preparationIdentity: digest }));
  assert.throws(() => compareBenchmarkRuns(baseline, candidate), /uncontrolled differences: preparationIdentity/);
  const varied = compareBenchmarkRuns(baseline, candidate, { permittedDifferences: ["preparationIdentity"] });
  assert.deepEqual(varied.controlDifferences, [{ field: "preparationIdentity", baseline: null, candidate: digest }]);
  const unknown = BenchmarkRunSchema.parse(run({ variantId: "candidate", preparationIdentity: undefined }));
  assert.throws(() => compareBenchmarkRuns(baseline, unknown), /observed preparationIdentity/);
});

test("verified outcomes require exact result identity", () => {
  assert.equal(BenchmarkRunSchema.safeParse(run({ resultIdentity: undefined })).success, false);
});

test("benchmark comparison refuses an unknown exposure even beside an explicit baseline", () => {
  const baseline = BenchmarkRunSchema.parse(run({ variantId: "baseline", capabilityExposureDigest: null }));
  const unknown = BenchmarkRunSchema.parse(run({ variantId: "candidate", capabilityExposureDigest: undefined }));
  assert.throws(() => compareBenchmarkRuns(baseline, unknown), /observed capabilityExposureDigest/);
});

test("benchmark comparison requires the same exact task identity", () => {
  const baseline = BenchmarkRunSchema.parse(run({ variantId: "baseline" }));
  const changedTask = BenchmarkRunSchema.parse(run({ variantId: "candidate", taskIdentity: `sha256:${"b".repeat(64)}` }));
  const unknownTask = BenchmarkRunSchema.parse(run({ variantId: "candidate", taskIdentity: undefined }));
  assert.throws(() => compareBenchmarkRuns(baseline, changedTask), /same taskIdentity/);
  assert.throws(() => compareBenchmarkRuns(baseline, unknownTask), /observed taskIdentity/);
});

test("benchmark comparison refuses different bases", () => {
  const base = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:same",
    variantId: "baseline",
    workId: "work:1",
    attemptIds: ["attempt:1"],
    baseIdentity: "git:one",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T05:00:00.000Z",
    endedAt: "2026-09-23T05:01:00.000Z",
    outcome: "rejected",
    verified: false,
    repairRequired: false,
    evidenceRefs: ["event:one"],
  });
  const other = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:same",
    variantId: "candidate",
    workId: "work:2",
    attemptIds: ["attempt:2"],
    baseIdentity: "git:two",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T06:00:00.000Z",
    endedAt: "2026-09-23T06:01:00.000Z",
    outcome: "rejected",
    verified: false,
    repairRequired: false,
    evidenceRefs: ["event:two"],
  });
  assert.throws(() => compareBenchmarkRuns(base, other), /same baseIdentity/);
});


test("failed benchmark runs may record zero attempts and no provider", () => {
  const parsed = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:pre-worker-failure",
    workId: "work:pre-worker-failure",
    attemptIds: [],
    baseIdentity: "git:base",
    hostId: "host:codex-app-server",
    startedAt: "2026-09-23T05:00:00.000Z",
    endedAt: "2026-09-23T05:00:01.000Z",
    outcome: "failed",
    verified: false,
    repairRequired: false,
    evidenceRefs: [],
  });
  assert.equal(parsed.attemptIds.length, 0);
  assert.equal(parsed.workerProviderId, undefined);
});

test("verified outcome remains distinct from organizational acceptance", () => {
  const parsed = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:verified",
    workId: "work:verified",
    attemptIds: ["attempt:1"],
    baseIdentity: "git:base",
    resultIdentity: "git:candidate",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T05:00:00.000Z",
    endedAt: "2026-09-23T05:01:00.000Z",
    outcome: "verified",
    verified: true,
    repairRequired: false,
    evidenceRefs: ["event:verify"],
  });
  assert.equal(parsed.outcome, "verified");
});

test("benchmark comparison refuses changed worker or measurement controls", () => {
  const baseline = BenchmarkRunSchema.parse(run({
    benchmarkCaseId: "bench:controls",
    variantId: "baseline",
    baseIdentity: "git:same",
    workerProviderId: "worker:a",
    measurementCoverage: {
      wallClock: "runner-measured",
      humanInterventions: "runner-observed",
      usage: "unavailable",
    },
  }));
  const candidate = BenchmarkRunSchema.parse(run({
    benchmarkCaseId: "bench:controls",
    variantId: "candidate",
    baseIdentity: "git:same",
    workerProviderId: "worker:b",
    measurementCoverage: {
      wallClock: "runner-measured",
      humanInterventions: "runner-observed",
      usage: "unavailable",
    },
  }));
  assert.throws(
    () => compareBenchmarkRuns(baseline, candidate),
    /uncontrolled differences: workerProviderId/,
  );
});

test("benchmark comparison refuses changed measurement collection", () => {
  const baseline = BenchmarkRunSchema.parse(run({
    benchmarkCaseId: "bench:coverage",
    variantId: "baseline",
    baseIdentity: "git:same",
    measurementCoverage: {
      wallClock: "runner-measured",
      humanInterventions: "runner-observed",
      usage: "unavailable",
    },
  }));
  const candidate = BenchmarkRunSchema.parse(run({
    benchmarkCaseId: "bench:coverage",
    variantId: "candidate",
    baseIdentity: "git:same",
    measurementCoverage: {
      wallClock: "runner-measured",
      humanInterventions: "complete",
      usage: "unavailable",
    },
  }));
  assert.throws(
    () => compareBenchmarkRuns(baseline, candidate),
    /uncontrolled differences: measurementCoverage/,
  );
});


test("benchmark comparison records intentionally varied harness dimensions", () => {
  const baseline = BenchmarkRunSchema.parse(
    run({
      benchmarkCaseId: "bench:harness-effect",
      variantId: "agent-alone",
      baseIdentity: "git:same",
      harnessMode: "agent-alone",
      harnessVersion: undefined,
    }),
  );
  const candidate = BenchmarkRunSchema.parse(
    run({
      benchmarkCaseId: "bench:harness-effect",
      variantId: "rhiz-harness",
      baseIdentity: "git:same",
      harnessMode: "rhiz-harness",
      harnessVersion: "0.0.1-kernel.0",
    }),
  );

  const comparison = compareBenchmarkRuns(baseline, candidate, {
    permittedDifferences: ["harnessMode", "harnessVersion"],
  });
  assert.deepEqual(
    comparison.controlDifferences.map((difference) => difference.field),
    ["harnessMode", "harnessVersion"],
  );
});

test("benchmark comparison refuses unknown controlled dimensions", () => {
  const baseline = BenchmarkRunSchema.parse(
    run({
      benchmarkCaseId: "bench:unknown-control",
      variantId: "baseline",
      baseIdentity: "git:same",
      model: undefined,
    }),
  );
  const candidate = BenchmarkRunSchema.parse(
    run({
      benchmarkCaseId: "bench:unknown-control",
      variantId: "candidate",
      baseIdentity: "git:same",
      model: undefined,
    }),
  );
  assert.throws(
    () => compareBenchmarkRuns(baseline, candidate),
    /unknown: model/,
  );
});

test("comparison preserves a failed baseline with no evidence refs", () => {
  const baseline = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:recovery",
    variantId: "baseline",
    workId: "work:recovery",
    attemptIds: [],
    baseIdentity: "git:same",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T05:00:00.000Z",
    endedAt: "2026-09-23T05:00:01.000Z",
    outcome: "failed",
    verified: false,
    repairRequired: false,
    evidenceRefs: [],
  });
  const candidate = createRepositoryBenchmarkRun({
    ...REPOSITORY_CONTROLS,
    benchmarkCaseId: "bench:recovery",
    variantId: "candidate",
    workId: "work:recovery",
    attemptIds: ["attempt:1"],
    baseIdentity: "git:same",
    resultIdentity: "git:candidate",
    hostId: "host:codex-app-server",
    workerProviderId: "worker:codex",
    startedAt: "2026-09-23T06:00:00.000Z",
    endedAt: "2026-09-23T06:01:00.000Z",
    outcome: "verified",
    verified: true,
    repairRequired: false,
    evidenceRefs: ["event:verify"],
  });
  const comparison = compareBenchmarkRuns(baseline, candidate);
  assert.deepEqual(comparison.evidenceRefs, ["candidate:event:verify"]);
  assert.equal(comparison.metrics.verified.baseline, false);
  assert.equal(comparison.metrics.verified.candidate, true);
});


test("incomplete intervention capture cannot manufacture zero measurements", () => {
  const coverage = {wallClock: "runner-measured", humanInterventions: "runner-observed", usage: "unavailable"};
  const baseline = BenchmarkRunSchema.parse(run({variantId: "baseline", measurementCoverage: coverage, humanInterventions: []}));
  const candidate = BenchmarkRunSchema.parse(run({variantId: "candidate", measurementCoverage: coverage, humanInterventions: []}));
  const comparison = compareBenchmarkRuns(baseline, candidate);
  assert.equal(comparison.metrics.humanInterventionCount, undefined);
  assert.equal(comparison.metrics.clericalInterventionCount, undefined);
  assert.equal(comparison.metrics.costUsd, undefined);
});

test("complete intervention capture can truthfully report zero", () => {
  const coverage = {wallClock: "runner-measured", humanInterventions: "complete", usage: "unavailable"};
  const baseline = BenchmarkRunSchema.parse(run({variantId: "baseline", measurementCoverage: coverage, humanInterventions: []}));
  const candidate = BenchmarkRunSchema.parse(run({variantId: "candidate", measurementCoverage: coverage, humanInterventions: []}));
  assert.equal(compareBenchmarkRuns(baseline, candidate).metrics.humanInterventionCount?.delta, 0);
});


test("refuses exposure content that ContextPack would truncate", () => {
  const content = "x".repeat(32_001);
  const digest = createHash("sha256").update(content).digest("hex");
  assert.throws(() => benchmarkExposureContext(content, digest), /per-file hard cap/);
});

test("reusable exposure binds content into the existing context resource and rejects tampering", () => {
  const content = "Calibrate before processing assay samples.";
  const digest = createHash("sha256").update(content).digest("hex");
  const exposure = benchmarkExposureContext(content, digest);
  assert.equal(exposure.content, content);
  assert.equal(exposure.resource.uri, `repo://benchmark/${exposure.path}`);
  assert.throws(() => benchmarkExposureContext(content + "tampered", digest), /digest mismatch/);
  const coverage = {wallClock: "runner-measured", humanInterventions: "complete", usage: "unavailable"};
  const baseline = BenchmarkRunSchema.parse(run({variantId: "baseline", capabilityExposureDigest: null, measurementCoverage: coverage}));
  const treatment = BenchmarkRunSchema.parse(run({variantId: "treatment", capabilityExposureDigest: digest, measurementCoverage: coverage}));
  assert.throws(() => compareBenchmarkRuns(baseline, treatment), /uncontrolled differences: capabilityExposureDigest/);
  const comparison = compareBenchmarkRuns(baseline, treatment, {permittedDifferences: ["capabilityExposureDigest"]});
  assert.deepEqual(comparison.controlDifferences, [{field: "capabilityExposureDigest", baseline: null, candidate: digest}]);
});

function includedFiles(strategyWork: ReturnType<typeof work>, exposure: { content: string; sha256: string } | null) {
  const runContext = repositoryRunContext({
    work: strategyWork,
    files: { "apps/task.ts": "export const task = 1;" },
    exposure,
  });
  const pack = composeContextPack(
    { ...strategyWork, context: { ...strategyWork.context, resources: runContext.resources } },
    "task:1",
    "attempt:1",
    parseContextCompositionOptions({ fileContents: runContext.files }),
    runContext.config,
    () => new Date("2026-09-23T00:00:00.000Z"),
  );
  return {
    runContext,
    paths: pack.fragments.flatMap((fragment) => (fragment.kind === "included-file" ? [fragment.path] : [])),
  };
}

test("capability exposure is added beside the task's own context, never in place of it", () => {
  const content = "Governed submission acknowledgement: capture once, record delivery, retry only what failed.";
  const digest = createHash("sha256").update(content).digest("hex");
  const explicitWork = work({ context: { strategy: "explicit", resources: [], includeHistory: true } });

  const baseline = includedFiles(explicitWork, null);
  const treatment = includedFiles(explicitWork, { content, sha256: digest });

  assert.deepEqual(baseline.paths, ["apps/task.ts"]);
  assert.deepEqual(treatment.paths.filter((path) => !path.startsWith("~benchmark_exposure__/")), baseline.paths);
  assert.equal(treatment.paths.length, baseline.paths.length + 1);
  assert.equal(baseline.runContext.contextStrategy, "explicit");
  assert.equal(treatment.runContext.config.strategy, "explicit");
  assert.equal(explicitWork.context.resources.length, 0, "the Work contract is not mutated");
});

test("capability exposure preserves declared file markers in baseline and treatment", () => {
  const content = "A reviewed capability.";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const strategyWork = work({ context: { strategy: "explicit", resources: [], includeHistory: true } });
  const files = { "apps/task.ts": "task", "src/worker.ts": "worker" };
  const buildPack = (exposure: { content: string; sha256: string } | null) => {
    const runContext = repositoryRunContext({ work: strategyWork, files, exposure });
    return composeContextPack(
      { ...strategyWork, context: { ...strategyWork.context, resources: runContext.resources } },
      "task:1",
      "attempt:1",
      parseContextCompositionOptions({ fileContents: runContext.files }),
      runContext.config,
      () => new Date("2026-09-23T00:00:00.000Z"),
    );
  };
  const baseline = buildPack(null);
  const treatment = buildPack({ content, sha256 });
  const declared = (pack: typeof baseline) => pack.fragments.flatMap((fragment) =>
    fragment.kind === "included-file" && !fragment.path.startsWith("~benchmark_exposure__/")
      ? [{ path: fragment.path, marker: fragment.marker, content: fragment.content }]
      : [],
  );
  assert.deepEqual(declared(treatment), declared(baseline));
  assert.equal(treatment.fragments.length, baseline.fragments.length + 1);
  assert.throws(
    () => repositoryRunContext({
      work: strategyWork,
      files: { "~benchmark_exposure__/later.txt": "would reorder the treatment" },
      exposure: { content, sha256 },
    }),
    /exposure path must sort after every declared context file/,
  );
});

test("refuses capability exposure under a strategy that could drop declared context", () => {
  const content = "exposure";
  const digest = createHash("sha256").update(content).digest("hex");
  for (const strategy of ["minimal", "balanced"] as const) {
    assert.throws(
      () => includedFiles(work({ context: { strategy, resources: [], includeHistory: true } }), { content, sha256: digest }),
      /capability exposure requires a context strategy that keeps every declared file/,
    );
  }
});

test("records the Work contract's context strategy, not the kernel default", () => {
  const { runContext } = includedFiles(work({ context: { strategy: "broad", resources: [], includeHistory: true } }), null);
  assert.equal(runContext.contextStrategy, "broad");
  assert.equal(runContext.config.strategy, "broad");
});
