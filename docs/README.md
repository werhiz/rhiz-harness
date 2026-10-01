# Rhiz Harness Documentation

Rhiz Harness is a coding harness for humans and agents that turns models, coding agents, tools, runtimes, repositories, and people into a disciplined engineering system with bounded authority, durable evidence, independent verification, and organizational memory.

This index is the entry point for readers. The repository also contains architecture authority, executable contracts, ADRs, design documents, lessons, and reviews. Those categories have different weight. Read the status of a document before treating it as shipped behavior.

## Current status

Rhiz Harness is in active private dogfood and pre-alpha. The package remains private. The public open-source release boundary has not been crossed yet.

The shipped repository contains portable Work and event contracts, Board, Context, Crew, Guard, Verify, Router, Ledger, Refiner, integration control, sandboxing, Git worktree isolation, benchmarks, worker/provider seams, DSH adapters, a Codex App Server adapter, falsifiable guards, and a real repository Work runner.

The proposed `rhiz` CLI described in `DEVELOPER_EXPERIENCE_V1.md` is design authority through ADR 0015, while the full CLI does not ship yet. Current operator entry points are the npm scripts documented in `GETTING_STARTED.md` and `REPOSITORY_WORK_RUNNER.md`.

## Read this first

1. [Getting Started](GETTING_STARTED.md) for the current executable surface.
2. [Architecture](ARCHITECTURE.md) for the full system in one view.
3. [Canonical Vocabulary](VOCABULARY.md) for the nouns used across code, events, docs, and future UI.
4. [Execution Lifecycle](EXECUTION_LIFECYCLE.md) for what happens from intent through acceptance and learning.
5. [Security Model](SECURITY_MODEL.md) for trust boundaries and fail-closed behavior.
6. [Examples](EXAMPLES.md) for copyable Work and verification shapes.
7. [Repository Work Runner](REPOSITORY_WORK_RUNNER.md) for the strongest end-to-end dogfood path that exists today.

## Architecture authority

When documents conflict, use this order:

1. [Rhiz Harness Constitution](RHIZ_HARNESS_CONSTITUTION.md)
2. shipped code and executable safety contracts
3. [Kernel 0.1 Contract](KERNEL_0_1.md), [System Boundaries](SYSTEM_BOUNDARIES.md), and [Canonical Vocabulary](VOCABULARY.md)
4. accepted [Architecture Decision Records](decisions/README.md)
5. design documents
6. reviews and lessons unless an ADR, Rule, Guard, or shipped contract has adopted them

Source, tests, executed proof, and durable receipts determine what is actually working.

## Core concepts

| Topic | Primary document |
| --- | --- |
| Founding invariants | [Constitution](RHIZ_HARNESS_CONSTITUTION.md) |
| Architecture | [Architecture](ARCHITECTURE.md) |
| Portable core | [Kernel 0.1](KERNEL_0_1.md) |
| Module ownership | [System Boundaries](SYSTEM_BOUNDARIES.md) |
| Terms and meanings | [Vocabulary](VOCABULARY.md) |
| Work contracts and work types | [Work Contracts](WORK_CONTRACTS.md) |
| Board state and durable event vocabulary | [Board and Events](BOARD_AND_EVENTS.md) |
| End-to-end execution | [Execution Lifecycle](EXECUTION_LIFECYCLE.md) |
| Crew orchestration | [Crew v0](CREW_V0.md) |
| Workers and providers | [Workers v0](WORKERS_V0.md) |
| Verification | [Verify v1](VERIFY_V1.md) and [Verification and Acceptance](VERIFICATION_AND_ACCEPTANCE.md) |
| Rules | [Rules v1](RULES_V1.md) |
| Guard and authority | [Guard and Authority](GUARD_AND_AUTHORITY.md) |
| OS containment and sandboxing | [Containment and Sandboxing](CONTAINMENT_AND_SANDBOXING.md) |
| Context, Rules, Router, Refiner | [Intelligence Loop](INTELLIGENCE_LOOP.md) |
| Durable truth and recovery | [Ledger, Observability, and Recovery](LEDGER_OBSERVABILITY_RECOVERY.md) |
| Hosts and integrations | [Hosts, Providers, and Integrations](HOSTS_PROVIDERS_INTEGRATIONS.md) |
| Runtime/provider compatibility | [Compatibility and Versioning](COMPATIBILITY.md) |
| Benchmarks | [Benchmark Contract](BENCHMARK_CONTRACT.md) |
| API/package surface | [API Reference](API_REFERENCE.md) |
| Provenance | [Provenance](PROVENANCE.md) |

## Operator guides

| Task | Guide |
| --- | --- |
| Set up and validate the repository | [Getting Started](GETTING_STARTED.md) |
| Check current tool/provider versions | [Compatibility and Versioning](COMPATIBILITY.md) |
| Copy a bounded Work + verifier example | [Examples](EXAMPLES.md) |
| Run the complete quality gate | [Getting Started: validation](GETTING_STARTED.md#validate-the-repository) |
| Prove the Codex App Server path | [Getting Started: canary](GETTING_STARTED.md#run-the-real-codex-canary) |
| Run verified Work against another repository | [Repository Work Runner](REPOSITORY_WORK_RUNNER.md) |
| Diagnose common failures | [Troubleshooting](TROUBLESHOOTING.md) |
| Prepare for public release | [Open Source Release Checklist](OPEN_SOURCE_RELEASE_CHECKLIST.md) |

## Design and historical records

Design documents may contain valuable future behavior that is not shipped. Their status headers control how they should be read.

- [Developer Experience v1](DEVELOPER_EXPERIENCE_V1.md) describes the intended proof-first `rhiz` command experience. Its durable decisions live in ADR 0015.
- [Compound Engineering Plan](COMPOUND_ENGINEERING_PLAN.md) describes the broader engineering/learning direction.
- [Proof Admissibility working design](PROOF_ADMISSIBILITY_0_1.md) is subordinate to ADR 0021 and must not be treated as a shipped contract.
- `reviews/` records independent findings at specific points in time.
- `lessons/` records evidence-derived learning. A lesson becomes authority only when promoted into the appropriate Rule, Guard, ADR, verifier, or other canonical owner.

## Contributor guides

Repository-wide contribution rules live in [`CONTRIBUTING.md`](../CONTRIBUTING.md). Security reporting lives in [`SECURITY.md`](../SECURITY.md). Community conduct lives in [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md).

Architecture changes should follow the [ADR index and numbering discipline](decisions/README.md). A change that violates a constitutional `MUST` requires a constitutional amendment rather than a local exception.

## Status labels

Use these labels in documentation:

- **shipped**: implemented in code and covered by the repository's executable validation path.
- **accepted design**: an accepted ADR defines the decision, while some implementation may remain incomplete.
- **proposed**: useful design work that is not yet architecture authority.
- **working design**: reasoning material that must not be implemented as a contract without a later accepted decision.
- **historical/review**: evidence about a point in time, not current product truth by itself.

## North Star

> Reduce human interventions per independently verified successful outcome while improving reliability, learning, and organizational capability over time.

Every major feature should be explainable in terms of that metric or a necessary safety and portability constraint.
