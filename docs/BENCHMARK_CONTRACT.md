# Benchmark Contract

Rhiz Harness must earn claims of superiority through reproducible evidence.

## North Star metric

> **Human interventions per independently verified successful outcome.**

A successful outcome means Work was accepted after satisfying its required verification policy. An agent saying "done" is not a successful outcome.

## Human intervention

Count a human intervention when a person must perform an action to keep execution moving or repair/coordinate work that the system could in principle have handled.

Examples:

- writing a follow-up prompt because the worker lost context;
- manually checking whether a worker/process is alive;
- locating a worktree or branch;
- copying logs between systems;
- manually routing an obvious review;
- repeating an already-known correction;
- running routine verification that policy could have triggered;
- repairing incorrect work;
- manually resuming recoverable interrupted work.

Track true product/judgment decisions separately. The goal is not to hide consequential human decisions; it is to remove clerical management.

## Required comparison controls

A benchmark claim should hold constant where practical:

- repository and base code identity;
- task/WorkContract;
- acceptance criteria;
- model/provider and effort level;
- available tools/authority;
- machine class and relevant environment;
- verification method.

When a variable cannot be held constant, record it explicitly.

## Comparison modes

At minimum support:

1. `agent-alone`: worker with its ordinary native environment;
2. `reference-harness`: an external harness when a fair comparison is possible;
3. `rhiz-harness`: the candidate Rhiz configuration.

Comparisons should measure the system, not merely one lucky run. Repeated trials are required for statistical claims.

## Competitive experiments

The [Competitive Benchmark Program](COMPETITIVE_BENCHMARKS.md) applies this
contract to named external systems. It records source-backed capabilities as
experiment proposals, not as reproduced Rhiz results or claims of superiority.
Use controlled harness experiments when runtime controls can be matched; use
product outcome experiments when they cannot, and disclose the differences.
No live paid benchmark results are currently claimed.

## Supporting metrics

Record when available:

- independently verified completion rate;
- human repair rate;
- regression rate;
- repeat-mistake rate;
- recovery rate after process/worker interruption;
- wall-clock time;
- model/API cost;
- input/output/reasoning tokens or equivalent usage;
- agent/model turns;
- context size and ContextPack composition;
- number and duration of blocked decisions;
- verification coverage and strength;
- autonomous continuation rate;
- changed artifact/code identity;
- number of workers involved;
- wasted/redundant work;
- acceptance latency after worker finish.

## Evidence requirements

Every benchmark run must be attributable to:

```text
benchmarkCaseId
workId
attemptIds
repository/artifact base identity
result identity
host
worker provider
model/config when available
context strategy
verification policy
human interventions
outcome
raw evidence references
```

A benchmark dashboard is a projection of this evidence, never the source of truth.

## Anti-gaming rules

- Do not weaken acceptance criteria to improve completion rate.
- Do not count worker self-report as independent verification.
- Do not omit failed/interrupted attempts from aggregate results.
- Do not compare different code bases without disclosure.
- Do not hide human setup or repair work outside the measured window.
- Do not claim cost improvements when provider usage data is unavailable.
- Do not generalize from one task class without evidence.

## Release discipline

Major performance or autonomy claims should cite a benchmark suite and exact Harness version. A feature may ship before measurable improvement is proven, but claims that it makes Rhiz better must eventually be tied to evidence.

## First benchmark milestone

Kernel 0.1 should include one bounded real-world coding case run as:

```text
same WorkContract
same base commit
same worker/model when possible

agent alone
vs
Rhiz Harness
```

The first purpose is not marketing. It is to verify that Rhiz can measure its own effect without relying on intuition.
