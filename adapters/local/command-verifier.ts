import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SandboxLauncher, SandboxPolicy } from "../../src/sandbox.js";
import { requireSandbox } from "../../src/sandbox.js";
import type { VerificationCheckResult, VerifierDescriptor, VerifierProvider, VerifierRequest } from "../../src/verify.js";
import { VerificationCheckResultSchema, VerifierDescriptorSchema } from "../../src/verify.js";
import { EvidenceKindSchema, EvidenceRefSchema } from "../../src/schemas.js";

const text = z.string().trim().min(1);
export const LocalCommandCheckConfigSchema = z.object({
  command: text.max(4096),
  args: z.array(z.string().max(4096)).max(200).default([]),
  expectedExitCodes: z.array(z.number().int().min(0).max(255)).min(1).default([0]),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).default(120_000),
  maxOutputBytes: z.number().int().positive().max(16 * 1024 * 1024).default(256 * 1024),
  evidenceKind: EvidenceKindSchema.refine((kind) => kind !== "artifact-identity", "local command output cannot impersonate artifact identity evidence").default("test"),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.expectedExitCodes).size !== value.expectedExitCodes.length) {
    ctx.addIssue({ code: "custom", path: ["expectedExitCodes"], message: "expected exit codes must be unique" });
  }
});
export type LocalCommandCheckConfig = z.infer<typeof LocalCommandCheckConfigSchema>;

export interface LocalCommandVerifierOptions {
  id?: string;
  displayName?: string;
  description?: string;
  now?: () => string;
  environment?: Record<string, string>;
  /**
   * OS containment for the checked process. When set, the command is wrapped so
   * the operating system enforces the boundary, and a launcher that is missing
   * or unavailable is an error rather than an unconfined run. When absent the
   * check runs unconfined, which is the pre-existing behavior and is NOT
   * containment; see issue #11.
   */
  sandbox?: SandboxLauncher | null;
  /** Require containment. With this set, no sandbox means the check errors. */
  requireContainment?: boolean;
  /**
   * HOME for the checked process. Defaults to a disposable scratch directory
   * so repository code cannot read the operator's ambient credentials, and so
   * tools that require HOME still work. Pass an explicit path only when a
   * check genuinely needs a populated home.
   */
  homeDirectory?: string;
}
interface CommandOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer<ArrayBufferLike>;
  stderr: Buffer<ArrayBufferLike>;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  /** True when the process group was still alive after escalation to SIGKILL. */
  processLeak: boolean;
}

/**
 * Signal an entire process group. The check is typically `npm test`, which
 * forks, so signalling the direct child alone leaves the real work running and
 * still mutating the workspace after the verifier has recorded its verdict.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    // Fall back to the direct child if the group is unavailable (no setsid).
    try {
      process.kill(pid, signal);
      return true;
    } catch (fallbackError) {
      return !isNoSuchProcess(fallbackError);
    }
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ESRCH";
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

/**
 * Variables that can turn "run the repository's test command" into "execute
 * attacker-chosen code in the verifier". These are never forwarded from the
 * operator environment and may never be supplied as overrides, because a
 * verifier that honours them is not a verifier.
 */
export const FORBIDDEN_VERIFIER_ENV = Object.freeze([
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
]);

/**
 * The only variables forwarded from the operator's environment. HOME is
 * deliberately absent: it is the path to ~/.ssh, ~/.aws, ~/.npmrc and every
 * other ambient credential, and the check under verification is repository
 * code we do not trust. A scratch HOME is supplied instead.
 */
const FORWARDED_VERIFIER_ENV = Object.freeze(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "CI"]);

/**
 * Never inherited and never overridable: always set to these exact values, so
 * ambient or repository-supplied git configuration cannot execute anything.
 */
export const NEUTRALIZED_VERIFIER_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

export class VerifierEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierEnvironmentError";
  }
}

function safeBaseEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const forbidden = new Set(FORBIDDEN_VERIFIER_ENV);
  for (const name of Object.keys(overrides)) {
    if (forbidden.has(name)) {
      throw new VerifierEnvironmentError(
        `verifier environment override ${name} can inject code into the checked process and is refused`,
      );
    }
  }
  const env: NodeJS.ProcessEnv = {};
  for (const name of FORWARDED_VERIFIER_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Hard-disable ambient git configuration so a hostile repository cannot reach
  // the verifier through core.pager, core.fsmonitor, or an external diff driver.
  for (const [name, value] of Object.entries(overrides)) env[name] = value;
  // Applied last so no override can displace them: a hostile repository must not
  // reach the verifier through core.pager, core.fsmonitor, or an external diff.
  for (const [name, value] of Object.entries(NEUTRALIZED_VERIFIER_ENV)) env[name] = value;
  return env;
}
function appendBounded(
  current: Buffer<ArrayBufferLike>,
  incoming: Buffer<ArrayBufferLike>,
  maxBytes: number,
): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (current.length >= maxBytes) return { value: current, truncated: incoming.length > 0 };
  const remaining = maxBytes - current.length;
  if (incoming.length <= remaining) return { value: Buffer.concat([current, incoming]), truncated: false };
  return { value: Buffer.concat([current, incoming.subarray(0, remaining)]), truncated: true };
}
async function runCommand(config: LocalCommandCheckConfig, cwd: string, env: NodeJS.ProcessEnv): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    // detached puts the child in its own process group so the whole tree can be
    // signalled as one unit on timeout.
    const child = spawn(config.command, config.args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const childPid = child.pid;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let processLeak = false;
    let settled = false;
    let timer: NodeJS.Timeout;
    let killTimer: NodeJS.Timeout | undefined;
    let leakTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      const next = appendBounded(stdout, Buffer.from(chunk), config.maxOutputBytes);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      const next = appendBounded(stderr, Buffer.from(chunk), config.maxOutputBytes);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (leakTimer !== undefined) clearTimeout(leakTimer);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // A timed-out group may still hold survivors that ignored SIGKILL or were
      // reparented. Report that rather than silently leaking them.
      if (timedOut && childPid !== undefined && groupAlive(childPid)) processLeak = true;
      resolve({ exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated, timedOut, processLeak });
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (childPid === undefined) {
        child.kill("SIGKILL");
        return;
      }
      signalGroup(childPid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup(childPid, "SIGKILL");
        leakTimer = setTimeout(() => {
          if (groupAlive(childPid)) processLeak = true;
        }, 250);
        leakTimer.unref();
      }, 1_000);
      killTimer.unref();
    }, config.timeoutMs);
    timer.unref();
  });
}
function outcomeDigest(config: LocalCommandCheckConfig, outcome: CommandOutcome): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    command: config.command,
    args: config.args,
    expectedExitCodes: config.expectedExitCodes,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    processLeak: outcome.processLeak,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
  }));
  hash.update("\0stdout\0");
  hash.update(outcome.stdout);
  hash.update("\0stderr\0");
  hash.update(outcome.stderr);
  return `sha256:${hash.digest("hex")}`;
}

export class LocalCommandVerifierProvider implements VerifierProvider {
  readonly id: string;
  readonly #descriptor: VerifierDescriptor;
  readonly #now: () => string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #home: string;
  readonly #scratchHome: string | undefined;
  readonly #sandbox: SandboxLauncher | null;
  readonly #requireContainment: boolean;

  constructor(options: LocalCommandVerifierOptions = {}) {
    this.id = options.id ?? "verifier:local-command";
    this.#descriptor = VerifierDescriptorSchema.parse({
      id: this.id,
      displayName: options.displayName ?? "Local Command Verifier",
      description: options.description ?? "Runs one explicit argv command without a shell and records bounded, digest-addressed output",
      deterministic: true,
      readOnly: true,
      evidenceKinds: ["test", "static-analysis", "log", "receipt", "other"],
    });
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.homeDirectory === undefined) {
      this.#scratchHome = mkdtempSync(join(tmpdir(), "rhiz-verifier-home-"));
      this.#home = this.#scratchHome;
    } else {
      this.#home = options.homeDirectory;
    }
    this.#env = { ...safeBaseEnvironment(options.environment), HOME: this.#home };
    this.#sandbox = options.sandbox ?? null;
    this.#requireContainment = options.requireContainment ?? false;
  }

  /**
   * The boundary for one check: the workspace it is verifying, plus the scratch
   * home it was given. Everything else is read-only, and the network is closed.
   */
  sandboxPolicyFor(executionRoot: string): SandboxPolicy {
    return {
      writableRoots: [executionRoot, this.#home],
      allowRead: true,
      allowNetwork: false,
      allowProcessExec: true,
    };
  }
  async describe(): Promise<VerifierDescriptor> { return VerifierDescriptorSchema.parse(this.#descriptor); }
  async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
    const config = LocalCommandCheckConfigSchema.parse(request.check.config);
    const startedAt = this.#now();
    try {
      const executionRoot = request.workspace.executionRoot;
      let effective = { command: config.command, args: config.args };
      let disposeSandbox: (() => Promise<void>) | undefined;
      if (this.#requireContainment || this.#sandbox !== null) {
        // requireSandbox turns "no launcher" and "launcher unavailable" into the
        // same error as "the sandbox refused", so a missing boundary can never
        // take the code path of a permitting one.
        const wrapped = await requireSandbox(
          this.#sandbox,
          this.sandboxPolicyFor(executionRoot),
          config.command,
          config.args,
        );
        effective = { command: wrapped.command, args: wrapped.args };
        disposeSandbox = () => wrapped.dispose();
      }
      const outcome = await runCommand(
        { ...config, command: effective.command, args: effective.args },
        executionRoot,
        this.#env,
      ).finally(async () => { await disposeSandbox?.(); });
      const evidence = EvidenceRefSchema.parse({
        id: `evidence:${request.check.id}:${request.target.digest}`.slice(0, 200),
        kind: config.evidenceKind,
        uri: `verify://local-command/${encodeURIComponent(request.check.id)}`,
        digest: outcomeDigest(config, outcome),
      });
      const expected = outcome.exitCode !== null && config.expectedExitCodes.includes(outcome.exitCode);
      // A surviving process group can still be writing to the workspace, so its
      // result cannot be trusted as proof of anything.
      const status = expected && !outcome.timedOut && !outcome.processLeak ? "pass" as const : "fail" as const;
      const exit = outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `exit ${outcome.exitCode}`;
      const truncation = outcome.stdoutTruncated || outcome.stderrTruncated ? "; output bounded" : "";
      return VerificationCheckResultSchema.parse({
        checkId: request.check.id,
        providerId: this.id,
        status,
        summary: outcome.processLeak
          ? `command left a live process group after SIGKILL; result discarded${truncation}`
          : outcome.timedOut
            ? `command timed out after ${config.timeoutMs}ms and its process group was terminated${truncation}`
            : `${exit}; expected ${config.expectedExitCodes.join(", ")}${truncation}`,
        evidence: [evidence],
        startedAt,
        finishedAt: this.#now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return VerificationCheckResultSchema.parse({
        checkId: request.check.id,
        providerId: this.id,
        status: "error",
        summary: `command verifier could not execute: ${message.replace(/\s+/g, " ").slice(0, 3000)}`,
        evidence: [],
        startedAt,
        finishedAt: this.#now(),
      });
    }
  }
  /** The HOME handed to checked processes. Exposed so proofs can assert it. */
  get homeDirectory(): string { return this.#home; }

  async close(): Promise<void> {
    if (this.#scratchHome !== undefined) rmSync(this.#scratchHome, { recursive: true, force: true });
  }
}
