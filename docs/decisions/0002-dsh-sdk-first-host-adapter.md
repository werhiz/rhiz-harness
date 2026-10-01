# ADR 0002: DSH SDK is the first concrete HostAdapter boundary

Status: accepted for DSH HostAdapter v0

## Context

Rhiz Harness must use DeepSeek Harness (DSH) aggressively without allowing DSH to become the portable domain model. Kernel 0.1 therefore defines Rhiz-owned Host and Worker contracts and mechanically forbids DSH imports inside `src/`.

DSH exposes several useful seams. Its in-process `ctx.subagents` runtime is a strong named-provider registry with capability validation and lifecycle events, but its one-shot start contract requires a live DSH parent Agent. That parent carries DSH-specific lineage, cwd, cancellation, and authority semantics. Using it as the first Rhiz boundary would force Rhiz to manufacture or retain DSH Agent identity before the Host abstraction has earned that coupling.

DSH also publishes a TypeScript SDK client that owns a complete DSH runtime subprocess over stdio JSON-RPC. It creates legitimate root sessions, accepts prompts, streams durable session events and status notifications, and returns an owned activity interval when the root session next becomes idle.

## Decision

1. The first concrete DSH HostAdapter uses the public `@deepseek-ai/dsh-sdk-client` process boundary.
2. The DSH SDK dependency is optional and isolated under `adapters/dsh/`. The portable `src/` kernel contains no DSH import.
3. A DSH SDK activity interval implements one Rhiz `WorkerProvider` execution attempt. The DSH final response becomes a portable WorkerResult summary only. It never means verification or organizational acceptance.
4. DSH notifications are translated into bounded portable WorkerObservations. Raw protocol payloads do not become Rhiz canonical state.
5. The adapter advertises only capabilities directly reachable and controllable through the SDK boundary. For v0:
   - workers: true
   - sessions: true
   - processes: false
   - filesystem: false
   - sandbox: false
   - tools: false
6. The v0 WorkerProvider advertises `streamingObservations: true`, `cancel: false`, and `resume: false`. DSH SDK rc.8 has no mid-turn cancel or per-session resume contract that satisfies the Rhiz WorkerHandle semantics. Unsupported operations fail loud.
7. `HarnessHost` owns an explicit `close()` lifecycle so adapter-owned runtime processes cannot leak.
8. Compatibility is pinned to and tested against DSH SDK `0.1.0-rc.8`. DSH is a developer-preview upstream, so malformed or incompatible SDK data fails closed at the adapter boundary.
9. A later in-process DSH adapter may use `ctx.subagents`, shell, sandbox, jobs, or other Cordis capabilities behind the same Rhiz contracts if dogfood evidence shows that the tighter integration materially improves outcomes.

## Why not expose all DSH capabilities now?

DSH internally provides shell execution, tools, sandboxing, subprocesses, jobs, and subagents. The SDK-driven Rhiz host does not directly own or verify those services. Advertising them would make HostCapabilities describe what DSH might contain instead of what Rhiz can actually control. The adapter therefore remains intentionally conservative.

## Consequences

- Rhiz gets a real DSH execution path without inheriting DSH Agent identity in its portable Work contracts.
- The runtime process is replaceable and explicitly owned by the HostAdapter.
- The first adapter is narrower than DSH, but its capability claims are trustworthy.
- Mid-turn cancellation remains unavailable until DSH exposes it through the chosen boundary or Rhiz adds a different DSH adapter.
- DSH-specific implementation can evolve independently from Board, Ledger, Authority, Evidence, and Work semantics.

## Proof required before promotion

Adapter v0 is not considered production-proven until:

1. fake-SDK conformance tests pass on a clean runner;
2. the portable-core import guard remains green;
3. a real DSH `0.1.0-rc.8` runtime boots through the adapter;
4. one bounded WorkContract reaches WorkerResult through a real DSH activity interval;
5. DSH events are recorded as observations without mutating Board truth directly;
6. host shutdown demonstrably reaps the DSH subprocess;
7. the run is replayable through the Rhiz Ledger/Board path.
