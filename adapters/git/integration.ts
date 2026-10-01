import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type {
  IntegrationExecutionRequest,
  IntegrationExecutionResult,
  WorkIntegrationExecutor,
} from "../../src/integration.js";
import type { EvidenceRef } from "../../src/schemas.js";
import {
  harnessGitRefSegment,
  pushHarnessCheckpoint,
  remoteRefHead,
} from "./checkpoints.js";
import { HARDENED_GIT_FLAGS, hardenedGitEnv } from "./worktrees.js";

const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: hardenedGitEnv(),
  }).trim();
}

function gitQuiet(cwd: string, args: string[]): void {
  execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd,
    stdio: "ignore",
    maxBuffer: MAX_BUFFER,
    env: hardenedGitEnv(),
  });
}

function assertCommitTree(repositoryRoot: string, head: string, tree: string): void {
  const exactHead = git(repositoryRoot, ["rev-parse", `${head}^{commit}`]);
  const exactTree = git(repositoryRoot, ["rev-parse", `${head}^{tree}`]);
  if (exactHead !== head || exactTree !== tree) {
    throw new Error(`checkpoint identity mismatch: expected ${head}/${tree}; observed ${exactHead}/${exactTree}`);
  }
}

function advanceRemoteRef(options: {
  repositoryRoot: string;
  remoteName: string;
  ref: string;
  expectedHead: string;
  nextHead: string;
}): void {
  const current = remoteRefHead(options.repositoryRoot, options.remoteName, options.ref);
  if (current === options.nextHead) return;
  if (current !== options.expectedHead) {
    throw new Error(`integration ref ${options.ref} moved from ${options.expectedHead} to ${current ?? "<missing>"}`);
  }
  git(options.repositoryRoot, [
    "push",
    `--force-with-lease=${options.ref}:${options.expectedHead}`,
    options.remoteName,
    `${options.nextHead}:${options.ref}`,
  ]);
  const observed = remoteRefHead(options.repositoryRoot, options.remoteName, options.ref);
  if (observed !== options.nextHead) throw new Error(`integration ref ${options.ref} did not converge to ${options.nextHead}`);
}

/** Create or verify the one durable remote integration ref for a Work. */
export function initializeWorkIntegrationRef(options: {
  repositoryRoot: string;
  remoteName?: string;
  ref: string;
  head: string;
}): void {
  const repositoryRoot = git(resolve(options.repositoryRoot), ["rev-parse", "--show-toplevel"]);
  const remoteName = options.remoteName ?? "origin";
  const exact = git(repositoryRoot, ["rev-parse", `${options.head}^{commit}`]);
  if (exact !== options.head) throw new Error("integration head did not resolve exactly");
  const current = remoteRefHead(repositoryRoot, remoteName, options.ref);
  if (current !== null && current !== exact) {
    throw new Error(`Work integration ref ${options.ref} already exists at ${current}, not ${exact}`);
  }
  if (current === null) git(repositoryRoot, ["push", remoteName, `${exact}:${options.ref}`]);
  if (remoteRefHead(repositoryRoot, remoteName, options.ref) !== exact) {
    throw new Error(`Work integration ref ${options.ref} was not durably observed at ${exact}`);
  }
  git(repositoryRoot, ["update-ref", options.ref, exact]);
}

export interface GitIntegrationProofRequest extends IntegrationExecutionRequest {
  readonly executionRoot: string;
  readonly targetHead: string;
  readonly targetTree: string;
}

export type GitIntegrationProofResult =
  | {
    status: "passed";
    proofHead: string;
    evidence: readonly EvidenceRef[];
    verificationEventId?: string;
  }
  | { status: "conflict"; reason: string };

export interface GitWorkIntegrationExecutorOptions {
  repositoryRoot: string;
  remoteName?: string;
  worktreeRoot?: string;
  idFactory?: () => string;
  prove(request: GitIntegrationProofRequest): Promise<GitIntegrationProofResult>;
}

/**
 * The Git implementation of the replaceable Work integration executor. It is
 * the only component here that may reconcile commits or advance a shared ref.
 * Every mutation is Harness-owned, remote-observed, and recoverably idempotent.
 */
export class GitWorkIntegrationExecutor implements WorkIntegrationExecutor {
  readonly repositoryRoot: string;
  readonly remoteName: string;
  readonly worktreeRoot: string;
  readonly #idFactory: () => string;
  readonly #prove: GitWorkIntegrationExecutorOptions["prove"];

  constructor(options: GitWorkIntegrationExecutorOptions) {
    const requested = resolve(options.repositoryRoot);
    this.repositoryRoot = git(requested, ["rev-parse", "--show-toplevel"]);
    this.remoteName = options.remoteName ?? "origin";
    this.worktreeRoot = resolve(options.worktreeRoot ?? join(this.repositoryRoot, ".context/rhiz-harness/integration-worktrees"));
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#prove = options.prove;
  }

  async reconcile(request: IntegrationExecutionRequest): Promise<IntegrationExecutionResult> {
    const checkpointRef = request.checkpoint.remoteRef;
    if (request.checkpoint.remoteStatus !== "pushed" || checkpointRef === undefined) {
      throw new Error(`checkpoint ${request.checkpoint.id} is not remotely durable`);
    }
    if (remoteRefHead(this.repositoryRoot, this.remoteName, checkpointRef) !== request.checkpoint.head) {
      throw new Error(`remote checkpoint ${checkpointRef} does not name ${request.checkpoint.head}`);
    }
    git(this.repositoryRoot, ["fetch", "--no-tags", this.remoteName, checkpointRef]);
    assertCommitTree(this.repositoryRoot, request.checkpoint.head, request.checkpoint.tree);

    if (request.purpose === "integrate-candidate") return this.#integrateCandidate(request);
    return this.#reconcileStaleAttempt(request);
  }

  async #integrateCandidate(request: IntegrationExecutionRequest): Promise<IntegrationExecutionResult> {
    if (request.checkpoint.parentIntegrationHead !== request.integrationHead) {
      return this.#preserveConflict(request, "candidate was built from a stale Work integration head");
    }
    try {
      gitQuiet(this.repositoryRoot, ["merge-base", "--is-ancestor", request.integrationHead, request.checkpoint.head]);
    } catch {
      return this.#preserveConflict(request, "candidate does not descend from the current Work integration head");
    }

    const proof = await this.#prove({
      ...request,
      executionRoot: this.repositoryRoot,
      targetHead: request.checkpoint.head,
      targetTree: request.checkpoint.tree,
    });
    if (proof.status === "conflict") return this.#preserveConflict(request, proof.reason);
    if (proof.proofHead !== request.checkpoint.head || proof.verificationEventId === undefined) {
      throw new Error("final integration proof must name the exact candidate head and a verification event");
    }

    advanceRemoteRef({
      repositoryRoot: this.repositoryRoot,
      remoteName: this.remoteName,
      ref: request.integrationRef,
      expectedHead: request.integrationHead,
      nextHead: request.checkpoint.head,
    });
    git(this.repositoryRoot, ["update-ref", request.integrationRef, request.checkpoint.head]);
    return {
      status: "integrated",
      head: request.checkpoint.head,
      tree: request.checkpoint.tree,
      proofHead: proof.proofHead,
      verificationEventId: proof.verificationEventId,
      remoteRef: request.integrationRef,
    };
  }

  async #reconcileStaleAttempt(request: IntegrationExecutionRequest): Promise<IntegrationExecutionResult> {
    mkdirSync(this.worktreeRoot, { recursive: true });
    const executionRoot = join(
      this.worktreeRoot,
      `${harnessGitRefSegment(request.workId)}-${harnessGitRefSegment(request.attemptId)}-${harnessGitRefSegment(this.#idFactory())}`,
    );
    try {
      gitQuiet(this.repositoryRoot, ["worktree", "add", "--detach", executionRoot, request.integrationHead]);
      try {
        gitQuiet(executionRoot, [
          "-c", "user.name=Rhiz Harness",
          "-c", "user.email=rhiz-harness@localhost.invalid",
          "cherry-pick", "--no-gpg-sign", request.checkpoint.head,
        ]);
      } catch {
        try { gitQuiet(executionRoot, ["cherry-pick", "--abort"]); } catch {}
        return this.#preserveConflict(request, "candidate cannot be reconciled cleanly onto the current Work head");
      }
      const head = git(executionRoot, ["rev-parse", "HEAD"]);
      const tree = git(executionRoot, ["rev-parse", "HEAD^{tree}"]);
      const proof = await this.#prove({ ...request, executionRoot, targetHead: head, targetTree: tree });
      if (proof.status === "conflict") return this.#preserveConflict(request, proof.reason);
      if (proof.proofHead !== head || proof.evidence.length === 0) {
        throw new Error("reconciled task proof must name the exact reconciled head and carry evidence");
      }
      const remoteRef = `refs/rhiz/reconciled/${harnessGitRefSegment(request.workId)}/${harnessGitRefSegment(request.attemptId)}`;
      git(this.repositoryRoot, ["update-ref", remoteRef, head]);
      pushHarnessCheckpoint({ repositoryRoot: this.repositoryRoot, remoteName: this.remoteName, ref: remoteRef, head });
      return { status: "reconciled", head, tree, proofHead: proof.proofHead, evidence: [...proof.evidence], remoteRef };
    } finally {
      try { gitQuiet(this.repositoryRoot, ["worktree", "remove", "--force", executionRoot]); }
      catch { rmSync(executionRoot, { recursive: true, force: true }); }
    }
  }

  #preserveConflict(request: IntegrationExecutionRequest, reason: string): IntegrationExecutionResult {
    const prefix = `refs/rhiz/conflicts/${harnessGitRefSegment(request.workId)}/${harnessGitRefSegment(request.attemptId)}`;
    const refs = [`${prefix}/integration-base`, `${prefix}/candidate`];
    for (const [ref, head] of [[refs[0]!, request.integrationHead], [refs[1]!, request.checkpoint.head]] as const) {
      git(this.repositoryRoot, ["update-ref", ref, head]);
      pushHarnessCheckpoint({ repositoryRoot: this.repositoryRoot, remoteName: this.remoteName, ref, head });
    }
    return { status: "conflict", reason, preservedRefs: refs };
  }
}
