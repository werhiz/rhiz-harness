import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGuardCanEvaluate,
  assertGuardVerdict,
  CircuitBreakerConfigSchema,
  createDefaultPolicyOracle,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_RISK_LEVELS,
  ExecPolicyBackendOracle,
  EXEC_POLICY_BACKEND_VERSION,
  GuardianRejectionCircuitBreaker,
  GuardCircuitOpenError,
  GuardConfigurationError,
  GuardDecisionSchema,
  GuardOracleUnavailableError,
  GuardPolicySchema,
  GuardRequestSchema,
  GuardVerificationError,
  guardPolicyFromWorkContract,
  matchForbiddenPattern,
  parseGuardPolicy,
  parseGuardRequest,
  parseWorkContractForGuard,
  parseGuardVerdict,
  PerToolGuardModeSchema,
  RhizNativePolicyOracle,
  RiskLevelSchema,
  ToolCategorySchema,
} from "../src/guard.js";
import { work } from "./helpers.js";

function request(overrides: Partial<{
  requestId: string;
  workId: string;
  taskId: string;
  attemptId: string;
  toolName: string;
  toolCategory: "read" | "write" | "shell" | "network" | "credential" | "external-mutate" | "other";
  toolArgs: Record<string, unknown>;
  writeScope: "none" | "workspace" | "unrestricted" | "host-policy";
  contextHash: string;
  evidenceRefs: string[];
  timestampMs: number;
}> = {}) {
  return parseGuardRequest({
    requestId: overrides.requestId ?? "req:1",
    workId: overrides.workId ?? "work:1",
    taskId: overrides.taskId ?? "task:1",
    attemptId: overrides.attemptId ?? "attempt:1",
    actor: { id: "agent:worker", kind: "agent" },
    tool: {
      name: overrides.toolName ?? "Read",
      category: overrides.toolCategory ?? "read",
      args: overrides.toolArgs ?? { path: "src/foo.ts" },
    },
    writeScope: overrides.writeScope ?? "workspace",
    contextHash: overrides.contextHash ?? "ctx:hash:1",
    evidenceRefs: overrides.evidenceRefs ?? [],
    timestampMs: overrides.timestampMs ?? 1_700_000_000_000,
  });
}

function policy(overrides: Partial<{
  workId: string;
  defaultDecision: "allow" | "prompt" | "forbid";
  denyByDefault: boolean;
  perToolMode: Record<string, { decision: "allow" | "prompt" | "forbid"; requireEvidence: boolean; maxInvocationsPerAttempt?: number }>;
  forbiddenPatterns: string[];
  backend: "rhiz-native" | "execpolicy";
  backendConfig: Record<string, unknown>;
}> = {}) {
  return parseGuardPolicy({
    workId: overrides.workId ?? "work:1",
    defaultDecision: overrides.defaultDecision ?? "prompt",
    denyByDefault: overrides.denyByDefault ?? true,
    perToolMode: overrides.perToolMode ?? {},
    forbiddenPatterns: overrides.forbiddenPatterns ?? [],
    circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
    backend: overrides.backend ?? "rhiz-native",
    backendConfig: overrides.backendConfig ?? {},
  });
}

test("DEFAULT_RISK_LEVELS covers every tool category with a non-empty severity", () => {
  for (const c of ToolCategorySchema.options) {
    assert.ok(DEFAULT_RISK_LEVELS[c], `category ${c} must have a default risk level`);
    assert.ok(RiskLevelSchema.options.includes(DEFAULT_RISK_LEVELS[c]));
  }
  assert.equal(DEFAULT_RISK_LEVELS.read, "low");
  assert.equal(DEFAULT_RISK_LEVELS.credential, "critical");
  assert.equal(DEFAULT_RISK_LEVELS["external-mutate"], "critical");
});

test("DEFAULT_CIRCUIT_BREAKER_CONFIG matches the upstream OpenInterpreter constants", () => {
  assert.equal(DEFAULT_CIRCUIT_BREAKER_CONFIG.consecutiveDenialLimit, 3);
  assert.equal(DEFAULT_CIRCUIT_BREAKER_CONFIG.slidingWindowDenialLimit, 10);
  assert.equal(DEFAULT_CIRCUIT_BREAKER_CONFIG.timeoutMs, 90_000);
  assert.equal(DEFAULT_CIRCUIT_BREAKER_CONFIG.perCategoryTokenBudget.prompt, 10_000);
  assert.equal(DEFAULT_CIRCUIT_BREAKER_CONFIG.perCategoryTokenBudget.tool, 10_000);
  assert.equal(DEFAULT_CIRCUIT_BREAKER_CONFIG.perCategoryTokenBudget.perEntry, 2_000);
});

test("GuardPolicySchema rejects unknown backend", () => {
  assert.throws(
    () => GuardPolicySchema.parse({ workId: "w", backend: "openai" }),
    (err: unknown) => err instanceof Error && /backend/.test((err as Error).message),
  );
});

test("GuardPolicySchema requires backendConfig when backend is execpolicy", () => {
  assert.throws(
    () => GuardPolicySchema.parse({ workId: "w", backend: "execpolicy", backendConfig: {} }),
    (err: unknown) => err instanceof Error && /backendConfig/.test((err as Error).message),
  );
  const ok = GuardPolicySchema.parse({
    workId: "w",
    backend: "execpolicy",
    backendConfig: { executablePath: "/usr/local/bin/codex-execpolicy" },
  });
  assert.equal(ok.backend, "execpolicy");
});

test("GuardRequestSchema rejects empty tool name and missing fields", () => {
  assert.throws(() => parseGuardRequest({ ...request(), tool: { name: "", category: "read", args: {} } }));
  assert.throws(() => parseGuardRequest({ requestId: "r" }));
});

test("GuardVerdictSchema rejects unsupported decision", () => {
  assert.throws(() => parseGuardVerdict({
    requestId: "r",
    decision: "maybe",
    rationale: "x",
    riskLevel: "low",
    ruleHits: [],
    policyBackend: "rhiz-native",
    evaluatedAt: "2026-08-20T05:00:00.000Z",
    durationMs: 0,
  }));
});

test("assertGuardVerdict narrows the type and rejects malformed input", () => {
  assertGuardVerdict(parseGuardVerdict({
    requestId: "r",
    decision: "allow",
    rationale: "ok",
    riskLevel: "low",
    ruleHits: [],
    policyBackend: "rhiz-native",
    evaluatedAt: "2026-08-20T05:00:00.000Z",
    durationMs: 0,
  }));
  assert.throws(() => assertGuardVerdict({}), (err: unknown) => err instanceof GuardVerificationError);
});

test("PerToolGuardModeSchema enforces strict schema and forbids unknown fields", () => {
  const ok = PerToolGuardModeSchema.parse({ decision: "allow", requireEvidence: false });
  assert.equal(ok.decision, "allow");
  assert.throws(() => PerToolGuardModeSchema.parse({ decision: "allow", requireEvidence: false, scope: "all" }));
});

test("CircuitBreakerConfigSchema accepts partial input by applying defaults", () => {
  const parsed = CircuitBreakerConfigSchema.parse({});
  assert.equal(parsed.consecutiveDenialLimit, 3);
  assert.equal(parsed.slidingWindowDurationMs, 300_000);
});

test("matchForbiddenPattern returns null for empty patterns", () => {
  assert.equal(matchForbiddenPattern(request(), []), null);
});

test("matchForbiddenPattern returns the first matching pattern", () => {
  assert.equal(matchForbiddenPattern(request({ toolArgs: { command: "rm -rf /tmp" } }), ["rm -rf"]), "rm -rf");
  assert.equal(matchForbiddenPattern(request({ toolArgs: { command: "ls -la" } }), ["rm -rf", "drop table"]), null);
});

test("RhizNativePolicyOracle forbid on forbidden-pattern match", async () => {
  const oracle = new RhizNativePolicyOracle();
  const v = await oracle.evaluate(
    request({ toolName: "Shell", toolCategory: "shell", toolArgs: { command: "rm -rf /" } }),
    policy({ forbiddenPatterns: ["rm -rf"] }),
  );
  assert.equal(v.decision, "forbid");
  assert.equal(v.riskLevel, "critical");
  assert.ok(v.ruleHits[0]?.startsWith("forbidden-pattern:"));
  assert.equal(v.policyBackend, "rhiz-native");
  assert.equal(v.policyBackendVersion, "0.1.0");
  assert.match(v.evaluatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(v.durationMs >= 0);
});

test("RhizNativePolicyOracle honors per-tool mode allow", async () => {
  const oracle = new RhizNativePolicyOracle();
  const v = await oracle.evaluate(
    request({ toolName: "Read", toolCategory: "read" }),
    policy({ perToolMode: { Read: { decision: "allow", requireEvidence: false } } }),
  );
  assert.equal(v.decision, "allow");
  assert.equal(v.riskLevel, "low");
  assert.ok(v.ruleHits.includes("per-tool-mode:Read:allow"));
});

test("RhizNativePolicyOracle escalates to prompt when per-tool mode requires evidence but none provided", async () => {
  const oracle = new RhizNativePolicyOracle();
  const v = await oracle.evaluate(
    request({ toolName: "Shell", toolCategory: "shell", toolArgs: { command: "ls" } }),
    policy({ perToolMode: { Shell: { decision: "allow", requireEvidence: true } } }),
  );
  assert.equal(v.decision, "prompt");
  assert.match(v.rationale, /requires evidence/);
});

test("RhizNativePolicyOracle forbids an unlisted tool when denyByDefault is set", async () => {
  const oracle = new RhizNativePolicyOracle();
  const v = await oracle.evaluate(
    request({ toolName: "UnknownTool", toolCategory: "other" }),
    policy({ defaultDecision: "prompt", denyByDefault: true }),
  );
  // Previously this asserted "prompt", which is defaultDecision rather than a
  // denial: the flag changed only the audit label. Deny by default denies.
  assert.equal(v.decision, "forbid");
  assert.equal(v.riskLevel, "medium");
  assert.ok(v.ruleHits.includes("default-deny:no-per-tool-mode-match"));
});

test("RhizNativePolicyOracle reflects default-allow path when denyByDefault is false", async () => {
  const oracle = new RhizNativePolicyOracle();
  const v = await oracle.evaluate(
    request({ toolName: "UnknownTool", toolCategory: "other" }),
    policy({ defaultDecision: "allow", denyByDefault: false }),
  );
  assert.equal(v.decision, "allow");
  assert.ok(v.ruleHits.includes("default-allow:no-per-tool-mode-match"));
});

test("RhizNativePolicyOracle honors a custom clock for determinism", async () => {
  const fakeNow = () => 1_700_000_000_000;
  const fakeClock = () => new Date("2026-01-01T00:00:00.000Z");
  const oracle = new RhizNativePolicyOracle({ now: fakeNow, clock: fakeClock });
  const v = await oracle.evaluate(request(), policy());
  assert.equal(v.evaluatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(v.durationMs, 0);
});

test("RhizNativePolicyOracle attaches the requestId to the verdict", async () => {
  const oracle = new RhizNativePolicyOracle();
  const v = await oracle.evaluate(request({ requestId: "req:abc" }), policy());
  assert.equal(v.requestId, "req:abc");
});

test("GuardianRejectionCircuitBreaker opens on consecutive denials", async () => {
  let now = 1_700_000_000_000;
  const clock = () => new Date(now);
  const oracle = new RhizNativePolicyOracle({ now: () => now, clock });
  const cb = new GuardianRejectionCircuitBreaker(parseGuardPolicy({ workId: "w" }).circuitBreaker);
  const denyPolicy = parseGuardPolicy({ workId: "w", forbiddenPatterns: ["rm -rf"] });
  // Must be a policy that genuinely allows. A bare policy now denies by
  // default, and a denial would not reset the consecutive counter.
  const allowPolicy = parseGuardPolicy({ workId: "w", denyByDefault: false, defaultDecision: "allow" });

  for (let i = 0; i < 3; i += 1) {
    const v = await oracle.evaluate(
      request({ toolName: "Shell", toolCategory: "shell", toolArgs: { command: "rm -rf /" } }),
      denyPolicy,
    );
    cb.record(v);
  }
  assert.equal(cb.isOpen(), true);
  assert.match(cb.snapshot().openReason ?? "", /consecutive/);
  const allowV = await oracle.evaluate(request(), allowPolicy);
  cb.record(allowV);
  assert.equal(cb.snapshot().consecutiveDenials, 0);
});

test("GuardianRejectionCircuitBreaker opens on sliding-window denials", async () => {
  let now = 1_700_000_000_000;
  const cb = new GuardianRejectionCircuitBreaker({
    consecutiveDenialLimit: 100,
    slidingWindowDenialLimit: 3,
    slidingWindowDurationMs: 300_000,
    timeoutMs: 90_000,
    perCategoryTokenBudget: { prompt: 10_000, tool: 10_000, perEntry: 2_000 },
  });
  const deny = parseGuardVerdict({
    requestId: "r",
    decision: "forbid",
    rationale: "no",
    riskLevel: "high",
    ruleHits: [],
    policyBackend: "rhiz-native",
    evaluatedAt: new Date(now).toISOString(),
    durationMs: 0,
  });
  const allow = parseGuardVerdict({
    requestId: "r",
    decision: "allow",
    rationale: "ok",
    riskLevel: "low",
    ruleHits: [],
    policyBackend: "rhiz-native",
    evaluatedAt: new Date(now).toISOString(),
    durationMs: 0,
  });
  cb.record(deny);
  cb.record(allow);
  cb.record(deny);
  cb.record(allow);
  cb.record(deny);
  assert.equal(cb.isOpen(), true);
  assert.match(cb.snapshot().openReason ?? "", /sliding-window/);
});

test("GuardianRejectionCircuitBreaker reset() clears all state", () => {
  const cb = new GuardianRejectionCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  const deny = parseGuardVerdict({
    requestId: "r",
    decision: "forbid",
    rationale: "no",
    riskLevel: "high",
    ruleHits: [],
    policyBackend: "rhiz-native",
    evaluatedAt: new Date().toISOString(),
    durationMs: 0,
  });
  cb.record(deny);
  cb.record(deny);
  cb.record(deny);
  cb.reset();
  assert.equal(cb.isOpen(), false);
  assert.equal(cb.snapshot().consecutiveDenials, 0);
  assert.equal(cb.snapshot().windowDenials, 0);
  assert.equal(cb.snapshot().evaluationCount, 0);
});

test("GuardianRejectionCircuitBreaker snapshot reflects evaluationCount", () => {
  const cb = new GuardianRejectionCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  assert.equal(cb.snapshot().evaluationCount, 0);
  const allow = parseGuardVerdict({
    requestId: "r",
    decision: "allow",
    rationale: "ok",
    riskLevel: "low",
    ruleHits: [],
    policyBackend: "rhiz-native",
    evaluatedAt: new Date().toISOString(),
    durationMs: 0,
  });
  cb.record(allow);
  cb.record(allow);
  assert.equal(cb.snapshot().evaluationCount, 2);
});

test("ExecPolicyBackendOracle refuses policies whose backend is not execpolicy", async () => {
  const oracle = new ExecPolicyBackendOracle({ executablePath: "/usr/local/bin/codex-execpolicy" });
  const p = policy({ backend: "rhiz-native" });
  await assert.rejects(
    oracle.evaluate(request(), p),
    (err: unknown) => err instanceof GuardConfigurationError,
  );
});

test("ExecPolicyBackendOracle refuses policies whose backendConfig.executablePath does not match the constructor", async () => {
  const oracle = new ExecPolicyBackendOracle({ executablePath: "/usr/local/bin/codex-execpolicy" });
  const p = policy({ backend: "execpolicy", backendConfig: { executablePath: "/different/path" } });
  await assert.rejects(
    oracle.evaluate(request(), p),
    (err: unknown) => err instanceof GuardConfigurationError,
  );
});

test("ExecPolicyBackendOracle throws GuardOracleUnavailableError when the unimplemented sentinel is mounted", async () => {
  const oracle = new ExecPolicyBackendOracle({ executablePath: "/usr/local/bin/codex-execpolicy" });
  assert.equal(oracle.version, EXEC_POLICY_BACKEND_VERSION);
  const p = policy({ backend: "execpolicy", backendConfig: { executablePath: "/usr/local/bin/codex-execpolicy" } });
  await assert.rejects(
    oracle.evaluate(request(), p),
    (err: unknown) => err instanceof GuardOracleUnavailableError,
  );
});

test("createDefaultPolicyOracle returns RhizNativePolicyOracle by default", () => {
  const oracle = createDefaultPolicyOracle(policy());
  assert.equal(oracle.name, "rhiz-native");
  assert.equal(oracle.version, "0.1.0");
});

test("createDefaultPolicyOracle returns ExecPolicyBackendOracle when backend is execpolicy", () => {
  const oracle = createDefaultPolicyOracle(
    policy({ backend: "execpolicy", backendConfig: { executablePath: "/usr/local/bin/codex-execpolicy" } }),
    { execPolicy: { executablePath: "/usr/local/bin/codex-execpolicy" } },
  );
  assert.equal(oracle.name, "execpolicy");
  assert.equal(oracle.version, EXEC_POLICY_BACKEND_VERSION);
});

test("createDefaultPolicyOracle rejects execpolicy backend without execPolicy options", () => {
  assert.throws(
    () => createDefaultPolicyOracle(
      policy({ backend: "execpolicy", backendConfig: { executablePath: "/usr/local/bin/codex-execpolicy" } }),
    ),
    (err: unknown) => err instanceof GuardConfigurationError,
  );
});

test("assertGuardCanEvaluate rejects oracle/policy pair mismatches", async () => {
  const oracle = new RhizNativePolicyOracle();
  const cb = new GuardianRejectionCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  await assert.rejects(
    assertGuardCanEvaluate(
      oracle,
      request(),
      policy({ backend: "execpolicy", backendConfig: { executablePath: "/x" } }),
      cb,
    ),
    (err: unknown) => err instanceof GuardConfigurationError,
  );
});

test("assertGuardCanEvaluate throws GuardCircuitOpenError when the breaker is open", async () => {
  const oracle = new RhizNativePolicyOracle();
  const cb = new GuardianRejectionCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  const deny = parseGuardVerdict({
    requestId: "r",
    decision: "forbid",
    rationale: "no",
    riskLevel: "high",
    ruleHits: [],
    policyBackend: "rhiz-native",
    evaluatedAt: new Date().toISOString(),
    durationMs: 0,
  });
  cb.record(deny);
  cb.record(deny);
  cb.record(deny);
  await assert.rejects(
    assertGuardCanEvaluate(oracle, request(), policy(), cb),
    (err: unknown) => err instanceof GuardCircuitOpenError,
  );
});

test("assertGuardCanEvaluate records the verdict into the breaker on success", async () => {
  const oracle = new RhizNativePolicyOracle();
  const cb = new GuardianRejectionCircuitBreaker(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  const before = cb.snapshot().evaluationCount;
  await assertGuardCanEvaluate(oracle, request(), policy(), cb);
  assert.equal(cb.snapshot().evaluationCount, before + 1);
});

test("guardPolicyFromWorkContract derives a denying policy, grants or no grants", () => {
  for (const authority of [
    { grants: [], requiresHumanApproval: [] },
    { grants: [{ action: "write" as const, resources: [], constraints: [] }], requiresHumanApproval: [] },
  ]) {
    const p = guardPolicyFromWorkContract(work({ authority }));
    assert.equal(p.denyByDefault, true);
    // Assert the exact constant, not "not the wrong one". notEqual is satisfied
    // by both "prompt" and "forbid", and those are different products: one
    // stops and asks a human, the other denies with nobody in the loop. If the
    // derivation later hardens to "forbid" it would silently stop routing to a
    // person and a notEqual assertion would stay green. That is the same shape
    // as the defect this file exists to catch.
    assert.equal(p.defaultDecision, "prompt");
  }
});

test("guardPolicyFromWorkContract derives defaultDecision=prompt when requiresHumanApproval is non-empty", () => {
  const p = guardPolicyFromWorkContract(work({ authority: { grants: [{ action: "read", resources: [], constraints: [] }], requiresHumanApproval: ["publish"] } }));
  assert.equal(p.defaultDecision, "prompt");
});

test("guardPolicyFromWorkContract surfaces execute constraints as forbiddenPatterns", () => {
  const p = guardPolicyFromWorkContract(work({
    authority: { grants: [{ action: "execute", resources: [], constraints: ["rm -rf"] }], requiresHumanApproval: [] },
  }));
  assert.ok(p.forbiddenPatterns.includes("rm -rf"));
});

test("guardPolicyFromWorkContract overrides apply on top of derived defaults", () => {
  const p = guardPolicyFromWorkContract(work(), { defaultDecision: "forbid" });
  assert.equal(p.defaultDecision, "forbid");
});

test("GuardDecisionSchema is the three-valued trichotomy: allow, prompt, forbid", () => {
  assert.deepEqual([...GuardDecisionSchema.options].sort(), ["allow", "forbid", "prompt"]);
});

test("ToolCategorySchema covers the seven categories the Constitution §9 enumerates", () => {
  assert.deepEqual([...ToolCategorySchema.options].sort(), [
    "credential",
    "external-mutate",
    "network",
    "other",
    "read",
    "shell",
    "write",
  ]);
});

test("RiskLevelSchema is the four-valued severity lattice", () => {
  assert.deepEqual([...RiskLevelSchema.options].sort(), ["critical", "high", "low", "medium"]);
});

// Falsifies: guard/deny-by-default-actually-denies
test("deny-by-default forbids an unlisted tool regardless of defaultDecision", async () => {
  const oracle = new RhizNativePolicyOracle();
  const policy = parseGuardPolicy({
    workId: "work:deny",
    denyByDefault: true,
    // The dangerous combination: the flag says deny, the fallback says allow.
    defaultDecision: "allow",
    perToolMode: {},
    forbiddenPatterns: [],
    backend: "rhiz-native",
  });
  const verdict = await oracle.evaluate(parseGuardRequest({
    requestId: "req:deny",
    workId: "work:deny",
    taskId: "task:deny",
    attemptId: "attempt:deny",
    actor: { id: "agent:worker", kind: "agent" },
    tool: { name: "tool:unlisted", category: "shell", args: {} },
    writeScope: "workspace",
    contextHash: "hash",
    evidenceRefs: [],
    timestampMs: 0,
  }), policy);

  // Assert the DECISION, never the label. A test that asserts ruleHits alone
  // passes against the defect this exists to catch.
  assert.equal(verdict.decision, "forbid");
  assert.ok(verdict.ruleHits.includes("default-deny:no-per-tool-mode-match"));
});

// Falsifies: guard/contract-derives-a-denying-policy
test("an ordinary contract derives a policy that denies unlisted tools", () => {
  const contract = parseWorkContractForGuard({
    id: "work:ordinary",
    objective: "An ordinary SHIP contract with grants and no approval list",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [{ action: "write", resources: [{ uri: "repo://example/src", kind: "directory" }], constraints: [] }],
      requiresHumanApproval: [],
    },
    acceptanceCriteria: [{ id: "criterion:x", description: "proven", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: { id: "human:owner", kind: "human" },
    createdAt: "2026-08-20T17:00:00.000Z",
  });
  const policy = guardPolicyFromWorkContract(contract);
  assert.equal(policy.denyByDefault, true);
  // Assert the value, not the absence of one wrong value. The derivation is a
  // literal constant, so there is no variability to accommodate, and
  // notEqual("allow") is satisfied by both "prompt" and "forbid". Those are
  // different products: "prompt" stops and asks a human, "forbid" denies with
  // nobody in the loop. A later hardening of that constant would silently stop
  // routing anything to a person while this test stayed green. Issue #39.
  assert.equal(policy.defaultDecision, "prompt");
});
