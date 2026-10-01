# Workers v0

Workers v0 makes execution actors discoverable, comparable, and safely startable without giving any worker authority over verification or acceptance.

## Scope

- portable Worker catalog;
- transactional Host contribution;
- unique worker identity;
- deterministic preference and fallback ordering;
- capability-aware selection;
- provider-specific rejection diagnostics;
- runtime validation around start, observations, results, and cancellation.

## Acceptance gate

Workers v0 is proven when:

- two or more providers can coexist in one catalog;
- duplicate identities fail closed;
- a partially colliding Host registration leaves no partial workers behind;
- Work preference order is honored;
- an incapable preferred provider yields to a capable fallback with a recorded reason;
- no capable provider produces a typed selection failure;
- a handle for the wrong Attempt is rejected;
- malformed observations and results cannot cross the portable boundary;
- cancellation behavior matches advertised capability;
- all prior Kernel and DSH integration proof remains green.

## Deferred

- learned routing;
- model/provider quality scores;
- cost and latency optimization;
- retries and attempt budgets;
- concurrent admission control;
- persistent worker inventory;
- Codex and Claude production credentials;
- Crew task decomposition and supervision.

## Descriptors are mandatory in practice (issue #18, 2026-08-20)

`describe()` is still optional on the interface for compatibility, but silence is
no longer read as safety. A provider that publishes no descriptor is synthesised
as `dangerous: true`, `writeAccess: "unrestricted"`, `bindsWorkspace: false`, and
is therefore rejected for SCOUT, SHIP and REVIEW alike.

`writeAccess: "host-policy"` is no longer accepted for any mission type. It means
"we do not know", and for a system whose thesis is bounded authority the unknown
case has to resolve to denial. Note that SCOUT and REVIEW contracts are already
forbidden from carrying any `writeScope`, which made accepting an unknown write
classification for them internally inconsistent.

The single override is `workerPolicy.explicitProviderAuthorizations`: it names an
exact provider id, requires a human actor, rejects duplicates, and is enforced in
a schema refinement rather than merely typed. It deliberately cannot buy
`bindsWorkspace`. Authorising a provider you trust is a different claim from that
provider being able to execute where it was told.

## Workspace binding (issue #9, 2026-08-20)

`WorkerStartRequest.workspace` is required and carries a `WorkspaceBinding`.
Providers execute in `binding.executionRoot`. Host-level `cwd` is gone rather
than defaulted, and there is no `process.cwd()` fallback for Crew-launched work.
A provider that cannot guarantee this must declare `bindsWorkspace: false` and
will be refused for any mission that owns a workspace.

See `docs/decisions/0013-execution-integrity.md`.

## Guarded tool mediation (issue #40, 2026-08-24)

`WorkerCapabilities.guardedToolMediation` declares that the provider awaits a
Guard verdict at its native permission hook and does not effect a `forbid`. It
defaults to `false`, and `WorkerSelectionRequirements.requireGuardedToolMediation`
— which Crew sets for every `isolated-write` mission — refuses any provider that
does not declare it. No `explicitProviderAuthorizations` entry buys it: a
provider with no synchronous return channel has no enforcement seam to authorise.
The verdict arrives through `WorkerStartOptions`, not through the serializable
`WorkerStartRequest`.

See `docs/decisions/0008-policy-oracle.md`.
