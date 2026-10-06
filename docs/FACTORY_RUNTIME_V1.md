# Factory Runtime v1

Status: in progress. **Shipped** marks what exists in code with tests. **Proposed** marks direction that has not been built or decided.

## The problem

Every team running coding agents has the same blind spot. Each run is visible; the system is not. Nobody can say, from evidence, which agent does better on which kind of work, which checks are doing nothing, which context is fetched a hundred times, what the humans keep fixing, or whether last week's change to the setup helped.

Rhiz Harness treats the setup itself (agent, model, context strategy, rules, tools, verification) as an engineering system that can be measured and improved:

```text
Agent + Model + Context Strategy + Rules + Tools + Verification
        -> independently verified outcome
```

The measure is the one in the [Benchmark Contract](BENCHMARK_CONTRACT.md): **human interventions per independently verified successful outcome**.

## The loop

```text
use Harness -> produce evidence -> Observer finds a pattern
  -> proposed change -> replay the same historical Work under it
  -> descriptive result -> reviewed promotion -> everyone's next run improves
```

The lifecycle each piece of Work moves through:

```text
Intent -> WorkContract -> Context + Rules -> Router + Crew -> bounded execution
  -> Guard -> independent Verify / Review -> Board acceptance -> durable Ledger
  -> Observer -> replay experiment -> Refiner proposal -> promotion
```

## What ships in v1

| Component | Status | Where |
| --- | --- | --- |
| Harness core: WorkContract, Board, Crew, Guard, Verify, Ledger, Router, Context, Rules, Refiner | Shipped | `src/`, `adapters/` |
| BenchmarkRun with intervention counting and paired comparison under controls | Shipped | `src/benchmark.ts` |
| **Factory Observer**: North Star, cohorts, waste, and six finding detectors | Shipped | `src/observer.ts`, [ADR 0025](decisions/0025-factory-runtime-observer-and-replay.md) |
| **Historical replay**: corpus-level experiment over paired runs, with refusal of uncontrolled trials | Shipped | `src/replay.ts` |
| Operator commands `factory:observe` and `factory:replay` | Shipped | `scripts/factory.mjs` |
| Repository Work runner that emits benchmark receipts per arm | Shipped | `scripts/run-repository-work.mjs` |

### Try it

```bash
npm run factory:observe -- --ledger <ledger-dir> --runs <receipts-dir>
```

The output reads like this:

```text
North Star: 1.4 human interventions per verified outcome (… coverage complete).
  ship / worker:codex / model-a: 91% verified completion, 0.6 interventions/outcome, $3.10 median cost (n=22).
  ship / worker:claude / model-b: 64% verified completion, 2.7 interventions/outcome, $2.40 median cost (n=14).
Waste: 9 unverified runs (…), 4 failed and 2 blocked attempts, 3 verified Works awaiting a Board decision.
5 findings:
  [cohort-gap] worker:codex / model-a outperforms worker:claude / model-b on ship Work
    -> routing-policy proposal; replay replay:… ready over 14 cases
  [quiet-criterion] Verification criterion criterion:lint has never failed and has no falsifier
  [repeated-context] Context docs/ARCHITECTURE.md was selected for 31 separate Works
  …
```

Each finding names its evidence. Where runs exist, it carries a ready replay experiment. Run that experiment's cases under both arms with the repository Work runner, then:

```bash
npm run factory:replay -- --experiment replay.json --pairs pairs.json
```

```text
Replay replay:…: improved (descriptive).
  baseline : 64% verified completion, 2.7 interventions/outcome, $2.40 median cost (n=28, interventions complete)
  candidate: 86% verified completion, 0.8 interventions/outcome, $4.21 median cost (n=28, interventions complete)
```

The numbers above illustrate the format. They are not results.

### Rules the results obey

- A pair that breaks the experiment's controls is refused and the result is `invalid`. It is never dropped.
- A case with fewer trials than requested makes the result `insufficient-evidence`.
- Interventions per verified outcome is `null` when nothing verified, and it is labelled a floor when only the runner observed interventions.
- Cohort comparisons cross different cases and say so. Only replay holds the case constant.
- Verdicts are descriptive. Nothing here computes or claims statistical significance.

## Proposed next

These are direction, not commitments. Each needs evidence and its own decision record.

| Area | Proposal |
| --- | --- |
| Rhiz Bench | A shared corpus of real, replayable historical tasks with answer-withholding replay packets and published, reproducible results per configuration. |
| Scorer SDK | Deterministic scorers as plugins, custom scorers, and optional model-backed judges that are always labelled advisory. |
| Agent adapters | Beyond Codex and Claude Code: OpenHands, Goose, Cline, and DSH workers behind the same worker contract. |
| Execution adapters | GitLab, local Git, and CI systems alongside GitHub. |
| Capability packs | Reusable rules, verification profiles, context strategies, and skills, each carrying the replay evidence that justified it. |
| Factory Console | A local, self-hosted view of runs, cost, failures, interventions, verification, and Observer findings. |
| Task-class routing | Router policy updated from replay results, never from cohort observation alone. |
| Production feedback | Outcomes observed after release fed back as evidence, so the loop closes beyond build acceptance. |
| Controlled self-improvement | Refiner proposals generated from findings, promoted only by named human authority after replay. |

## Contributing a result

A result anyone can check has five parts:
- the exact Harness commit;
- the experiment spec;
- the paired receipts;
- the replay result JSON;
- the configuration that differed.

Fork the configuration, replay the same cases, and publish the receipts. The [Benchmark Contract](BENCHMARK_CONTRACT.md) lists the anti-gaming rules a result must respect.
