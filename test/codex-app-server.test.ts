import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAppServerHost,
  preflightCodexModel,
  type CodexAppServerConnection,
} from "../adapters/codex/app-server.js";
import type { GuardEvaluation, GuardToolCall } from "../src/guard.js";
import { parseWorkerStartRequest } from "../src/host.js";
import { startWorkerAttempt } from "../src/workers.js";
import { CrewSupervisor, parseCrewPlan, type CrewWorkspaceProvider } from "../src/crew.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { human, testDigestScope, work, sandboxCapableCatalog } from "./helpers.js";

class TestQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  [Symbol.asyncIterator](): AsyncIterableIterator<T> { return this; }
  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

type Sent = Readonly<Record<string, unknown>>;
type Script = (message: Sent, connection: ScriptedConnection) => Promise<void> | void;

class ScriptedConnection implements CodexAppServerConnection {
  readonly sent: Sent[] = [];
  readonly #queue = new TestQueue<unknown>();
  readonly #script: Script;
  #closed = false;

  constructor(script: Script) { this.#script = script; }
  async send(message: Sent): Promise<void> {
    if (this.#closed) throw new Error("scripted connection closed");
    this.sent.push(message);
    await this.#script(message, this);
  }
  messages(): AsyncIterable<unknown> { return this.#queue; }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.close();
  }
  push(message: unknown): void { this.#queue.push(message); }
  end(): void { this.#queue.close(); }
}

test("model preflight checks all catalog pages and never starts inference or selects a fallback", async () => {
  for (const selected of ["model:available-hidden", "model:stale"]) {
    const connection = new ScriptedConnection((message, channel) => {
      if (message.method === "initialize") respond(channel, message, {});
      if (message.method === "config/read") respond(channel, message, { config: { model: selected } });
      if (message.method === "model/list") {
        const params = message.params as { cursor?: string; includeHidden: boolean };
        assert.equal(params.includeHidden, true);
        respond(channel, message, params.cursor ? { data: [{ id: "model:available-hidden", model: "model:available-hidden", isDefault: false }], nextCursor: null }
          : { data: [{ id: "model:default", model: "model:default", isDefault: true }], nextCursor: "page:2" });
      }
    });
    if (selected === "model:stale") await assert.rejects(preflightCodexModel({ connection }), /absent from the complete model catalog/);
    else assert.equal((await preflightCodexModel({ connection })).model, selected);
    assert.equal(connection.sent.some(message => message.method === "thread/start" || message.method === "turn/start"), false);
  }
});

function usageNotification(inputTokens: unknown, outputTokens: unknown, threadId = "thread:1", turnId = "turn:1") {
  return { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: {
    total: { inputTokens, outputTokens, cachedInputTokens: 5, reasoningOutputTokens: 3, totalTokens: 99 },
    last: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 2 },
    modelContextWindow: 1000,
  } } };
}

async function usageResult(notifications: unknown[], terminal = "completed") {
  let result;
  await withRoot(async root => {
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        // Real protocol updates can precede the turn/start response.
        for (const notification of notifications) self.push(notification);
        respond(self, message, turnResult());
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:usage", text: "measurement fixture" } } });
        if (terminal === "transport") { self.end(); return; }
        if (terminal === "local-cancel") return;
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: terminal, error: null } } });
        self.push(usageNotification(9999, 9999)); // Settled evidence is immutable.
      }
      if (method(message) === "turn/interrupt") respond(self, message, {});
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation() });
      if (terminal === "local-cancel") await started.handle.cancel("fixture cancellation");
      result = await started.handle.result();
    } finally { await host.close(); }
  });
  return result!;
}

test("Codex usage keeps the final correlated cumulative total exactly once", async () => {
  const result = await usageResult([
    usageNotification(9000, 9000, "unrelated"), usageNotification(9000, 9000, "thread:1", "other-turn"),
    usageNotification(10, 2), usageNotification(20, 7), usageNotification(20, 7),
  ]);
  assert.deepEqual((result as { observedUsage?: unknown }).observedUsage, { source: "provider-reported", complete: true, inputTokens: 20, outputTokens: 7 });
});

test("Codex usage preserves zero, missing, and invalid measurements distinctly", async () => {
  assert.deepEqual((await usageResult([usageNotification(0, 0)])).observedUsage,
    { source: "provider-reported", complete: true, inputTokens: 0, outputTokens: 0 });
  assert.equal((await usageResult([])).observedUsage, undefined);
  for (const invalid of [usageNotification(-1, 3), usageNotification(1.5, 3), usageNotification(Number.MAX_SAFE_INTEGER + 1, 3), usageNotification("2", 3), usageNotification(9, 1)]) {
    assert.equal((await usageResult([usageNotification(10, 2), invalid, usageNotification(20, 4)])).observedUsage, undefined);
  }
});

test("Codex failed and interrupted turns retain usage while transport and local cancellation remain partial", async () => {
  for (const terminal of ["failed", "interrupted", "transport", "local-cancel"]) {
    const result = await usageResult([usageNotification(10, 2)], terminal);
    assert.deepEqual(result.observedUsage, {
      source: "provider-reported", inputTokens: 10, outputTokens: 2,
      complete: terminal === "failed" || terminal === "interrupted",
    });
  }
});

function requestId(message: Sent): string | number | null {
  const value = message["id"];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function method(message: Sent): string | null {
  return typeof message["method"] === "string" ? message["method"] : null;
}

function respond(connection: ScriptedConnection, message: Sent, result: unknown): void {
  const id = requestId(message);
  assert.notEqual(id, null, "expected an RPC request id");
  connection.push({ id, result });
}

function threadResult(
  cwd: string,
  threadId = "thread:1",
  reasoningEffort: string | null = null,
) {
  return {
    thread: { id: threadId },
    model: "gpt-test",
    modelProvider: "openai",
    serviceTier: null,
    cwd,
    instructionSources: [],
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    reasoningEffort,
  };
}

function turnResult(turnId = "turn:1") {
  return { turn: { id: turnId, status: "inProgress" } };
}

function baseHandshake(message: Sent, connection: ScriptedConnection, cwd: string): boolean {
  if (method(message) === "initialize") {
    respond(connection, message, { userAgent: "fake-codex", codexHome: "/fake", platformFamily: "unix", platformOs: "test" });
    return true;
  }
  if (method(message) === "thread/start") {
    respond(connection, message, threadResult(cwd));
    return true;
  }
  return method(message) === "initialized";
}

function inputFor(root: string) {
  const contract = work();
  return parseWorkerStartRequest({
    work: contract,
    taskId: "task:codex",
    attemptId: "attempt:codex",
    objective: "make the bounded test change",
    authority: contract.authority,
    context: contract.context,
    contextPack: {
      id: "pack:codex",
      workId: contract.id,
      taskId: "task:codex",
      attemptId: "attempt:codex",
      strategy: "minimal",
      taskClass: "ship",
      fragments: [{
        kind: "included-file",
        marker: "file:src/context-proof.ts",
        tokenEstimate: 5,
        path: "src/context-proof.ts",
        content: "export const selectedContextProof = true;",
      }],
      totalTokens: 5,
      composedAt: "2026-08-20T16:00:00.000Z",
      markers: ["file:src/context-proof.ts"],
    },
    workspace: {
      workspaceId: "workspace:codex",
      leaseId: "lease:codex",
      uri: `file://${root}`,
      executionRoot: root,
      mode: "isolated-write",
      baseRevision: "0".repeat(40),
      expectedHead: "0".repeat(40),
      expectedDigest: `sha256:${"0".repeat(64)}`,
    },
  });
}

function mediation(decision: "allow" | "forbid" = "allow", calls: GuardToolCall[] = []) {
  return {
    async evaluate(call: GuardToolCall): Promise<GuardEvaluation> {
      calls.push(call);
      return {
        request: {
          ...call,
          workId: "work:1",
          taskId: "task:codex",
          attemptId: "attempt:codex",
          actor: { id: "worker:codex-app-server", kind: "agent" },
          writeScope: "workspace",
          contextHash: "test:codex-app-server",
          evidenceRefs: [],
          timestampMs: 1_700_000_000_000,
        },
        verdict: {
          requestId: call.requestId,
          decision,
          rationale: `test ${decision}`,
          riskLevel: decision === "allow" ? "medium" : "critical",
          ruleHits: ["test"],
          policyBackend: "test",
          evaluatedAt: "2023-11-14T22:13:20.000Z",
          durationMs: 0,
        },
      };
    },
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "rhiz-codex-app-server-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function runFileApprovalScenario(root: string, lifecycle: readonly unknown[]) {
  let approval: unknown;
  const calls: GuardToolCall[] = [];
  const connection = new ScriptedConnection((message, self) => {
    if (baseHandshake(message, self, root)) return;
    if (method(message) === "turn/start") {
      respond(self, message, turnResult());
      for (const event of lifecycle) self.push(event);
      self.push({
        id: "approval:scenario",
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread:1", turnId: "turn:1", itemId: "file:scenario", startedAtMs: 1 },
      });
      return;
    }
    if (requestId(message) === "approval:scenario" && message["result"] !== undefined) {
      approval = message["result"];
      self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:scenario", text: "scenario settled" } } });
      self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
    }
  });
  const host = new CodexAppServerHost({ connectionFactory: () => connection });
  try {
    const started = await startWorkerAttempt(
      host.workers().get("worker:codex-app-server")!,
      inputFor(root),
      { guardedToolMediation: mediation("allow", calls) },
    );
    const result = await started.handle.result();
    return { approval, calls, result };
  } finally {
    await host.close();
  }
}

test("notifications arriving before turn/start response preserve the final agent message", async () => {
  await withRoot(async (root) => {
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        self.push({ method: "item/agentMessage/delta", params: { threadId: "thread:1", turnId: "turn:1", itemId: "message:1", delta: "early " } });
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:1", text: "early final message" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
        respond(self, message, turnResult());
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const provider = host.workers().get("worker:codex-app-server")!;
      const started = await startWorkerAttempt(provider, inputFor(root), { guardedToolMediation: mediation() });
      const result = await started.handle.result();
      assert.equal(result.status, "finished");
      assert.equal(result.summary, "early final message");
      assert.deepEqual(result.runtime, { model: "gpt-test" });
    } finally {
      await host.close();
    }
  });
});

test("provider-observed reasoning effort survives into WorkerResult", async () => {
  await withRoot(async (root) => {
    const connection = new ScriptedConnection((message, self) => {
      if (method(message) === "initialize") {
        respond(self, message, {
          userAgent: "fake-codex",
          codexHome: "/fake",
          platformFamily: "unix",
          platformOs: "test",
        });
        return;
      }
      if (method(message) === "initialized") return;
      if (method(message) === "thread/start") {
        respond(self, message, threadResult(root, "thread:1", "high"));
        return;
      }
      if (method(message) === "turn/start") {
        respond(self, message, turnResult());
        self.push({
          method: "item/completed",
          params: {
            threadId: "thread:1",
            turnId: "turn:1",
            item: {
              type: "agentMessage",
              id: "message:runtime",
              text: "runtime recorded",
            },
          },
        });
        self.push({
          method: "turn/completed",
          params: {
            threadId: "thread:1",
            turn: {
              id: "turn:1",
              status: "completed",
              error: null,
            },
          },
        });
      }
    });
    const host = new CodexAppServerHost({
      connectionFactory: () => connection,
    });
    try {
      const started = await startWorkerAttempt(
        host.workers().get("worker:codex-app-server")!,
        inputFor(root),
        { guardedToolMediation: mediation() },
      );
      const result = await started.handle.result();
      assert.deepEqual(result.runtime, {
        model: "gpt-test",
        effortLevel: "high",
      });
    } finally {
      await host.close();
    }
  });
});

test("wrong-turn completion cannot settle the attempt", async () => {
  await withRoot(async (root) => {
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        assert.match(JSON.stringify(message), /selectedContextProof/);
        respond(self, message, turnResult());
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:wrong", status: "completed", error: null } } });
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:1", text: "correct turn survived" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation() });
      const result = await started.handle.result();
      assert.equal(result.status, "finished");
      assert.equal(result.summary, "correct turn survived");
    } finally { await host.close(); }
  });
});

test("a concrete in-scope fileChange can be approved through Guard even when the new file does not exist yet", async () => {
  await withRoot(async (root) => {
    let approval: unknown;
    const calls: GuardToolCall[] = [];
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        respond(self, message, turnResult());
        self.push({ method: "item/started", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "fileChange", id: "file:1", changes: [{ path: "src/new-file.ts", kind: { type: "add" }, diff: "+export const value = 1;" }] } } });
        self.push({ id: "approval:1", method: "item/fileChange/requestApproval", params: { threadId: "thread:1", turnId: "turn:1", itemId: "file:1", startedAtMs: 1 } });
        return;
      }
      if (requestId(message) === "approval:1" && message["result"] !== undefined) {
        approval = message["result"];
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:1", text: "write approved" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation("allow", calls) });
      const result = await started.handle.result();
      assert.equal(result.status, "finished");
      assert.deepEqual(approval, { decision: "accept" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.tool.name, "codex:file-change");
      assert.equal(calls[0]?.tool.category, "write");
      assert.deepEqual(calls[0]?.tool.args, {
        changes: [{
          path: join(root, "src/new-file.ts"),
          kind: "add",
          diffDigest: `sha256:${createHash("sha256").update("+export const value = 1;").digest("hex")}`,
        }],
      });
    } finally { await host.close(); }
  });
});

test("an out-of-scope fileChange is declined before Guard sees it", async () => {
  await withRoot(async (root) => {
    let approval: unknown;
    const calls: GuardToolCall[] = [];
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        respond(self, message, turnResult());
        self.push({ method: "item/started", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "fileChange", id: "file:escape", changes: [{ path: "outside.ts", kind: "add", diff: "+escape" }] } } });
        self.push({ id: "approval:escape", method: "item/fileChange/requestApproval", params: { threadId: "thread:1", turnId: "turn:1", itemId: "file:escape", startedAtMs: 1 } });
        return;
      }
      if (requestId(message) === "approval:escape" && message["result"] !== undefined) {
        approval = message["result"];
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:1", text: "escape refused" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation("allow", calls) });
      await started.handle.result();
      assert.deepEqual(approval, { decision: "decline" });
      assert.equal(calls.length, 0);
    } finally { await host.close(); }
  });
});

test("command escalation is declined even when the supplied Guard fixture would allow it", async () => {
  await withRoot(async (root) => {
    let approval: unknown;
    const calls: GuardToolCall[] = [];
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        respond(self, message, turnResult());
        self.push({ id: "approval:command", method: "item/commandExecution/requestApproval", params: { threadId: "thread:1", turnId: "turn:1", itemId: "command:1", startedAtMs: 1, kind: "command", command: "git push", cwd: root } });
        return;
      }
      if (requestId(message) === "approval:command" && message["result"] !== undefined) {
        approval = message["result"];
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:1", text: "command refused" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation("allow", calls) });
      await started.handle.result();
      assert.deepEqual(approval, { decision: "decline" });
      assert.equal(calls[0]?.tool.category, "shell");
    } finally { await host.close(); }
  });
});

test("unexpected App Server EOF settles the worker as failed instead of hanging", async () => {
  await withRoot(async (root) => {
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        respond(self, message, turnResult());
        queueMicrotask(() => self.end());
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation() });
      const result = await started.handle.result();
      assert.equal(result.status, "failed");
      assert.match(result.summary, /transport failed|connection ended/i);
    } finally { await host.close(); }
  });
});

test("cancellation preserves partial usage before Crew cleanup closes even when turn/interrupt never answers", async () => {
  for (const pendingSend of [false, true]) {
    await withRoot(async (root) => {
      let releaseSend!: () => void;
      const sent = new Promise<void>(resolve => { releaseSend = resolve; });
      const connection = new ScriptedConnection((message, self) => {
        if (baseHandshake(message, self, root)) return;
        if (method(message) === "turn/start") {
          self.push(usageNotification(10, 2));
          respond(self, message, turnResult());
        }
        // Deliberately never respond, and also exercise a send callback still pending.
        if (method(message) === "turn/interrupt" && pendingSend) return sent;
      });
      const host = new CodexAppServerHost({ connectionFactory: () => connection });
      try {
        const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation() });
        const cancelling = started.handle.cancel("test cancel");
        let timer: NodeJS.Timeout | undefined;
        try {
          // Crew's existing cancellation custody closes after 100 ms. Provider
          // transport acknowledgement must not hide an already observed snapshot.
          const result = await Promise.race([
            started.handle.result(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("observed usage missed Crew cleanup custody")), 100);
            }),
          ]);
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(result.status, "cancelled");
          assert.deepEqual(result.observedUsage, {
            source: "provider-reported", complete: false, inputTokens: 10, outputTokens: 2,
          });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          releaseSend();
          await cancelling;
        }
      } finally { await host.close(); }
    });
  }
});

test("real Codex adapter preserves partial usage through Crew deadline and late interrupt replies", async () => {
  for (const reply of ["never", "late"] as const) {
    await withRoot(async root => {
      let interruptRequest: Sent | undefined;
      const connection = new ScriptedConnection((message, self) => {
        if (baseHandshake(message, self, root)) return;
        if (method(message) === "turn/start") {
          self.push(usageNotification(10, 2));
          respond(self, message, turnResult());
        }
        if (method(message) === "turn/interrupt") interruptRequest = message;
      });
      const host = new CodexAppServerHost({ connectionFactory: () => connection });
      const ledger = new InMemoryEventLedger();
      const contract = work({ workerPolicy: {
        preferredProviders: ["worker:codex-app-server"], maxAttempts: 1,
        allowParallelAttempts: false, explicitProviderAuthorizations: [], attemptBudgetMs: 150,
      } });
      const workspaceProvider: CrewWorkspaceProvider = {
        id: "workspace:codex",
        acquire: async request => ({ leaseId: "lease:codex", workspaceId: "workspace:codex", uri: `file://${root}`,
          executionRoot: root, baseRevision: request.baseRevision, mode: request.mode }),
        snapshot: async workspace => ({ workspaceId: workspace.workspaceId, head: workspace.baseRevision,
          digest: "sha256:clean", digestScope: testDigestScope, changedPaths: [], observedAt: new Date().toISOString() }),
        release: async () => {}, close: async () => {},
      };
      try {
        const run = await new CrewSupervisor({
          plan: parseCrewPlan({ id: "crew:codex-deadline", objective: "Retain observed usage", baseRevision: "0".repeat(40),
            maxParallel: 1, missions: [{ work: contract, workspace: { strategy: "fresh", mode: "isolated-write" } }] }),
          ledger, workspaceProvider, actor: human,
          workerCatalog: sandboxCapableCatalog(host.workers().get("worker:codex-app-server")!),
        }).run();
        try {
          assert.ok(interruptRequest, "the real adapter cancellation path must execute");
          const usage = { source: "provider-reported", complete: false, inputTokens: 10, outputTokens: 2 };
          assert.equal(run.receipt.missions[0]?.status, "failed");
          assert.deepEqual(run.receipt.missions[0]?.workerResult?.observedUsage, usage);
          const events = await ledger.replay("stream:work:1");
          const failures = events.filter(event => event.type === "attempt.failed");
          assert.equal(failures.length, 1);
          assert.deepEqual(failures[0]?.payload.observedUsage, usage);
          assert.equal(events.some(event => event.type === "attempt.finished"), false);
          const frozen = JSON.stringify(events);
          if (reply === "late") respond(connection, interruptRequest, {});
          connection.push(usageNotification(99, 9));
          connection.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(JSON.stringify(await ledger.replay("stream:work:1")), frozen);
          assert.deepEqual(run.receipt.missions[0]?.workerResult?.observedUsage, usage);
        } finally { await run.close(); }
      } finally { await host.close(); }
    });
  }
});

test("thread cwd mismatch is refused before a WorkerHandle is published", async () => {
  await withRoot(async (root) => {
    const connection = new ScriptedConnection((message, self) => {
      if (method(message) === "initialize") respond(self, message, { userAgent: "fake" });
      else if (method(message) === "thread/start") respond(self, message, threadResult(tmpdir()));
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      await assert.rejects(
        () => startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation() }),
        /does not match WorkspaceBinding/,
      );
    } finally { await host.close(); }
  });
});

test("a v2 fileChange observed before turn/start confirmation is available to the later approval", async () => {
  await withRoot(async (root) => {
    let approval: unknown;
    const calls: GuardToolCall[] = [];
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        self.push({ method: "item/started", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "fileChange", id: "file:early", changes: [{ path: "src/early.ts", kind: { type: "add" }, diff: "+early" }] } } });
        respond(self, message, turnResult());
        self.push({ id: "approval:early", method: "item/fileChange/requestApproval", params: { threadId: "thread:1", turnId: "turn:1", itemId: "file:early", startedAtMs: 1 } });
        return;
      }
      if (requestId(message) === "approval:early" && message["result"] !== undefined) {
        approval = message["result"];
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:early", text: "early write approved" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation("allow", calls) });
      await started.handle.result();
      assert.deepEqual(approval, { decision: "accept" });
      assert.equal(calls.length, 1);
    } finally { await host.close(); }
  });
});

test("approval before a concrete fileChange lifecycle item is declined before Guard", async () => {
  await withRoot(async (root) => {
    const scenario = await runFileApprovalScenario(root, []);
    assert.deepEqual(scenario.approval, { decision: "decline" });
    assert.equal(scenario.calls.length, 0);
  });
});

test("a completed fileChange cannot be authorized after the effect boundary", async () => {
  await withRoot(async (root) => {
    const item = { type: "fileChange", id: "file:scenario", changes: [{ path: "src/late.ts", kind: { type: "add" }, diff: "+late" }] };
    const scenario = await runFileApprovalScenario(root, [
      { method: "item/started", params: { threadId: "thread:1", turnId: "turn:1", item } },
      { method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item } },
    ]);
    assert.deepEqual(scenario.approval, { decision: "decline" });
    assert.equal(scenario.calls.length, 0);
  });
});

test("duplicate approval requests consume one concrete proposal and reach Guard once", async () => {
  await withRoot(async (root) => {
    const approvals = new Map<string, unknown>();
    const calls: GuardToolCall[] = [];
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        respond(self, message, turnResult());
        self.push({
          method: "item/started",
          params: {
            threadId: "thread:1",
            turnId: "turn:1",
            item: { type: "fileChange", id: "file:duplicate", changes: [{ path: "src/duplicate.ts", kind: { type: "add" }, diff: "+once" }] },
          },
        });
        for (const id of ["approval:first", "approval:duplicate"]) {
          self.push({
            id,
            method: "item/fileChange/requestApproval",
            params: { threadId: "thread:1", turnId: "turn:1", itemId: "file:duplicate", startedAtMs: 1 },
          });
        }
        return;
      }
      const id = requestId(message);
      if (typeof id === "string" && id.startsWith("approval:") && message["result"] !== undefined) {
        approvals.set(id, message["result"]);
        if (approvals.size === 2) {
          self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:duplicate", text: "duplicate settled" } } });
          self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
        }
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation("allow", calls) });
      await started.handle.result();
      assert.deepEqual(approvals.get("approval:first"), { decision: "accept" });
      assert.deepEqual(approvals.get("approval:duplicate"), { decision: "decline" });
      assert.equal(calls.length, 1);
    } finally { await host.close(); }
  });
});

test("malformed v2 patch kinds remain fail-closed", async () => {
  await withRoot(async (root) => {
    const scenario = await runFileApprovalScenario(root, [{
      method: "item/started",
      params: { threadId: "thread:1", turnId: "turn:1", item: { type: "fileChange", id: "file:scenario", changes: [{ path: "src/malformed.ts", kind: { type: "update" }, diff: "+malformed" }] } },
    }]);
    assert.deepEqual(scenario.approval, { decision: "decline" });
    assert.equal(scenario.calls.length, 0);
  });
});

test("a wrong-turn fileChange cannot authorize a correct-turn approval", async () => {
  await withRoot(async (root) => {
    const scenario = await runFileApprovalScenario(root, [{
      method: "item/started",
      params: { threadId: "thread:1", turnId: "turn:wrong", item: { type: "fileChange", id: "file:scenario", changes: [{ path: "src/wrong.ts", kind: { type: "add" }, diff: "+wrong" }] } },
    }]);
    assert.deepEqual(scenario.approval, { decision: "decline" });
    assert.equal(scenario.calls.length, 0);
  });
});

test("an absolute-path escape is declined before Guard", async () => {
  await withRoot(async (root) => {
    const scenario = await runFileApprovalScenario(root, [{
      method: "item/started",
      params: { threadId: "thread:1", turnId: "turn:1", item: { type: "fileChange", id: "file:scenario", changes: [{ path: join(tmpdir(), "rhiz-escape.ts"), kind: { type: "add" }, diff: "+escape" }] } },
    }]);
    assert.deepEqual(scenario.approval, { decision: "decline" });
    assert.equal(scenario.calls.length, 0);
  });
});

test("a symlinked Work write root escaping the workspace is refused before Codex starts", async () => {
  const outside = await mkdtemp(join(tmpdir(), "rhiz-codex-outside-"));
  try {
    await withRoot(async (root) => {
      await symlink(outside, join(root, "src"));
      const host = new CodexAppServerHost({ connectionFactory: () => new ScriptedConnection(() => undefined) });
      try {
        await assert.rejects(
          () => startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation() }),
          /resolves outside execution root/,
        );
      } finally { await host.close(); }
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("duplicate correct-turn completion cannot overwrite the first terminal result", async () => {
  await withRoot(async (root) => {
    const connection = new ScriptedConnection((message, self) => {
      if (baseHandshake(message, self, root)) return;
      if (method(message) === "turn/start") {
        respond(self, message, turnResult());
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:first", text: "first terminal result" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "completed", error: null } } });
        self.push({ method: "item/completed", params: { threadId: "thread:1", turnId: "turn:1", item: { type: "agentMessage", id: "message:second", text: "overwritten result" } } });
        self.push({ method: "turn/completed", params: { threadId: "thread:1", turn: { id: "turn:1", status: "failed", error: "late" } } });
      }
    });
    const host = new CodexAppServerHost({ connectionFactory: () => connection });
    try {
      const started = await startWorkerAttempt(host.workers().get("worker:codex-app-server")!, inputFor(root), { guardedToolMediation: mediation() });
      const result = await started.handle.result();
      assert.equal(result.status, "finished");
      assert.equal(result.summary, "first terminal result");
    } finally { await host.close(); }
  });
});
