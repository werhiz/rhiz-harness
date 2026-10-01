#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  compareBenchmarkRuns,
  parseBenchmarkRun,
} from "../dist/src/benchmark.js";

function usage() {
  return [
    "Usage:",
    "  npm run benchmark:compare -- <baseline.json> <candidate.json> [--vary field,field]",
    "",
    "Inputs may be a BenchmarkRun object directly or a repository-work receipt",
    "containing benchmarkRun. The comparison requires the same benchmarkCaseId",
    "and exact baseIdentity, plus distinct variantId values. --vary names intentional",
    "experimental dimensions such as harnessMode or harnessVersion; every named",
    "difference is preserved in the comparison receipt.",
  ].join("\n");
}

async function readRun(file) {
  const raw = JSON.parse(await readFile(resolve(file), "utf8"));
  return parseBenchmarkRun(raw?.benchmarkRun ?? raw);
}

const argv = process.argv.slice(2);
const baselinePath = argv[0];
const candidatePath = argv[1];
const varyIndex = argv.indexOf("--vary");
const permittedDifferences =
  varyIndex === -1
    ? []
    : (argv[varyIndex + 1] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
if (!baselinePath || !candidatePath) {
  console.error(usage());
  process.exitCode = 2;
} else {
  const baseline = await readRun(baselinePath);
  const candidate = await readRun(candidatePath);
  console.log(
    JSON.stringify(
      compareBenchmarkRuns(baseline, candidate, { permittedDifferences }),
      null,
      2,
    ),
  );
}
