import { z } from "zod";
import type { WorkContract } from "./schemas.js";
import { WorkContractSchema } from "./schemas.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);
const path = z.string().trim().min(1).max(4096);
const uri = z.string().trim().min(1).max(2048);

export const ContextTaskClassSchema = z.enum(["scout", "ship", "review", "default"]);
export type ContextTaskClass = z.infer<typeof ContextTaskClassSchema>;

export const ContextStrategySchema = z.enum(["minimal", "balanced", "broad", "explicit"]);
export type ContextStrategy = z.infer<typeof ContextStrategySchema>;

const FragmentBaseSchema = z.object({
  marker: id,
  tokenEstimate: z.number().int().nonnegative(),
  source: text.max(200).optional(),
}).strict();

export const IncludedFileFragmentSchema = FragmentBaseSchema.extend({
  kind: z.literal("included-file"),
  path: path,
  content: z.string(),
}).strict();
export type IncludedFileFragment = z.infer<typeof IncludedFileFragmentSchema>;

export const SelectedSymbolFragmentSchema = FragmentBaseSchema.extend({
  kind: z.literal("selected-symbol"),
  file: path,
  name: text.max(500),
  range: z.object({ startLine: z.number().int().nonnegative(), endLine: z.number().int().nonnegative() }).strict(),
}).strict();
export type SelectedSymbolFragment = z.infer<typeof SelectedSymbolFragmentSchema>;

export const HistoryFragmentSchema = FragmentBaseSchema.extend({
  kind: z.literal("history"),
  eventCount: z.number().int().nonnegative(),
  lastOccurredAt: z.iso.datetime({ offset: true }),
  summary: z.string().default(""),
}).strict();
export type HistoryFragment = z.infer<typeof HistoryFragmentSchema>;

export const RuleFragmentSchema = FragmentBaseSchema.extend({
  kind: z.literal("rule"),
  ruleId: id,
  text: z.string().max(8000),
}).strict();
export type RuleFragment = z.infer<typeof RuleFragmentSchema>;

export const ArchitectureDocFragmentSchema = FragmentBaseSchema.extend({
  kind: z.literal("architecture-doc"),
  docUri: uri,
  content: z.string(),
}).strict();
export type ArchitectureDocFragment = z.infer<typeof ArchitectureDocFragmentSchema>;

export const SkillFragmentSchema = FragmentBaseSchema.extend({
  kind: z.literal("skill"),
  skillId: id,
  content: z.string(),
}).strict();
export type SkillFragment = z.infer<typeof SkillFragmentSchema>;

export const ContextFragmentSchema = z.discriminatedUnion("kind", [
  IncludedFileFragmentSchema,
  SelectedSymbolFragmentSchema,
  HistoryFragmentSchema,
  RuleFragmentSchema,
  ArchitectureDocFragmentSchema,
  SkillFragmentSchema,
]);
export type ContextFragment = z.infer<typeof ContextFragmentSchema>;

export const ContextPackSchema = z.object({
  id: id,
  workId: id,
  taskId: id,
  attemptId: id,
  strategy: ContextStrategySchema,
  taskClass: ContextTaskClassSchema,
  fragments: z.array(ContextFragmentSchema),
  totalTokens: z.number().int().nonnegative(),
  composedAt: z.iso.datetime({ offset: true }),
  markers: z.array(id),
}).strict().superRefine((value, ctx) => {
  if (value.totalTokens !== value.fragments.reduce((sum, fragment) => sum + fragment.tokenEstimate, 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["totalTokens"],
      message: "totalTokens must equal the sum of fragment tokenEstimates",
    });
  }
  if (value.markers.length !== value.fragments.length) {
    ctx.addIssue({
      code: "custom",
      path: ["markers"],
      message: "markers must have one entry per fragment",
    });
  }
  if (new Set(value.markers).size !== value.markers.length) {
    ctx.addIssue({
      code: "custom",
      path: ["markers"],
      message: "fragment markers must be unique",
    });
  }
  for (let i = 0; i < value.fragments.length; i += 1) {
    const fragment = value.fragments[i];
    const marker = value.markers[i];
    if (fragment && marker && fragment.marker !== marker) {
      ctx.addIssue({
        code: "custom",
        path: ["markers", i],
        message: `markers[${i}]=${marker} does not match fragments[${i}].marker=${fragment.marker}`,
      });
    }
  }
});
export type ContextPack = z.infer<typeof ContextPackSchema>;
export type ContextPackInput = z.input<typeof ContextPackSchema>;

/** Render the exact selected fragments as bounded data for a worker prompt. */
export function renderContextPackForWorker(pack: ContextPack): string {
  return JSON.stringify({
    id: pack.id,
    workId: pack.workId,
    taskId: pack.taskId,
    attemptId: pack.attemptId,
    strategy: pack.strategy,
    taskClass: pack.taskClass,
    fragments: pack.fragments,
    markers: pack.markers,
  }, null, 2);
}

export const ClearToolUsesEditSchema = z.object({
  kind: z.literal("clear-tool-uses"),
  keepRecent: z.number().int().nonnegative().default(0),
  minTokens: z.number().int().nonnegative().default(0),
}).strict();
export type ClearToolUsesEdit = z.infer<typeof ClearToolUsesEditSchema>;

export const DropFragmentEditSchema = z.object({
  kind: z.literal("drop-fragment"),
  marker: id,
}).strict();
export type DropFragmentEdit = z.infer<typeof DropFragmentEditSchema>;

export const ReplaceFragmentEditSchema = z.object({
  kind: z.literal("replace-fragment"),
  marker: id,
  replacement: ContextFragmentSchema,
}).strict();
export type ReplaceFragmentEdit = z.infer<typeof ReplaceFragmentEditSchema>;

export const ContextEditSchema = z.discriminatedUnion("kind", [
  ClearToolUsesEditSchema,
  DropFragmentEditSchema,
  ReplaceFragmentEditSchema,
]);
export type ContextEdit = z.infer<typeof ContextEditSchema>;

export const ContextTokenBudgetSchema = z.object({
  includedFile: z.number().int().nonnegative().default(40_000),
  selectedSymbol: z.number().int().nonnegative().default(20_000),
  history: z.number().int().nonnegative().default(10_000),
  rule: z.number().int().nonnegative().default(8_000),
  architectureDoc: z.number().int().nonnegative().default(15_000),
  skill: z.number().int().nonnegative().default(8_000),
  total: z.number().int().positive().default(60_000),
}).strict();
export type ContextTokenBudget = z.infer<typeof ContextTokenBudgetSchema>;

export const ContextConfigSchema = z.object({
  strategy: ContextStrategySchema.default("minimal"),
  tokenBudget: ContextTokenBudgetSchema.default(() => ({
    includedFile: 40_000,
    selectedSymbol: 20_000,
    history: 10_000,
    rule: 8_000,
    architectureDoc: 15_000,
    skill: 8_000,
    total: 60_000,
  })),
  markerPrefix: z.string().trim().min(1).max(20).default("ctx"),
  maxHistoryEvents: z.number().int().nonnegative().default(50),
  perFileHardCap: z.number().int().positive().default(8_000),
  perRuleHardCap: z.number().int().positive().default(2_000),
  perArchitectureDocHardCap: z.number().int().positive().default(4_000),
  perSkillHardCap: z.number().int().positive().default(2_000),
}).strict();
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = Object.freeze({
  strategy: "minimal",
  tokenBudget: Object.freeze({
    includedFile: 40_000,
    selectedSymbol: 20_000,
    history: 10_000,
    rule: 8_000,
    architectureDoc: 15_000,
    skill: 8_000,
    total: 60_000,
  }),
  markerPrefix: "ctx",
  maxHistoryEvents: 50,
  perFileHardCap: 8_000,
  perRuleHardCap: 2_000,
  perArchitectureDocHardCap: 4_000,
  perSkillHardCap: 2_000,
});

export const SelectedSymbolInputSchema = z.object({
  file: path,
  name: text.max(500),
  range: z.object({ startLine: z.number().int().nonnegative(), endLine: z.number().int().nonnegative() }).strict(),
}).strict();
export type SelectedSymbolInput = z.infer<typeof SelectedSymbolInputSchema>;

export const RuleInputSchema = z.object({
  ruleId: id,
  text: z.string().max(8000),
}).strict();
export type RuleInput = z.infer<typeof RuleInputSchema>;

export const ArchitectureDocInputSchema = z.object({
  docUri: uri,
  content: z.string(),
}).strict();
export type ArchitectureDocInput = z.infer<typeof ArchitectureDocInputSchema>;

export const SkillInputSchema = z.object({
  skillId: id,
  content: z.string(),
}).strict();
export type SkillInput = z.infer<typeof SkillInputSchema>;

export const HistoryEventSummaryInputSchema = z.object({
  id: id,
  occurredAt: z.iso.datetime({ offset: true }),
  type: text.max(100),
  summary: z.string().default(""),
}).strict();
export type HistoryEventSummaryInput = z.infer<typeof HistoryEventSummaryInputSchema>;

export const ContextCompositionOptionsSchema = z.object({
  fileContents: z.record(path, z.string()).default({}),
  selectedSymbols: z.array(SelectedSymbolInputSchema).default([]),
  historyEvents: z.array(HistoryEventSummaryInputSchema).default([]),
  rules: z.array(RuleInputSchema).default([]),
  architectureDocs: z.array(ArchitectureDocInputSchema).default([]),
  skills: z.array(SkillInputSchema).default([]),
}).strict();
export type ContextCompositionOptions = z.infer<typeof ContextCompositionOptionsSchema>;

export const ContextBudgetBreakdownSchema = z.object({
  byKind: z.record(z.string(), z.number().int().nonnegative()),
  total: z.number().int().nonnegative(),
  perKindBudget: z.record(z.string(), z.number().int().nonnegative()),
  totalBudget: z.number().int().nonnegative(),
  withinBudget: z.boolean(),
  overBudgetKinds: z.array(z.string()),
}).strict();
export type ContextBudgetBreakdown = z.infer<typeof ContextBudgetBreakdownSchema>;

export class ContextError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ContextError";
  }
}

export class ContextConfigurationError extends ContextError {
  constructor(message: string) {
    super(message, "CONTEXT_CONFIGURATION_ERROR");
    this.name = "ContextConfigurationError";
  }
}

export class ContextBudgetExceededError extends ContextError {
  constructor(message: string, readonly breakdown: ContextBudgetBreakdown) {
    super(message, "CONTEXT_BUDGET_EXCEEDED");
    this.name = "ContextBudgetExceededError";
  }
}

export class ContextValidationError extends ContextError {
  constructor(message: string) {
    super(message, "CONTEXT_VALIDATION_ERROR");
    this.name = "ContextValidationError";
  }
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function classifyTaskClass(contract: WorkContract): ContextTaskClass {
  if (contract.type === "SCOUT") return "scout";
  if (contract.type === "REVIEW") return "review";
  if (contract.type === "SHIP") return "ship";
  return "default";
}

export function defaultStrategyForTaskClass(taskClass: ContextTaskClass): ContextStrategy {
  switch (taskClass) {
    case "scout":
      return "broad";
    case "review":
      return "balanced";
    case "ship":
      return "minimal";
    case "default":
    default:
      return "balanced";
  }
}

export function markerFor(kind: string, counter: number, prefix: string = "ctx"): string {
  return `${prefix}:${kind}:${counter}`;
}

export function findFragmentByMarker(pack: ContextPack, marker: string): ContextFragment | null {
  for (const fragment of pack.fragments) {
    if (fragment.marker === marker) return fragment;
  }
  return null;
}

export function indexOfMarker(pack: ContextPack, marker: string): number {
  for (let i = 0; i < pack.fragments.length; i += 1) {
    if (pack.fragments[i]?.marker === marker) return i;
  }
  return -1;
}

export function selectFilesByStrategy(
  fileContents: Readonly<Record<string, string>>,
  strategy: ContextStrategy,
  hardCap: number,
): IncludedFileFragment[] {
  const paths = Object.keys(fileContents).sort();
  const chosen: IncludedFileFragment[] = [];
  if (strategy === "minimal") {
    if (paths[0] !== undefined) {
      const content = fileContents[paths[0]] ?? "";
      chosen.push({
        kind: "included-file",
        marker: markerFor("included-file", 0),
        tokenEstimate: Math.min(estimateTokens(content), hardCap),
        path: paths[0],
        content: content.slice(0, hardCap * 4),
      });
    }
    return chosen;
  }
  if (strategy === "balanced") {
    const limit = Math.min(paths.length, 4);
    for (let i = 0; i < limit; i += 1) {
      const p = paths[i];
      if (p === undefined) continue;
      const content = fileContents[p] ?? "";
      chosen.push({
        kind: "included-file",
        marker: markerFor("included-file", i),
        tokenEstimate: Math.min(estimateTokens(content), hardCap),
        path: p,
        content: content.slice(0, hardCap * 4),
      });
    }
    return chosen;
  }
  if (strategy === "broad" || strategy === "explicit") {
    for (let i = 0; i < paths.length; i += 1) {
      const p = paths[i];
      if (p === undefined) continue;
      const content = fileContents[p] ?? "";
      chosen.push({
        kind: "included-file",
        marker: markerFor("included-file", i),
        tokenEstimate: Math.min(estimateTokens(content), hardCap),
        path: p,
        content: content.slice(0, hardCap * 4),
      });
    }
  }
  return chosen;
}

export function selectSymbols(
  selected: ReadonlyArray<SelectedSymbolInput>,
  strategy: ContextStrategy,
  hardCap: number,
): SelectedSymbolFragment[] {
  const out: SelectedSymbolFragment[] = [];
  const limit = strategy === "minimal" ? 0 : strategy === "balanced" ? Math.min(selected.length, 8) : selected.length;
  for (let i = 0; i < limit; i += 1) {
    const symbol = selected[i];
    if (symbol === undefined) continue;
    const tokenEstimate = Math.min(hardCap, Math.max(1, symbol.range.endLine - symbol.range.startLine));
    out.push({
      kind: "selected-symbol",
      marker: markerFor("selected-symbol", i),
      tokenEstimate,
      file: symbol.file,
      name: symbol.name,
      range: { startLine: symbol.range.startLine, endLine: symbol.range.endLine },
    });
  }
  return out;
}

export function selectHistory(
  events: ReadonlyArray<HistoryEventSummaryInput>,
  strategy: ContextStrategy,
  hardCap: number,
  maxEvents: number,
): HistoryFragment[] {
  if (strategy === "minimal" || events.length === 0) return [];
  const limit = strategy === "balanced" ? Math.min(events.length, 10) : Math.min(events.length, maxEvents);
  const trimmed = events.slice(0, limit);
  const summary = trimmed.map((event) => `${event.type}@${event.id}`).join("; ");
  const lastOccurredAt = trimmed[trimmed.length - 1]?.occurredAt ?? new Date().toISOString();
  return [{
    kind: "history",
    marker: markerFor("history", 0),
    tokenEstimate: Math.min(hardCap, estimateTokens(summary)),
    eventCount: trimmed.length,
    lastOccurredAt,
    summary,
  }];
}

export function selectRules(
  rules: ReadonlyArray<RuleInput>,
  strategy: ContextStrategy,
  hardCap: number,
): RuleFragment[] {
  const out: RuleFragment[] = [];
  const limit = strategy === "minimal" ? Math.min(rules.length, 3) : strategy === "balanced" ? Math.min(rules.length, 6) : rules.length;
  for (let i = 0; i < limit; i += 1) {
    const rule = rules[i];
    if (rule === undefined) continue;
    out.push({
      kind: "rule",
      marker: markerFor("rule", i),
      tokenEstimate: Math.min(hardCap, estimateTokens(rule.text)),
      ruleId: rule.ruleId,
      text: rule.text.slice(0, hardCap * 4),
    });
  }
  return out;
}

export function selectArchitectureDocs(
  docs: ReadonlyArray<ArchitectureDocInput>,
  strategy: ContextStrategy,
  hardCap: number,
): ArchitectureDocFragment[] {
  const out: ArchitectureDocFragment[] = [];
  const limit = strategy === "minimal" ? 0 : strategy === "balanced" ? Math.min(docs.length, 2) : docs.length;
  for (let i = 0; i < limit; i += 1) {
    const doc = docs[i];
    if (doc === undefined) continue;
    out.push({
      kind: "architecture-doc",
      marker: markerFor("architecture-doc", i),
      tokenEstimate: Math.min(hardCap, estimateTokens(doc.content)),
      docUri: doc.docUri,
      content: doc.content.slice(0, hardCap * 4),
    });
  }
  return out;
}

export function selectSkills(
  skills: ReadonlyArray<SkillInput>,
  strategy: ContextStrategy,
  hardCap: number,
): SkillFragment[] {
  const out: SkillFragment[] = [];
  const limit = strategy === "minimal" ? 0 : strategy === "balanced" ? Math.min(skills.length, 2) : skills.length;
  for (let i = 0; i < limit; i += 1) {
    const skill = skills[i];
    if (skill === undefined) continue;
    out.push({
      kind: "skill",
      marker: markerFor("skill", i),
      tokenEstimate: Math.min(hardCap, estimateTokens(skill.content)),
      skillId: skill.skillId,
      content: skill.content.slice(0, hardCap * 4),
    });
  }
  return out;
}

export function composeContextPack(
  workContract: WorkContract,
  taskId: string,
  attemptId: string,
  options: ContextCompositionOptions,
  config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
  now: () => Date = () => new Date(),
): ContextPack {
  const parsed = WorkContractSchema.parse(workContract);
  const strategy = config.strategy;
  const taskClass = classifyTaskClass(parsed);
  const fragments: ContextFragment[] = [
    ...selectFilesByStrategy(options.fileContents, strategy, config.perFileHardCap),
    ...selectSymbols(options.selectedSymbols, strategy, config.tokenBudget.selectedSymbol),
    ...selectHistory(options.historyEvents, strategy, config.tokenBudget.history, config.maxHistoryEvents),
    ...selectRules(options.rules, strategy, config.perRuleHardCap),
    ...selectArchitectureDocs(options.architectureDocs, strategy, config.perArchitectureDocHardCap),
    ...selectSkills(options.skills, strategy, config.perSkillHardCap),
  ];
  const markers = fragments.map((fragment) => fragment.marker);
  const totalTokens = fragments.reduce((sum, fragment) => sum + fragment.tokenEstimate, 0);
  return ContextPackSchema.parse({
    id: `pack:${parsed.id}:${attemptId}`,
    workId: parsed.id,
    taskId,
    attemptId,
    strategy,
    taskClass,
    fragments,
    totalTokens,
    composedAt: now().toISOString(),
    markers,
  });
}

export function applyContextEdit(
  pack: ContextPack,
  edit: ContextEdit,
  now: () => Date = () => new Date(),
): ContextPack {
  if (edit.kind === "clear-tool-uses") {
    let keptFragments = pack.fragments;
    let droppedTokens = 0;
    const toolUseFragmentIndices: number[] = [];
    for (let i = 0; i < pack.fragments.length; i += 1) {
      const fragment = pack.fragments[i];
      if (fragment === undefined) continue;
      const isToolUse = fragment.kind === "selected-symbol" || fragment.kind === "skill" || (fragment.kind === "included-file");
      if (isToolUse) toolUseFragmentIndices.push(i);
    }
    const droppable = Math.max(0, toolUseFragmentIndices.length - edit.keepRecent);
    const droppedIndices = new Set<number>(toolUseFragmentIndices.slice(0, droppable));
    keptFragments = pack.fragments.filter((_, i) => !droppedIndices.has(i));
    droppedTokens = pack.fragments
      .filter((_, i) => droppedIndices.has(i))
      .reduce((sum, fragment) => sum + fragment.tokenEstimate, 0);
    const totalTokens = Math.max(0, pack.totalTokens - droppedTokens);
    return ContextPackSchema.parse({
      id: pack.id,
      workId: pack.workId,
      taskId: pack.taskId,
      attemptId: pack.attemptId,
      strategy: pack.strategy,
      taskClass: pack.taskClass,
      fragments: keptFragments,
      totalTokens,
      composedAt: now().toISOString(),
      markers: keptFragments.map((fragment) => fragment.marker),
    });
  }
  if (edit.kind === "drop-fragment") {
    const idx = indexOfMarker(pack, edit.marker);
    if (idx === -1) {
      throw new ContextValidationError(`fragment with marker=${edit.marker} not found in pack ${pack.id}`);
    }
    const removed = pack.fragments[idx];
    if (removed === undefined) {
      throw new ContextValidationError(`fragment at index ${idx} unexpectedly undefined in pack ${pack.id}`);
    }
    const fragments = pack.fragments.filter((_, i) => i !== idx);
    const totalTokens = Math.max(0, pack.totalTokens - removed.tokenEstimate);
    return ContextPackSchema.parse({
      id: pack.id,
      workId: pack.workId,
      taskId: pack.taskId,
      attemptId: pack.attemptId,
      strategy: pack.strategy,
      taskClass: pack.taskClass,
      fragments,
      totalTokens,
      composedAt: now().toISOString(),
      markers: fragments.map((fragment) => fragment.marker),
    });
  }
  const idx = indexOfMarker(pack, edit.marker);
  if (idx === -1) {
    throw new ContextValidationError(`fragment with marker=${edit.marker} not found in pack ${pack.id}`);
  }
  const fragments = pack.fragments.map((fragment, i) => (i === idx ? edit.replacement : fragment));
  const totalTokens = fragments.reduce((sum, fragment) => sum + fragment.tokenEstimate, 0);
  return ContextPackSchema.parse({
    id: pack.id,
    workId: pack.workId,
    taskId: pack.taskId,
    attemptId: pack.attemptId,
    strategy: pack.strategy,
    taskClass: pack.taskClass,
    fragments,
    totalTokens,
    composedAt: now().toISOString(),
    markers: fragments.map((fragment) => fragment.marker),
  });
}

export function validateContextBudget(pack: ContextPack, config: ContextConfig = DEFAULT_CONTEXT_CONFIG): ContextBudgetBreakdown {
  const byKind: Record<string, number> = {};
  for (const fragment of pack.fragments) {
    byKind[fragment.kind] = (byKind[fragment.kind] ?? 0) + fragment.tokenEstimate;
  }
  const perKindBudget: Record<string, number> = {
    "included-file": config.tokenBudget.includedFile,
    "selected-symbol": config.tokenBudget.selectedSymbol,
    history: config.tokenBudget.history,
    rule: config.tokenBudget.rule,
    "architecture-doc": config.tokenBudget.architectureDoc,
    skill: config.tokenBudget.skill,
  };
  const overBudgetKinds: string[] = [];
  for (const [kind, used] of Object.entries(byKind)) {
    const limit = perKindBudget[kind];
    if (limit !== undefined && used > limit) {
      overBudgetKinds.push(kind);
    }
  }
  return ContextBudgetBreakdownSchema.parse({
    byKind,
    total: pack.totalTokens,
    perKindBudget,
    totalBudget: config.tokenBudget.total,
    withinBudget: overBudgetKinds.length === 0 && pack.totalTokens <= config.tokenBudget.total,
    overBudgetKinds,
  });
}

export function assertContextPack(value: unknown): asserts value is ContextPack {
  const parsed = ContextPackSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContextValidationError(`ContextPack validation failed: ${parsed.error.message}`);
  }
}

export function parseContextPack(input: unknown): ContextPack {
  return ContextPackSchema.parse(input);
}

export function parseContextCompositionOptions(input: unknown): ContextCompositionOptions {
  return ContextCompositionOptionsSchema.parse(input);
}

export function parseContextEdit(input: unknown): ContextEdit {
  return ContextEditSchema.parse(input);
}

export function parseContextConfig(input: unknown): ContextConfig {
  return ContextConfigSchema.parse(input);
}
