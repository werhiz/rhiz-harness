# Follow-through supervision

`FollowThroughSupervisor` coordinates bounded assignments through the existing
Crew, worker catalog, Guard, and Ledger. It projects status from the same Board
events used by the operator. It owns no second work-state store.

The motivating gap is an account with useful incoming information and open
promises, but uneven delivery and follow-up. A product integration can map an
authorized promise to a WorkContract and persist a FollowThroughAssignment with
an opaque account/context reference, source reference, due date and priority.
Private messages and client names belong in that integration's authorized
Context, not in portable Harness source or public fixtures.

## Host integration

```ts
import { FollowThroughSupervisor } from "@werhiz/rhiz-harness";

// Reuse the host's durable single-writer Ledger, worker catalog, workspace
// provider, operator identity and existing Router/Context/Refiner bridges.
const coordinator = new FollowThroughSupervisor({
  ledger, workerCatalog, workspaceProvider, actor,
  router, context, refiner,
});

// assignments are persisted and permission-filtered by the product adapter.
const cycle = await coordinator.cycle(assignments, 1);
for (const item of cycle.items) {
  // The product routes these next actions to its existing operator paths.
  // 'verify', 'review', and 'accept' describe pending actions, not completion.
  await presentNextAction(item);
}
// Keep cycle.runs and their workspace custody until independent verification
// and integration consume their artifacts. Explicitly close each handle only
// when its output is preserved/consumed. Do not auto-delete unverified output.
```

The host owns persistent assignment metadata, periodic/event-triggered ticks,
identity-to-account authorization, independent verification and review,
integration/publishing, delivery evidence, and authorized communication.
Calling `cycle` is bounded execution, not installing a daemon or activating a
client account. This module does not ingest email, send messages, accept Work,
or assert that a customer received or approved a deliverable.

## Dispatch and recovery

- Higher priority wins; equal priorities use earliest due date, then Work ID.
- A cycle starts at most the explicit dispatch bound (one by default).
- Workers are selected and started by Crew; assignment is evidenced by its
  durable task/Attempt events. Merely listing a preferred provider assigns no one.
- Every launch replays the Work. The exact last-event cursor is checked again
  under Crew's Work-stream lock, before workspace acquisition or worker effects.
  A concurrent operator changing that stream makes the stale dispatch fail closed.
- Same-Ledger coordinator cycles serialize in process. The durable Ledger's
  existing one-writer lock is required across processes; an in-memory Ledger is
  appropriate only for tests or nonpersistent embedding.
- A finished Attempt waits for verification; it never becomes accepted Work
  merely because a worker returned. Readiness uses the existing operator/Board
  acceptance logic, including current revision and evidence requirements.
- Expired or missing leases on unfinished Attempts surface `recover`. They
  retain their owner until the operator performs explicit recovery; the
  coordinator never forges a failure or silently starts a competing writer.
- Failed Attempts, failed checks, orphaned assignments, exhausted budgets,
  open decisions and mismatched/amended contracts surface `resolve`. They
  require a repair or organizational decision rather than blind retries.
- Accepted, rejected and cancelled Work are closed and retain their distinct
  canonical state. Closing a cancelled item does not count as client success.

Version one dispatches independent fresh-workspace missions. A dependent Crew
graph, especially a REVIEW inheriting a SHIP workspace, must be executed as one
intact Crew plan through the existing operator path; the schema refuses to split
it into independent assignments. The existing Crew authority and provider
eligibility rules apply unchanged.

## Preserve selected design quality

Product adapters must classify UI/site implementation as `deliveryKind:
"interface"`. Those assignments require a `designContinuity` policy containing
the selected executable design's URI, SHA-256 digest and concrete protected
features. Use `withDesignContinuity(work, policy)` before creating that Work.
The assignment schema refuses an unbound contract or missing design policy.

The binding retains that reference in Context and adds required criteria for
each protected feature and desktop/mobile rendered inspection. Required evidence
includes distinct desktop and mobile screenshots, browser interaction proof,
and independent comparison with the selected reference. Independent verification
and review remain required. Existing Work must be explicitly amended, never
silently rewritten. Tool authority and write scope are unchanged.

For an operational map, protected features should specify selecting drivers,
assigning actual jobs, geographic orientation and the useful interaction states,
alongside the selected visual composition. A decorative replacement fails those
criteria. Existing typography, image treatment, hierarchy and purposeful motion
should be preserved according to the project-specific selection.

These are executable contract/evidence requirements, not a machine aesthetic
score. The independent reviewer must inspect the actual render and exercise the
actual interaction. Supplying a screenshot alone does not establish quality.
The host is responsible for correct delivery classification and retrieving the
selected artifact; this library cannot infer those facts from arbitrary text.

## Verification

`test/follow-through.test.ts` exercises actual Crew provider invocation, durable
assignment events, concurrent cycles, priority/bounds, failure isolation,
canonical holds and contract mismatch, expired ownership, and durable Ledger
reopen. Additional review regressions cover truthful lifecycle projections and
stale dispatch refusal. All fixtures are synthetic. These tests prove the
portable coordination behavior; live customer integration requires its own
end-to-end host proof.
