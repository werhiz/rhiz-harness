# Lesson 0001: Smoke gates must assert the intended outcome

## Observation

The first keyless DSH integration job received a failed `WorkerResult`, projected the Board to `failed`, and still exited successfully because the smoke script derived its expected state from the observed failure.

## Root cause

The test checked internal consistency rather than the intended outcome. It proved that Rhiz represented a failed execution consistently. It did not prove that DSH executed successfully or returned control through the HostAdapter.

A second issue amplified the problem: the workflow installed DSH packages through an ephemeral root `npm install`, while the optional SDK peer remained unavailable to the adapter's runtime import. The workflow never asserted the SDK import or runtime binary before starting the smoke.

## Mechanized correction

- The smoke now requires `WorkerResult.status === "finished"`.
- The Board must reach `verifying` with zero projection violations.
- The replay response must contain the expected keyless DSH proof phrase.
- At least one validated DSH observation must be present.
- A unit test proves that a failed worker and `failed` Board state cannot satisfy the smoke.
- CI installs DSH into an isolated pinned dependency root, links the DSH package scope for adapter resolution, and verifies the SDK import and runtime binary before execution.

## Reusable rule

A proof gate must encode the desired end state independently of the system output being tested. Never derive expected success from the observed result. Infrastructure availability must be asserted before the behavior it is meant to prove.

## Compound destination

This lesson belongs in Verify and future Host conformance suites. Every integration lane should distinguish:

1. transport available;
2. execution started;
3. execution completed successfully;
4. canonical Board state advanced as intended;
5. evidence matched the exact proof target.
