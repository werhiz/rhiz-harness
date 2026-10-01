# ADR 0003: Portable Worker catalog and deterministic selection

Status: accepted for Workers v0

## Context

Kernel 0.1 defines a portable `WorkerProvider` seam, and the DSH HostAdapter proves one concrete worker can execute through it. A usable Harness needs to combine workers from multiple Hosts, select among them without provider-specific assumptions, and reject dishonest or malformed provider behavior before it enters Board or Ledger state.

The later Router will learn which worker performs each task class best. Workers v0 needs a smaller deterministic foundation that the Router can eventually replace or augment.

## Decision

1. Worker identity is globally unique within a `WorkerCatalog`.
2. Hosts contribute WorkerProviders transactionally. Any identity collision rolls back the entire Host registration.
3. Worker selection is deterministic:
   - exact `WorkContract.workerPolicy.preferredProviders` order first;
   - all remaining providers in stable lexical identity order;
   - capability requirements applied before selection.
4. Provider capability discovery is runtime validated. A broken provider is rejected with diagnostics and does not silently win selection.
5. Selection records why earlier candidates were rejected.
6. Every started worker is wrapped at the portable boundary:
   - request is runtime validated;
   - provider and handle identities are checked;
   - the handle must remain bound to the requested Attempt;
   - observations and terminal results are runtime validated;
   - cancellation is available only when the provider truthfully advertises it.
7. Worker completion remains execution evidence. It never verifies or accepts Work.
8. Workers v0 performs no learned ranking, cost optimization, automatic retries, or task-class inference. Those belong to Router and Crew after sufficient evidence exists.

## Consequences

- DSH, Codex, Claude, OpenCode, local agents, and future Hosts can enter the same WorkerCatalog.
- Provider-specific capabilities remain behind adapters.
- The Harness can fail over from an incapable preferred worker to a capable fallback while preserving a reasoned audit trail.
- Misbound Attempts and malformed outputs fail before reaching canonical organizational state.
- Router can later consume the same catalog and selection evidence without changing WorkerProvider contracts.
