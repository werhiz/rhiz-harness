import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableEventLedger } from "../adapters/local/durable-ledger.js";
import { FollowThroughAssignmentSchema, FollowThroughSupervisor, inspectFollowThrough, type FollowThroughAssignment } from "../src/follow-through.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import type { EventLedger } from "../src/ledger.js";
import { streamIdForWork } from "../src/refiner.js";
import type { CrewWorkspace, CrewWorkspaceProvider } from "../src/crew.js";
import type { WorkerProvider } from "../src/host.js";
import { event, human, sandboxCapableCatalog, successfulExecution, testDigestScope, work } from "./helpers.js";

const now = "2026-08-20T16:00:00.000Z";
function assignment(id = "work:1", priority = 50): FollowThroughAssignment {
  return FollowThroughAssignmentSchema.parse({
    ownerRef: "account:fixture", sourceRef: "message:fixture", dueAt: "2026-08-20T15:00:00.000Z", priority, baseRevision: "base",
    mission: {
      work: work({ id, type: "SCOUT", writeScope: [], requiredEvidence: [], authority: { grants: [{ action: "read", resources: [{ uri: "repo://example" }], constraints: [] }], requiresHumanApproval: ["publish"] } }),
      workspace: { strategy: "fresh", mode: "read-only" },
    },
  });
}

function setup(ledger: EventLedger = new InMemoryEventLedger(), fail = false) {
  const started: string[] = [];
  const released: string[] = [];
  let count = 0;
  const spaces: CrewWorkspaceProvider = {
    id: "fixture:spaces",
    async acquire(input) { count++; return { leaseId: `lease:${count}`, workspaceId: `workspace:${count}`, uri: `memory://${count}`, executionRoot: `/fixture/${count}`, baseRevision: input.baseRevision, mode: input.mode }; },
    async snapshot(space: CrewWorkspace) { return { workspaceId: space.workspaceId, head: "base", digest: "sha256:clean", digestScope: testDigestScope, changedPaths: [], observedAt: now }; },
    async release(id) { released.push(id); }, async close() {},
  };
  const provider: WorkerProvider = {
    id: "worker:fixture",
    async describe() { return { id: this.id, displayName: "Fixture", description: "Deterministic test worker", bindsWorkspace: true, adapter: "test", product: "fixture", execution: "one-shot", context: "standalone", authorityMode: "test", writeAccess: "none", dangerous: false, credentialEnv: [] }; },
    async capabilities() { return { streamingObservations: true, cancel: true, resume: false, guardedToolMediation: true }; },
    async start(input) {
      started.push(input.work.id);
      return { workerId: `worker:${input.attemptId}`, attemptId: input.attemptId,
        async *observe() { yield { kind: "activity" as const, occurredAt: now, detail: "Research performed" }; },
        async result() { return { status: fail ? "failed" as const : "finished" as const, summary: "Fixture result", artifacts: [], evidence: [] }; },
        async cancel() {},
      };
    },
  };
  const options = { ledger, workerCatalog: sandboxCapableCatalog(provider), workspaceProvider: spaces, actor: human, now: () => now };
  return { ledger, started, released, options, supervisor: new FollowThroughSupervisor(options) };
}

test("dispatch starts an actual Crew worker and leaves execution awaiting independent verification", async () => {
  const fixture = setup();
  const cycle = await fixture.supervisor.cycle([assignment()]);
  assert.deepEqual(fixture.started, ["work:1"]);
  assert.equal(cycle.errors.length, 0);
  assert.equal(cycle.items[0]!.action, "verify");
  assert.equal(cycle.items[0]!.overdue, true);
  const events = await fixture.ledger.replay(streamIdForWork("work:1"));
  assert.ok(events.some(item => item.type === "task.assigned"));
  assert.ok(events.some(item => item.type === "attempt.started"));
  assert.ok(events.every(item => item.correlationId === "account:fixture"));
  assert.ok(!events.some(item => item.type === "work.accepted"));
  assert.equal(fixture.released.length, 0, "workspace remains in operator custody");
  await cycle.runs[0]!.close();
  assert.equal(fixture.released.length, 1);
});

test("restart and concurrent ticks do not redispatch completed execution", async () => {
  const fixture = setup();
  const second = new FollowThroughSupervisor(fixture.options);
  const results = await Promise.all([fixture.supervisor.cycle([assignment()]), second.cycle([assignment()])]);
  assert.equal(fixture.started.length, 1);
  const restarted = new FollowThroughSupervisor(fixture.options);
  assert.equal((await restarted.cycle([assignment()])).runs.length, 0);
  for (const result of results) for (const run of result.runs) await run.close();
});

test("priority, deadline, bounded dispatch and failure isolation", async () => {
  const fixture = setup(undefined, true);
  const jobs = [assignment("work:low", 1), assignment("work:high", 99)];
  const first = await fixture.supervisor.cycle(jobs);
  assert.deepEqual(fixture.started, ["work:high"]);
  const second = await fixture.supervisor.cycle(jobs, 2);
  assert.ok(fixture.started.includes("work:low"));
  assert.ok(second.items.every(item => item.action === "dispatch" || item.action === "resolve"));
  for (const result of [first, second]) for (const run of result.runs) await run.close();
});

test("exhausted retry budget does not invoke another worker", async () => {
  const fixture = setup(undefined, true);
  const job = assignment(); job.mission.work.workerPolicy.maxAttempts = 1;
  const result = await fixture.supervisor.cycle([job]);
  assert.equal(result.items[0]!.action, "resolve");
  assert.equal((await fixture.supervisor.cycle([job])).runs.length, 0);
  assert.equal(fixture.started.length, 1);
  for (const run of result.runs) await run.close();
});

test("unfinished live and expired leases remain owned and require recovery", async () => {
  const ledger = new InMemoryEventLedger();
  const contract = assignment().mission.work;
  const execution = successfulExecution(contract).slice(0, 4);
  for (const item of execution) await ledger.append(item);
  const live = await inspectFollowThrough(ledger, [assignment()], now);
  assert.equal(live[0]!.action, "active");
  assert.deepEqual(live[0]!.workerIds, ["agent:worker"]);
  const stale = await inspectFollowThrough(ledger, [assignment()], "2099-01-02T00:00:00.000Z");
  assert.equal(stale[0]!.action, "recover");
  const fixture = setup(ledger);
  assert.equal((await fixture.supervisor.cycle([assignment()])).runs.length, 0);
  assert.equal(fixture.started.length, 0);
});

test("parked Work and open decisions are surfaced without worker effects", async () => {
  for (const kind of ["parked", "decision"]) {
    const ledger = new InMemoryEventLedger();
    await ledger.append(event("work.created", { contract: assignment().mission.work, revision: 1 }));
    await ledger.append(kind === "parked" ? event("work.parked", { reason: "Owner hold" }) : event("decision.requested", { decisionId: "decision:1", question: "Choose scope", choices: ["Proceed", "Hold"] }));
    const fixture = setup(ledger);
    const result = await fixture.supervisor.cycle([assignment()]);
    assert.equal(result.items[0]!.action, "resolve");
    assert.equal(fixture.started.length, 0);
  }
});

test("schema rejects splitting dependency graphs, duplicate identities and caller continuation", async () => {
  const job = assignment();
  assert.throws(() => FollowThroughAssignmentSchema.parse({ ...job, mission: { ...job.mission, continuesWork: true } }));
  assert.throws(() => FollowThroughAssignmentSchema.parse({ ...job, mission: { ...job.mission, work: { ...job.mission.work, dependencies: ["work:other"] } } }));
  await assert.rejects(() => inspectFollowThrough(new InMemoryEventLedger(), [job, job], now), /Duplicate/);
});

test("canonical contract mismatch cannot broaden authority", async () => {
  const fixture = setup();
  const job = assignment();
  await fixture.ledger.append(event("work.created", { contract: job.mission.work, revision: 1 }));
  job.mission.work.objective = "A different request";
  const result = await fixture.supervisor.cycle([job]);
  assert.equal(result.items[0]!.action, "resolve");
  assert.equal(fixture.started.length, 0);
});

test("reopened durable Ledger prevents duplicate dispatch across coordinator restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "follow-through-"));
  try {
    const first = await DurableEventLedger.open({ directory });
    const fixture = setup(first);
    const result = await fixture.supervisor.cycle([assignment()]);
    assert.equal(fixture.started.length, 1);
    for (const run of result.runs) await run.close();
    await first.close();
    const reopened = await DurableEventLedger.open({ directory });
    try {
      const restarted = setup(reopened);
      const cycle = await restarted.supervisor.cycle([assignment()]);
      assert.equal(cycle.items[0]!.action, "verify");
      assert.equal(restarted.started.length, 0);
    } finally { await reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
