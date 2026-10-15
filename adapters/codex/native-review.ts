import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import readline from "node:readline";

/** Installed-native boundary, not a verdict parser or a review authority. */
export interface NativeCodexReviewOptions {
  executable: string;
  model: string;
  /** Trusted reviewer definition. The packet is separately sent as user input. */
  instructions: string;
  packet: string;
  canonicalCodexHome: string;
  /** Original native metadata, pinned by independent boundary review. Never credentials. */
  modelCatalog: { path: string; recordSha256: string };
  checkout: string;
  scratch: string;
  commonGitDirectory: string;
  /** Explicitly reviewed toolchain directories, never arbitrary home directories. */
  toolchainRoots: readonly string[];
  timeoutMs?: number;
}

export interface NativeCodexReviewResult {
  text: string;
  executor: { executable: string; version: "0.162.1"; modelCatalogSha256: string; reasoningEffort: "high"; model: string; provider: "openai"; profile: "review" };
  usage: Readonly<Record<string, number>>;
  /** Raw JSONL for the existing consumer's evidence/leak checks, never acceptance. */
  events: string;
}

type Config = Record<string, unknown>;
type NativeOutput = { stdout: string; stderr: string };
const MAX_OUTPUT = 16 * 1024 * 1024;
const DISABLED_FEATURES = [
  "apps", "plugins", "hooks", "memories", "multi_agent", "skill_search",
  "skill_mcp_dependency_install", "browser_use", "browser_use_external", "computer_use",
  "image_generation", "view_image", "shell_snapshot", "chronicle", "tool_suggest",
  "remote_plugin", "sleep_tool", "goals", "workspace_dependencies",
] as const;

function contains(parent: string, child: string): boolean {
  const tail = relative(parent, child);
  return tail === "" || (!tail.startsWith(`..${sep}`) && tail !== ".." && !isAbsolute(tail));
}
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function overrides(config: Config): string[] {
  return Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
}
function hostEnvironment(home: string, codexHome: string): NodeJS.ProcessEnv {
  // Deliberately do not spread process.env. Auth is consumed by the native host.
  return { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin", RUST_LOG: "codex_exec=info" };
}
async function directory(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error("review paths must be absolute");
  const resolved = await realpath(value);
  if (/[?*\[\]{}]/.test(resolved)) throw new Error("native review directory cannot contain glob syntax");
  if (!(await stat(resolved)).isDirectory()) throw new Error("review scope must be a directory");
  return resolved;
}

/** Bounded native process; failure diagnostics never include auth or provider response bodies. */
async function invoke(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string, timeoutMs: number): Promise<NativeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: Error | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    const kill = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ } }
      hardKill ??= setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } } }, 500);
    };
    const timer = setTimeout(() => { failure = new Error("native review timed out"); kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > MAX_OUTPUT) { failure = new Error("native review output exceeded bound"); kill(); } });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (Buffer.byteLength(stderr) > MAX_OUTPUT) { failure = new Error("native review diagnostics exceeded bound"); kill(); } });
    child.stdin.on("error", () => { failure ??= new Error("native review input failed"); });
    child.on("error", () => { failure = new Error("native review process unavailable"); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); if (hardKill) clearTimeout(hardKill);
      // The leader can exit before a background test child; retire its process group.
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group is gone */ } }
      if (failure || code !== 0 || signal !== null) reject(failure ?? new Error("native review process did not complete successfully"));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** Metadata-only RPC. No login, refresh request, bearer-token request or credential file read. */
async function accountMetadata(executable: string, codexHome: string, home: string, cwd: string, timeoutMs: number, canonical: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["app-server", "--stdio"];
    if (!canonical) args.push(...overrides({ cli_auth_credentials_store: "file", "features.apps": false, "features.plugins": false, "features.hooks": false }));
    const child = spawn(executable, args, { cwd, env: hostEnvironment(home, codexHome), stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: child.stdout });
    let nextId = 0, bytes = 0, settled = false;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const finish = (error?: Error, value?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); lines.close(); child.kill("SIGKILL");
      for (const item of pending.values()) item.reject(new Error("native account metadata closed")); pending.clear();
      error ? reject(error) : resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("native account metadata timed out")), timeoutMs);
    child.stderr.resume(); child.stdin.on("error", () => finish(new Error("native account metadata input failed")));
    child.on("error", () => finish(new Error("native account metadata unavailable")));
    child.on("close", () => { if (!settled) finish(new Error("native account metadata interrupted")); });
    lines.on("line", (line) => {
      bytes += Buffer.byteLength(line); if (bytes > MAX_OUTPUT) { finish(new Error("native account metadata exceeded bound")); return; }
      let message: { id?: number; result?: unknown; error?: unknown };
      try { message = JSON.parse(line); } catch { finish(new Error("native account metadata malformed")); return; }
      if (message.id !== undefined) {
        const item = pending.get(message.id); if (!item) { finish(new Error("native account metadata unknown reply")); return; }
        pending.delete(message.id); message.error ? item.reject(new Error("native account metadata refused")) : item.resolve(message.result);
      }
    });
    const rpc = (method: string, params: unknown) => new Promise<unknown>((yes, no) => {
      const id = ++nextId; pending.set(id, { resolve: yes, reject: no });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    void (async () => {
      await rpc("initialize", { clientInfo: { name: "rhiz-native-review", version: "1" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      const config = await rpc("config/read", { includeLayers: false, cwd }) as { config?: { cli_auth_credentials_store?: string } };
      if (config.config?.cli_auth_credentials_store !== "file") throw new Error("independent review requires the verified canonical file auth backend");
      const response = await rpc("account/read", { refreshToken: false }) as { account?: { type?: string; email?: string; planType?: string }; requiresOpenaiAuth?: boolean };
      const account = response.account;
      if (account?.type !== "chatgpt" || !account.email || !account.planType || response.requiresOpenaiAuth !== true) throw new Error("native review requires a signed-in ChatGPT principal");
      // Compare only public account metadata in memory; never emit an account identifier.
      finish(undefined, JSON.stringify([account.type, account.email, account.planType]));
    })().catch(() => finish(new Error("native review account/backend verification failed")));
  });
}

/** Strict final-event extraction is shared by deterministic native wire fixtures. */
export function parseNativeCodexReview(output: NativeOutput, expected: { model: string; provider: string; filesystem: Readonly<Record<string, string>>; codexHome: string; cwd: string }): Pick<NativeCodexReviewResult, "text" | "usage"> {
  const sessions = output.stderr.split("\n").filter((line) => /^\d{4}-\d\d-\d\dT\S+\s+INFO codex\.exec\{[^\n]*\}: codex_exec: Codex initialized with event: SessionConfiguredEvent \{/.test(line));
  if (sessions.length !== 1) throw new Error("native review startup attestation missing or ambiguous");
  const session = sessions[0]!;
  for (const fragment of [`model: ${JSON.stringify(expected.model)},`, `model_provider_id: ${JSON.stringify(expected.provider)},`, "approval_policy: Never,", "reasoning_effort: Some(High),", 'active_permission_profile: Some(ActivePermissionProfile { id: "review", extends: None })', `cwd: AbsolutePathBuf(${JSON.stringify(expected.cwd)})`]) {
    if (!session.includes(fragment)) throw new Error("native review model/provider/profile drift");
  }
  if (!session.includes("permission_profile: Managed { file_system: Restricted {") || !session.includes("network: Restricted }")) throw new Error("native review permission profile missing");
  const observed = new Map<string, string>();
  const entry = /FileSystemSandboxEntry \{ path: Path \{ path: PathUri\(Url \{[^}]*path: ("(?:[^"\\]|\\.)*")[^}]*\}\) \}, access: (Read|Write|Deny), missing_path_behavior: None \}/g;
  for (const match of session.matchAll(entry)) {
    const scope = JSON.parse(match[1]!) as string;
    if (/[?*\[\]{}]/.test(scope)) throw new Error("native review literal path contains glob syntax");
    if (observed.has(scope)) throw new Error("native review duplicate permission scope");
    observed.set(scope, match[2]!.toLowerCase());
  }
  const minimal = /FileSystemSandboxEntry \{ path: Special \{ value: Minimal \}, access: (Read|Write|Deny), missing_path_behavior: None \}/g;
  for (const match of session.matchAll(minimal)) {
    if (observed.has(":minimal")) throw new Error("native review duplicate minimal permission");
    observed.set(":minimal", match[1]!.toLowerCase());
  }
  const terminalGlob = /FileSystemSandboxEntry \{ path: GlobPattern \{ pattern: "(\/dev\/(?:tty|ptmx)\*)" \}, access: Deny, missing_path_behavior: None \}/g;
  for (const match of session.matchAll(terminalGlob)) {
    if (observed.has(match[1]!)) throw new Error("native review duplicate terminal deny glob");
    observed.set(match[1]!, "deny");
  }
  for (const [scope, access] of Object.entries(expected.filesystem)) {
    if (observed.get(scope) !== access) throw new Error("native review filesystem profile drift");
    observed.delete(scope);
  }
  // Native 0.162.1 adds its private executable shim as read-only. No other additions.
  for (const [scope, access] of observed) {
    if (access !== "read" || !scope.startsWith(`${expected.codexHome}/tmp/arg0/codex-arg0`) || scope.slice(`${expected.codexHome}/tmp/arg0/`.length).includes("/")) throw new Error("native review unexpected filesystem scope");
  }
  if ((session.match(/FileSystemSandboxEntry \{/g) ?? []).length !== observed.size + Object.keys(expected.filesystem).length) throw new Error("native review unrecognized filesystem entry");
  const rows = output.stdout.trimEnd().split("\n");
  let thread = false, started = false, completed = false, final: string | undefined, usage: Record<string, number> | undefined;
  const activeItems = new Set<string>();
  for (const row of rows) {
    let event: { type?: string; item?: { id?: string; type?: string; status?: string; text?: string }; usage?: Record<string, number> };
    try { event = JSON.parse(row); } catch { throw new Error("native review malformed or truncated event"); }
    if (completed) throw new Error("native review events after completed turn");
    if (event.type === "thread.started") { if (thread || started) throw new Error("native review multiple threads"); thread = true; continue; }
    if (event.type === "turn.started") { if (!thread || started) throw new Error("native review multiple turns or missing thread"); started = true; continue; }
    if (!started) throw new Error("native review event before turn");
    if (event.type === "turn.completed") {
      if (activeItems.size || !final || !event.usage || !Number.isSafeInteger(event.usage.input_tokens) || !Number.isSafeInteger(event.usage.output_tokens) || Object.values(event.usage).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("native review final/usage missing");
      completed = true; usage = event.usage; continue;
    }
    if (event.type !== "item.started" && event.type !== "item.completed") throw new Error("native review failed or unexpected event");
    if (!event.item || !["agent_message", "reasoning", "command_execution", "file_change"].includes(event.item.type ?? "")) throw new Error("native review unexpected tool item");
    if (!event.item.id) throw new Error("native review missing item identity");
    if (event.type === "item.started") {
      if (activeItems.has(event.item.id)) throw new Error("native review duplicate active item");
      activeItems.add(event.item.id);
    } else {
      activeItems.delete(event.item.id);
    }
    if (event.item.status === "failed" || event.item.status === "error") throw new Error("native review tool failed");
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      if (final !== undefined || typeof event.item.text !== "string" || !event.item.text.trim()) throw new Error("native review conflicting or empty final");
      final = event.item.text;
    }
  }
  if (!completed || final === undefined || usage === undefined) throw new Error("native review incomplete turn");
  return { text: final, usage };
}

function nativeReviewFilesystem(scopes: Readonly<Record<string, string>>): Record<string, string> {
  // Globs compile to overriding Seatbelt denies; literal device carveouts do not.
  return { ...scopes, ":minimal": "read", "/dev/tty*": "deny", "/dev/ptmx*": "deny" };
}

/** Production flags/environment shared with deterministic native-provider probes. No provider override. */
export function nativeCodexReviewInvocation(input: {
  model: string; instructions: string; trusted: string; alias: string; hostHome: string;
  scratch: string; shellHome: string; catalogPath: string; filesystem: Readonly<Record<string, string>>;
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const { trusted, alias, hostHome, scratch, shellHome, filesystem, catalogPath } = input;
  const shellEnvironment = { HOME: scratch, TMPDIR: scratch, PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ZDOTDIR: shellHome, BASH_ENV: "/dev/null", ENV: "/dev/null" };
  const config: Config = {
    model_reasoning_effort: "high", model_catalog_json: catalogPath, cli_auth_credentials_store: "file", model_provider: "openai", approval_policy: "never", default_permissions: "review",
    "permissions.review.filesystem": nativeReviewFilesystem(filesystem), "permissions.review.network.enabled": false,
    "skills.include_instructions": false, "skills.bundled.enabled": false, project_doc_max_bytes: 0,
    "agents.enabled": false, "features.multi_agent_v2": false, "features.send_message_to_user_async": false,
    "tools.update_plan.enabled": false, "tools.experimental_request_user_input.enabled": false,
    allow_login_shell: false, "shell_environment_policy.inherit": "none", "shell_environment_policy.set": shellEnvironment,
    developer_instructions: input.instructions, web_search: "disabled",
  };
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--strict-config", "--json", "--color", "never", "-C", trusted, "-m", input.model, ...overrides(config), ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]), "-"];
  return { args, env: hostEnvironment(hostHome, alias) };
}

export async function runNativeCodexReview(options: NativeCodexReviewOptions): Promise<NativeCodexReviewResult> {
  if (process.platform !== "darwin") throw new Error("native review profile is proven only on Darwin");
  if (!/^[a-zA-Z0-9._-]+$/.test(options.model) || !options.packet.trim() || !options.instructions.trim()) throw new Error("native review requires explicit model, instructions and packet");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1_800_000) throw new Error("native review timeout invalid");
  const deadline = Date.now() + timeoutMs;
  const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw new Error("native review timed out"); return value; };
  const executable = await realpath(options.executable);
  const executableStat = await stat(executable);
  if (!executableStat.isFile() || (executableStat.mode & 0o022) !== 0 || ![0, process.getuid?.()].includes(executableStat.uid)) throw new Error("native review executable is not trusted");
  const home = await directory(homedir()), canonical = await directory(options.canonicalCodexHome);
  const auth = join(canonical, "auth.json"), authStat = await lstat(auth);
  if (!authStat.isFile() || authStat.uid !== process.getuid?.() || (authStat.mode & 0o077) !== 0 || await realpath(auth) !== auth) throw new Error("native review auth must be the canonical operator-owned private regular file");
  if (!/^[a-f0-9]{64}$/.test(options.modelCatalog.recordSha256) || !isAbsolute(options.modelCatalog.path)) throw new Error("native review requires a reviewed model catalog fingerprint");
  const catalogFile = await realpath(options.modelCatalog.path), catalogStat = await lstat(options.modelCatalog.path);
  if (catalogFile !== join(canonical, "models_cache.json") || !catalogStat.isFile() || catalogStat.uid !== process.getuid?.() || (catalogStat.mode & 0o022) !== 0 || catalogStat.size > MAX_OUTPUT || (catalogStat.dev === authStat.dev && catalogStat.ino === authStat.ino)) throw new Error("native review model catalog must be the canonical operator-owned metadata file");
  const catalog = JSON.parse(await readFile(catalogFile, "utf8")) as { models?: { slug?: string }[] };
  const records = catalog.models?.filter((record) => record.slug === options.model);
  if (records?.length !== 1 || createHash("sha256").update(JSON.stringify(records[0])).digest("hex") !== options.modelCatalog.recordSha256) throw new Error("native review model catalog drift");
  const checkout = await directory(options.checkout), scratch = await directory(options.scratch), common = await directory(options.commonGitDirectory);
  const toolchains = await Promise.all(options.toolchainRoots.map(directory));
  const control = await realpath(await mkdtemp(join(tmpdir(), "rhiz-native-review-")));
  await chmod(control, 0o700);
  try {
    for (const scope of [checkout, scratch, common, ...toolchains]) {
      if (scope === "/" || scope === home || scope === dirname(home) || scope === "/private/var/folders" || contains(scope, canonical) || contains(canonical, scope) || contains(scope, control) || contains(control, scope)) throw new Error("native review scope overlaps private control/auth");
    }
    if (contains(checkout, executable) || contains(scratch, executable) || contains(checkout, catalogFile) || contains(scratch, catalogFile)) throw new Error("native review controls must be outside target writable scopes");
    if (contains(checkout, common) || contains(scratch, common) || contains(checkout, scratch) || contains(scratch, checkout)) throw new Error("native review scopes overlap");
    const trusted = join(control, "trusted"), alias = join(control, "codex"), hostHome = join(control, "home"), shellHome = join(control, "shell-home");
    for (const path of [trusted, alias, hostHome, shellHome]) await mkdir(path, { mode: 0o700 });
    await symlink(auth, join(alias, "auth.json"));
    const catalogPath = join(control, "native-model.json");
    await writeFile(catalogPath, JSON.stringify({ models: records }), { mode: 0o600, flag: "wx" });
    const version = await invoke(executable, ["--version"], trusted, hostEnvironment(hostHome, alias), "", remaining());
    if (version.stdout.trim() !== "codex-cli 0.162.1") throw new Error("native review CLI version is unproven");
    const originalAccount = await accountMetadata(executable, canonical, home, trusted, remaining(), true);
    if (await accountMetadata(executable, alias, hostHome, trusted, remaining(), false) !== originalAccount) throw new Error("native review auth alias principal mismatch");
    const filesystem = nativeReviewFilesystem({ "/": "read", [home]: "deny", [canonical]: "deny", "/private/tmp": "deny", "/private/var/folders": "deny", [control]: "deny", [shellHome]: "read", [checkout]: "write", [scratch]: "write", [common]: "read" });
    for (const toolchain of toolchains) filesystem[toolchain] = "read";
    const invocation = nativeCodexReviewInvocation({ model: options.model, instructions: options.instructions, trusted, alias, hostHome, scratch, shellHome, filesystem, catalogPath });
    const output = await invoke(executable, invocation.args, trusted, invocation.env, options.packet, remaining());
    const parsed = parseNativeCodexReview(output, { model: options.model, provider: "openai", filesystem, codexHome: alias, cwd: trusted });
    const aliasStat = await lstat(join(alias, "auth.json")), finalAuthStat = await lstat(auth);
    if (!aliasStat.isSymbolicLink() || await realpath(join(alias, "auth.json")) !== auth || !finalAuthStat.isFile() || finalAuthStat.uid !== process.getuid?.() || (finalAuthStat.mode & 0o077) !== 0) throw new Error("native review auth alias was materialized or replaced");
    return { ...parsed, executor: { executable, version: "0.162.1", modelCatalogSha256: options.modelCatalog.recordSha256, reasoningEffort: "high", model: options.model, provider: "openai", profile: "review" }, events: output.stdout };
  } finally {
    // rm unlinks the single symlink; it never follows it into the canonical home.
    await rm(control, { recursive: true, force: true });
  }
}
