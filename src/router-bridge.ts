import type { ActorRef } from "./schemas.js";
import type { EventLedger } from "./ledger.js";
import {
  routeWorker,
  routerDecisionToEvent,
  type RouterDecision,
  type RouterPolicy,
  type RouterPolicyInput,
  type RouterWorkerDescriptor,
  type RouterWorkerRegistry,
} from "./router.js";

/**
 * Build RouterWorkerDescriptors from the live host descriptors. The portable
 * RouterWorkerDescriptor requires cost, latency, and a role; when those are
 * not published by the underlying host, conservative defaults are used so
 * routing can still happen. A bridge that wants measured values should
 * override this with a real workerAdapter.
 */
export function defaultRouterWorkerDescriptor(
  workerId: string,
  hostDescriptor: {
    adapter: string;
    product?: string;
    supportedWorkTypes: readonly ("SCOUT" | "SHIP" | "REVIEW")[];
    writeAccess: string;
    capabilityTags?: readonly string[];
  },
): RouterWorkerDescriptor {
  const role: RouterWorkerDescriptor["role"] = hostDescriptor.writeAccess === "workspace"
    ? "shipper"
    : hostDescriptor.writeAccess === "unrestricted"
      ? "shipper"
      : "general";
  return {
    workerId,
    role,
    displayName: workerId,
    model: hostDescriptor.product ?? hostDescriptor.adapter,
    supportedWorkTypes: [...hostDescriptor.supportedWorkTypes],
    languages: [],
    maxContextTokens: 200_000,
    costPer1kTokensUsd: 0,
    avgLatencyMs: 0,
    capabilityTags: hostDescriptor.capabilityTags === undefined ? [] : [...hostDescriptor.capabilityTags],
    weight: 1,
  };
}

/**
 * Adapter from a host WorkerDescriptor to a RouterWorkerDescriptor. Optional
 * override point: callers can supply their own mapping when they have richer
 * telemetry (e.g., measured cost from a previous attempt).
 */
export type RouterWorkerAdapter = (workerId: string, descriptor: {
  adapter: string;
  product?: string;
  supportedWorkTypes: readonly ("SCOUT" | "SHIP" | "REVIEW")[];
  writeAccess: string;
  capabilityTags?: readonly string[];
}) => RouterWorkerDescriptor;

/**
 * Owns the RouterWorkerRegistry and the Ledger where RouterDecision events
 * are appended. CrewSupervisor delegates to one of these at mission start so
 * that worker selection can be evidence-driven rather than a first-eligible
 * walk over `preferredProviders`.
 */
export class RouterBridge {
  readonly #registry: RouterWorkerRegistry;
  readonly #ledger: EventLedger;
  readonly #policy: RouterPolicy | RouterPolicyInput | undefined;
  readonly #idFactory: () => string;
  readonly #now: () => Date;

  constructor(options: RouterBridgeOptions) {
    this.#registry = options.registry;
    this.#ledger = options.ledger;
    this.#policy = options.policy;
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  /** The registry the bridge owns. Useful for tests and for adapter setup. */
  get registry(): RouterWorkerRegistry {
    return this.#registry;
  }

  /**
   * Compute a RouterDecision for the given Work and append a
   * `router.decision-made` event. The selected worker id, if any, becomes
   * a binding hint for the resolver: a non-empty `preferredProviders`
   * still wins; an empty one uses the Router's selection.
   */
  async route(input: {
    work: import("./schemas.js").WorkContract;
    taskId: string;
    attemptId: string;
    streamId: string;
    actor: ActorRef;
  }): Promise<RouterDecision> {
    const decision = await routeWorker(
      this.#registry,
      this.#ledger,
      {
        contract: input.work,
        ...(this.#policy === undefined ? {} : { policy: this.#policy }),
      },
      this.#now,
    );
    const event = routerDecisionToEvent(decision, {
      id: `event:router:${this.#idFactory()}`,
      streamId: input.streamId,
      actor: { id: input.actor.id, kind: input.actor.kind === "service" ? "service" : "automation" },
      taskId: input.taskId,
      attemptId: input.attemptId,
    });
    await this.#ledger.append(event as Parameters<EventLedger["append"]>[0]);
    return decision;
  }
}

export interface RouterBridgeOptions {
  registry: RouterWorkerRegistry;
  ledger: EventLedger;
  policy?: RouterPolicy | RouterPolicyInput;
  idFactory?: () => string;
  now?: () => Date;
}
