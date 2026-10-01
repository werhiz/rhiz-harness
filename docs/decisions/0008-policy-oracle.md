# ADR 0008: Policy Oracle architecture

Status: accepted for Kernel 0.2 / Guard v0

Supersedes nothing. Refines the Constitution §9 (Authority is explicit and bounded), §10 (Mechanical supervision precedes cognitive supervision), and §16 (Provenance is a product feature) into a concrete authority-evaluation surface. The full design rationale, evidence base, and rejection of the alternative are recorded below; the read-only Open Source Architecture Scout report (2026-08-20) is the upstream evidence.

## Context

The Rhiz Constitution §9 requires every substantial task to have an explicit authority policy defining read/write/execute/approve/publish/external-mutate rights, and "high-consequence capabilities SHOULD be guarded mechanically." §10 requires that "PID checks, process health, FS state, Git state, deterministic validation, queue handling, timeouts, machine-readable supervision SHOULD consume zero model tokens whenever possible." §7 (Workers are interchangeable) forbids hard dependencies on a single vendor. The Compound Engineering Plan §22 forbids "no automatic weakening of security/authority boundaries" and "no worker self-certification."

None of the existing Kernel modules (Schemas, Board, Ledger, Host, Workers, Crew, Verify, Benchmark) enforces an authority boundary on tool calls. Each WorkerProvider is permitted to surface tools whose invocation can have read/write/execute/approve/publish/external-mutate consequences without a portable, recorded, evidence-attached gate. That is a constitutional gap that any Phase §K (Crew) or Phase §I (Router) implementation will encounter within one PR.

The Open Source Architecture Scout (2026-08-20) surveyed ten upstream projects. The strongest single guard blueprint is `codex-rs/core/src/guardian/mod.rs:1-202` in `openinterpreter/openinterpreter` (Apache-2.0; the Rust fork of OpenAI Codex CLI). That module defines:

- `GuardianAssessment { risk_level, user_authorization, outcome, rationale }` — the strict-JSON contract an LLM-supervisor must satisfy.
- `GuardianRejectionCircuitBreaker` — consecutive-denial and sliding-window-denial caps that escalate to `InterruptTurn`.
- Default tuning constants: 90s timeout, 3 consecutive denials (1 for cyber), 10 recent denials in a 50-window, per-category token budgets (10k message / 10k tool / 2k per-entry).
- A four-step doctrine: reconstruct compact transcript → dedicated review session → strict-JSON contract → fail closed on timeout/malformed.

The same upstream repo also ships `codex-rs/execpolicy/` as a binary oracle (`Decision{Allow, Prompt, Forbidden}`), enabling a two-tier design where Rhiz owns the default policy and can defer to a vendor-built oracle as an opt-in backend.

## Decision

We adopt a `PolicyOracle` trait with two implementations:

1. **`RhizNativePolicyOracle` (default)** — derived from `codex-rs/core/src/guardian/mod.rs`. Pure TypeScript, deterministic, zero model tokens. Matches the four-step doctrine structurally: schema validation → rule evaluation (forbidden-pattern, per-tool mode, default-deny) → verdict emission → fail closed on internal error. The LLM-as-judge path is deferred to v0.2 because Constitution §10 mandates mechanical supervision with zero model tokens whenever possible, and the Constitution §22 amendment rule requires every consequential change to be reversible and evidence-bound (LLM-as-judge verdicts are not mechanically testable in the same way).

2. **`ExecPolicyBackendOracle` (escape hatch)** — shells out to `codex-rs/execpolicy` as a binary oracle. Disabled by default. Operators explicitly opt in by setting `GuardPolicy.backend = "execpolicy"` and supplying `backendConfig.executablePath`. This satisfies Constitution §13 (prefer open protocols at boundaries) without making Rhiz depend on a single vendor's binary as the default. In v0.1 the sidecar is unimplemented; the oracle constructor accepts a `version` option and throws `GuardOracleUnavailableError` until an operator sets a non-`0.0.0-unimplemented` sentinel.

Selection is per `GuardPolicy.backend`. The `createDefaultPolicyOracle(policy, options)` factory picks the right oracle. `assertGuardCanEvaluate` first checks the circuit breaker, then validates the policy/oracle pairing, then invokes `oracle.evaluate`, then records the verdict.

`GuardianRejectionCircuitBreaker` is a small state machine over a sliding-window-denial counter; the upstream constants are the defaults. The breaker is keyed at the WorkAttempt level — each attempt has its own breaker, so a sequence of `forbid` verdicts in one attempt opens the breaker for that attempt only, not organisation-wide.

The portable module `src/guard.ts`:
- imports nothing from DSH, Rhiz Protocol, or any concrete host (verified by `scripts/check-portable-boundary.mjs`);
- re-exports its types via `src/index.ts`;
- is accompanied by `provenance/openinterpreter-codex-cli.yaml` recording the derivation per Constitution §16;
- declares its first occurrence in `docs/decisions/0008-policy-oracle.md` (this file).

## Consequences

Positive:
- Rhiz owns the default oracle. Constitution §7 (workers are interchangeable) is satisfied.
- The oracle is a portable kernel module: a DSH adapter, a CLI, an MCP server, or a future Crew witness can all invoke `assertGuardCanEvaluate` without knowing which backend is mounted.
- The escape hatch exists for operators who want to defer to OpenAI's prompt-tuning. The escape hatch is opt-in and explicit per `WorkContract`.
- A mediated native tool request records a typed `guard.evaluated` Ledger event containing its request and verdict, so replay reconstructs what Guard decided without creating a second Work state machine.
- The forbidden-pattern matcher is deterministic and pattern-array-driven; no string-eval, no regex, no model call.
- The circuit breaker is unit-testable without any model provider.

Negative:
- The LLM-as-judge path is deferred. Ambiguous cases fall to `policy.defaultDecision` (default `'prompt'`, the human-decision branch). This is the conservative default per §22.
- Evidence keeps the decision, not the payload. A `guard.evaluated` event carries the tool's identity plus a bounded argument summary — parameter names, byte size, and a digest over key-sorted JSON — because an append-only ledger cannot redact a file body or a credential that was passed as a tool argument, and correlation is all replay needs. Authorization still sees the raw arguments; only the record is reduced.
- Evidence is downstream of authorization. A failed diagnostic, observation, or ledger write is a failure to record history, not a licence to revise the verdict, and the denial circuit breaker counts effected Guard verdicts only — never evidence failures.
- A DSH product route advertises `guardedToolMediation` only because an operator declared it on the route, and the declaration is rechecked against the live runtime before the first native effect. Capability discovery stays pure — selecting among candidate workers must not boot a runtime — so an undeclared route is refused for write work rather than credited with an enforcement nobody verified.
- `prompt` cannot be honoured at a native permission hook. That hook is answered by a machine, and no approval channel exists yet, so a mediation seam declaring `approvalChannel: "none"` — every seam shipped today — records and effects a `prompt` verdict as `forbid`, keeping the original decision and rule hits in the record. A seam that can actually carry the question to a human may declare `interactive`; none does.
- The `ExecPolicyBackendOracle` is a stub in v0.1. The sidecar wiring is a separate PR.
- The forbidden-pattern matcher is a `JSON.stringify(args).includes(pattern)` substring test. This is intentionally conservative — it catches obvious commands (`rm -rf`, `delete`, `drop`) without false positives, and it does not invoke a regex engine.
- The `policyBackendVersion` field is optional and producer-set; consumers should treat it as informational.

## Compliance check

- Constitution §7 (workers interchangeable): ✓ — Rhiz owns the oracle; the binary shim is a backend, not a dependency.
- Constitution §9 (authority explicit and bounded): pending — a `GuardPolicy` can compute a verdict, but the pinned DSH product runtime cannot route native callbacks through Guard; write-capable work is refused there rather than claimed protected.
- Constitution §10 (mechanical supervision): ✓ — deterministic rule evaluation in v0.1; LLM-as-judge is a fallback behind an explicit policy flag.
- Constitution §13 (open protocols at boundaries): ✓ — the oracle is a TypeScript interface; the only concrete binary backend is opt-in.
- Constitution §16 (provenance is a product feature): ✓ — `provenance/openinterpreter-codex-cli.yaml` records the derivation and lists upstream_paths, rhiz_paths, material_changes, license, and strategy.
- Plan §22 (no automatic weakening of security/authority boundaries): ✓ — the oracle is read-only; improvement is gated by Refiner proposals + human approval (future PR).
- AGENTS.md non-negotiable: "The portable core MUST NOT import DSH, Rhiz Protocol, or another concrete host/runtime." — ✓ — `src/guard.ts` imports only `./schemas.js` and `zod`.

## Out of scope for v0.1

- LLM-as-judge fallback behind a `policy.guardOracle.judgeModel` flag.
- Sidecar runtime for `codex-rs/execpolicy` (binary invocation, JSON-RPC protocol, persistence of the audit log).
- Cross-attempt circuit breaker.
- Cross-work circuit breaker.
- An MCP-server surface that other agents can invoke to query a Rhiz-mounted oracle.

## References

- `codex-rs/core/src/guardian/mod.rs:1-202`, `openinterpreter/openinterpreter` @ `5b07159c477920c159d8892d112b480e7307f257` (upstream)
- `codex-rs/core/src/guardian/policy.md` (upstream)
- `codex-rs/execpolicy/src/lib.rs`, `codex-rs/execpolicy/src/main.rs` (upstream)
- Rhiz Constitution §7, §9, §10, §13, §16
- Rhiz Compound Engineering Plan §22
- Open Source Architecture Scout (2026-08-20) — `codex-rs/core/src/guardian/mod.rs` survey entry
- Rhiz provenance registry entry: `provenance/openinterpreter-codex-cli.yaml`
