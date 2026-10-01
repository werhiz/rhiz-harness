// Execution-integrity regression protections for dormant DSH composition.
//
// Dormancy is enforced by overriding the execution surface of a prerelease base
// class, so these tests assert the guard rather than the override.
//
// The base ships ABSTRACT: upstream declares resolveExecutable, spawn, and
// spawnTerminal as `abstract`, which emit no runtime body, so the real
// prototype carries only `constructor`. Every fixture here used to be concrete,
// which is how the suite stayed green while CI could not compose against the
// actual dependency. AbstractSubprocessBase now pins the real shape.
//
// Issue #19. Review: docs/reviews/2026-08-20-stack-review.md

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDormantOverridesEngaged,
  createDshInProcessSubagentRuntime,
  DshDormantCompositionError,
  DORMANT_REQUIRED_OVERRIDES,
} from "../adapters/dsh/product-runtime.js";
import type { DshProductModuleLoader } from "../adapters/dsh/product-runtime.js";

class RealisticSubprocessBase {
  async resolveExecutable(): Promise<string> { return "/usr/bin/true"; }
  spawn(): { pid: number } { return { pid: 1 }; }
  async spawnTerminal(): Promise<{ pid: number }> { return { pid: 2 }; }
}

/**
 * The shape upstream actually ships: an abstract class whose execution surface
 * exists only in its type declarations. Prototype carries `constructor` alone.
 */
class AbstractSubprocessBase {}

/** Upstream drift: half the execution surface implemented, half absent. */
class PartiallyImplementedBase {
  async resolveExecutable(): Promise<string> { return "/usr/bin/true"; }
}

class FakeContext {
  readonly subagents = {
    list: () => ["rhiz-codex"],
    start: async () => ({ id: "run:1", result: Promise.resolve({ stopReason: "completed", output: [] }), dispose: () => {} }),
  };
  plugin(): { dispose: () => void } { return { dispose: () => {} }; }
  dispose(): void {}
}

function loaderFor(SubprocessBase: unknown): DshProductModuleLoader {
  return async (specifier: string) => {
    switch (specifier) {
      case "@deepseek-ai/cordis": return { Context: FakeContext };
      case "@deepseek-ai/dsh-subprocess": return { default: SubprocessBase };
      case "@deepseek-ai/dsh-subagent": return { default: () => {} };
      case "@deepseek-ai/dsh-subagent-codex": return { default: () => {} };
      default: return { default: () => {} };
    }
  };
}

const routes = [{ product: "codex" as const, providerName: "rhiz-codex", workerId: "worker:codex" }];

test("dormant composition mounts when every guarded upstream method is present", async () => {
  const runtime = await createDshInProcessSubagentRuntime(routes, {
    loadModule: loaderFor(RealisticSubprocessBase),
    subprocessMode: "dormant",
  });
  assert.deepEqual([...runtime.listProviders()], ["rhiz-codex"]);
  await runtime.close();
});

test("dormant composition refuses to mount when an overridden method was renamed upstream", async () => {
  // The exact upstream drift that previously turned every override into dead
  // code while the composition still reported itself as dormant.
  class RenamedUpstream {
    async resolveExecutable(): Promise<string> { return "/usr/bin/true"; }
    async spawnTerminal(): Promise<{ pid: number }> { return { pid: 2 }; }
    // `spawn` was renamed to `launchProcess`.
    launchProcess(): { pid: number } { return { pid: 3 }; }
  }

  await assert.rejects(
    () => createDshInProcessSubagentRuntime(routes, {
      loadModule: loaderFor(RenamedUpstream),
      subprocessMode: "dormant",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // A rename leaves the execution surface half implemented, which is the
      // signature the partial-implementation check exists to catch. Were the
      // base abstract instead, the same rename would be refused by the
      // unguarded-path scan, since `launchProcess` is execution-named.
      assert.match(
        String((error as { cause?: unknown }).cause ?? error),
        /implements resolveExecutable, spawnTerminal but not spawn/,
      );
      return true;
    },
  );
});

test("dormant composition mounts against the abstract base upstream actually ships", async () => {
  // The regression this suite was missing. Every fixture was concrete, so the
  // guard's requirement that the base implement the surface looked satisfiable
  // while the real dependency could never satisfy it.
  assert.deepEqual(
    Object.getOwnPropertyNames(AbstractSubprocessBase.prototype),
    ["constructor"],
    "fixture must match the real upstream shape: no execution bodies on the prototype",
  );

  const runtime = await createDshInProcessSubagentRuntime(routes, {
    loadModule: loaderFor(AbstractSubprocessBase),
    subprocessMode: "dormant",
  });
  assert.deepEqual([...runtime.listProviders()], ["rhiz-codex"]);
  await runtime.close();
});

test("dormant composition refuses a base that implements only part of the execution surface", async () => {
  await assert.rejects(
    () => createDshInProcessSubagentRuntime(routes, {
      loadModule: loaderFor(PartiallyImplementedBase),
      subprocessMode: "dormant",
    }),
    (error: unknown) => {
      assert.match(
        String((error as { cause?: unknown }).cause ?? error),
        /implements resolveExecutable but not spawn, spawnTerminal/,
      );
      return true;
    },
  );
});

test("dormant composition refuses a renamed execution path on an abstract base", async () => {
  // The abstract-base half of the rename case: nothing is implemented, so the
  // partial check is silent and the unguarded-path scan is the only thing
  // standing between a renamed spawn and a mounted composition.
  class RenamedOnAbstractBase {
    launchProcess(): { pid: number } { return { pid: 5 }; }
  }

  await assert.rejects(
    () => createDshInProcessSubagentRuntime(routes, {
      loadModule: loaderFor(RenamedOnAbstractBase),
      subprocessMode: "dormant",
    }),
    (error: unknown) => {
      assert.match(String((error as { cause?: unknown }).cause ?? error), /unguarded execution path\(s\) launchProcess/);
      return true;
    },
  );
});

test("dormant composition refuses an upstream execution path it does not override", async () => {
  class ExtraPathUpstream extends RealisticSubprocessBase {
    // A new spawn path added upstream that our overrides do not cover.
    execCommand(): { pid: number } { return { pid: 4 }; }
  }

  await assert.rejects(
    () => createDshInProcessSubagentRuntime(routes, {
      loadModule: loaderFor(ExtraPathUpstream),
      subprocessMode: "dormant",
    }),
    (error: unknown) => {
      assert.match(String((error as { cause?: unknown }).cause ?? error), /unguarded execution path\(s\) execCommand/);
      return true;
    },
  );
});

test("the engagement self-test rejects a subclass whose override resolves upstream", () => {
  class NotOverridden extends RealisticSubprocessBase {}
  assert.throws(
    () => assertDormantOverridesEngaged(RealisticSubprocessBase, NotOverridden),
    DshDormantCompositionError,
  );

  class Overridden extends RealisticSubprocessBase {
    override async resolveExecutable(): Promise<string> { throw new Error("denied"); }
    override spawn(): never { throw new Error("denied"); }
    override async spawnTerminal(): Promise<never> { throw new Error("denied"); }
  }
  assert.doesNotThrow(() => assertDormantOverridesEngaged(RealisticSubprocessBase, Overridden));
  assert.deepEqual([...DORMANT_REQUIRED_OVERRIDES], ["resolveExecutable", "spawn", "spawnTerminal"]);
});
