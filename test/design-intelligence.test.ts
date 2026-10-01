import assert from "node:assert/strict";
import test from "node:test";
import {
  AbstractDesignLearningSchema,
  BrandDesignLearningSchema,
  DESIGN_ABSTRACTION_SURFACE,
  DesignAbstractionSchema,
  DesignPolicyError,
  DesignReceiptSchema,
  RhizDesignLearningSchema,
  UniversalDesignLearningSchema,
  abstractDesignLearning,
  assertDesignPromotion,
  designAbstractionDraftPayload,
  designReceiptEvidenceRefs,
  learningFromAcceptedReceipt,
  reviewDesignSignals,
  selectDesignContext,
  type BrandDesignLearning,
  type DesignReceipt,
} from "../src/design-intelligence.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { makeRefinerProposal, streamIdForWork } from "../src/refiner.js";
import type { ActorRef, HarnessEvent, RefinerProposal } from "../src/schemas.js";
import {
  event,
  human,
  passingVerificationSequence,
  reviewer,
  successfulExecution,
  worker,
} from "./helpers.js";

const now = "2026-08-20T04:00:01.000Z";
const fixtureAcceptance = {
  workId: "work:accepted-fixture",
  acceptanceEventId: "event:accepted-fixture",
  receiptId: "receipt:fixture",
  receiptDigest: `sha256:${"1".repeat(64)}`,
  learningDigest: `sha256:${"2".repeat(64)}`,
};

type AcceptedDesignReceipt = Extract<DesignReceipt, { decision: "accepted" }>;

function acceptedReceipt(value: unknown): AcceptedDesignReceipt {
  const parsed = DesignReceiptSchema.parse(value);
  if (parsed.decision !== "accepted") throw new Error("fixture expected accepted receipt");
  return parsed;
}

const universal = UniversalDesignLearningSchema.parse({
  id: "learning:universal:hierarchy",
  scope: "universal",
  kind: "principle",
  statement: "Visual hierarchy should follow the importance of the decision or content.",
  evidenceRefs: ["evidence:1"],
  createdAt: now,
});
const fakeRhiz = RhizDesignLearningSchema.parse({
  id: "learning:rhiz:fake",
  scope: "rhiz-first-party",
  kind: "interaction",
  statement: "Unaccepted Rhiz learning must never enter prompt context.",
  evidenceRefs: ["evidence:fake"],
  acceptance: fixtureAcceptance,
  expressionRefs: [],
  createdAt: now,
});
const fakeBrand = BrandDesignLearningSchema.parse({
  id: "learning:brand:fake",
  scope: "brand",
  brandId: "brand:mcgruder",
  kind: "signature",
  statement: "Unaccepted brand learning must never enter prompt context.",
  evidenceRefs: ["evidence:fake"],
  acceptance: fixtureAcceptance,
  expressionRefs: ["artifact:fake"],
  createdAt: now,
});
const fabricatedAbstract = AbstractDesignLearningSchema.parse({
  id: "learning:abstract:fake",
  scope: "abstract",
  kind: "pattern",
  statement: "A typed portable object without a lifecycle is not authority.",
  evidenceRefs: ["evidence:fake"],
  sourceLearningIds: [fakeBrand.id],
  sourceAcceptance: fixtureAcceptance,
  promotion: {
    workId: "work:abstraction-fixture",
    proposalId: "proposal:abstraction-fixture",
    acceptedEventId: "event:abstraction-accepted-fixture",
    promotedEventId: "event:abstraction-promoted-fixture",
  },
  createdAt: now,
});

async function appendAll(ledger: InMemoryEventLedger, events: readonly HarnessEvent[]) {
  for (const item of events) await ledger.append(item);
}

function mcgruderReceipt(overrides: Record<string, unknown> = {}): AcceptedDesignReceipt {
  return acceptedReceipt({
    id: "receipt:mcgruder:accepted-source",
    workId: "work:1",
    candidateId: "candidate:mcgruder:accepted-source",
    target: {
      scope: "brand",
      surfaceId: "surface:mcgruder-home",
      brandId: "brand:mcgruder",
    },
    learning: {
      id: "learning:brand:mcgruder:accepted-lineage",
      kind: "signature",
      statement: "Preserve the accepted lineage treatment within McGruder expression.",
      expressionRefs: ["artifact:mcgruder-lineage"],
    },
    decision: "accepted",
    acceptanceEventId: "event:design-accepted:mcgruder",
    evidenceRefs: ["evidence:human-selection", "evidence:accessibility"],
    rationale: "The selected direction is accepted design evidence.",
    recordedAt: now,
    ...overrides,
  });
}

async function acceptedMcgruderLearning(ledger: InMemoryEventLedger): Promise<{
  learning: BrandDesignLearning;
  proposalEvidenceEventIds: [string, string];
}> {
  const receipt = mcgruderReceipt();
  const verification = passingVerificationSequence();
  const acceptedEvent = event(
    "work.accepted",
    { reason: "Design evidence satisfies the Work contract.", contractRevision: 1 },
    { id: receipt.acceptanceEventId, evidence: designReceiptEvidenceRefs(receipt) },
  );
  await appendAll(ledger, [...successfulExecution(), ...verification, acceptedEvent]);
  const learning = await learningFromAcceptedReceipt(receipt, ledger);
  if (learning.scope !== "brand") throw new Error("fixture expected brand learning");
  return { learning, proposalEvidenceEventIds: [verification[1]!.id, acceptedEvent.id] };
}

function makeAbstractionProposal(
  source: BrandDesignLearning,
  evidenceEventIds: readonly [string, string],
) {
  return makeRefinerProposal({
    id: "proposal:design-abstraction:1",
    workId: "work:1",
    kind: "lesson-fixture",
    title: "Abstract a reviewed design lesson",
    summary: "Extract the portable lineage principle without the McGruder expression.",
    reasoning: "The local expression is evidence, but only the reviewed principle may travel.",
    classification: "excellent-review",
    evidenceRefs: evidenceEventIds.map((ledgerEventId) => ({
      ledgerEventId,
      reasoning: "Durable evidence from the accepted design Work.",
    })),
    draft: {
      summary: "Portable lineage principle",
      rationale: "The principle can transfer without typography, palette, imagery, or branded composition.",
      reversibleUntil: "2099-08-28T20:00:00Z",
      draftPayload: designAbstractionDraftPayload(source, {
        id: "learning:abstract:provenance-lineage",
        kind: "pattern",
        statement: "For provenance-heavy stories, make lineage directly explorable.",
      }),
    },
    proposedBy: worker,
    proposedAt: now,
  });
}

function abstractionEvents(
  source: BrandDesignLearning,
  evidenceEventIds: readonly [string, string],
  options: {
    proposal?: RefinerProposal;
    proposedActor?: ActorRef;
    acceptedBy?: ActorRef;
    includePromotion?: boolean;
    rejectAfterAcceptance?: boolean;
    appliedSurface?: string | undefined;
    irreversible?: boolean;
    promotionRecordedAt?: string;
  } = {},
) {
  const proposal = options.proposal ?? makeAbstractionProposal(source, evidenceEventIds);
  const acceptedBy = options.acceptedBy ?? reviewer;
  const events: HarnessEvent[] = [
    event("refiner.proposed", { proposal }, { actor: options.proposedActor ?? proposal.proposedBy }),
    event(
      "refiner.accepted",
      {
        proposalId: proposal.id,
        workId: proposal.workId,
        acceptedBy,
        rationale: "Independent review approved only the portable principle.",
      },
      { actor: acceptedBy },
    ),
  ];
  if (options.rejectAfterAcceptance) {
    events.push(
      event(
        "refiner.rejected",
        {
          proposalId: proposal.id,
          workId: proposal.workId,
          rejectedBy: human,
          rationale: "The accepted abstraction was withdrawn before promotion.",
        },
        { actor: human },
      ),
    );
  }
  if (options.includePromotion !== false) {
    events.push(
      event(
        "refiner.promoted",
        {
          proposalId: proposal.id,
          workId: proposal.workId,
          promotedBy: human,
          appliedSurface: options.appliedSurface ?? DESIGN_ABSTRACTION_SURFACE,
          irreversible: options.irreversible ?? false,
        },
        {
          actor: human,
          ...(options.promotionRecordedAt ? { recordedAt: options.promotionRecordedAt } : {}),
        },
      ),
    );
  }
  return { proposal, events };
}

async function portableMcgruderLearning(ledger: InMemoryEventLedger) {
  const fixture = await acceptedMcgruderLearning(ledger);
  const lifecycle = abstractionEvents(fixture.learning, fixture.proposalEvidenceEventIds);
  await appendAll(ledger, lifecycle.events);
  const portable = await abstractDesignLearning(
    fixture.learning,
    ledger,
    lifecycle.proposal.workId,
    lifecycle.proposal.id,
  );
  return { ...fixture, ...lifecycle, portable };
}

test("design context is smallest-sufficient and revalidates local plus portable learning", async () => {
  const ledger = new InMemoryEventLedger();
  const fixture = await portableMcgruderLearning(ledger);
  const knowledge = [universal, fixture.portable, fixture.learning];
  assert.deepEqual(
    (await selectDesignContext(
      knowledge,
      { scope: "rhiz-first-party", surfaceId: "surface:world" },
      ledger,
    )).map((x) => x.id),
    [universal.id, fixture.portable.id],
  );
  assert.deepEqual(
    (await selectDesignContext(
      knowledge,
      { scope: "brand", surfaceId: "surface:mcgruder-home", brandId: "brand:mcgruder" },
      ledger,
    )).map((x) => x.id),
    [universal.id, fixture.portable.id, fixture.learning.id],
  );
  assert.deepEqual(
    (await selectDesignContext(
      knowledge,
      { scope: "brand", surfaceId: "surface:field-home", brandId: "brand:field-studio" },
      ledger,
    )).map((x) => x.id),
    [universal.id, fixture.portable.id],
  );
});

test("fabricated local and abstract objects cannot enter prompt context", async () => {
  for (const [learning, target, code] of [
    [fakeRhiz, { scope: "rhiz-first-party", surfaceId: "surface:world" }, "DESIGN_SOURCE_LEARNING_TAMPERED"],
    [fakeBrand, { scope: "brand", surfaceId: "surface:mcgruder", brandId: "brand:mcgruder" }, "DESIGN_SOURCE_LEARNING_TAMPERED"],
    [fabricatedAbstract, { scope: "brand", surfaceId: "surface:field", brandId: "brand:field" }, "DESIGN_ABSTRACTION_NOT_PROPOSED"],
  ] as const) {
    await assert.rejects(
      selectDesignContext([learning], target, new InMemoryEventLedger()),
      (e: unknown) => e instanceof DesignPolicyError && e.code === code,
    );
  }
});

test("a later rejection revokes a previously portable lesson at selection", async () => {
  const ledger = new InMemoryEventLedger();
  const fixture = await portableMcgruderLearning(ledger);
  await ledger.append(
    event(
      "refiner.rejected",
      {
        proposalId: fixture.proposal.id,
        workId: fixture.proposal.workId,
        rejectedBy: human,
        rationale: "Portable lesson withdrawn after later review.",
      },
      { actor: human },
    ),
  );
  await assert.rejects(
    selectDesignContext(
      [fixture.portable],
      { scope: "brand", surfaceId: "surface:field", brandId: "brand:field" },
      ledger,
    ),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_INVALID",
  );
});

test("portable lifecycle must bind an actually accepted source learning", async () => {
  const ledger = new InMemoryEventLedger();
  const real = await acceptedMcgruderLearning(ledger);
  const fakeLifecycle = abstractionEvents(fakeBrand, real.proposalEvidenceEventIds);
  await appendAll(ledger, fakeLifecycle.events);
  const acceptedEvent = fakeLifecycle.events[1]!;
  const promotedEvent = fakeLifecycle.events.at(-1)!;
  const portable = AbstractDesignLearningSchema.parse({
    id: "learning:abstract:forged-source",
    scope: "abstract",
    kind: "pattern",
    statement: "Portable wording backed by a fake local source.",
    evidenceRefs: [acceptedEvent.id, promotedEvent.id],
    sourceLearningIds: [fakeBrand.id],
    sourceAcceptance: fakeBrand.acceptance,
    promotion: {
      workId: fakeLifecycle.proposal.workId,
      proposalId: fakeLifecycle.proposal.id,
      acceptedEventId: acceptedEvent.id,
      promotedEventId: promotedEvent.id,
    },
    createdAt: promotedEvent.recordedAt,
  });
  await assert.rejects(
    selectDesignContext(
      [portable],
      { scope: "brand", surfaceId: "surface:field", brandId: "brand:field" },
      ledger,
    ),
    (e: unknown) =>
      e instanceof DesignPolicyError &&
      (e.code === "DESIGN_ABSTRACTION_SOURCE_INVALID" || e.code === "ACCEPTANCE_EVIDENCE_MISSING"),
  );
});

test("direct cross-brand, brand-to-universal, and Rhiz-to-brand promotion fail", () => {
  assert.throws(
    () => assertDesignPromotion(
      { scope: "brand", brandId: "brand:mcgruder" },
      { scope: "brand", brandId: "brand:field-studio" },
    ),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "BRAND_LEAKAGE",
  );
  assert.throws(
    () => assertDesignPromotion({ scope: "brand", brandId: "brand:mcgruder" }, { scope: "universal" }),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "BRAND_LEAKAGE",
  );
  assert.throws(
    () => assertDesignPromotion(
      { scope: "rhiz-first-party" },
      { scope: "brand", brandId: "brand:mcgruder" },
    ),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "FIRST_PARTY_LEAKAGE",
  );
});

test("anti-AI suspicions are caller-owned review triggers", () => {
  const findings = reviewDesignSignals(
    ["centered-hero", "card-everything", "custom-brand-typography"],
    [
      { id: "p1", signal: "centered-hero", rationale: "Require a reason." },
      { id: "p2", signal: "card-everything", rationale: "Require meaningful grouping." },
    ],
  );
  assert.deepEqual(findings.map((x) => x.signal), ["centered-hero", "card-everything"]);
});

test("Board acceptance attests the exact design receipt and learning claim", async () => {
  const ledger = new InMemoryEventLedger();
  const { learning } = await acceptedMcgruderLearning(ledger);
  assert.equal(learning.brandId, "brand:mcgruder");
  assert.ok(learning.evidenceRefs.includes(learning.acceptance.receiptId));
  assert.ok(learning.evidenceRefs.includes(learning.acceptance.acceptanceEventId));
});

test("receipt evidence reserves derived capacity and maximum id length", async () => {
  const maximumId = mcgruderReceipt({ id: "r".repeat(200) });
  const maximumIdEvidence = designReceiptEvidenceRefs(maximumId);
  assert.ok(maximumIdEvidence.every((item) => item.id.length <= 200));
  assert.doesNotThrow(() =>
    event(
      "work.accepted",
      { reason: "Maximum length receipt evidence.", contractRevision: 1 },
      { evidence: maximumIdEvidence },
    ),
  );

  const refs62 = Array.from({ length: 62 }, (_, i) => `evidence:${i}`);
  const ledger = new InMemoryEventLedger();
  const receipt62 = mcgruderReceipt({
    id: "receipt:capacity-62",
    acceptanceEventId: "event:design-accepted:capacity-62",
    evidenceRefs: refs62,
  });
  const verification = passingVerificationSequence();
  const acceptedEvent = event(
    "work.accepted",
    { reason: "Capacity boundary.", contractRevision: 1 },
    { id: receipt62.acceptanceEventId, evidence: designReceiptEvidenceRefs(receipt62) },
  );
  await appendAll(ledger, [...successfulExecution(), ...verification, acceptedEvent]);
  const learning = await learningFromAcceptedReceipt(receipt62, ledger);
  assert.equal(learning.evidenceRefs.length, 64);
  assert.throws(() => mcgruderReceipt({ evidenceRefs: [...refs62, "evidence:63"] }));
});

test("a different receipt cannot borrow another candidate's acceptance", async () => {
  const ledger = new InMemoryEventLedger();
  const original = mcgruderReceipt({
    id: "receipt:original",
    candidateId: "candidate:original",
    acceptanceEventId: "event:design-accepted:borrow-test",
  });
  const verification = passingVerificationSequence();
  const acceptedEvent = event(
    "work.accepted",
    { reason: "Accept original design receipt.", contractRevision: 1 },
    { id: original.acceptanceEventId, evidence: designReceiptEvidenceRefs(original) },
  );
  await appendAll(ledger, [...successfulExecution(), ...verification, acceptedEvent]);
  const forged = mcgruderReceipt({
    id: "receipt:forged",
    candidateId: "candidate:forged",
    acceptanceEventId: original.acceptanceEventId,
    learning: {
      id: "learning:forged",
      kind: "pattern",
      statement: "A different lesson trying to borrow the original acceptance.",
      expressionRefs: [],
    },
  });
  await assert.rejects(
    learningFromAcceptedReceipt(forged, ledger),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_RECEIPT_NOT_ATTESTED",
  );
});

test("premature and worker self-acceptance cannot create local learning", async () => {
  for (const mode of ["premature", "self"] as const) {
    const ledger = new InMemoryEventLedger();
    const receipt = mcgruderReceipt({
      id: `receipt:${mode}`,
      acceptanceEventId: `event:design-accepted:${mode}`,
    });
    const acceptedEvent = event(
      "work.accepted",
      { reason: mode, contractRevision: 1 },
      {
        id: receipt.acceptanceEventId,
        actor: mode === "self" ? worker : human,
        evidence: designReceiptEvidenceRefs(receipt),
      },
    );
    const proof = mode === "self" ? passingVerificationSequence() : [];
    await appendAll(ledger, [...successfulExecution(), ...proof, acceptedEvent]);
    await assert.rejects(
      learningFromAcceptedReceipt(receipt, ledger),
      (e: unknown) => e instanceof DesignPolicyError && e.code === "INVALID_ACCEPTANCE_EVIDENCE",
    );
  }
});

test("rejected receipts cannot become successful learning", async () => {
  const receipt = DesignReceiptSchema.parse({
    id: "receipt:rejected",
    workId: "work:1",
    candidateId: "candidate:rejected",
    target: { scope: "rhiz-first-party", surfaceId: "surface:world" },
    learning: {
      id: "learning:rejected",
      kind: "pattern",
      statement: "Do not learn this rejected expression.",
      expressionRefs: [],
    },
    decision: "rejected",
    evidenceRefs: ["evidence:review"],
    rationale: "Structurally generic.",
    recordedAt: now,
  });
  await assert.rejects(
    learningFromAcceptedReceipt(receipt, new InMemoryEventLedger()),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "UNACCEPTED_DESIGN_LEARNING",
  );
});

test("signature cannot itself become abstract learning", () => {
  assert.throws(() => DesignAbstractionSchema.parse({
    id: "learning:abstract:bad-signature",
    sourceLearning: {
      scope: "brand",
      brandId: "brand:mcgruder",
      id: "learning:source",
      kind: "signature",
      statement: "Local signature.",
      expressionRefs: ["artifact:signature"],
    },
    sourceAcceptance: fixtureAcceptance,
    kind: "signature",
    statement: "Copy the signature everywhere.",
  }));
});

test("accepted and promoted abstraction preserves provenance without local expression", async () => {
  const ledger = new InMemoryEventLedger();
  const fixture = await portableMcgruderLearning(ledger);
  assert.equal(fixture.portable.scope, "abstract");
  assert.equal(fixture.portable.kind, "pattern");
  assert.deepEqual(fixture.portable.sourceLearningIds, [fixture.learning.id]);
  assert.equal(fixture.portable.statement, "For provenance-heavy stories, make lineage directly explorable.");
  assert.equal("expressionRefs" in fixture.portable, false);
  assert.deepEqual(fixture.portable.sourceAcceptance, fixture.learning.acceptance);
});

test("tampered or acceptance-less local learning cannot become abstract", async () => {
  const ledger = new InMemoryEventLedger();
  const fixture = await acceptedMcgruderLearning(ledger);
  const tampered = BrandDesignLearningSchema.parse({
    ...fixture.learning,
    statement: "A replacement statement that was never accepted.",
  });
  await assert.rejects(
    abstractDesignLearning(tampered, ledger, "work:1", "proposal:any"),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_SOURCE_LEARNING_TAMPERED",
  );
  const missing = BrandDesignLearningSchema.parse({
    ...fixture.learning,
    acceptance: { ...fixture.learning.acceptance, acceptanceEventId: "event:missing" },
  });
  await assert.rejects(
    abstractDesignLearning(missing, ledger, "work:1", "proposal:any"),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "ACCEPTANCE_EVIDENCE_MISSING",
  );
});

test("proposal actor provenance and unique proposal identity are required", async () => {
  const ledgerA = new InMemoryEventLedger();
  const fixtureA = await acceptedMcgruderLearning(ledgerA);
  const forgedActor = abstractionEvents(fixtureA.learning, fixtureA.proposalEvidenceEventIds, {
    proposedActor: human,
  });
  await appendAll(ledgerA, forgedActor.events);
  await assert.rejects(
    abstractDesignLearning(fixtureA.learning, ledgerA, forgedActor.proposal.workId, forgedActor.proposal.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_INVALID",
  );

  const ledgerB = new InMemoryEventLedger();
  const fixtureB = await acceptedMcgruderLearning(ledgerB);
  const lifecycle = abstractionEvents(fixtureB.learning, fixtureB.proposalEvidenceEventIds);
  const duplicate = event(
    "refiner.proposed",
    { proposal: { ...lifecycle.proposal, title: "Different draft, same proposal id" } },
    { actor: lifecycle.proposal.proposedBy },
  );
  await appendAll(ledgerB, [lifecycle.events[0]!, duplicate, ...lifecycle.events.slice(1)]);
  await assert.rejects(
    abstractDesignLearning(fixtureB.learning, ledgerB, lifecycle.proposal.workId, lifecycle.proposal.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_DUPLICATE_PROPOSAL",
  );
});

test("withdrawn abstraction cannot be promoted", async () => {
  const ledger = new InMemoryEventLedger();
  const fixture = await acceptedMcgruderLearning(ledger);
  const lifecycle = abstractionEvents(fixture.learning, fixture.proposalEvidenceEventIds, {
    rejectAfterAcceptance: true,
  });
  await appendAll(ledger, lifecycle.events);
  await assert.rejects(
    abstractDesignLearning(fixture.learning, ledger, lifecycle.proposal.workId, lifecycle.proposal.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_NOT_ACCEPTED",
  );
});

test("replayed proposals pass Refiner guards and cite durable unique bounded evidence", async () => {
  const ledgerA = new InMemoryEventLedger();
  const fixtureA = await acceptedMcgruderLearning(ledgerA);
  const valid = makeAbstractionProposal(fixtureA.learning, fixtureA.proposalEvidenceEventIds);
  const tooThin: RefinerProposal = { ...valid, evidenceRefs: valid.evidenceRefs.slice(0, 1) };
  const thinLifecycle = abstractionEvents(fixtureA.learning, fixtureA.proposalEvidenceEventIds, { proposal: tooThin });
  await appendAll(ledgerA, thinLifecycle.events);
  await assert.rejects(
    abstractDesignLearning(fixtureA.learning, ledgerA, tooThin.workId, tooThin.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_INVALID",
  );

  const ledgerB = new InMemoryEventLedger();
  const fixtureB = await acceptedMcgruderLearning(ledgerB);
  const missing = makeAbstractionProposal(fixtureB.learning, ["event:fake:1", "event:fake:2"]);
  const missingLifecycle = abstractionEvents(fixtureB.learning, fixtureB.proposalEvidenceEventIds, { proposal: missing });
  await appendAll(ledgerB, missingLifecycle.events);
  await assert.rejects(
    abstractDesignLearning(fixtureB.learning, ledgerB, missing.workId, missing.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
  );

  const ledgerC = new InMemoryEventLedger();
  const fixtureC = await acceptedMcgruderLearning(ledgerC);
  const repeatedBase = makeAbstractionProposal(fixtureC.learning, fixtureC.proposalEvidenceEventIds);
  const repeated: RefinerProposal = {
    ...repeatedBase,
    evidenceRefs: [repeatedBase.evidenceRefs[0]!, repeatedBase.evidenceRefs[0]!],
  };
  const repeatedLifecycle = abstractionEvents(fixtureC.learning, fixtureC.proposalEvidenceEventIds, { proposal: repeated });
  await appendAll(ledgerC, repeatedLifecycle.events);
  await assert.rejects(
    abstractDesignLearning(fixtureC.learning, ledgerC, repeated.workId, repeated.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
  );

  const ledgerD = new InMemoryEventLedger();
  const fixtureD = await acceptedMcgruderLearning(ledgerD);
  const overCapacity = makeAbstractionProposal(fixtureD.learning, fixtureD.proposalEvidenceEventIds);
  const expanded: RefinerProposal = {
    ...overCapacity,
    evidenceRefs: Array.from({ length: 63 }, (_, i) => ({
      ledgerEventId: `evidence:over-capacity:${i}`,
      reasoning: "Capacity falsifier.",
    })),
  };
  const expandedLifecycle = abstractionEvents(fixtureD.learning, fixtureD.proposalEvidenceEventIds, { proposal: expanded });
  await appendAll(ledgerD, expandedLifecycle.events);
  await assert.rejects(
    abstractDesignLearning(fixtureD.learning, ledgerD, expanded.workId, expanded.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
  );
});

test("proposal cannot self-accept and must be promoted to the exact reversible surface", async () => {
  for (const mode of ["self", "none", "wrong", "irreversible"] as const) {
    const ledger = new InMemoryEventLedger();
    const fixture = await acceptedMcgruderLearning(ledger);
    const lifecycle = abstractionEvents(fixture.learning, fixture.proposalEvidenceEventIds, {
      acceptedBy: mode === "self" ? worker : reviewer,
      includePromotion: mode !== "none",
      appliedSurface: mode === "wrong" ? "some-other-surface" : undefined,
      irreversible: mode === "irreversible",
    });
    await appendAll(ledger, lifecycle.events);
    const expected =
      mode === "self"
        ? "DESIGN_ABSTRACTION_REVIEW_NOT_INDEPENDENT"
        : mode === "none"
          ? "DESIGN_ABSTRACTION_NOT_PROMOTED"
          : mode === "wrong"
            ? "DESIGN_ABSTRACTION_WRONG_SURFACE"
            : "DESIGN_ABSTRACTION_IRREVERSIBLE";
    await assert.rejects(
      abstractDesignLearning(fixture.learning, ledger, lifecycle.proposal.workId, lifecycle.proposal.id),
      (e: unknown) => e instanceof DesignPolicyError && e.code === expected,
    );
  }
});

test("reversal window must remain open at durable promotion time", async () => {
  const ledger = new InMemoryEventLedger();
  const fixture = await acceptedMcgruderLearning(ledger);
  const base = makeAbstractionProposal(fixture.learning, fixture.proposalEvidenceEventIds);
  const expiring: RefinerProposal = {
    ...base,
    draft: { ...base.draft, reversibleUntil: "2026-08-20T04:00:02.000Z" },
  };
  const lifecycle = abstractionEvents(fixture.learning, fixture.proposalEvidenceEventIds, {
    proposal: expiring,
    promotionRecordedAt: "2026-08-20T04:00:03.000Z",
  });
  await appendAll(ledger, lifecycle.events);
  await assert.rejects(
    abstractDesignLearning(fixture.learning, ledger, expiring.workId, expiring.id),
    (e: unknown) => e instanceof DesignPolicyError && e.code === "DESIGN_ABSTRACTION_REVERSAL_EXPIRED",
  );
});

test("accepted local learning is reconstructible from exact receipt evidence", async () => {
  const ledger = new InMemoryEventLedger();
  const fixture = await acceptedMcgruderLearning(ledger);
  const events = await ledger.replay(streamIdForWork(fixture.learning.acceptance.workId));
  const acceptance = events.find((x) => x.id === fixture.learning.acceptance.acceptanceEventId);
  assert.ok(acceptance);
  assert.ok(
    acceptance.evidence.some(
      (x) => x.id === fixture.learning.acceptance.receiptId && x.digest === fixture.learning.acceptance.receiptDigest,
    ),
  );
  assert.ok(
    acceptance.evidence.some(
      (x) => x.kind === "artifact-identity" && x.digest === fixture.learning.acceptance.learningDigest,
    ),
  );
});
