#!/usr/bin/env node
// Factory Runtime operator surface (ADR 0025).
//
//   observe  read Ledger directories and benchmark receipts, print what the
//            population shows and the replay experiments worth running
//   replay   summarize paired benchmark receipts against one experiment
//
// Both commands only read. A Ledger is verified from a private copy of its
// events file, so observing never takes the writer's lock, repairs a torn
// tail, or creates anything in the Ledger directory.
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { DurableEventLedger } from "../dist/adapters/local/durable-ledger.js";
import { parseBenchmarkRun } from "../dist/src/benchmark.js";
import { formatFactoryObservation, observeFactory, ReplayExperimentSpecSchema } from "../dist/src/observer.js";
import { formatReplayResult, summarizeReplayExperiment } from "../dist/src/replay.js";

function usage() {
  return [
    "Usage:",
    "  npm run factory:observe -- [--ledger <dir>]... [--runs <file|dir>]... [--json]",
    "  npm run factory:replay -- --experiment <spec.json> --pairs <pairs.json> [--json]",
    "",
    "--ledger    a durable Ledger directory (holding events.jsonl). Repeatable.",
    "--runs      a BenchmarkRun, a repository-work receipt containing benchmarkRun,",
    "            a JSON array of either, or a directory of such files. Repeatable.",
    "--experiment a replay experiment, as printed in an observation's findings.",
    "--pairs     a JSON array of {\"baseline\": <run|receipt>, \"candidate\": <run|receipt>}.",
    "--json      print the full record instead of the summary.",
  ].join("\n");
}

class UsageError extends Error {}

// Every argument must be a known flag, and every valued flag needs its value.
// A misspelled or bare flag that was silently skipped would publish an
// observation without the evidence the operator named.
const VALUED_FLAGS = { observe: ["ledger", "runs"], replay: ["experiment", "pairs"] };

function parseArgs(command, argv) {
  const values = Object.fromEntries((VALUED_FLAGS[command] ?? []).map((name) => [name, []]));
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    if (name === null || !(name in values)) throw new UsageError(`unknown argument ${arg}\n${usage()}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value\n${usage()}`);
    values[name].push(value);
    index += 1;
  }
  return { values, json };
}

function toRun(raw) {
  return parseBenchmarkRun(raw?.benchmarkRun ?? raw);
}

async function readRuns(path) {
  const absolute = resolve(path);
  if ((await stat(absolute)).isDirectory()) {
    const names = (await readdir(absolute)).filter((name) => name.endsWith(".json")).sort();
    if (names.length === 0) throw new UsageError(`no benchmark run files (*.json) in ${absolute}`);
    return (await Promise.all(names.map((name) => readRuns(join(absolute, name))))).flat();
  }
  const raw = JSON.parse(await readFile(absolute, "utf8"));
  return (Array.isArray(raw) ? raw : [raw]).map(toRun);
}

async function readLedger(directory) {
  const source = join(resolve(directory), "events.jsonl");
  const exists = await stat(source).then((entry) => entry.isFile(), () => false);
  if (!exists) throw new UsageError(`no Ledger at ${resolve(directory)} (expected events.jsonl)`);
  const scratch = await mkdtemp(join(tmpdir(), "rhiz-factory-observe-"));
  try {
    await copyFile(source, join(scratch, "events.jsonl"));
    let ledger;
    try {
      ledger = await DurableEventLedger.open({ directory: scratch, repairTornTail: false });
    } catch (error) {
      // A Ledger copied mid-append, or a damaged one, is reported, never repaired here.
      throw new UsageError(`Ledger at ${resolve(directory)} failed verification: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const events = [];
      for await (const record of ledger.records()) events.push(record.event);
      if (events.length === 0) throw new UsageError(`Ledger at ${resolve(directory)} holds no events`);
      return events;
    } finally {
      await ledger.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const [command, ...argv] = process.argv.slice(2);
let parsed;
try {
  parsed = parseArgs(command, argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const { values, json } = parsed;

if (command === "observe") {
  const ledgers = values.ledger;
  const runFiles = values.runs;
  if (ledgers.length === 0 && runFiles.length === 0) {
    console.error(usage());
    process.exit(2);
  }
  let events;
  let runs;
  let observation;
  try {
    events = (await Promise.all(ledgers.map(readLedger))).flat();
    // Each named input must hold runs; an empty one beside a full one is
    // still evidence the operator expected and did not get.
    const perInput = await Promise.all(runFiles.map(readRuns));
    perInput.forEach((inputRuns, index) => {
      if (inputRuns.length === 0) throw new UsageError(`--runs ${runFiles[index]} contains no benchmark runs`);
    });
    runs = perInput.flat();
    observation = observeFactory({ events, runs });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  console.log(json ? JSON.stringify(observation, null, 2) : formatFactoryObservation(observation));
} else if (command === "replay") {
  const [experimentPath] = values.experiment;
  const [pairsPath] = values.pairs;
  if (!experimentPath || !pairsPath || values.experiment.length > 1 || values.pairs.length > 1) {
    console.error(usage());
    process.exit(2);
  }
  let result;
  try {
    const experiment = ReplayExperimentSpecSchema.parse(JSON.parse(await readFile(resolve(experimentPath), "utf8")));
    const raw = JSON.parse(await readFile(resolve(pairsPath), "utf8"));
    if (!Array.isArray(raw)) throw new UsageError("--pairs must be a JSON array of {baseline, candidate}");
    const pairs = raw.map((pair) => ({ baseline: toRun(pair?.baseline), candidate: toRun(pair?.candidate) }));
    result = summarizeReplayExperiment(experiment, pairs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  console.log(json ? JSON.stringify(result, null, 2) : formatReplayResult(result));
  // A result nobody may claim is not a passing command.
  if (result.verdict === "invalid" || result.verdict === "insufficient-evidence") process.exitCode = 1;
} else {
  console.error(usage());
  process.exit(2);
}
