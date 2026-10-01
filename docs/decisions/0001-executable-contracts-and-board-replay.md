# ADR 0001: Runtime schemas and replayable Board state

Status: accepted for Kernel 0.1

## Context

The founding architecture requires portable Work contracts, typed durable events, and a Board that owns canonical organizational state. TypeScript interfaces alone cannot validate data crossing host/provider/process boundaries, and mutable state stores make recovery and audit depend on hidden update history.

## Decision

1. Kernel contracts are defined as runtime-validating schemas with inferred TypeScript types. Zod is the initial schema implementation because it is TypeScript-first, mature, permissively licensed, and keeps validation close to the type definition.
2. The portable public concepts remain Rhiz-owned. Zod is an implementation dependency, not part of the domain vocabulary.
3. Board state is a pure deterministic projection over validated HarnessEvents in Ledger append order. `occurredAt` and `recordedAt` are evidence fields, not an instruction to reorder history during replay.
4. WorkContract starts at revision 1. Consequential changes are `work.amended` events that increment the revision. Verification and review results identify the revision they evaluated, so old proof cannot silently satisfy a changed contract.
5. A worker finishing an Attempt cannot accept Work. Acceptance requires a separate `work.accepted` event and the Board refuses to enter `accepted` unless the current contract's verification/evidence/review preconditions are satisfied.
6. Runtime/model/process activity is represented as Observation events. Observations can inform Board projections but cannot override terminal organizational state.
7. Failed Attempts do not erase Work. A later Attempt can continue the same Work identity.

## Consequences

- Replay tests become the primary proof for state semantics.
- Event schema changes require explicit schema-version and replay decisions.
- Host adapters must translate concrete runtime data into these portable schemas.
- Contract amendments intentionally invalidate prior verification when its revision no longer matches.
- We accept one small runtime schema dependency rather than building a bespoke validator.

## Deferred

- cross-Work dependency projection;
- persistent Ledger implementation;
- DSH HostAdapter;
- rich task graphs;
- automated Crew supervision;
- schema migration tooling beyond version 1.
