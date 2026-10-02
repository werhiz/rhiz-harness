import assert from "node:assert/strict";
import test from "node:test";
import type { BenchmarkRun } from "../src/benchmark.js";
import {
  FactoryObservationSchema,
  formatFactoryObservation,
  normalizeFindingSummary,
  observeFactory,
  type ObserverFinding,
} from "../src/observer.js";
import type { HarnessEvent } from "../src/schemas.js";
import { benchRun, event, verifier } from "./helpers.js";

function intervention(kind: string, index: number) {
  return {
    id: `intervention:${kind}:${index}`,
    occurredAt: "2026-09-01T00:05:00.000Z",
    kind,
    detail: `Human performed ${kind}`,
    clerical: kind !== "judgment-decision",
  };
}

function contextSelected(workId: string, markers: string[], taskClass: "scout" | "ship" | "review" | "default" = "ship") {
  return event("context.pack-selected", {
    packId: `pack:${workId}`,
    digest: `sha256:${workId}`,
    taskClass,
    strategy: "balanced",
    totalTokens: 1200,
    fragmentCount: markers.length,
    markers,
  }, { workId, streamId: `stream:${workId}` });
}

let verificationCounter = 0;
function verification(workId: string, criteria: Record<string, "pass" | "fail">, proven: string[] = []) {
  return event("verification.result", {
    verificationId: `verification:${workId}:${(verificationCounter += 1)}`,
    contractRevision: 1,
    status: Object.values(criteria).includes("fail") ? "fail" : "pass",
    criterionResults: Object.entries(criteria).map(([criterionId, status]) => ({
      criterionId,
      status,
      evidence: status === "pass" ? [{ id: "proof:test", kind: "test", digest: "sha256:abc" }] : [],
    })),
    evidenceSatisfaction: [],
    falsifiability: { provenCriteria: proven, exemptedCriteria: [] },
  }, { workId, streamId: `stream:${workId}`, actor: verifier });
}

function reviewFinding(workId: string, summary: string, severity: "info" | "low" | "medium" | "high" | "critical" = "high") {
  return event("review.finding", { reviewId: `review:${workId}`, severity, summary }, { workId, streamId: `stream:${workId}` });
}

function only(findings: readonly ObserverFinding[], kind: ObserverFinding["kind"]): ObserverFinding[] {
  return findings.filter((finding) => finding.kind === kind);
}

test("North Star is null, not zero or infinity, when nothing was verified", () => {
  const observation = observeFactory({
    runs: [
      benchRun({ verified: false, humanInterventions: [intervention("status-check", 1)] }),
      benchRun({ verified: false, benchmarkCaseId: "case:2" }),
    ],
  });
  assert.equal(observation.northStar.verifiedOutcomes, 0);
  assert.equal(observation.northStar.humanInterventions, 1);
  assert.equal(observation.northStar.interventionsPerVerifiedOutcome, null);
  assert.match(formatFactoryObservation(observation), /undefined \(nothing verified\)/);
});

test("North Star divides every intervention by verified outcomes and states its coverage", () => {
  const observation = observeFactory({
    runs: [
      benchRun({ humanInterventions: [intervention("status-check", 1), intervention("judgment-decision", 2)] }),
      benchRun({ benchmarkCaseId: "case:2", humanInterventions: [intervention("repair", 3)] }),
      benchRun({
        benchmarkCaseId: "case:3",
        verified: false,
        measurementCoverage: { wallClock: "runner-measured", humanInterventions: "runner-observed", usage: "provider-reported" },
      }),
    ],
  });
  assert.equal(observation.northStar.verifiedOutcomes, 2);
  assert.equal(observation.northStar.humanInterventions, 3);
  assert.equal(observation.northStar.clericalInterventions, 2);
  assert.equal(observation.northStar.interventionsPerVerifiedOutcome, 1.5);
  // One run only saw what the runner saw, so the whole measure is a floor.
  assert.equal(observation.northStar.interventionCoverage, "mixed");
  assert.match(formatFactoryObservation(observation), /so this is a floor/);
});

test("judgment decisions are counted apart from clerical effort", () => {
  const observation = observeFactory({
    events: [
      event("decision.requested", { decisionId: "d1", question: "Ship it?", choices: [] }, { workId: "work:a" }),
      event("decision.resolved", { decisionId: "d1", resolution: "yes" }, { workId: "work:a" }),
      event("decision.requested", { decisionId: "d1", question: "Ship it?", choices: [] }, { workId: "work:b" }),
    ],
  });
  assert.deepEqual(observation.decisions, { requested: 2, resolved: 1, unresolved: 1 });
});

function cohortRuns(worker: string, model: string, verifiedCount: number, total: number, prefix: string): BenchmarkRun[] {
  return Array.from({ length: total }, (_, index) => benchRun({
    benchmarkCaseId: `${prefix}:${index}`,
    workId: `${prefix}:work:${index}`,
    workerProviderId: worker,
    model,
    verified: index < verifiedCount,
  }));
}

function shipContext(runs: readonly BenchmarkRun[]): HarnessEvent[] {
  return runs.map((run) => contextSelected(run.workId!, [], "ship"));
}

test("a completion gap between two cohorts on one task class becomes a routing finding with a replay", () => {
  const strong = cohortRuns("worker:codex", "model-a", 3, 3, "strong");
  const weak = cohortRuns("worker:claude", "model-b", 1, 3, "weak");
  const observation = observeFactory({ runs: [...strong, ...weak], events: shipContext([...strong, ...weak]) });

  const shipCohorts = observation.cohorts.filter((cohort) => cohort.taskClass === "ship");
  assert.equal(shipCohorts.length, 2);
  const gaps = only(observation.findings, "cohort-gap");
  assert.equal(gaps.length, 1);
  const gap = gaps[0]!;
  assert.equal(gap.proposalKind, "routing-policy");
  assert.equal(gap.classification, "bad-routing");
  assert.ok(gap.replay);
  // The replay runs the weak cohort's own cases under the strong worker.
  assert.deepEqual(gap.replay.benchmarkCaseIds, weak.map((run) => run.benchmarkCaseId).sort());
  assert.deepEqual(gap.replay.permittedDifferences, ["workerProviderId", "model"]);
  assert.deepEqual(gap.replay.candidateControls, { workerProviderId: "worker:codex", model: "model-a" });
});

test("a cohort below the minimum sample is never compared", () => {
  const strong = cohortRuns("worker:codex", "model-a", 3, 3, "strong");
  const weak = cohortRuns("worker:claude", "model-b", 0, 2, "weak");
  const observation = observeFactory({ runs: [...strong, ...weak], events: shipContext([...strong, ...weak]) });
  assert.equal(only(observation.findings, "cohort-gap").length, 0);
});

test("a gap just under the threshold is not a finding", () => {
  const a = cohortRuns("worker:codex", "model-a", 5, 5, "a");
  const b = cohortRuns("worker:claude", "model-b", 4, 5, "b");
  const observation = observeFactory({
    runs: [...a, ...b],
    events: shipContext([...a, ...b]),
    config: { minimumCompletionGap: 0.21 },
  });
  assert.equal(only(observation.findings, "cohort-gap").length, 0);
});

test("cohorts on different task classes are never compared with each other", () => {
  const strong = cohortRuns("worker:codex", "model-a", 3, 3, "strong");
  const weak = cohortRuns("worker:claude", "model-b", 0, 3, "weak");
  const observation = observeFactory({
    runs: [...strong, ...weak],
    events: [...shipContext(strong), ...weak.map((run) => contextSelected(run.workId!, [], "review"))],
  });
  assert.equal(only(observation.findings, "cohort-gap").length, 0);
});

test("a Work selected under two task classes is not silently assigned either", () => {
  const run = benchRun({ workId: "work:ambiguous" });
  const observation = observeFactory({
    runs: [run],
    events: [contextSelected("work:ambiguous", [], "ship"), contextSelected("work:ambiguous", [], "review")],
  });
  assert.equal(observation.cohorts[0]!.taskClass, "unclassified");
});

test("a criterion that never failed and has no falsifier is reported, not proposed for deletion", () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    verification(`work:${index % 3}`, { "criterion:lint": "pass" }));
  const observation = observeFactory({ events });
  const quiet = only(observation.findings, "quiet-criterion");
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0]!.proposalKind, "verifier");
  assert.match(quiet[0]!.summary, /do not remove it on this evidence alone/);
  assert.equal(quiet[0]!.replay, null);
  assert.equal(quiet[0]!.evidence.ledgerEventIds.length, 5);
});

test("a criterion proven by a negative control is never called quiet", () => {
  const events = Array.from({ length: 6 }, (_, index) =>
    verification(`work:${index % 3}`, { "criterion:lint": "pass" }, index === 0 ? ["criterion:lint"] : []));
  assert.equal(only(observeFactory({ events }).findings, "quiet-criterion").length, 0);
});

test("a criterion that has failed once is not quiet", () => {
  const events = [
    ...Array.from({ length: 6 }, (_, index) => verification(`work:${index % 3}`, { "criterion:lint": "pass" })),
    verification("work:9", { "criterion:lint": "fail" }),
  ];
  assert.equal(only(observeFactory({ events }).findings, "quiet-criterion").length, 0);
});

test("a criterion evaluated in only one Work is not quiet however often it ran", () => {
  const events = Array.from({ length: 8 }, () => verification("work:only", { "criterion:lint": "pass" }));
  assert.equal(only(observeFactory({ events }).findings, "quiet-criterion").length, 0);
});

test("Context selected across Works becomes a context-strategy finding, replayable only when runs cover it", () => {
  const events = ["work:a", "work:b", "work:c"].map((workId) => contextSelected(workId, ["docs/ARCHITECTURE.md", `src/${workId}.ts`]));
  const withoutRuns = only(observeFactory({ events }).findings, "repeated-context");
  assert.equal(withoutRuns.length, 1);
  assert.equal(withoutRuns[0]!.metrics.marker, "docs/ARCHITECTURE.md");
  assert.equal(withoutRuns[0]!.replay, null);
  assert.match(withoutRuns[0]!.replayUnavailableReason!, /no benchmark run/);

  const runs = ["work:a", "work:b"].map((workId, index) => benchRun({ workId, benchmarkCaseId: `case:${index}` }));
  const withRuns = only(observeFactory({ events, runs }).findings, "repeated-context");
  assert.deepEqual(withRuns[0]!.replay!.benchmarkCaseIds, ["case:0", "case:1"]);
  assert.deepEqual(withRuns[0]!.replay!.permittedDifferences, ["contextStrategy"]);
});

test("Context selected in fewer Works than the threshold is not repeated", () => {
  const events = ["work:a", "work:b"].map((workId) => contextSelected(workId, ["docs/ARCHITECTURE.md"]));
  assert.equal(only(observeFactory({ events }).findings, "repeated-context").length, 0);
});

test("the same review correction with different specifics groups across Works", () => {
  assert.equal(
    normalizeFindingSummary("Missing test for `parseWork` in src/a/b.ts line 42"),
    normalizeFindingSummary("Missing test for `projectBoard` in src/c/d.ts line 7"),
  );
  const events = [
    reviewFinding("work:a", "Missing test for `parseWork` in src/a/b.ts line 42"),
    reviewFinding("work:b", "Missing test for `projectBoard` in src/c/d.ts line 7", "critical"),
  ];
  const recurring = only(observeFactory({ events }).findings, "recurring-review-finding");
  assert.equal(recurring.length, 1);
  assert.equal(recurring[0]!.proposalKind, "rule");
  assert.equal(recurring[0]!.classification, "repeated-mistake");
  assert.equal(recurring[0]!.metrics.severity, "critical");
});

test("low-severity and single-Work review findings do not recur", () => {
  const lowSeverity = [
    reviewFinding("work:a", "Prefer const", "low"),
    reviewFinding("work:b", "Prefer const", "low"),
  ];
  const singleWork = [
    reviewFinding("work:a", "Missing guard"),
    reviewFinding("work:a", "Missing guard"),
  ];
  assert.equal(only(observeFactory({ events: lowSeverity }).findings, "recurring-review-finding").length, 0);
  assert.equal(only(observeFactory({ events: singleWork }).findings, "recurring-review-finding").length, 0);
});

test("clerical interventions repeated across runs name the mechanism that would remove them", () => {
  const runs = [
    benchRun({ humanInterventions: [intervention("status-check", 1), intervention("status-check", 2)] }),
    benchRun({ benchmarkCaseId: "case:2", humanInterventions: [intervention("status-check", 3)] }),
    benchRun({ benchmarkCaseId: "case:3", humanInterventions: [intervention("judgment-decision", 4)] }),
  ];
  const hotspots = only(observeFactory({ runs }).findings, "intervention-hotspot");
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0]!.metrics.interventions, 3);
  assert.equal(hotspots[0]!.metrics.runs, 2);
  assert.equal(hotspots[0]!.proposalKind, "recovery-behavior");
  assert.equal(hotspots[0]!.classification, "human-friction");
});

test("judgment decisions are never reported as clerical hotspots", () => {
  const runs = [1, 2, 3].map((index) =>
    benchRun({ benchmarkCaseId: `case:${index}`, humanInterventions: [intervention("judgment-decision", index)] }));
  assert.equal(only(observeFactory({ runs }).findings, "intervention-hotspot").length, 0);
});

test("a capability verified across enough distinct cases becomes a candidate whose replay removes it", () => {
  const digest = "c".repeat(64);
  const runs = [1, 2, 3, 4].map((index) => benchRun({
    benchmarkCaseId: `case:${index}`,
    capabilityExposureDigest: digest,
    verified: index !== 4,
  }));
  const candidates = only(observeFactory({ runs }).findings, "capability-candidate");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.metrics.verifiedCases, 3);
  assert.equal(candidates[0]!.metrics.cases, 4);
  assert.deepEqual(candidates[0]!.replay!.permittedDifferences, ["capabilityExposureDigest"]);
  assert.match(candidates[0]!.summary, /Reuse alone is not causation/);
});

test("repeat verification of one case does not count as reuse", () => {
  const digest = "c".repeat(64);
  const runs = [1, 2, 3].map(() => benchRun({ benchmarkCaseId: "case:same", capabilityExposureDigest: digest }));
  assert.equal(only(observeFactory({ runs }).findings, "capability-candidate").length, 0);
});

test("waste counts unverified spend, failed and blocked attempts, and verified Work left undecided", () => {
  const observation = observeFactory({
    runs: [
      benchRun({ verified: false, usage: { costUsd: 2.5 } }),
      benchRun({ benchmarkCaseId: "case:2", verified: false, measurementCoverage: { wallClock: "runner-measured", humanInterventions: "complete", usage: "unavailable" }, usage: undefined }),
      benchRun({ benchmarkCaseId: "case:3" }),
    ],
    events: [
      event("attempt.failed", { reason: "crashed", recoverable: true }, { taskId: "task:1", attemptId: "attempt:1" }),
      event("attempt.blocked", { reason: "waiting" }, { taskId: "task:1", attemptId: "attempt:2" }),
      verification("work:done", { "criterion:tests": "pass" }),
      verification("work:decided", { "criterion:tests": "pass" }),
      event("work.accepted", { reason: "verified", contractRevision: 1 }, { workId: "work:decided" }),
    ],
  });
  assert.equal(observation.waste.unverifiedRuns, 2);
  assert.equal(observation.waste.unverifiedElapsedMs, 20 * 60 * 1000);
  assert.equal(observation.waste.unverifiedCostUsd, 2.5);
  assert.equal(observation.waste.unverifiedCostReportedRuns, 1);
  assert.equal(observation.waste.failedAttempts, 1);
  assert.equal(observation.waste.blockedAttempts, 1);
  assert.equal(observation.waste.verifiedButUndecidedWorks, 1);
});

test("the observation is deterministic over input order and validates against its schema", () => {
  const strong = cohortRuns("worker:codex", "model-a", 3, 3, "strong");
  const weak = cohortRuns("worker:claude", "model-b", 0, 3, "weak");
  const events: HarnessEvent[] = [
    ...shipContext([...strong, ...weak]),
    ...["work:a", "work:b", "work:c"].map((workId) => contextSelected(workId, ["docs/ARCHITECTURE.md"])),
    reviewFinding("work:a", "Missing guard"),
    reviewFinding("work:b", "Missing guard"),
  ];
  const runs = [...strong, ...weak];
  const forward = observeFactory({ events, runs });
  const reversed = observeFactory({ events: [...events].reverse(), runs: [...runs].reverse() });
  assert.deepEqual(reversed, forward);
  assert.doesNotThrow(() => FactoryObservationSchema.parse(forward));
  assert.ok(forward.findings.length >= 3);
  assert.equal(new Set(forward.findings.map((finding) => finding.id)).size, forward.findings.length);
});

test("an empty population is an observation with nothing in it, not an error", () => {
  const observation = observeFactory({});
  assert.equal(observation.window.workCount, 0);
  assert.equal(observation.northStar.interventionCoverage, "none");
  assert.deepEqual(observation.findings, []);
  assert.match(formatFactoryObservation(observation), /no benchmark runs/);
});

test("the same run supplied twice is counted once and reported as a duplicate", () => {
  const runs = [benchRun(), benchRun({ benchmarkCaseId: "case:2", verified: false })];
  const observation = observeFactory({ runs: [...runs, ...runs] });
  assert.equal(observation.northStar.runs, 2);
  assert.equal(observation.window.runCount, 2);
  assert.equal(observation.window.duplicateRunsIgnored, 2);
});

test("the same Ledger event read twice is one event", () => {
  const events = ["w1", "w2", "w3"].map((workId) => verification(workId, { "criterion:x": "pass" }));
  const once = observeFactory({ events, config: { minimumQuietCriterionEvaluations: 5 } });
  const twice = observeFactory({ events: [...events, ...events], config: { minimumQuietCriterionEvaluations: 5 } });
  assert.equal(once.findings.length, 0);
  assert.equal(twice.findings.length, 0);
  assert.equal(twice.window.eventCount, 3);
  assert.equal(twice.window.duplicateEventsIgnored, 3);
});

test("two different events that share an id fail closed", () => {
  const original = event("attempt.failed", { reason: "crashed", recoverable: true }, { id: "event:same", taskId: "t", attemptId: "a" });
  const forged = event("attempt.failed", { reason: "different", recoverable: true }, { id: "event:same", taskId: "t", attemptId: "a" });
  assert.throws(() => observeFactory({ events: [original, forged] }), /share id event:same/);
});

test("a verified run that ended failed, interrupted, or rejected is not a verified outcome", () => {
  const observation = observeFactory({
    runs: [
      benchRun({ outcome: "failed", verified: true, attemptIds: ["a1"] }),
      benchRun({ benchmarkCaseId: "case:2", outcome: "rejected", verified: true, attemptIds: ["a2"] }),
      benchRun({ benchmarkCaseId: "case:3", attemptIds: ["a3"] }),
    ],
  });
  assert.equal(observation.northStar.verifiedOutcomes, 1);
  assert.equal(observation.waste.unverifiedRuns, 2);
});

test("one execution copied with a field changed fails closed instead of counting twice", () => {
  const solo = benchRun({ attemptIds: ["solo"] });
  const copy = benchRun({ attemptIds: ["solo"], endedAt: "2026-09-01T00:11:00.000Z" });
  assert.throws(() => observeFactory({ runs: [solo, copy] }), /claim attempt solo/);
  assert.equal(observeFactory({ runs: [solo, solo] }).window.duplicateRunsIgnored, 1);
});

test("the observation is identical under every locale", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
    import { observeFactory } from "./dist/src/observer.js";
    import { benchRun } from "./dist/test/helpers.js";
    const runs = [];
    for (const [worker, verified] of [["worker:åa", true], ["worker:ab", true], ["worker:zz", false]]) {
      for (let i = 0; i < 3; i += 1) runs.push(benchRun({ benchmarkCaseId: worker + ":" + i, workId: worker + ":w" + i, workerProviderId: worker, verified }));
    }
    process.stdout.write(JSON.stringify(observeFactory({ runs })));
  `;
  const outputs = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: locale, LANG: locale },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
  const finding = JSON.parse(outputs[0]!).findings.find((item: { kind: string }) => item.kind === "cohort-gap");
  assert.match(finding.title, /^worker:ab /);
});

test("the observation window is chronological across timestamp offsets", () => {
  const early = event("attempt.failed", { reason: "a", recoverable: true }, { taskId: "t", attemptId: "a", occurredAt: "2026-01-01T10:00:00+05:00" });
  const late = event("attempt.failed", { reason: "b", recoverable: true }, { taskId: "t", attemptId: "b", occurredAt: "2026-01-01T06:00:00Z" });
  const observation = observeFactory({ events: [late, early] });
  assert.equal(observation.window.firstOccurredAt, "2026-01-01T10:00:00+05:00");
  assert.equal(observation.window.lastOccurredAt, "2026-01-01T06:00:00Z");
});

test("a Work whose latest verification failed is not counted as verified and awaiting a decision", () => {
  const pass = verification("work:1", { "criterion:tests": "pass" });
  const fail = verification("work:1", { "criterion:tests": "fail" });
  const events = [
    { ...pass, occurredAt: "2026-01-01T00:00:00.000Z" },
    { ...fail, occurredAt: "2026-01-02T00:00:00.000Z" },
  ];
  assert.equal(observeFactory({ events }).waste.verifiedButUndecidedWorks, 0);
});

test("an intervention floor never picks the cohort a routing finding recommends", () => {
  const observed = { wallClock: "runner-measured", humanInterventions: "runner-observed", usage: "provider-reported" };
  const cohort = (worker: string, verified: boolean, extra: Record<string, unknown>) =>
    [0, 1, 2].map((i) => benchRun({ benchmarkCaseId: `${worker}:${i}`, workId: `${worker}:w${i}`, workerProviderId: worker, model: `m-${worker}`, verified, ...extra }));
  const runs = [
    ...cohort("worker:a", true, { measurementCoverage: observed }),
    ...cohort("worker:b", true, { humanInterventions: [intervention("status-check", 1)] }),
    ...cohort("worker:c", false, {}),
  ];
  const gap = observeFactory({ runs }).findings.find((finding) => finding.kind === "cohort-gap");
  assert.ok(gap);
  // With the floor ignored, the tie between a and b falls to name order.
  assert.match(gap.title, /^worker:a /);
  const reversed = observeFactory({
    runs: [
      ...cohort("worker:b", true, { measurementCoverage: observed }),
      ...cohort("worker:a", true, { humanInterventions: [intervention("status-check", 1)] }),
      ...cohort("worker:c", false, {}),
    ],
  }).findings.find((finding) => finding.kind === "cohort-gap");
  // A floor of zero for b must not beat a's complete count of one.
  assert.match(reversed!.title, /^worker:a /);
});
