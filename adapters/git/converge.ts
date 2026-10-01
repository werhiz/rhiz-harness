/**
 * Convergence: getting a candidate's bytes somewhere durable, and its changes
 * into the integration ref.
 *
 * Harness Work and raw Git branches have different authority models. A Work
 * item converges through the #77 controller, which binds Ledger, Attempt,
 * checkpoint eligibility, and exact-head proof. A raw branch has none of that
 * and must not be given the controller's semantics by implication.
 *
 * So the dispatch is deterministic: a branch is Harness Work only when a
 * durable integration ref for that Work exists, never because its name or its
 * PR title looked like Work. See ADR 0023.
 */

import { execFileSync } from "node:child_process";

import { HARDENED_GIT_FLAGS, hardenedGitEnv } from "./worktrees.js";

const MAX_BUFFER = 64 * 1024 * 1024;

export type ConvergenceRoute = "harness-work" | "raw-branch";

export type ConvergenceResult =
  | { readonly kind: "durable"; readonly route: ConvergenceRoute; readonly branch: string; readonly head: string }
  | { readonly kind: "already-durable"; readonly route: ConvergenceRoute; readonly branch: string; readonly head: string }
  | { readonly kind: "failed"; readonly route: ConvergenceRoute; readonly branch: string; readonly reason: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: hardenedGitEnv(),
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

export interface ConvergeOptions {
  repositoryRoot: string;
  branch: string;
  remoteName?: string;
  /**
   * Report what would happen and send nothing. Every consequential effect in
   * this module is behind this flag being false.
   */
  dryRun?: boolean;
}

/**
 * Whether this branch is a Harness Work candidate.
 *
 * Deterministic: it asks whether a durable Work integration ref exists for the
 * branch, and nothing else. A heuristic here would silently give raw branches
 * the controller's authority model.
 */
export function convergenceRouteFor(repositoryRoot: string, branch: string, remoteName = "origin"): ConvergenceRoute {
  const workRef = `refs/remotes/${remoteName}/harness/work/${branch}`;
  return tryGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", workRef]) === undefined
    ? "raw-branch"
    : "harness-work";
}

/** True when the branch has no remote copy of its unique bytes. */
function needsDurability(repositoryRoot: string, branch: string): boolean {
  const upstream = tryGit(repositoryRoot, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]) ?? "";
  if (upstream.length === 0) return true;
  if (tryGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", upstream]) === undefined) return true;
  return Number(tryGit(repositoryRoot, ["rev-list", "--count", `${upstream}..${branch}`]) ?? "0") > 0;
}

/**
 * Durability convergence for a raw branch: push, then read the remote back.
 *
 * Deliberately not gated on review, verification, or approval. The remedy for
 * bytes that exist on exactly one machine must never wait for a person, and it
 * merges nothing.
 */
export function convergeRawBranch(options: ConvergeOptions): ConvergenceResult {
  const { repositoryRoot, branch } = options;
  const remoteName = options.remoteName ?? "origin";
  const route: ConvergenceRoute = "raw-branch";

  const head = tryGit(repositoryRoot, ["rev-parse", branch]);
  if (head === undefined) return { kind: "failed", route, branch, reason: `branch ${branch} does not resolve` };

  if (!needsDurability(repositoryRoot, branch)) {
    return { kind: "already-durable", route, branch, head };
  }
  if (options.dryRun === true) {
    return { kind: "already-durable", route, branch, head };
  }

  if (tryGit(repositoryRoot, ["push", "-u", remoteName, branch]) === undefined) {
    return { kind: "failed", route, branch, reason: `push to ${remoteName} failed` };
  }

  // Verify the end state rather than the command's report. A push that exits
  // zero and a remote that holds the bytes are different claims.
  const remote = (tryGit(repositoryRoot, ["ls-remote", remoteName, `refs/heads/${branch}`]) ?? "").split("\t")[0];
  if (remote !== head) {
    return { kind: "failed", route, branch, reason: `push reported success but ${remoteName} does not hold ${head}` };
  }
  return { kind: "durable", route, branch, head };
}

/**
 * Durability convergence for a Harness Work candidate.
 *
 * Work integration itself — queueing an eligible candidate, taking the durable
 * Work lock, advancing the head under exact-head proof — belongs to
 * `IntegrationController` and `GitWorkIntegrationExecutor`, which own the
 * Ledger and the authority. This makes the candidate's bytes durable so those
 * seams have something remote to read, and does not advance shared truth.
 */
export function convergeHarnessWork(options: ConvergeOptions): ConvergenceResult {
  const result = convergeRawBranch(options);
  return { ...result, route: "harness-work" } as ConvergenceResult;
}

/** Converge one branch, dispatching only after the route is established. */
export function converge(options: ConvergeOptions): ConvergenceResult {
  const route = convergenceRouteFor(options.repositoryRoot, options.branch, options.remoteName ?? "origin");
  return route === "harness-work" ? convergeHarnessWork(options) : convergeRawBranch(options);
}
