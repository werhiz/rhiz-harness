#!/usr/bin/env node
/**
 * Falsify the horizon sensor against a real repository, not a fixture.
 *
 * Three guards in this organization recently passed against the very thing they
 * were built to catch, because their fixtures were cleaner than the repository.
 * So this points the sensor at an actual checkout, recomputes its sentinels
 * with raw Git commands, and fails when the two disagree.
 *
 * The independent recomputation is the whole point. A proof in which the sensor
 * supplies both the claim and the expectation establishes only that the sensor
 * is self-consistent.
 *
 * The branch count is written into the receipt as evidence. It is deliberately
 * not an invariant: it is one day's census and will drift.
 *
 * Usage: node scripts/horizon-calibration-proof.mjs --repo <path> [--integration-ref <ref>] [--receipt <path>]
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { measureBranchDrift, driftedBranches } from "../dist/adapters/git/drift.js";
import { CALIBRATED_INTEGRATION_HORIZON, HORIZON_THRESHOLDS, decideHorizon } from "../dist/src/horizon.js";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

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

const repo = option("repo", process.cwd());
const integrationRef = option("integration-ref", "origin/main");
const receiptPath = option("receipt", null);

const failures = [];
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures.push(`${label}: sensor said ${JSON.stringify(actual)}, raw Git said ${JSON.stringify(expected)}`);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
  return ok;
};

console.log(`horizon calibration proof against ${repo} (${integrationRef})`);
console.log(`policy ${CALIBRATED_INTEGRATION_HORIZON.id}`);
console.log("");

const branches = driftedBranches(repo, integrationRef);
const rows = branches.map((branch) => {
  const measurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
  if (measurement.kind === "unavailable") return { branch, state: "unavailable", reason: measurement.reason };
  const decision = decideHorizon(measurement.signals);
  return { branch, state: decision.kind, signals: measurement.signals };
});

const tally = { clear: 0, grandfathered: 0, tripped: 0, unavailable: 0 };
for (const row of rows) tally[row.state] += 1;

// Sentinel 1: the worst diverged branch, recomputed independently.
console.log("sentinel: worst-diverged branch agrees with raw Git");
const measured = rows.filter((row) => row.state !== "unavailable");
const worst = measured.slice().sort((a, b) => b.signals.commitsAhead - a.signals.commitsAhead)[0];
if (worst === undefined) {
  failures.push("no measurable drifted branch to use as a sentinel");
} else {
  const counts = git(repo, ["rev-list", "--left-right", "--count", `${integrationRef}...${worst.branch}`]).split(/\s+/);
  check(`${worst.branch} commitsBehind`, worst.signals.commitsBehind, Number(counts[0]));
  check(`${worst.branch} commitsAhead`, worst.signals.commitsAhead, Number(counts[1]));

  const numstat = git(repo, ["diff", "--numstat", `${integrationRef}...${worst.branch}`]);
  let rawLines = 0;
  let rawBinary = 0;
  for (const line of numstat.split("\n").filter((value) => value.length > 0)) {
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") rawBinary += 1;
    else rawLines += Number(added) + Number(deleted);
  }
  check(`${worst.branch} diffLines`, worst.signals.diffLines, rawLines);
  check(`${worst.branch} binaryFilesChanged`, worst.signals.binaryFilesChanged, rawBinary);
  check(`${worst.branch} is tripped`, worst.state, "tripped");
}

// Sentinel 2: every branch the sensor calls durable really is on the remote.
console.log("");
console.log("sentinel: durability verdicts agree with the remote");
let durabilityDisagreements = 0;
for (const row of measured) {
  const upstream = tryGit(repo, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${row.branch}`]) ?? "";
  const resolves = upstream.length > 0 && tryGit(repo, ["rev-parse", "--verify", "--quiet", upstream]) !== undefined;
  const ahead = resolves ? Number(tryGit(repo, ["rev-list", "--count", `${upstream}..${row.branch}`]) ?? "0") : 0;
  const rawDurable = resolves && ahead === 0;
  if ((row.signals.upstreamState === "pushed") !== rawDurable) durabilityDisagreements += 1;
}
check("branches where sensor and raw Git disagree on durability", durabilityDisagreements, 0);

// Sentinel 3: the integration ref does not trip against itself.
console.log("");
console.log("sentinel: the integration ref is not tripped against itself");
const localIntegration = integrationRef.includes("/") ? integrationRef.split("/").slice(1).join("/") : integrationRef;
const selfMeasurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch: localIntegration });
if (selfMeasurement.kind === "measured") {
  check(`${localIntegration} commitsAhead`, selfMeasurement.signals.commitsAhead, 0);
  check(`${localIntegration} divergenceAgeMs`, selfMeasurement.signals.divergenceAgeMs, 0);
} else {
  console.log(`  skip ${localIntegration}: ${selfMeasurement.reason}`);
}

const receipt = {
  $comment: "Calibration evidence for the integration horizon. The branch count is evidence, never an invariant.",
  policy: CALIBRATED_INTEGRATION_HORIZON.id,
  policyStatus: CALIBRATED_INTEGRATION_HORIZON.status,
  thresholds: HORIZON_THRESHOLDS,
  repository: repo,
  integrationRef,
  integrationHead: tryGit(repo, ["rev-parse", integrationRef]) ?? null,
  measuredAt: new Date().toISOString(),
  branchCount: rows.length,
  tally,
  sentinels: {
    worstDivergedBranch: worst?.branch ?? null,
    worstDivergedSignals: worst?.signals ?? null,
    durabilityDisagreements,
  },
  failures,
};

console.log("");
if (receiptPath !== null) {
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`receipt written to ${receiptPath}`);
}

console.log(`branches ${rows.length}  tripped ${tally.tripped}  unavailable ${tally.unavailable}`);
if (failures.length > 0) {
  console.error("");
  console.error("horizon calibration: FAIL");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("horizon calibration: PASS (sensor agrees with independently recomputed raw Git)");
