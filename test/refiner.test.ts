import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptProposal,
  analyzeClosedWork,
  analyzeClosedWorkFromEvents,
  assertRefinerProposal,
  buildAcceptedEvent,
  buildPromotedEvent,
  buildProposedEvent,
  buildRejectedEvent,
  computeLedgerSpanMs,
  DEFAULT_REFINER_CONFIG,
  FAILURE_TAXONOMY,
  findProposalInLedger,
  isFailureClassification,
  isSuccessClassification,
  listAllowedKinds,
  makeRefinerProposal,
  parseRefinerAnalysis,
  parseRefinerConfig,
  parseRefinerProposal,
  parseRefinerProposalReview,
  promoteProposal,
  recordProposal,
  RefinerAnalysisSchema,
  RefinerClassificationSchema,
  RefinerConfigSchema,
  RefinerConfigurationError,
  RefinerError,
  RefinerGuard,
  RefinerGuardViolationError,
  RefinerLifecycleError,
  RefinerProposalReviewSchema,
  rejectProposal,
  runProposalGuards,
  streamIdForWork,
  SUCCESS_TAXONOMY,
  type FailureTaxonomy,
  type SuccessTaxonomy,
} from "../src/refiner.js";
import {
  RefinerDraftSchema,
  RefinerProposalSchema,
} from "../src/schemas.js";
import {
  InMemoryEventLedger,
  type EventLedger,
} from "../src/ledger.js";
import { event, human, worker, work } from "./helpers.js";

const TEST_NOW = "2026-08-20T05:00:00.000Z";

function evidence(ledgerEventId: string, reasoning = "because"): { ledgerEventId: string; reasoning: string } {
  return { ledgerEventId, reasoning };
}

function draft(overrides: Partial<{
  summary: string;
  rationale: string;
  reversibleUntil: string;
  draftPayload: Record<string, unknown>;
}> = {}) {
  const base: { summary: string; rationale: string; reversibleUntil: string; draftPayload: Record<string, unknown> } = {
    summary: "Add a regression test that pins the missing context failure mode.",
    rationale: "Three close events in the last 30 days were tagged missing-context. The same fix would have prevented all three.",
    reversibleUntil: "2026-12-31T00:00:00.000Z",
    draftPayload: {},
  };
  return { ...base, ...overrides };
}

function proposalInput(overrides: Partial<{
  id: string;
  workId: string;
  kind: "rule" | "guard-tuning" | "test" | "verifier" | "context-strategy" | "routing-policy" | "worker-profile" | "tool" | "capability" | "documentation" | "benchmark" | "adr" | "recovery-behavior" | "lesson-fixture";
  classification: FailureTaxonomy | SuccessTaxonomy;
  draftPayload: Record<string, unknown>;
  draftOverride: { summary: string; rationale: string; reversibleUntil: string; draftPayload: Record<string, unknown> };
  evidenceCount: number;
}> = {}) {
  const evidenceRefs: { ledgerEventId: string; reasoning: string }[] = [];
  const count = overrides.evidenceCount ?? 2;
  for (let i = 0; i < count; i += 1) {
    evidenceRefs.push(evidence(`event:${i + 1}`));
  }
  const result: {
    id: string;
    workId: string;
    kind: "rule" | "guard-tuning" | "test" | "verifier" | "context-strategy" | "routing-policy" | "worker-profile" | "tool" | "capability" | "documentation" | "benchmark" | "adr" | "recovery-behavior" | "lesson-fixture";
    title: string;
    summary: string;
    reasoning: string;
    classification: FailureTaxonomy | SuccessTaxonomy;
    evidenceRefs: { ledgerEventId: string; reasoning: string }[];
    draft: { summary: string; rationale: string; reversibleUntil: string; draftPayload: Record<string, unknown> };
    proposedBy: typeof human;
    proposedAt: string;
  } = {
    id: overrides.id ?? "proposal:1",
    workId: overrides.workId ?? "work:1",
    kind: overrides.kind ?? "test",
    title: "Regression test for missing-context failures",
    summary: "Pin failures so the same regression never recurs.",
    reasoning: "Three similar failures were observed; a regression test is the strongest preventive surface.",
    classification: overrides.classification ?? "missing-context",
    evidenceRefs,
    draft: overrides.draftOverride ?? draft({ draftPayload: overrides.draftPayload ?? {} }),
    proposedBy: human,
    proposedAt: TEST_NOW,
  };
  return result;
}

function failureTaxonomySorted(): string {
  return [...FAILURE_TAXONOMY].sort().join(",");
}

function successTaxonomySorted(): string {
  return [...SUCCESS_TAXONOMY].sort().join(",");
}

test("FAILURE_TAXONOMY has 19 entries and is exposed as a readonly tuple", () => {
  assert.equal(FAILURE_TAXONOMY.length, 19);
  assert.equal(failureTaxonomySorted(), [
    "architecture-confusion",
    "authority-error",
    "bad-routing",
    "concurrency-conflict",
    "coordination-error",
    "dependency-failure",
    "environment-drift",
    "false-verification",
    "human-friction",
    "implementation-error",
    "missing-context",
    "process-stall",
    "recovery-failure",
    "repeated-mistake",
    "runtime-failure",
    "too-much-context",
    "verification-gap",
    "worker-capability",
    "wrong-understanding",
  ].join(","));
});

test("SUCCESS_TAXONOMY has 12 entries and is exposed as a readonly tuple", () => {
  assert.equal(SUCCESS_TAXONOMY.length, 12);
  assert.equal(successTaxonomySorted(), [
    "cheap-model-success",
    "effective-guard",
    "effective-rule",
    "excellent-review",
    "fast-verification",
    "high-quality-first-attempt",
    "high-value-tool",
    "low-context-success",
    "strong-context-selection",
    "successful-recovery",
    "useful-parallelization",
    "zero-human-intervention",
  ].join(","));
});

test("isFailureClassification and isSuccessClassification are type guards", () => {
  assert.equal(isFailureClassification("missing-context"), true);
  assert.equal(isFailureClassification("cheap-model-success"), false);
  assert.equal(isSuccessClassification("cheap-model-success"), true);
  assert.equal(isSuccessClassification("missing-context"), false);
  assert.equal(isFailureClassification("nope"), false);
  assert.equal(isSuccessClassification("nope"), false);
});

test("RefinerClassificationSchema accepts taxonomy entries and rejects others", () => {
  RefinerClassificationSchema.parse("missing-context");
  RefinerClassificationSchema.parse("cheap-model-success");
  assert.throws(() => RefinerClassificationSchema.parse("untagged-outcome"));
});

test("RefinerProposalSchema requires at least one evidence ref", () => {
  const input = proposalInput({ evidenceCount: 0 });
  assert.throws(() => RefinerProposalSchema.parse(input));
});

test("RefinerProposalSchema rejects unknown kind", () => {
  const input = { ...proposalInput(), kind: "unknown-kind" };
  assert.throws(() => RefinerProposalSchema.parse(input));
});

test("RefinerDraftSchema rejects unparsable reversibleUntil", () => {
  assert.throws(() => RefinerDraftSchema.parse({
    summary: "x",
    rationale: "y",
    reversibleUntil: "not-a-date",
    draftPayload: {},
  }));
});

test("RefinerConfigSchema exposes the §22 toggles with default-on", () => {
  const config = RefinerConfigSchema.parse({});
  assert.equal(config.forbidConstitutionAmendments, true);
  assert.equal(config.forbidAuthorityWeakening, true);
  assert.equal(config.forbidRoutingOptimization, true);
  assert.equal(config.forbidBenchmarkAcceptanceWeakening, true);
  assert.equal(config.forbidWorkerSelfCertification, true);
  assert.equal(config.requireReversibleUntil, true);
  assert.equal(config.minEvidenceCount, 2);
});

test("DEFAULT_REFINER_CONFIG is frozen and matches the §22 default", () => {
  assert.equal(DEFAULT_REFINER_CONFIG.forbidConstitutionAmendments, true);
  assert.equal(DEFAULT_REFINER_CONFIG.requireReversibleUntil, true);
  assert.throws(() => {
    (DEFAULT_REFINER_CONFIG as { minEvidenceCount: number }).minEvidenceCount = 0;
  });
});

test("listAllowedKinds returns the 14 kinds from the Compound Engineering Plan", () => {
  const allowed = listAllowedKinds();
  assert.equal(allowed.length, 14);
  assert.ok(allowed.includes("rule"));
  assert.ok(allowed.includes("guard-tuning"));
  assert.ok(allowed.includes("lesson-fixture"));
});

test("runProposalGuards rejects a proposal that attempts to amend the Constitution", () => {
  assert.throws(
    () => runProposalGuards(
      makeRefinerProposal(proposalInput({ draftPayload: { amendsConstitution: true } })),
    ),
    (err: unknown) => err instanceof RefinerGuardViolationError && (err as RefinerGuardViolationError).guard === RefinerGuard.proposalNotConstitutionAmendment,
  );
});

test("runProposalGuards rejects a proposal that weakens Authority boundaries", () => {
  assert.throws(
    () => runProposalGuards(
      makeRefinerProposal(proposalInput({ draftPayload: { weakensAuthority: true } })),
    ),
    (err: unknown) => err instanceof RefinerGuardViolationError && (err as RefinerGuardViolationError).guard === RefinerGuard.proposalDoesNotWeakenAuthority,
  );
});

test("runProposalGuards rejects routing optimization across incomparable tasks", () => {
  assert.throws(
    () => runProposalGuards(
      makeRefinerProposal(proposalInput({ draftPayload: { optimizesRoutingAcrossIncomparableTasks: true } })),
    ),
    (err: unknown) => err instanceof RefinerGuardViolationError && (err as RefinerGuardViolationError).guard === RefinerGuard.proposalNotRoutingOptimization,
  );
});

test("runProposalGuards rejects weakening of acceptance criteria", () => {
  assert.throws(
    () => runProposalGuards(
      makeRefinerProposal(proposalInput({ draftPayload: { weakensAcceptanceCriteria: true } })),
    ),
    (err: unknown) => err instanceof RefinerGuardViolationError && (err as RefinerGuardViolationError).guard === RefinerGuard.proposalNotBenchmarkWeakening,
  );
});

test("runProposalGuards rejects worker self-certification", () => {
  assert.throws(
    () => runProposalGuards(
      makeRefinerProposal(proposalInput({ draftPayload: { proposedBySameActorAsExecution: true } })),
    ),
    (err: unknown) => err instanceof RefinerGuardViolationError && (err as RefinerGuardViolationError).guard === RefinerGuard.proposalNotWorkerSelfCertification,
  );
});

test("runProposalGuards rejects proposals with fewer evidence refs than minEvidenceCount", () => {
  assert.throws(
    () => runProposalGuards(
      makeRefinerProposal(proposalInput({ evidenceCount: 1 })),
    ),
    (err: unknown) => err instanceof RefinerGuardViolationError && (err as RefinerGuardViolationError).guard === RefinerGuard.proposalHasEvidence,
  );
});

test("RefinerDraftSchema rejects unparsable reversibleUntil at parse time", () => {
  assert.throws(() => RefinerDraftSchema.parse({
    summary: "x",
    rationale: "y",
    reversibleUntil: "not-a-date",
    draftPayload: {},
  }));
});

test("runProposalGuards allows a clean proposal", () => {
  const ok = makeRefinerProposal(proposalInput());
  assert.equal(ok.status, "proposed");
  assert.equal(ok.evidenceRefs.length, 2);
});

test("runProposalGuards honors allowedKinds when set", () => {
  const config = RefinerConfigSchema.parse({ allowedKinds: ["rule"] });
  assert.throws(
    () => runProposalGuards(makeRefinerProposal(proposalInput({ kind: "test" })), config),
    (err: unknown) => err instanceof RefinerGuardViolationError,
  );
  const ok = makeRefinerProposal(proposalInput({ kind: "rule" }), config);
  assert.equal(ok.kind, "rule");
});

test("assertRefinerProposal is the public invariant surface", () => {
  assertRefinerProposal(makeRefinerProposal(proposalInput()));
  assert.throws(() => assertRefinerProposal({}), (err: unknown) => err instanceof RefinerConfigurationError);
});

test("analyzeClosedWorkFromEvents classifies an accepted Work as high-quality-first-attempt", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("work.accepted", { reason: "ok", contractRevision: 1 }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.equal(analysis.outcome, "accepted");
  // Creation and acceptance are the two judgment calls; nothing else was asked of a human.
  assert.deepEqual(analysis.classifications, ["high-quality-first-attempt", "zero-human-intervention"]);
  assert.deepEqual(analysis.candidateProposalKinds, []);
  assert.equal(analysis.ledgerEventCount, 2);
});

test("analyzeClosedWorkFromEvents calls acceptance after a failed attempt a recovery, not a first attempt", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("attempt.started", { worker: { id: "agent:w", kind: "agent" }, contractRevision: 1 }, { workId: "work:1", taskId: "task:1", attemptId: "attempt:1" }),
    event("attempt.failed", { reason: "verification refused", recoverable: true }, { workId: "work:1", taskId: "task:1", attemptId: "attempt:1" }),
    event("attempt.started", { worker: { id: "agent:w", kind: "agent" }, contractRevision: 1 }, { workId: "work:1", taskId: "task:1", attemptId: "attempt:2" }),
    event("work.accepted", { reason: "ok", contractRevision: 1 }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.deepEqual(analysis.classifications, ["successful-recovery", "zero-human-intervention"]);
  assert.deepEqual(analysis.candidateProposalKinds, ["recovery-behavior"]);
});

test("analyzeClosedWorkFromEvents does not call a Work zero-intervention when a human acted mid-run", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("review.started", { reviewId: "review:1", contractRevision: 1 }, { workId: "work:1" }),
    event("work.accepted", { reason: "ok", contractRevision: 1 }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.deepEqual(analysis.classifications, ["high-quality-first-attempt"]);
});

test("analyzeClosedWorkFromEvents classifies a failed Work as runtime-failure", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("attempt.failed", { reason: "boom", recoverable: true }, { workId: "work:1", taskId: "task:1", attemptId: "attempt:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.equal(analysis.outcome, "failed");
  assert.ok(analysis.classifications.includes("runtime-failure"));
});

test("analyzeClosedWorkFromEvents classifies a blocked Work as process-stall", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("attempt.blocked", { reason: "waiting on dependency", decisionId: "dec:1" }, { workId: "work:1", taskId: "task:1", attemptId: "attempt:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.ok(analysis.classifications.includes("process-stall"));
});

test("analyzeClosedWorkFromEvents classifies a verification-gap when verification fails", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("verification.result", {
      verificationId: "ver:1",
      contractRevision: 1,
      status: "fail",
      criterionResults: [{ criterionId: "criterion:tests", status: "fail", evidence: [] }],
      evidenceSatisfaction: [],
        falsifiability: { provenCriteria: [], exemptedCriteria: [] },
    }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.ok(analysis.classifications.includes("verification-gap"));
});

test("analyzeClosedWorkFromEvents classifies an authority-error when an authority is denied", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("authority.denied", { policy: { grants: [], requiresHumanApproval: [] }, reason: "nope" }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.ok(analysis.classifications.includes("authority-error"));
});

test("analyzeClosedWorkFromEvents suggests candidate proposal kinds for verification-gap", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("verification.result", {
      verificationId: "ver:1",
      contractRevision: 1,
      status: "fail",
      criterionResults: [{ criterionId: "criterion:tests", status: "fail", evidence: [] }],
      evidenceSatisfaction: [],
        falsifiability: { provenCriteria: [], exemptedCriteria: [] },
    }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.ok(analysis.candidateProposalKinds.includes("verifier"));
  assert.ok(analysis.candidateProposalKinds.includes("test"));
});

test("analyzeClosedWorkFromEvents suggests guard-tuning + rule for authority-error", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1" }),
    event("authority.denied", { policy: { grants: [], requiresHumanApproval: [] }, reason: "nope" }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.ok(analysis.candidateProposalKinds.includes("guard-tuning"));
  assert.ok(analysis.candidateProposalKinds.includes("rule"));
});

test("analyzeClosedWorkFromEvents ignores events from other work ids", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:other" }),
    event("work.accepted", { reason: "ok", contractRevision: 1 }, { workId: "work:1" }),
  ];
  const analysis = analyzeClosedWorkFromEvents("work:1", events);
  assert.equal(analysis.ledgerEventCount, 1);
  assert.equal(analysis.outcome, "accepted");
});

test("computeLedgerSpanMs returns zero for an empty list", () => {
  assert.equal(computeLedgerSpanMs([]), 0);
});

test("computeLedgerSpanMs returns the difference between the last and first occurredAt", () => {
  const events = [
    event("work.created", { contract: work(), revision: 1 }, { workId: "work:1", occurredAt: "2026-08-20T04:00:00.000Z" }),
    event("attempt.finished", { resultSummary: "ok", artifactRefs: [] }, { workId: "work:1", taskId: "task:1", attemptId: "attempt:1", occurredAt: "2026-08-20T04:01:00.000Z" }),
  ];
  assert.equal(computeLedgerSpanMs(events), 60_000);
});

test("streamIdForWork is the canonical work stream id", () => {
  assert.equal(streamIdForWork("work:1"), "stream:work:1");
});

test("streamIdForWork bounds valid 200-character Work ids without collisions", () => {
  const prefix = "work:" + "x".repeat(194);
  const first = streamIdForWork(`${prefix}a`);
  const second = streamIdForWork(`${prefix}b`);
  assert.ok(first.length <= 200);
  assert.ok(second.length <= 200);
  assert.notEqual(first, second);
});

test("analyzeClosedWork reads from the Ledger via streamIdForWork", async () => {
  const ledger = new InMemoryEventLedger();
  await ledger.append(event("work.created", { contract: work(), revision: 1 }, { workId: "work:1", occurredAt: "2026-08-20T04:00:00.000Z" }));
  await ledger.append(event("work.accepted", { reason: "ok", contractRevision: 1 }, { workId: "work:1", occurredAt: "2026-08-20T04:01:00.000Z" }));
  const analysis = await analyzeClosedWork("work:1", ledger);
  assert.equal(analysis.outcome, "accepted");
  assert.equal(analysis.ledgerEventCount, 2);
});

test("buildProposedEvent produces a typed refiner.proposed event", () => {
  const proposal = makeRefinerProposal(proposalInput());
  const ev = buildProposedEvent(proposal, "event:ledger:1", "stream:work:work:1", TEST_NOW, TEST_NOW);
  assert.equal(ev.type, "refiner.proposed");
  assert.equal(ev.payload.proposal.id, proposal.id);
  assert.equal(ev.workId, "work:1");
});

test("recordProposal appends a refiner.proposed event to the Ledger", async () => {
  const ledger = new InMemoryEventLedger();
  const proposal = makeRefinerProposal(proposalInput());
  const ev = await recordProposal(proposal, ledger, "event:ledger:1");
  assert.equal(ev.type, "refiner.proposed");
  const found = await findProposalInLedger(proposal.id, ledger, "work:1");
  assert.ok(found);
  assert.equal(found.id, proposal.id);
});

test("acceptProposal appends a refiner.accepted event with rationale", async () => {
  const ledger = new InMemoryEventLedger();
  const proposal = makeRefinerProposal(proposalInput());
  await recordProposal(proposal, ledger, "event:1");
  const ev = await acceptProposal(proposal.id, proposal.workId, human, "approve", ledger, "event:2");
  assert.equal(ev.type, "refiner.accepted");
  assert.equal(ev.payload.rationale, "approve");
});

test("acceptProposal refuses agent actors with empty rationale", async () => {
  const ledger = new InMemoryEventLedger();
  const proposal = makeRefinerProposal(proposalInput());
  await recordProposal(proposal, ledger, "event:1");
  await assert.rejects(
    acceptProposal(proposal.id, proposal.workId, worker, "", ledger, "event:2"),
    (err: unknown) => err instanceof RefinerGuardViolationError,
  );
});

test("acceptProposal throws RefinerLifecycleError when required fields are empty", async () => {
  const ledger = new InMemoryEventLedger();
  await assert.rejects(
    acceptProposal("", "work:1", human, "ok", ledger, "event:1"),
    (err: unknown) => err instanceof RefinerLifecycleError,
  );
});

test("rejectProposal appends a refiner.rejected event", async () => {
  const ledger = new InMemoryEventLedger();
  const proposal = makeRefinerProposal(proposalInput());
  await recordProposal(proposal, ledger, "event:1");
  const ev = await rejectProposal(proposal.id, proposal.workId, human, "not relevant", ledger, "event:2");
  assert.equal(ev.type, "refiner.rejected");
});

test("promoteProposal refuses agent actors per §22", async () => {
  const ledger = new InMemoryEventLedger();
  const proposal = makeRefinerProposal(proposalInput());
  await recordProposal(proposal, ledger, "event:1");
  await assert.rejects(
    promoteProposal(proposal.id, proposal.workId, worker, "kernel:rules", false, ledger, "event:2"),
    (err: unknown) => err instanceof RefinerGuardViolationError,
  );
});

test("promoteProposal accepts a human actor and appends a refiner.promoted event", async () => {
  const ledger = new InMemoryEventLedger();
  const proposal = makeRefinerProposal(proposalInput());
  await recordProposal(proposal, ledger, "event:1");
  const ev = await promoteProposal(proposal.id, proposal.workId, human, "kernel:rules", false, ledger, "event:2");
  assert.equal(ev.type, "refiner.promoted");
  assert.equal(ev.payload.appliedSurface, "kernel:rules");
  assert.equal(ev.payload.irreversible, false);
});

test("promoteProposal throws RefinerLifecycleError when appliedSurface is empty", async () => {
  const ledger = new InMemoryEventLedger();
  await assert.rejects(
    promoteProposal("proposal:1", "work:1", human, "", false, ledger, "event:1"),
    (err: unknown) => err instanceof RefinerLifecycleError,
  );
});

test("findProposalInLedger returns null when the proposal is not found", async () => {
  const ledger = new InMemoryEventLedger();
  const found = await findProposalInLedger("proposal:nope", ledger, "work:1");
  assert.equal(found, null);
});

test("parseRefinerProposal round-trips a valid proposal", () => {
  const proposal = makeRefinerProposal(proposalInput());
  const parsed = parseRefinerProposal(proposal);
  assert.equal(parsed.id, proposal.id);
});

test("parseRefinerConfig rejects unknown guard flags", () => {
  assert.throws(() => parseRefinerConfig({ unknownFlag: true }));
});

test("parseRefinerAnalysis requires workId", () => {
  assert.throws(() => parseRefinerAnalysis({}));
  const ok = parseRefinerAnalysis({ workId: "w", outcome: "accepted", classifications: [], candidateProposalKinds: [], ledgerEventCount: 0, ledgerSpanMs: 0 });
  assert.equal(ok.workId, "w");
});

test("RefinerAnalysisSchema rejects unknown outcome", () => {
  assert.throws(() => RefinerAnalysisSchema.parse({
    workId: "w",
    outcome: "in-progress",
    classifications: [],
    candidateProposalKinds: [],
    ledgerEventCount: 0,
    ledgerSpanMs: 0,
  }));
});

test("parseRefinerProposalReview requires reviewer and decision", () => {
  assert.throws(() => parseRefinerProposalReview({ proposalId: "p", reviewer: { id: "x", kind: "human" }, reason: "ok", reviewedAt: "2026-08-20T05:00:00.000Z" }));
});

test("RefinerProposalReviewSchema accepts a valid review", () => {
  const review = RefinerProposalReviewSchema.parse({
    proposalId: "proposal:1",
    reviewer: { id: "reviewer:1", kind: "verifier" },
    decision: "endorse",
    reason: "well-evidenced",
    reviewedAt: "2026-08-20T05:00:00.000Z",
  });
  assert.equal(review.decision, "endorse");
});

test("RefinerAnalysisSchema rejects unknown outcome", () => {
  assert.throws(() => RefinerAnalysisSchema.parse({
    workId: "w",
    outcome: "in-progress",
    classifications: [],
    candidateProposalKinds: [],
    ledgerEventCount: 0,
    ledgerSpanMs: 0,
  }));
});

test("buildAcceptedEvent, buildRejectedEvent, buildPromotedEvent produce typed events", () => {
  const accepted = buildAcceptedEvent("p:1", "work:1", human, "ok", "e:1", "stream:work:work:1", TEST_NOW, TEST_NOW);
  assert.equal(accepted.type, "refiner.accepted");
  const rejected = buildRejectedEvent("p:1", "work:1", human, "no", "e:1", "stream:work:work:1", TEST_NOW, TEST_NOW);
  assert.equal(rejected.type, "refiner.rejected");
  const promoted = buildPromotedEvent("p:1", "work:1", human, "kernel:rules", false, "e:1", "stream:work:work:1", TEST_NOW, TEST_NOW);
  assert.equal(promoted.type, "refiner.promoted");
  assert.equal(promoted.payload.irreversible, false);
});

test("RefinerError carries a stable code on every subclass", () => {
  const err = new RefinerGuardViolationError("msg", RefinerGuard.proposalHasEvidence);
  assert.equal(err.code, "REFINER_GUARD_VIOLATION");
  assert.equal(err.name, "RefinerGuardViolationError");
  const cfg = new RefinerConfigurationError("msg");
  assert.equal(cfg.code, "REFINER_CONFIGURATION_ERROR");
  const life = new RefinerLifecycleError("msg");
  assert.equal(life.code, "REFINER_LIFECYCLE_ERROR");
  const base = new RefinerError("msg", "X");
  assert.equal(base.code, "X");
});

test("RefinerGuard enum names are stable across the public surface", () => {
  assert.equal(RefinerGuard.proposalHasEvidence, "proposalHasEvidence");
  assert.equal(RefinerGuard.proposalIsReversible, "proposalIsReversible");
  assert.equal(RefinerGuard.proposalNotConstitutionAmendment, "proposalNotConstitutionAmendment");
  assert.equal(RefinerGuard.proposalDoesNotWeakenAuthority, "proposalDoesNotWeakenAuthority");
  assert.equal(RefinerGuard.proposalNotRoutingOptimization, "proposalNotRoutingOptimization");
  assert.equal(RefinerGuard.proposalNotBenchmarkWeakening, "proposalNotBenchmarkWeakening");
  assert.equal(RefinerGuard.proposalNotWorkerSelfCertification, "proposalNotWorkerSelfCertification");
  assert.equal(RefinerGuard.reviewerNotProposer, "reviewerNotProposer");
});

test("Refiner config with requireReversibleUntil=false accepts past dates", () => {
  const config = RefinerConfigSchema.parse({ requireReversibleUntil: false });
  const ok = makeRefinerProposal(proposalInput({
    draftOverride: { summary: "x", rationale: "y", reversibleUntil: "2020-01-01T00:00:00.000Z", draftPayload: {} },
  }), config);
  assert.equal(ok.draft.reversibleUntil, "2020-01-01T00:00:00.000Z");
});

test("Refiner requires reversibleUntil to be in the future when requireReversibleUntil=true", () => {
  const config = RefinerConfigSchema.parse({ requireReversibleUntil: true });
  assert.throws(
    () => makeRefinerProposal(proposalInput({
      draftOverride: { summary: "x", rationale: "y", reversibleUntil: "2020-01-01T00:00:00.000Z", draftPayload: {} },
    }), config),
    (err: unknown) => err instanceof RefinerGuardViolationError && (err as RefinerGuardViolationError).guard === RefinerGuard.proposalIsReversible,
  );
});

test("helper integration: recordProposal then promoteProposal records three events in stream order", async () => {
  const ledgerEvents: { type: string; id: string }[] = [];
  const ledger: EventLedger = {
    async append(event) {
      ledgerEvents.push({ type: event.type, id: event.id });
    },
    async *read() {
      throw new Error("not used");
    },
    async replay() {
      throw new Error("not used");
    },
  };
  const proposal = makeRefinerProposal(proposalInput());
  await recordProposal(proposal, ledger, "event:1");
  await acceptProposal(proposal.id, proposal.workId, human, "ok", ledger, "event:2");
  await promoteProposal(proposal.id, proposal.workId, human, "kernel:rules", false, ledger, "event:3");
  assert.deepEqual(ledgerEvents.map((e) => e.type), [
    "refiner.proposed",
    "refiner.accepted",
    "refiner.promoted",
  ]);
});
