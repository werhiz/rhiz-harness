# 0011. Router v0.1 — evidence-based worker/model selection

Status: **accepted**, 2026-08-20.

## Context

Compound Engineering Plan §14 calls for Router as the ninth kernel surface.
The Plan is explicit: "Initially record routing decisions before making aggressive
automatic choices" and "Routing must be evidence-based rather than reputation-based."

The Kernel 0.1 already exposes the surfaces the Router needs to read:

- `WorkContract.type` (`SCOUT` | `SHIP` | `REVIEW`) is the primary input for
  capability matching.
- `WorkContract.workerPolicy.preferredProviders` is the soft-preference channel.
- `EventLedger` records the full Work history needed to replay Board state;
  individual completion, verification, and review events are not standalone
  Router outcomes.
- `InMemoryEventLedger` is sufficient for v0.1; the Router does not need a
  durable ledger to derive evidence.
- `HarnessEventSchema` is a discriminated union the Router extends with a single
  new event type (`router.decision-made`).

The Constitution §10 ("prefer mechanical, deterministic supervision before
spending model tokens") requires the v0.1 Router to be **deterministic and
offline**. No model tokens are spent by the Router itself.

## Decision

Add `src/router.ts` (the Router module) and a single new event type
`router.decision-made` to `HarnessEventSchema`.

The Router module exports:

- **`RouterWorkerDescriptorSchema`** — the typed product surface the Router
  needs (role, supported work types, languages, max context, cost per 1k
  tokens, average latency, region, capability tags, optional notes, weight).
  Workers must declare this descriptor to be eligible for routing.
- **`RouterWorkerRegistry`** interface (`list`, `get`, `query`) plus
  `InMemoryRouterWorkerRegistry` (lexicographic ordering, deterministic).
- **`RouterPolicySchema`** — discriminated union of four policy kinds:
  - `cheapest-capable` — minimize cost per 1k tokens.
  - `fastest-capable` — minimize average latency.
  - `highest-confidence` — maximize confidence derived from accepted outcomes
    and terminal failures, with independent current-revision verification
    required for success.
  - `balanced` — weighted score across success rate, cost inverse, duration
    inverse, and confidence (default weights: 0.4 / 0.3 / 0.3 / 0.0).
- **`RouterEvidenceSchema`** — per-worker stats:
  `attemptCount`, `successCount`, `failedCount`, `successRate`,
  `medianCostUsd`, `p95CostUsd`, `medianDurationMs`, `p95DurationMs`,
  `confidence`, `lastSeenAt`.
- **`RouterDecisionSchema`** — the typed decision record:
  `id`, `workId`, `taskId?`, `attemptId?`, `policy`, `considered[]`,
  `selected`, `rationale`, `evidenceHash`, `expectedCostUsd`,
  `expectedDurationMs`, `decidedAt`. The schema's `superRefine` enforces:
  - the selected worker (if any) appears in `considered`,
  - the rationale matches the selected state,
  - the `evidenceHash` matches `sha256:[a-f0-9]{64}`.
- **`RouterDecisionRationaleSchema`** — discriminated union:
  `selected | no-capable-worker | no-evidence | policy-denied`.
- **`computeRouterEvidence(ledger, options)`** — derives per-worker evidence
  by replaying each Work's full event history through the canonical Board
  projection. A finished Attempt is not a success: success requires an
  accepted Work, a current-revision passing verification selected by
  `acceptanceReadiness`, an independent verifier, and a current finished
  Attempt. Deterministic: the same `(ledger, options)` produces the same
  evidence.
- **`routeWorker(registry, ledger | null, input, now)`** — pure, deterministic
  router. Same `(registry, ledger, contract, policy, options)` produces the
  same decision byte-for-byte (apart from `decidedAt`, which is the only
  clock-dependent field).
- **`routerDecisionToEvent(decision, eventInput)`** — emits a
  `router.decision-made` event from a decision.

### Capability filter

A worker is matched iff `worker.supportedWorkTypes.includes(contract.type)`.
A worker is excluded iff it appears in `options.excludeProviders`. The
filter is hard: an unmatched or excluded worker cannot be selected.

### Scoring algorithm

For each matched worker:

```
weight = preferredWeight(workerId, preferredProviders) * worker.weight
bonus = 0.1 if workerId in preferredProviders else 0

cheapest-capable:
  score = normalizeInverse(cost, maxCost) * weight + bonus

fastest-capable:
  score = normalizeInverse(latency, maxLatency) * weight + bonus

highest-confidence:
  score = (evidence.confidence ?? 0) * weight + bonus

balanced:
  score = (
    w.successRate * (evidence.successRate ?? 0.5)
    + w.costInverse * normalizeInverse(cost, maxCost)
    + w.durationInverse * normalizeInverse(latency, maxLatency)
    + w.confidence * (evidence.confidence ?? 0)
  ) * weight + bonus
```

Tie-breaker: lexicographic on `workerId`. Deterministic.

### Evidence derivation

`computeRouterEvidence` reads the configured streams as candidate full Work
histories and replays them through `projectEvent`. Duplicate event IDs within
a Work view are counted once. If one Work ID appears in multiple streams, the
history is ambiguous and contributes no evidence; the Router does not stitch
partial or competing streams together. Events rejected by Board projection do
not establish attempt state.

Evidence is attributed only to unique actors in each admitted Attempt's
`executionProvenance`; task assignment, verification, and review actors do
not earn executor credit. Each admitted attempt with a started event counts
once for each unique executor, including unresolved attempts. Success requires
all of the following: Board state is accepted; `acceptanceReadiness` selects a
passing verification for the current contract revision; that verifier is not
an execution actor for the Work; and the executor's attempt is finished,
current-revision, and the latest attempt for its task. A self-proof acceptance
or acceptance without qualifying verification earns no success.

`failedCount` records a Board-admitted failed Attempt, or a current finished
Attempt when the Work was rejected. Success and such terminal failure produce
confidence signals of 1 and 0 respectively. Unresolved attempts contribute
to `attemptCount` but have no confidence signal; absent evidence remains
unknown. Duration is measured from the admitted `attempt.started.occurredAt`
to the admitted terminal `attempt.finished.occurredAt` or
`attempt.failed.occurredAt`. Negative or invalid elapsed durations are
omitted. `lastSeenAt` is the latest `occurredAt` among admitted attempt events
and a terminal Board acceptance or rejection relevant to that outcome.

### Determinism

The router is a pure function with respect to `(registry, ledger, contract,
policy, options, now)`. Two routes with the same inputs produce the same
`RouterDecision` byte-for-byte apart from `decidedAt`. The `evidenceHash`
is `sha256(JSON.stringify({contractId, workType, policy, options, considered}))`
— a content-addressed fingerprint that changes iff any input changes.

### Composition with the rest of the kernel

- **Guard v0.1** (`feat/guard-v0`, PR #8): the caller is expected to call
  `PolicyOracle.evaluate(contract, decision)` after the Router emits a
  decision. If denied, the decision is discarded and the Router's
  `policy-denied` rationale is logged.
- **Refiner v1** (`feat/refiner-v1`, PR #24): a `RefinerProposal` carrying
  `targetWorker` becomes a soft preference through the `preferredProviders`
  channel. The Router does not import Refiner types.
- **Context v0.1** (`feat/context-v0`, PR #25): the Router reads `contract.context`
  for the `expectedTokens` channel but does not import Context types.
- **Ledger v1** (`feat/ledger-v1`, PR #7): the Router reads from the existing
  Ledger interface and emits a single new event type additively.

### Independent parallel branches

The Router does not import Guard, Refiner, or Context. The four modules
(Guard, Refiner, Context, Router) share only `WorkContract`, `HarnessEvent`,
and `EventLedger` (all in the portable core). The Router's PR can be merged
in any order relative to the other three.

## Consequences

### Positive

- The Kernel 0.1 now exposes a typed, deterministic, evidence-based Router.
- Every decision carries a stable `evidenceHash` so that downstream consumers
  can compare two decisions without parsing the full payload.
- The four policy kinds match the canonical vocabulary of the Compound
  Engineering Plan §14 ("cheapest-capable | fastest-capable | highest-confidence
  | balanced").
- `router.decision-made` is a single additive event type; no schema migration.
- Every Router surface is portable; `scripts/check-portable-boundary.mjs` PASS.

### Negative

- Evidence requires a complete, unambiguous per-Work stream. Sparse or
  multi-stream histories conservatively withhold evidence rather than
  reconstructing a synthetic Board history.
- The Router does not currently call `PolicyOracle` itself; the caller is
  responsible for the guard composition. A follow-up PR can fold that into
  the Router for ergonomics.
- No bandit exploration, no model-profile lookup, no LLM-assisted routing —
  these are deferred to v0.2.
- The Router depends on the discriminated union carrying a new event type
  (`router.decision-made`); if a future PR removes that event type, the
  Router's `routerDecisionToEvent` helper breaks.

## Out of scope for v0.1

- OTel OTTL expressions for declarative routing rules — v0.2 PR with a
  `RouterExpression` schema.
- `langchain-model-profiles` as a capability data source — v0.2 PR behind a
  `RouterConfig.profileProvider` flag.
- LLM-assisted routing — v0.2 PR behind `RouterConfig.advisorModel`.
- Adaptive bandit exploration — v0.2 PR with a β-prior over worker success rates.
- Direct Guard composition inside the Router — separate v0.2 PR with a
  `routeWorkerWithGuard` wrapper.

## Compliance

- **Constitution §8 (context is engineered):** ✓ — the smallest sufficient
  Router surface for v0.1 is deterministic; no model tokens are spent.
- **Constitution §10 (mechanical supervision):** ✓ — the Router is a pure
  deterministic function of its inputs.
- **Constitution §13 (open protocols at boundaries):** ✓ — the Router
  exposes a typed policy surface; every consumer calls the same function.
- **Constitution §16 (provenance is a product feature):** ✓ —
  `provenance/router.yaml` records the derivation.
- **AGENTS.md non-negotiable** ("portable core MUST NOT import DSH, Rhiz
  Protocol, or any concrete host/runtime"): ✓ — `src/router.ts` imports
  the portable Board projection, Ledger interface, schemas, and `node:crypto`.
  Verified by `npm run check:portable-boundary`.
- **Compound Engineering Plan §14:** ✓ — the four policy kinds match the
  Plan's vocabulary, and the evidence surface matches the Plan's required
  captured fields.
