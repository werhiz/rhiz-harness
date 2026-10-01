import type {
  DshProductRoute,
  DshSubagentRun,
  DshSubagentRuntime,
  DshSubagentStartRequest,
  ResolvedDshProductRoute,
} from "./product-routes.js";
import {
  createDefaultDshProductRoutes,
  DshProductWorkerHost,
  resolveDshProductRoutes,
} from "./product-routes.js";

const DSH_MODULES = {
  cordis: "@deepseek-ai/cordis",
  subagent: "@deepseek-ai/dsh-subagent",
  subprocess: "@deepseek-ai/dsh-subprocess",
  subprocessLocal: "@deepseek-ai/dsh-subprocess-local",
  codex: "@deepseek-ai/dsh-subagent-codex",
  claude: "@deepseek-ai/dsh-subagent-claude-code",
} as const;

export type DshProductModuleLoader = (specifier: string) => Promise<unknown>;
export type DshSubprocessMode = "local" | "dormant";

interface CordisFiberLike {
  dispose(): Promise<void> | void;
}

interface CordisContextLike {
  plugin(plugin: unknown, config?: unknown): unknown;
  dispose?(): Promise<void> | void;
  subagents?: {
    list(): string[];
    start(name: string, request: unknown): Promise<unknown>;
  };
}

interface CordisContextConstructor {
  new(): CordisContextLike;
}

interface RawSubagentRun {
  id: string;
  result: Promise<unknown>;
  dispose(): Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function moduleRecord(value: unknown, specifier: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`DSH module ${specifier} did not expose a module namespace`);
  return value;
}

function modulePlugin(value: unknown, specifier: string): unknown {
  const record = moduleRecord(value, specifier);
  return record.default ?? record;
}

function contextConstructor(value: unknown): CordisContextConstructor {
  const record = moduleRecord(value, DSH_MODULES.cordis);
  if (typeof record.Context !== "function") {
    throw new Error(`DSH module ${DSH_MODULES.cordis} did not expose Context`);
  }
  return record.Context as CordisContextConstructor;
}

export class DshDormantCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshDormantCompositionError";
  }
}

/**
 * The execution surface dormancy is responsible for. Our subclass defines all
 * three so a caller reaching one gets a named refusal rather than a TypeError.
 *
 * These are NOT required to exist on the base prototype. Upstream ships
 * `SubprocessRuntime` as an ABSTRACT class: the three names are `abstract`
 * declarations in its type surface and emit no runtime body, so its prototype
 * carries only `constructor`. Requiring them there could never pass against the
 * real dependency, and did not; see the abstract-base fixture in
 * test/dormant-composition.test.ts.
 *
 * Dormancy is still checked, by three separate facts:
 *
 *   1. An abstract base has no inherited implementation to fall through to, so
 *      there is nothing for a dead override to re-expose.
 *   2. EXECUTION_METHOD_PATTERN refuses any execution-named prototype method we
 *      do not override, which is what catches an upstream rename: `spawn`
 *      renamed to `launchProcess` is still execution-named and still refused.
 *   3. assertDormantOverridesEngaged proves each guarded name resolves to our
 *      implementation rather than an inherited one.
 *
 * A rename to a name that escapes the pattern fails closed rather than open:
 * callers invoke a name neither we nor the abstract base implement, which is a
 * TypeError, not a spawn.
 */
export const DORMANT_REQUIRED_OVERRIDES = Object.freeze([
  "resolveExecutable",
  "spawn",
  "spawnTerminal",
]);

/**
 * Any additional upstream PROTOTYPE method whose name suggests it can reach a
 * process. A new spawn path added upstream on the prototype fails composition
 * loudly rather than quietly becoming an unguarded hole.
 *
 * Two limits, both real and neither closed here:
 *
 *   - It scans the prototype chain only. An execution path assigned in the
 *     constructor (`this.spawnWorker = ...`) is invisible to this check whatever
 *     it is named, so `spawnWorker` on the prototype is refused while the same
 *     function assigned as an instance field composes and reports itself
 *     dormant. Enumerating instance fields would mean constructing Base, which
 *     is executing upstream code in order to decide whether executing upstream
 *     code is safe.
 *   - It matches on name. `system()` and `popen()` reach a process and compose
 *     cleanly.
 *
 * The honest claim is therefore narrow: this refuses NAMED PROTOTYPE execution
 * paths it does not override. It does not establish that the composition cannot
 * spawn. A call-time Proxy trap would; see ADR 0012.
 */
const EXECUTION_METHOD_PATTERN = /(^|[a-z])(spawn|exec|fork|launch|run|shell|terminal|pty|command)/i;
const EXECUTION_METHOD_ALLOWLIST = new Set<string>([
  ...DORMANT_REQUIRED_OVERRIDES,
  "constructor",
]);

function prototypeMethods(Base: new (...args: any[]) => any): string[] {
  const names = new Set<string>();
  let current: object | null = Base.prototype;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor && typeof descriptor.value === "function") names.add(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names];
}

function dormantSubprocessPlugin(value: unknown): unknown {
  const record = moduleRecord(value, DSH_MODULES.subprocess);
  const candidate = record.default ?? record.SubprocessRuntime;
  if (typeof candidate !== "function") {
    throw new Error(`DSH module ${DSH_MODULES.subprocess} did not expose SubprocessRuntime`);
  }
  const Base = candidate as new (...args: any[]) => any;

  // Upstream ships this base either abstract (no execution bodies at all) or
  // concrete (real bodies our subclass shadows). Both are safe. A base that
  // implements SOME of the guarded surface and not the rest is neither, and is
  // the shape a partial upstream rename produces, so it is refused.
  const available = prototypeMethods(Base);
  const implemented = DORMANT_REQUIRED_OVERRIDES.filter((name) => available.includes(name));
  if (implemented.length > 0 && implemented.length < DORMANT_REQUIRED_OVERRIDES.length) {
    const absent = DORMANT_REQUIRED_OVERRIDES.filter((name) => !available.includes(name));
    throw new DshDormantCompositionError(
      `DSH SubprocessRuntime implements ${implemented.join(", ")} but not ${absent.join(", ")}; `
      + "a partially implemented execution surface is upstream drift, not a contract dormancy can reason about",
    );
  }

  // Fail closed on an upstream execution path we do not override.
  const unguarded = available.filter(
    (name) => !EXECUTION_METHOD_ALLOWLIST.has(name) && EXECUTION_METHOD_PATTERN.test(name),
  ).sort();
  if (unguarded.length > 0) {
    throw new DshDormantCompositionError(
      `DSH SubprocessRuntime exposes unguarded execution path(s) ${unguarded.join(", ")}; dormant composition refuses to mount`,
    );
  }

  const Dormant = class RhizDormantSubprocessRuntime extends Base {
    async resolveExecutable(): Promise<string> {
      throw new DshDormantCompositionError("Rhiz dormant DSH composition does not permit executable resolution");
    }

    spawn(): never {
      throw new DshDormantCompositionError("Rhiz dormant DSH composition does not permit process spawn");
    }

    async spawnTerminal(): Promise<never> {
      throw new DshDormantCompositionError("Rhiz dormant DSH composition does not permit terminal spawn");
    }
  };

  assertDormantOverridesEngaged(Base, Dormant);
  return Dormant;
}

/**
 * Positive self-test: every guarded method must resolve to OUR implementation
 * rather than the base one. This is what makes dormancy a checked property
 * instead of an assumption about the shape of a prerelease dependency.
 */
export function assertDormantOverridesEngaged(
  Base: new (...args: any[]) => any,
  Dormant: new (...args: any[]) => any,
): void {
  for (const name of DORMANT_REQUIRED_OVERRIDES) {
    const own = Object.getOwnPropertyDescriptor(Dormant.prototype, name);
    if (!own || typeof own.value !== "function") {
      throw new DshDormantCompositionError(`dormant composition lost its ${name} override`);
    }
    let baseValue: unknown;
    let current: object | null = Base.prototype;
    while (current && current !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) { baseValue = descriptor.value; break; }
      current = Object.getPrototypeOf(current) as object | null;
    }
    if (own.value === baseValue) {
      throw new DshDormantCompositionError(`dormant ${name} override resolves to the upstream implementation`);
    }
  }
}

async function mount(
  context: CordisContextLike,
  plugin: unknown,
  config?: unknown,
): Promise<CordisFiberLike | undefined> {
  const candidate = context.plugin(plugin, config);
  await Promise.resolve(candidate);
  if (!isRecord(candidate) || typeof candidate.dispose !== "function") return undefined;
  return candidate as unknown as CordisFiberLike;
}

async function disposeComposition(
  context: CordisContextLike,
  fibers: CordisFiberLike[],
): Promise<void> {
  const failures: unknown[] = [];
  const hadFibers = fibers.length > 0;
  for (const fiber of [...fibers].reverse()) {
    try {
      await Promise.resolve(fiber.dispose());
    } catch (error) {
      failures.push(error);
    }
  }
  fibers.splice(0);
  if (!hadFibers && context.dispose !== undefined) {
    try {
      await Promise.resolve(context.dispose());
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "DSH Cordis composition teardown failed");
  }
}

function outputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((block): block is { type: string; text: string } => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("");
}

function mapSubagentResult(value: unknown): {
  stopReason: string;
  outputText: string;
  diagnostic?: string;
} {
  if (!isRecord(value) || typeof value.stopReason !== "string") {
    throw new Error("DSH product subagent returned no stopReason");
  }
  const diagnostic = value.diagnostic;
  if (diagnostic !== undefined && typeof diagnostic !== "string") {
    throw new Error("DSH product subagent returned a malformed diagnostic");
  }
  return {
    stopReason: value.stopReason,
    outputText: outputText(value.output),
    ...(diagnostic === undefined ? {} : { diagnostic: diagnostic.slice(0, 4096) }),
  };
}

function rawRun(value: unknown): RawSubagentRun {
  if (!isRecord(value) || typeof value.dispose !== "function") {
    throw new Error("DSH product subagent start returned no disposable run");
  }
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error("DSH product subagent run carried no stable id");
  }
  if (!isRecord(value.result) && !(value.result instanceof Promise)) {
    throw new Error("DSH product subagent run carried no result Promise");
  }
  const result = value.result as { then?: unknown };
  if (typeof result.then !== "function") {
    throw new Error("DSH product subagent run carried no result Promise");
  }
  return value as unknown as RawSubagentRun;
}

function parentFor(context: CordisContextLike, request: DshSubagentStartRequest): object {
  return {
    id: `rhiz-parent:${request.attemptId}`,
    ctx: context,
    session: {
      id: `rhiz-parent-session:${request.attemptId}`,
      header: { cwd: request.cwd },
      events: [],
    },
  };
}

function productModule(route: ResolvedDshProductRoute): string {
  return route.product === "codex" ? DSH_MODULES.codex : DSH_MODULES.claude;
}

async function defaultModuleLoader(specifier: string): Promise<unknown> {
  return import(specifier);
}

class InProcessDshSubagentRuntime implements DshSubagentRuntime {
  readonly #context: CordisContextLike;
  readonly #fibers: CordisFiberLike[];
  readonly #active = new Set<DshSubagentRun>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(context: CordisContextLike, fibers: CordisFiberLike[]) {
    this.#context = context;
    this.#fibers = fibers;
  }

  async capabilities(): Promise<{ guardedToolMediation: boolean }> {
    // Pinned DSH rc.8 hard-codes its Codex and Claude permission handlers. It
    // cannot accept Rhiz's awaited callback, so write-capable selection must
    // refuse this runtime rather than label static product settings a boundary.
    return { guardedToolMediation: false };
  }

  listProviders(): readonly string[] {
    const runtime = this.#context.subagents;
    if (!runtime) throw new Error("DSH subagent service is unavailable");
    return [...runtime.list()];
  }

  async start(providerName: string, request: DshSubagentStartRequest): Promise<DshSubagentRun> {
    if (this.#closed) throw new Error("DSH product subagent runtime is closed");
    const runtime = this.#context.subagents;
    if (!runtime) throw new Error("DSH subagent service is unavailable");
    const raw = rawRun(await runtime.start(providerName, {
      label: request.label,
      prompt: [{ type: "text", text: request.prompt }],
      parent: parentFor(this.#context, request),
      signal: request.signal,
    }));

    let disposePromise: Promise<void> | undefined;
    const run: DshSubagentRun = {
      id: raw.id,
      result: raw.result.then(mapSubagentResult),
      dispose: () => {
        disposePromise ??= Promise.resolve(raw.dispose()).finally(() => {
          this.#active.delete(run);
        });
        return disposePromise;
      },
    };
    this.#active.add(run);
    return run;
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closePromise ??= (async () => {
      const failures: unknown[] = [];
      const results = await Promise.allSettled([...this.#active].map((run) => run.dispose()));
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      try {
        await disposeComposition(this.#context, this.#fibers);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "DSH product runtime teardown failed");
      }
    })();
    return this.#closePromise;
  }
}

export async function createDshInProcessSubagentRuntime(
  rawRoutes: readonly DshProductRoute[],
  options: {
    loadModule?: DshProductModuleLoader;
    subprocessMode?: DshSubprocessMode;
  } = {},
): Promise<DshSubagentRuntime> {
  const routes = resolveDshProductRoutes(rawRoutes);
  const loadModule = options.loadModule ?? defaultModuleLoader;
  const subprocessMode = options.subprocessMode ?? "local";
  let context: CordisContextLike | undefined;
  const fibers: CordisFiberLike[] = [];
  try {
    const cordisModule = await loadModule(DSH_MODULES.cordis);
    const Context = contextConstructor(cordisModule);
    context = new Context();

    const subagentFiber = await mount(
      context,
      modulePlugin(await loadModule(DSH_MODULES.subagent), DSH_MODULES.subagent),
    );
    if (subagentFiber) fibers.push(subagentFiber);

    const subprocessPlugin = subprocessMode === "local"
      ? modulePlugin(await loadModule(DSH_MODULES.subprocessLocal), DSH_MODULES.subprocessLocal)
      : dormantSubprocessPlugin(await loadModule(DSH_MODULES.subprocess));
    const subprocessFiber = await mount(context, subprocessPlugin);
    if (subprocessFiber) fibers.push(subprocessFiber);

    const loadedProducts = new Map<string, unknown>();
    for (const route of routes) {
      const specifier = productModule(route);
      let plugin = loadedProducts.get(specifier);
      if (plugin === undefined) {
        plugin = modulePlugin(await loadModule(specifier), specifier);
        loadedProducts.set(specifier, plugin);
      }
      const productFiber = await mount(context, plugin, {
        providerName: route.providerName,
        env: { ...route.env },
        permissionMode: route.permissionMode,
        disposeGraceMs: route.disposeGraceMs,
      });
      if (productFiber) fibers.push(productFiber);
    }

    const runtime = new InProcessDshSubagentRuntime(context, fibers);
    const available = new Set(runtime.listProviders());
    const missing = routes
      .map((route) => route.providerName)
      .filter((providerName) => !available.has(providerName));
    if (missing.length > 0) {
      throw new Error(`DSH product composition did not register providers: ${missing.join(", ")}`);
    }
    return runtime;
  } catch (error) {
    if (context) {
      await disposeComposition(context, fibers).catch(() => undefined);
    }
    throw new Error(`DSH product runtime composition failed: ${safeError(error)}`, { cause: error });
  }
}

export function createDshProductWorkerHost(options: {
  id?: string;
  routes?: readonly DshProductRoute[];
  cwd?: string;
  now?: () => string;
  loadModule?: DshProductModuleLoader;
  subprocessMode?: DshSubprocessMode;
  codexEnv?: Record<string, string>;
  claudeEnv?: Record<string, string>;
} = {}): DshProductWorkerHost {
  const routes = options.routes ?? createDefaultDshProductRoutes({
    ...(options.codexEnv === undefined ? {} : { codexEnv: options.codexEnv }),
    ...(options.claudeEnv === undefined ? {} : { claudeEnv: options.claudeEnv }),
  });
  return new DshProductWorkerHost({
    routes,
    runtimeFactory: () => createDshInProcessSubagentRuntime(routes, {
      ...(options.loadModule === undefined ? {} : { loadModule: options.loadModule }),
      ...(options.subprocessMode === undefined ? {} : { subprocessMode: options.subprocessMode }),
    }),
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
