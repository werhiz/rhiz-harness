# Local Studio execution

This is a Studio-scoped adapter proposal over the existing Work runner, not a second controller. The global Rhiz model cascade is unchanged. Reconciled with Rhiz Protocol PR #4519 at `13ccaa1c3190f40abb2bbe04ffc9b1d8d86e03fa`.

`rhiz-harness start --contract work.json --verify verify.json --local-config local.json` registers only the local Worker/Host. Router, Crew, Guard, isolated Git worktrees, independent Verify, preserved candidates, Ledger, operator review/acceptance and Refiner remain the existing implementations. `resume` reuses the pinned configuration; the direct runner also refuses a changed or missing provider binding. Old Work without the binding requires explicit migration rather than guessing a route.

The local configuration has backend `ollama`, model `qwen3:8b` or `qwen3-coder:30b`, the full digest read from the installed runtime, numeric loopback `origin`, `contextTokens` (default 4096, maximum 8192), `permittedPaths` (explicit exact non-control-plane files), `autonomousPaidBudgetUsd: 0` and `cloudFallback: false`. No example fabricates an installed model digest. Keep this operator-controlled configuration outside the candidate. Use an independently authorized, claimed Work with immutable checks; a path allowlist is an additional limit, never an authority grant.

Studio shells/services set `RHIZ_LOCAL_ONLY=1`; this runner then refuses an omitted local configuration before selecting Codex. Removing that restriction is not an authorization mechanism. An actual cloud escalation still needs the existing explicit authority, data scope and budget. Generic non-Studio deployments retain their existing default route.

The initial tool is deliberately narrow: one exact `replace_text` in an existing file. No shell, arbitrary generated program, new controller, acceptance, or policy-changing tool is available. Files must be under both the operator path allowlist and Work writeScope, regular, bounded and free of symlink/hardlink escape. Harness itself cannot be the autonomous mutation target. Guard records its decision before the fixed effect program runs under the existing OS sandbox. Replacement stages complete bytes in private scratch storage and atomically renames them; cross-device rename fails without truncating the original. Verification must still pass against the exact candidate. Unit tests with a pass-through test launcher do not prove host containment.

Atomic rename can also be refused by a file-only sandbox scope that lacks parent-directory mutation rights. This remains a failed attempt, never grounds to widen scope automatically or fall back to non-atomic writes. Prove the exact filesystem and contract scope on the actual host before scheduling execution.

Missing containment, unavailable inference, changed model digest, unknown tools, ambiguous replacements, cancellation and verification failure do not trigger another model. The failed attempt and its reason are retained through existing Ledger semantics. An escalation packet is advisory and requires a separate explicit authorization; this adapter intentionally contains no cloud route. Provider token usage and financial cost remain unknown unless reported and recorded; configured budget is not a measurement of savings.

Before inference the adapter executes a fixed positive probe under the exact effect sandbox and requires its private scratch marker. The existing macOS launcher's availability bit alone is insufficient: this managed session reports available but `sandbox_apply` fails. A refused positive probe fails the attempt before model work.

The existing Factory observer consumes actual Ledgers and accepted results. Skills and retrieval enter through existing selected Context fragments; their presence does not grant writes to the skills, evaluators, guards, baseline benchmarks or controller. Refiner proposes changes, and existing authorities review/promote them. No self-authored acceptance or automatic skill/model promotion is introduced.

## Experimental training preparation

`scripts/prepare-local-training.mjs` reads verified repository Ledgers and an operator-reviewed approval manifest. It emits a versioned private derived corpus only after at least 40 distinct accepted Work items pass identity, independent verification, approved-content digest, rights assertions and supplemental secret/personal-information screening. One Work cannot enter two splits. The approval manifest is audit input to the existing trusted private operator boundary, not authentication. Automated screening cannot certify privacy; actual content review remains necessary. No production/customer corpus is inferred from filesystem access.

MLX-LM is a replaceable experimental tool, not the execution runtime. Install a compatible pinned release and a permitted 7–8B converted model before checking training support. Start at batch size 1, sequence length 512, 100 iterations and low-rank adapters only; do not train a 30B model on this host. Run only while generation is stopped and swap/pressure can be measured. Baseline model, held-out tests and evaluator are immutable. Run identical coding, authority/tool and regression tasks against baseline and candidate; loss alone is not proof of improvement. Persist dataset/model/adapter hashes, source Work and approval identities, command, versions, resource readings and test results. No weights are trained, fused, redistributed, or promoted by the preparation script. Use the unchanged baseline unless independent evaluation and promotion approval succeed.

## Current proof boundary

The CLI bridge also accepts `backend: "llama-cli"`, model
`qwen2.5-7b-instruct-q4_k_m` or `qwen3-8b-q4_k_m`, absolute `executable` and `modelPath`, and exact
SHA-256 `executableDigest` and `digest`. The zero-budget, no-fallback and path
allowlist fields remain required. It uses offline CPU inference under the existing
OS sandbox, strips inherited credentials, and feeds structured data into the same
Guard-mediated effect. Set `TMPDIR` to a physical path such as `/private/tmp` on
macOS; a symlinked workspace is correctly refused. This bridge is an activation
experiment, not integration approval. The real fixture task passed independent
Verify including a disposable negative control on 2026-10-17; it did not modify a
product or establish general coding quality. Full check and hosted proof remain open.
On 2026-10-19 the Qwen3 8B Q4_K_M GGUF that Ollama stores for `qwen3:8b`
(blob `sha256-a3de86cd…`) returned the exact schema-constrained replacement for a
fixture broken-link prompt with this bridge's arguments in 37s on CPU. The JSON
schema grammar suppresses thinking output. Pin that blob path and digest in
`modelPath`/`digest`; the label alone grants nothing.

The Studio session cannot download Ollama, bind loopback sockets, initialize Codex state, inspect swap, or register launchd. Existing Qwen 2.5 CPU CLI inference works, but does not establish either requested Qwen 3 benchmark or a live Ollama Harness task. Persistent execution remains paused. The slow guard suite remains INCOMPLETE and is not rerun by this change. Full gate, independent exact-candidate review, real OS containment, model benchmark, safe stop and restart recovery are required before activation or integration.
