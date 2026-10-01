# Hosts, Providers, and Integrations

Status: current integration guide. Exact interfaces live in `src/host.ts`, `src/workers.ts`, adapters, tests, and accepted ADRs.

## Portability rule

Rhiz Harness owns the Work, authority, verification, evidence, and acceptance semantics. Execution products sit behind replaceable interfaces.

```text
Portable Rhiz contracts
        |
        v
    HostAdapter
        |
        v
 concrete host / agent product / runtime
```

A host change should normally be absorbed by its adapter rather than forcing changes to WorkContract, Board, Ledger, Verify, Context, or Rules.

## Host

A `HarnessHost` exposes portable capabilities:

- worker registry;
- process provider;
- session provider;
- filesystem provider;
- sandbox provider;
- tool provider;
- lifecycle close.

Host capability declarations are checked against the providers the host actually exposes. A host cannot claim a capability while returning no provider for it.

## Worker provider

A `WorkerProvider` represents an execution actor such as Codex, Claude, a DSH-backed product worker, a local command worker, or a future ACP-compatible agent.

It supplies:

- stable provider id;
- optional descriptor;
- capabilities;
- `start()` for a bounded Attempt.

A returned `WorkerHandle` exposes observations, result, and cancellation.

Provider-specific diagnostics may be preserved as evidence. They do not redefine portable Work semantics.

## Worker descriptors

Descriptors communicate safety-relevant facts such as:

- product and adapter;
- execution mode;
- context inheritance;
- authority mode;
- write-access classification;
- dangerous classification;
- workspace binding support;
- credential environment names.

Missing description is handled conservatively. Unknown write or safety characteristics are not assumed safe.

## Workspace binding

Every Crew-launched worker receives a portable `WorkspaceBinding` containing:

- workspace id;
- lease id;
- URI;
- absolute execution root;
- read-only or isolated-write mode;
- base revision;
- optional expected head and digest.

A provider that claims `bindsWorkspace` must execute inside that exact root. Providers that choose their own working directory must declare otherwise and are refused for workspace-owning missions.

## Runtime-only options

Serializable Work data and runtime wiring are deliberately separate.

`WorkerStartRequest` contains durable, serializable execution inputs. `WorkerStartOptions` carries runtime-only mechanisms such as the Guard mediation callback.

This prevents an in-memory permission function from being confused with durable authority data.

## DeepSeek Harness

DSH is the first Host because its plugin architecture, sessions, tools, jobs, sandboxes, terminals, subprocesses, and subagent seams provide useful execution substrate.

The DSH adapter is an anti-corruption layer. DSH types remain below the portable boundary.

Current operator commands include:

```bash
npm run setup:dsh-products
npm run proof:dsh-products
npm run smoke:dsh
npm run smoke:dsh-products
```

See existing DSH-specific references:

- [DSH Product Worker Routes v0](DSH_PRODUCT_WORKER_ROUTES_V0.md)
- [DSH Product Operator Proof v0](DSH_PRODUCT_OPERATOR_PROOF_V0.md)

## Codex App Server

The Codex adapter provides a direct live Worker path through the Codex App Server.

The real canary exercises:

```text
WorkContract
-> Crew
-> Git worktree
-> Codex App Server
-> native Guard mediation
-> exact changed-path check
-> durable Ledger reopen
```

Run it with:

```bash
npm run canary:codex
```

Override the binary with `RHIZ_CODEX_COMMAND` when needed.

The repository Work runner also uses this adapter for real external repository Work.

## Git adapter

The Git adapter owns repository-specific workspace mechanics beneath portable workspace contracts.

Current responsibilities include:

- isolated detached worktrees;
- exact base revision identity;
- workspace snapshots and digests;
- changed-path detection;
- candidate preservation;
- rescue and verified candidate refs;
- checkpoint support;
- candidate path scopes derived from Work resources.

Git mechanics do not become Board semantics. They supply artifact and workspace evidence to the portable system.

## Local adapters

Current local adapters include:

### Durable Ledger

File-backed hash-chained event storage with replay, integrity, audit, and recovery behavior.

### Local command verifier

Runs explicit executable plus argv without shell interpolation, under bounded output/time/environment policy, and emits digest-addressed evidence.

### Local command worker

Provides a local worker implementation for appropriate proof/testing paths.

### Local sandbox

Supplies local containment behavior beneath the portable sandbox interface.

## Rhiz Protocol

Rhiz Protocol is a major Customer Zero and consumer of Rhiz Harness.

Dependency direction is:

```text
rhizprotocol
    |
    v
rhiz-harness
```

Rhiz Protocol may provide organization-specific:

- Rules;
- Context sources;
- graph data;
- authority policy;
- verification profiles;
- deployment adapters;
- repository integrations;
- product plugins.

The standalone Harness must function without Rhiz Protocol.

## Adding a new worker

A new worker integration should:

1. implement the portable provider contract;
2. use a stable provider id;
3. describe safety-relevant capabilities truthfully;
4. bind to the supplied workspace or declare that it cannot;
5. expose Guard mediation if the provider supports consequential native effects;
6. translate observations/results into portable schemas;
7. preserve useful raw diagnostics through safe evidence references;
8. fail closed when required host capabilities are absent;
9. add compatibility and adversarial tests;
10. add provenance for adapted upstream code or architecture.

## Adding a new Host

A Host adapter should prove:

- capability declarations match real providers;
- portable Work runs without host-specific types leaking upward;
- provider errors are translated predictably;
- cancellation and cleanup semantics match advertised capabilities;
- workspace and authority claims are enforced at the real host seams;
- failure of one optional capability does not corrupt unrelated portable state;
- version compatibility is explicit.

## Integration principle

Prefer open documented boundaries when they meet the need. ACP, MCP, and future interoperable protocols can be integrated behind the same portable contracts.

Portability does not mean lowest-common-denominator behavior. Provider-specific capabilities may be exposed explicitly as capabilities while core Work meaning remains stable.