# DSH Product Worker Routes v0

This phase turns DSH's official Codex and Claude Code subagent providers into directly addressable Rhiz workers.

## Scope

- portable worker descriptors;
- Codex and Claude route schemas;
- truthful native authority metadata;
- direct named-provider invocation through DSH's subagent service;
- one shared lazy product runtime;
- final-text result mapping;
- exact run cancellation and disposal;
- deterministic fake-runtime conformance tests;
- real dormant-provider composition in CI;
- no production credentials in CI.

## Default routes

| Rhiz worker | DSH provider | Product | Native mode | Portable write class |
|---|---|---|---|---|
| `worker:codex` | `rhiz-codex` | Codex 0.147.0 | `never` | `host-policy` |
| `worker:claude` | `rhiz-claude` | Claude Code 2.1.220 | `dontAsk` | `host-policy` |

`host-policy` means Rhiz does not claim that the product is read-only. Native account, project, sandbox, and product settings still influence what is already authorized. A bounded Rhiz `WorkContract` remains an organizational instruction until Guard mechanically enforces it at the tool or filesystem seam.

A route may declare `guardedToolMediation: true` to state that its runtime routes the native permission hook through `canUseTool` and awaits a Guard verdict before any effect. It defaults to `false`, is rechecked against the live runtime before the first native effect, and the pinned rc.8 in-process runtime declares `false` — so these routes are refused for `isolated-write` work rather than credited with an enforcement they do not have. See `docs/decisions/0008-policy-oracle.md`.

## Acceptance gate

The phase is proven when:

- worker descriptors are runtime validated and identity-bound;
- malformed or mismatched descriptors fail before execution;
- dangerous modes are visibly marked;
- Codex and Claude execute the same portable fake-runtime conformance contract;
- route prompts contain the bounded Work and no credential values;
- product stop reasons map deterministically to portable outcomes;
- cancellation aborts and disposes the exact run;
- one Host creates and closes one lazy DSH runtime;
- missing or duplicate DSH provider identities fail closed;
- actual DSH Codex and Claude provider packages mount under the intended names in CI;
- dormant composition starts zero Codex or Claude product processes;
- all prior Kernel, Board, Ledger, Workers, and keyless DSH proofs remain green.

## Credentialed operator gate

CI proves composition, contracts, and safety metadata. A separate operator-run gate is required to prove actual product execution because Codex and Claude authentication remain native and private.

That future gate must record only:

- route and product version;
- successful publication and settlement;
- portable final outcome;
- cancellation and teardown proof;
- zero credential values;
- no claim of verification or acceptance from worker text alone.

## Deferred

- native product session continuation;
- worker progress streams beyond wrapper lifecycle observations;
- artifact and diff collection;
- usage and cost telemetry;
- model selection inside native products;
- learned Router scoring;
- per-attempt sandbox construction;
- mechanical write-scope enforcement;
- production credential management;
- Crew orchestration.
