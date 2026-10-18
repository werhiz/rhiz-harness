# Studio decision evidence — 2026-10-17

## Explicit session ownership

An engineering process in a primary checkout has unknown write scope until the
trusted operator associates its exact uid/PID/start identity with a scoped Work
contract using `node scripts/factory-session.mjs --repo <coordination-repo>
--contract <Work.json> --pid <owner-pid>`. The association is an existing
`integration.execution-observed` event, not a lease transfer, acceptance, or new
authority. The process and its observed descendants retain that Work's full
canonical write scope while live. Heartbeat age never releases it.

The existing observer host supplies a fresh process-birth census over Node IPC
for each selection; privileged `ps` remains outside the dispatch sandbox.
Unbound/new/reused processes remain parked with their exact PID and resolution
action. A scoped session permits only unrelated authorized proposals; PR, Work,
lease, attempted-ID and native worker-lock exclusions still apply. Terminal
Work cannot authorize a new session. Subscription CLI installation does not
enroll a provider in unattended dispatch; local Qwen remains the default.

The existing Router remains the owner. The added deterministic adviser recommends actions; it cannot grant authority, accept Work, merge, promote lessons, or authorize inference. Factory dispatch is restricted to exact-file, unambiguous broken-link repairs in an operator-approved reference-doc allowlist. Missing coordination, pressure telemetry, runtime identity or proof parks execution. One worker, three tasks per cycle, zero paid budget, no cloud fallback.

## Reproduce

Run `npm run build`, `node --test scripts/test-factory-dispatch.mjs dist/test/engineering-decision.test.js`, then `node scripts/benchmark-engineering-decisions.mjs test/fixtures/engineering-decisions/v1.json /tmp/decisions.json`. Set RHIZ_BENCHMARK_CONTRACT to an approved WorkContract to compare the actual existing worker Router. Optional arguments are a pinned zero-budget local CLI config and cpu or metal. No server or additional model is required. Evaluation labels were independently frozen before implementation inspection; four tuning examples are separate. The original pretty-JSON evaluation digest is f4d0c9dd908659e03b9f4a5a416551f09aa2112e18ac3dc4c51c136b95ff010c; the checked-in representation preserves all values.

Twenty constructed decisions cover ten families. These are policy screening cases, not 100 independent natural outcomes. Final safety-tightened adviser: 17/20 (85%); existing worker-selection Router plus safety veto: 13/20 (65%). The baseline was not built for semantic triage. Earlier adviser 18/20 used a less conservative missing-verification default; it is superseded. CPU Qwen chat prompt: 11/20, 61.76s; Metal same prompt: 10/20, 17.69s. CPU overlapped other work, so timing does not establish causal acceleration. Metal offloaded 29 layers; its 706MB process RSS excludes unified GPU allocations. No production acceleration promotion follows this comparison. Self-reported Qwen confidence is not calibrated.

Laya-MLX 0.4.0 / MLX 0.32.4 on this M2 Max/macOS 14.8.4 scored 1/20 with the same facts and four separate tuning examples in typed-choice format: all predictions were stop, with zero truncated cases. P50 was 31.65ms, P95 37.46ms, throughput 30.39 decisions/s, process peak RSS 1.82GB and MLX peak allocation 1.28GB (not additive memory measures). The official billing control passed, so the installation worked; this is a failure on this structured-input screen, not a universal model-quality claim. One prompt per model was screened, without evaluation-label tuning. Inference had OS-denied network access. The deterministic adviser remains the simplest tested winner; Laya adds no operational dependency.

Seven real Rhiz doc candidates passed independent Harness verification, exact content checks and disposable negative controls, including three consecutive Factory-selected tasks in one cycle. These are unaccepted review candidates, not accepted Outcomes or evidence of improved engineering productivity. Canonical observed provider costs remain unknown where no usage was returned; offline local-only execution incurred $0 paid inference. Electricity is unmeasured.

## Official-source research

- [laya-mlx](https://github.com/mizorewww/laya-mlx): exists, Apache-2.0, pushed October 10, native Apple MLX typed decision heads; ModernBERT 421M/512-token or mmBERT 322M/1024-token checkpoint. Python 3.11/macOS 14+. Published M3 Max timings are not M2 measurements. Checkpoint revision 20aed815fc6acde75733882e7ec0e3f28aeb9717 is Apache-2.0 and was screened in a temporary environment; downstream effectiveness remains unproven.
- [local-jev](https://github.com/amithgc/local-jev): exists, MIT, pushed September 21; local decision server with Qwen3.5-4B or DeBERTa, PyTorch/MPS support. Larger default model footprint; adds server dependencies. Not benchmarked or installed.
- [SemIf-OpenJev](https://github.com/TheoLeeCJ/SemIf-OpenJev): exists, MIT, pushed September 23; direct option-logit decisions, MLX/PyTorch MPS/llama.cpp backends. GPU results in README do not establish M2 quality. Not benchmarked or installed.
- [mlx-serve](https://github.com/raspoli/mlx-serve): exists, MIT, pushed October 11, v0.3.0; MLX serving/hot-swap with optional decision provider. It is serving infrastructure, not a decision model. No demonstrated advantage justifies installing it.
- [SetFit](https://github.com/huggingface/setfit) and small embedding classifiers require representative labeled examples and held-out proof; neither is evidence of a better Rhiz ranker today. No weights were trained.
- [llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md) supports Metal on Apple Silicon. Existing binary/model were pinned and tested; worker configuration stays CPU pending controlled outcome proof.

All four repositories were unarchived at inspection; recent pushes are maintenance signals, not support guarantees. No upstream source was copied into Rhiz and no new serving dependency was installed. Laya was installed only in an isolated temporary benchmark environment, never in the operational loop. The simplest tested winner is deterministic advice; a specialized model may be evaluated later without replacing hard controls.

## Governance and rollback

Board/Ledger remain canonical Work state. Factory reads the existing ownership projections and stores only derived cycle reports. Successful candidates await human review/acceptance before Router credit or positive Refiner learning; failed attempts retain existing Refiner behavior. No synthetic acceptance, separate memory or training system is introduced. Disable the operator profile to stop new dispatch; terminate its process group to cancel a running attempt. Keep the existing observer script and containment unchanged until dispatch lifecycle proof passes. Runtime head and built bytes are pinned; any change requires re-verification.
