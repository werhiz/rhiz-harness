import { z } from "zod";

import {
  ContextTaskClassSchema,
  RuleInputSchema,
  type ContextTaskClass,
  type RuleInput,
} from "./context.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(8_000);

export const RuleSeveritySchema = z.enum(["hard", "strong", "preference"]);
export type RuleSeverity = z.infer<typeof RuleSeveritySchema>;

export const RuleBindingModeSchema = z.enum(["mechanized", "injected", "graded"]);
export type RuleBindingMode = z.infer<typeof RuleBindingModeSchema>;

function normalizeRepositoryPath(value: string): string {
  let normalized = value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized.length === 0) normalized = ".";
  return normalized;
}

function repositoryPathIssues(value: string): string[] {
  const issues: string[] = [];
  const trimmed = value.trim();
  if (trimmed.includes("\0")) issues.push("must not contain NUL");
  if (trimmed.includes("\\")) issues.push("must use forward slashes");
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    issues.push("must be repository-relative");
  }
  if (trimmed.includes("*") || trimmed.includes("?") || trimmed.includes("[") || trimmed.includes("]")) {
    issues.push("uses prefix semantics; glob metacharacters are not allowed");
  }
  const normalized = normalizeRepositoryPath(trimmed);
  if (normalized.split("/").some((segment) => segment === "..")) {
    issues.push("must not escape the repository with '..'");
  }
  return issues;
}

export const RulePathPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .superRefine((value, ctx) => {
    for (const issue of repositoryPathIssues(value)) {
      ctx.addIssue({ code: "custom", message: issue });
    }
  })
  .transform(normalizeRepositoryPath);
export type RulePathPrefix = z.infer<typeof RulePathPrefixSchema>;

export const HarnessRuleSchema = z
  .object({
    id,
    revision: z.number().int().positive().default(1),
    severity: RuleSeveritySchema,
    binding: RuleBindingModeSchema,
    text,
    taskClasses: z.array(ContextTaskClassSchema).default([]),
    pathPrefixes: z.array(RulePathPrefixSchema).default([]),
    evidenceRefs: z.array(id).default([]),
    guardId: id.optional(),
    source: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.binding === "mechanized" && rule.guardId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["guardId"],
        message: "mechanized rules require guardId",
      });
    }
    if (rule.binding !== "mechanized" && rule.guardId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["guardId"],
        message: "guardId is allowed only when binding=mechanized",
      });
    }
    if (
      rule.taskClasses.length === 0 &&
      rule.pathPrefixes.length === 0 &&
      rule.severity !== "hard"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["severity"],
        message: "a global rule must be severity=hard; narrower rules need taskClasses or pathPrefixes",
      });
    }
    if (new Set(rule.taskClasses).size !== rule.taskClasses.length) {
      ctx.addIssue({
        code: "custom",
        path: ["taskClasses"],
        message: "taskClasses must not contain duplicates",
      });
    }
    if (new Set(rule.pathPrefixes).size !== rule.pathPrefixes.length) {
      ctx.addIssue({
        code: "custom",
        path: ["pathPrefixes"],
        message: "pathPrefixes must not contain duplicates",
      });
    }
    if (new Set(rule.evidenceRefs).size !== rule.evidenceRefs.length) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "evidenceRefs must not contain duplicates",
      });
    }
  });
export type HarnessRule = z.infer<typeof HarnessRuleSchema>;

export const RuleCatalogSchema = z
  .object({
    schema: z.literal("rhiz-rule-catalog/v1"),
    id,
    revision: z.number().int().positive(),
    rules: z.array(HarnessRuleSchema).max(10_000),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < catalog.rules.length; index += 1) {
      const rule = catalog.rules[index];
      if (rule === undefined) continue;
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", index, "id"],
          message: `duplicate rule id ${rule.id}`,
        });
      }
      seen.add(rule.id);
    }
  });
export type RuleCatalog = z.infer<typeof RuleCatalogSchema>;

const RepositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .superRefine((value, ctx) => {
    for (const issue of repositoryPathIssues(value)) {
      ctx.addIssue({ code: "custom", message: issue });
    }
  })
  .transform(normalizeRepositoryPath);

export const RuleSelectionRequestSchema = z
  .object({
    taskClass: ContextTaskClassSchema,
    paths: z.array(RepositoryPathSchema).default([]),
    maxRules: z.number().int().positive().max(100).default(12),
    includeMechanized: z.boolean().default(false),
    /** Guard ids proven active in this execution environment. Unlisted guards are not trusted. */
    activeGuardIds: z.array(id).default([]),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (new Set(request.paths).size !== request.paths.length) {
      ctx.addIssue({ code: "custom", path: ["paths"], message: "paths must not contain duplicates" });
    }
    if (new Set(request.activeGuardIds).size !== request.activeGuardIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["activeGuardIds"],
        message: "activeGuardIds must not contain duplicates",
      });
    }
  });
export type RuleSelectionRequest = z.infer<typeof RuleSelectionRequestSchema>;

export const RuleMatchReasonSchema = z.enum(["global", "task-class", "path", "task-and-path"]);
export type RuleMatchReason = z.infer<typeof RuleMatchReasonSchema>;

export const SelectedRuleRefSchema = z
  .object({
    ruleId: id,
    revision: z.number().int().positive(),
    reason: RuleMatchReasonSchema,
  })
  .strict();
export type SelectedRuleRef = z.infer<typeof SelectedRuleRefSchema>;

export const RuleSelectionResultSchema = z
  .object({
    catalogId: id,
    catalogRevision: z.number().int().positive(),
    selected: z.array(SelectedRuleRefSchema),
    inputs: z.array(RuleInputSchema),
    mechanicallyBoundRuleIds: z.array(id),
    inactiveMechanizedRuleIds: z.array(id),
    omittedByLimitRuleIds: z.array(id),
  })
  .strict();
export type RuleSelectionResult = z.infer<typeof RuleSelectionResultSchema>;

function matchesPrefix(prefix: string, candidate: string): boolean {
  if (prefix === ".") return true;
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function appliesToTask(rule: HarnessRule, taskClass: ContextTaskClass): boolean {
  return rule.taskClasses.length === 0 || rule.taskClasses.includes(taskClass);
}

function appliesToPaths(rule: HarnessRule, paths: readonly string[]): boolean {
  if (rule.pathPrefixes.length === 0) return true;
  if (paths.length === 0) return false;
  return rule.pathPrefixes.some((prefix) => paths.some((candidate) => matchesPrefix(prefix, candidate)));
}

function matchReason(rule: HarnessRule): RuleMatchReason {
  const taskBound = rule.taskClasses.length > 0;
  const pathBound = rule.pathPrefixes.length > 0;
  if (taskBound && pathBound) return "task-and-path";
  if (taskBound) return "task-class";
  if (pathBound) return "path";
  return "global";
}

function severityRank(severity: RuleSeverity): number {
  switch (severity) {
    case "hard": return 3;
    case "strong": return 2;
    case "preference": return 1;
  }
}

function specificity(rule: HarnessRule): number {
  return Number(rule.taskClasses.length > 0) + Number(rule.pathPrefixes.length > 0);
}

/** Locale-independent UTF-16 code-unit ordering. Distinct strings never compare equal. */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareRules(left: HarnessRule, right: HarnessRule): number {
  const severity = severityRank(right.severity) - severityRank(left.severity);
  if (severity !== 0) return severity;
  const specific = specificity(right) - specificity(left);
  if (specific !== 0) return specific;
  const revision = right.revision - left.revision;
  if (revision !== 0) return revision;
  return compareIds(left.id, right.id);
}

export function parseRuleCatalog(input: unknown): RuleCatalog {
  return RuleCatalogSchema.parse(input);
}

export function parseRuleSelectionRequest(input: unknown): RuleSelectionRequest {
  return RuleSelectionRequestSchema.parse(input);
}

export function selectHarnessRules(
  catalogInput: RuleCatalog | unknown,
  requestInput: RuleSelectionRequest | unknown,
): RuleSelectionResult {
  const catalog = RuleCatalogSchema.parse(catalogInput);
  const request = RuleSelectionRequestSchema.parse(requestInput);
  const activeGuards = new Set(request.activeGuardIds);
  const applicable = catalog.rules
    .filter((rule) => appliesToTask(rule, request.taskClass) && appliesToPaths(rule, request.paths))
    .sort(compareRules);

  const mechanized = applicable.filter((rule) => rule.binding === "mechanized");
  const mechanicallyBound = mechanized.filter(
    (rule) => rule.guardId !== undefined && activeGuards.has(rule.guardId),
  );
  const inactiveMechanized = mechanized.filter(
    (rule) => rule.guardId === undefined || !activeGuards.has(rule.guardId),
  );

  // Fail closed: a rule is suppressed from Context only when the caller proves
  // its named guard is active in this execution environment. A stale/missing
  // guard therefore costs prompt tokens rather than silently dropping safety.
  const injectable = request.includeMechanized
    ? applicable
    : applicable.filter(
      (rule) => rule.binding !== "mechanized"
        || rule.guardId === undefined
        || !activeGuards.has(rule.guardId),
    );
  const selectedRules = injectable.slice(0, request.maxRules);
  const omittedByLimit = injectable.slice(request.maxRules);

  return RuleSelectionResultSchema.parse({
    catalogId: catalog.id,
    catalogRevision: catalog.revision,
    selected: selectedRules.map((rule) => ({
      ruleId: rule.id,
      revision: rule.revision,
      reason: matchReason(rule),
    })),
    inputs: selectedRules.map<RuleInput>((rule) => RuleInputSchema.parse({
      ruleId: rule.id,
      text: rule.text,
    })),
    mechanicallyBoundRuleIds: mechanicallyBound.map((rule) => rule.id).sort(compareIds),
    inactiveMechanizedRuleIds: inactiveMechanized.map((rule) => rule.id).sort(compareIds),
    omittedByLimitRuleIds: omittedByLimit.map((rule) => rule.id),
  });
}

export function ruleInputsForContext(
  catalog: RuleCatalog | unknown,
  request: RuleSelectionRequest | unknown,
): RuleInput[] {
  return selectHarnessRules(catalog, request).inputs;
}
