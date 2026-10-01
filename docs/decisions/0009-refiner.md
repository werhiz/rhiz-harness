# ADR 0009: Refiner — proposal/accept/reject/promote lifecycle

Status: accepted for Kernel 0.2 / Refiner v0

Supersedes nothing. Implements the Compound Engineering Plan §7 evidence-backed improvement proposal lifecycle. Refines Constitution §16 (provenance is a product feature) and Plan §22 (guard against self-corruption). The full taxonomy and lifecycle design are recorded below; the Open Source Architecture Scout (2026-08-20) provided the upstream evidence (failure/success taxonomy shape from `first-fluke/oh-my-agent`).

## Context

The Compound Engineering Plan §7 says: "Every consequential Work item answers five questions: What happened? What evidence proves it? What surprised us? What should the system learn? What should permanently change?" §7 also lists possible permanent outputs: "Rule, Guard, Test, Verifier, Context strategy, Routing policy, Worker profile, Tool, Capability, Documentation, Benchmark, Architecture decision, Recovery behavior." §22 forbids "no automatic Constitution modification; no automatic weakening of security/authority boundaries; no permanent Rule from one low-confidence event; no routing optimization across incomparable tasks; no benchmark improvement through weaker acceptance criteria; no worker self-certification; all promoted learning must be attributable to evidence; improvements must be reversible; regression benchmarks must remain available; stale rules/lessons may be retired; humans retain authority over consequential policy."

The Refiner operationalises §7 + §22. It analyzes closed Work, classifies outcomes against the failure and success taxonomies, generates typed proposals backed by evidence, and routes every proposal through a five-state lifecycle (proposed → accepted → rejected → superseded → promoted). A promotion is the only change that mutates a permanent Rhiz surface; promotions require a human or verifier actor (§22), a typed `appliedSurface`, and an explicit `irreversible` flag.

The taxonomy is taken verbatim from the Compound Engineering Plan §6 (failure and success enumerations). The lifecycle is Rhiz-native; the closest upstream analogue is `first-fluke/oh-my-agent`'s `cli/state/{artifact-verifier,decision-verifier}.ts` (MIT), which is the only public project that ships a `REQUIRED_DECISIONS` table similar in shape to `RefinerProposal`. The Scout recommends `study` (not `derive`) for `oh-my-agent`'s orchestrator, but `adapt concepts` for the verifier schemas — Rhiz's lifecycle is inspired by but does not copy that code.

## Decision

We add a portable Refiner module (`src/refiner.ts`) that:

1. Re-exports the new `RefinerProposalSchema`, `RefinerDraftSchema`, `RefinerEvidenceRefSchema`, `RefinerProposalStatusSchema`, `RefinerProposalKindSchema` (added to `src/schemas.ts`).
2. Extends the portable `HarnessEventSchema` discriminated union with four new event types: `refiner.proposed`, `refiner.accepted`, `refiner.rejected`, `refiner.promoted`. Each event carries enough payload to reconstruct the proposal's state without re-reading the parent proposal event.
3. Defines the failure and success taxonomies as readonly tuple literals — 19 failure entries and 12 success entries, verbatim from the Compound Engineering Plan §6.
4. Defines `RefinerConfig` with §22 toggles (default `true` for every guard):
   - `forbidConstitutionAmendments`
   - `forbidAuthorityWeakening`
   - `forbidRoutingOptimization`
   - `forbidBenchmarkAcceptanceWeakening`
   - `forbidWorkerSelfCertification`
   - `requireReversibleUntil`
   - `minEvidenceCount` (default 2)
5. Defines `runProposalGuards(proposal, config)` — runs all §22 guards on a proposal. Any violation throws `RefinerGuardViolationError` with the named guard from `RefinerGuard`.
6. Defines the primitives:
   - `analyzeClosedWork(workId, ledger, config)` — reads events from the Ledger, classifies, returns `RefinerAnalysis`.
   - `makeRefinerProposal(input, config)` — typed constructor; runs guards; throws on §22 violation.
   - `recordProposal(proposal, ledger, eventId, now)` — appends `refiner.proposed` to the Ledger.
   - `acceptProposal(proposalId, workId, acceptedBy, rationale, ledger, eventId, now)` — appends `refiner.accepted`. Refuses agents with empty rationale.
   - `rejectProposal(...)` — appends `refiner.rejected`.
   - `promoteProposal(proposalId, workId, promotedBy, appliedSurface, irreversible, ledger, eventId, now)` — appends `refiner.promoted`. Refuses agents (humans or verifiers only).
   - `findProposalInLedger(proposalId, ledger, workId)` — projection helper.
7. Defines the four error classes: `RefinerError`, `RefinerGuardViolationError`, `RefinerConfigurationError`, `RefinerLifecycleError`. Each carries a stable `code` and a stable `name`.

The Refiner does not actually mutate any surface on `promote`. v0.1 records the promotion event and returns it; the actual application of a rule or guard-tuning is the responsibility of a separate consumer (a future PR). This separation is mandatory: the Refiner is the *proposal* machine, not the *applicator* machine. The Compound Engineering Plan §22 ("humans retain authority over consequential policy") and Plan §22 ("improvements must be reversible") make this clear.

## Consequences

Positive:
- Every proposal is evidence-bound (≥1 ledger event Id) and the analysis is reproducible from the Ledger.
- Every promotion is reversible — promotions carry an `appliedSurface` and an `irreversible` flag; reversals are a separate event in the Ledger.
- The §22 guards are mechanically enforced at proposal construction time, not at apply time. A proposal that violates §22 cannot be appended to the Ledger.
- The portable `HarnessEventSchema` discriminated union now includes Refiner events, so any consumer that reads the Ledger can react to them via the typed event vocabulary.
- The failure and success taxonomies are first-class readonly constants that consumers can iterate over without runtime allocation.
- The Refiner is a portable kernel module: a DSH adapter, a CI pipeline, a CLI, an MCP server, or a future Crew witness can all invoke `recordProposal` without knowing which host is mounted.

Negative:
- No LLM-assisted analysis in v0.1. The `analyzeClosedWork` heuristics are deterministic scanning over Ledger events. Adding an LLM-backed classifier is a v0.2 PR that requires a separate ADR (because the Constitution §10 mandates "mechanical, deterministic supervision before spending model tokens").
- The Refiner does not apply changes. A consumer (future PR) must read `refiner.promoted` events and apply the payload to the appropriate surface. This is intentional.
- The portable `HarnessEventSchema` now has 27 event types (was 23). This is a backwards-compatible additive change to the discriminated union; existing consumers ignore the new types.

## Compliance check

- Constitution §16 (provenance is a product feature): ✓ — `provenance/refiner-taxonomy.yaml` records the derivation. The taxonomy is Rhiz-native (Compound Engineering Plan §6 is Rhiz-authored).
- Plan §22 (no automatic Constitution modification): ✓ — `forbidConstitutionAmendments` is a default-on guard.
- Plan §22 (no automatic weakening of security/authority boundaries): ✓ — `forbidAuthorityWeakening` is a default-on guard.
- Plan §22 (no permanent Rule from one low-confidence event): ✓ — `minEvidenceCount` defaults to 2.
- Plan §22 (no routing optimization across incomparable tasks): ✓ — `forbidRoutingOptimization` is a default-on guard.
- Plan §22 (no benchmark improvement through weaker acceptance criteria): ✓ — `forbidBenchmarkAcceptanceWeakening` is a default-on guard.
- Plan §22 (no worker self-certification): ✓ — `forbidWorkerSelfCertification` is a default-on guard; `promoteProposal` refuses agents.
- Plan §22 (all promoted learning must be attributable to evidence): ✓ — every proposal carries `evidenceRefs: RefinerEvidenceRef[]` with at least `minEvidenceCount` entries.
- Plan §22 (improvements must be reversible): ✓ — `requireReversibleUntil` is a default-on guard; `RefinerDraft.reversibleUntil` is a typed ISO datetime.
- Plan §22 (humans retain authority over consequential policy): ✓ — `promoteProposal` throws `RefinerGuardViolationError` if invoked by an `agent` actor.
- AGENTS.md non-negotiable: "The portable core MUST NOT import DSH, Rhiz Protocol, or another concrete host/runtime." — ✓ — `src/refiner.ts` imports only `./schemas.js`, `./ledger.js`, and `zod`. Verified by `scripts/check-portable-boundary.mjs`.

## Out of scope for v0.1

- LLM-assisted analysis behind a `RefinerConfig.classifierModel` flag.
- The actual application of a `refiner.promoted` payload to a surface (e.g., updating a Guard policy, adding to a RuleSet). A follow-up PR will provide `applyPromotedProposal(proposal, surface)` per surface.
- Cross-Work rollups (e.g., "what proposal kinds are most common across the last 100 Work items?").
- A Refiner MCP server that lets external agents query proposal state.
- A Refiner CLI surface.
- Versioning of the taxonomy (v0 failure taxonomy may differ from v1; consumers that serialize taxonomy values must version them).

## References

- `docs/COMPOUND_ENGINEERING_PLAN.md` §6 (failure and success taxonomy), §7 (Refiner phases), §22 (guard against self-corruption)
- `first-fluke/oh-my-agent@032c988f5eb0f69d2072c44af273b42866b9eb8d` `cli/state/{artifact-verifier,decision-verifier}.ts` (study-only inspiration)
- `letta-ai/letta-code@0d245b4fb8be8dc1ae0b550ae729ff9279f378fd` `src/backend/local/local-compaction-parity.test.ts` (study-only inspiration; parity discipline)
- Open Source Architecture Scout (2026-08-20) — `first-fluke/oh-my-agent` survey entry
- Rhiz provenance registry entry: `provenance/refiner-taxonomy.yaml`
- Architecturally adjacent: `kunchenguid/firstmate@1cb900c28faf23fe23c9bb54e63f7c3b436ea096` `bin/fm-watch.sh` (study-only inspiration; mechanical-watcher reason taxonomy)
