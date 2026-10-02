# ADR 0025: Factory Runtime v1 starts with the Observer and historical replay

Status: proposed

Authorized by founder ruling, 2026-10-01, together with the public release under Apache-2.0.

## Context

The Harness already records what happened to each piece of Work: typed Ledger events, verification results, review findings, Context selections, route decisions, and `BenchmarkRun` receipts that count human interventions. Refiner reads one closed Work at a time.

Nothing reads the population. The questions a team running agents actually asks cannot be answered from one Work:

- Which worker or model verifies more of this task class, and at what intervention cost?
- Which verification criteria have never failed, and can they?
- Which Context is assembled again and again?
- Which review correction keeps coming back?
- Where does human clerical effort go, and what does unverified work cost?
- Did a change to the system actually help, on the same historical tasks?

Answers to these exist today only as intuition. The Benchmark Contract already names the measure that would settle them, human interventions per independently verified successful outcome, and `compareBenchmarkRuns` already enforces controls on one pair of runs. What is missing is the cross-Work stage of the intelligence loop and an experiment that spans a corpus.

## Decision

Add two portable modules. Both are pure projections over existing evidence.

1. **Observer** (`src/observer.ts`). `observeFactory({ events, runs })` returns a `FactoryObservation`:
   - the North Star over the runs, with its coverage. It is `null` when nothing was verified, and it is labelled a floor when intervention counts were only runner-observed;
   - cohorts by task class × worker × model: verified completion, interventions per verified outcome, median cost, median time;
   - waste: unverified runs and their time and cost, failed and blocked attempts, verified Work left undecided;
   - judgment decisions, counted apart from clerical effort;
   - findings, each naming its Ledger events or benchmark cases, the Refiner proposal kind and classification it would become, and either a replay experiment or the reason none exists. The detectors are: cohort gap, quiet criterion, repeated context, recurring review finding, intervention hotspot, and capability candidate.

2. **Replay** (`src/replay.ts`). `summarizeReplayExperiment(spec, pairs)` takes the experiment a finding proposes and the paired runs that re-executed its historical cases.
   - Every pair passes `compareBenchmarkRuns` with only the experiment's permitted differences.
   - A refused pair makes the result `invalid`.
   - A case short of its trials makes it `insufficient-evidence`.
   - Otherwise the verdict is `improved`, `regressed`, `mixed`, or `no-difference`, and it is always marked `descriptive`.

`scripts/factory.mjs` exposes both as `npm run factory:observe` and `npm run factory:replay`.

### Invariants

- **Observation writes nothing.** The CLI verifies a private copy of the Ledger file, so it takes no lock and creates no file in the Ledger directory. A path with no Ledger, a Ledger that fails verification, or `--runs` inputs that hold no runs, and a Ledger that holds no events, are errors, never an empty report. Tests prove both.
- **Learning proposes; named authorities promote.** A finding carries a proposal kind, never a promotion. A quiet criterion is reported for falsification, never for removal.
- **Success means verified and accepted.** A run counts toward verified outcomes only when verification passed and it ended `verified` or `accepted`, as the Benchmark Contract defines success. A run that verified and then failed, was interrupted, or was rejected does not count. Guard `observer/success-is-verified-and-accepted`.
- **No denominator of zero.** Guard `observer/no-verified-outcome-means-no-north-star`.
- **A proven check is not inert.** A criterion with an executed negative control is never called quiet. Guard `observer/falsified-criterion-is-not-quiet`.
- **Refused trials are reported, never dropped.** Guard `replay/refused-pair-is-reported-never-dropped`.
- **Every case weighs the same.** A case takes exactly `trialsPerArm` pairs; a surplus pair is refused, so re-running a favourable case cannot outweigh the others. Guard `replay/cases-weigh-equally`.
- **Missing trials do not shrink the experiment.** Guard `replay/missing-trials-are-insufficient`.
- **Intervention floors never decide.** Interventions per verified outcome decides a replay verdict, or breaks a tie between Observer cohorts, only when both sides counted interventions completely. A runner-observed count is a floor. Guard `replay/intervention-floors-never-decide`.
- **One execution counts once.** A trial is named by its attempts. An attempt that appears twice, in one pair or across pairs, is refused, so a copied receipt with one field changed, or one execution relabelled as the other arm, cannot pass as a second trial. An arm with no attempts never executed and is refused. Guard `replay/one-trial-counts-once`.
- **Every varied dimension varies.** A pair that leaves any of the experiment's permitted dimensions unchanged is refused; an A/A pair is the extreme case. The result records what each arm actually ran (`armControls`) and prints it. Guard `replay/a-a-pair-is-not-evidence`.
- **Each arm is one configuration.** A pair whose variant or permitted-dimension values differ from the arm established by earlier pairs is refused. Guard `replay/arms-hold-one-configuration`.
- **Duplicates are counted once.** The Observer collapses repeated runs and repeated Ledger events, and reports how many (`duplicateRunsIgnored`, `duplicateEventsIgnored`). Two different events sharing one id fail closed, and so do two different runs claiming one attempt. Guards `observer/conflicting-event-ids-fail-closed`, `observer/conflicting-run-attempts-fail-closed`.
- **Deterministic.** The same evidence in any order, on any machine, yields the same observation with stable finding ids. Text is ordered by UTF-16 code unit, never by locale, and timestamps by parsed instant, so offsets sort correctly. A test runs the Observer under two locales and requires identical output.

### Not decided here

Scorer plugins, model-backed judges, task-class routing changes, a console, and production-outcome ingestion are in [Factory Runtime v1](../FACTORY_RUNTIME_V1.md) as proposed work. Each needs its own evidence and decision.

## Consequences

- The intelligence loop gains its population stage, and Refiner gains evidence that spans Works.
- Any team running the Harness gets the same report about its own repository, and the same experiment format to test a proposed fix. That is the basis for comparable, reproducible results across teams.
- Thresholds are configuration, not truth. Defaults are deliberately conservative: three runs per cohort, a 20-point completion gap, five evaluations across two Works for a quiet criterion. They should be recalibrated against real dogfood populations, as ADR 0023 did for the horizon.
- Cohort findings compare different cases and say so. Only a replay experiment holds the case constant.
