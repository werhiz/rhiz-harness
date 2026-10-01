# Contributing to Rhiz Harness

Rhiz Harness is currently in private pre-alpha dogfood and is being prepared for an eventual open-source release. Contributions should strengthen one coherent Harness rather than add parallel systems.

## Before changing code

Read, in order:

1. [`docs/RHIZ_HARNESS_CONSTITUTION.md`](docs/RHIZ_HARNESS_CONSTITUTION.md)
2. [`docs/VOCABULARY.md`](docs/VOCABULARY.md)
3. [`docs/SYSTEM_BOUNDARIES.md`](docs/SYSTEM_BOUNDARIES.md)
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
5. [`docs/decisions/README.md`](docs/decisions/README.md)
6. [`AGENTS.md`](AGENTS.md) for repository-wide implementation rules

For specialized work, read the relevant module document and ADR before editing the code.

## What makes a good contribution

Prefer work grounded in one of these:

- a reproduced defect;
- an open acceptance gap;
- a failing or insufficient proof;
- real dogfood friction;
- a benchmark gap;
- a constitutional requirement;
- a necessary portability or security seam.

Prefer strengthening an existing canonical module over creating a sibling subsystem.

## Architectural rules

The following are load-bearing:

- portable core does not import DSH, Rhiz Protocol, or another concrete host/runtime;
- Board owns organizational state;
- Ledger owns durable event history;
- execution, verification, and acceptance remain separate;
- authority is explicit and mechanically enforced where consequential;
- workers/providers remain replaceable;
- Work survives workers and processes;
- external observations enter as typed observations/evidence rather than silently mutating canonical truth;
- proof binds to exact artifact identity;
- learning proposals do not self-authorize permanent policy;
- imported/adapted upstream work carries provenance.

A change that violates a constitutional `MUST` requires a constitutional amendment, not a local exception.

## Development setup

Requirements:

- Node.js 20+
- npm version compatible with the repository `packageManager`
- Git

Install:

```bash
npm install
```

Run the complete gate:

```bash
npm run check
```

Read [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) for current integration/canary commands.

## Tests and proof

Match proof strength to the claim.

Examples:

- parser/schema change: positive and negative schema tests;
- authority boundary: allowed and forbidden behavior;
- Guard: executable falsifier that fails when the mechanism is removed;
- verifier: positive behavior plus a negative control where falsifiability applies;
- artifact identity: prove drift is detected;
- durability: close/reopen/replay rather than same-process assertions only;
- provider capability: real adapter behavior where the claim concerns the real provider;
- performance/autonomy: benchmark with controlled baseline and exact task identity.

A safety comment or prompt instruction is not proof of enforcement.

## Full local gate

`npm run check` currently covers the repository's portable boundary, barrel/operator consistency, build, tests, Guard falsifiability, proof suite, and CI parity.

Run narrower stages while developing. An independent check agent runs the
complete gate on the exact candidate and records its receipt before integration;
see `docs/AGENT_PROOF_AND_CI_SPEND.md`. GitHub Actions has no automatic
triggers in this repository.

If a live integration is affected, run its proof path too when credentials/environment are available:

```bash
npm run canary:codex
npm run smoke:dsh
npm run smoke:dsh-products
npm run proof:dsh-products
```

Do not describe a live integration as proven when only a mock/unit path was run.

## WorkContract and authority changes

When changing Work, authority, Guard, workspace, verification, or acceptance behavior, include:

- the exact authority gained/lost;
- canonical fact owner;
- failure behavior when required facts are absent;
- durable evidence produced;
- compatibility/migration impact;
- adversarial test or falsifier;
- ADR when architecture changes.

## Disposable proof rule

Any operation that deliberately breaks or perturbs a candidate for proof must use the disposable-derivative lifecycle. Never mutate the canonical candidate in place for a negative control, mutation test, or falsifier.

## Architecture Decision Records

Use an ADR for durable architecture decisions involving ownership, authority, portability, lifecycle semantics, public command ontology, proof policy, or a comparable load-bearing boundary.

Rules:

- claim the next number from `docs/decisions/README.md` on current `main`;
- one number belongs to one document forever;
- land the ADR with the work it decides;
- update the ADR index in the same change;
- supersede explicitly rather than deleting history.

Do not write an ADR for ordinary implementation detail that does not change architecture.

## Documentation

Update documentation in the same change when behavior, commands, public types, security claims, status, or architecture changes.

Use the status vocabulary in [`docs/README.md`](docs/README.md): shipped, accepted design, proposed, working design, historical/review.

Keep proposed experience separate from currently executable behavior.

## Provenance

Before importing or materially adapting code, algorithms, schemas, or architecture from another project:

1. identify the upstream source and version/commit;
2. classify its license;
3. record whether the Rhiz implementation is invented, adapted, derived, vendored, or integrated;
4. preserve required attribution/notices;
5. update the repository provenance record.

See [`docs/PROVENANCE.md`](docs/PROVENANCE.md).

## Pull requests

A strong PR explains:

- the problem/evidence;
- the smallest coherent change;
- which architectural owner is affected;
- how authority/security changes, if at all;
- what tests/proofs discriminate the fix;
- exact validation commands run;
- documentation/ADR/provenance updates;
- remaining limitations.

Keep unrelated cleanup out of a proof-sensitive change unless the cleanup is required to make the proof truthful.

## Review standard

Review should ask:

1. Does this solve the reproduced problem?
2. Does it preserve one canonical owner per fact?
3. Does it reuse existing seams before adding another abstraction?
4. Are authority and artifact identity explicit?
5. Can the success claim be independently falsified?
6. Does the result survive process failure where durability is claimed?
7. Does the documentation say only what the code proves?
8. Does this reduce or increase human clerical management?

## Security reports

Do not open a public issue for a vulnerability that would expose exploit details. Follow [`SECURITY.md`](SECURITY.md).

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
