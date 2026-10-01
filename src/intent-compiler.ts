import { createHash } from "node:crypto";
import { z } from "zod";
import { AuthorityActionSchema } from "./schemas.js";
import { estimateTokens, ContextStrategySchema, ContextTaskClassSchema, defaultStrategyForTaskClass, type ContextTaskClass } from "./context.js";

/**
 * A small deterministic compiler between human intent and model execution.
 *
 * It does not decide authority, execute tools, or claim semantic truth. It
 * turns already-known facts into a bounded execution specification so workers
 * spend context and reasoning on unresolved work rather than rediscovering
 * routing facts on every turn. The objective is opaque: semantic resolution
 * supplies explicit typed facts before this compiler can mark them resolved.
 */

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);
const objectiveText = z.string().min(1).max(20_000).refine(
  (value) => value.trim().length > 0,
  "objective must contain non-whitespace text",
);

export const IntentActionSchema = z.enum([
  "answer", "inspect", "modify", "execute", "external-action", "monitor", "review", "research",
]);
export type IntentAction = z.infer<typeof IntentActionSchema>;

export const IntentAmbiguitySchema = z.enum([
  "none", "resolvable-from-context", "requires-retrieval", "requires-user",
]);
export type IntentAmbiguity = z.infer<typeof IntentAmbiguitySchema>;

// Requests are advisory data. Only WorkContract + Guard grant authority.
const RequestedActionsSchema = z.array(AuthorityActionSchema)
  .transform((actions) => [...new Set(actions)].sort());

export const IntentProofSchema = z.enum([
  "none", "explanation", "test", "receipt", "external-verification",
]);
export type IntentProof = z.infer<typeof IntentProofSchema>;

export const IntentAtomSchema = z.object({
  id,
  source: z.enum(["deterministic", "cached", "semantic-judgment", "human"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1).optional(),
  evidenceRefs: z.array(text.max(2048)).default([]),
}).strict();
export type IntentAtom = z.infer<typeof IntentAtomSchema>;

const IntentAtomsSchema = z.array(IntentAtomSchema).refine(
  (atoms) => new Set(atoms.map((atom) => atom.id)).size === atoms.length,
  "atom IDs must be unique",
);

function unresolvedIds(atoms: readonly IntentAtom[]): string[] {
  return atoms
    .filter((atom) => atom.value === null || (atom.confidence !== undefined && atom.confidence < 0.5))
    .map((atom) => atom.id)
    .sort();
}

function hasExternalCapability(actions: readonly z.infer<typeof AuthorityActionSchema>[]): boolean {
  return actions.some(value => ["approve", "publish", "spend", "external-mutate"].includes(value));
}

function hasDisjointContextMarkers(value: { requiredContextMarkers: string[]; optionalContextMarkers: string[] }): boolean {
  const required = new Set(value.requiredContextMarkers);
  return value.optionalContextMarkers.every(marker => !required.has(marker));
}

export const IntentCompileRequestSchema = z.object({
  workId: id,
  taskId: id,
  objective: objectiveText,
  taskClass: ContextTaskClassSchema.optional(),
  action: IntentActionSchema.optional(),
  ambiguity: IntentAmbiguitySchema.optional(),
  requestedActions: RequestedActionsSchema.optional(),
  proof: IntentProofSchema.optional(),
  contextStrategy: ContextStrategySchema.optional(),
  atoms: IntentAtomsSchema.default([]),
  requiredContextMarkers: z.array(id).default([]),
  optionalContextMarkers: z.array(id).default([]),
  /** Ceiling in the existing Context module's estimated-token units. */
  maxContextTokens: z.number().int().positive().default(8_000),
}).strict().refine(hasDisjointContextMarkers, {
  path: ["optionalContextMarkers"], message: "required and optional context markers must be disjoint",
});
export type IntentCompileRequest = z.input<typeof IntentCompileRequestSchema>;

export const IntentExecutionSpecSchema = z.object({
  schema: z.literal("rhiz-harness/intent-execution-spec/v0"),
  workId: id,
  taskId: id,
  objective: objectiveText,
  taskClass: ContextTaskClassSchema,
  action: IntentActionSchema.nullable(),
  ambiguity: IntentAmbiguitySchema,
  requestedActions: RequestedActionsSchema,
  /** Minimum category for the primary action; WorkContract owns full acceptance criteria. */
  proof: IntentProofSchema.nullable(),
  contextStrategy: ContextStrategySchema,
  atoms: IntentAtomsSchema,
  requiredContextMarkers: z.array(id),
  optionalContextMarkers: z.array(id),
  maxContextTokens: z.number().int().positive(),
  unresolvedAtomIds: z.array(id),
  /** Integrity of the canonical compiled payload, not an authority attestation. */
  specHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((spec, ctx) => {
  if (!hasDisjointContextMarkers(spec)) {
    ctx.addIssue({ code: "custom", path: ["optionalContextMarkers"], message: "required and optional context markers must be disjoint" });
  }
  if (spec.ambiguity === "none" && (spec.action === null || spec.requestedActions.length === 0
      || spec.proof === null || spec.unresolvedAtomIds.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["ambiguity"], message: "incomplete intent facts must remain unresolved" });
  }
  if (spec.ambiguity === "none" && spec.action !== null && spec.proof !== null && spec.requestedActions.length > 0) {
    const hasExternal = hasExternalCapability(spec.requestedActions);
    // Capabilities may support secondary operations without changing the task's
    // purpose: a review can execute a verifier, and execution can write output.
    const actionMatches = spec.action === "external-action" ? hasExternal
      : spec.requestedActions.includes(spec.action === "modify" ? "write" : spec.action === "execute" ? "execute" : "read");
    const minimumProof = inferProof(spec.action);
    const proofMatches = (minimumProof === "none" || spec.proof === minimumProof || spec.proof === "external-verification")
      && (!hasExternal || spec.proof === "receipt" || spec.proof === "external-verification");
    if (!actionMatches || spec.taskClass !== inferTaskClass(spec.action) || !proofMatches) {
      ctx.addIssue({ code: "custom", path: ["ambiguity"], message: "resolved specifications require coherent intent facts: action, effects, task class, and minimum proof" });
    }
  }
  if (JSON.stringify(spec.unresolvedAtomIds) !== JSON.stringify(unresolvedIds(spec.atoms))) {
    ctx.addIssue({ code: "custom", path: ["unresolvedAtomIds"], message: "unresolved atom IDs must exactly match the atoms" });
  }
  const { specHash, ...payload } = spec;
  if (specHash !== stableHash(payload)) {
    ctx.addIssue({ code: "custom", path: ["specHash"], message: "specification hash must match the compiled payload" });
  }
});
export type IntentExecutionSpec = z.infer<typeof IntentExecutionSpecSchema>;

function inferTaskClass(action: IntentAction | null): ContextTaskClass {
  if (action === "review") return "review";
  if (action === "research" || action === "inspect") return "scout";
  if (action === "modify" || action === "execute" || action === "external-action") return "ship";
  return "default";
}

function inferProof(action: IntentAction | null): IntentProof | null {
  if (action === null) return null;
  if (action === "modify" || action === "execute") return "test";
  if (action === "external-action") return "receipt";
  if (action === "review") return "explanation";
  return "none";
}

function stableHash(value: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function compileIntent(input: IntentCompileRequest): IntentExecutionSpec {
  const parsed = IntentCompileRequestSchema.parse(input);
  const action = parsed.action ?? null;
  const taskClass = parsed.taskClass ?? inferTaskClass(action);
  const requestedActions = parsed.requestedActions ?? [];
  const proof = parsed.proof ?? (action !== null && action !== "external-action" && hasExternalCapability(requestedActions)
    ? "external-verification" : inferProof(action));
  const contextStrategy = parsed.contextStrategy ?? defaultStrategyForTaskClass(taskClass);
  const unresolvedAtomIds = unresolvedIds(parsed.atoms);
  const incomplete = action === null || requestedActions.length === 0 || proof === null || unresolvedAtomIds.length > 0;
  const ambiguity = parsed.ambiguity ?? (incomplete ? "requires-retrieval" : "none");

  const payload = {
    schema: "rhiz-harness/intent-execution-spec/v0",
    workId: parsed.workId,
    taskId: parsed.taskId,
    objective: parsed.objective,
    taskClass,
    action,
    ambiguity,
    requestedActions,
    proof,
    contextStrategy,
    atoms: [...parsed.atoms].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    requiredContextMarkers: [...new Set(parsed.requiredContextMarkers)].sort(),
    optionalContextMarkers: [...new Set(parsed.optionalContextMarkers)].sort(),
    maxContextTokens: parsed.maxContextTokens,
    unresolvedAtomIds,
  };
  const spec = IntentExecutionSpecSchema.parse({ ...payload, specHash: stableHash(payload) });
  serializeWithinContextBudget(spec);
  return spec;
}

function serializeWithinContextBudget(spec: IntentExecutionSpec): string {
  const rendered = JSON.stringify(spec, null, 2);
  const estimatedTokens = estimateTokens(rendered);
  if (estimatedTokens > spec.maxContextTokens) {
    throw new RangeError(`Intent context budget exceeded: ${estimatedTokens} estimated tokens > ${spec.maxContextTokens}`);
  }
  return rendered;
}

/**
 * Render data within Context's estimated-token ceiling. The estimate is not
 * a provider tokenizer measurement, and compiled fields never grant authority.
 * Null action/proof or empty requestedActions means unresolved, not permission
 * to do nothing or waive proof. Consumers must resolve facts before execution.
 */
export function renderIntentForWorker(spec: IntentExecutionSpec): string {
  return serializeWithinContextBudget(IntentExecutionSpecSchema.parse(spec));
}
