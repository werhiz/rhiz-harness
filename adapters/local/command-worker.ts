import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type {
  HarnessHost,
  HostCapabilities,
  FilesystemProvider,
  ProcessProvider,
  SandboxProvider,
  SessionProvider,
  ToolProvider,
  WorkerCapabilities,
  WorkerDescriptor,
  WorkerHandle,
  WorkerObservation,
  WorkerProvider,
  WorkerRegistry,
  WorkerResult,
  WorkerStartRequest,
} from "../../src/host.js";
import {
  HostCapabilitiesSchema,
  parseWorkerObservation,
  parseWorkerStartRequest,
  requireBoundExecutionRoot,
  WorkerDescriptorSchema,
  WorkerResultSchema,
} from "../../src/host.js";
import type { SandboxLauncher, SandboxPolicy } from "../../src/sandbox.js";
import { requireSandbox, workerSandboxPolicy } from "../../src/sandbox.js";
import { FORBIDDEN_VERIFIER_ENV, NEUTRALIZED_VERIFIER_ENV } from "./command-verifier.js";

/**
 * The worker enforcement seam — issue #11.
 *
 * ADR 0017 gave the verifier an operating-system boundary and said, in its own
 * "What is NOT closed" section, that workers still run unconfined and that this
 * is the more dangerous of the two paths because it is the one that edits the
 * repository. This is that path.
 *
 * The whole claim of this module is one ordering: `requireSandbox` runs to
 * completion, producing a rewritten argv, BEFORE `spawn` is reached. There is
 * no branch in which a worker process starts without the operating system
 * holding a profile over it. A missing launcher, an unavailable launcher and a
 * refusing launcher all raise from the same call, so "there was no boundary"
 * can never take the code path of "the boundary allowed it".
 *
 * What this contains and what it does not, stated plainly because the failure
 * mode issue #11 names is a detection layer described as a boundary:
 *
 *   - Contained: writes. The process may write only inside the writable roots
 *     derived from its own WorkContract writeScope plus a scratch HOME. That
 *     is enforced by the kernel, not checked afterwards.
 *   - Contained: outbound network, denied by default.
 *   - NOT contained: reads. A worker can still read ~/.ssh and ~/.aws. With the
 *     network closed it cannot trivially exfiltrate them, but "cannot read
 *     secrets" is not claimed. This matches ADR 0017 and is not a new gap.
 *   - NOT contained: anything on a platform with no launcher. There, every
 *     write-enabled start fails closed rather than running unconfined.
 */

const id = z.string().trim().min(1).max(200);

/** How a contained command reports, through its exit status, that the OS refused it. */
const exitCode = z.number().int().min(0).max(255);

export interface LocalCommandWorkerOptions {
  id?: string;
  displayName?: string;
  description?: string;
  /** Absolute path to the executable. No shell: an argv, never a command line. */
  command: string;
  args?: readonly string[];
  /**
   * OS containment for this worker. Required in the sense that a null or
   * unavailable launcher makes `start` throw rather than run unconfined; it is
   * accepted as nullable only so a caller can pass through a
   * `createDefaultSandboxLauncher()` that returned null on an unsupported
   * platform and get the fail-closed error rather than a type error.
   */
  sandbox: SandboxLauncher | null;
  /**
   * Exit statuses by which this command reports that the operating system
   * refused it. This is the command's declared refusal-reporting contract, not
   * an inference: see the note on `authority.denied` below.
   */
  deniedExitCodes?: readonly number[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: Record<string, string>;
  homeDirectory?: string;
  now?: () => string;
}

/**
 * The only variables forwarded from the operator's environment. HOME is
 * deliberately absent for the same reason it is absent from the verifier: it is
 * the path to every ambient credential, and a worker is untrusted code. A
 * scratch HOME is supplied, and it is inside the OS boundary so the worker can
 * still use it.
 */
const FORWARDED_WORKER_ENV = Object.freeze(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM"]);

export class WorkerEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerEnvironmentError";
  }
}

function safeWorkerEnvironment(overrides: Record<string, string>, home: string): NodeJS.ProcessEnv {
  const forbidden = new Set(FORBIDDEN_VERIFIER_ENV);
  for (const name of Object.keys(overrides)) {
    if (forbidden.has(name)) {
      throw new WorkerEnvironmentError(
        `worker environment override ${name} can inject code into the contained process and is refused`,
      );
    }
  }
  const env: NodeJS.ProcessEnv = {};
  for (const name of FORWARDED_WORKER_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) env[name] = value;
  // Applied last so no override can displace them. Repository-supplied git
  // configuration must not reach the worker through core.pager, core.fsmonitor
  // or an external diff driver.
  for (const [name, value] of Object.entries(NEUTRALIZED_VERIFIER_ENV)) env[name] = value;
  env.HOME = home;
  return env;
}

/**
 * A bounded, replayable observation stream. Crew consumes this live while the
 * process runs; proofs consume it after the fact. Both must see every
 * observation, so it buffers rather than dropping what arrived before the first
 * consumer attached.
 */
class ObservationStream {
  readonly #buffer: WorkerObservation[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  push(observation: WorkerObservation): void {
    if (this.#closed) return;
    this.#buffer.push(parseWorkerObservation(observation));
    this.#wake();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  async *read(): AsyncIterable<WorkerObservation> {
    let index = 0;
    for (;;) {
      while (index < this.#buffer.length) {
        yield this.#buffer[index]!;
        index += 1;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    }
  }
}

interface ProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ESRCH";
}

/** Signal the whole group: a worker forks, and a surviving child still writes. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (isNoSuchProcess(error)) return;
    try {
      process.kill(pid, signal);
    } catch {
      // The process is already gone; nothing to signal.
    }
  }
}

class LocalCommandWorkerHandle implements WorkerHandle {
  readonly workerId: string;
  readonly attemptId: string;
  readonly #stream: ObservationStream;
  readonly #result: Promise<WorkerResult>;

  constructor(workerId: string, attemptId: string, stream: ObservationStream, result: Promise<WorkerResult>) {
    this.workerId = workerId;
    this.attemptId = attemptId;
    this.#stream = stream;
    this.#result = result;
  }

  observe(): AsyncIterable<WorkerObservation> {
    return this.#stream.read();
  }

  result(): Promise<WorkerResult> {
    return this.#result;
  }

  async cancel(): Promise<void> {
    throw new Error(`worker ${this.workerId} does not advertise cancellation`);
  }
}

export class LocalCommandWorkerProvider implements WorkerProvider {
  readonly id: string;
  readonly #descriptor: WorkerDescriptor;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #sandbox: SandboxLauncher | null;
  readonly #deniedExitCodes: ReadonlySet<number>;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #home: string;
  readonly #scratchHome: string | undefined;
  readonly #now: () => string;

  constructor(options: LocalCommandWorkerOptions) {
    this.id = id.parse(options.id ?? "worker:local-command");
    this.#command = z.string().trim().min(1).max(4096).parse(options.command);
    this.#args = z.array(z.string().max(4096)).max(200).parse([...(options.args ?? [])]);
    this.#sandbox = options.sandbox;
    this.#deniedExitCodes = new Set(z.array(exitCode).max(64).parse([...(options.deniedExitCodes ?? [])]));
    this.#timeoutMs = z.number().int().positive().max(60 * 60 * 1000).parse(options.timeoutMs ?? 300_000);
    this.#maxOutputBytes = z.number().int().positive().max(16 * 1024 * 1024).parse(options.maxOutputBytes ?? 256 * 1024);
    this.#now = options.now ?? (() => new Date().toISOString());
    if (options.homeDirectory === undefined) {
      this.#scratchHome = mkdtempSync(join(tmpdir(), "rhiz-worker-home-"));
      this.#home = this.#scratchHome;
    } else {
      this.#home = options.homeDirectory;
    }
    this.#env = safeWorkerEnvironment(options.environment ?? {}, this.#home);
    this.#descriptor = WorkerDescriptorSchema.parse({
      id: this.id,
      displayName: options.displayName ?? "Local Contained Command Worker",
      description: options.description
        ?? "Runs one explicit argv inside an operating-system boundary derived from the Work writeScope",
      adapter: "local",
      product: "command",
      execution: "one-shot",
      context: "standalone",
      // Not "host-policy". This provider states exactly what the worker may
      // write, and an operating system holds it to that statement.
      authorityMode: "os-contained:write-scope",
      writeAccess: "workspace",
      dangerous: false,
      bindsWorkspace: true,
      credentialEnv: [],
    });
  }

  async describe(): Promise<WorkerDescriptor> {
    return WorkerDescriptorSchema.parse(this.#descriptor);
  }

  async capabilities(): Promise<WorkerCapabilities> {
    return { streamingObservations: true, cancel: false, resume: false, guardedToolMediation: false };
  }

  /**
   * Whether this worker's launcher can actually impose a boundary on this
   * machine. The host publishes HostCapabilities.sandbox from this rather than
   * asserting it, so a host cannot advertise containment it does not have.
   */
  async containmentAvailable(): Promise<boolean> {
    if (this.#sandbox === null) return false;
    try {
      return await this.#sandbox.available();
    } catch {
      return false;
    }
  }

  /** The boundary this worker would impose for one request. Exposed so proofs can assert it. */
  policyFor(request: WorkerStartRequest): SandboxPolicy {
    return workerSandboxPolicy(parseWorkerStartRequest(request), this.#home);
  }

  /** The HOME handed to contained workers. Inside the boundary, so tools still work. */
  get homeDirectory(): string { return this.#home; }

  async start(rawRequest: WorkerStartRequest): Promise<WorkerHandle> {
    const request = parseWorkerStartRequest(rawRequest);
    const executionRoot = requireBoundExecutionRoot(this.id, request);
    const policy = workerSandboxPolicy(request, this.#home);

    // THE SEAM. Everything below this line runs inside a boundary the operating
    // system is already holding. requireSandbox throws for a null launcher, an
    // unavailable launcher and a refusing launcher alike, so no worker process
    // can be reached without one. Nothing has been spawned yet.
    let effective: { command: string; args: readonly string[] } = { command: this.#command, args: this.#args };
    const wrapped = await requireSandbox(this.#sandbox, policy, this.#command, this.#args);
    // This one assignment is the entire containment claim for the worker path.
    // Without it the policy is derived, the profile is written, the launcher is
    // consulted, the granted event is emitted -- and the worker still runs the
    // original, unconfined argv. Guard: sandbox/worker-actually-wraps-the-command.
    effective = { command: wrapped.command, args: wrapped.args };

    const stream = new ObservationStream();
    const launcherId = this.#sandbox?.id ?? "unknown";
    stream.push({
      kind: "diagnostic",
      occurredAt: this.#now(),
      detail: `OS containment imposed by ${launcherId}; writable roots: ${policy.writableRoots.join(", ")}`,
      authority: {
        decision: "granted",
        boundary: launcherId.slice(0, 200),
        // The granted event names the roots the kernel is actually holding, so
        // it is a statement about an imposed boundary rather than a label.
        reason: `writes confined to ${policy.writableRoots.join(", ")}; network denied`,
      },
    });

    const result = this.#run(effective.command, effective.args, executionRoot, stream, launcherId)
      .finally(() => wrapped.dispose().catch(() => undefined));

    return new LocalCommandWorkerHandle(this.id, request.attemptId, stream, result);
  }

  async #run(
    command: string,
    args: readonly string[],
    executionRoot: string,
    stream: ObservationStream,
    launcherId: string,
  ): Promise<WorkerResult> {
    let outcome: ProcessOutcome;
    try {
      outcome = await this.#spawn(command, args, executionRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stream.push({
        kind: "diagnostic",
        occurredAt: this.#now(),
        detail: `contained worker could not execute: ${message}`.slice(0, 4000),
      });
      stream.close();
      return WorkerResultSchema.parse({
        status: "failed",
        summary: `contained worker could not execute: ${message}`.slice(0, 4000),
        artifacts: [],
        evidence: [],
      });
    }

    const exit = outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `exit ${outcome.exitCode}`;
    const refused = outcome.exitCode !== null && this.#deniedExitCodes.has(outcome.exitCode);

    if (refused) {
      // `authority.denied` is emitted HERE, by the seam that imposed the
      // boundary, at the moment it learns the contained process was refused.
      //
      // Precisely what this is: the seam's first-hand knowledge is that it
      // imposed boundary B, and that the process it ran under B terminated
      // reporting refusal through its declared refusal-reporting contract. The
      // seam does not see the individual EPERM — that happens in the kernel,
      // inside the child. So the EVENT is evidence of a refusal under a proven
      // boundary; the BOUNDARY itself is proven by the escape targets not
      // existing on disk, which is what test/worker-containment.test.ts
      // asserts. Neither claim is asked to carry the other.
      stream.push({
        kind: "blocked",
        occurredAt: this.#now(),
        detail: `the OS boundary refused the worker (${exit})`,
        authority: {
          decision: "denied",
          boundary: launcherId.slice(0, 200),
          reason: `contained worker reported OS refusal (${exit}); no write landed outside the granted roots`,
        },
      });
    } else {
      stream.push({
        kind: "activity",
        occurredAt: this.#now(),
        detail: `contained worker finished (${exit})`,
      });
    }
    stream.close();

    const status = refused || outcome.timedOut || outcome.exitCode !== 0 ? "failed" as const : "finished" as const;
    const summary = refused
      ? `worker refused by the OS boundary (${exit})`
      : outcome.timedOut
        ? `contained worker timed out after ${this.#timeoutMs}ms and its process group was terminated`
        : `contained worker completed with ${exit}`;
    return WorkerResultSchema.parse({ status, summary: summary.slice(0, 4000), artifacts: [], evidence: [] });
  }

  #spawn(command: string, args: readonly string[], executionRoot: string): Promise<ProcessOutcome> {
    return new Promise<ProcessOutcome>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: executionRoot,
        env: this.#env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const childPid = child.pid;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const append = (current: string, chunk: Buffer): string =>
        current.length >= this.#maxOutputBytes ? current : (current + chunk.toString("utf8")).slice(0, this.#maxOutputBytes);
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => {
        timedOut = true;
        if (childPid === undefined) {
          child.kill("SIGKILL");
          return;
        }
        signalGroup(childPid, "SIGTERM");
        const killTimer = setTimeout(() => signalGroup(childPid, "SIGKILL"), 1_000);
        killTimer.unref();
      }, this.#timeoutMs);
      timer.unref();
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, signal, stdout, stderr, timedOut });
      });
    });
  }

  async close(): Promise<void> {
    if (this.#scratchHome !== undefined) rmSync(this.#scratchHome, { recursive: true, force: true });
  }
}

class LocalWorkerRegistry implements WorkerRegistry {
  readonly #providers: readonly LocalCommandWorkerProvider[];
  constructor(providers: readonly LocalCommandWorkerProvider[]) { this.#providers = providers; }
  list(): readonly WorkerProvider[] { return this.#providers; }
  get(id: string): WorkerProvider | undefined { return this.#providers.find((provider) => provider.id === id); }
}

export interface LocalContainedWorkerHostOptions {
  id?: string;
  worker?: LocalCommandWorkerProvider;
  workers?: readonly LocalCommandWorkerProvider[];
}

/**
 * A host whose workers execute under OS containment.
 *
 * `HostCapabilities.sandbox` is DERIVED from whether the launcher can actually
 * impose a boundary on this machine, never asserted. That matters because
 * worker selection refuses a non-sandbox-capable host for write-enabled work
 * (issue #11): a host that could advertise containment it does not have would
 * turn that gate back into a label.
 */
export class LocalContainedWorkerHost implements HarnessHost {
  readonly id: string;
  readonly #workers: readonly LocalCommandWorkerProvider[];
  readonly #registry: WorkerRegistry;

  constructor(options: LocalContainedWorkerHostOptions = {}) {
    this.id = id.parse(options.id ?? "host:local-contained");
    const workers = [...(options.workers ?? []), ...(options.worker === undefined ? [] : [options.worker])];
    if (workers.length === 0) throw new Error(`${this.id} was constructed with no worker providers`);
    this.#workers = workers;
    this.#registry = new LocalWorkerRegistry(workers);
  }

  async capabilities(): Promise<HostCapabilities> {
    const availability = await Promise.all(this.#workers.map((worker) => worker.containmentAvailable()));
    return HostCapabilitiesSchema.parse({
      workers: true,
      processes: true,
      sessions: false,
      filesystem: false,
      // Every worker this host offers must be containable, or the host does not
      // claim containment at all. A partially contained host is an uncontained
      // one wearing a guarantee.
      sandbox: availability.length > 0 && availability.every(Boolean),
      tools: false,
    });
  }

  workers(): WorkerRegistry { return this.#registry; }
  processes(): ProcessProvider | null { return null; }
  sessions(): SessionProvider | null { return null; }
  filesystem(): FilesystemProvider | null { return null; }
  sandbox(): SandboxProvider | null { return { id: "sandbox:local-contained-worker" }; }
  tools(): ToolProvider | null { return null; }

  async close(): Promise<void> {
    for (const worker of this.#workers) await worker.close();
  }
}
