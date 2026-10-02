# Competitive benchmark program

Status: proposed experiments and source review, 2026-10-02. No competitive
execution results are claimed. This document applies the existing
[Benchmark Contract](BENCHMARK_CONTRACT.md); it introduces no new runtime,
acceptance authority, or automatic policy promotion.

## Target

Earn a lower number of human interventions per independently verified accepted
outcome, with reliable recovery and reusable learning. Compare capability by
capability. A coding harness, a collaboration workspace, and a personal agent
serve different scopes; a single feature count cannot rank them fairly.

## Named comparators

The following are first-party documentation or product claims, reviewed on
2026-10-02. They are research inputs, not results reproduced by Rhiz. No source
code was copied or adapted for this review.

| Comparator | Reference and documented strength | Experiment to run |
| --- | --- | --- |
| Hermes Agent, Nous Research | [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/) documents persistent curated notes and conversation search. | Learn a procedure, restart, reuse it, then correct it when its source changes. |
| OpenClaw | [Restart recovery](https://docs.openclaw.ai/gateway/restart-recovery) documents durable recovery, ownership and handling of ambiguous effects. | Kill the process before and after a simulated external effect; reconcile without repeating the effect. |
| Buzz, Block | [Repository](https://github.com/block/buzz) documents shared rooms, agent identities, workflows and event history. Its [information-flow design](https://github.com/block/buzz/blob/main/docs/practical-information-flow-for-buzz-agents.md) is explicitly a draft. | Hand off work across two agents while changing room membership and retaining the correct evidence permissions. |
| OpenMuse, CopilotKit | [Repository](https://github.com/CopilotKit/openmuse) and [verification record](https://github.com/CopilotKit/openmuse/blob/main/docs/VERIFICATION.md) describe persistent browser work, takeover, task recovery, leases and approval tests. | Race two claimants, expire one lease, resume and reject the stale worker's completion. |
| Instinct | [Product](https://instinct.com/) presents a text/call agent with connected context, phone/computer actions and proactive follow-through. | Complete a bounded multi-app task after the user closes the conversation; count every required follow-up. |
| Grok Bot, xAI | [Overview](https://docs.x.ai/grok-bot/overview), [skills/routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), and [security](https://docs.x.ai/grok-bot/approvals-security-and-privacy) describe persistent agents, a shared computer, handoffs and reusable workflows. | Reuse a learned workflow across agents while enforcing evidence scope and revocation over shared resources. |

“Muse” here means CopilotKit OpenMuse, matching the persistent agent-computer
comparison. Meta Muse is a separate product. OpenMuse is an alpha; project
verification documents distinguish fixture proof from live-provider proof.
Instinct and Grok Bot are service comparisons: record the observed service
version and date when a source revision is unavailable. Do not imply source
access or identical model configuration where the service does not expose it.

## Two comparison tracks

1. **Controlled harness experiment:** same model/provider/effort, repository base,
   WorkContract, acceptance criteria, tools, permissions, environment and budgets.
   Vary the harness only. Pin the exact revision of each open-source harness.
2. **Product outcome experiment:** same user objective, input data, permission
   envelope, acceptance checks and spending/time ceilings. Disclose unavailable
   controls. A result describes the whole product configuration; it cannot isolate
   a harness effect when models or tools differ.

Register task selection, trial count, stopping rules, primary metric and allowed
differences before execution. Include every attempted trial, failed setup,
interruption, repair and refusal in the result set. Randomize execution order and
reset fixtures between arms. Use a held-out task set for learning experiments.

## Acceptance cases

Use synthetic accounts and reversible fixture effects for failure injection.
Destructive source perturbations must use `runDisposableProof` under ADR 0019.

| Case | Required result | Existing Rhiz seam |
| --- | --- | --- |
| Fresh completion | A worker report alone cannot become success; current independently checked evidence and organizational acceptance are required. | Board, Verify, Router |
| Bounded execution | Stalled startup, worker result, observation stream and cancellation produce a bounded failure with evidence. Late output cannot revive the Attempt. | Crew, WorkerProvider, Ledger |
| Restart after effect | Preserve known completed steps; reconcile an uncertain effect; never blindly repeat a consequential write. | Ledger plus concrete host/effect adapter |
| Lease race | One current owner; stale execution cannot checkpoint or settle the successor's Work. | AttemptLease, integration controller |
| Changed authorization | A revoked grant, changed payload or new destination requires evaluation under current authority before dispatch. | Guard plus authenticated host |
| Shared context | Authorized shared facts remain reusable; private evidence remains scoped across handoff and restart. | Context plus organization adapter |
| Corrected memory | Current authoritative evidence supersedes a stale procedure; learning requires attributable evidence and reviewed promotion. | Refiner, Context, Rules |
| Fair measurement | Actual attempt provider/model/effort agree with recorded controls; missing usage and incomplete intervention capture stay explicit. | BenchmarkRun, compareBenchmarkRuns |
| Real repository outcome | An independent checker exercises the requested journey on the exact deliverable; preserved candidate and deployment receipts identify the same revision. | Repository runner plus consumer deployment verification |

The “existing seam” column identifies ownership, not a claim that every case is
implemented end to end. Browser, messaging, live deployment, authenticated user
identity and external-effect recovery require consumer/provider proofs beyond
portable unit tests.

## Scoring and publication

Report accepted outcomes and independently verified candidates separately.
Preserve raw `BenchmarkRun.outcome`: a comparison's `verified` boolean alone does
not establish organizational acceptance. Until complete operator capture exists,
runner-observed interventions are a lower bound and cannot prove fewer human
interventions per accepted outcome.

Publish verified/accepted completion rate, recovery rate, false completions,
unauthorized effects, duplicate effects, human interventions, repair rate,
repeat mistakes, elapsed time and provider-reported cost. Report missing values
as missing. Show quality and safety failures separately from averages so speed
cannot conceal them. Any unauthorized effect, duplicate consequential effect or
false acceptance blocks a superiority claim for the affected case.

Use `BenchmarkRunSchema` and `compareBenchmarkRuns` for controlled paired receipts:
record distinct `variantId`s, exact task/base identities, harness identity and
version, and observed runtime controls. Permit only predeclared differences.
Preserve the original receipts alongside descriptive deltas. Repeated-trial
uncertainty and complete operator capture are prerequisites for statistical and
North Star claims; the pair comparator is not a statistical evaluator.

## Current engineering follow-through

The initial code inspection found three defects worth fixing before a competitive
run: Router treated worker completion as success and ingestion delay as execution
time; single-attempt benchmark controls could contradict their labels; Crew's
deadline did not bound all worker lifecycle waits. Focused regression tests must
fail against these behaviors and pass after repair.

The existing Factory Observer/historical replay work remains the population
analysis lane. Integrate these evidence corrections with it through the same
Board, Ledger and benchmark contracts. Next, execute repeated controlled trials
on a bounded repository task and a recovery task, then extend to product outcome
cases as the necessary providers are available.
