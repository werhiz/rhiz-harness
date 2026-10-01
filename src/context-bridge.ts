import type { ActorRef } from "./schemas.js";
import type { EventLedger } from "./ledger.js";
import {
  composeContextPack,
  DEFAULT_CONTEXT_CONFIG,
  type ContextCompositionOptions,
  type ContextConfig,
  type ContextPack,
  type ContextTaskClass,
  type ContextStrategy,
} from "./context.js";

/**
 * Material the bridge needs to build a ContextPack. The portable core
 * cannot reach into the filesystem, so a host adapter is responsible for
 * filling these fields from the live workspace, the ledger, the rules
 * catalog, and the architecture docs.
 */
export interface ContextBridgeSource {
  files: ContextCompositionOptions["fileContents"];
  symbols: ContextCompositionOptions["selectedSymbols"];
  history: ContextCompositionOptions["historyEvents"];
  rules: ContextCompositionOptions["rules"];
  architectureDocs: ContextCompositionOptions["architectureDocs"];
  skills: ContextCompositionOptions["skills"];
}

/**
 * Compute a ContextPack for one Work and persist the selection as a
 * `context.pack-selected` event. The pack itself is returned to the
 * caller (currently Crew) which can carry it into the worker or store
 * it for replay; the event carries the identity and shape so a replay
 * can reconstruct what was selected without re-running the bridge.
 */
export class ContextBridge {
  readonly #ledger: EventLedger;
  readonly #source: ContextBridgeSource;
  readonly #config: ContextConfig;
  readonly #idFactory: () => string;
  readonly #now: () => Date;

  constructor(options: ContextBridgeOptions) {
    this.#ledger = options.ledger;
    this.#source = options.source;
    this.#config = options.config ?? DEFAULT_CONTEXT_CONFIG;
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Build a ContextPack for the given Work, persist it, and return it.
   * The returned pack has the full fragment list; the event records
   * only the identity and shape.
   */
  async select(input: {
    work: import("./schemas.js").WorkContract;
    taskId: string;
    attemptId: string;
    streamId: string;
    actor: ActorRef;
  }): Promise<ContextPack> {
    const pack = composeContextPack(
      input.work,
      input.taskId,
      input.attemptId,
      {
        fileContents: this.#source.files,
        selectedSymbols: this.#source.symbols,
        historyEvents: this.#source.history,
        rules: this.#source.rules,
        architectureDocs: this.#source.architectureDocs,
        skills: this.#source.skills,
      },
      this.#config,
      this.#now,
    );
    const digest = packDigest(pack);
    await this.#ledger.append({
      id: `event:context:${this.#idFactory()}`,
      schemaVersion: 1,
      type: "context.pack-selected",
      streamId: input.streamId,
      workId: input.work.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      actor: { id: input.actor.id, kind: "automation" },
      occurredAt: this.#now().toISOString(),
      recordedAt: this.#now().toISOString(),
      evidence: [],
      payload: {
        packId: pack.id,
        digest,
        taskClass: pack.taskClass as ContextTaskClass,
        strategy: pack.strategy as ContextStrategy,
        totalTokens: pack.totalTokens,
        fragmentCount: pack.fragments.length,
        markers: pack.markers,
      },
    } as Parameters<EventLedger["append"]>[0]);
    return pack;
  }
}

export interface ContextBridgeOptions {
  ledger: EventLedger;
  source: ContextBridgeSource;
  config?: ContextConfig;
  idFactory?: () => string;
  now?: () => Date;
}

function packDigest(pack: ContextPack): string {
  // Cheap, deterministic, content-derived identity. We hash the markers
  // and total tokens rather than the full fragment bodies to keep the
  // event payload bounded; full-content digests live with the pack itself.
  const material = `${pack.markers.join("|")}::${pack.totalTokens}`;
  // A simple FNV-1a 32-bit hash expressed in hex. Good enough for
  // identity, not a security primitive.
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `ctx-fnva1:${hash.toString(16).padStart(8, "0")}`;
}
