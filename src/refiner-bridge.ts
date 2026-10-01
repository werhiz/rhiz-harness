import type { ActorRef, HarnessEvent, RefinerProposal, RefinerProposalKind } from "./schemas.js";
import type { EventLedger } from "./ledger.js";
import {
  analyzeClosedWorkFromEvents,
  buildProposedEvent,
  makeRefinerProposal,
  streamIdForWork,
  DEFAULT_REFINER_CONFIG,
  type RefinerAnalysis,
  type RefinerConfig,
  type FailureTaxonomy,
  type SuccessTaxonomy,
} from "./refiner.js";

/**
 * Consume a closed work's event stream and emit `refiner.proposed` events
 * for any candidate improvement kinds the analysis flagged.
 *
 * The Refiner does not silently rewrite policy. Every proposal goes
 * through the human / organizational review gate (`refiner.accepted` /
 * `refiner.rejected`) before it can become a permanent change.
 */
export class RefinerBridge {
  readonly #ledger: EventLedger;
  readonly #proposer: ActorRef;
  readonly #config: RefinerConfig;
  readonly #idFactory: () => string;
  readonly #now: () => string;

  constructor(options: RefinerBridgeOptions) {
    this.#ledger = options.ledger;
    this.#proposer = options.proposer ?? {
      id: "service:refiner-bridge",
      kind: "service",
    };
    this.#config = options.config ?? DEFAULT_REFINER_CONFIG;
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Analyze the events for one Work and emit one `refiner.proposed` event
   * per candidate improvement kind. The number of events emitted equals
   * the number of distinct `candidateProposalKinds` in the analysis
   * (zero when the run was clean).
   *
   * Returns the analysis so the caller can record it externally if it
   * wants to.
   */
  async consume(input: {
    workId: string;
    events: readonly HarnessEvent[];
  }): Promise<{ analysis: RefinerAnalysis; proposals: readonly RefinerProposal[] }> {
    const analysis = analyzeClosedWorkFromEvents(input.workId, input.events, this.#config);
    const streamId = streamIdForWork(input.workId);
    const proposals: RefinerProposal[] = [];
    for (const kind of new Set(analysis.candidateProposalKinds)) {
      const proposal = makeRefinerProposal({
        id: `proposal:${this.#idFactory()}`,
        workId: input.workId,
        kind: kind as RefinerProposalKind,
        title: proposalTitle(kind as RefinerProposalKind, analysis),
        summary: proposalSummary(kind as RefinerProposalKind, analysis),
        reasoning: `Classified as ${analysis.classifications.join(", ") || "no-classifications"}; ledger span ${analysis.ledgerSpanMs}ms over ${analysis.ledgerEventCount} events.`,
        classification: (analysis.classifications[0] ?? "repeated-mistake") as FailureTaxonomy | SuccessTaxonomy,
        evidenceRefs: input.events.length === 0
          ? []
          : input.events
              .slice(-3)
              .map((event) => ({
                ledgerEventId: event.id,
                reasoning: `${event.type} observed at ${event.occurredAt}`,
              })),
        draft: {
          summary: `Auto-drafted from ${analysis.classifications.join(", ") || "no-classifications"}.`,
          rationale: `Outcome: ${analysis.outcome}.`,
          reversibleUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
        proposedBy: this.#proposer,
        proposedAt: this.#now(),
      }, this.#config);
      const event = buildProposedEvent(
        proposal,
        `event:refiner:${this.#idFactory()}`,
        streamId,
        this.#now(),
        this.#now(),
      );
      await this.#ledger.append(event);
      proposals.push(proposal);
    }
    return { analysis, proposals };
  }
}

export interface RefinerBridgeOptions {
  ledger: EventLedger;
  /** Who is offering these proposals. Defaults to a service actor. */
  proposer?: ActorRef;
  config?: RefinerConfig;
  idFactory?: () => string;
  now?: () => string;
}

function proposalTitle(kind: RefinerProposalKind, analysis: RefinerAnalysis): string {
  return `${kind} candidate from ${analysis.outcome} run (${analysis.ledgerEventCount} events)`;
}

function proposalSummary(kind: RefinerProposalKind, analysis: RefinerAnalysis): string {
  const classifications = analysis.classifications.length > 0
    ? analysis.classifications.join(", ")
    : "no-classifications";
  return `Refiner proposes a ${kind} based on ${classifications}.`;
}
