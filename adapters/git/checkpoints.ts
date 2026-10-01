import { execFileSync } from "node:child_process";

import type { CrewWorkspaceSnapshot } from "../../src/crew.js";
import type { ResourceRef } from "../../src/schemas.js";
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

export function harnessGitRefSegment(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "work").slice(0, 80);
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    throw new Error(`invalid candidate path ${JSON.stringify(value)}`);
  }
  return normalized;
}

export interface CandidatePathScope {
  path: string;
  kind: "file" | "directory" | "repository";
}

export interface CandidateCommit {
  head: string;
  tree: string;
  rescueRef: string;
  changedPaths: readonly string[];
}

export interface RemoteCandidateCommit extends CandidateCommit {
  remoteRef: string;
  remoteStatus: "pushed";
}

export interface PreserveCandidateOptions {
  executionRoot: string;
  expectedBaseRevision: string;
  workId: string;
  attemptId: string;
  snapshot: CrewWorkspaceSnapshot;
  allowed: readonly CandidatePathScope[];
  message?: string;
}

export function candidatePathScopesFromResources(
  resources: readonly ResourceRef[],
): CandidatePathScope[] {
  return resources.map((resource) => {
    if (resource.kind === "repository") return { path: ".", kind: "repository" as const };
    const uri = resource.uri;
    let path: string | null = null;
    if (uri.startsWith("repo://")) {
      const rest = uri.slice("repo://".length);
      const slash = rest.indexOf("/");
      path = slash === -1 ? null : rest.slice(slash + 1);
    } else {
      for (const prefix of ["file://", "dir://", "path://"]) {
        if (uri.startsWith(prefix)) {
          path = uri.slice(prefix.length);
          break;
        }
      }
    }
    if (path === null || (resource.kind !== "file" && resource.kind !== "directory")) {
      throw new Error(`unsupported candidate write-scope resource ${resource.uri}`);
    }
    return { path: normalizePath(path), kind: resource.kind };
  });
}

function pathAllowed(path: string, scopes: readonly CandidatePathScope[]): boolean {
  return scopes.some((scope) => {
    if (scope.kind === "repository") return true;
    const root = normalizePath(scope.path).replace(/\/$/, "");
    if (scope.kind === "file") return path === root;
    return path === root || path.startsWith(`${root}/`);
  });
}

export function assertCandidatePathsAllowed(
  changedPaths: readonly string[],
  allowed: readonly CandidatePathScope[],
): string[] {
  const normalized = [...new Set(changedPaths.map(normalizePath))].sort();
  if (normalized.length === 0) throw new Error("candidate contains no changed paths");
  const forbidden = normalized.filter((path) => !pathAllowed(path, allowed));
  if (forbidden.length > 0) {
    throw new Error(`candidate changed paths outside Work write scope: ${forbidden.join(", ")}`);
  }
  return normalized;
}

/**
 * Make worker bytes durable before verification without giving the worker Git
 * authority. The candidate is committed by the Harness and immediately held by
 * a Harness-owned rescue ref. A later verified checkpoint may promote the same
 * exact commit to the Work integration ref.
 */
export function preserveCandidate(raw: PreserveCandidateOptions): CandidateCommit {
  const expected = git(raw.executionRoot, ["rev-parse", `${raw.expectedBaseRevision}^{commit}`]);
  const headBefore = git(raw.executionRoot, ["rev-parse", "HEAD"]);
  if (headBefore !== expected) {
    throw new Error(`candidate workspace HEAD ${headBefore} does not match expected base ${expected}`);
  }
  if (raw.snapshot.head !== expected) {
    throw new Error(`candidate snapshot head ${raw.snapshot.head} does not match expected base ${expected}`);
  }

  const changedPaths = assertCandidatePathsAllowed(raw.snapshot.changedPaths, raw.allowed);
  git(raw.executionRoot, ["add", "-A", "--", ...changedPaths]);

  const staged = git(raw.executionRoot, ["diff", "--cached", "--name-only", "--no-ext-diff"])
    .split("\n")
    .filter(Boolean)
    .map(normalizePath)
    .sort();
  if (JSON.stringify(staged) !== JSON.stringify(changedPaths)) {
    throw new Error(
      `staged candidate paths do not equal observed changed paths: expected ${changedPaths.join(", ")}; got ${staged.join(", ")}`,
    );
  }

  const message = raw.message ?? `rhiz: checkpoint ${raw.workId}`;
  git(raw.executionRoot, [
    "-c", "user.name=Rhiz Harness",
    "-c", "user.email=rhiz-harness@localhost.invalid",
    "commit",
    "--no-gpg-sign",
    "-m", message,
  ]);

  const head = git(raw.executionRoot, ["rev-parse", "HEAD"]);
  const tree = git(raw.executionRoot, ["rev-parse", "HEAD^{tree}"]);
  const rescueRef = `refs/rhiz/rescue/${harnessGitRefSegment(raw.workId)}/${harnessGitRefSegment(raw.attemptId)}/${head}`;
  git(raw.executionRoot, ["update-ref", rescueRef, head]);

  return { head, tree, rescueRef, changedPaths };
}

export function remoteRefHead(repositoryRoot: string, remoteName: string, ref: string): string | null {
  const result = git(repositoryRoot, ["ls-remote", "--refs", remoteName, ref]);
  if (result.length === 0) return null;
  const [head, resolvedRef] = result.split(/\s+/);
  if (head === undefined || resolvedRef !== ref) {
    throw new Error(`remote ${remoteName} returned an ambiguous value for ${ref}`);
  }
  return head;
}

/**
 * Push a Harness-owned immutable checkpoint and read it back before claiming
 * durability. An existing ref may be reused only when it names the same exact
 * commit; Harness never overwrites unique candidate history.
 */
export function pushHarnessCheckpoint(options: {
  repositoryRoot: string;
  remoteName?: string;
  ref: string;
  head: string;
}): "pushed" {
  const remoteName = options.remoteName ?? "origin";
  const exact = git(options.repositoryRoot, ["rev-parse", `${options.head}^{commit}`]);
  if (exact !== options.head) throw new Error("checkpoint head did not resolve exactly");
  const current = remoteRefHead(options.repositoryRoot, remoteName, options.ref);
  if (current !== null && current !== exact) {
    throw new Error(`remote checkpoint ${options.ref} already names different history ${current}`);
  }
  if (current === null) git(options.repositoryRoot, ["push", remoteName, `${exact}:${options.ref}`]);
  const observed = remoteRefHead(options.repositoryRoot, remoteName, options.ref);
  if (observed !== exact) throw new Error(`remote checkpoint ${options.ref} was not durably observed at ${exact}`);
  return "pushed";
}

/** Preserve, push, and read back worker bytes as one Harness-owned operation. */
export function preserveCandidateRemotely(
  raw: PreserveCandidateOptions & { repositoryRoot: string; remoteName?: string },
): RemoteCandidateCommit {
  const candidate = preserveCandidate(raw);
  pushHarnessCheckpoint({
    repositoryRoot: raw.repositoryRoot,
    ...(raw.remoteName === undefined ? {} : { remoteName: raw.remoteName }),
    ref: candidate.rescueRef,
    head: candidate.head,
  });
  return { ...candidate, remoteRef: candidate.rescueRef, remoteStatus: "pushed" };
}

export function promoteVerifiedCandidate(options: {
  executionRoot: string;
  workId: string;
  candidateHead: string;
}): string {
  const exact = git(options.executionRoot, ["rev-parse", `${options.candidateHead}^{commit}`]);
  if (exact !== options.candidateHead) throw new Error("candidate head did not resolve exactly");
  const ref = `refs/rhiz/work/${harnessGitRefSegment(options.workId)}/candidate`;
  git(options.executionRoot, ["update-ref", ref, exact]);
  return ref;
}
