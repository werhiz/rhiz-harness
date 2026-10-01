import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CrewWorkspace,
  CrewWorkspaceAcquireRequest,
  CrewWorkspaceProvider,
  CrewWorkspaceSnapshot,
} from "../../src/crew.js";
import {
  CrewWorkspaceAcquireRequestSchema,
  CrewWorkspaceSchema,
  CrewWorkspaceSnapshotSchema,
} from "../../src/crew.js";
import {
  digestExecutionRoot,
  manifestChangedPaths,
  type ExecutionRootDigestLimits,
} from "../../src/workspace-digest.js";

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Git reads configuration out of the very repository we are inspecting, and
 * several of those settings execute programs. `core.pager`, `core.fsmonitor` and
 * `core.hooksPath` all run during ordinary plumbing like `status`, `rev-parse`
 * and `worktree remove`.
 *
 * The execution-root digest deliberately excludes `.git` (see
 * DEFAULT_EXECUTION_ROOT_EXCLUSIONS), so without this hardening a worker could
 * plant a hostile config in the one directory the identity does not cover and
 * get code executed by the act of snapshotting. These flags and this env are
 * what make that exclusion safe rather than a hole.
 */
export const HARDENED_GIT_FLAGS = [
  "-c", "core.fsmonitor=",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "protocol.ext.allow=never",
];

export function hardenedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: hardenedGitEnv(),
  }).trim();
}

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: hardenedGitEnv(),
  });
}

function gitCommand(cwd: string, args: string[]): void {
  execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd,
    stdio: "ignore",
    maxBuffer: MAX_BUFFER,
    env: hardenedGitEnv(),
  });
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "work").slice(0, 80);
}

function nulPaths(value: Buffer): string[] {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/\\/g, "/"));
}

function changedPaths(cwd: string): string[] {
  const paths = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "-z", "--no-ext-diff"],
    ["diff", "--cached", "--name-only", "-z", "--no-ext-diff"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    for (const path of nulPaths(gitBuffer(cwd, args))) paths.add(path);
  }
  return [...paths].sort();
}

/**
 * Retired: the git-scoped workspace digest.
 *
 * It hashed HEAD, `status`, both diffs and the non-ignored untracked files. All
 * of those honour `.gitignore`, so the identity excluded exactly the paths a
 * poisoned dependency would use. Identity now comes from
 * `digestExecutionRoot`, which hashes the bytes that will actually execute.
 * See issue #10.
 */

interface WorkspaceRecord {
  workspaceId: string;
  executionRoot: string;
  baseRevision: string;
  /**
   * Content manifest captured at acquisition. Change reporting is a diff against
   * this rather than a question put to git, which is what lets an ignored-path
   * write show up as a changed path.
   */
  baselineManifest: ReadonlyMap<string, string>;
}

export interface GitWorktreeWorkspaceProviderOptions {
  repositoryRoot: string;
  worktreeRoot?: string;
  now?: () => string;
  idFactory?: () => string;
  /** Bounds for the execution-root walk. Exceeding one throws; it never truncates. */
  digestLimits?: Partial<ExecutionRootDigestLimits>;
  /**
   * Trusted operator preparation performed after the detached worktree is
   * created but before its execution identity is pinned. This exists for
   * materialising ignored dependencies such as node_modules. Preparation may
   * not move HEAD or change/stage/create any non-ignored source path; those
   * cases fail before the workspace is admitted.
   */
  prepareWorkspace?: (executionRoot: string) => Promise<void> | void;
}

export class GitWorktreeWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:git-worktree";
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly #now: () => string;
  readonly #idFactory: () => string;
  readonly #digestLimits: Partial<ExecutionRootDigestLimits>;
  readonly #prepareWorkspace: ((executionRoot: string) => Promise<void> | void) | undefined;
  readonly #records = new Map<string, WorkspaceRecord>();
  #closed = false;

  constructor(options: GitWorktreeWorkspaceProviderOptions) {
    const requestedRoot = resolve(options.repositoryRoot);
    this.repositoryRoot = gitText(requestedRoot, ["rev-parse", "--show-toplevel"]);
    this.worktreeRoot = resolve(
      options.worktreeRoot ?? join(this.repositoryRoot, ".context/rhiz-harness/crew-worktrees"),
    );
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#digestLimits = options.digestLimits ?? {};
    this.#prepareWorkspace = options.prepareWorkspace;
  }

  async acquire(rawRequest: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> {
    if (this.#closed) throw new Error("Git worktree workspace provider is closed");
    const request = CrewWorkspaceAcquireRequestSchema.parse(rawRequest);

    if (request.sourceWorkspace !== undefined) {
      const source = request.sourceWorkspace;
      const record = this.#records.get(source.workspaceId);
      if (!record) throw new Error(`source workspace ${source.workspaceId} is not owned by this provider`);
      if (record.executionRoot !== source.executionRoot || record.baseRevision !== source.baseRevision) {
        throw new Error(`source workspace ${source.workspaceId} does not match the provider record`);
      }
      return CrewWorkspaceSchema.parse({
        leaseId: `lease:${this.#idFactory()}`,
        workspaceId: record.workspaceId,
        uri: pathToFileURL(record.executionRoot).href,
        executionRoot: record.executionRoot,
        baseRevision: record.baseRevision,
        mode: request.mode,
        sourceWorkId: request.sourceWorkId,
      });
    }

    const baseRevision = gitText(this.repositoryRoot, ["rev-parse", `${request.baseRevision}^{commit}`]);
    const workspaceId = `workspace:${this.#idFactory()}`;
    const executionRoot = join(
      this.worktreeRoot,
      `${safeSegment(request.crewId)}-${safeSegment(request.work.id)}-${safeSegment(workspaceId)}`,
    );
    mkdirSync(this.worktreeRoot, { recursive: true });

    try {
      gitCommand(this.repositoryRoot, ["worktree", "add", "--detach", executionRoot, baseRevision]);
      const actualHead = gitText(executionRoot, ["rev-parse", "HEAD"]);
      if (actualHead !== baseRevision) {
        throw new Error(`worktree HEAD ${actualHead} does not match requested base ${baseRevision}`);
      }

      if (this.#prepareWorkspace !== undefined) {
        await this.#prepareWorkspace(executionRoot);
        const preparedHead = gitText(executionRoot, ["rev-parse", "HEAD"]);
        if (preparedHead !== baseRevision) {
          throw new Error(`workspace preparation moved HEAD from ${baseRevision} to ${preparedHead}`);
        }
        const sourceChanges = changedPaths(executionRoot);
        if (sourceChanges.length > 0) {
          throw new Error(
            `workspace preparation changed non-ignored source paths before baseline identity: ${sourceChanges.join(", ")}`,
          );
        }
      }

      // Ignored dependencies created by trusted preparation are included by the
      // execution-root digest. The resulting baseline therefore identifies the
      // bytes the worker and verifier will actually execute, not only git truth.
      const baseline = await digestExecutionRoot(executionRoot, { limits: this.#digestLimits });
      this.#records.set(workspaceId, {
        workspaceId,
        executionRoot,
        baseRevision,
        baselineManifest: baseline.manifest,
      });
      return CrewWorkspaceSchema.parse({
        leaseId: `lease:${this.#idFactory()}`,
        workspaceId,
        uri: pathToFileURL(executionRoot).href,
        executionRoot,
        baseRevision,
        mode: request.mode,
      });
    } catch (error) {
      try {
        gitCommand(this.repositoryRoot, ["worktree", "remove", "--force", executionRoot]);
      } catch {
        rmSync(executionRoot, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async snapshot(rawWorkspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot> {
    const workspace = CrewWorkspaceSchema.parse(rawWorkspace);
    const record = this.#records.get(workspace.workspaceId);
    if (!record) throw new Error(`workspace ${workspace.workspaceId} is not active`);
    if (record.executionRoot !== workspace.executionRoot) {
      throw new Error(`workspace ${workspace.workspaceId} execution root does not match provider state`);
    }
    if (!existsSync(record.executionRoot)) throw new Error(`workspace ${workspace.workspaceId} no longer exists`);
    const identity = await digestExecutionRoot(record.executionRoot, { limits: this.#digestLimits });
    // Union of two views on purpose. The manifest diff is the authority and is
    // the only one that can see an ignored path; git's view is retained because
    // it still reports staged intent that leaves file content identical.
    const changed = new Set<string>([
      ...manifestChangedPaths(record.baselineManifest, identity.manifest),
      ...changedPaths(record.executionRoot),
    ]);
    return CrewWorkspaceSnapshotSchema.parse({
      workspaceId: workspace.workspaceId,
      head: gitText(record.executionRoot, ["rev-parse", "HEAD"]),
      digest: identity.digest,
      digestScope: identity.scope,
      changedPaths: [...changed].sort(),
      observedAt: this.#now(),
    });
  }

  async release(workspaceId: string): Promise<void> {
    const record = this.#records.get(workspaceId);
    if (!record) return;
    this.#records.delete(workspaceId);
    try {
      gitCommand(this.repositoryRoot, ["worktree", "remove", "--force", record.executionRoot]);
    } finally {
      rmSync(record.executionRoot, { recursive: true, force: true });
      try {
        gitCommand(this.repositoryRoot, ["worktree", "prune"]);
      } catch {
        // Worktree removal already completed; prune is best-effort housekeeping.
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const workspaceId of [...this.#records.keys()].reverse()) {
      try {
        await this.release(workspaceId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Git worktree workspace cleanup failed");
  }

  activeWorkspaceIds(): readonly string[] {
    return [...this.#records.keys()].sort();
  }
}
