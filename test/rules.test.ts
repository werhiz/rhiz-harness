import assert from "node:assert/strict";
import test from "node:test";

import {
  HarnessRuleSchema,
  RuleCatalogSchema,
  RuleSelectionRequestSchema,
  parseRuleCatalog,
  ruleInputsForContext,
  selectHarnessRules,
} from "../src/rules.js";

function catalog(rules: unknown[]) {
  return parseRuleCatalog({
    schema: "rhiz-rule-catalog/v1",
    id: "catalog:test",
    revision: 1,
    rules,
  });
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule:test",
    revision: 1,
    severity: "strong",
    binding: "injected",
    text: "Do the thing that the evidence supports.",
    taskClasses: ["ship"],
    pathPrefixes: [],
    evidenceRefs: ["evidence:1"],
    ...overrides,
  };
}

test("HarnessRuleSchema accepts a bounded injected rule", () => {
  const parsed = HarnessRuleSchema.parse(rule());
  assert.equal(parsed.id, "rule:test");
  assert.deepEqual(parsed.taskClasses, ["ship"]);
  assert.equal(parsed.binding, "injected");
});

test("global rules must be hard", () => {
  const parsed = HarnessRuleSchema.safeParse(
    rule({ severity: "strong", taskClasses: [], pathPrefixes: [] }),
  );
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.message, /global rule must be severity=hard/);
});

test("mechanized rules require a guard and injected rules cannot claim one", () => {
  assert.equal(HarnessRuleSchema.safeParse(rule({ binding: "mechanized", guardId: undefined })).success, false);
  assert.equal(HarnessRuleSchema.safeParse(rule({ binding: "injected", guardId: "guard:fake" })).success, false);
});

test("rule path prefixes are repository-relative literal prefixes", () => {
  for (const invalid of ["/tmp/x", "../escape", "src/**", "src\\thing"]) {
    assert.equal(
      HarnessRuleSchema.safeParse(rule({ pathPrefixes: [invalid] })).success,
      false,
      `expected ${invalid} to be rejected`,
    );
  }
  const parsed = HarnessRuleSchema.parse(rule({ pathPrefixes: ["./src/router/"] }));
  assert.deepEqual(parsed.pathPrefixes, ["src/router"]);
});

test("catalog refuses duplicate rule identities", () => {
  const parsed = RuleCatalogSchema.safeParse({
    schema: "rhiz-rule-catalog/v1",
    id: "catalog:test",
    revision: 1,
    rules: [rule(), rule()],
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.message, /duplicate rule id/);
});

test("selection requires both task and path constraints when both are declared", () => {
  const selected = selectHarnessRules(
    catalog([
      rule({ id: "rule:both", taskClasses: ["ship"], pathPrefixes: ["src/board"] }),
      rule({ id: "rule:wrong-task", taskClasses: ["review"], pathPrefixes: ["src/board"] }),
      rule({ id: "rule:wrong-path", taskClasses: ["ship"], pathPrefixes: ["src/router"] }),
      rule({ id: "rule:task", taskClasses: ["ship"], pathPrefixes: [] }),
      rule({ id: "rule:path", severity: "hard", taskClasses: [], pathPrefixes: ["src/board"] }),
    ]),
    { taskClass: "ship", paths: ["src/board/project.ts"] },
  );
  assert.deepEqual(
    selected.selected.map((item) => item.ruleId).sort(),
    ["rule:both", "rule:path", "rule:task"].sort(),
  );
});

test("selection is deterministic and prioritizes severity then specificity then revision", () => {
  const input = [
    rule({ id: "rule:preference", severity: "preference", revision: 9 }),
    rule({ id: "rule:strong-task", severity: "strong", revision: 1 }),
    rule({ id: "rule:strong-specific", severity: "strong", revision: 1, pathPrefixes: ["src"] }),
    rule({ id: "rule:strong-specific-new", severity: "strong", revision: 2, pathPrefixes: ["src"] }),
    rule({ id: "rule:hard", severity: "hard", taskClasses: [], pathPrefixes: [] }),
  ];
  const request = { taskClass: "ship" as const, paths: ["src/board.ts"], maxRules: 20 };
  const first = selectHarnessRules(catalog(input), request);
  const second = selectHarnessRules(catalog([...input].reverse()), request);
  const expected = [
    "rule:hard",
    "rule:strong-specific-new",
    "rule:strong-specific",
    "rule:strong-task",
    "rule:preference",
  ];
  assert.deepEqual(first.selected.map((item) => item.ruleId), expected);
  assert.deepEqual(second.selected.map((item) => item.ruleId), expected);
});

test("tie-breaking is locale-independent for distinct Unicode ids", () => {
  const composed = "rule:e\u0301";
  const precomposed = "rule:é";
  const request = { taskClass: "ship" as const, paths: [], maxRules: 1 };
  const first = selectHarnessRules(catalog([rule({ id: composed }), rule({ id: precomposed })]), request);
  const second = selectHarnessRules(catalog([rule({ id: precomposed }), rule({ id: composed })]), request);
  assert.equal(first.selected[0]?.ruleId, composed < precomposed ? composed : precomposed);
  assert.deepEqual(first.selected, second.selected);
});

test("inactive mechanized rules stay in Context instead of silently disappearing", () => {
  const selected = selectHarnessRules(
    catalog([
      rule({
        id: "rule:mechanized",
        severity: "hard",
        binding: "mechanized",
        taskClasses: [],
        pathPrefixes: [],
        guardId: "guard:worktree",
      }),
      rule({ id: "rule:injected" }),
    ]),
    { taskClass: "ship", paths: ["src/crew.ts"] },
  );
  assert.deepEqual(selected.mechanicallyBoundRuleIds, []);
  assert.deepEqual(selected.inactiveMechanizedRuleIds, ["rule:mechanized"]);
  assert.deepEqual(selected.inputs.map((item) => item.ruleId), ["rule:mechanized", "rule:injected"]);
});

test("only a proven active guard suppresses a mechanized rule from prompt Context", () => {
  const selected = selectHarnessRules(
    catalog([
      rule({
        id: "rule:mechanized",
        severity: "hard",
        binding: "mechanized",
        taskClasses: [],
        pathPrefixes: [],
        guardId: "guard:worktree",
      }),
      rule({ id: "rule:injected" }),
    ]),
    {
      taskClass: "ship",
      paths: ["src/crew.ts"],
      activeGuardIds: ["guard:worktree"],
    },
  );
  assert.deepEqual(selected.mechanicallyBoundRuleIds, ["rule:mechanized"]);
  assert.deepEqual(selected.inactiveMechanizedRuleIds, []);
  assert.deepEqual(selected.inputs, [
    { ruleId: "rule:injected", text: "Do the thing that the evidence supports." },
  ]);
});

test("includeMechanized can include an active mechanized rule without erasing binding evidence", () => {
  const selected = selectHarnessRules(
    catalog([
      rule({
        id: "rule:mechanized",
        severity: "hard",
        binding: "mechanized",
        taskClasses: [],
        pathPrefixes: [],
        guardId: "guard:worktree",
      }),
    ]),
    {
      taskClass: "ship",
      paths: ["src/crew.ts"],
      includeMechanized: true,
      activeGuardIds: ["guard:worktree"],
    },
  );
  assert.deepEqual(selected.mechanicallyBoundRuleIds, ["rule:mechanized"]);
  assert.deepEqual(selected.inputs.map((item) => item.ruleId), ["rule:mechanized"]);
});

test("selection request refuses duplicate active guard evidence", () => {
  const parsed = RuleSelectionRequestSchema.safeParse({
    taskClass: "ship",
    activeGuardIds: ["guard:x", "guard:x"],
  });
  assert.equal(parsed.success, false);
});

test("selection limit records the deterministic rules omitted from Context", () => {
  const selected = selectHarnessRules(
    catalog([rule({ id: "rule:c" }), rule({ id: "rule:a" }), rule({ id: "rule:b" })]),
    { taskClass: "ship", paths: [], maxRules: 2 },
  );
  assert.deepEqual(selected.selected.map((item) => item.ruleId), ["rule:a", "rule:b"]);
  assert.deepEqual(selected.omittedByLimitRuleIds, ["rule:c"]);
});

test("ruleInputsForContext produces the exact Context rule input contract", () => {
  const inputs = ruleInputsForContext(
    catalog([
      rule({ id: "rule:one", text: "First rule" }),
      rule({ id: "rule:two", text: "Second rule" }),
    ]),
    RuleSelectionRequestSchema.parse({ taskClass: "ship", paths: [] }),
  );
  assert.deepEqual(inputs, [
    { ruleId: "rule:one", text: "First rule" },
    { ruleId: "rule:two", text: "Second rule" },
  ]);
});
