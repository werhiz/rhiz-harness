# ADR 0004: Codex and Claude as direct DSH-backed Rhiz workers

Status: accepted for DSH Product Worker Routes v0

## Context

Workers v0 gives Rhiz a portable catalog, deterministic selection, and a validated execution boundary. DeepSeek Harness already provides official, separately packaged one-shot providers for Codex and Claude Code. Both accept a standalone text task, inherit the parent Session workspace, use native product authentication and settings, and return final text through the DSH subagent result contract.

A naive integration would ask a parent model to call `subagent_codex` or `subagent_claude_code`. That adds another model decision, another prompt, more latency, and a new place where routing can drift from Board intent. Rhiz already knows which WorkerProvider it selected, so the Host should address the named DSH provider directly.

## Decision

1. Codex and Claude Code are first-class Rhiz `WorkerProvider`s with stable Rhiz identities:
   - `worker:codex` → DSH provider `rhiz-codex`;
   - `worker:claude` → DSH provider `rhiz-claude`.
2. The adapter mounts DSH's shared `SubagentRuntime`, local subprocess provider, and the official Codex and Claude Code provider packages in one Cordis context.
3. Rhiz calls `ctx.subagents.start(providerName, request)` directly. No coordinator model turn is used to choose or invoke the worker.
4. Each product run receives one standalone rendered `WorkContract` and the exact workspace cwd. Parent conversation history is not inherited.
5. Default unattended authority modes are conservative product-native modes:
   - Codex: `never`;
   - Claude Code: `dontAsk`.
6. Native product settings and authentication remain authoritative. Rhiz may provide an explicit environment overlay, but never records or renders credential values.
7. Every worker publishes a validated portable descriptor before selection. The descriptor states product, pinned product version, execution shape, context inheritance, native authority mode, write-access class, dangerous-mode flag, and only the names of explicitly supplied credential variables.
8. Dangerous bypass modes are available only through explicit route configuration and are surfaced as `dangerous: true` with `writeAccess: unrestricted`.
9. DSH product results map into the portable boundary:
   - `completed` with nonblank text → `finished`;
   - `aborted` → `cancelled`;
   - every other stop reason, malformed result, or blank completed output → `failed`.
10. Product reasoning, tool activity, raw protocol payloads, stderr, usage, native ids, and workspace diffs do not cross this v0 boundary. Artifacts and evidence remain empty until an independent collector can prove them.
11. The Host owns one lazy DSH product runtime and closes it exactly once. Worker cancellation aborts and disposes the exact one-shot DSH run.
12. CI installs the pinned provider packages without optional native product payloads and proves dormant provider registration. CI does not authenticate or execute paid Codex or Claude turns.

## Consequences

- Rhiz can route the same portable Work to Codex or Claude without changing Board, Ledger, Verify, or Crew contracts.
- DSH remains an adapter implementation, while worker identity and authority metadata belong to Rhiz.
- Routing has no unnecessary parent-model tax.
- CI can detect package, composition, provider-name, and safety-metadata drift without credentials.
- A credentialed operator gate is still required before claiming real Codex or Claude product execution.
- Because v0 receives final text only, worker claims about changed files or tests remain unverified statements until later Runtime, artifact, and Verify layers supply evidence.
