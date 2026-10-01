/**
 * The horizon sensor.
 *
 * `src/horizon.ts` decides; this measures. Every field of
 * `IntegrationHorizonSignals` had existed for months with nothing in the
 * repository producing one from real Git state, which is why the horizon never
 * ran. This is that missing half.
 *
 * Measurement is reported as `measured | unavailable`. A sensor failure is not
 * a policy verdict: a detached HEAD, an absent `git`, a corrupt repository, an
 * unparseable timestamp, or a failed `rev-list` must never be reported as
 * `clear`, and must not be reported as `tripped` either. See ADR 0023.
 */

import { execFileSync } from "node:child_process";

import type { IntegrationHorizonSignals, UpstreamState } from "../../src/integration.js";
import type { IntegrationHorizonBaseline } from "../../src/horizon.js";
import { HARDENED_GIT_FLAGS, hardenedGitEnv } from "./worktrees.js";

const MAX_BUFFER = 64 * 1024 * 1024;

export type BranchMeasurement =
  | { readonly kind: "measured"; readonly branch: string; readonly signals: IntegrationHorizonSignals }
  | { readonly kind: "unavailable"; readonly branch: string; readonly reason: string };

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

/**
 * Durability of the candidate's unique bytes.
 *
 * `pushed` is the only state in which losing this machine loses nothing. An
 * upstream that no longer resolves is `upstream-gone` rather than `pushed`,
 * because a recorded upstream that is not there protects nothing.
 */
export function measureUpstreamState(repositoryRoot: string, branch: string): UpstreamState {
  // Durability asks one question: would losing this machine lose any of these
  // commits? So it is measured by reachability from ANY remote ref, not by
  // whether one particular upstream happens to track the branch.
  //
  // This distinction is not theoretical. Seven branches whose own upstreams had
  // diverged were preserved under `rescue/*` refs on the remote. Their bytes
  // were safe; an upstream-tracking check still called them at risk, which is a
  // false alarm that teaches people to ignore the alarm.
  const undurable = tryGit(repositoryRoot, ["rev-list", "--count", branch, "--not", "--remotes"]);
  if (undurable !== undefined && Number(undurable) === 0) return "pushed";

  const upstream = tryGit(repositoryRoot, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]);
  if (upstream === undefined || upstream.length === 0) return "no-upstream";
  if (tryGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", upstream]) === undefined) return "upstream-gone";
  return "ahead-of-remote";
}

/**
 * Time since divergence began: the committer date of the OLDEST candidate-only
 * commit after the merge base.
 *
 * Not the merge base's own age, which is the age of the common ancestor and
 * says nothing about how long private work has been accumulating. A branch cut
 * today from a year-old base has diverged for a day, not a year.
 */
function measureDivergenceAgeMs(repositoryRoot: string, base: string, branch: string, now: number): number | undefined {
  // `--max-count` is applied BEFORE `--reverse`, so `--max-count=1 --reverse`
  // yields the NEWEST candidate-only commit. That reads correctly on a
  // single-commit branch and silently reports near-zero divergence age on every
  // long-lived one, which is precisely the branch this signal exists to catch.
  // Take the whole list in oldest-first order and read its first entry.
  const committerDates = tryGit(repositoryRoot, ["log", "--reverse", "--format=%ct", `${base}..${branch}`]);
  if (committerDates === undefined) return undefined;
  if (committerDates.length === 0) return 0;

  const oldest = committerDates.split("\n", 1)[0];
  const parsed = Number(oldest);
  if (!Number.isFinite(parsed)) return undefined;

  return Math.max(0, now - parsed * 1000);
}

/**
 * Added plus deleted lines against the merge base, and a count of binary files.
 *
 * `--numstat` prints `-` for a binary file. Coercing that to zero would let a
 * branch that rewrote a hundred megabytes of assets read as no drift at all.
 */
function measureDiff(
  repositoryRoot: string,
  base: string,
  branch: string,
): { diffLines: number; binaryFilesChanged: number } | undefined {
  const numstat = tryGit(repositoryRoot, ["diff", "--numstat", `${base}...${branch}`]);
  if (numstat === undefined) return undefined;
  if (numstat.length === 0) return { diffLines: 0, binaryFilesChanged: 0 };

  let diffLines = 0;
  let binaryFilesChanged = 0;
  for (const line of numstat.split("\n")) {
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") {
      binaryFilesChanged += 1;
      continue;
    }
    const a = Number(added);
    const d = Number(deleted);
    if (!Number.isFinite(a) || !Number.isFinite(d)) return undefined;
    diffLines += a + d;
  }
  return { diffLines, binaryFilesChanged };
}

export interface MeasureBranchOptions {
  repositoryRoot: string;
  /** The integration ref this candidate is measured against, e.g. `origin/main`. */
  integrationRef: string;
  branch: string;
  now?: () => number;
}

/** Measure one branch into horizon signals, or report why it could not be measured. */
export function measureBranchDrift(options: MeasureBranchOptions): BranchMeasurement {
  const { repositoryRoot, integrationRef, branch } = options;
  const now = options.now?.() ?? Date.now();
  const unavailable = (reason: string): BranchMeasurement => ({ kind: "unavailable", branch, reason });

  if (tryGit(repositoryRoot, ["rev-parse", "--git-dir"]) === undefined) {
    return unavailable("not a Git repository, or `git` is unavailable");
  }
  if (tryGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) {
    return unavailable(`no such branch ${branch}`);
  }
  const integrationHead = tryGit(repositoryRoot, ["rev-parse", "--verify", "--quiet", integrationRef]);
  if (integrationHead === undefined) return unavailable(`integration ref ${integrationRef} does not resolve`);

  // A branch that IS the integration ref has not diverged from anything.
  const branchHead = tryGit(repositoryRoot, ["rev-parse", branch]);
  if (branchHead === undefined) return unavailable(`branch ${branch} does not resolve`);

  const counts = tryGit(repositoryRoot, ["rev-list", "--left-right", "--count", `${integrationRef}...${branch}`]);
  if (counts === undefined) return unavailable("rev-list failed; the repository may be corrupt or the refs unrelated");
  const [behindRaw, aheadRaw] = counts.split(/\s+/);
  const commitsBehind = Number(behindRaw);
  const commitsAhead = Number(aheadRaw);
  if (!Number.isFinite(commitsBehind) || !Number.isFinite(commitsAhead)) {
    return unavailable(`rev-list returned an unparseable count ${JSON.stringify(counts)}`);
  }

  const divergenceAgeMs = measureDivergenceAgeMs(repositoryRoot, integrationRef, branch, now);
  if (divergenceAgeMs === undefined) return unavailable("could not read the oldest candidate-only commit date");

  const diff = measureDiff(repositoryRoot, integrationRef, branch);
  if (diff === undefined) return unavailable("could not measure the diff against the merge base");

  return {
    kind: "measured",
    branch,
    signals: {
      commitsAhead,
      commitsBehind,
      elapsedMsSinceConvergence: 0,
      divergenceAgeMs,
      diffLines: diff.diffLines,
      binaryFilesChanged: diff.binaryFilesChanged,
      upstreamState: measureUpstreamState(repositoryRoot, branch),
      overlappingResourceClaims: 0,
      integrationHeadMoved: false,
      proofInvalidationRisk: false,
    },
  };
}

/**
 * The branch currently checked out, or `undefined` on a detached HEAD.
 *
 * A detached HEAD is not an error and not a clear verdict: there is no branch
 * whose divergence could be measured, so the caller reports `unavailable`.
 */
export function currentBranch(repositoryRoot: string): string | undefined {
  const name = tryGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return name === undefined || name.length === 0 ? undefined : name;
}

/** Every local branch that has any unique commit relative to the integration ref. */
export function driftedBranches(repositoryRoot: string, integrationRef: string): readonly string[] {
  const all = tryGit(repositoryRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]) ?? "";
  if (all.length === 0) return [];

  const drifted: string[] = [];
  for (const branch of all.split("\n").filter((line) => line.length > 0)) {
    const ahead = tryGit(repositoryRoot, ["rev-list", "--count", `${integrationRef}..${branch}`]);
    if (ahead !== undefined && Number(ahead) > 0) drifted.push(branch);
  }
  return drifted;
}

/** The observed drift of a measurement, in the shape a baseline is frozen from. */
export function baselineFromSignals(signals: IntegrationHorizonSignals): IntegrationHorizonBaseline {
  return {
    commitsAhead: signals.commitsAhead,
    commitsBehind: signals.commitsBehind,
    elapsedMs: signals.divergenceAgeMs,
    diffLines: signals.diffLines,
  };
}
