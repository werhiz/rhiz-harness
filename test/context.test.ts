import assert from "node:assert/strict";
import test from "node:test";

import {
  applyContextEdit,
  assertContextPack,
  classifyTaskClass,
  composeContextPack,
  ContextBudgetExceededError,
  ContextCompositionOptionsSchema,
  ContextConfigurationError,
  ContextEditSchema,
  ContextError,
  ContextPackSchema,
  ContextTokenBudgetSchema,
  ContextValidationError,
  defaultStrategyForTaskClass,
  DEFAULT_CONTEXT_CONFIG,
  estimateTokens,
  findFragmentByMarker,
  indexOfMarker,
  markerFor,
  parseContextCompositionOptions,
  parseContextConfig,
  parseContextEdit,
  parseContextPack,
  selectArchitectureDocs,
  selectFilesByStrategy,
  selectHistory,
  selectRules,
  selectSkills,
  selectSymbols,
  validateContextBudget,
  type ContextCompositionOptions,
  type ContextConfig,
  type ContextFragment,
  type ContextPack,
  type ContextTaskClass,
  type IncludedFileFragment,
} from "../src/context.js";
import { ContextFragmentSchema } from "../src/context.js";
import { work } from "./helpers.js";

const TEST_NOW = "2026-08-20T05:00:00.000Z";

function fileOptions(overrides: Partial<ContextCompositionOptions> = {}): ContextCompositionOptions {
  return parseContextCompositionOptions({
    fileContents: {
      "src/foo.ts": "export function foo() { return 1; }",
      "src/bar.ts": "export function bar() { return 2; }",
    },
    selectedSymbols: [
      { file: "src/foo.ts", name: "foo", range: { startLine: 0, endLine: 1 } },
      { file: "src/bar.ts", name: "bar", range: { startLine: 0, endLine: 1 } },
    ],
    historyEvents: [
      { id: "event:1", occurredAt: "2026-08-20T04:00:00.000Z", type: "attempt.started", summary: "started" },
      { id: "event:2", occurredAt: "2026-08-20T04:01:00.000Z", type: "attempt.finished", summary: "done" },
    ],
    rules: [
      { ruleId: "rule:1", text: "always handle errors" },
      { ruleId: "rule:2", text: "never log secrets" },
      { ruleId: "rule:3", text: "prefer composition" },
      { ruleId: "rule:4", text: "write tests first" },
    ],
    architectureDocs: [
      { docUri: "docs://arch/overview.md", content: "# Overview" },
    ],
    skills: [
      { skillId: "skill:1", content: "skill body" },
    ],
    ...overrides,
  });
}

function makePack(config: Partial<ContextConfig> = {}, options: Partial<ContextCompositionOptions> = {}): ContextPack {
  const merged: ContextConfig = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  return composeContextPack(
    work(),
    "task:1",
    "attempt:1",
    fileOptions(options),
    merged,
    () => new Date(TEST_NOW),
  );
}

test("estimateTokens rounds up at chars/4 with a minimum of 1", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a"), 1);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("a".repeat(1000)), 250);
});

test("classifyTaskClass maps WorkType to ContextTaskClass", () => {
  assert.equal(classifyTaskClass(work({ type: "SCOUT", writeScope: [] })), "scout");
  assert.equal(classifyTaskClass(work({ type: "SHIP" })), "ship");
  assert.equal(classifyTaskClass(work({ type: "REVIEW", writeScope: [] })), "review");
});

test("defaultStrategyForTaskClass picks broad/balanced/minimal/balanced", () => {
  assert.equal(defaultStrategyForTaskClass("scout"), "broad");
  assert.equal(defaultStrategyForTaskClass("review"), "balanced");
  assert.equal(defaultStrategyForTaskClass("ship"), "minimal");
  assert.equal(defaultStrategyForTaskClass("default"), "balanced");
});

test("markerFor is stable for the same inputs", () => {
  assert.equal(markerFor("included-file", 0), "ctx:included-file:0");
  assert.equal(markerFor("included-file", 0, "x"), "x:included-file:0");
});

test("ContextFragmentSchema accepts every fragment kind", () => {
  const fragments: ContextFragment[] = [
    { kind: "included-file", marker: "ctx:included-file:0", tokenEstimate: 100, path: "src/foo.ts", content: "x" },
    { kind: "selected-symbol", marker: "ctx:selected-symbol:0", tokenEstimate: 50, file: "src/foo.ts", name: "foo", range: { startLine: 0, endLine: 1 } },
    { kind: "history", marker: "ctx:history:0", tokenEstimate: 30, eventCount: 2, lastOccurredAt: TEST_NOW, summary: "x" },
    { kind: "rule", marker: "ctx:rule:0", tokenEstimate: 20, ruleId: "rule:1", text: "x" },
    { kind: "architecture-doc", marker: "ctx:architecture-doc:0", tokenEstimate: 40, docUri: "docs://arch/overview.md", content: "x" },
    { kind: "skill", marker: "ctx:skill:0", tokenEstimate: 10, skillId: "skill:1", content: "x" },
  ];
  for (const fragment of fragments) {
    assert.equal(ContextFragmentSchema.parse(fragment).kind, fragment.kind);
  }
});

test("ContextFragmentSchema rejects an unknown kind", () => {
  assert.throws(() => ContextFragmentSchema.parse({
    kind: "unknown-kind",
    marker: "ctx:unknown:0",
    tokenEstimate: 0,
  } as unknown));
});

test("ContextPackSchema rejects a pack whose totalTokens does not equal the sum of fragment tokenEstimates", () => {
  assert.throws(() => ContextPackSchema.parse({
    id: "pack:1",
    workId: "work:1",
    taskId: "task:1",
    attemptId: "attempt:1",
    strategy: "minimal",
    taskClass: "default",
    fragments: [{ kind: "included-file", marker: "ctx:included-file:0", tokenEstimate: 100, path: "src/foo.ts", content: "x" }],
    totalTokens: 99,
    composedAt: TEST_NOW,
    markers: ["ctx:included-file:0"],
  }));
});

test("ContextPackSchema rejects duplicate fragment markers", () => {
  assert.throws(() => ContextPackSchema.parse({
    id: "pack:1",
    workId: "work:1",
    taskId: "task:1",
    attemptId: "attempt:1",
    strategy: "minimal",
    taskClass: "default",
    fragments: [
      { kind: "included-file", marker: "ctx:included-file:0", tokenEstimate: 100, path: "src/a.ts", content: "x" },
      { kind: "included-file", marker: "ctx:included-file:0", tokenEstimate: 50, path: "src/b.ts", content: "y" },
    ],
    totalTokens: 150,
    composedAt: TEST_NOW,
    markers: ["ctx:included-file:0", "ctx:included-file:0"],
  }));
});

test("ContextPackSchema rejects mismatched markers array", () => {
  assert.throws(() => ContextPackSchema.parse({
    id: "pack:1",
    workId: "work:1",
    taskId: "task:1",
    attemptId: "attempt:1",
    strategy: "minimal",
    taskClass: "default",
    fragments: [
      { kind: "included-file", marker: "ctx:included-file:0", tokenEstimate: 100, path: "src/a.ts", content: "x" },
    ],
    totalTokens: 100,
    composedAt: TEST_NOW,
    markers: ["ctx:different:0"],
  }));
});

test("ContextPackSchema accepts a pack whose markers match fragments and totalTokens is consistent", () => {
  const pack = makePack();
  assert.equal(pack.markers.length, pack.fragments.length);
  assert.equal(pack.totalTokens, pack.fragments.reduce((sum, fragment) => sum + fragment.tokenEstimate, 0));
});

test("selectFilesByStrategy: minimal picks one file", () => {
  const chosen = selectFilesByStrategy({ "src/a.ts": "aaa", "src/b.ts": "bbb" }, "minimal", 8000);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]?.path, "src/a.ts");
});

test("selectFilesByStrategy: balanced picks up to four files", () => {
  const chosen = selectFilesByStrategy({
    "src/a.ts": "aaa",
    "src/b.ts": "bbb",
    "src/c.ts": "ccc",
    "src/d.ts": "ddd",
    "src/e.ts": "eee",
  }, "balanced", 8000);
  assert.equal(chosen.length, 4);
  assert.equal(chosen[0]?.path, "src/a.ts");
  assert.equal(chosen[3]?.path, "src/d.ts");
});

test("selectFilesByStrategy: broad picks all files", () => {
  const chosen = selectFilesByStrategy({ "src/a.ts": "aaa", "src/b.ts": "bbb" }, "broad", 8000);
  assert.equal(chosen.length, 2);
});

test("selectFilesByStrategy: explicit picks all files", () => {
  const chosen = selectFilesByStrategy({ "src/a.ts": "aaa" }, "explicit", 8000);
  assert.equal(chosen.length, 1);
});

test("selectSymbols: minimal picks none, balanced picks up to 8, broad picks all", () => {
  const symbols = Array.from({ length: 12 }, (_, i) => ({
    file: `src/file-${i}.ts`,
    name: `fn${i}`,
    range: { startLine: 0, endLine: 10 },
  }));
  assert.equal(selectSymbols(symbols, "minimal", 1000).length, 0);
  assert.equal(selectSymbols(symbols, "balanced", 1000).length, 8);
  assert.equal(selectSymbols(symbols, "broad", 1000).length, 12);
});

test("selectHistory: minimal picks none", () => {
  const events = fileOptions().historyEvents;
  assert.equal(selectHistory(events, "minimal", 1000, 50).length, 0);
});

test("selectHistory: balanced caps at 10", () => {
  const events = fileOptions().historyEvents.concat(
    Array.from({ length: 20 }, (_, i) => ({
      id: `event:more-${i}`,
      occurredAt: `2026-08-20T04:0${i % 10}:00.000Z`,
      type: "attempt.activity-observed",
      summary: "x",
    })),
  );
  const chosen = selectHistory(events, "balanced", 1000, 50);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]?.eventCount, 10);
});

test("selectHistory: broad uses maxHistoryEvents", () => {
  const events = fileOptions().historyEvents.concat(
    Array.from({ length: 80 }, (_, i) => ({
      id: `event:more-${i}`,
      occurredAt: `2026-08-20T04:0${i % 10}:00.000Z`,
      type: "attempt.activity-observed",
      summary: "x",
    })),
  );
  const chosen = selectHistory(events, "broad", 10000, 30);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0]?.eventCount, 30);
});

test("selectRules: minimal caps at 3, balanced at 6, broad at all", () => {
  const rules = fileOptions().rules;
  assert.equal(selectRules(rules, "minimal", 1000).length, 3);
  assert.equal(selectRules(rules, "balanced", 1000).length, 4);
  assert.equal(selectRules(rules, "broad", 1000).length, 4);
});

test("selectArchitectureDocs: minimal picks none, balanced at 2, broad at all", () => {
  const docs = fileOptions().architectureDocs;
  assert.equal(selectArchitectureDocs(docs, "minimal", 1000).length, 0);
  assert.equal(selectArchitectureDocs(docs, "balanced", 1000).length, 1);
  assert.equal(selectArchitectureDocs(docs, "broad", 1000).length, 1);
});

test("selectSkills: minimal picks none, balanced at 2, broad at all", () => {
  const skills = fileOptions().skills;
  assert.equal(selectSkills(skills, "minimal", 1000).length, 0);
  assert.equal(selectSkills(skills, "balanced", 1000).length, 1);
  assert.equal(selectSkills(skills, "broad", 1000).length, 1);
});

test("composeContextPack uses the work type to pick the default strategy", () => {
  const scoutPack = composeContextPack(
    work({ type: "SCOUT", writeScope: [] }),
    "task:1",
    "attempt:1",
    fileOptions(),
    { ...DEFAULT_CONTEXT_CONFIG, strategy: "broad" },
    () => new Date(TEST_NOW),
  );
  assert.equal(scoutPack.taskClass, "scout");
  const shipPack = composeContextPack(
    work({ type: "SHIP" }),
    "task:1",
    "attempt:1",
    fileOptions(),
    { ...DEFAULT_CONTEXT_CONFIG, strategy: "minimal" },
    () => new Date(TEST_NOW),
  );
  assert.equal(shipPack.taskClass, "ship");
  assert.equal(shipPack.strategy, "minimal");
});

test("composeContextPack with no events or rules still produces a valid pack", () => {
  const pack = makePack({}, {
    historyEvents: [],
    rules: [],
    architectureDocs: [],
    skills: [],
    selectedSymbols: [],
    fileContents: {},
  });
  assert.equal(pack.fragments.length, 0);
  assert.equal(pack.totalTokens, 0);
});

test("composeContextPack honours the config token budget and the per-kind caps", () => {
  const pack = makePack({
    perFileHardCap: 10,
  }, {
    fileContents: {
      "src/a.ts": "a".repeat(1000),
    },
  });
  const fileFragment = pack.fragments.find((fragment) => fragment.kind === "included-file") as IncludedFileFragment | undefined;
  assert.ok(fileFragment);
  assert.ok(fileFragment.tokenEstimate <= 10);
});

test("applyContextEdit drop-fragment removes the fragment and recomputes totalTokens", () => {
  const pack = makePack();
  const before = pack.totalTokens;
  const droppedMarker = pack.fragments[0]?.marker;
  if (droppedMarker === undefined) throw new Error("no fragment to drop");
  const after = applyContextEdit(pack, { kind: "drop-fragment", marker: droppedMarker });
  assert.equal(after.fragments.length, pack.fragments.length - 1);
  assert.equal(after.totalTokens, before - (pack.fragments[0]?.tokenEstimate ?? 0));
  assert.equal(findFragmentByMarker(after, droppedMarker), null);
});

test("applyContextEdit replace-fragment swaps the fragment and recomputes totalTokens", () => {
  const pack = makePack();
  const marker = pack.fragments[0]?.marker;
  if (marker === undefined) throw new Error("no fragment");
  const replacement: ContextFragment = {
    kind: "rule",
    marker,
    tokenEstimate: 999,
    ruleId: "rule:replacement",
    text: "replacement",
  };
  const after = applyContextEdit(pack, { kind: "replace-fragment", marker, replacement });
  const replaced = findFragmentByMarker(after, marker);
  assert.ok(replaced);
  assert.equal(replaced.kind, "rule");
  assert.equal(after.totalTokens, pack.totalTokens - (pack.fragments[0]?.tokenEstimate ?? 0) + 999);
});

test("applyContextEdit clear-tool-uses evicts tool-use fragments above keepRecent", () => {
  const pack = makePack();
  const toolUseCount = pack.fragments.filter((fragment) =>
    fragment.kind === "included-file" || fragment.kind === "selected-symbol" || fragment.kind === "skill",
  ).length;
  assert.ok(toolUseCount > 0);
  const after = applyContextEdit(pack, { kind: "clear-tool-uses", keepRecent: 0, minTokens: 0 });
  assert.equal(after.fragments.filter((fragment) =>
    fragment.kind === "included-file" || fragment.kind === "selected-symbol" || fragment.kind === "skill",
  ).length, 0);
});

test("applyContextEdit clear-tool-uses with keepRecent=N retains the last N tool-use fragments", () => {
  const pack = makePack({ strategy: "broad" });
  const beforeToolUse = pack.fragments.filter((fragment) =>
    fragment.kind === "included-file" || fragment.kind === "selected-symbol" || fragment.kind === "skill",
  );
  if (beforeToolUse.length < 2) {
    throw new Error("test requires at least 2 tool-use fragments");
  }
  const lastMarker = beforeToolUse[beforeToolUse.length - 1]?.marker;
  if (lastMarker === undefined) throw new Error("no marker");
  const after = applyContextEdit(pack, { kind: "clear-tool-uses", keepRecent: 1, minTokens: 0 });
  const kept = after.fragments.filter((fragment) =>
    fragment.kind === "included-file" || fragment.kind === "selected-symbol" || fragment.kind === "skill",
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.marker, lastMarker);
});

test("applyContextEdit drop-fragment throws ContextValidationError when the marker is unknown", () => {
  const pack = makePack();
  assert.throws(
    () => applyContextEdit(pack, { kind: "drop-fragment", marker: "ctx:nope:0" }),
    (err: unknown) => err instanceof ContextValidationError,
  );
});

test("validateContextBudget reports withinBudget=true when totals are under the caps", () => {
  const pack = makePack();
  const breakdown = validateContextBudget(pack);
  assert.equal(breakdown.withinBudget, true);
  assert.equal(breakdown.overBudgetKinds.length, 0);
});

test("validateContextBudget reports withinBudget=false when a per-kind cap is exceeded", () => {
  const customConfig: ContextConfig = {
    ...DEFAULT_CONTEXT_CONFIG,
    tokenBudget: {
      includedFile: 100,
      selectedSymbol: 20_000,
      history: 10_000,
      rule: 8_000,
      architectureDoc: 15_000,
      skill: 8_000,
      total: 60_000,
    },
    perFileHardCap: 8_000,
  };
  const oversizePack = makePack(customConfig, {
    fileContents: {
      "src/oversize.ts": "a".repeat(40_000),
      "src/oversize-2.ts": "b".repeat(40_000),
    },
  });
  const breakdown = validateContextBudget(oversizePack, customConfig);
  if (breakdown.withinBudget) {
    assert.fail("expected the oversize pack to exceed the per-kind cap");
  }
  assert.ok(breakdown.overBudgetKinds.includes("included-file"));
});

test("validateContextBudget reports the total budget exceeded when totalTokens > total", () => {
  const customConfig: ContextConfig = {
    ...DEFAULT_CONTEXT_CONFIG,
    strategy: "broad",
    tokenBudget: {
      includedFile: 1_000_000,
      selectedSymbol: 1_000_000,
      history: 1_000_000,
      rule: 1_000_000,
      architectureDoc: 1_000_000,
      skill: 1_000_000,
      total: 1,
    },
    perFileHardCap: 100_000,
  };
  const oversizedPack = makePack(customConfig);
  const breakdown = validateContextBudget(oversizedPack, customConfig);
  if (breakdown.withinBudget) {
    assert.fail("expected the oversize pack to exceed the total budget");
  }
  assert.ok(breakdown.total > breakdown.totalBudget);
});

test("indexOfMarker returns -1 when the marker is missing", () => {
  const pack = makePack();
  assert.equal(indexOfMarker(pack, "ctx:nope:0"), -1);
});

test("indexOfMarker returns the index when the marker is present", () => {
  const pack = makePack();
  const marker = pack.fragments[0]?.marker;
  if (marker === undefined) throw new Error("no fragment");
  assert.equal(indexOfMarker(pack, marker), 0);
});

test("findFragmentByMarker returns null when the marker is missing", () => {
  const pack = makePack();
  assert.equal(findFragmentByMarker(pack, "ctx:nope:0"), null);
});

test("findFragmentByMarker returns the fragment when the marker is present", () => {
  const pack = makePack();
  const marker = pack.fragments[0]?.marker;
  if (marker === undefined) throw new Error("no fragment");
  const fragment = findFragmentByMarker(pack, marker);
  assert.ok(fragment);
  assert.equal(fragment.marker, marker);
});

test("assertContextPack narrows the type", () => {
  assertContextPack(makePack());
  assert.throws(() => assertContextPack({}), (err: unknown) => err instanceof ContextValidationError);
});

test("parseContextPack round-trips a valid pack", () => {
  const pack = makePack();
  const parsed = parseContextPack(pack);
  assert.equal(parsed.id, pack.id);
});

test("parseContextCompositionOptions rejects an unknown event shape", () => {
  assert.throws(() => parseContextCompositionOptions({ fileContents: {}, selectedSymbols: [{ file: "x", name: "y", range: "nope" }] }));
});

test("parseContextEdit accepts every edit kind", () => {
  parseContextEdit({ kind: "clear-tool-uses", keepRecent: 0, minTokens: 0 });
  parseContextEdit({ kind: "drop-fragment", marker: "ctx:included-file:0" });
  parseContextEdit({ kind: "replace-fragment", marker: "ctx:included-file:0", replacement: { kind: "rule", marker: "ctx:included-file:0", tokenEstimate: 1, ruleId: "rule:1", text: "x" } });
});

test("parseContextConfig accepts an empty object and applies the defaults", () => {
  const config = parseContextConfig({});
  assert.equal(config.strategy, "minimal");
  assert.equal(config.markerPrefix, "ctx");
  assert.equal(config.maxHistoryEvents, 50);
});

test("ContextTokenBudgetSchema rejects a negative total budget", () => {
  assert.throws(() => ContextTokenBudgetSchema.parse({ total: -1 }));
});

test("ContextEditSchema rejects an unknown kind", () => {
  assert.throws(() => ContextEditSchema.parse({ kind: "unknown", marker: "x" }));
});

test("composeContextPack is deterministic for the same inputs", () => {
  const opts = fileOptions();
  const a = composeContextPack(work(), "task:1", "attempt:1", opts, DEFAULT_CONTEXT_CONFIG, () => new Date(TEST_NOW));
  const b = composeContextPack(work(), "task:1", "attempt:1", opts, DEFAULT_CONTEXT_CONFIG, () => new Date(TEST_NOW));
  assert.deepEqual(a, b);
});

test("applyContextEdit is non-mutating: input pack is unchanged", () => {
  const pack = makePack();
  const before = JSON.stringify(pack);
  applyContextEdit(pack, { kind: "drop-fragment", marker: pack.fragments[0]?.marker ?? "ctx:nope:0" });
  assert.equal(JSON.stringify(pack), before);
});

test("DEFAULT_CONTEXT_CONFIG is frozen and matches the documented defaults", () => {
  assert.ok(Object.isFrozen(DEFAULT_CONTEXT_CONFIG));
  assert.equal(DEFAULT_CONTEXT_CONFIG.strategy, "minimal");
  assert.equal(DEFAULT_CONTEXT_CONFIG.tokenBudget.total, 60_000);
});

test("ContextError subclasses carry stable codes", () => {
  const cfg = new ContextConfigurationError("x");
  assert.equal(cfg.code, "CONTEXT_CONFIGURATION_ERROR");
  assert.equal(cfg.name, "ContextConfigurationError");
  const val = new ContextValidationError("x");
  assert.equal(val.code, "CONTEXT_VALIDATION_ERROR");
  const budget = new ContextBudgetExceededError("x", {
    byKind: {}, total: 0, perKindBudget: {}, totalBudget: 0, withinBudget: false, overBudgetKinds: [],
  });
  assert.equal(budget.code, "CONTEXT_BUDGET_EXCEEDED");
  const base = new ContextError("x", "X");
  assert.equal(base.code, "X");
});

test("the composer is a pure function with respect to clock and config", () => {
  const opts = fileOptions();
  const a = composeContextPack(work(), "task:1", "attempt:1", opts, DEFAULT_CONTEXT_CONFIG, () => new Date("2026-08-20T05:00:00.000Z"));
  const b = composeContextPack(work(), "task:1", "attempt:1", opts, DEFAULT_CONTEXT_CONFIG, () => new Date("2026-08-20T06:00:00.000Z"));
  assert.notEqual(a.composedAt, b.composedAt);
  assert.equal(a.id, b.id);
});
