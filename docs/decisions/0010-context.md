# ADR 0010: Context — typed pack with measurable composition

Status: accepted for Kernel 0.2 / Context v0

Supersedes nothing. Refines the Constitution §8 (context is engineered) and §16 (provenance is a product feature) into a typed context-pack surface. The full design rationale, evidence base, and out-of-scope section are recorded below; the Open Source Architecture Scout (2026-08-20) provided the upstream evidence.

## Context

The Constitution §8 says: "Context is a scarce computational resource; SHOULD select the smallest sufficient context; record what was selected; measure whether context strategies improve outcomes; dumping all available state is not a default."

The Compound Engineering Plan §13 names the deliverables: "ContextPack with identity + measurable composition (included files, selected symbols, history, rules, architecture docs, token estimate, retrieval strategy, task class, outcome)."

The Open Source Architecture Scout (2026-08-20) surveyed the public context-engine landscape. The three strongest references are:

- **Aider** (`Aider-AI/aider@5dc9490bb35f9729ef2c95d00a19ccd30c26339c`, Apache-2.0) — the `RepoMap` algorithm in `aider/repomap.py:1-680` is the reference PageRank-on-the-repo. Token-budgeted binary search, `map_mul_no_files=8` heuristic, `max_map_tokens` trim. Re-implement in Rhiz's stack; do not vendor.
- **LangChain** (`langchain-ai/langchain`, MIT) — `ContextEditingMiddleware` in `libs/langchain_v1/langchain/agents/middleware/context_editing.py:44-290` with `ClearToolUsesEdit`, `SummarizationMiddleware`, and `TriggerClause`. Production-tested. The `ContextEdit` Protocol is a 12-line interface that is the correct abstraction for "an edit to the context window."
- **OpenInterpreter** (`openinterpreter/openinterpreter@5b07159c477920c159d8892d112b480e7307f257`, Apache-2.0) — `codex-rs/core/src/context/` ships a `ContextualUserFragment` trait with a marker discipline. Every fragment carries a stable `marker` so consumers can find and remove it later. The Scout calls this the marker/round-trip discipline; it is the most important part of the design.

The Scout's recommendation: **derive** the LangChain eviction, **derive** the OpenInterpreter marker discipline, **re-implement** the Aider PageRank in Rhiz's stack, **study** the Continue retrieval pipelines (do not depend on Continue; the repo is read-only).

## Decision

We add a portable Context module (`src/context.ts`) that:

1. Defines a `ContextFragment` discriminated union of six kinds:
   - `IncludedFileFragment` (file path, content, token estimate)
   - `SelectedSymbolFragment` (file, name, range, token estimate)
   - `HistoryFragment` (event count, last occurred-at, summary, token estimate)
   - `RuleFragment` (rule id, text, token estimate)
   - `ArchitectureDocFragment` (doc URI, content, token estimate)
   - `SkillFragment` (skill id, content, token estimate)
2. Every fragment carries a stable `marker` field (e.g., `ctx:included-file:0`). This is the **OpenInterpreter marker discipline** — the marker is a stable handle so consumers can find, mutate, or remove the fragment later.
3. Defines a `ContextPack` typed bundle with `id`, `workId`, `taskId`, `attemptId`, `strategy`, `taskClass`, `fragments`, `totalTokens`, `composedAt`, `markers`. The schema's `superRefine` enforces: `totalTokens === sum(fragments.tokenEstimate)`, markers are unique and one-per-fragment. Any pack that fails this consistency check is rejected.
4. Defines a `ContextEdit` discriminated union of three kinds:
   - `ClearToolUsesEdit` (LangChain-derived) — `keepRecent` and `minTokens` knobs; evicts tool-use fragments above a token threshold.
   - `DropFragmentEdit` — drop a fragment by marker.
   - `ReplaceFragmentEdit` — replace a fragment by marker with a new typed fragment.
5. Defines a `ContextConfig` with `strategy`, `tokenBudget` (per-kind caps and total), `markerPrefix`, `maxHistoryEvents`, and per-fragment-kind hard caps. The defaults match the Constitution §8 "smallest sufficient context" directive: `strategy: "minimal"`, total budget `60_000` tokens.
6. Defines a `ContextCompositionOptions` input shape (file contents, selected symbols, history events, rules, architecture docs, skills) that the composer reads. v0.1 is **deterministic and offline** — no file system, no Ledger reads. The actual file fetching and history reading is done by a higher-level consumer (a future PR).
7. Defines the primitives:
   - `classifyTaskClass(contract)` — returns `"scout" | "ship" | "review" | "default"` from the contract's `type`.
   - `defaultStrategyForTaskClass(taskClass)` — defaults: scout→broad, review→balanced, ship→minimal, default→balanced.
   - `estimateTokens(text)` — heuristic `ceil(text.length / 4)`. v0.1 does not use a real tokenizer; v0.2 will use `tiktoken` or the model provider's tokenizer.
   - `selectFilesByStrategy(fileContents, strategy, hardCap)` — per-strategy file selector.
   - `selectSymbols(selectedSymbols, strategy, hardCap)` — per-strategy symbol selector.
   - `selectHistory(events, strategy, hardCap, maxEvents)` — per-strategy history selector.
   - `selectRules(rules, strategy, hardCap)` — per-strategy rule selector.
   - `selectArchitectureDocs(docs, strategy, hardCap)` — per-strategy doc selector.
   - `selectSkills(skills, strategy, hardCap)` — per-strategy skill selector.
   - `composeContextPack(contract, taskId, attemptId, options, config, now)` — the composer. Returns a `ContextPack` whose `totalTokens` is the sum of fragment token estimates.
   - `applyContextEdit(pack, edit, now)` — applies a typed edit; returns a new pack.
   - `validateContextBudget(pack, config)` — returns a `ContextBudgetBreakdown` with `byKind`, `perKindBudget`, `total`, `totalBudget`, `withinBudget`, `overBudgetKinds`.
   - `findFragmentByMarker(pack, marker)` / `indexOfMarker(pack, marker)` — marker discipline helpers.
8. Defines four error classes: `ContextError`, `ContextConfigurationError`, `ContextBudgetExceededError`, `ContextValidationError`. Each carries a stable `code` and a stable `name`.
9. Exposes the `markerFor(kind, counter, prefix)` helper for external fragment constructors.

The Context module does **not** extend `HarnessEventSchema` in v0.1. Consumers record context outcomes via the existing `attempt.activity-observed` event with a `source: "context-pack"` or similar. A future v0.2 PR will add a `context.pack.composed` event when the composer becomes event-emitting.

## Consequences

Positive:
- Every `ContextPack` is a typed, durable data structure. A consumer (Refiner, CI, audit) can compare two packs and answer "what changed in the context between these two attempts?" without re-running the composer.
- The marker discipline enables find-and-remove. A `ClearToolUsesEdit` can drop a fragment by marker without knowing its content or kind.
- The per-kind token caps are part of the schema. A pack that exceeds a per-kind cap is reported in the `validateContextBudget` breakdown.
- The composer is deterministic. The same `(workContract, options, config)` triple produces the same `ContextPack` byte-for-byte. This is the property the Refiner needs to make context-strategy proposals evidence-bound (Plan §22: "all promoted learning must be attributable to evidence").
- The portable core does not import DSH, Rhiz Protocol, or any concrete host. Verified by `scripts/check-portable-boundary.mjs`.

Negative:
- No PageRank in v0.1. The `selectFilesByStrategy` selector uses deterministic sort + strategy-specific limits. PageRank requires a tree-sitter corpus and a real repository; that is a v0.2 PR (and a separate ADR because it's a non-trivial dependency on tree-sitter language packs).
- No real tokenizer in v0.1. `estimateTokens(text) = ceil(text.length / 4)` is a heuristic. v0.2 will swap in the model provider's tokenizer.
- No LLM-assisted fragment selection. Per Constitution §10, mechanical supervision precedes cognitive supervision; an LLM-based "which symbols are most relevant" is a v0.2 PR behind a separate ADR.
- No new `HarnessEventSchema` events. Consumers record context outcomes via the existing `attempt.activity-observed`. The `validateContextBudget` breakdown is a pure data structure, not an event.

## Compliance check

- Constitution §8 (context is engineered): ✓ — the smallest sufficient context is the default; every pack is recorded with measurable composition; token estimates are part of the schema.
- Constitution §10 (mechanical supervision): ✓ — the composer is deterministic; no model tokens are spent in v0.1.
- Constitution §13 (open protocols at boundaries): ✓ — the marker discipline is a stable public protocol for find-and-remove.
- Constitution §16 (provenance is a product feature): ✓ — `provenance/context-fragments.yaml` records the derivation from Aider, LangChain, and OpenInterpreter.
- AGENTS.md non-negotiable ("portable core MUST NOT import DSH, Rhiz Protocol, or any concrete host/runtime"): ✓ — `src/context.ts` imports only `./schemas.js` and `zod`. Verified by `npm run check:portable-boundary`.

## Out of scope for v0.1

- **PageRank-on-the-repo** — v0.2 PR with a tree-sitter corpus. The algorithm is documented in Aider's `aider/repomap.py:1-680`; the Rhiz re-implementation will be a separate module (`src/repo-map.ts`).
- **A real tokenizer** — v0.2 PR that consumes the model provider's tokenizer (or `tiktoken` for non-model work).
- **Two-stage retrieval + rerank pipelines** (Continue's pattern) — v0.2 PR with a `LocalEmbedder` and a `Reranker` interface. v0.1 is a strict superset of "deterministic file/symbol selection by strategy".
- **An LLM-assisted "which fragments matter" selector** — v0.2 PR behind a `ContextConfig.classifierModel` flag.
- **`HarnessEvent` event types for context** — v0.2 PR will add `context.pack.composed` and `context.edit.applied`.
- **A `ContextConsumer` interface** that bridges `ContextPack` → `HarnessEvent` (e.g., emits `attempt.activity-observed` with the pack's `byKind` breakdown). v0.1 is a pure module.

## References

- `aider/repomap.py:1-680`, `Aider-AI/aider@5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (Apache-2.0, study + re-implement in v0.2)
- `aider/coders/base_coder.py:600-770` (the `format_chat_chunks` order: system → examples → done → repo_map → read-only → chat_files → cur → reminder) — *the* prompt-composition order reference
- `libs/langchain_v1/langchain/agents/middleware/context_editing.py:44-290`, `langchain-ai/langchain` (MIT, derive — `ContextEdit` Protocol + `ClearToolUsesEdit` are the right abstraction)
- `libs/langchain_v1/langchain/agents/middleware/types.py` (the typed payloads `ModelRequest` / `ModelResponse` — study for the §16 provenance implication: typed payloads make provenance statements machine-checkable)
- `codex-rs/core/src/context/`, `openinterpreter/openinterpreter@5b07159c477920c159d8892d112b480e7307f257` (Apache-2.0, derive — the marker discipline)
- `codex-rs/core/src/context_manager/`, `codex-rs/core/src/compact*.rs` (study — the compaction discipline is the prior art for v0.2 token-budget eviction)
- Rhiz Constitution §8, §10, §13, §16
- Rhiz Compound Engineering Plan §13
- Open Source Architecture Scout (2026-08-20) — Context survey entry
- Rhiz provenance registry entry: `provenance/context-fragments.yaml`
