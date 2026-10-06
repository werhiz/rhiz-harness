# Repository Work Runner

Status: current dogfood operator guide for `scripts/run-repository-work.mjs`.

## What it proves

The repository Work runner is the strongest end-to-end operator path currently shipped in Rhiz Harness. It runs one bounded SHIP WorkContract against a real Git repository, independently verifies the resulting candidate, pushes and reads back an immutable checkpoint, queues it through the Integration Controller, atomically advances the one remote Work ref, closes and reopens the durable Ledger, and emits a machine-readable receipt.

It deliberately stops before PR merge, deployment, publication, or organizational acceptance. Its pushes are limited to Harness-owned `refs/rhiz/*` checkpoint and Work namespaces.

## Command

```bash
npm run work:repository -- \
  --repo /absolute/or/relative/path/to/repository \
  --contract /path/to/work.json \
  --verify /path/to/verification.json \
  --output /path/to/receipt.json
```

Optional arguments:

```text
--base <git revision>
--remote <git remote name>
--prepare <prepare.json>
--ledger <durable ledger directory>
--output <receipt.json>
--benchmark-case <stable case id>
--benchmark-variant <variant id>
--resume true
--correlation-id <consumer build reference>
```

`--resume true` continues the Work its Ledger already holds. Any attempt whose process ended without a
terminal event is closed as a recoverable failure by `service:repository-runner-resume`. Then the
remaining `maxAttempts` budget is spent on the same Work. Resume refuses terminal Work, `ready` Work,
a spent budget, a contract that differs from the one the Work was opened with, and benchmark runs.

Worker selection reads accepted outcomes from every other Work Ledger in the repository through
`RouterBridge` `evidenceEvents` (ADR 0026). The receipt records how many Work items were read, and
which Ledgers could not be read, in `composition.routerEvidence`.

The operator loop in `scripts/rhiz-harness.mjs` (`npm run operator -- <verb>`) wraps this runner for
`start` and `resume`. It adds `status`, `review`, `accept`, `reject`, and retryable `harvest` over the same Ledgers.

`--correlation-id` records a consumer reference on Work creation and subsequent
execution evidence. Resume inherits that reference and rejects a different explicit
reference before orphan closure. It is linkage only, never execution permission.

`preflightCodexModel` in the published `codex` adapter reads the effective CLI
configuration and complete account catalog, including hidden entries and pagination,
without starting a thread or inference. Consumer replay runners use it before
workspace preparation. It refuses an unavailable configured model without choosing
a fallback. Actual execution model attribution still comes from `thread/start`.

Default base is the target repository's current `HEAD`.
`--benchmark-variant` requires `--benchmark-case`. Benchmark arguments do not change execution authority, worker selection, verification, delivery, or acceptance. They add a canonical `BenchmarkRun` measurement record to the repository-work receipt. Codex model and reasoning effort are read from the provider's own `thread/start` response and carried through `WorkerResult`; they are never operator-invented benchmark labels.

A repository run whose candidate passes independent verification records benchmark outcome `verified`. It does **not** record `accepted`: the runner deliberately stops with Board state `ready` and `accepted: false`. Organizational acceptance remains a later governed fact.

When benchmark mode is enabled, runner exceptions are also emitted as benchmark evidence before cleanup. A failure that occurs before a worker is selected may truthfully contain zero attempt ids and no worker provider. Missing provider usage/cost remains absent and measurement coverage says `unavailable`; it is never coerced to zero.

Comparable arms share the Work id, task identity, and base on purpose, so each benchmark execution gets its own durable Ledger stream under `--ledger`/`benchmark-runs/<run id>` and integrates into its own remote ref, `refs/rhiz/work/<work>/benchmark-runs/<run id>/candidate`. An earlier arm advancing its ref therefore cannot block a later arm from initializing at the shared base. Non-benchmark Work keeps the single `refs/rhiz/work/<work>/candidate` ref.

Like-for-like benchmark comparison refuses changed controlled dimensions such as worker provider, host, model, verification policy, context strategy, or measurement-coverage method. Experiments that intentionally vary a dimension must declare it with `benchmark:compare -- --vary <field,...>`; the comparison receipt then records the baseline and candidate values for that experimental variable. This supports agent-alone versus Rhiz Harness and previous-Harness-version versus candidate-version experiments without silently relaxing unrelated controls.

By default the Ledger is preserved under the repository's Git metadata. Use
`--ledger` only to choose a different durable replay location.

## Preconditions

The runner requires:

- a Git repository;
- a valid SHIP WorkContract;
- a verification plan for that exact Work at contract revision 1;
- a positive `workerPolicy.maxAttempts` repair budget;
- a Work creator record whose actor kind is `human`;
- a working Codex CLI / App Server authentication path;
- verification commands that can execute locally under the verifier policy.

The creator-kind requirement validates the recorded audit shape only. `ActorRef.kind` is self-declared metadata and does not authenticate a person. Current private dogfood relies on the operator boundary around contract creation. Any public or multi-user product surface must authenticate and authorize the person before writing a human-only actor claim.

The Work's write scope must map cleanly to repository paths the candidate is allowed to change.

## Execution flow

```text
target repository + base revision
           |
           v
fresh isolated Git worktree
           |
           +--> optional trusted preparation
           |
           v
Crew + Codex App Server worker
           |
           +--> contract-bound Guard mediation
           +--> changed-path enforcement
           |
           v
candidate preserved by exact Git identity
           |
           v
independent LocalCommandVerifier
           |
           +--> FAIL: next bounded worker attempt, if budget remains
           |           (verifier refusal arrives only as tainted data)
           |
           +--> EXHAUSTED: Work rejected -> Refiner -> durable replay receipt
           |
           v PASS
verification PASS on exact candidate
           |
           v
immutable remote checkpoint ref
           |
           v
IntegrationCheckpoint -> automatic queue -> serialized lock
           |
           v
final exact-head proof -> compare-and-swap remote Work ref
           |
           v
Board replay = ready
           |
           v
Ledger close -> reopen -> replay -> integrity
           |
           v
repository-work-run/v1 receipt
```

## Trusted preparation

Some repositories need ignored dependencies materialized before a worker can execute, for example installing packages into ignored directories.

Use `--prepare` with a JSON file:

```json
{
  "command": "pnpm",
  "args": ["install", "--frozen-lockfile", "--ignore-scripts"]
}
```

Preparation runs inside the isolated worktree before the baseline artifact identity is pinned.

The runner verifies that preparation did not edit tracked source or move `HEAD`. Preparation is for identified pre-baseline setup, not a hidden implementation step.

Keep preparation commands deterministic and as narrow as possible. `--ignore-scripts` is appropriate when dependency lifecycle scripts are unnecessary because preparation runs before the worker authority path.

## Work contract requirements

The contract should make the mutation boundary clear.

Example shape:

```json
{
  "id": "work:fix-parser-edge",
  "objective": "Fix the parser edge case and add regression coverage.",
  "type": "SHIP",
  "scope": [
    { "uri": "repo://target", "kind": "repository" }
  ],
  "writeScope": [
    { "uri": "repo://target/src/parser", "kind": "directory" },
    { "uri": "repo://target/test/parser", "kind": "directory" }
  ],
  "nonGoals": ["Do not change unrelated public APIs."],
  "authority": {
    "grants": [
      {
        "action": "read",
        "resources": [{ "uri": "repo://target", "kind": "repository" }],
        "constraints": []
      },
      {
        "action": "write",
        "resources": [{ "uri": "repo://target/src/parser", "kind": "directory" }],
        "constraints": []
      }
    ],
    "requiresHumanApproval": []
  },
  "acceptanceCriteria": [
    {
      "id": "criterion:regression",
      "description": "The reported parser edge case passes and regression coverage fails without the fix.",
      "required": true
    }
  ],
  "requiredEvidence": [
    {
      "id": "evidence:test",
      "description": "Automated regression test evidence.",
      "acceptedKinds": ["test"],
      "required": true
    }
  ],
  "context": {
    "strategy": "minimal",
    "resources": [],
    "includeHistory": true
  },
  "dependencies": [],
  "workerPolicy": {
    "preferredProviders": ["worker:codex-app-server"],
    "maxAttempts": 1,
    "allowParallelAttempts": false,
    "explicitProviderAuthorizations": []
  },
  "verificationPolicy": {
    "required": true,
    "independentActor": true,
    "reviewRequired": false,
    "falsifiabilityExemptions": []
  },
  "createdBy": {
    "id": "human:operator",
    "kind": "human"
  },
  "createdAt": "2026-08-28T20:00:00-04:00"
}
```

Validate real files with the shipped parser. Do not treat this example as a substitute for the current schema. The example's `createdBy.kind` records the claimed actor class; it is not an authentication token.

## Verification plan

The verification plan must target the same `workId` and contract revision 1.

Verification should run independent deterministic checks over the exact candidate. Required criteria and evidence requirements must be covered.

Use negative controls for checks where a known perturbation can prove the verifier detects failure. See [Verify v1](VERIFY_V1.md) and [Verification and Acceptance](VERIFICATION_AND_ACCEPTANCE.md).

## What the runner refuses

Current v0 refuses or does not perform:

- SCOUT Work;
- REVIEW Work;
- multiple worker attempts;
- creator records whose actor kind is not `human`;
- verification plans for another Work/revision;
- source-changing preparation before the baseline;
- candidate changes outside Work write scope;
- failed independent verification;
- Board projection violations;
- PR merge;
- pushes outside Harness-owned `refs/rhiz/*` namespaces;
- organizational acceptance.

The narrowness is intentional. The runner is a proof-bearing building block, not a convenience script with hidden authority.

## Candidate preservation

After execution, the runner captures the candidate's exact HEAD, tree, and changed paths. It preserves the candidate before independent verification and promotes a passed candidate to a Harness-owned verified ref.

The source repository can therefore recover the exact tree after the temporary worktree is cleaned up.

Do not manually move the preserved ref and continue treating old verification as current proof. Verification is bound to the candidate identity recorded in the receipt.

## Receipt

The runner emits schema:

```text
rhiz/repository-work-run/v1
```

The receipt includes:

- generated time;
- repository root;
- Work id;
- base revision;
- optional preparation record;
- worker provider id;
- candidate HEAD/tree/rescue ref/remote status/Work ref/changed paths;
- verification id and result event;
- falsifiability information;
- individual check results and evidence;
- full Board integration projection, state, and violation count;
- `accepted: false`;
- integration checkpoint;
- durable Ledger head digest.

Preserve the receipt when the run matters. It is the compact operator-facing record linking artifact, proof, Board state, and durable history.

### Benchmark instrumentation

When `--benchmark-case` is supplied, the receipt also carries a `benchmarkRun` parsed by the canonical `BenchmarkRunSchema` in `src/benchmark.ts`. Use an explicit `--benchmark-variant` whenever the run will be compared with another run of the same case.

The benchmark record currently measures:

- exact benchmark case and variant identity;
- exact base and candidate identities;
- start/end timestamps and therefore runner-observed wall-clock duration;
- attempt identities and whether repair was required;
- worker provider identity;
- independent-verification result;
- runner-observed human interventions;
- provider token/cost usage only when the provider boundary actually reports it.

Missing usage is **absent**, never zero. `measurementCoverage.usage = "unavailable"` means the current provider boundary supplied no trustworthy token/cost figures. This runner must not estimate or reconstruct provider spend after the fact.

`humanInterventions` is likewise labelled `runner-observed` until every relevant operator interaction is captured through a durable intervention seam. A zero-length array therefore means the runner observed none, not that no human interaction occurred anywhere outside the runner.

A successful repository replay records benchmark `outcome: "verified"` after independent verification. The containing repository-work receipt still carries Board `accepted: false`; the runner does not perform organizational acceptance, merge, deployment, or publication. Reserve benchmark `accepted` for a separately evidenced organizational acceptance event.

Compare two like-for-like benchmark runs with:

```bash
npm run benchmark:compare -- baseline-receipt.json candidate-receipt.json
```

The comparison refuses different benchmark case ids, different base identities, missing variants, or identical variants. It reports deterministic deltas for duration, attempts, interventions and, when both providers supplied it, token/cost usage. A better delta is evidence for investigation; it is not by itself proof that a prior reusable capability caused the improvement.

## Why `accepted` is false

The runner proves execution and verification. It does not own the organization's final decision.

A future product surface may let an authenticated and authorized decision-maker inspect the verified candidate and emit `work.accepted`. That surface must enforce the real identity and organizational permission boundary before recording the event. Board itself enforces readiness and refuses acceptance by any actor that executed the Work; it does not authenticate `ActorRef` identity.

Keeping acceptance separate preserves a clean boundary even when a future user experience compresses the review and decision into one clear action.

## Failure handling

If execution fails, inspect:

- Crew mission status/error;
- changed-path violations;
- worker activity observations;
- Guard evaluations;
- preserved candidate/rescue ref if one exists.

If verification fails, inspect the check receipt and falsifiability results. Fix the contract, implementation, or verifier depending on which claim failed. Do not simply rerun until green without understanding whether the verifier is discriminating.

If Ledger reopen or replay fails, treat it as a durability defect. A transient successful worker run is insufficient when the durable record cannot be trusted.

## Relationship to the future CLI

The accepted Developer Experience direction eventually compresses this machinery behind commands such as `rhiz ship`, `rhiz diff`, `rhiz verify`, and `rhiz accept`.

Until those commands ship, this runner is the current honest operator surface for end-to-end repository Work.


### Capability exposure in factory replays

Pass an experiment-aware Protocol worker packet with `--benchmark-replay-packet <file>`
alongside the matching benchmark case, variant, and base. The adapter rejects mismatched
identities and altered content, adds digest-bound reusable content through the existing
Context resource path, and records `capabilityExposureDigest` on the canonical BenchmarkRun.
The baseline has explicit null exposure. Comparisons must explicitly permit the
`capabilityExposureDigest` difference. A prepared packet is not an executed or accepted run.

Intervention comparison metrics are omitted unless both runs have complete capture.
Runner-observed empty arrays cannot establish that no human intervened.
