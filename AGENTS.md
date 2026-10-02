# Rhiz Harness agent instructions

Read these before making substantial changes:

1. `docs/RHIZ_HARNESS_CONSTITUTION.md`
2. `docs/VOCABULARY.md`
3. `docs/SYSTEM_BOUNDARIES.md`
4. `docs/KERNEL_0_1.md`
5. `docs/COMPOUND_ENGINEERING_PLAN.md`
6. `docs/PROVENANCE.md`
7. `docs/BENCHMARK_CONTRACT.md`
8. `docs/decisions/README.md`, the decision record and its numbering discipline

## Authority order

The Constitution is the highest architectural authority in this repository. An ADR may refine a decision but may not silently contradict the Constitution. Code must follow the canonical vocabulary and dependency boundaries. Every ADR that governs current behavior is listed in `docs/decisions/README.md`; an ADR absent from that index is not authority, and a new ADR claims its number from that index on `main` rather than from a feature branch. The Compound Engineering Plan owns the learning loop and durable development direction unless an evidence-backed ADR explicitly changes it. Source, tests, executed falsifiers, and current issue state determine what is actually implemented and proven.

## Non-negotiable development rules

- Before integration, use the independent exact-candidate check and receipt in
  `docs/AGENT_PROOF_AND_CI_SPEND.md`. Kernel CI runs on every pull request;
  a failed, skipped, or empty hosted run is not proof.

- The portable core MUST NOT import DSH, Rhiz Protocol, or another concrete host/runtime.
- DSH is the first host implementation behind a Rhiz-owned interface.
- Board is the canonical owner of organizational state. Runtime/process/model observations never silently overwrite Board state.
- Work, decisions, authority, evidence, and outcomes must survive worker/process failure.
- A worker report is evidence, not acceptance.
- Consequential behavior must be reconstructible from typed events and evidence.
- Reuse from upstream open-source projects requires provenance and license classification before code is imported or adapted.
- Prefer mechanical, deterministic supervision before spending model tokens.
- New abstractions should be justified by real dogfood evidence or a clearly required portable contract.
- Benchmark claims must state the baseline, exact task/code identity, model/provider conditions, and verification method.
- Every consequential Work item should leave behind evidence sufficient to ask what the Harness should learn from it.
- Repeated failure without a proposed system-level improvement is a Harness failure.
- Prefer mechanized learning (Guard/Test/Verify/Router/Context) over accumulating prompt instructions where practical.
- Human clerical friction should be tracked under the One Less Action Doctrine and eliminated when safe.
- Any operation that deliberately breaks the candidate (mutation test, falsifier, negative control) runs through `src/disposable.ts`, never in place. See ADR 0019.
- Prefer closing an existing reproduced defect or acceptance gap over introducing a parallel subsystem.

## Current scope

Rhiz Harness is in **active dogfood and convergence**, not a Kernel-0.1-only phase. Core modules now exist; the job is to make them one trustworthy, zero-ceremony coding system.

The product loop to deepen is:

```text
intent
→ WorkContract
→ Context + Rules
→ Router + Crew
→ bounded execution
→ Guard
→ independent Verify / Review
→ Board acceptance
→ durable Ledger evidence
→ Refiner learning
```

For substantial work:

- start from a current open issue, reproduced defect, benchmark gap, or constitutional requirement;
- preserve one canonical owner for each fact;
- use existing Board, Crew, Runtime/Host, Guard, Verify, Ledger, Context, Router, Refiner, and integration seams before creating another one;
- treat zero-ceremony operation as a product requirement: pane IDs, Git choreography, provider trivia, process polling, and routine recovery are implementation details;
- keep DSH and every worker/provider replaceable;
- do not call a capability complete because its type or module exists; require the proof appropriate to the claim.

Do not build a terminal emulator, cloud control plane, marketplace, general-purpose organization product, or provider-specific parallel core unless reproduced evidence establishes a missing portable seam.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file, issue, test, or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
