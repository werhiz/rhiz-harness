import { createHash } from "node:crypto";
import { z } from "zod";
import { projectBoard } from "./board.js";
import type {
  EventAppendProvenance,
  EventLedger,
  LedgerRecord,
} from "./ledger.js";
import {
  DEFAULT_REFINER_CONFIG,
  runProposalGuards,
  streamIdForWork,
} from "./refiner.js";
import type { EvidenceRef, HarnessEvent, RefinerProposal } from "./schemas.js";

const id = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(4000);
const evidenceRefs = z.array(id).min(1).max(64);
const receiptEvidenceRefs = z.array(id).min(1).max(62);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const DesignTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("rhiz-first-party"), surfaceId: id }).strict(),
  z.object({
    scope: z.literal("brand"),
    surfaceId: id,
    brandId: id,
  }).strict(),
]);
export type DesignTarget = z.infer<typeof DesignTargetSchema>;

export const BrandGenomeSchema = z.object({
  id,
  name: shortText,
  worldview: text,
  audience: z.array(shortText).max(32).default([]),
  principles: z.array(shortText).max(32).default([]),
  signatureMoves: z.array(shortText).max(16).default([]),
  avoid: z.array(shortText).max(32).default([]),
  referenceRefs: z.array(id).max(64).default([]),
}).strict();
export type BrandGenome = z.infer<typeof BrandGenomeSchema>;

export const DesignLearningKindSchema = z.enum([
  "principle",
  "anti-pattern",
  "pattern",
  "interaction",
  "motion",
  "accessibility",
  "performance",
  "signature",
]);
export type DesignLearningKind = z.infer<typeof DesignLearningKindSchema>;

export const AbstractableDesignLearningKindSchema = z.enum([
  "principle",
  "anti-pattern",
  "pattern",
  "interaction",
  "motion",
  "accessibility",
  "performance",
]);
export type AbstractableDesignLearningKind = z.infer<
  typeof AbstractableDesignLearningKindSchema
>;

const localLearningDraftFields = {
  id,
  kind: DesignLearningKindSchema,
  statement: text,
  expressionRefs: z.array(id).max(64).default([]),
};

export const LocalDesignLearningDraftSchema = z
  .object(localLearningDraftFields)
  .strict();
export type LocalDesignLearningDraft = z.infer<
  typeof LocalDesignLearningDraftSchema
>;

const LocalDesignLearningClaimSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("rhiz-first-party"),
      ...localLearningDraftFields,
      evidenceRefs,
    })
    .strict(),
  z
    .object({
      scope: z.literal("brand"),
      brandId: id,
      ...localLearningDraftFields,
      evidenceRefs,
    })
    .strict(),
]);
type LocalDesignLearningClaim = z.infer<
  typeof LocalDesignLearningClaimSchema
>;

const DesignAcceptanceRefSchema = z
  .object({
    workId: id,
    acceptanceEventId: id,
    receiptId: id,
    receiptDigest: sha256,
    learningDigest: sha256,
  })
  .strict();
export type DesignAcceptanceRef = z.infer<typeof DesignAcceptanceRefSchema>;

const DesignPromotionRefSchema = z
  .object({
    workId: id,
    proposalId: id,
    acceptedEventId: id,
    promotedEventId: id,
  })
  .strict();

const learningBase = {
  id,
  kind: DesignLearningKindSchema,
  statement: text,
  evidenceRefs,
  createdAt: z.iso.datetime({ offset: true }),
};

export const UniversalDesignLearningSchema = z
  .object({
    ...learningBase,
    kind: AbstractableDesignLearningKindSchema,
    scope: z.literal("universal"),
  })
  .strict();
export type UniversalDesignLearning = z.infer<
  typeof UniversalDesignLearningSchema
>;

export const RhizDesignLearningSchema = z
  .object({
    ...learningBase,
    scope: z.literal("rhiz-first-party"),
    acceptance: DesignAcceptanceRefSchema,
    expressionRefs: z.array(id).max(64).default([]),
  })
  .strict();
export type RhizDesignLearning = z.infer<typeof RhizDesignLearningSchema>;

export const BrandDesignLearningSchema = z
  .object({
    ...learningBase,
    scope: z.literal("brand"),
    brandId: id,
    acceptance: DesignAcceptanceRefSchema,
    expressionRefs: z.array(id).max(64).default([]),
  })
  .strict();
export type BrandDesignLearning = z.infer<typeof BrandDesignLearningSchema>;

export const AbstractDesignLearningSchema = z
  .object({
    ...learningBase,
    kind: AbstractableDesignLearningKindSchema,
    scope: z.literal("abstract"),
    sourceLearningIds: z.array(id).length(1),
    sourceAcceptance: DesignAcceptanceRefSchema,
    promotion: DesignPromotionRefSchema,
  })
  .strict();
export type AbstractDesignLearning = z.infer<
  typeof AbstractDesignLearningSchema
>;

export const DesignLearningSchema = z.discriminatedUnion("scope", [
  UniversalDesignLearningSchema,
  RhizDesignLearningSchema,
  BrandDesignLearningSchema,
  AbstractDesignLearningSchema,
]);
export type DesignLearning = z.infer<typeof DesignLearningSchema>;

const designReceiptBase = {
  id,
  workId: id,
  candidateId: id,
  target: DesignTargetSchema,
  learning: LocalDesignLearningDraftSchema,
  evidenceRefs: receiptEvidenceRefs,
  observedSignals: z.array(id).max(64).default([]),
  signatureMove: shortText.optional(),
  rationale: text,
  recordedAt: z.iso.datetime({ offset: true }),
};

export const DesignReceiptSchema = z.discriminatedUnion("decision", [
  z
    .object({
      ...designReceiptBase,
      decision: z.literal("accepted"),
      acceptanceEventId: id,
    })
    .strict(),
  z
    .object({
      ...designReceiptBase,
      decision: z.literal("rejected"),
    })
    .strict(),
]);
export type DesignReceipt = z.infer<typeof DesignReceiptSchema>;

export const DesignSuspicionSchema = z
  .object({ id, signal: id, rationale: shortText })
  .strict();
export type DesignSuspicion = z.infer<typeof DesignSuspicionSchema>;

export const DesignAbstractionSchema = z
  .object({
    id,
    sourceLearning: LocalDesignLearningClaimSchema,
    sourceAcceptance: DesignAcceptanceRefSchema,
    kind: AbstractableDesignLearningKindSchema,
    statement: text,
  })
  .strict();
export type DesignAbstraction = z.infer<typeof DesignAbstractionSchema>;

export const DESIGN_ABSTRACTION_SURFACE =
  "design-intelligence:abstract" as const;
export const DESIGN_ABSTRACTION_PROPOSAL_KIND = "lesson-fixture" as const;

export class DesignPolicyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DesignPolicyError";
  }
}

function designLearningApplies(
  learning: DesignLearning,
  target: DesignTarget,
): boolean {
  switch (learning.scope) {
    case "universal":
    case "abstract":
      return true;
    case "rhiz-first-party":
      return target.scope === "rhiz-first-party";
    case "brand":
      return target.scope === "brand" && target.brandId === learning.brandId;
  }
}

type LedgerWithRecords = EventLedger & {
  records(afterGlobalSequence?: number): AsyncIterable<LedgerRecord>;
};

function hasRecords(ledger: EventLedger): ledger is LedgerWithRecords {
  return typeof (ledger as { records?: unknown }).records === "function";
}

async function appendProvenance(
  ledger: EventLedger,
  eventId: string,
): Promise<EventAppendProvenance> {
  if (ledger.provenanceForEvent) {
    const direct = await ledger.provenanceForEvent(eventId);
    if (direct) return direct;
  }
  if (hasRecords(ledger)) {
    for await (const record of ledger.records()) {
      if (record.event.id !== eventId) continue;
      return {
        eventId,
        streamId: record.event.streamId,
        globalSequence: record.globalSequence,
        streamSequence: record.streamSequence,
        appendedAt: record.appendedAt,
      };
    }
  }
  throw new DesignPolicyError(
    `ledger append provenance for event ${eventId} is unavailable`,
    "LEDGER_APPEND_PROVENANCE_MISSING",
  );
}

export async function selectDesignContext(
  knowledge: readonly DesignLearning[],
  target: DesignTarget,
  ledger: EventLedger,
): Promise<DesignLearning[]> {
  const selected: DesignLearning[] = [];
  for (const learning of knowledge) {
    if (!designLearningApplies(learning, target)) continue;
    if (learning.scope === "abstract") {
      await assertAbstractDesignLearningCurrent(learning, ledger);
    } else if (
      learning.scope === "rhiz-first-party" ||
      learning.scope === "brand"
    ) {
      await assertLocalDesignLearningCurrent(learning, ledger);
    }
    selected.push(learning);
  }
  return selected;
}

export function reviewDesignSignals(
  signals: readonly string[],
  suspicions: readonly DesignSuspicion[],
): DesignSuspicion[] {
  const observed = new Set(signals);
  return suspicions.filter((suspicion) => observed.has(suspicion.signal));
}

type ScopeRef =
  | { scope: "universal" | "abstract" | "rhiz-first-party" }
  | { scope: "brand"; brandId: string };

export function assertDesignPromotion(
  source: ScopeRef,
  target: ScopeRef,
): void {
  if (source.scope === "brand") {
    if (target.scope === "abstract") return;
    if (target.scope === "brand" && target.brandId === source.brandId) return;
    throw new DesignPolicyError(
      "brand-local design learning may only stay with its brand or be abstracted",
      "BRAND_LEAKAGE",
    );
  }
  if (source.scope === "rhiz-first-party") {
    if (
      target.scope === "rhiz-first-party" ||
      target.scope === "abstract"
    ) {
      return;
    }
    throw new DesignPolicyError(
      "Rhiz first-party expression may only stay first-party or be abstracted",
      "FIRST_PARTY_LEAKAGE",
    );
  }
  if (source.scope === target.scope) return;
  throw new DesignPolicyError(
    "portable learning cannot silently broaden scope",
    "UNREVIEWED_SCOPE_PROMOTION",
  );
}

function digestHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: unknown): string {
  return `sha256:${digestHex(JSON.stringify(value))}`;
}

function uniqueRefs(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())];
}

function localLearningEvidenceRefs(receipt: DesignReceipt): string[] {
  return receipt.decision === "accepted"
    ? uniqueRefs(receipt.evidenceRefs, [receipt.id, receipt.acceptanceEventId])
    : uniqueRefs(receipt.evidenceRefs, [receipt.id]);
}

function localLearningClaim(receipt: DesignReceipt): LocalDesignLearningClaim {
  const claim = {
    ...receipt.learning,
    evidenceRefs: localLearningEvidenceRefs(receipt),
  };
  return LocalDesignLearningClaimSchema.parse(
    receipt.target.scope === "rhiz-first-party"
      ? { scope: "rhiz-first-party", ...claim }
      : {
          scope: "brand",
          brandId: receipt.target.brandId,
          ...claim,
        },
  );
}

function localLearningClaimFromLearning(
  learning: RhizDesignLearning | BrandDesignLearning,
): LocalDesignLearningClaim {
  const draft = {
    id: learning.id,
    kind: learning.kind,
    statement: learning.statement,
    expressionRefs: learning.expressionRefs,
    evidenceRefs: learning.evidenceRefs,
  };
  return LocalDesignLearningClaimSchema.parse(
    learning.scope === "rhiz-first-party"
      ? { scope: "rhiz-first-party", ...draft }
      : {
          scope: "brand",
          brandId: learning.brandId,
          ...draft,
        },
  );
}

function learningEvidenceId(receiptId: string): string {
  return `design-learning:${digestHex(receiptId)}`;
}

export function designReceiptDigest(receipt: DesignReceipt): string {
  return digestJson(DesignReceiptSchema.parse(receipt));
}

export function designLocalLearningDigest(receipt: DesignReceipt): string {
  return digestJson(localLearningClaim(DesignReceiptSchema.parse(receipt)));
}

export function designReceiptEvidenceRefs(
  receipt: DesignReceipt,
): EvidenceRef[] {
  const parsed = DesignReceiptSchema.parse(receipt);
  return [
    {
      id: parsed.id,
      kind: "receipt",
      uri: `design-receipt:${parsed.id}`,
      digest: designReceiptDigest(parsed),
    },
    {
      id: learningEvidenceId(parsed.id),
      kind: "artifact-identity",
      uri: `design-receipt:${parsed.id}#learning`,
      digest: designLocalLearningDigest(parsed),
    },
  ];
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function matchingEvidence(event: HarnessEvent, expected: EvidenceRef): boolean {
  return event.evidence.some(
    (item) =>
      item.id === expected.id &&
      item.kind === expected.kind &&
      item.uri === expected.uri &&
      item.digest === expected.digest,
  );
}

type AcceptedWorkEvidence = {
  event: Extract<HarnessEvent, { type: "work.accepted" }>;
  provenance: EventAppendProvenance;
};

async function acceptedWorkEvent(
  reference: DesignAcceptanceRef,
  ledger: EventLedger,
): Promise<AcceptedWorkEvidence> {
  const events = await ledger.replay(streamIdForWork(reference.workId));
  const acceptanceIndex = events.findIndex(
    (event) => event.id === reference.acceptanceEventId,
  );
  if (acceptanceIndex < 0) {
    throw new DesignPolicyError(
      `acceptance event ${reference.acceptanceEventId} is not present on Work ${reference.workId}`,
      "ACCEPTANCE_EVIDENCE_MISSING",
    );
  }

  const acceptance = events[acceptanceIndex]!;
  if (
    acceptance.type !== "work.accepted" ||
    acceptance.workId !== reference.workId ||
    acceptance.streamId !== streamIdForWork(reference.workId)
  ) {
    throw new DesignPolicyError(
      `event ${reference.acceptanceEventId} is not the Work acceptance named by the design evidence`,
      "INVALID_ACCEPTANCE_EVIDENCE",
    );
  }

  const receiptEvidence: EvidenceRef = {
    id: reference.receiptId,
    kind: "receipt",
    uri: `design-receipt:${reference.receiptId}`,
    digest: reference.receiptDigest,
  };
  const learningEvidence: EvidenceRef = {
    id: learningEvidenceId(reference.receiptId),
    kind: "artifact-identity",
    uri: `design-receipt:${reference.receiptId}#learning`,
    digest: reference.learningDigest,
  };
  if (
    !matchingEvidence(acceptance, receiptEvidence) ||
    !matchingEvidence(acceptance, learningEvidence)
  ) {
    throw new DesignPolicyError(
      `event ${reference.acceptanceEventId} does not attest the exact design receipt and learning claim`,
      "DESIGN_RECEIPT_NOT_ATTESTED",
    );
  }

  const board = projectBoard(events.slice(0, acceptanceIndex + 1));
  if (
    board.state !== "accepted" ||
    board.violations.some((item) => item.eventId === acceptance.id) ||
    board.acceptedBy?.id !== acceptance.actor.id ||
    board.acceptedBy?.kind !== acceptance.actor.kind
  ) {
    throw new DesignPolicyError(
      `event ${reference.acceptanceEventId} did not produce valid Board acceptance`,
      "INVALID_ACCEPTANCE_EVIDENCE",
    );
  }
  return {
    event: acceptance,
    provenance: await appendProvenance(ledger, acceptance.id),
  };
}

async function assertLocalDesignLearningCurrent(
  learning: RhizDesignLearning | BrandDesignLearning,
  ledger: EventLedger,
): Promise<void> {
  if (
    digestJson(localLearningClaimFromLearning(learning)) !==
    learning.acceptance.learningDigest
  ) {
    throw new DesignPolicyError(
      `local design learning ${learning.id} no longer matches its accepted learning evidence`,
      "DESIGN_SOURCE_LEARNING_TAMPERED",
    );
  }
  const acceptance = await acceptedWorkEvent(learning.acceptance, ledger);
  if (learning.createdAt !== acceptance.provenance.appendedAt) {
    throw new DesignPolicyError(
      `local design learning ${learning.id} has a createdAt that does not match ledger acceptance provenance`,
      "DESIGN_SOURCE_LEARNING_TAMPERED",
    );
  }
}

export async function learningFromAcceptedReceipt(
  receipt: DesignReceipt,
  ledger: EventLedger,
): Promise<RhizDesignLearning | BrandDesignLearning> {
  if (receipt.decision !== "accepted") {
    throw new DesignPolicyError(
      "only Board-accepted design outcomes may become local design learning",
      "UNACCEPTED_DESIGN_LEARNING",
    );
  }

  const reference = DesignAcceptanceRefSchema.parse({
    workId: receipt.workId,
    acceptanceEventId: receipt.acceptanceEventId,
    receiptId: receipt.id,
    receiptDigest: designReceiptDigest(receipt),
    learningDigest: designLocalLearningDigest(receipt),
  });
  const acceptance = await acceptedWorkEvent(reference, ledger);
  const common = {
    ...receipt.learning,
    evidenceRefs: localLearningEvidenceRefs(receipt),
    createdAt: acceptance.provenance.appendedAt,
    acceptance: reference,
  };
  return receipt.target.scope === "rhiz-first-party"
    ? RhizDesignLearningSchema.parse({
        ...common,
        scope: "rhiz-first-party",
      })
    : BrandDesignLearningSchema.parse({
        ...common,
        scope: "brand",
        brandId: receipt.target.brandId,
      });
}

export function designAbstractionDraftPayload(
  source: RhizDesignLearning | BrandDesignLearning,
  input: {
    id: string;
    kind: AbstractableDesignLearningKind;
    statement: string;
  },
): { designAbstraction: DesignAbstraction } {
  assertDesignPromotion(
    source.scope === "brand"
      ? { scope: "brand", brandId: source.brandId }
      : { scope: "rhiz-first-party" },
    { scope: "abstract" },
  );
  return {
    designAbstraction: DesignAbstractionSchema.parse({
      ...input,
      sourceLearning: localLearningClaimFromLearning(source),
      sourceAcceptance: source.acceptance,
    }),
  };
}

function assertReplaySafeRefinerProposal(proposal: RefinerProposal): void {
  try {
    runProposalGuards(proposal, {
      ...DEFAULT_REFINER_CONFIG,
      requireReversibleUntil: false,
    });
  } catch (error) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposal.id} fails proposal guards: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "DESIGN_ABSTRACTION_INVALID",
    );
  }
}

function assertProposalEvidence(
  proposal: RefinerProposal,
  events: readonly HarnessEvent[],
  proposedIndex: number,
): void {
  const ids = proposal.evidenceRefs.map((item) => item.ledgerEventId);
  if (ids.length > 62 || new Set(ids).size !== ids.length) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposal.id} evidence must be unique and leave room for acceptance/promotion provenance`,
      "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
    );
  }
  const expectedStreamId = streamIdForWork(proposal.workId);
  for (const evidenceId of ids) {
    const index = events.findIndex((event) => event.id === evidenceId);
    if (index < 0 || index >= proposedIndex) {
      throw new DesignPolicyError(
        `Refiner proposal ${proposal.id} evidence ${evidenceId} is missing or was not durable before proposal`,
        "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
      );
    }
    const evidenceEvent = events[index]!;
    if (
      evidenceEvent.workId !== proposal.workId ||
      evidenceEvent.streamId !== expectedStreamId
    ) {
      throw new DesignPolicyError(
        `Refiner proposal ${proposal.id} evidence ${evidenceId} does not belong to proposal Work ${proposal.workId}`,
        "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
      );
    }
    const board = projectBoard(events.slice(0, index + 1));
    if (board.violations.some((item) => item.eventId === evidenceEvent.id)) {
      throw new DesignPolicyError(
        `Refiner proposal ${proposal.id} evidence ${evidenceId} has invalid Work provenance`,
        "DESIGN_ABSTRACTION_EVIDENCE_INVALID",
      );
    }
  }
}

type AbstractionLifecycle = {
  abstraction: DesignAbstraction;
  proposal: RefinerProposal;
  acceptedEvent: Extract<HarnessEvent, { type: "refiner.accepted" }>;
  promotedEvent: Extract<HarnessEvent, { type: "refiner.promoted" }>;
  promotedAt: string;
  evidenceRefs: string[];
};

async function replayAbstractionLifecycle(
  ledger: EventLedger,
  workId: string,
  proposalId: string,
  expected?: AbstractDesignLearning,
): Promise<AbstractionLifecycle> {
  const events = await ledger.replay(streamIdForWork(workId));
  const proposalMatches = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.type === "refiner.proposed" &&
        event.workId === workId &&
        event.payload.proposal.id === proposalId,
    );
  if (proposalMatches.length === 0) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} is missing from Work ${workId}`,
      "DESIGN_ABSTRACTION_NOT_PROPOSED",
    );
  }
  if (proposalMatches.length !== 1) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} has ${proposalMatches.length} proposed events; identity is ambiguous`,
      "DESIGN_ABSTRACTION_DUPLICATE_PROPOSAL",
    );
  }

  const { event: proposedEvent, index: proposedIndex } = proposalMatches[0]!;
  if (proposedEvent.type !== "refiner.proposed") {
    throw new DesignPolicyError(
      "design abstraction proposal is malformed",
      "DESIGN_ABSTRACTION_INVALID",
    );
  }
  const proposal = proposedEvent.payload.proposal;
  if (
    proposal.workId !== workId ||
    proposal.status !== "proposed" ||
    proposal.kind !== DESIGN_ABSTRACTION_PROPOSAL_KIND ||
    proposedEvent.actor.id !== proposal.proposedBy.id ||
    proposedEvent.actor.kind !== proposal.proposedBy.kind
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} has invalid Work, status, kind, or proposer provenance`,
      "DESIGN_ABSTRACTION_INVALID",
    );
  }
  assertReplaySafeRefinerProposal(proposal);
  assertProposalEvidence(proposal, events, proposedIndex);
  const proposedProvenance = await appendProvenance(ledger, proposedEvent.id);

  const parsedAbstraction = DesignAbstractionSchema.safeParse(
    proposal.draft.draftPayload["designAbstraction"],
  );
  if (!parsedAbstraction.success) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} does not carry a valid design abstraction`,
      "DESIGN_ABSTRACTION_INVALID",
    );
  }
  const abstraction = parsedAbstraction.data;
  if (
    digestJson(abstraction.sourceLearning) !==
    abstraction.sourceAcceptance.learningDigest
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} source learning does not match its accepted learning digest`,
      "DESIGN_ABSTRACTION_SOURCE_INVALID",
    );
  }
  const sourceAcceptance = await acceptedWorkEvent(
    abstraction.sourceAcceptance,
    ledger,
  );
  if (
    sourceAcceptance.provenance.globalSequence >=
    proposedProvenance.globalSequence
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} was reviewed before its source design learning was durably accepted`,
      "DESIGN_ABSTRACTION_SOURCE_NOT_ACCEPTED_AT_PROPOSAL",
    );
  }

  const promotionMatches = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event, index }) =>
        index > proposedIndex &&
        event.type === "refiner.promoted" &&
        event.workId === workId &&
        event.payload.proposalId === proposalId,
    );
  if (promotionMatches.length === 0) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} has not been promoted`,
      "DESIGN_ABSTRACTION_NOT_PROMOTED",
    );
  }
  if (promotionMatches.length !== 1) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} has ${promotionMatches.length} promotion events; lifecycle is ambiguous`,
      "DESIGN_ABSTRACTION_INVALID",
    );
  }

  const { event: promotionCandidate, index: promotedIndex } =
    promotionMatches[0]!;
  if (promotionCandidate.type !== "refiner.promoted") {
    throw new DesignPolicyError(
      "design abstraction promotion is malformed",
      "DESIGN_ABSTRACTION_INVALID",
    );
  }
  const promotedEvent = promotionCandidate;
  const promotedProvenance = await appendProvenance(ledger, promotedEvent.id);

  const latestDecision = events
    .slice(proposedIndex + 1, promotedIndex)
    .filter(
      (event) =>
        (event.type === "refiner.accepted" ||
          event.type === "refiner.rejected") &&
        event.workId === workId &&
        event.payload.proposalId === proposalId,
    )
    .at(-1);
  if (!latestDecision || latestDecision.type !== "refiner.accepted") {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} was not accepted or was withdrawn before promotion`,
      "DESIGN_ABSTRACTION_NOT_ACCEPTED",
    );
  }
  const acceptedEvent = latestDecision;

  if (
    events.slice(promotedIndex + 1).some(
      (event) =>
        (event.type === "refiner.accepted" ||
          event.type === "refiner.rejected") &&
        event.workId === workId &&
        event.payload.proposalId === proposalId,
    )
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} has a contradictory decision after promotion`,
      "DESIGN_ABSTRACTION_INVALID",
    );
  }

  const acceptedBy = acceptedEvent.payload.acceptedBy;
  if (
    acceptedEvent.payload.workId !== workId ||
    acceptedEvent.actor.id !== acceptedBy.id ||
    acceptedEvent.actor.kind !== acceptedBy.kind ||
    (acceptedBy.kind !== "human" && acceptedBy.kind !== "verifier") ||
    acceptedBy.id === proposal.proposedBy.id
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} lacks an independent human or verifier acceptance`,
      "DESIGN_ABSTRACTION_REVIEW_NOT_INDEPENDENT",
    );
  }

  const promotedBy = promotedEvent.payload.promotedBy;
  if (
    promotedEvent.payload.workId !== workId ||
    promotedEvent.actor.id !== promotedBy.id ||
    promotedEvent.actor.kind !== promotedBy.kind ||
    (promotedBy.kind !== "human" && promotedBy.kind !== "verifier")
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} was not promoted by a human or verifier`,
      "DESIGN_ABSTRACTION_NOT_PROMOTED",
    );
  }
  if (
    promotedEvent.payload.appliedSurface !== DESIGN_ABSTRACTION_SURFACE
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} was promoted to ${promotedEvent.payload.appliedSurface}, not the design abstraction surface`,
      "DESIGN_ABSTRACTION_WRONG_SURFACE",
    );
  }
  if (promotedEvent.payload.irreversible) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} cannot make design learning irreversible`,
      "DESIGN_ABSTRACTION_IRREVERSIBLE",
    );
  }
  if (
    Date.parse(proposal.draft.reversibleUntil) <=
    Date.parse(promotedProvenance.appendedAt)
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} was promoted after its reversal window closed`,
      "DESIGN_ABSTRACTION_REVERSAL_EXPIRED",
    );
  }

  const canonicalEvidenceRefs = uniqueRefs(
    proposal.evidenceRefs.map((item) => item.ledgerEventId),
    [acceptedEvent.id, promotedEvent.id],
  );

  if (expected) {
    const sourceLearningId = expected.sourceLearningIds[0]!;
    if (
      expected.promotion.workId !== workId ||
      expected.promotion.proposalId !== proposalId ||
      expected.promotion.acceptedEventId !== acceptedEvent.id ||
      expected.promotion.promotedEventId !== promotedEvent.id ||
      expected.id !== abstraction.id ||
      expected.kind !== abstraction.kind ||
      expected.statement !== abstraction.statement ||
      sourceLearningId !== abstraction.sourceLearning.id ||
      digestJson(expected.sourceAcceptance) !==
        digestJson(abstraction.sourceAcceptance) ||
      expected.createdAt !== promotedProvenance.appendedAt ||
      !sameRefs(expected.evidenceRefs, canonicalEvidenceRefs)
    ) {
      throw new DesignPolicyError(
        `abstract design learning ${expected.id} no longer matches its promoted Refiner lifecycle`,
        "DESIGN_ABSTRACTION_STALE",
      );
    }
  }

  return {
    abstraction,
    proposal,
    acceptedEvent,
    promotedEvent,
    promotedAt: promotedProvenance.appendedAt,
    evidenceRefs: canonicalEvidenceRefs,
  };
}

export async function assertAbstractDesignLearningCurrent(
  learning: AbstractDesignLearning,
  ledger: EventLedger,
): Promise<void> {
  const parsed = AbstractDesignLearningSchema.parse(learning);
  await replayAbstractionLifecycle(
    ledger,
    parsed.promotion.workId,
    parsed.promotion.proposalId,
    parsed,
  );
}

export async function abstractDesignLearning(
  source: RhizDesignLearning | BrandDesignLearning,
  ledger: EventLedger,
  workId: string,
  proposalId: string,
): Promise<AbstractDesignLearning> {
  assertDesignPromotion(
    source.scope === "brand"
      ? { scope: "brand", brandId: source.brandId }
      : { scope: "rhiz-first-party" },
    { scope: "abstract" },
  );
  await assertLocalDesignLearningCurrent(source, ledger);

  const lifecycle = await replayAbstractionLifecycle(
    ledger,
    workId,
    proposalId,
  );
  if (
    digestJson(lifecycle.abstraction.sourceLearning) !==
      digestJson(localLearningClaimFromLearning(source)) ||
    digestJson(lifecycle.abstraction.sourceAcceptance) !==
      digestJson(source.acceptance)
  ) {
    throw new DesignPolicyError(
      `Refiner proposal ${proposalId} does not abstract the exact accepted local learning ${source.id}`,
      "DESIGN_ABSTRACTION_INVALID",
    );
  }

  return AbstractDesignLearningSchema.parse({
    id: lifecycle.abstraction.id,
    kind: lifecycle.abstraction.kind,
    statement: lifecycle.abstraction.statement,
    evidenceRefs: lifecycle.evidenceRefs,
    createdAt: lifecycle.promotedAt,
    scope: "abstract",
    sourceLearningIds: [source.id],
    sourceAcceptance: source.acceptance,
    promotion: {
      workId,
      proposalId,
      acceptedEventId: lifecycle.acceptedEvent.id,
      promotedEventId: lifecycle.promotedEvent.id,
    },
  });
}
