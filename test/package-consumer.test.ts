import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  BenchmarkRunSchema,
  HarnessRuleSchema,
  composeContextPack,
  parseWorkContract,
} from "../src/index.js";

const ROOT = process.cwd();

test("the packed package's installed CLI executes directly", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "rhiz-package-consumer-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", directory,
  ], { cwd: ROOT, encoding: "utf8" })) as Array<{ filename: string }>;
  const dependency = JSON.parse(execFileSync("npm", [
    "pack", resolve(ROOT, "node_modules/zod"), "--ignore-scripts", "--json", "--pack-destination", directory,
  ], { cwd: ROOT, encoding: "utf8" })) as Array<{ filename: string }>;
  const consumer = resolve(directory, "consumer");
  mkdirSync(consumer);
  writeFileSync(resolve(consumer, "package.json"), '{"private":true}');
  execFileSync("npm", [
    "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", resolve(directory, "empty-cache"),
    resolve(directory, dependency[0]!.filename),
    resolve(directory, packed[0]!.filename),
  ], { cwd: consumer, encoding: "utf8" });
  const output = execFileSync(resolve(consumer, "node_modules/.bin/rhiz-harness-repository-work"), ["--help"], {
    cwd: consumer, encoding: "utf8",
  });
  assert.match(output, /Usage:/);
});

test("the package exposes the supported Protocol consumer contracts from its root export", () => {
  assert.equal(typeof BenchmarkRunSchema.parse, "function");
  assert.equal(typeof HarnessRuleSchema.parse, "function");
  assert.equal(typeof composeContextPack, "function");
  assert.equal(typeof parseWorkContract, "function");
});

test("a git-installed package builds before consumers import dist", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    files?: string[];
    exports?: Record<string, unknown>;
  };

  assert.equal(manifest.scripts?.prepare, "npm run build");
  assert.ok(manifest.files?.includes("dist/src"));
  assert.ok(manifest.files?.includes("dist/adapters"));
  assert.ok(manifest.exports?.["."]);
});

test("every redistribution carries the license and the upstream notices Apache-2.0 requires", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    license?: string;
    files?: string[];
  };
  assert.equal(manifest.license, "Apache-2.0");
  // npm adds LICENSE to every tarball by itself. NOTICE it does not, and
  // Apache-2.0 section 4(d) requires a derivative work to carry the upstream
  // NOTICE, so the files list has to name it.
  assert.ok(manifest.files?.includes("NOTICE"));
  assert.ok(manifest.files?.includes("THIRD_PARTY_NOTICES.md"));
  const notice = readFileSync(resolve(ROOT, "NOTICE"), "utf8");
  assert.match(notice, /OpenAI Codex\s+Copyright 2025 OpenAI/);
  assert.match(readFileSync(resolve(ROOT, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0, January 2004/);
});
