import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, link, symlink, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalModelWorkerProvider, OllamaLocalInference, LocalWorkerConfigSchema, localEditablePath, localOllamaEndpoint, type LocalReplacement } from "../adapters/local/model-worker.js";
import { createGuardedToolMediation, createDefaultPolicyOracle, guardPolicyFromWorkContract, GuardianRejectionCircuitBreaker } from "../src/guard.js";
import type { WorkerStartRequest } from "../src/host.js";
import type { SandboxLauncher } from "../src/sandbox.js";
import { work } from "./helpers.js";

// Unit-test transport only. This launcher deliberately DOES NOT prove OS
// containment; real-host availability is a separately reported rollout gate.
const testOnlyLauncher: SandboxLauncher = {
  id: "sandbox:test-only-pass-through", async available() { return true; },
  async wrap(_policy, command, args) { return { command, args: [...args], async dispose() {} }; },
};
const modelDigest = "a".repeat(64);
const change = { path: "src/example.ts", oldText: "return 1", newText: "return 2" };

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rhiz-local-model-unit-")));
  await mkdir(join(root, "src"));
  const target = join(root, change.path);
  await writeFile(target, "export function answer() { return 1; }\n");
  const request: WorkerStartRequest = {
    work: work({ workerPolicy: { preferredProviders: ["worker:local-model"], maxAttempts: 1, allowParallelAttempts: false, explicitProviderAuthorizations: [] } }),
    taskId: "task:local", attemptId: "attempt:local", objective: "Return two",
    authority: work().authority, context: work().context,
    workspace: { workspaceId: "workspace:local", leaseId: "lease:local", uri: `file://${root}`, executionRoot: root, mode: "isolated-write", baseRevision: "a".repeat(40) },
  };
  return { root, target, request, close: () => rm(root, { recursive: true, force: true }) };
}
function mediation(request: WorkerStartRequest, beforeEffect: () => Promise<void>, deny = false) {
  const contract = deny ? { ...request.work, authority: { ...request.work.authority, requiresHumanApproval: ["write" as const] } } : request.work;
  const policy = guardPolicyFromWorkContract(contract, { contractBoundCategoryAuthority: true });
  return createGuardedToolMediation({ oracle: createDefaultPolicyOracle(policy), policy,
    circuitBreaker: new GuardianRejectionCircuitBreaker(policy.circuitBreaker), workId: request.work.id,
    taskId: request.taskId, attemptId: request.attemptId, actor: { id: "agent:local", kind: "agent" },
    writeScope: "workspace", contextHash: "ctx:local-unit", requireRecordBeforeEffect: true,
    record: async () => { await beforeEffect(); },
  });
}
async function execute(replacement: LocalReplacement, options: { deny?: boolean; prepare?: (root: string, target: string) => Promise<void> } = {}) {
  const f = await fixture();
  try {
    await options.prepare?.(f.root, f.target);
    let guardRecords = 0;
    const provider = new LocalModelWorkerProvider({ model: "unit-local", async replace() { return replacement; } }, testOnlyLauncher, [change.path]);
    const guard = mediation(f.request, async () => { guardRecords++; assert.match(await readFile(f.target, "utf8"), /return 1/); }, options.deny);
    const handle = await provider.start(f.request, { guardedToolMediation: guard });
    const result = await handle.result();
    const observations = [];
    for await (const observation of handle.observe()) observations.push(observation);
    await provider.close();
    return { result, text: await readFile(f.target, "utf8"), guardRecords, observations };
  } finally { await f.close(); }
}

test("local tool effect awaits native Guard and emits completion without self-verification", async () => {
  const r = await execute(change);
  assert.equal(r.result.status, "finished");
  assert.equal(r.guardRecords, 1);
  assert.equal(r.text, "export function answer() { return 2; }\n");
  assert.deepEqual(r.result.evidence, []);
  assert.ok(r.observations.some(o => o.kind === "artifact"));
});
test("Guard refusal prevents effect and never invokes a fallback", async () => {
  const r = await execute(change, { deny: true });
  assert.equal(r.result.status, "failed"); assert.match(r.text, /return 1/);
  assert.match(r.result.summary, /Guard refused/);
});
test("missing OS containment refuses before inference", async () => {
  const f = await fixture(); let calls = 0;
  try {
    const provider = new LocalModelWorkerProvider({ model: "unit-local", async replace() { calls++; return change; } }, null);
    const h = await provider.start(f.request, { guardedToolMediation: mediation(f.request, async () => {}) });
    assert.equal((await h.result()).status, "failed"); assert.equal(calls, 0);
    assert.match(await readFile(f.target, "utf8"), /return 1/);
  } finally { await f.close(); }
});
test("a launcher availability claim without actual sandbox execution refuses before inference", async () => {
  const f = await fixture(); let calls = 0;
  const refusing: SandboxLauncher = { id: "sandbox:false-capability-unit", async available() { return true; },
    async wrap() { return { command: "/usr/bin/false", args: [], async dispose() {} }; } };
  try {
    const provider = new LocalModelWorkerProvider({ model: "unit-local", async replace() { calls++; return change; } }, refusing, [change.path]);
    const h = await provider.start(f.request, { guardedToolMediation: mediation(f.request, async () => {}) });
    assert.equal((await h.result()).status, "failed"); assert.equal(calls, 0);
    assert.equal(await readFile(f.target, "utf8"), "export function answer() { return 1; }\n");
  } finally { await f.close(); }
});
test("a reused worker never attributes previous inference tokens to a preflight failure", async () => {
  const f = await fixture(); let wraps = 0; let calls = 0;
  const launcher: SandboxLauncher = { id: "sandbox:reused-unit", async available() { return true; },
    async wrap(policy, command, args) {
      if (++wraps === 1) return testOnlyLauncher.wrap(policy, command, args);
      return { command: "/usr/bin/false", args: [], async dispose() {} };
    } };
  try {
    const inference = { model: "unit-local", reportedUsage: { source: "provider-reported" as const, inputTokens: 100, outputTokens: 20 }, async replace() { calls++; return change; } };
    const provider = new LocalModelWorkerProvider(inference, launcher, [change.path]);
    const guard = mediation(f.request, async () => {});
    const first = await provider.start(f.request, { guardedToolMediation: guard });
    assert.equal((await first.result()).observedUsage?.inputTokens, 100);
    const second = await provider.start(f.request, { guardedToolMediation: guard });
    const failed = await second.result();
    assert.equal(failed.status, "failed"); assert.equal(failed.observedUsage, undefined); assert.equal(calls, 1);
  } finally { await f.close(); }
});
test("an explicit broad Work grant cannot authorize edits to the Harness itself", async () => {
  const f = await fixture(); let calls = 0;
  try {
    await writeFile(join(f.root, "package.json"), JSON.stringify({ name: "@werhiz/rhiz-harness" }));
    const provider = new LocalModelWorkerProvider({ model: "unit-local", async replace() { calls++; return change; } }, testOnlyLauncher, [change.path]);
    const h = await provider.start(f.request, { guardedToolMediation: mediation(f.request, async () => {}) });
    assert.match((await h.result()).summary, /own Harness control plane/); assert.equal(calls, 0);
  } finally { await f.close(); }
});
test("concurrency is one and cancelling inference cannot edit the candidate", async () => {
  const f = await fixture();
  try {
    const provider = new LocalModelWorkerProvider({ model: "unit-local", async replace(_p, signal) {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    } }, testOnlyLauncher, [change.path]);
    const guard = mediation(f.request, async () => {});
    const h = await provider.start(f.request, { guardedToolMediation: guard });
    await assert.rejects(provider.start(f.request, { guardedToolMediation: guard }), /concurrency is one/);
    await h.cancel(); assert.equal((await h.result()).status, "cancelled");
    assert.equal(await readFile(f.target, "utf8"), "export function answer() { return 1; }\n");
  } finally { await f.close(); }
});
test("cancellation after staging preserves complete original bytes (unit transport, not OS proof)", async () => {
  const f = await fixture(); const marker = join(f.root, "stage-marker");
  const delayingLauncher: SandboxLauncher = { ...testOnlyLauncher, async wrap(_p, command, args) {
    const prefix = `const f=require('node:fs');const rename=f.renameSync;f.renameSync=(...a)=>{f.writeFileSync(${JSON.stringify(marker)},'staged');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return rename(...a)};`;
    return { command, args: ["-e", prefix + args[1]], async dispose() {} };
  } };
  try {
    const provider = new LocalModelWorkerProvider({ model: "unit-local", async replace() { return change; } }, delayingLauncher, [change.path]);
    const h = await provider.start(f.request, { guardedToolMediation: mediation(f.request, async () => {}) });
    const deadline = Date.now() + 3000;
    while (true) {
      if (await access(marker).then(() => true, () => false)) break;
      if (Date.now() > deadline) { await h.cancel(); assert.fail("effect never reached staged-rename boundary"); }
      await new Promise(r => setTimeout(r, 10));
    }
    await h.cancel(); assert.equal((await h.result()).status, "cancelled");
    assert.equal(await readFile(f.target, "utf8"), "export function answer() { return 1; }\n");
  } finally { await f.close(); }
});
test("reserved policy, evaluator, task, model, controller and credential paths are refused", () => {
  for (const p of ["../outside", "src/../outside", "src//file", ".env", ".git/config", "src/guard.ts", "src/crew.ts", "src/verify/index.ts", "src/router.ts", "src/schemas.ts", "adapters/local/model-worker.ts", "scripts/rhiz-harness.mjs", "tools/rhiz-local/identity.mts", "packages/kernel/permission.ts", "docs/canon/LAWS.md", "test/expected.test.ts", "foo/SKILL.md"]) assert.equal(localEditablePath(p), false, p);
  assert.equal(localEditablePath("src/example.ts"), true);
});
test("reserved path and writeScope escape cannot change any file", async () => {
  for (const path of ["src/guard.ts", "other.ts", "../example.ts"]) {
    const r = await execute({ ...change, path }); assert.equal(r.result.status, "failed");
    assert.match(r.text, /return 1/); assert.equal(r.guardRecords, 0);
  }
});
test("ambiguous match and no-op output cannot become successful Work", async () => {
  const a = await execute({ ...change, oldText: "return", newText: "return" }); assert.equal(a.result.status, "failed");
  const b = await execute(change, { prepare: async (_r, p) => { await writeFile(p, "return 1; return 1;"); } });
  assert.equal(b.result.status, "failed"); assert.equal(b.guardRecords, 0);
});
test("hardlinks and symlinks cannot extend the effect boundary", async () => {
  const a = await execute(change, { prepare: async (root, p) => { await link(p, join(root, "other")); } });
  assert.equal(a.result.status, "failed");
  const b = await execute(change, { prepare: async (root, p) => { await rm(p); await writeFile(join(root, "other"), "return 1;"); await symlink(join(root, "other"), p); } });
  assert.equal(b.result.status, "failed");
});
test("budget-zero configuration refuses any silent paid fallback or unknown policy field", () => {
  const config = { backend: "ollama", model: "qwen3:8b", digest: modelDigest, autonomousPaidBudgetUsd: 0, cloudFallback: false, permittedPaths: [change.path] };
  assert.equal(LocalWorkerConfigSchema.parse(config).autonomousPaidBudgetUsd, 0);
  for (const patch of [{ autonomousPaidBudgetUsd: 0.01 }, { cloudFallback: true }, { model: "qwen3:8b-cloud" }, { paidProvider: "codex" }]) assert.throws(() => LocalWorkerConfigSchema.parse({ ...config, ...patch }));
});
test("local endpoint cannot redirect credentials, context or fallback to the network", () => {
  for (const origin of ["https://127.0.0.1", "http://localhost", "http://example.com", "http://127.0.0.1.evil", "http://u:p@127.0.0.1", "http://127.0.0.1/v1", "http://127.0.0.1/?x=1"]) assert.throws(() => localOllamaEndpoint(origin));
  assert.equal(localOllamaEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
});
test("Ollama uses a pinned installed model, bounded context, one tool, no redirect or auth header", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(String(url).endsWith("/api/tags") ? { models: [{ name: "qwen3:8b", digest: modelDigest }] } : { model: "qwen3:8b", done: true, prompt_eval_count: 100, eval_count: 20, message: { tool_calls: [{ function: { name: "replace_text", arguments: change } }] } });
  }) as typeof fetch;
  const local = new OllamaLocalInference({ model: "qwen3:8b", digest: modelDigest }, fetcher);
  assert.deepEqual(await local.replace("task", new AbortController().signal), change);
  assert.deepEqual(local.reportedUsage, { source: "provider-reported", complete: true, inputTokens: 100, outputTokens: 20 });
  assert.equal(local.reportedUsage?.costUsd, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.init.redirect, "error");
  assert.equal(new Headers(calls[1]!.init.headers).has("Authorization"), false);
  const body = JSON.parse(String(calls[1]!.init.body));
  assert.equal(body.keep_alive, 0); assert.equal(body.options.num_ctx, 4096); assert.equal(body.options.num_predict, 512);
});
test("missing model or changed digest refuses before generation", async () => {
  let calls = 0;
  const local = new OllamaLocalInference({ model: "qwen3:8b", digest: modelDigest }, (async () => { calls++; return Response.json({ models: [{ name: "qwen3:8b", digest: "b".repeat(64) }] }); }) as typeof fetch);
  await assert.rejects(local.replace("task", new AbortController().signal), /pinned digest/); assert.equal(calls, 1);
});
test("runtime errors produce no additional inference or cloud requests", async () => {
  let calls = 0;
  const local = new OllamaLocalInference({ model: "qwen3:8b", digest: modelDigest }, (async () => { calls++; return new Response("blocked", { status: 503 }); }) as typeof fetch);
  await assert.rejects(local.replace("task", new AbortController().signal), /503/); assert.equal(calls, 1);
});
test("oversized responses and multiple/unrecognized model tools fail closed", async () => {
  for (const payload of ["x".repeat(65537), { model: "qwen3:8b", done: true, message: { tool_calls: [{ function: { name: "shell", arguments: change } }] } }]) {
    let n = 0;
    const local = new OllamaLocalInference({ model: "qwen3:8b", digest: modelDigest }, (async () => ++n === 1 ? Response.json({ models: [{ name: "qwen3:8b", digest: modelDigest }] }) : typeof payload === "string" ? new Response(payload) : Response.json(payload)) as typeof fetch);
    await assert.rejects(local.replace("task", new AbortController().signal));
  }
});
