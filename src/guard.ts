import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ActorRef,
  GuardDecision,
  GuardEvaluation,
  GuardEvaluationRecord,
  GuardRequest,
  GuardToolArgsSummary,
  GuardToolCall,
  GuardVerdict,
  RiskLevel,
  ToolCategory,
  WorkContract,
} from "./schemas.js";
import {
  ActorRefSchema,
  GuardDecisionSchema,
  GuardEvaluationRecordSchema,
  GuardEvaluationSchema,
  GuardRequestSchema,
  GuardToolCallSchema,
  GuardVerdictSchema,
  RiskLevelSchema,
  ToolCategorySchema,
  WorkContractSchema,
} from "./schemas.js";

export {
  GuardDecisionSchema,
  GuardEvaluationRecordSchema,
  GuardEvaluationSchema,
  GuardRequestSchema,
  GuardToolCallSchema,
  GuardVerdictSchema,
  RiskLevelSchema,
  ToolCategorySchema,
} from "./schemas.js";
export type {
  GuardDecision,
  GuardEvaluation,
  GuardEvaluationRecord,
  GuardToolArgsSummary,
  GuardRequest,
  GuardToolCall,
  GuardVerdict,
  RiskLevel,
  ToolCategory,
} from "./schemas.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);

export const GuardBackendSchema = z.enum(["rhiz-native", "execpolicy"]);
export type GuardBackend = z.infer<typeof GuardBackendSchema>;

export const DEFAULT_RISK_LEVELS: Readonly<Record<ToolCategory, RiskLevel>> = Object.freeze({
  read: "low",
  write: "medium",
  shell: "high",
  network: "high",
  credential: "critical",
  "external-mutate": "critical",
  other: "medium",
});

export interface CircuitBreakerConfigPlain {
  readonly consecutiveDenialLimit: number;
  readonly slidingWindowDenialLimit: number;
  readonly slidingWindowDurationMs: number;
  readonly timeoutMs: number;
  readonly perCategoryTokenBudget: {
    readonly prompt: number;
    readonly tool: number;
    readonly perEntry: number;
  };
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfigPlain = Object.freeze({
  consecutiveDenialLimit: 3,
  slidingWindowDenialLimit: 10,
  slidingWindowDurationMs: 300_000,
  timeoutMs: 90_000,
  perCategoryTokenBudget: { prompt: 10_000, tool: 10_000, perEntry: 2_000 },
});

export const PerToolGuardModeSchema = z.object({
  decision: GuardDecisionSchema,
  requireEvidence: z.boolean().default(false),
  maxInvocationsPerAttempt: z.number().int().nonnegative().optional(),
}).strict();
export type PerToolGuardMode = z.infer<typeof PerToolGuardModeSchema>;

export const CircuitBreakerConfigSchema = z.object({
  consecutiveDenialLimit: z.number().int().positive().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.consecutiveDenialLimit),
  slidingWindowDenialLimit: z.number().int().positive().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.slidingWindowDenialLimit),
  slidingWindowDurationMs: z.number().int().positive().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.slidingWindowDurationMs),
  timeoutMs: z.number().int().positive().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.timeoutMs),
  perCategoryTokenBudget: z.object({
    prompt: z.number().int().nonnegative().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.perCategoryTokenBudget.prompt),
    tool: z.number().int().nonnegative().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.perCategoryTokenBudget.tool),
    perEntry: z.number().int().nonnegative().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.perCategoryTokenBudget.perEntry),
  }).strict().default(DEFAULT_CIRCUIT_BREAKER_CONFIG.perCategoryTokenBudget),
}).strict().default(DEFAULT_CIRCUIT_BREAKER_CONFIG);
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;

const PerCategoryGuardModeRecordSchema = z.record(z.string(), PerToolGuardModeSchema).default({}).superRefine((value, ctx) => {
  for (const category of Object.keys(value)) {
    if (!ToolCategorySchema.safeParse(category).success) {
      ctx.addIssue({
        code: "custom",
        path: [category],
        message: `unknown tool category ${category}`,
      });
    }
  }
});

export const GuardPolicySchema = z.object({
  workId: id,
  defaultDecision: GuardDecisionSchema.default("prompt"),
  denyByDefault: z.boolean().default(true),
  perToolMode: z.record(id, PerToolGuardModeSchema).default({}),
  perCategoryMode: PerCategoryGuardModeRecordSchema,
  /** Exact host-broker operations, independent of filesystem category authority. */
  httpEffects: z.array(z.object({
    toolName: id,
    method: z.enum(["GET", "POST"]),
    url: z.url(),
    action: z.enum(["read", "external-mutate"]),
    resourceUri: text.max(2048),
    decision: GuardDecisionSchema.default("forbid"),
  }).strict()).default([]),
  /**
   * Category authority is only live when the caller has already established a
   * Work-derived, workspace-bound enforcement boundary. A Work grant alone is
   * semantic permission; it is not proof that an arbitrary provider is
   * physically confined to those resources.
   */
  contractBoundCategoryAuthority: z.boolean().default(false),
  forbiddenPatterns: z.array(text.max(500)).default([]),
  circuitBreaker: CircuitBreakerConfigSchema,
  backend: GuardBackendSchema.default("rhiz-native"),
  backendConfig: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  const effectNames = new Set<string>();
  for (const [index, effect] of value.httpEffects.entries()) {
    if (effect.action !== (effect.method === "POST" ? "external-mutate" : "read") ||
        effect.resourceUri !== `http-effect:${effect.method}:${effect.url}` || effectNames.has(effect.toolName)) {
      ctx.addIssue({ code: "custom", path: ["httpEffects", index], message: "HTTP effect action/resource must match its unique exact method and URL" });
    }
    effectNames.add(effect.toolName);
  }
  if (value.backend === "execpolicy" && Object.keys(value.backendConfig).length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["backendConfig"],
      message: "backendConfig must be supplied when backend is 'execpolicy'",
    });
  }
});
export type GuardPolicy = z.infer<typeof GuardPolicySchema>;
export type GuardPolicyInput = z.input<typeof GuardPolicySchema>;

export type GuardVerdictInput = z.input<typeof GuardVerdictSchema>;

export class GuardError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "GuardError";
  }
}

export class GuardOracleUnavailableError extends GuardError {
  constructor(message: string) {
    super(message, "GUARD_ORACLE_UNAVAILABLE");
    this.name = "GuardOracleUnavailableError";
  }
}

export class GuardCircuitOpenError extends GuardError {
  constructor(
    message: string,
    readonly attempts: number,
    readonly consecutiveDenials: number,
    readonly windowDenials: number,
    readonly reason: string,
  ) {
    super(message, "GUARD_CIRCUIT_OPEN");
    this.name = "GuardCircuitOpenError";
  }
}

export class GuardConfigurationError extends GuardError {
  constructor(message: string) {
    super(message, "GUARD_CONFIGURATION_ERROR");
    this.name = "GuardConfigurationError";
  }
}

export class GuardVerificationError extends GuardError {
  constructor(message: string) {
    super(message, "GUARD_VERIFICATION_ERROR");
    this.name = "GuardVerificationError";
  }
}

export interface PolicyOracle {
  readonly name: string;
  readonly version: string;
  evaluate(request: GuardRequest, policy: GuardPolicy): Promise<GuardVerdict>;
}

export interface CircuitBreakerSnapshot {
  readonly consecutiveDenials: number;
  readonly windowDenials: number;
  readonly isOpen: boolean;
  readonly openReason: string | null;
  readonly evaluationCount: number;
}

export const CIRCUIT_BREAKER_OPEN_THRESHOLD = Symbol.for("rhiz.guard.circuit_open");

export class GuardianRejectionCircuitBreaker {
  private consecutiveDenials = 0;
  private recentDenials: number[] = [];
  private openReason: string | null = null;
  private evaluationCount = 0;

  constructor(private readonly config: GuardPolicy["circuitBreaker"]) {}

  record(verdict: GuardVerdict): void {
    this.evaluationCount += 1;
    const isDenial = verdict.decision === "forbid";
    if (isDenial) {
      this.consecutiveDenials += 1;
      this.recentDenials.push(Date.now());
      this.pruneWindow();
    } else {
      this.consecutiveDenials = 0;
    }
    this.check();
  }

  isOpen(): boolean {
    return this.openReason !== null;
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      consecutiveDenials: this.consecutiveDenials,
      windowDenials: this.recentDenials.length,
      isOpen: this.isOpen(),
      openReason: this.openReason,
      evaluationCount: this.evaluationCount,
    };
  }

  reset(): void {
    this.consecutiveDenials = 0;
    this.recentDenials = [];
    this.openReason = null;
    this.evaluationCount = 0;
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - this.config.slidingWindowDurationMs;
    while (this.recentDenials.length > 0 && (this.recentDenials[0] ?? Number.MAX_SAFE_INTEGER) < cutoff) {
      this.recentDenials.shift();
    }
  }

  private check(): void {
    if (this.consecutiveDenials >= this.config.consecutiveDenialLimit) {
      this.openReason = `consecutive denials ${this.consecutiveDenials} reached limit ${this.config.consecutiveDenialLimit}`;
    } else if (this.recentDenials.length >= this.config.slidingWindowDenialLimit) {
      this.openReason = `sliding-window denials ${this.recentDenials.length} reached limit ${this.config.slidingWindowDenialLimit} (window ${this.config.slidingWindowDurationMs}ms)`;
    }
  }
}

export interface RhizNativePolicyOracleOptions {
  readonly now?: (() => number) | undefined;
  readonly clock?: (() => Date) | undefined;
}

export class RhizNativePolicyOracle implements PolicyOracle {
  readonly name = "rhiz-native";
  readonly version = "0.1.0";

  constructor(private readonly options: RhizNativePolicyOracleOptions = {}) {}

  async evaluate(request: GuardRequest, policy: GuardPolicy): Promise<GuardVerdict> {
    const start = (this.options.now?.() ?? Date.now());
    const ruleHits: string[] = [];
    const now = (this.options.clock?.() ?? new Date()).toISOString();

    const verdict = (decision: GuardDecision, rationale: string, riskLevel: RiskLevel, hits: string[]): GuardVerdict => ({
      requestId: request.requestId,
      decision,
      rationale,
      riskLevel,
      ruleHits: hits,
      policyBackend: this.name,
      policyBackendVersion: this.version,
      evaluatedAt: now,
      durationMs: (this.options.now?.() ?? Date.now()) - start,
    });

    const harnessOwnedGitOperation = matchHarnessOwnedGitOperation(request);
    if (harnessOwnedGitOperation !== null) {
      ruleHits.push("integration-git-authority:harness-owned");
      return verdict(
        "forbid",
        `${harnessOwnedGitOperation} is owned by the Work Integration Controller, not by a worker Attempt.`,
        "critical",
        ruleHits,
      );
    }

    const forbiddenHit = matchForbiddenPattern(request, policy.forbiddenPatterns);
    if (forbiddenHit !== null) {
      ruleHits.push(`forbidden-pattern:${forbiddenHit}`);
      return verdict("forbid", `Tool "${request.tool.name}" args match forbidden pattern "${forbiddenHit}".`, "critical", ruleHits);
    }

    const httpEffect = policy.httpEffects.find((binding) => binding.toolName === request.tool.name);
    if (httpEffect !== undefined) {
      const args = request.tool.args;
      const expectedCategory = httpEffect.method === "POST" ? "external-mutate" : "network";
      if (request.tool.category !== expectedCategory || args.method !== httpEffect.method ||
          args.url !== httpEffect.url || args.resourceUri !== httpEffect.resourceUri) {
        return verdict("forbid", "HTTP effect does not match its exact host binding.", "critical", ["http-effect:binding-mismatch"]);
      }
      return verdict(httpEffect.decision, "Exact HTTP effect evaluated against Work authority.",
        DEFAULT_RISK_LEVELS[expectedCategory], [`http-effect:${httpEffect.decision}`]);
    }

    const toolMode = policy.perToolMode[request.tool.name];
    if (toolMode !== undefined) {
      if (toolMode.requireEvidence && request.evidenceRefs.length === 0) {
        ruleHits.push("per-tool-mode:requires-evidence");
        return verdict("prompt", `Tool "${request.tool.name}" requires evidence; none provided.`, DEFAULT_RISK_LEVELS[request.tool.category], ruleHits);
      }
      ruleHits.push(`per-tool-mode:${request.tool.name}:${toolMode.decision}`);
      return verdict(toolMode.decision, `Per-tool mode for "${request.tool.name}" → ${toolMode.decision}.`, DEFAULT_RISK_LEVELS[request.tool.category], ruleHits);
    }

    const categoryMode = policy.contractBoundCategoryAuthority
      ? policy.perCategoryMode[request.tool.category]
      : undefined;
    if (categoryMode !== undefined) {
      if (categoryMode.requireEvidence && request.evidenceRefs.length === 0) {
        ruleHits.push("per-category-mode:requires-evidence");
        return verdict("prompt", `Tool category "${request.tool.category}" requires evidence; none provided.`, DEFAULT_RISK_LEVELS[request.tool.category], ruleHits);
      }
      ruleHits.push(`per-category-mode:${request.tool.category}:${categoryMode.decision}`);
      return verdict(
        categoryMode.decision,
        `Category mode for "${request.tool.category}" → ${categoryMode.decision}.`,
        DEFAULT_RISK_LEVELS[request.tool.category],
        ruleHits,
      );
    }

    if (policy.denyByDefault) {
      // Preserve the stable rule-hit identity: consumers use it as evidence.
      // Category authority is a higher-priority optional seam, not a rename of
      // the long-standing default-deny fact.
      ruleHits.push("default-deny:no-per-tool-mode-match");
      return verdict("forbid", `Tool "${request.tool.name}" has no active specific/category authorization and this policy denies by default.`, DEFAULT_RISK_LEVELS[request.tool.category], ruleHits);
    }

    ruleHits.push("default-allow:no-per-tool-mode-match");
    return verdict(policy.defaultDecision, `Tool "${request.tool.name}" has no active specific/category authorization; default-decision ${policy.defaultDecision} applied.`, DEFAULT_RISK_LEVELS[request.tool.category], ruleHits);
  }
}

export interface ExecPolicyBackendOracleOptions {
  readonly executablePath: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly version?: string;
}

export const EXEC_POLICY_BACKEND_VERSION = "0.0.0-unimplemented";

export class ExecPolicyBackendOracle implements PolicyOracle {
  readonly name = "execpolicy";
  readonly version: string;

  constructor(private readonly options: ExecPolicyBackendOracleOptions) {
    this.version = options.version ?? EXEC_POLICY_BACKEND_VERSION;
  }

  async evaluate(request: GuardRequest, policy: GuardPolicy): Promise<GuardVerdict> {
    if (policy.backend !== "execpolicy") {
      throw new GuardConfigurationError(`ExecPolicyBackendOracle cannot evaluate policy with backend="${policy.backend}"`);
    }
    if (policy.backendConfig["executablePath"] !== this.options.executablePath) {
      throw new GuardConfigurationError("policy.backendConfig.executablePath does not match configured oracle executablePath");
    }
    if (this.version === EXEC_POLICY_BACKEND_VERSION) {
      throw new GuardOracleUnavailableError("ExecPolicyBackendOracle sidecar runtime not yet implemented in Rhiz Kernel 0.1; set options.version to a non-unimplemented sentinel once a sidecar ships");
    }
    throw new GuardOracleUnavailableError(`ExecPolicyBackendOracle sidecar runtime version ${this.version} is not mounted in this build`);
  }
}

export interface CreateDefaultPolicyOracleOptions {
  readonly execPolicy?: ExecPolicyBackendOracleOptions | undefined;
  readonly now?: (() => number) | undefined;
  readonly clock?: (() => Date) | undefined;
}

export function createDefaultPolicyOracle(
  policy: GuardPolicy,
  options: CreateDefaultPolicyOracleOptions = {},
): PolicyOracle {
  if (policy.backend === "execpolicy") {
    if (options.execPolicy === undefined) {
      throw new GuardConfigurationError("policy.backend='execpolicy' requires createDefaultPolicyOracle options.execPolicy");
    }
    return new ExecPolicyBackendOracle(options.execPolicy);
  }
  return new RhizNativePolicyOracle({ now: options.now, clock: options.clock });
}

export async function assertGuardCanEvaluate(
  oracle: PolicyOracle,
  request: GuardRequest,
  policy: GuardPolicy,
  circuitBreaker: GuardianRejectionCircuitBreaker,
  attempt: number = 1,
  /**
   * Maps the oracle's verdict to the one that will actually authorize or
   * refuse the effect. The circuit breaker counts what is effected, not what
   * was proposed: a decision that is recorded and enforced as a denial must
   * advance the breaker even when the oracle called it something else.
   */
  effect: (verdict: GuardVerdict) => GuardVerdict = (verdict) => verdict,
): Promise<GuardVerdict> {
  if (circuitBreaker.isOpen()) {
    const snap = circuitBreaker.snapshot();
    throw new GuardCircuitOpenError(
      `Guard circuit breaker open: ${snap.openReason}`,
      attempt,
      snap.consecutiveDenials,
      snap.windowDenials,
      snap.openReason ?? "unknown",
    );
  }
  if (policy.backend !== oracle.name && !(oracle.name === "execpolicy" && policy.backend === "execpolicy")) {
    throw new GuardConfigurationError(`policy.backend="${policy.backend}" does not match oracle.name="${oracle.name}"`);
  }
  const verdict = effect(await oracle.evaluate(request, policy));
  circuitBreaker.record(verdict);
  return verdict;
}

/**
 * An attempt-scoped mediation contract for native provider permission hooks.
 * The provider gives it the native request identity and raw arguments, receives
 * the Guard verdict synchronously, and must not effect a `forbid` verdict.
 *
 * `evaluate` never rejects. The native permission channel is synchronous and
 * has no defined behaviour for a rejected promise, so every failure to reach a
 * verdict - an open circuit breaker, an unavailable oracle, a misconfigured
 * policy, an unparsable native call - resolves as a recorded `forbid`.
 */
export interface GuardedToolMediation {
  evaluate(call: GuardToolCall): Promise<GuardEvaluation>;
}

export interface GuardedToolMediationOptions {
  readonly oracle: PolicyOracle;
  readonly policy: GuardPolicy;
  readonly circuitBreaker: GuardianRejectionCircuitBreaker;
  readonly workId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly actor: ActorRef;
  readonly writeScope: GuardRequest["writeScope"];
  readonly contextHash: string;
  readonly evidenceRefs?: readonly string[];
  readonly now?: () => number;
  /**
   * Whether the mediated seam has a human approval channel. Native permission
   * hooks are answered by a machine, so a `prompt` verdict - "a human must
   * decide this" - has nobody to ask and is collapsed to `forbid` before the
   * decision is recorded. Only a seam that can actually carry the question to
   * a human may declare `interactive`.
   */
  readonly approvalChannel?: "none" | "interactive";
  /**
   * Writes the bounded, durable form of the decision before the verdict is
   * handed back to the native runtime. Advisory recording does not revise an
   * authorization decision. Crew separately requires successful durable
   * admission with requireRecordBeforeEffect before allowing an effect.
   */
  readonly record?: (record: GuardEvaluationRecord) => Promise<void>;
  /** Crew requires durable admission before any native effect may proceed. */
  readonly requireRecordBeforeEffect?: boolean;
}

const MEDIATION_BACKEND = "rhiz-guard-mediation";
/** The largest instant a `Date` can represent, and so the largest one evidence can carry. */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MEDIATION_TIMESTAMP_SUBSTITUTED = "mediation-timestamp-substituted";

/** A timestamp and whether it came from the clock the caller asked for. */
interface ObservedClock {
  readonly timestampMs: number;
  readonly substituted: boolean;
}

function mediationId(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, 200);
  return trimmed.length === 0 ? fallback : trimmed;
}

function usableTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "bigint") return `${entry}n`;
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const source = entry as Record<string, unknown>;
      return Object.fromEntries(Object.keys(source).sort().map((key) => [key, source[key]]));
    }
    return entry;
  }) ?? "";
}

/**
 * Reduce native tool arguments to what evidence may keep.
 *
 * The digest is taken over key-sorted JSON, so two records of the same call
 * correlate, and nothing that was in the arguments survives into the record.
 * This never throws: arguments that cannot be serialized are still summarized.
 */
export function summarizeGuardToolArgs(args: unknown): GuardToolArgsSummary {
  let keys: string[] = [];
  try {
    keys = Object.keys((args ?? {}) as Record<string, unknown>).sort();
  } catch {
    keys = [];
  }
  let canonical: string | null = null;
  try {
    canonical = canonicalJson(args ?? {});
  } catch {
    canonical = null;
  }
  return {
    keys: keys.slice(0, 64).map((key) => key.trim().slice(0, 200)).filter((key) => key.length > 0),
    keyCount: keys.length,
    byteSize: canonical === null ? 0 : new TextEncoder().encode(canonical).length,
    digest: canonical === null
      ? "unavailable:arguments-are-not-serializable"
      : `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  };
}

/** The durable, bounded form of an evaluation. Pure, and never throws. */
export function summarizeGuardEvaluation(evaluation: GuardEvaluation): GuardEvaluationRecord {
  return {
    request: {
      ...evaluation.request,
      tool: {
        name: evaluation.request.tool.name,
        category: evaluation.request.tool.category,
        args: summarizeGuardToolArgs(evaluation.request.tool.args),
      },
    },
    verdict: evaluation.verdict,
  };
}

function failureReason(cause: unknown): string {
  if (cause instanceof GuardError) return `${cause.name}: ${cause.message}`;
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

const MEDIATION_PROBE_TOOL = Object.freeze({
  name: "guard:scope-probe",
  category: "other" as const,
  args: {} as Record<string, unknown>,
});

class DefaultGuardedToolMediation implements GuardedToolMediation {
  readonly #options: GuardedToolMediationOptions;
  readonly #actor: ActorRef;

  constructor(options: GuardedToolMediationOptions) {
    this.#options = options;
    if (options.policy.workId !== options.workId) {
      throw new GuardConfigurationError(
        `guard policy workId ${options.policy.workId} does not match mediated work ${options.workId}`,
      );
    }
    // The attempt scope is validated once, here, so that no later request can
    // fail to parse for a reason the native call did not cause. A permission
    // channel that rejects has no verdict to honour, so a misconfigured scope
    // must fail at wiring time instead.
    try {
      this.#actor = ActorRefSchema.parse(options.actor);
      GuardRequestSchema.parse({
        requestId: "guard:scope-probe",
        tool: MEDIATION_PROBE_TOOL,
        ...this.#scopeFrom(this.#actor, 0),
      });
    } catch (cause) {
      throw new GuardConfigurationError(
        `guarded tool mediation cannot be wired for work ${options.workId}: ${failureReason(cause)}`,
      );
    }
  }

  async evaluate(rawCall: GuardToolCall): Promise<GuardEvaluation> {
    try {
      return await this.#mediate(rawCall);
    } catch (cause) {
      // Last resort: the permission channel is synchronous and a rejection
      // leaves the native runtime with no verdict to honour, so an unforeseen
      // failure still resolves as a refusal, recorded if the ledger will take it.
      const refusal = this.#unrecordableForbid(rawCall, cause);
      this.#count(refusal.verdict);
      return await this.#record(refusal);
    }
  }

  async #mediate(rawCall: GuardToolCall): Promise<GuardEvaluation> {
    const clock = this.#observedClock();
    if (clock.timestampMs === 0 && clock.substituted) {
      throw new GuardConfigurationError(
        "guard mediation has no observable clock, so no truthful evidence can be written for this request",
      );
    }
    let request: GuardRequest;
    try {
      request = GuardRequestSchema.parse({
        ...GuardToolCallSchema.parse(rawCall),
        ...this.#scopeFrom(this.#actor, clock.timestampMs),
      });
    } catch (cause) {
      // An unparsable native call has no trustworthy tool identity, so it is
      // refused outright rather than matched against a per-tool policy.
      const refusal = this.#forbid(
        this.#unparsableRequest(rawCall, clock),
        `Guard could not parse this native tool call; failing closed. ${failureReason(cause)}`,
        clock,
      );
      this.#count(refusal.verdict);
      return await this.#record(refusal);
    }

    let evaluation: GuardEvaluation;
    try {
      const verdict = await assertGuardCanEvaluate(
        this.#options.oracle,
        request,
        this.#options.policy,
        this.#options.circuitBreaker,
        1,
        (raw) => this.#effectiveVerdict(raw),
      );
      evaluation = GuardEvaluationSchema.parse({ request, verdict: this.#withClockProvenance(verdict, clock) });
    } catch (cause) {
      evaluation = this.#forbid(request, `Guard could not evaluate this request; failing closed. ${failureReason(cause)}`, clock);
      this.#count(evaluation.verdict);
    }
    return await this.#record(evaluation);
  }

  /**
   * Only `allow` may authorize a native effect at a seam with no human to ask.
   * The original decision and its rule hits stay in the record, so the audit
   * still shows what Guard said and why the seam could not honour it.
   */
  #effectiveVerdict(verdict: GuardVerdict): GuardVerdict {
    const { decision } = verdict;
    if (decision !== "allow" && decision !== "forbid" && (this.#options.approvalChannel ?? "none") !== "interactive") {
      return {
        ...verdict,
        decision: "forbid",
        rationale: `Guard decided "${decision}" but this seam has no human approval channel, so the effect is refused. ${verdict.rationale}`.slice(0, 4000),
        ruleHits: [...verdict.ruleHits, `mediation-no-approval-channel:${decision}`],
      };
    }
    return verdict;
  }

  /**
   * A record whose timestamp came from somewhere other than the clock the rest
   * of the attempt uses says so, so a replay can see the disagreement instead
   * of inheriting it silently.
   */
  #withClockProvenance(verdict: GuardVerdict, clock: ObservedClock): GuardVerdict {
    if (!clock.substituted) return verdict;
    return { ...verdict, ruleHits: [...verdict.ruleHits, MEDIATION_TIMESTAMP_SUBSTITUTED] };
  }

  /**
   * The breaker counts denials that were actually enforced. A fail-closed
   * refusal is one of those; a failure to write evidence is not.
   */
  #count(verdict: GuardVerdict): void {
    try {
      this.#options.circuitBreaker.record(verdict);
    } catch {
      // A breaker that cannot count does not get to change this decision.
    }
  }

  async #record(evaluation: GuardEvaluation): Promise<GuardEvaluation> {
    try {
      if (this.#options.record === undefined) {
        if (this.#options.requireRecordBeforeEffect) throw new Error("Required Guard recorder is missing");
        return evaluation;
      }
      await this.#options.record(GuardEvaluationRecordSchema.parse(summarizeGuardEvaluation(evaluation)));
    } catch {
      if (this.#options.requireRecordBeforeEffect) {
        // Authorization may allow the action, but the required durable admission
        // did not complete. Return a refusal without exposing the storage error.
        return { ...evaluation, verdict: { ...evaluation.verdict, decision: "forbid",
          rationale: "Required Guard admission could not be recorded; execution refused.",
          ruleHits: [...evaluation.verdict.ruleHits, "guard-record:required-write-failed"] } };
      }
    }
    return evaluation;
  }

  #scopeFrom(actor: ActorRef, timestampMs: number): Omit<GuardRequest, "requestId" | "tool"> {
    return {
      workId: this.#options.workId,
      taskId: this.#options.taskId,
      attemptId: this.#options.attemptId,
      actor,
      writeScope: this.#options.writeScope,
      contextHash: this.#options.contextHash,
      evidenceRefs: [...(this.#options.evidenceRefs ?? [])],
      timestampMs,
    };
  }

  /**
   * A durable Guard record must never carry a timestamp nobody observed. An
   * injected clock that returns nonsense is replaced by the wall clock, and the
   * substitution is reported so every evaluation built from it can mark the
   * record rather than hide the disagreement.
   */
  #observedClock(): ObservedClock {
    let injected: number | undefined;
    try {
      injected = this.#options.now?.();
    } catch {
      injected = Number.NaN;
    }
    if (injected !== undefined && usableTimestamp(injected)) {
      return { timestampMs: injected, substituted: false };
    }
    const wall = Date.now();
    if (usableTimestamp(wall)) {
      return { timestampMs: wall, substituted: injected !== undefined };
    }
    return { timestampMs: 0, substituted: true };
  }

  #unrecordableForbid(rawCall: GuardToolCall, cause: unknown): GuardEvaluation {
    let requestId = "guard:unmediatable-request";
    try {
      requestId = mediationId((rawCall as { requestId?: unknown } | null | undefined)?.requestId, requestId);
    } catch {
      // A call object that cannot even be read still gets an identified refusal.
    }
    const clock = this.#observedClock();
    const timestampMs = clock.timestampMs;
    return {
      request: {
        requestId,
        tool: { name: "guard:unmediatable-tool", category: "other", args: {} },
        workId: mediationId(this.#options.workId, "guard:unknown-work"),
        taskId: mediationId(this.#options.taskId, "guard:unknown-task"),
        attemptId: mediationId(this.#options.attemptId, "guard:unknown-attempt"),
        actor: this.#actor,
        writeScope: this.#options.writeScope,
        contextHash: mediationId(this.#options.contextHash, "guard:unknown-context"),
        evidenceRefs: [],
        timestampMs,
      },
      verdict: {
        requestId,
        decision: "forbid",
        rationale: `Guard mediation failed unexpectedly; failing closed. ${failureReason(cause)}`.slice(0, 4000),
        riskLevel: "critical",
        ruleHits: clock.substituted ? ["mediation-fail-closed", MEDIATION_TIMESTAMP_SUBSTITUTED] : ["mediation-fail-closed"],
        policyBackend: MEDIATION_BACKEND,
        evaluatedAt: new Date(timestampMs).toISOString(),
        durationMs: 0,
      },
    };
  }

  #unparsableRequest(rawCall: GuardToolCall, clock: ObservedClock): GuardRequest {
    // A refusal still has to be identified and recorded, so what the native
    // call claimed about itself is kept, sanitized, for the audit record only.
    const call = rawCall as { requestId?: unknown; tool?: { name?: unknown } } | null | undefined;
    return GuardRequestSchema.parse({
      requestId: mediationId(call?.requestId, "guard:unparsable-request"),
      tool: { name: mediationId(call?.tool?.name, "guard:unparsable-tool"), category: "other", args: {} },
      ...this.#scopeFrom(this.#actor, clock.timestampMs),
    });
  }

  #forbid(request: GuardRequest, rationale: string, clock: ObservedClock = { timestampMs: request.timestampMs, substituted: false }): GuardEvaluation {
    return GuardEvaluationSchema.parse({
      request,
      verdict: {
        requestId: request.requestId,
        decision: "forbid",
        rationale: rationale.slice(0, 4000),
        riskLevel: "critical",
        ruleHits: clock.substituted ? ["mediation-fail-closed", MEDIATION_TIMESTAMP_SUBSTITUTED] : ["mediation-fail-closed"],
        policyBackend: MEDIATION_BACKEND,
        evaluatedAt: new Date(request.timestampMs).toISOString(),
        durationMs: 0,
      },
    });
  }
}

export function createGuardedToolMediation(options: GuardedToolMediationOptions): GuardedToolMediation {
  return new DefaultGuardedToolMediation(options);
}

export function guardPolicyFromWorkContract(contract: WorkContract, overrides: Partial<GuardPolicyInput> = {}): GuardPolicy {
  const grantsWrite = contract.authority.grants.some((grant) => grant.action === "write");
  const writeRequiresHuman = contract.authority.requiresHumanApproval.includes("write");
  const derivedCategoryMode: Record<string, z.input<typeof PerToolGuardModeSchema>> = grantsWrite
    ? {
      write: {
        decision: writeRequiresHuman ? "prompt" : "allow",
        requireEvidence: false,
      },
    }
    : {};
  const derived: Omit<GuardPolicyInput, "workId"> = {
    // The ordinary contract (some grants, no explicit approval list) previously
    // derived to allow-everything, inverting the ADR's headline property. An
    // authority policy that has not spoken about a tool has not authorized it.
    defaultDecision: "prompt",
    denyByDefault: true,
    perToolMode: {},
    // Semantic category rules are derived from Work authority, but remain
    // dormant until a caller proves the execution boundary is contract-bound.
    perCategoryMode: derivedCategoryMode,
    contractBoundCategoryAuthority: false,
    forbiddenPatterns: contract.authority.grants
      .filter((g) => g.action === "execute" || g.action === "external-mutate")
      .flatMap((g) => g.constraints),
    circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
    backend: "rhiz-native",
    backendConfig: {},
  };
  return GuardPolicySchema.parse({
    ...derived,
    ...overrides,
    httpEffects: (overrides.httpEffects ?? []).map((binding) => ({
      ...binding,
      decision: contract.authority.requiresHumanApproval.includes(binding.action) ? "prompt"
        : contract.authority.grants.some((grant) => grant.action === binding.action && grant.constraints.length === 0 &&
            grant.resources.some((resource) => resource.uri === binding.resourceUri)) ? "allow" : "forbid",
    })),
    workId: contract.id,
  });
}

export function parseGuardRequest(input: unknown): GuardRequest {
  return GuardRequestSchema.parse(input);
}

export function parseGuardPolicy(input: unknown): GuardPolicy {
  return GuardPolicySchema.parse(input);
}

export function parseGuardVerdict(input: unknown): GuardVerdict {
  return GuardVerdictSchema.parse(input);
}

export function assertGuardVerdict(value: unknown): asserts value is GuardVerdict {
  const result = GuardVerdictSchema.safeParse(value);
  if (!result.success) {
    throw new GuardVerificationError(`GuardVerdict validation failed: ${result.error.message}`);
  }
}

export function parseWorkContractForGuard(input: unknown): WorkContract {
  return WorkContractSchema.parse(input);
}

export function matchForbiddenPattern(request: GuardRequest, patterns: readonly string[]): string | null {
  if (patterns.length === 0) return null;
  const haystack = JSON.stringify(request.tool.args);
  for (const pattern of patterns) {
    if (haystack.includes(pattern)) return pattern;
  }
  return null;
}

/**
 * Git convergence is an organizational effect. A worker may inspect and edit
 * its isolated workspace, but push/rebase/merge/shared-ref and PR mutations
 * must cross the Harness integration authority seam.
 */
export function matchHarnessOwnedGitOperation(request: GuardRequest): string | null {
  if (request.tool.category !== "shell" && request.tool.category !== "external-mutate") return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(request.tool.args);
  } catch {
    return null;
  }
  const git = serialized.match(/(?:^|[\s"';&|])(?:[A-Za-z]:)?(?:[\/\\][\w.@+-]+)*[\/\\]?git\b[\s\S]*?\b(push|merge|rebase|update-ref)\b/i);
  if (git !== null) return `git ${git[1]!.toLowerCase()}`;
  const gh = serialized.match(/(?:^|[\s"';&|])(?:[A-Za-z]:)?(?:[\/\\][\w.@+-]+)*[\/\\]?gh\s+pr\s+(create|merge|ready|close)(?=[\s"']|$)/i);
  return gh === null ? null : `gh pr ${gh[1]!.toLowerCase()}`;
}

export const DEFAULT_GUARD_BACKEND = "rhiz-native" as const;
