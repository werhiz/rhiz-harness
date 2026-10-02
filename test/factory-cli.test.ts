import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DurableEventLedger } from "../adapters/local/durable-ledger.js";
import { benchRun, event } from "./helpers.js";

const SCRIPT = resolve(process.cwd(), "scripts/factory.mjs");

function factory(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test("observe reads a real Ledger and run receipts, and leaves the Ledger byte-identical", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-factory-cli-"));
  try {
    const ledgerDir = join(root, "ledger");
    const ledger = await DurableEventLedger.open({ directory: ledgerDir });
    for (const workId of ["work:a", "work:b", "work:c"]) {
      await ledger.append(event("context.pack-selected", {
        packId: `pack:${workId}`,
        digest: `sha256:${workId}`,
        taskClass: "ship",
        strategy: "balanced",
        totalTokens: 900,
        fragmentCount: 1,
        markers: ["docs/ARCHITECTURE.md"],
      }, { workId, streamId: `stream:${workId}` }));
    }
    await ledger.close();
    const before = readFileSync(join(ledgerDir, "events.jsonl"));

    // One receipt in the runner's shape, one bare run.
    writeFileSync(join(root, "receipt.json"), JSON.stringify({ benchmarkRun: benchRun({ workId: "work:a" }) }));
    writeFileSync(join(root, "run.json"), JSON.stringify(benchRun({ benchmarkCaseId: "case:2", workId: "work:b", verified: false })));

    const result = factory(["observe", "--ledger", ledgerDir, "--runs", join(root, "receipt.json"), "--runs", join(root, "run.json"), "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(result.stdout);
    assert.equal(observation.schema, "rhiz-harness-factory-observation/v1");
    assert.equal(observation.window.eventCount, 3);
    assert.equal(observation.northStar.runs, 2);
    assert.equal(observation.northStar.verifiedOutcomes, 1);
    const repeated = observation.findings.find((finding: { kind: string }) => finding.kind === "repeated-context");
    assert.ok(repeated);
    assert.deepEqual(repeated.replay.benchmarkCaseIds, ["case:1", "case:2"]);

    assert.deepEqual(readFileSync(join(ledgerDir, "events.jsonl")), before);

    const text = factory(["observe", "--ledger", ledgerDir]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /\[repeated-context\] Context docs\/ARCHITECTURE\.md was selected for 3 separate Works/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay exits nonzero when the result may not be claimed", () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-factory-cli-"));
  try {
    const experiment = {
      schema: "rhiz-harness-replay-experiment/v1",
      id: "replay:cli",
      hypothesis: "model-b verifies this case",
      benchmarkCaseIds: ["case:1"],
      permittedDifferences: ["model"],
      candidateControls: { model: "model-b" },
      trialsPerArm: 2,
    };
    const pair = {
      baseline: benchRun({ variantId: "baseline", verified: false }),
      candidate: benchRun({ variantId: "candidate", model: "model-b", attemptIds: ["attempt:2"] }),
    };
    writeFileSync(join(root, "experiment.json"), JSON.stringify(experiment));

    writeFileSync(join(root, "one.json"), JSON.stringify([pair]));
    const short = factory(["replay", "--experiment", join(root, "experiment.json"), "--pairs", join(root, "one.json")]);
    assert.equal(short.status, 1);
    assert.match(short.stdout, /insufficient-evidence/);

    writeFileSync(join(root, "two.json"), JSON.stringify([pair, pair]));
    const enough = factory(["replay", "--experiment", join(root, "experiment.json"), "--pairs", join(root, "two.json")]);
    assert.equal(enough.status, 0, enough.stderr);
    assert.match(enough.stdout, /Replay replay:cli: improved \(descriptive\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no command prints usage and exits 2", () => {
  const result = factory([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /factory:observe/);
});
