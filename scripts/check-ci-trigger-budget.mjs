#!/usr/bin/env node
// GitHub-hosted runs spend metered minutes. Keep every workflow manual until
// an explicit cost/outcome decision changes this budget.
import { readdirSync, readFileSync } from "node:fs";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file)).sort();
const expected = ["codex-app-server-canary.yml", "kernel.yml"];

function declaredTriggers(source) {
  const lines = source.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const heading = line.match(/^([^\s#][^:]*):/);
    return heading?.[1].replace(/^(['"])(.*)\1$/, "$2") === "on" ? [index] : [];
  });
  if (headings.length !== 1) throw new Error(`expected one top-level on: block; found ${headings.length}`);
  const start = headings[0];
  let end = start + 1;
  while (end < lines.length && !/^[^\s#][^:]*:/.test(lines[end])) end++;
  return lines.slice(start, end)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .join("\n");
}

try {
  if (files.join("\n") !== expected.join("\n")) {
    throw new Error(`workflow inventory changed: ${files.join(", ")}; review its cost before updating this guard`);
  }
  for (const file of files) {
    const source = readFileSync(new URL(file, workflowsDir), "utf8");
    if (declaredTriggers(source) !== "on:\n  workflow_dispatch:") {
      throw new Error(`${file} has a changed trigger; automatic GitHub Actions need an explicit cost/outcome decision`);
    }
  }
  console.log("GitHub Actions trigger budget: PASS (manual dispatch only)");
} catch (error) {
  console.error(`GitHub Actions trigger budget: FAIL: ${error.message}`);
  process.exitCode = 1;
}
