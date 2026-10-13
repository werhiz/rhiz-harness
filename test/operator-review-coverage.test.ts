import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { human } from "./helpers.js";
import { readDurableLedgerEvents } from "../adapters/local/durable-ledger.js";

import { cli, git, contractFor, planFor, fixture, cliRun, json } from "./operator-cli-fixture.js";

test("operator CLI: ordered review ranges reject missing, repeated, reordered and altered UTF-8 bytes", async () => {
  const { assertReviewPartCoverage } = await import(new URL(cli, "file:").href);
  const body = { label: "original:a.ts", blob: "a".repeat(40), digest: "b".repeat(64), content: "café🌿done" };
  const first = { ...body, start: 0, end: Buffer.byteLength("café"), content: "café" };
  const second = { ...body, start: first.end, end: Buffer.byteLength(body.content), content: "🌿done" };
  const plan = [{ ranges: [first] }, { ranges: [second] }];
  assert.doesNotThrow(() => assertReviewPartCoverage([body], plan));
  for (const ranges of [[first], [first, first, second], [first, second, second], [second, first], [first, { ...second, start: second.start + 1 }], [first, { ...second, content: "🌾done" }], [first, { ...second, blob: "c".repeat(40) }]]) {
    assert.throws(() => assertReviewPartCoverage([body], [{ ranges }]), /coverage differs/);
  }
});
