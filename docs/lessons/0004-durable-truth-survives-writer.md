# Lesson 0004: Durable truth must survive its writer

## Observation

Before Durable Ledger v1, Rhiz could reconstruct Board state only while the in-memory Ledger process remained alive. A killed Harness could leave a worker process, workspace, or external side effect behind while erasing the organizational history needed to understand what had happened.

## Root cause

The architecture correctly treated events as canonical truth, but the only implementation stored those events in process memory. The semantic model was durable; the storage was not.

## Mechanized correction

- Event history is appended to a synced local file before the append succeeds.
- Every record is globally ordered, stream ordered, schema validated, and hash chained.
- One live writer owns the Ledger through an explicit lock.
- Dead-writer locks are recovered; live or malformed ownership fails closed.
- Reopen validates the entire chain before exposing history.
- An incomplete final crash tail may be removed to the last complete record.
- Complete corruption, tampering, sequence gaps, and duplicate identities are never silently repaired.
- A process-kill test proves recovery from running Work through replacement execution, independent verification, acceptance, and a second reopen.

## Reusable rule

If organizational state matters after a process exits, acknowledgement must occur only after that state is durably recorded and independently recoverable. Process memory may cache truth. It may not be the only place truth exists.

## Compound destination

This lesson governs future Crew resume, Runtime recovery, Board projections, verification receipts, Refiner history, and remote replication. Every new stateful subsystem must identify which facts survive process death and prove that recovery path directly.
