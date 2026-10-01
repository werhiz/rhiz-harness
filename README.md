# Rhiz Harness

**A coding harness for humans and agents being prepared for open-source release.**

Rhiz Harness turns models, coding agents, tools, runtimes, repositories, and humans into a disciplined engineering system with bounded authority, independent verification, durable evidence, and learning that compounds across Work.

Software engineering is Customer Zero. The portable contracts are designed to survive changes in models, agent products, execution hosts, repositories, and development workflows.

## Current status

**Public alpha, in active dogfood.** Portable Work and event contracts, Board, Context, Crew, Guard, Verify, Router, Ledger, Refiner, integration control, sandboxing, Git worktree isolation, benchmarks, worker/provider seams, DSH adapters, a Codex App Server adapter, falsifiable guards, and a real repository Work runner exist in executable form.

The current engineering phase is convergence: make those pieces operate as one trustworthy, low-friction coding loop, close authority and durability defects exposed by adversarial dogfood, and measure whether the Harness reduces human interventions per independently verified successful outcome.

## Start here

- [Documentation home](docs/README.md)
- [Getting started](docs/GETTING_STARTED.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Examples](docs/EXAMPLES.md)
- [Security model](docs/SECURITY_MODEL.md)
- [Repository Work runner](docs/REPOSITORY_WORK_RUNNER.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)

## Current operator path

Install dependencies and run the canonical repository gate:

```bash
npm install
npm run check
```

Run the live Codex App Server canary when Codex is installed and authenticated:

```bash
npm run canary:codex
```

Run one real bounded SHIP Work item against another Git repository:

```bash
npm run work:repository -- \
  --repo /path/to/target-repository \
  --contract /path/to/work.json \
  --verify /path/to/verification.json \
  --output /path/to/receipt.json
```

The repository runner uses isolated Git worktrees, contract-bound Guard mediation, independent exact-target verification, durable Ledger evidence, and Harness-owned candidate preservation. It deliberately does not push, merge, deploy, or accept the Work.

## Product loop

```text
intent
  -> WorkContract
  -> Context + Rules
  -> Router + Crew
  -> bounded worker execution
  -> Guard
  -> independent Verify / Review
  -> Board ready
  -> explicit acceptance
  -> durable Ledger evidence
  -> Refiner learning
```

Worker completion, verification, and organizational acceptance are different facts and remain separately authorized.

## Host strategy

DeepSeek Harness (DSH) is the first execution host because its plugin architecture and execution seams provide useful substrate. Rhiz Harness remains portable above that boundary so DSH can evolve, be replaced, or become one of several hosts without redefining Work, authority, verification, acceptance, or learning.

Codex App Server also has a direct Rhiz-owned adapter used by the live canary and repository Work runner.

## Relationship to Rhiz Protocol

Rhiz Harness is standalone. Rhiz Protocol is a major Customer Zero and may supply organization-specific Rules, Context, policies, verification profiles, graph data, and adapters. The portable Harness does not depend on Rhiz Protocol.

## License and release status

Rhiz Harness is open source under the [Apache License 2.0](LICENSE). Upstream work it derives from is attributed in [`NOTICE`](NOTICE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with per-module records in [`provenance/`](provenance/).

This is an alpha. Contracts change between commits, and no release line is supported yet. Install from Git at an exact commit:

```bash
npm install github:werhiz/rhiz-harness#<commit>
```

The npm package is not published yet. `package.json` keeps `"private": true` so nothing reaches the registry by accident; the rest of the public-release gate is tracked in the [Open Source Release Checklist](docs/OPEN_SOURCE_RELEASE_CHECKLIST.md).

### History

Development began in a private repository, and this repository's history starts at the public release. Pull request and issue numbers cited in documents written before that point, such as ADRs and lessons, refer to the private archive, not to this repository.

## North Star

> **Reduce human interventions per independently verified successful outcome while improving reliability, learning, and organizational capability over time.**

## Architecture authority

The highest architectural authority is [`docs/RHIZ_HARNESS_CONSTITUTION.md`](docs/RHIZ_HARNESS_CONSTITUTION.md). The current authority order, vocabulary, system boundaries, ADR record, and status labels are indexed in [`docs/README.md`](docs/README.md).

Source, tests, executed falsifiers, durable receipts, and current issue state determine what is actually implemented and proven.