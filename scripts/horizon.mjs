#!/usr/bin/env node
/**
 * The integration horizon, as an operator command.
 *
 * This is the only surface a consuming repository touches. Hooks shell out to
 * it and hold no thresholds of their own, so the number has exactly one owner.
 *
 * Exit codes are the contract (ADR 0023):
 *   0  measured; clear or grandfathered
 *   1  measured; tripped, with reasons
 *   2  could not establish the facts safely
 *
 * The third state exists so a sensor failure is never mistaken for a policy
 * verdict. A consuming repository is expected to fail closed on 2 where it
 * blocks work, and to warn on 2 where it must never block.
 *
 * Usage:
 *   node scripts/horizon.mjs check [--repo <path>] [--branch <name>] [--integration-ref <ref>] [--json]
 *   node scripts/horizon.mjs census [--repo <path>] [--integration-ref <ref>] [--json]
 *   node scripts/horizon.mjs baseline freeze [--repo <path>] [--integration-ref <ref>]
 *   node scripts/horizon.mjs converge [--repo <path>] [--branch <name>] [--durability-only] [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  baselineFromSignals,
  currentBranch,
  driftedBranches,
  measureBranchDrift,
} from "../dist/adapters/git/drift.js";
import {
  CALIBRATED_INTEGRATION_HORIZON,
  HORIZON_THRESHOLDS,
  decideHorizon,
  ratchetBaseline,
  ratchetReviewAnchor,
} from "../dist/src/horizon.js";

const EXIT_CLEAR = 0;
const EXIT_TRIPPED = 1;
const EXIT_UNAVAILABLE = 2;

const BASELINE_FILE = ".rhiz-horizon-baseline.json";
const REVIEW_FILE = ".rhiz-horizon-reviews.json";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

const flag = (name) => process.argv.includes(`--${name}`);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

function baselinePath(repo) {
  return join(repo, BASELINE_FILE);
}

function readBaselines(repo) {
  const path = baselinePath(repo);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed.branches ?? {};
  } catch {
    return {};
  }
}

function describe(decision) {
  if (decision.kind === "clear") return "clear";
  if (decision.kind === "grandfathered") return "grandfathered";
  if (decision.kind === "in_review") return `in review (diffLines limit ${decision.limit}, anchored at ${decision.anchorDiffLines})`;
  return decision.reasons.map((reason) => `${reason.signal} ${reason.observed} >= ${reason.limit}`).join("; ");
}

function readReviews(repo) {
  const path = join(repo, REVIEW_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")).reviews ?? {};
  } catch {
    return {};
  }
}

function writeReviews(repo, reviews) {
  const payload = {
    $comment: "Review anchors: a change's size when first observed under open review. Falls only. See ADR 0024.",
    reviews,
  };
  writeFileSync(join(repo, REVIEW_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * The host half of ADR 0024: is this branch a change under open review, and
 * what was its size when review began? The forge is asked, never assumed; any
 * failure to ask means no allowance, so the branch simply stays tripped.
 */
function reviewFor(repo, branch, signals) {
  if (signals.upstreamState !== "pushed") return { review: undefined, note: "not pushed" };
  let pr;
  try {
    pr = JSON.parse(
      execFileSync("gh", ["pr", "view", branch, "--json", "number,state,headRefOid"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      }),
    );
  } catch {
    return { review: undefined, note: "no open review found for this branch (or the forge could not be asked)" };
  }
  if (pr.state !== "OPEN") return { review: undefined, note: `review #${pr.number} is ${pr.state}` };
  const upstream = tryGit(repo, ["rev-parse", `${branch}@{upstream}`]);
  if (upstream === undefined || upstream !== pr.headRefOid) {
    return { review: undefined, note: `review #${pr.number} is not at this branch's pushed head` };
  }
  const reviews = readReviews(repo);
  const stored = reviews[branch];
  const observed = { anchorDiffLines: signals.diffLines };
  const review =
    stored !== undefined && stored.change === pr.number
      ? ratchetReviewAnchor({ anchorDiffLines: stored.anchorDiffLines }, observed)
      : observed;
  if (stored?.change !== pr.number || stored.anchorDiffLines !== review.anchorDiffLines) {
    reviews[branch] = {
      change: pr.number,
      anchorDiffLines: review.anchorDiffLines,
      recordedAt: stored?.change === pr.number ? stored.recordedAt : new Date().toISOString(),
    };
    writeReviews(repo, reviews);
  }
  return { review, note: `under review as #${pr.number}` };
}

function measure(repo, integrationRef, branch, baselines) {
  const measurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
  if (measurement.kind === "unavailable") return { branch, state: "unavailable", reason: measurement.reason };
  let decision = decideHorizon(measurement.signals, baselines[branch]);
  let review;
  // The forge is asked only when size alone tripped, so an ordinary check
  // never pays for a network call.
  if (decision.kind === "tripped" && decision.reasons.every((reason) => reason.signal === "diffLines")) {
    review = reviewFor(repo, branch, measurement.signals);
    decision = decideHorizon(measurement.signals, baselines[branch], review.review);
  }
  return {
    branch,
    state: decision.kind,
    decision,
    signals: measurement.signals,
    summary: describe(decision),
    ...(review ? { review: review.note } : {}),
  };
}

function commandCheck(repo, integrationRef) {
  const branch = option("branch", currentBranch(repo));
  if (branch === undefined) {
    const payload = { state: "unavailable", reason: "detached HEAD names no branch to measure" };
    report(payload);
    return EXIT_UNAVAILABLE;
  }

  const result = measure(repo, integrationRef, branch, readBaselines(repo));
  report(result);
  if (result.state === "unavailable") return EXIT_UNAVAILABLE;
  return result.state === "tripped" ? EXIT_TRIPPED : EXIT_CLEAR;
}

function report(payload) {
  if (flag("json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.state === "unavailable") {
    console.error(`horizon: UNAVAILABLE (${payload.reason})`);
    return;
  }
  if (payload.state === "tripped") {
    console.error(`horizon: TRIPPED on ${payload.branch}`);
    for (const reason of payload.decision.reasons) {
      console.error(`  ${reason.signal}: ${reason.observed} (limit ${reason.limit}) — ${reason.detail}`);
    }
    console.error("");
    if (payload.review) console.error(`  review allowance: ${payload.review}`);
    console.error(`  converge with: node scripts/horizon.mjs converge --branch ${payload.branch}`);
    return;
  }
  console.log(`horizon: ${payload.summary ?? payload.state} on ${payload.branch}`);
}

function commandCensus(repo, integrationRef) {
  const baselines = readBaselines(repo);
  const branches = driftedBranches(repo, integrationRef);
  const rows = branches.map((branch) => measure(repo, integrationRef, branch, baselines));

  const tally = { clear: 0, grandfathered: 0, in_review: 0, tripped: 0, unavailable: 0 };
  let durability = 0;
  for (const row of rows) {
    tally[row.state] += 1;
    if (row.state === "tripped" && row.decision.reasons.some((reason) => reason.signal === "upstreamState")) {
      durability += 1;
    }
  }

  if (flag("json")) {
    console.log(JSON.stringify({ integrationRef, policy: CALIBRATED_INTEGRATION_HORIZON.id, tally, durability, rows }, null, 2));
  } else {
    console.log(`horizon census against ${integrationRef} (policy ${CALIBRATED_INTEGRATION_HORIZON.id})`);
    console.log(`  branches measured : ${rows.length}`);
    console.log(`  clear             : ${tally.clear}`);
    console.log(`  grandfathered     : ${tally.grandfathered}`);
    console.log(`  in review         : ${tally.in_review}`);
    console.log(`  tripped           : ${tally.tripped}`);
    console.log(`    of which durability: ${durability}`);
    console.log(`  unavailable       : ${tally.unavailable}`);
  }
  return tally.unavailable > 0 && rows.length === tally.unavailable ? EXIT_UNAVAILABLE : EXIT_CLEAR;
}

function commandBaselineFreeze(repo, integrationRef) {
  const existing = readBaselines(repo);
  const branches = driftedBranches(repo, integrationRef);

  const frozen = {};
  let ratcheted = 0;
  let recorded = 0;
  for (const branch of branches) {
    const measurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
    if (measurement.kind !== "measured") continue;
    const observed = baselineFromSignals(measurement.signals);
    const previous = existing[branch];
    // The ratchet: a re-freeze may lower an inherited allowance and may never
    // raise one. Freezing twice cannot be used to forgive new drift.
    frozen[branch] = previous === undefined ? observed : ratchetBaseline(previous, observed);
    if (previous === undefined) recorded += 1;
    else if (JSON.stringify(frozen[branch]) !== JSON.stringify(previous)) ratcheted += 1;
  }

  const payload = {
    $comment: "Grandfathered volume drift. Ratchets down only; never forgives missing durability. See ADR 0023.",
    policy: CALIBRATED_INTEGRATION_HORIZON.id,
    thresholds: HORIZON_THRESHOLDS,
    integrationRef,
    integrationHead: tryGit(repo, ["rev-parse", integrationRef]) ?? null,
    frozenAt: new Date().toISOString(),
    branches: frozen,
  };
  writeFileSync(baselinePath(repo), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`horizon baseline frozen at ${baselinePath(repo)}`);
  console.log(`  branches recorded : ${Object.keys(frozen).length} (${recorded} new, ${ratcheted} ratcheted down)`);
  console.log("  durability is NOT grandfathered by this file");
  return EXIT_CLEAR;
}

function commandConverge(repo) {
  const branch = option("branch", currentBranch(repo));
  if (branch === undefined) {
    console.error("horizon: UNAVAILABLE (detached HEAD names no branch to converge)");
    return EXIT_UNAVAILABLE;
  }
  const dryRun = flag("dry-run");

  // Durability convergence is a push and nothing else. It is deliberately not
  // gated on review: the remedy for bytes that exist on one machine must be
  // available without a PR, a verification run, or anyone's approval.
  const upstream = tryGit(repo, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]) ?? "";
  const needsPush = upstream.length === 0
    || tryGit(repo, ["rev-parse", "--verify", "--quiet", upstream]) === undefined
    || Number(tryGit(repo, ["rev-list", "--count", `${upstream}..${branch}`]) ?? "0") > 0;

  if (!needsPush) {
    console.log(`horizon: ${branch} already has a durable remote copy`);
    return EXIT_CLEAR;
  }
  if (dryRun) {
    console.log(`horizon: would push ${branch} to origin (dry run; nothing was sent)`);
    return EXIT_CLEAR;
  }

  console.log(`horizon: pushing ${branch} to origin`);
  try {
    git(repo, ["push", "-u", "origin", branch]);
  } catch (error) {
    console.error(`horizon: push failed — ${error.message.split("\n")[0]}`);
    return EXIT_UNAVAILABLE;
  }

  // Verify the end state rather than trusting the command's exit status.
  const local = tryGit(repo, ["rev-parse", branch]);
  const remote = (tryGit(repo, ["ls-remote", "origin", `refs/heads/${branch}`]) ?? "").split("\t")[0];
  if (local !== remote) {
    console.error(`horizon: push reported success but origin does not have ${local}`);
    return EXIT_UNAVAILABLE;
  }
  console.log(`horizon: ${branch} is durable at ${local}`);
  return EXIT_CLEAR;
}

function main() {
  const command = process.argv[2];
  const repo = option("repo", process.cwd());
  const integrationRef = option("integration-ref", "origin/main");

  switch (command) {
    case "check":
      return commandCheck(repo, integrationRef);
    case "census":
      return commandCensus(repo, integrationRef);
    case "baseline":
      if (process.argv[3] !== "freeze") throw new Error("usage: baseline freeze");
      return commandBaselineFreeze(repo, integrationRef);
    case "converge":
      return commandConverge(repo);
    default:
      console.error("usage: horizon.mjs <check|census|baseline freeze|converge> [options]");
      return EXIT_UNAVAILABLE;
  }
}

try {
  process.exit(main());
} catch (error) {
  console.error(`horizon: UNAVAILABLE (${error.message})`);
  process.exit(EXIT_UNAVAILABLE);
}
