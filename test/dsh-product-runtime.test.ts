import assert from "node:assert/strict";
import test from "node:test";
import type { DshProductRoute } from "../adapters/dsh/product-routes.js";
import { createDefaultDshProductRoutes } from "../adapters/dsh/product-routes.js";
import {
  createDshInProcessSubagentRuntime,
  type DshProductModuleLoader,
} from "../adapters/dsh/product-runtime.js";

interface MountedProduct {
  kind: "codex" | "claude";
  config: Record<string, unknown>;
}

class FakeContext {
  static instances: FakeContext[] = [];
  readonly providers = new Map<string, MountedProduct>();
  readonly mounts: Array<{ plugin: unknown; config: unknown }> = [];
  readonly starts: Array<{ name: string; request: Record<string, unknown> }> = [];
  disposeCalls = 0;
  subagents: {
    list: () => string[];
    start: (name: string, request: unknown) => Promise<unknown>;
  } | undefined;

  constructor() {
    FakeContext.instances.push(this);
  }

  plugin(plugin: unknown, config?: unknown): void {
    this.mounts.push({ plugin, config });
    const value = plugin as { kind?: string };
    if (value.kind === "subagent-base") {
      this.subagents = {
        list: () => [...this.providers.keys()],
        start: async (name, rawRequest) => {
          const request = rawRequest as Record<string, unknown>;
          if (!this.providers.has(name)) throw new Error(`provider ${name} unavailable`);
          this.starts.push({ name, request });
          return {
            id: `run:${name}:${this.starts.length}`,
            result: Promise.resolve({
              stopReason: "completed",
              output: [
                { type: "reasoning", text: "private reasoning" },
                { type: "text", text: `${name} final answer` },
              ],
            }),
            async dispose() {},
          };
        },
      };
      return;
    }
    if (value.kind === "codex" || value.kind === "claude") {
      const resolved = config as Record<string, unknown>;
      const providerName = resolved.providerName;
      if (typeof providerName !== "string") throw new Error("providerName missing");
      this.providers.set(providerName, {
        kind: value.kind,
        config: resolved,
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

/**
 * Stands in for the real upstream SubprocessRuntime. It must actually define
 * the execution methods dormancy overrides, otherwise the dormant proof is
 * vacuous: an empty base cannot spawn whether or not we override anything.
 */
class FakeSubprocessBase {
  async resolveExecutable(): Promise<string> {
    return "/usr/bin/true";
  }

  spawn(): { pid: number } {
    return { pid: 1 };
  }

  async spawnTerminal(): Promise<{ pid: number }> {
    return { pid: 2 };
  }
}

function loader(options: { omitClaudeRegistration?: boolean } = {}): {
  load: DshProductModuleLoader;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const load: DshProductModuleLoader = async (specifier) => {
    counts.set(specifier, (counts.get(specifier) ?? 0) + 1);
    switch (specifier) {
      case "@deepseek-ai/cordis":
        return { Context: FakeContext };
      case "@deepseek-ai/dsh-subagent":
        return { default: { kind: "subagent-base" } };
      case "@deepseek-ai/dsh-subprocess":
        return { default: FakeSubprocessBase };
      case "@deepseek-ai/dsh-subprocess-local":
        return { default: { kind: "subprocess" } };
      case "@deepseek-ai/dsh-subagent-codex":
        return { kind: "codex", apply() {} };
      case "@deepseek-ai/dsh-subagent-claude-code":
        return options.omitClaudeRegistration
          ? { kind: "ignored", apply() {} }
          : { kind: "claude", apply() {} };
      default:
        throw new Error(`unexpected module ${specifier}`);
    }
  };
  return { load, counts };
}

test("the in-process bridge mounts real DSH seams as dormant named providers", async () => {
  FakeContext.instances = [];
  const { load, counts } = loader();
  const routes = createDefaultDshProductRoutes({
    codexEnv: { OPENAI_API_KEY: "codex-secret" },
    claudeEnv: { ANTHROPIC_API_KEY: "claude-secret" },
  });
  const runtime = await createDshInProcessSubagentRuntime(routes, {
    loadModule: load,
    subprocessMode: "dormant",
  });
  const context = FakeContext.instances[0]!;

  assert.deepEqual(runtime.listProviders(), ["rhiz-codex", "rhiz-claude"]);
  assert.equal(context.starts.length, 0, "composition registers dormant providers without starting products");
  assert.equal(counts.get("@deepseek-ai/dsh-subprocess"), 1);
  assert.equal(counts.get("@deepseek-ai/dsh-subprocess-local"), undefined);
  assert.equal(counts.get("@deepseek-ai/dsh-subagent-codex"), 1);
  assert.equal(counts.get("@deepseek-ai/dsh-subagent-claude-code"), 1);
  assert.equal(context.providers.get("rhiz-codex")!.config.permissionMode, "never");
  assert.equal(context.providers.get("rhiz-claude")!.config.permissionMode, "dontAsk");
  assert.deepEqual(context.providers.get("rhiz-codex")!.config.env, { OPENAI_API_KEY: "codex-secret" });
  assert.deepEqual(context.providers.get("rhiz-claude")!.config.env, { ANTHROPIC_API_KEY: "claude-secret" });

  await runtime.close();
  assert.equal(context.disposeCalls, 1);
});

test("local execution mode mounts the native subprocess provider", async () => {
  FakeContext.instances = [];
  const { load, counts } = loader();
  const runtime = await createDshInProcessSubagentRuntime(createDefaultDshProductRoutes(), {
    loadModule: load,
    subprocessMode: "local",
  });
  assert.equal(counts.get("@deepseek-ai/dsh-subprocess-local"), 1);
  assert.equal(counts.get("@deepseek-ai/dsh-subprocess"), undefined);
  await runtime.close();
});

test("the bridge calls a named provider directly and maps only final text", async () => {
  FakeContext.instances = [];
  const { load } = loader();
  const runtime = await createDshInProcessSubagentRuntime(createDefaultDshProductRoutes(), {
    loadModule: load,
  });
  const controller = new AbortController();
  const run = await runtime.start("rhiz-codex", {
    attemptId: "attempt:direct",
    cwd: "/workspace",
    label: "SCOUT work:direct",
    prompt: "bounded task",
    signal: controller.signal,
  });
  const result = await run.result;
  assert.deepEqual(result, {
    stopReason: "completed",
    outputText: "rhiz-codex final answer",
  });
  const context = FakeContext.instances[0]!;
  assert.equal(context.starts[0]!.name, "rhiz-codex");
  const parent = context.starts[0]!.request.parent as { session: { header: { cwd: string } } };
  assert.equal(parent.session.header.cwd, "/workspace");
  await run.dispose();
  await runtime.close();
});

test("multiple named instances reuse one loaded product module", async () => {
  FakeContext.instances = [];
  const { load, counts } = loader();
  const routes: DshProductRoute[] = [
    { product: "codex", workerId: "worker:codex-safe", providerName: "codex-safe" },
    {
      product: "codex",
      workerId: "worker:codex-bypass",
      providerName: "codex-bypass",
      permissionMode: "dangerously-bypass-approvals-and-sandbox",
    },
  ];
  const runtime = await createDshInProcessSubagentRuntime(routes, { loadModule: load });
  assert.deepEqual(runtime.listProviders(), ["codex-safe", "codex-bypass"]);
  assert.equal(counts.get("@deepseek-ai/dsh-subagent-codex"), 1);
  await runtime.close();
});

test("composition fails closed when a product module does not register its provider", async () => {
  FakeContext.instances = [];
  const { load } = loader({ omitClaudeRegistration: true });
  await assert.rejects(
    () => createDshInProcessSubagentRuntime(createDefaultDshProductRoutes(), { loadModule: load }),
    /did not register providers: rhiz-claude/,
  );
  assert.ok(FakeContext.instances[0]!.disposeCalls >= 1);
});

test("composition rejects an incompatible Cordis module before publishing a runtime", async () => {
  const load: DshProductModuleLoader = async (specifier) => (
    specifier === "@deepseek-ai/cordis" ? {} : { default: {} }
  );
  await assert.rejects(
    () => createDshInProcessSubagentRuntime(createDefaultDshProductRoutes(), { loadModule: load }),
    /did not expose Context/,
  );
});
