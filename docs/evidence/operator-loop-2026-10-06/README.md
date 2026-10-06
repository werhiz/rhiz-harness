# Operator loop live journey, 2026-10-06

Real CLI, real processes, real providers, on a disposable repository (Node 24.15.0). No secrets are in
these files. Operator inputs are the contract and plan produced by the fixture described below.

Journey (`transcript.txt`): `status` (empty) -> `start` -> the process group is SIGKILLed after the
durable Ledger shows `attempt.started` -> `status` -> `resume` -> `status` -> independent `review`
(MiniMax through OpenCode, then Claude Code) -> `accept` -> `status` -> a second Work `start` whose
receipt shows the Router reading the accepted first Work (`second-work-start.json`).

| Provider | Role | Result |
|---|---|---|
| Codex CLI 0.154.0 (ChatGPT login), model pinned to `gpt-5.5` by `codex-gpt55.sh` | worker | ran (real) |
| Claude Code 2.1.290 login (`claude -p`) | independent reviewer | ran (real); reported USD 0.1883 |
| MiniMax `opencode-go/minimax-m3` through OpenCode (`mm-reviewer.sh`) | independent reviewer | ran (real); reported no usage, so observed spend is "not reported" for it |
| (none) | | No provider was BENCHMARK NOT RUN: all three were available and ran |

Earlier transcripts are kept because they are true and instructive:

- `transcript-0-codex-model-unsupported.txt`: the default Codex model on this account is rejected, so
  the pinned-model wrapper was used. This is environment configuration, not a Harness change.
- `transcript-1-codex-guard-circuit-opened.txt`: a chatty real Codex ran shell inspections, three
  denials opened the Guard circuit, and the legitimate edit was refused fail-closed. The rerun's
  objective forbids shell inspection.

Files: `ledger-events.jsonl` (the hash-chained durable Ledger), `review-receipts/` (what each reviewer
returned), `router-refiner-record.json` (Refiner analysis with its Work record, and Router evidence,
derived from that Ledger), `receipt.json` (last runner receipt), `second-work-start.json`.

Honest limits: the live journey's killed attempt left no verifier refusal, so the carried-refusal
property is proven by `test/operator-resume-journey.test.ts` (real processes, a fake Codex App Server
that refuses once and then hangs, killed with SIGKILL) and by an A/B run on this tree: with the carry line in `scripts/run-repository-work.mjs` replaced by an empty list, that test fails; restored, it passes.
The Codex worker reports no token usage, so worker spend is unobserved; Router `medianCostUsd` stays
null rather than reading the estimate.

Build disclosure: the journey ran at code commit `280e83a` plus the `c8e9f96` display fix. A later
independent review (see the PR) changed what `status` prints: the receipt-derived "reviewer spend" line
was removed because the Ledger already holds provider-reported spend (`observed ...`), so the
transcript's `reviewer spend $0.0000` lines, which disagree with `observed $0.1883`, come from the
build that was reviewed and corrected. Journey semantics and the Ledger are unchanged by those fixes.
Absolute paths in the transcripts and receipts are shown with `~` for the operator's home directory.
The Ledger file is verbatim and hash-chained, so it is not edited.
