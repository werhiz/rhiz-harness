import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ROUTER_POLICY,
  DuplicateRouterWorkerError,
  InMemoryRouterWorkerRegistry,
  RouterConfigurationError,
  RouterConsideredSchema,
  RouterDecisionPayloadSchema,
  RouterDecisionRationaleSchema,
  RouterDecisionSchema,
  RouterError,
  RouterEvidenceSchema,
  RouterPolicyDeniedError,
  RouterPolicySchema,
  RouterRouteOptionsSchema,
  RouterWorkerDescriptorSchema,
  RouterWorkerFilterSchema,
  computeRouterEvidence,
  computeRouterEvidenceFromEvents,
  parseRouterDecision,
  parseRouterEvidence,
  parseRouterPolicy,
  parseRouterWorkerDescriptor,
  routeWorker,
  routerDecisionToEvent,
} from "../src/router.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { parseHarnessEvent } from "../src/schemas.js";
import { human, worker as workerActor, event, work, successfulExecution, passingVerificationSequence } from "./helpers.js";

const TEST_NOW = new Date("2026-08-20T04:00:00.000Z");

function ts(offsetSeconds: number): string {
  return new Date(TEST_NOW.getTime() + offsetSeconds * 1000).toISOString();
}

function descriptor(overrides: Record<string, unknown> = {}): import("../src/router.js").RouterWorkerDescriptor {
  return RouterWorkerDescriptorSchema.parse({
    workerId: "worker:scout",
    role: "scout",
    displayName: "Scout",
    model: "scout-v1",
    supportedWorkTypes: ["SCOUT", "SHIP"],
    languages: ["ts", "tsx"],
    maxContextTokens: 32_000,
    costPer1kTokensUsd: 0.002,
    avgLatencyMs: 1_200,
    region: "us-east-1",
    capabilityTags: ["fast"],
    weight: 1,
    ...overrides,
  });
}

function cheaper(): import("../src/router.js").RouterWorkerDescriptor {
  return descriptor({
    workerId: "worker:cheap",
    role: "general",
    displayName: "Cheap",
    model: "cheap-v1",
    supportedWorkTypes: ["SHIP"],
    costPer1kTokensUsd: 0.0005,
    avgLatencyMs: 4_000,
  });
}

function faster(): import("../src/router.js").RouterWorkerDescriptor {
  return descriptor({
    workerId: "worker:fast",
    role: "general",
    displayName: "Fast",
    model: "fast-v1",
    supportedWorkTypes: ["SHIP"],
    costPer1kTokensUsd: 0.005,
    avgLatencyMs: 400,
  });
}

function balanced(): import("../src/router.js").RouterWorkerDescriptor {
  return descriptor({
    workerId: "worker:balanced",
    role: "general",
    displayName: "Balanced",
    model: "balanced-v1",
    supportedWorkTypes: ["SHIP"],
    costPer1kTokensUsd: 0.002,
    avgLatencyMs: 1_500,
  });
}

test("parseRouterWorkerDescriptor accepts a minimal descriptor", () => {
  const parsed = parseRouterWorkerDescriptor({
    workerId: "w:1",
    role: "general",
    displayName: "W1",
    model: "model-1",
    supportedWorkTypes: ["SHIP"],
    maxContextTokens: 8000,
    costPer1kTokensUsd: 0.001,
    avgLatencyMs: 1000,
  });
  assert.equal(parsed.workerId, "w:1");
  assert.deepEqual(parsed.supportedWorkTypes, ["SHIP"]);
  assert.equal(parsed.weight, 1);
  assert.deepEqual(parsed.languages, []);
  assert.deepEqual(parsed.capabilityTags, []);
});

test("RouterWorkerDescriptorSchema rejects an empty supportedWorkTypes list", () => {
  assert.throws(() => RouterWorkerDescriptorSchema.parse({
    workerId: "w:1",
    role: "general",
    displayName: "W1",
    model: "model-1",
    supportedWorkTypes: [],
    maxContextTokens: 8000,
    costPer1kTokensUsd: 0.001,
    avgLatencyMs: 1000,
  }));
});

test("RouterPolicy defaults to balanced with the documented weights", () => {
  const parsed = RouterPolicySchema.parse(undefined);
  assert.equal(parsed.kind, "balanced");
  if (parsed.kind === "balanced") {
    assert.equal(parsed.weights.successRate, 0.4);
    assert.equal(parsed.weights.costInverse, 0.3);
    assert.equal(parsed.weights.durationInverse, 0.3);
    assert.equal(parsed.weights.confidence, 0.0);
  }
});

test("DEFAULT_ROUTER_POLICY is frozen", () => {
  assert.equal(Object.isFrozen(DEFAULT_ROUTER_POLICY), true);
  assert.equal(Object.isFrozen(DEFAULT_ROUTER_POLICY.weights), true);
});

test("RouterPolicySchema rejects balanced weights that sum to zero", () => {
  assert.throws(() => RouterPolicySchema.parse({
    kind: "balanced",
    weights: { successRate: 0, costInverse: 0, durationInverse: 0, confidence: 0 },
  }));
});

test("parseRouterPolicy parses the cheapest-capable policy", () => {
  const parsed = parseRouterPolicy({ kind: "cheapest-capable" });
  assert.equal(parsed.kind, "cheapest-capable");
});

test("RouterEvidenceSchema rejects a successRate > 1", () => {
  assert.throws(() => RouterEvidenceSchema.parse({
    workerId: "w:1",
    attemptCount: 1,
    successCount: 1,
    failedCount: 0,
    successRate: 1.5,
    medianCostUsd: null,
    p95CostUsd: null,
    medianDurationMs: null,
    p95DurationMs: null,
    confidence: null,
    lastSeenAt: null,
  }));
});

test("RouterDecisionRationaleSchema discriminates on kind", () => {
  const selected = RouterDecisionRationaleSchema.parse({
    kind: "selected",
    workerId: "w:1",
    reason: "best",
    score: 0.9,
    policyKind: "balanced",
  });
  assert.equal(selected.kind, "selected");
  const noCapable = RouterDecisionRationaleSchema.parse({
    kind: "no-capable-worker",
    reason: "none",
    considered: [],
  });
  assert.equal(noCapable.kind, "no-capable-worker");
});

test("RouterRouteOptionsSchema rejects negative excludeProviders entries", () => {
  assert.throws(() => RouterRouteOptionsSchema.parse({ excludeProviders: [""] }));
});

test("RouterWorkerFilterSchema accepts an empty object", () => {
  const parsed = RouterWorkerFilterSchema.parse({});
  assert.deepEqual(parsed, {});
});

test("InMemoryRouterWorkerRegistry register/get/list/query operations", () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster(), balanced()]);
  assert.equal(registry.list().length, 3);
  assert.equal(registry.list()[0]!.workerId, "worker:balanced");
  assert.equal(registry.get("worker:cheap")!.workerId, "worker:cheap");
  assert.equal(registry.get("worker:unknown"), undefined);
  const filtered = registry.query({ workType: "SHIP" });
  assert.equal(filtered.length, 3);
  const languageFilter = registry.query({ language: "ts" });
  assert.equal(languageFilter.length, 3);
  const emptyLanguageFilter = registry.query({ language: "rust" });
  assert.equal(emptyLanguageFilter.length, 0);
});

test("InMemoryRouterWorkerRegistry rejects duplicate registrations", () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper()]);
  assert.throws(() => registry.register(cheaper()), DuplicateRouterWorkerError);
});

test("InMemoryRouterWorkerRegistry lists workers in deterministic lexicographic order", () => {
  const registry = new InMemoryRouterWorkerRegistry([faster(), balanced(), cheaper()]);
  const ids = registry.list().map((entry) => entry.workerId);
  assert.deepEqual(ids, ["worker:balanced", "worker:cheap", "worker:fast"]);
});

test("computeRouterEvidence returns an empty list when no streams are configured", async () => {
  const ledger = new InMemoryEventLedger();
  const result = await computeRouterEvidence(ledger, { streamIds: [] });
  assert.equal(result.length, 0);
});

test("computeRouterEvidence aggregates accepted outcomes and terminal failures per executor", async () => {
  const ledger = new InMemoryEventLedger();
  const execution = successfulExecution();
  const events = [
    execution[0]!,
    event("task.created", { objective: "First task" }, { taskId: "task:failed" }),
    event("attempt.started", { worker: workerActor, contractRevision: 1 }, { taskId: "task:failed", attemptId: "attempt:failed", occurredAt: ts(1) }),
    event("attempt.failed", { reason: "boom", recoverable: true }, { taskId: "task:failed", attemptId: "attempt:failed", occurredAt: ts(4) }),
    ...execution.slice(1).map((item) => ({ ...item, occurredAt: item.type === "attempt.finished" ? ts(16) : ts(10), recordedAt: ts(100) })),
    ...passingVerificationSequence(),
    event("work.accepted", { contractRevision: 1, reason: "Independently verified" }, { occurredAt: ts(20) }),
  ];
  for (const item of events) await ledger.append(item);

  const evidence = await computeRouterEvidence(ledger, { streamIds: ["stream:work:1"] });
  assert.equal(evidence.length, 1);
  const item = evidence[0]!;
  assert.equal(item.workerId, "agent:worker");
  assert.equal(item.attemptCount, 2);
  assert.equal(item.successCount, 1);
  assert.equal(item.failedCount, 1);
  assert.equal(item.successRate, 1 / 2);
  assert.equal(item.medianDurationMs, 4500);
  assert.equal(item.p95DurationMs, 6000);
  assert.equal(item.confidence, 0.5);
  assert.equal(item.lastSeenAt, ts(20));
});

test("computeRouterEvidenceFromEvents is deterministic for the same Board-valid input", () => {
  const events = [...successfulExecution(), ...passingVerificationSequence(),
    event("work.accepted", { reason: "Verified", contractRevision: 1 })];
  const left = computeRouterEvidenceFromEvents(events);
  const right = computeRouterEvidenceFromEvents(events);
  assert.deepEqual(left, right);
  assert.equal(left[0]?.successCount, 1);
});

test("finished work earns no success before independent verification and Board acceptance", () => {
  const evidence = computeRouterEvidenceFromEvents(successfulExecution());
  assert.equal(evidence[0]?.attemptCount, 1);
  assert.equal(evidence[0]?.successCount, 0);
  assert.equal(evidence[0]?.failedCount, 0);
  assert.equal(evidence[0]?.confidence, null);
});

test("accepted work whose verifier also executed it earns no Router success", () => {
  const contract = work({
    verificationPolicy: { required: true, independentActor: false, reviewRequired: false, falsifiabilityExemptions: [] },
  });
  const events = [
    ...successfulExecution(contract),
    ...passingVerificationSequence(workerActor),
    event("work.accepted", { reason: "Board allows the configured self-check", contractRevision: 1 }),
  ];
  const evidence = computeRouterEvidenceFromEvents(events);
  assert.equal(evidence.find((item) => item.workerId === workerActor.id)?.successCount, 0);
});

test("handoff credits each unique Board execution actor once", () => {
  const successor = { id: "agent:successor", kind: "agent" as const, displayName: "Successor" };
  const execution = successfulExecution();
  const handoff = event("attempt.lease-transferred", {
    fromLeaseId: "lease:1",
    worker: successor,
    lease: {
      id: "lease:2",
      workspaceId: "workspace:2",
      resourceClaims: [{ kind: "path", resource: "src" }],
      acquiredAt: ts(1),
      expiresAt: ts(100),
    },
    reason: "Continue from the checkpoint",
  }, { taskId: "task:1", attemptId: "attempt:1", actor: successor, occurredAt: ts(1), recordedAt: ts(1) });
  const events = [
    ...execution.slice(0, 4),
    handoff,
    ...execution.slice(4),
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "Independently verified", contractRevision: 1 }),
  ];
  const evidence = computeRouterEvidenceFromEvents(events);
  assert.deepEqual(evidence.map((item) => [item.workerId, item.attemptCount, item.successCount]), [
    ["agent:successor", 1, 1],
    ["agent:worker", 1, 1],
  ]);
});

test("duplicate event input and duplicate streams cannot double-credit one Work", () => {
  const events = [
    ...successfulExecution(),
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "Independently verified", contractRevision: 1 }),
  ];
  const repeatedEvents = computeRouterEvidenceFromEvents([...events, ...events]);
  assert.equal(repeatedEvents[0]?.attemptCount, 1);
  assert.equal(repeatedEvents[0]?.successCount, 1);

  const secondStream = events.map((item) => ({ ...item, streamId: "stream:duplicate-work-view" }));
  assert.deepEqual(computeRouterEvidenceFromEvents([...events, ...secondStream]), []);
});

test("conflicting bodies for one event ID withhold that Work's evidence", () => {
  const events = [
    ...successfulExecution(),
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "Independently verified", contractRevision: 1 }),
  ];
  const conflictingStart = { ...events[3]!, occurredAt: ts(1) };
  assert.deepEqual(computeRouterEvidenceFromEvents([...events, conflictingStart]), []);
});

test("negative source-clock duration is omitted", () => {
  const events = [
    ...successfulExecution().map((item) => {
      if (item.type === "attempt.started") return { ...item, occurredAt: ts(5) };
      if (item.type === "attempt.finished") return { ...item, occurredAt: ts(4) };
      return item;
    }),
    ...passingVerificationSequence(),
    event("work.accepted", { reason: "Independently verified", contractRevision: 1 }),
  ];
  const evidence = computeRouterEvidenceFromEvents(events);
  assert.equal(evidence[0]?.medianDurationMs, null);
  assert.equal(evidence[0]?.p95DurationMs, null);
});

test("routeWorker with cheapest-capable picks the lowest-cost worker among matched candidates", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster(), balanced()]);
  const contract = work();
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "cheapest-capable" } }, () => new Date(TEST_NOW));
  assert.equal(decision.selected?.workerId, "worker:cheap");
  assert.equal(decision.rationale.kind, "selected");
  if (decision.rationale.kind === "selected") {
    assert.equal(decision.rationale.policyKind, "cheapest-capable");
  }
  assert.equal(decision.considered.length, 3);
  assert.ok(decision.considered.every((entry) => entry.matched));
});

test("routeWorker with fastest-capable picks the lowest-latency worker", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster(), balanced()]);
  const contract = work();
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "fastest-capable" } }, () => new Date(TEST_NOW));
  assert.equal(decision.selected?.workerId, "worker:fast");
});

test("routeWorker with highest-confidence picks the worker with the strongest evidence", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster()]);
  const contract = work();
  const evidence = [
    RouterEvidenceSchema.parse({
      workerId: "worker:cheap",
      attemptCount: 10,
      successCount: 2,
      failedCount: 8,
      successRate: 0.2,
      medianCostUsd: 0.001,
      p95CostUsd: 0.002,
      medianDurationMs: 500,
      p95DurationMs: 1000,
      confidence: 0.2,
      lastSeenAt: ts(1),
    }),
    RouterEvidenceSchema.parse({
      workerId: "worker:fast",
      attemptCount: 10,
      successCount: 9,
      failedCount: 1,
      successRate: 0.9,
      medianCostUsd: 0.005,
      p95CostUsd: 0.006,
      medianDurationMs: 400,
      p95DurationMs: 800,
      confidence: 0.95,
      lastSeenAt: ts(1),
    }),
  ];
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "highest-confidence" }, evidence }, () => new Date(TEST_NOW));
  assert.equal(decision.selected?.workerId, "worker:fast");
});

test("routeWorker with highest-confidence returns no-evidence when every matched worker has zero confidence signals", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster()]);
  const contract = work();
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "highest-confidence" }, evidence: [] }, () => new Date(TEST_NOW));
  assert.equal(decision.selected, null);
  assert.equal(decision.rationale.kind, "no-evidence");
});

test("routeWorker with balanced policy uses the documented weights", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster(), balanced()]);
  const contract = work();
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "balanced" } }, () => new Date(TEST_NOW));
  assert.ok(decision.selected);
  assert.equal(decision.rationale.kind, "selected");
});

test("routeWorker returns no-capable-worker when the registry has no workers for the work type", async () => {
  const scoutOnly = descriptor({ workerId: "worker:scout-only", supportedWorkTypes: ["SCOUT"] });
  const registry = new InMemoryRouterWorkerRegistry([scoutOnly]);
  const contract = work({ writeScope: [] });
  const decision = await routeWorker(registry, null, { contract }, () => new Date(TEST_NOW));
  assert.equal(decision.selected, null);
  assert.equal(decision.rationale.kind, "no-capable-worker");
});

test("routeWorker excludes providers listed in options.excludeProviders", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster(), balanced()]);
  const contract = work();
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "cheapest-capable" }, options: { excludeProviders: ["worker:cheap"] } }, () => new Date(TEST_NOW));
  assert.equal(decision.selected?.workerId, "worker:balanced");
});

test("routeWorker honors preferred providers via the weight boost when scores are otherwise equal", async () => {
  const a = descriptor({ workerId: "worker:zeta", supportedWorkTypes: ["SHIP"], costPer1kTokensUsd: 0.002, avgLatencyMs: 1_000 });
  const b = descriptor({ workerId: "worker:alpha", supportedWorkTypes: ["SHIP"], costPer1kTokensUsd: 0.002, avgLatencyMs: 1_000 });
  const c = descriptor({ workerId: "worker:mid", supportedWorkTypes: ["SHIP"], costPer1kTokensUsd: 0.002, avgLatencyMs: 1_000 });
  const registry = new InMemoryRouterWorkerRegistry([a, b, c]);
  const contract = work({ workerPolicy: { preferredProviders: ["worker:zeta"], maxAttempts: 3, allowParallelAttempts: false, explicitProviderAuthorizations: [] } });
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "cheapest-capable" } }, () => new Date(TEST_NOW));
  assert.equal(decision.selected?.workerId, "worker:zeta");
});

test("routeWorker expected cost uses the configured expectedTokens", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper()]);
  const contract = work();
  const decision = await routeWorker(registry, null, { contract, policy: { kind: "cheapest-capable" }, options: { expectedTokens: 10_000 } }, () => new Date(TEST_NOW));
  assert.equal(decision.selected?.workerId, "worker:cheap");
  assert.equal(decision.expectedCostUsd, 0.005);
});

test("routeWorker is deterministic for the same inputs", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster(), balanced()]);
  const contract = work();
  const left = await routeWorker(registry, null, { contract }, () => new Date(TEST_NOW));
  const right = await routeWorker(registry, null, { contract }, () => new Date(TEST_NOW));
  assert.equal(left.evidenceHash, right.evidenceHash);
  assert.equal(left.id, right.id);
});

test("routeWorker emits a fresh decision id when the evidence hash changes", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper(), faster(), balanced()]);
  const contract = work();
  const left = await routeWorker(registry, null, { contract }, () => new Date(TEST_NOW));
  const right = await routeWorker(registry, null, { contract, options: { excludeProviders: ["worker:fast"] } }, () => new Date(TEST_NOW));
  assert.notEqual(left.evidenceHash, right.evidenceHash);
  assert.notEqual(left.id, right.id);
});

test("routeWorker is pure with respect to clock: only decidedAt changes", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper()]);
  const contract = work();
  const left = await routeWorker(registry, null, { contract }, () => new Date("2026-01-01T00:00:00.000Z"));
  const right = await routeWorker(registry, null, { contract }, () => new Date("2026-02-01T00:00:00.000Z"));
  assert.equal(left.evidenceHash, right.evidenceHash);
  assert.notEqual(left.decidedAt, right.decidedAt);
});

test("RouterDecisionSchema rejects mismatched rationale and selected worker", () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper()]);
  assert.throws(() => RouterDecisionSchema.parse({
    id: "r:1",
    workId: "work:1",
    policy: { kind: "cheapest-capable" },
    considered: [{
      workerId: "worker:cheap",
      descriptor: cheaper(),
      evidence: null,
      score: 1,
      matched: true,
      excludedReason: null,
    }],
    selected: null,
    rationale: { kind: "selected", workerId: "worker:cheap", reason: "x", score: 1, policyKind: "cheapest-capable" },
    evidenceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    expectedCostUsd: 0,
    expectedDurationMs: 0,
    decidedAt: ts(0),
  }));
});

test("RouterConsideredSchema accepts a single entry", () => {
  const entry = RouterConsideredSchema.parse({
    workerId: "w:1",
    descriptor: cheaper(),
    evidence: null,
    score: null,
    matched: false,
    excludedReason: null,
  });
  assert.equal(entry.workerId, "w:1");
});

test("routerDecisionToEvent returns a HarnessEventBase-compatible record", () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper()]);
  return routeWorker(registry, null, { contract: work() }, () => new Date(TEST_NOW)).then((decision) => {
    const record = routerDecisionToEvent(decision, {
      id: "event:router:1",
      streamId: "stream:work:1",
      actor: { id: "automation:router", kind: "automation", displayName: "Router" },
      taskId: "task:1",
      attemptId: "attempt:1",
    }) as Record<string, unknown>;
    assert.equal(record.type, "router.decision-made");
    assert.equal(record.streamId, "stream:work:1");
    assert.equal((record.payload as Record<string, unknown>).decisionId, decision.id);
  });
});

test("HarnessEventSchema accepts router.decision-made with the new payload shape", () => {
  const parsed = parseHarnessEvent({
    schemaVersion: 1,
    id: "event:router:1",
    streamId: "stream:work:1",
    workId: "work:1",
    actor: human,
    occurredAt: ts(0),
    recordedAt: ts(1),
    evidence: [],
    type: "router.decision-made",
    payload: {
      decisionId: "r:1",
      policy: "balanced",
      selectedWorkerId: "worker:cheap",
      consideredCount: 1,
      evidenceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      expectedCostUsd: 0.001,
      expectedDurationMs: 1_000,
    },
  });
  assert.equal(parsed.type, "router.decision-made");
});

test("HarnessEventSchema rejects router.decision-made with an unknown policy", () => {
  assert.throws(() => parseHarnessEvent({
    schemaVersion: 1,
    id: "event:router:1",
    streamId: "stream:work:1",
    workId: "work:1",
    actor: human,
    occurredAt: ts(0),
    recordedAt: ts(1),
    evidence: [],
    type: "router.decision-made",
    payload: {
      decisionId: "r:1",
      policy: "unknown-policy",
      selectedWorkerId: null,
      consideredCount: 0,
      evidenceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      expectedCostUsd: 0,
      expectedDurationMs: 0,
    },
  }));
});

test("RouterDecisionPayloadSchema rejects a negative expectedCostUsd", () => {
  assert.throws(() => RouterDecisionPayloadSchema.parse({
    decisionId: "r:1",
    policy: "balanced",
    selectedWorkerId: "w:1",
    consideredCount: 1,
    evidenceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    expectedCostUsd: -0.1,
    expectedDurationMs: 0,
  }));
});

test("RouterError subclasses carry stable codes", () => {
  assert.equal(new RouterError("custom", "msg").code, "custom");
  assert.equal(new RouterConfigurationError("cfg").code, "rhiz/router/configuration-error");
  assert.equal(new RouterPolicyDeniedError("denied").code, "rhiz/router/policy-denied");
});

test("parseRouterDecision round-trips a valid decision", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper()]);
  const decision = await routeWorker(registry, null, { contract: work() }, () => new Date(TEST_NOW));
  const reparsed = parseRouterDecision(decision);
  assert.equal(reparsed.id, decision.id);
});

test("parseRouterEvidence rejects an unknown shape", () => {
  assert.throws(() => parseRouterEvidence({ workerId: "w:1" }));
});

test("RouterDecisionSchema superRefine rejects evidenceHash that does not match the documented prefix", async () => {
  const registry = new InMemoryRouterWorkerRegistry([cheaper()]);
  const decision = await routeWorker(registry, null, { contract: work() }, () => new Date(TEST_NOW));
  const tampered = { ...decision, evidenceHash: "md5:11111111111111111111111111111111" };
  assert.throws(() => parseRouterDecision(tampered));
});

test("routeWorker with cheapest-capable ties broken by lexicographic workerId", async () => {
  const a = descriptor({ workerId: "worker:zeta", supportedWorkTypes: ["SHIP"], costPer1kTokensUsd: 0.001, avgLatencyMs: 1_000 });
  const b = descriptor({ workerId: "worker:alpha", supportedWorkTypes: ["SHIP"], costPer1kTokensUsd: 0.001, avgLatencyMs: 1_000 });
  const registry = new InMemoryRouterWorkerRegistry([a, b]);
  const decision = await routeWorker(registry, null, { contract: work(), policy: { kind: "cheapest-capable" } }, () => new Date(TEST_NOW));
  assert.equal(decision.selected?.workerId, "worker:alpha");
});
