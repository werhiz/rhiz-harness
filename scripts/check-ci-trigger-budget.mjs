#!/usr/bin/env node
// Every workflow's triggers are a decision about cost and about who may run
// code on which machine. This gate holds each workflow to the triggers decided
// for it in docs/AGENT_PROOF_AND_CI_SPEND.md, and holds every automatically
// triggered workflow to what a pull request may safely run: GitHub-hosted
// runners only, exactly `contents: read`, no secrets, no reusable workflows.
//
// Scope, stated so nobody over-reads a pass: on a pull_request event GitHub
// runs the workflow files from the pull request itself, so a hostile fork can
// edit any workflow before this gate ever runs. This gate stops a maintainer
// from merging an unsafe workflow by accident. What stops a hostile fork is
// the repository's fork pull request approval policy, and runners that are not
// available to this public repository; the decision document names both.
//
// Usage: node scripts/check-ci-trigger-budget.mjs [--workflows <dir>]
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const flag = process.argv.indexOf("--workflows");
const workflowsDir = flag === -1
  ? new URL("../.github/workflows/", import.meta.url)
  : pathToFileURL(`${resolve(process.argv[flag + 1])}/`);

// Public-repository decision, 2026-10-01: hosted Linux minutes are free on a
// public repository, and outside contributors need hosted proof on their pull
// requests. The canary stays manual: it needs a self-hosted machine holding
// operator credentials.
const DECIDED_TRIGGERS = {
  "codex-app-server-canary.yml": "on:\n  workflow_dispatch:",
  "kernel.yml": "on:\n  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch:",
};

// Labels that only GitHub-hosted runners carry. Anything else, including a
// bare `macOS` or `linux`, can route to a self-hosted machine.
const HOSTED_RUNNER = /^(ubuntu|windows|macos)-(latest|\d[\w.-]*)$/;

function normalize(source) {
  return source.replace(/\r\n?/g, "\n");
}

function declaredTriggers(source) {
  const lines = source.split("\n");
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

function topLevelBlock(source, key) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^(['"]?)${key}\\1:`).test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]) || lines[end].trimStart().startsWith("#"))) end++;
  return lines.slice(start, end).filter((line) => line.trim() && !line.trimStart().startsWith("#")).join("\n");
}

function forkSafetyProblems(file, source) {
  const problems = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const runsOn = line.match(/^([ \t]+)(['"]?)runs-on\2:[ \t]*(.*)$/);
    if (!runsOn) return;
    const value = runsOn[3].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!HOSTED_RUNNER.test(value)) {
      problems.push(`line ${index + 1} runs-on "${value || lines[index + 1]?.trim() || ""}" is not a single GitHub-hosted runner label`);
    }
  });
  if (/\bsecrets\b/.test(source)) problems.push("references secrets");
  if (/^[ \t]+(['"]?)uses\1:[ \t]*[^\s#]*\.github\/workflows\//m.test(source) || /^ {4}(['"]?)uses\1:/m.test(source)) {
    problems.push("calls a reusable workflow");
  }
  if (topLevelBlock(source, "permissions") !== "permissions:\n  contents: read") {
    problems.push("does not set top-level permissions to exactly contents: read");
  }
  if (/^[ \t]+(['"]?)permissions\1:/m.test(source)) problems.push("sets job-level permissions");
  if (/pull_request_target|workflow_run/.test(source)) problems.push("uses a privileged trigger");
  return problems.map((problem) => `${file} runs automatically but ${problem}`);
}

try {
  const files = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file)).sort();
  const decided = Object.keys(DECIDED_TRIGGERS).sort();
  if (files.join("\n") !== decided.join("\n")) {
    throw new Error(`workflow inventory changed: ${files.join(", ")}; decide its triggers before updating this guard`);
  }
  const problems = [];
  for (const file of files) {
    const source = normalize(readFileSync(new URL(file, workflowsDir), "utf8"));
    const triggers = declaredTriggers(source);
    if (triggers !== DECIDED_TRIGGERS[file]) {
      problems.push(`${file} triggers differ from the recorded decision`);
      continue;
    }
    if (triggers !== "on:\n  workflow_dispatch:") problems.push(...forkSafetyProblems(file, source));
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  console.log("GitHub Actions trigger budget: PASS (decided triggers; automatic workflows hosted-only, read-only, secret-free)");
} catch (error) {
  console.error(`GitHub Actions trigger budget: FAIL: ${error.message}`);
  process.exitCode = 1;
}
