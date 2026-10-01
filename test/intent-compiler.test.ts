import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityActionSchema, AuthorityGrantSchema } from "../src/schemas.js";
import { compileIntent, renderIntentForWorker, type IntentCompileRequest } from "../src/intent-compiler.js";

test("compiles a build request into a bounded ship specification", () => {
  const spec = compileIntent({
    workId: "w1",
    taskId: "t1",
    objective: "Build the intent compiler and verify it",
    action: "modify",
    requestedActions: ["read", "write"],
    atoms: [{ id: "repo-known", source: "deterministic", value: true, evidenceRefs: ["git:main"] }],
  });
  assert.equal(spec.action, "modify");
  assert.equal(spec.taskClass, "ship");
  assert.deepEqual(spec.requestedActions, ["read", "write"]);
  assert.equal(spec.proof, "test");
  assert.equal(spec.contextStrategy, "minimal");
  assert.deepEqual(spec.unresolvedAtomIds, []);
  assert.match("specHash" in spec ? String(spec.specHash) : "", /^sha256:[a-f0-9]{64}$/);
});

test("worker data preserves all canonical external effect requests", () => {
  for (const [objective, requestedActions] of [
    ["Pay the invoice", ["spend"]],
    ["Publish the release", ["publish"]],
    ["Pay the invoice and publish the release", ["publish", "spend"]],
    ["Build, run tests, and publish the release", ["execute", "publish", "write"]],
  ] as const) {
    const spec = compileIntent({ workId: "effects", taskId: "effects", objective, action: "external-action", requestedActions: [...requestedActions] });
    const data = JSON.parse(renderIntentForWorker(spec));
    assert.deepEqual(data.requestedActions, requestedActions, objective);
  }
});

test("explicit integration facts use external effect routing", () => {
  for (const objective of ["Merge the pull request", "Land PR #42", "git merge feature", "Run gh pr merge 42"]) {
    const spec = compileIntent({ workId: "integration", taskId: "integration", objective, action: "external-action", requestedActions: ["external-mutate"] });
    assert.equal(spec.action, "external-action", objective);
    assert.equal(spec.proof, "receipt", objective);
  }
});

test("natural-language PR requests cannot manufacture operation or permission facts", () => {
  for (const objective of ["Create a pull request", "Open the PR", "Reopen PR #42", "Close this pull request", "Update the PR description"]) {
    const spec = compileIntent({ workId: "pr", taskId: "pr", objective });
    assert.equal(spec.action, null, objective);
    assert.deepEqual(spec.requestedActions, [], objective);
    assert.equal(spec.proof, null, objective);
    assert.equal(spec.ambiguity, "requires-retrieval", objective);
  }
});

test("Git arguments and PR words inside local objects do not become integration mutations", () => {
  for (const objective of ["Run git log --grep=merge", "Execute git show merge", "Run gh pr view 42 --json mergeable", "Create a file documenting pull requests"]) {
    const spec = compileIntent({ workId: "positions", taskId: "positions", objective });
    assert.notEqual(spec.action, "external-action", objective);
    assert.ok(!spec.requestedActions.includes("external-mutate"), objective);
  }
  const unsupported = compileIntent({ workId: "syntax", taskId: "syntax", objective: "Run git -C repo push" });
  assert.equal(unsupported.ambiguity, "requires-retrieval");
});

test("questions and polite prefixes remain opaque to the compiler", () => {
  for (const objective of ["How do I build and publish the package?", "What happens when I run tests and deploy?", "Explain how to build and publish the package", "Could you explain how to build and publish the package?"]) {
    const spec = compileIntent({ workId: "question", taskId: "question", objective });
    assert.equal(spec.action, null, objective);
    assert.deepEqual(spec.requestedActions, [], objective);
    assert.equal(spec.ambiguity, "requires-retrieval", objective);
  }
});

test("arbitrary execution remains unresolved without verified command effects", () => {
  for (const objective of ["Run sh -c 'git push origin main'", "Run sudo gh pr merge 42", "Execute a deployment script", "Run git status && git push origin main", "gh pr view 42 && gh pr merge 42"]) {
    const spec = compileIntent({ workId: "wrapped", taskId: "wrapped", objective });
    assert.equal(spec.ambiguity, "requires-retrieval", objective);
  }
});

test("replay validates an integrity hash over the exact compiled payload", () => {
  const spec = compileIntent({ workId: "bound", taskId: "bound", objective: "Inspect this module" });
  for (const change of [
    { objective: "Publish the release" }, { workId: "another-work" }, { taskId: "another-task" },
    { requestedActions: ["publish" as const] }, { proof: "receipt" as const },
    { atoms: [{ id: "new-fact", source: "human" as const, value: true, evidenceRefs: [] }] },
  ]) {
    assert.throws(() => renderIntentForWorker({ ...spec, ...change }), /specification hash/);
  }
  assert.deepEqual(JSON.parse(renderIntentForWorker(JSON.parse(JSON.stringify(spec)))), spec);
});

test("replayed specifications reject stale or invented unresolved atom IDs", () => {
  const spec = compileIntent({ workId: "replay", taskId: "replay", objective: "Inspect facts",
    atoms: [{ id: "unknown", source: "human", value: null }, { id: "known", source: "human", value: true }] });
  for (const unresolvedAtomIds of [[], ["absent"], ["known"], ["unknown", "unknown"]]) {
    assert.throws(() => renderIntentForWorker({ ...spec, unresolvedAtomIds }), /unresolved atom IDs/);
  }
  assert.throws(() => renderIntentForWorker({ ...spec, atoms: spec.atoms.map(atom => ({ ...atom, value: true })) }), /unresolved atom IDs/);
  assert.deepEqual(JSON.parse(renderIntentForWorker(spec)).unresolvedAtomIds, ["unknown"]);
});

test("action words in the object of a request do not replace the requested operation", () => {
  for (const objective of ["Review this change", "Inspect the publish button", "Research invoice payment"]) {
    const spec = compileIntent({ workId: "objects", taskId: "objects", objective });
    assert.notEqual(spec.action, "modify", objective);
    assert.notEqual(spec.action, "external-action", objective);
  }
});

test("surfaces unresolved low-confidence atoms instead of hiding uncertainty", () => {
  const spec = compileIntent({
    workId: "w2",
    taskId: "t2",
    objective: "Review this change",
    atoms: [
      { id: "needs-domain-context", source: "semantic-judgment", value: true, confidence: 0.3 },
      { id: "tests-known", source: "cached", value: null },
    ],
  });
  assert.deepEqual(spec.unresolvedAtomIds, ["needs-domain-context", "tests-known"]);
});

test("explicit caller facts are preserved without interpreting the objective", () => {
  const spec = compileIntent({
    workId: "w3",
    taskId: "t3",
    objective: "Run an analysis",
    action: "research",
    requestedActions: ["read"],
    proof: "external-verification",
    contextStrategy: "explicit",
  });
  assert.equal(spec.action, "research");
  assert.deepEqual(spec.requestedActions, ["read"]);
  assert.equal(spec.proof, "external-verification");
  assert.equal(spec.contextStrategy, "explicit");
  assert.doesNotMatch(renderIntentForWorker(spec), /You are|must obey/i);
});

test("local execution requests local authority and test evidence", () => {
  const spec = compileIntent({ workId: "w4", taskId: "t4", objective: "Run the test suite", action: "execute", requestedActions: ["execute"] });
  assert.equal(spec.action, "execute");
  assert.deepEqual(spec.requestedActions, ["execute"]);
  assert.equal(spec.proof, "test");
});

test("external effects stay distinct even alongside a local modification", () => {
  for (const [objective, requestedActions] of [
    ["Deploy the project", ["publish"]],
    ["Build and publish the site", ["publish", "write"]],
    ["Send the email", ["external-mutate"]],
  ] as const) {
    const spec = compileIntent({ workId: "w5", taskId: "t5", objective, action: "external-action", requestedActions: [...requestedActions] });
    assert.equal(spec.action, "external-action");
    assert.deepEqual(spec.requestedActions, requestedActions);
    assert.equal(spec.proof, "receipt");
  }
});

test("the worker receives the exact whitespace-sensitive objective", () => {
  const objective = "  Update this YAML exactly:\nsteps:\n  - run: |\n      echo first\n      echo second\n";
  const spec = compileIntent({ workId: "w6", taskId: "t6", objective });
  assert.equal(spec.objective, objective);
  assert.equal(JSON.parse(renderIntentForWorker(spec)).objective, objective);
});

test("compilation and rendering enforce the existing Context token estimate budget", () => {
  assert.throws(() => compileIntent({ workId: "w7", taskId: "t7", objective: "Inspect this module", maxContextTokens: 1 }), /context budget/);
  assert.throws(() => compileIntent({ workId: "w7", taskId: "t7", objective: "Inspect this module", atoms: [{ id: "large", source: "human", value: "x".repeat(40_000) }] }), /context budget/);
  const spec = compileIntent({ workId: "w7", taskId: "t7", objective: "Inspect this module" });
  assert.throws(() => renderIntentForWorker({ ...spec, maxContextTokens: 1 }), /specification hash/);
});

test("compiled authority uses the canonical WorkContract action vocabulary", () => {
  for (const [objective, expected] of [
    ["Build the module", "write"],
    ["Run the suite", "execute"],
    ["Publish the site", "publish"],
    ["Monitor the logs", "read"],
  ] as const) {
    const spec = compileIntent({ workId: "w8", taskId: "t8", objective, requestedActions: [expected] });
    assert.deepEqual(spec.requestedActions, [expected]);
    assert.equal(AuthorityActionSchema.parse(spec.requestedActions[0]), expected);
    assert.equal(AuthorityGrantSchema.parse({ action: spec.requestedActions[0] }).action, expected);
  }
});

test("ambiguous duplicate atom identifiers are rejected after normalization", () => {
  const request = {
    workId: "w9", taskId: "t9", objective: "Inspect the module",
    atoms: [
      { id: "fact", source: "human" as const, value: true },
      { id: " fact ", source: "cached" as const, value: null },
    ],
  };
  assert.throws(() => compileIntent(request), /atom IDs must be unique/);
  const spec = compileIntent({ ...request, atoms: [request.atoms[0]!] });
  assert.throws(() => renderIntentForWorker({ ...spec, atoms: [spec.atoms[0]!, spec.atoms[0]!] }), /atom IDs must be unique/);
});

test("mixed explicit facts retain every requested effect", () => {
  const cases = [
    ["Investigate and fix the failing test", "modify", ["read", "write"], "test"],
    ["Review and update the module", "modify", ["read", "write"], "test"],
    ["Inspect the logs and run the suite", "execute", ["execute", "read"], "test"],
    ["Research, implement, and publish the change", "external-action", ["publish", "read", "write"], "receipt"],
    ["Notify the customer that deployment completed", "external-action", ["external-mutate"], "receipt"],
    ["Alert the on-call team", "external-action", ["external-mutate"], "receipt"],
    ["Monitor the logs", "monitor", ["read"], "none"],
    ["Watch the process", "monitor", ["read"], "none"],
  ] as const;
  for (const [objective, action, requestedActions, proof] of cases) {
    const spec = compileIntent({ workId: "w10", taskId: "t10", objective, action, requestedActions: [...requestedActions] });
    assert.equal(spec.action, action, objective);
    assert.deepEqual(spec.requestedActions, requestedActions, objective);
    assert.equal(spec.proof, proof, objective);
  }
});

test("unrecognized clauses keep their ambiguity instead of claiming a resolved request", () => {
  const spec = compileIntent({ workId: "unknown", taskId: "unknown", objective: "Do not publish the release" });
  assert.equal(spec.ambiguity, "requires-retrieval");
  assert.deepEqual(spec.requestedActions, []);
  const explicit = compileIntent({ workId: "known", taskId: "known", objective: "Prepare the publication",
    action: "external-action", requestedActions: ["publish", "spend", "publish"], ambiguity: "none" });
  assert.deepEqual(explicit.requestedActions, ["publish", "spend"]);
});

test("PR template work requires explicit workspace facts instead of noun matching", () => {
  for (const objective of ["Create a PR template", "Edit the pull request template"]) {
    const unresolved = compileIntent({ workId: "template", taskId: "template", objective });
    assert.equal(unresolved.action, null);
    assert.equal(unresolved.ambiguity, "requires-retrieval");
    const resolved = compileIntent({ workId: "template", taskId: "template", objective, action: "modify", requestedActions: ["write"] });
    assert.equal(resolved.action, "modify");
    assert.deepEqual(resolved.requestedActions, ["write"]);
    assert.equal(resolved.proof, "test");
  }
});

test("missing operation facts and uncertain atoms cannot be declared resolved", () => {
  const base = { workId: "missing", taskId: "missing", objective: "Publish the release" };
  assert.throws(() => compileIntent({ ...base, ambiguity: "none" }), /incomplete intent facts/);
  assert.throws(() => compileIntent({ ...base, action: "external-action", ambiguity: "none" }), /incomplete intent facts/);
  assert.throws(() => compileIntent({ ...base, action: "inspect", requestedActions: ["read"], ambiguity: "none",
    atoms: [{ id: "unknown", source: "human", value: null }] }), /incomplete intent facts/);
  const spec = compileIntent({ ...base, action: "external-action" });
  assert.equal(spec.ambiguity, "requires-retrieval");
  assert.deepEqual(spec.requestedActions, []);
  assert.throws(() => renderIntentForWorker({ ...spec, ambiguity: "none" }), /incomplete intent facts/);
});

test("equivalent fact sets produce one locale-independent specification identity", () => {
  const base = { workId: "canonical", taskId: "canonical", objective: "Inspect facts", action: "inspect" as const,
    atoms: ["ä", "a", "Z"].map(id => ({ id, source: "human" as const, value: true })) };
  const first = compileIntent({ ...base, requestedActions: ["read", "read"], requiredContextMarkers: ["b", "a", "b"] });
  const second = compileIntent({ ...base, atoms: [...base.atoms].reverse(), requestedActions: ["read"], requiredContextMarkers: ["a", "b"] });
  assert.deepEqual(first.atoms.map(atom => atom.id), ["Z", "a", "ä"]);
  assert.equal(first.specHash, second.specHash);
  assert.deepEqual(first, second);
});

test("resolved effects require coherent routing and minimum proof", () => {
  const contradictions: Partial<IntentCompileRequest>[] = [
    { action: "answer", requestedActions: ["publish"], proof: "none" },
    { action: "answer", requestedActions: ["read", "publish"], proof: "none" },
    { action: "inspect", requestedActions: ["write"] },
    { action: "modify", requestedActions: ["write"], taskClass: "scout" },
    { action: "execute", requestedActions: ["execute"], proof: "none" },
    { action: "external-action", requestedActions: ["publish"], proof: "test" },
    { action: "external-action", requestedActions: ["read"] },
    { action: "review", requestedActions: ["read"], proof: "none" },
    { action: "monitor", requestedActions: ["approve"] },
  ];
  for (const facts of contradictions) {
    assert.throws(() => compileIntent({ workId: "conflict", taskId: "conflict", objective: "Caller-supplied facts",
      ...facts, ambiguity: "none" }), /coherent intent facts/);
  }
  const verified = compileIntent({ workId: "verified", taskId: "verified", objective: "Approve publication",
    action: "external-action", requestedActions: ["approve", "publish"], proof: "external-verification" });
  assert.equal(verified.ambiguity, "none");
  const readOnly = compileIntent({ workId: "readonly", taskId: "readonly", objective: "Answer a question",
    action: "answer", requestedActions: ["read"], proof: "none" });
  assert.equal(readOnly.ambiguity, "none");
});

test("secondary capabilities do not replace the declared primary action", () => {
  for (const [action, requestedActions, taskClass, proof] of [
    ["review", ["read", "execute"], "review", "explanation"],
    ["execute", ["execute", "write"], "ship", "test"],
    ["modify", ["read", "write", "execute"], "ship", "test"],
    ["review", ["read", "publish"], "review", "external-verification"],
  ] as const) {
    const spec = compileIntent({ workId: "secondary", taskId: "secondary", objective: "Perform the declared task",
      action, requestedActions: [...requestedActions] });
    assert.equal(spec.action, action);
    assert.equal(spec.taskClass, taskClass);
    assert.equal(spec.proof, proof);
    assert.equal(spec.ambiguity, "none");
    assert.deepEqual(JSON.parse(renderIntentForWorker(spec)), spec);
  }
});

test("context markers cannot be both required and optional after normalization", () => {
  const request = { workId: "markers", taskId: "markers", objective: "Inspect context",
    requiredContextMarkers: ["contract"], optionalContextMarkers: [" contract "] };
  assert.throws(() => compileIntent(request), /required and optional context markers must be disjoint/);
  const spec = compileIntent({ ...request, optionalContextMarkers: ["history", "history"] });
  assert.deepEqual(spec.optionalContextMarkers, ["history"]);
  assert.throws(() => renderIntentForWorker({ ...spec, optionalContextMarkers: [" contract "] }), /required and optional context markers must be disjoint/);
});
