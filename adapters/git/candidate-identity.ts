import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { CandidateIdentity, CandidateIdentityProbe } from "../../src/disposable.js";
import { CandidateIdentitySchema } from "../../src/disposable.js";
import { digestExecutionRoot, type ExecutionRootDigestLimits } from "../../src/workspace-digest.js";
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

export interface GitCandidateIdentityProbeOptions {
  now?: () => string;
  /** Bounds for the content walk. Exceeding one throws; it never truncates. */
  digestLimits?: Partial<ExecutionRootDigestLimits>;
}

/**
 * Content-level identity of a git checkout.
 *
 * Three facts, because no two of them see the same thing, and the mutation that
 * caused issue #63 was invisible to two:
 *
 *   - `HEAD`, the commit;
 *   - `HEAD^{tree}`, its content, which distinguishes an amend that changed
 *     files from one that only changed a message;
 *   - the execution-root content digest, which is the only one that notices an
 *     uncommitted edit — and `const acceptable = true` in `src/board.ts` was an
 *     uncommitted edit.
 *
 * The git invocations run with the same hardening as the worktree provider,
 * for the same reason: the digest excludes `.git`, so a hostile `core.pager` or
 * `core.hooksPath` in the candidate would otherwise execute during the act of
 * identifying it.
 *
 * An unborn HEAD is reported as `unborn` rather than as an error. A fresh
 * repository is a legitimate candidate, and two unborn pins compare equal, which
 * is the right answer.
 */
export class GitCandidateIdentityProbe implements CandidateIdentityProbe {
  readonly id = "candidate-identity:git-content";
  readonly #now: () => string;
  readonly #digestLimits: Partial<ExecutionRootDigestLimits>;

  constructor(options: GitCandidateIdentityProbeOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#digestLimits = options.digestLimits ?? {};
  }

  async pin(executionRoot: string): Promise<CandidateIdentity> {
    const root = await realpath(resolve(executionRoot));
    const topLevel = await realpath(git(root, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== root) {
      // A pin taken from a subdirectory would carry HEAD and tree for the whole
      // repository next to a digest for one folder, and the two halves would
      // disagree about what artifact the receipt is even about.
      throw new Error(`candidate root ${root} is not a checkout top level (git reports ${topLevel})`);
    }

    // `--verify -q` exits non-zero on an unborn HEAD rather than printing a
    // diagnostic that would end up parsed as an object id.
    let head = "unborn";
    let tree = "unborn";
    try {
      head = git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
      tree = git(root, ["rev-parse", "--verify", "-q", "HEAD^{tree}"]);
    } catch {
      head = "unborn";
      tree = "unborn";
    }

    const identity = await digestExecutionRoot(root, { limits: this.#digestLimits });
    return CandidateIdentitySchema.parse({
      executionRoot: root,
      head,
      tree,
      digest: identity.digest,
      digestScope: identity.scope,
      observedAt: this.#now(),
    });
  }
}
