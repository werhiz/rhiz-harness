import assert from "node:assert/strict";
import test from "node:test";
import {
  AbstractDesignLearningSchema,
  BrandDesignLearningSchema,
  DESIGN_ABSTRACTION_SURFACE,
  DesignPolicyError,
  DesignReceiptSchema,
  abstractDesignLearning,
  designAbstractionDraftPayload,
  designLocalLearningDigest,
  designReceiptDigest,
  designReceiptEvidenceRefs,
  learningFromAcceptedReceipt,
  selectDesignContext,
  type BrandDesignLearning,
  type DesignAcceptanceRef,
  type DesignReceipt,
} from "../src/design-intelligence.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { makeRefinerProposal, streamIdForWork } from "../src/refiner.js";
import type { HarnessEvent, WorkContract } from "../src/schemas.js";
import { event, human, reviewer, verifier, work, worker } from "./helpers.js";

type AcceptedDesignReceipt = Extract<DesignReceipt, { decision: "accepted" }>;

const sourceWorkId = "work:design-source";
const proposalWorkId = "work:design-abstraction";

function sourceReceipt(): AcceptedDesignReceipt {
  const parsed = DesignReceiptSchema.parse({
    id: "receipt:source-design",
    workId: sourceWorkId,
    candidateId: "candidate:source-design",
    target: {
      scope: "brand",
      surfaceId: "surface:mcgruder",
      brandId: "brand:mcgruder",
    },
    learning: {
      id: "learning:brand:mcgruder:source",
      kind: "pattern",
      statement: "Use directly explorable lineage when provenance is central.",
      expressionRefs: ["artifact:mcgruder-lineage"],
    },
    decision: "accepted",
    acceptanceEventId: "event:source-accepted",
    evidenceRefs: ["evidence:design-review", "evidence:accessibility"],
    rationale: "Accepted local design evidence.",
    recordedAt: "2026-08-20T04:00:01.000Z",
  });
  if (parsed.decision !== "accepted") {
    throw new Error("fixture requires acceptance");
  }
  return parsed;
}

function sourceAcceptanceRef(
  receipt: AcceptedDesignReceipt,
): DesignAcceptanceRef {
  return {
    workId: receipt.workId,
    acceptanceEventId: receipt.acceptanceEventId,
    receiptId: receipt.id,
    receiptDigest: designReceiptDigest(receipt),
    learningDigest: designLocalLearningDigest(receipt),
  };
}

function canonicalEvidence(receipt: AcceptedDesignReceipt): string[] {
  return [
    ...receipt.evidenceRefs,
    receipt.id,
    receipt.acceptanceEventId,
  ];
}

function manualSourceLearning(
  receipt: AcceptedDesignReceipt,
  createdAt: string,
): BrandDesignLearning {
  return BrandDesignLearningSchema.parse({
    ...receipt.learning,
    scope: "brand",
    brandId: "brand:mcgruder",
    evidenceRefs: canonicalEvidence(receipt),
    createdAt,
    acceptance: sourceAcceptanceRef(receipt),
  });
}

function withWork(
  type: HarnessEvent["type"],
  payload: unknown,
  workId: string,
  overrides: Record<string, unknown> = {},
): HarnessEvent {
  return event(type as never, payload as never, {
    workId,
    streamId: streamIdForWork(workId),
    ...overrides,
  } as never) as HarnessEvent;
}

function sourceWorkEvents(
  receipt: AcceptedDesignReceipt,
): HarnessEvent[] {
  const contract: WorkContract = work({ id: sourceWorkId });
  const taskId = "task:source";
  const attemptId = "attempt:source";
  const verificationId = "verification:source";
  return [
    withWork("work.created", { contract, revision: 1 }, sourceWorkId),
    withWork(
      "task.created",
      { objective: "Produce accepted design evidence" },
      sourceWorkId,
      { taskId },
    ),
    withWork("task.assigned", { worker }, sourceWorkId, { taskId }),
    withWork(
      "attempt.started",
      {
        worker,
        contractRevision: 1,
        lease: {
          id: "lease:source",
          workspaceId: "workspace:source",
          resourceClaims: [{ kind: "path", resource: "src" }],
          acquiredAt: "2026-08-20T04:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
      sourceWorkId,
      { taskId, attemptId, actor: worker },
    ),
    withWork(
      "attempt.activity-observed",
      {
        state: "working",
        detail: "message: worker produced the design receipt",
        source: worker.id,
        authority: "observation",
      },
      sourceWorkId,
      { taskId, attemptId, actor: worker },
    ),
    withWork(
      "guard.evaluated",
      {
        request: {
          requestId: "guard:source:write",
          workId: sourceWorkId,
          taskId,
          attemptId,
          actor: worker,
          writeScope: "workspace",
          contextHash: "ctx:source",
          evidenceRefs: [],
          timestampMs: 1787000000000,
          tool: {
            name: "worker:file-change",
            category: "write",
            args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:source-write" },
          },
        },
        verdict: {
          requestId: "guard:source:write",
          decision: "allow",
          rationale: "source design fixture write authorized",
          riskLevel: "medium",
          ruleHits: ["per-category-mode:write:allow"],
          evaluatedAt: "2026-08-20T04:00:00.500Z",
          durationMs: 1,
          policyBackend: "rhiz-native",
          policyBackendVersion: "0.1.0",
        },
      },
      sourceWorkId,
      { taskId, attemptId, actor: worker },
    ),
    withWork(
      "attempt.finished",
      { resultSummary: "Design evidence complete", artifactRefs: [] },
      sourceWorkId,
      { taskId, attemptId, actor: worker },
    ),
    withWork(
      "verification.started",
      { verificationId, contractRevision: 1 },
      sourceWorkId,
      { actor: verifier },
    ),
    withWork(
      "verification.result",
      {
        verificationId,
        contractRevision: 1,
        status: "pass",
        criterionResults: [
          {
            criterionId: "criterion:tests",
            status: "pass",
            evidence: [
              {
                id: "proof:source",
                kind: "test",
                digest: "sha256:source",
              },
            ],
          },
        ],
        evidenceSatisfaction: [
          {
            requirementId: "evidence:tests",
            evidence: [
              {
                id: "proof:source",
                kind: "test",
                digest: "sha256:source",
              },
            ],
          },
        ],
        falsifiability: {
          provenCriteria: ["criterion:tests"],
          exemptedCriteria: [],
        },
      },
      sourceWorkId,
      { actor: verifier },
    ),
    withWork(
      "work.accepted",
      { reason: "Accepted exact design receipt.", contractRevision: 1 },
      sourceWorkId,
      {
        id: receipt.acceptanceEventId,
        actor: human,
        evidence: designReceiptEvidenceRefs(receipt),
      },
    ),
  ];
}

function proposalEvidenceEvents(): [HarnessEvent, HarnessEvent] {
  const contract = work({ id: proposalWorkId });
  return [
    withWork("work.created", { contract, revision: 1 }, proposalWorkId),
    withWork(
      "task.created",
      { objective: "Review a portable design abstraction" },
      proposalWorkId,
      { taskId: "task:abstraction" },
    ),
  ];
}

function abstractionProposal(
  source: BrandDesignLearning,
  evidence: readonly [HarnessEvent, HarnessEvent],
  reversibleUntil = "2099-08-20T04:00:00.000Z",
) {
  return makeRefinerProposal({
    id: "proposal:design-abstraction:provenance",
    workId: proposalWorkId,
    kind: "lesson-fixture",
    title: "Review portable lineage principle",
    summary:
      "Review a brand-neutral principle derived from accepted local evidence.",
    reasoning:
      "Only the reviewed principle may travel; local visual expression stays local.",
    classification: "excellent-review",
    evidenceRefs: evidence.map((item) => ({
      ledgerEventId: item.id,
      reasoning: "Durable proposal-work evidence.",
    })),
    draft: {
      summary: "Portable lineage principle",
      rationale: "The principle can travel without McGruder expression.",
      reversibleUntil,
      draftPayload: designAbstractionDraftPayload(source, {
        id: "learning:abstract:lineage",
        kind: "pattern",
        statement:
          "When provenance is central, make lineage directly explorable.",
      }),
    },
    proposedBy: worker,
    proposedAt: "2026-08-20T04:00:03.000Z",
  });
}

function abstractionLifecycleEvents(
  proposal: ReturnType<typeof abstractionProposal>,
  promotionRecordedAt = "2026-08-20T04:00:05.000Z",
): HarnessEvent[] {
  return [
    withWork("refiner.proposed", { proposal }, proposalWorkId, {
      actor: proposal.proposedBy,
      recordedAt: "2026-08-20T04:00:03.000Z",
    }),
    withWork(
      "refiner.accepted",
      {
        proposalId: proposal.id,
        workId: proposal.workId,
        acceptedBy: reviewer,
        rationale: "Independent review accepts the portable wording.",
      },
      proposalWorkId,
      {
        actor: reviewer,
        recordedAt: "2026-08-20T04:00:04.000Z",
      },
    ),
    withWork(
      "refiner.promoted",
      {
        proposalId: proposal.id,
        workId: proposal.workId,
        promotedBy: human,
        appliedSurface: DESIGN_ABSTRACTION_SURFACE,
        irreversible: false,
      },
      proposalWorkId,
      { actor: human, recordedAt: promotionRecordedAt },
    ),
  ];
}

async function appendAll(
  ledger: InMemoryEventLedger,
  events: readonly HarnessEvent[],
): Promise<void> {
  for (const item of events) await ledger.append(item);
}

async function validSourceFixture(
  options: { now?: () => string } = {},
) {
  const ledger = new InMemoryEventLedger(options);
  const receipt = sourceReceipt();
  await appendAll(ledger, sourceWorkEvents(receipt));
  const learning = await learningFromAcceptedReceipt(receipt, ledger);
  if (learning.scope !== "brand") throw new Error("fixture requires brand learning");
  return { ledger, receipt, learning };
}

async function validPortableFixture(
  options: { now?: () => string } = {},
) {
  const fixture = await validSourceFixture(options);
  const evidence = proposalEvidenceEvents();
  await appendAll(fixture.ledger, evidence);
  const proposal = abstractionProposal(fixture.learning, evidence);
  await appendAll(fixture.ledger, abstractionLifecycleEvents(proposal));
  const portable = await abstractDesignLearning(
    fixture.learning,
    fixture.ledger,
    proposal.workId,
    proposal.id,
  );
  return { ...fixture, proposal, portable };
}

test("source acceptance must be durable before abstraction review", async () => {
  let ledgerNow = "2099-08-20T04:00:01.000Z";
  const ledger = new InMemoryEventLedger({ now: () => ledgerNow });
  const receipt = sourceReceipt();
  const learning = manualSourceLearning(
    receipt,
    "2099-08-20T04:00:20.000Z",
  );
  const evidence = proposalEvidenceEvents();
  await appendAll(ledger, evidence);
  const proposal = abstractionProposal(learning, evidence);
  await appendAll(ledger, abstractionLifecycleEvents(proposal));

  ledgerNow = "2099-08-20T04:00:20.000Z";
  await appendAll(ledger, sourceWorkEvents(receipt));

  await assert.rejects(
    abstractDesignLearning(
      learning,
      ledger,
      proposal.workId,
      proposal.id,
    ),
    (error: unknown) =>
      error instanceof DesignPolicyError &&
      error.code === "DESIGN_ABSTRACTION_SOURCE_NOT_ACCEPTED_AT_PROPOSAL",
  );
});

test("reversal deadline uses ledger append time, not a backdated event envelope", async () => {
  let ledgerNow = "2099-08-20T04:00:00.000Z";
  const ledger = new InMemoryEventLedger({ now: () => ledgerNow });
  const receipt = sourceReceipt();
  await appendAll(ledger, sourceWorkEvents(receipt));
  const learning = await learningFromAcceptedReceipt(receipt, ledger);
  if (learning.scope !== "brand") throw new Error("fixture requires brand learning");

  const evidence = proposalEvidenceEvents();
  ledgerNow = "2099-08-20T04:00:01.000Z";
  await appendAll(ledger, evidence);
  const proposal = abstractionProposal(
    learning,
    evidence,
    "2099-08-20T04:00:10.000Z",
  );
  const lifecycle = abstractionLifecycleEvents(
    proposal,
    "2099-08-20T04:00:05.000Z",
  );
  await ledger.append(lifecycle[0]!);
  await ledger.append(lifecycle[1]!);
  ledgerNow = "2099-08-20T04:00:20.000Z";
  await ledger.append(lifecycle[2]!);

  await assert.rejects(
    abstractDesignLearning(
      learning,
      ledger,
      proposal.workId,
      proposal.id,
    ),
    (error: unknown) =>
      error instanceof DesignPolicyError &&
      error.code === "DESIGN_ABSTRACTION_REVERSAL_EXPIRED",
  );
});

test("portable evidence refs are reconstructed and tampering fails at consumption", async () => {
  const fixture = await validPortableFixture();
  const tampered = AbstractDesignLearningSchema.parse({
    ...fixture.portable,
    evidenceRefs: ["evidence:unrelated"],
  });

  await assert.rejects(
    selectDesignContext(
      [tampered],
      {
        scope: "brand",
        surfaceId: "surface:field-studio",
        brandId: "brand:field-studio",
      },
      fixture.ledger,
    ),
    (error: unknown) =>
      error instanceof DesignPolicyError &&
      error.code === "DESIGN_ABSTRACTION_STALE",
  );
});

test("proposal evidence must belong to the exact proposal Work", async () => {
  const fixture = await validSourceFixture();
  const valid = proposalEvidenceEvents()[0];
  const forged = event(
    "task.created",
    { objective: "Foreign work disguised as proposal evidence" },
    {
      id: "event:foreign-evidence",
      workId: "work:foreign",
      streamId: streamIdForWork(proposalWorkId),
      taskId: "task:foreign",
    },
  );
  await appendAll(fixture.ledger, [valid, forged]);
  const evidence: [HarnessEvent, HarnessEvent] = [valid, forged];
  const proposal = abstractionProposal(fixture.learning, evidence);
  await appendAll(fixture.ledger, abstractionLifecycleEvents(proposal));

  await assert.rejects(
    abstractDesignLearning(
      fixture.learning,
      fixture.ledger,
      proposal.workId,
      proposal.id,
    ),
    (error: unknown) =>
      error instanceof DesignPolicyError &&
      error.code === "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
  );
});

test("local learning evidence refs and createdAt are revalidated at consumption", async () => {
  const fixture = await validSourceFixture();

  const badEvidence = BrandDesignLearningSchema.parse({
    ...fixture.learning,
    evidenceRefs: ["evidence:forged"],
  });
  await assert.rejects(
    selectDesignContext(
      [badEvidence],
      {
        scope: "brand",
        surfaceId: "surface:mcgruder",
        brandId: "brand:mcgruder",
      },
      fixture.ledger,
    ),
    (error: unknown) =>
      error instanceof DesignPolicyError &&
      error.code === "DESIGN_SOURCE_LEARNING_TAMPERED",
  );

  const badCreatedAt = BrandDesignLearningSchema.parse({
    ...fixture.learning,
    createdAt: "2099-12-31T23:59:59.000Z",
  });
  await assert.rejects(
    selectDesignContext(
      [badCreatedAt],
      {
        scope: "brand",
        surfaceId: "surface:mcgruder",
        brandId: "brand:mcgruder",
      },
      fixture.ledger,
    ),
    (error: unknown) =>
      error instanceof DesignPolicyError &&
      error.code === "DESIGN_SOURCE_LEARNING_TAMPERED",
  );
});
