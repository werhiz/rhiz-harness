#!/usr/bin/env node
// Every workflow's triggers are a decision about cost and about who may run
// code on which machine. This gate holds each workflow to the triggers decided
// for it in docs/AGENT_PROOF_AND_CI_SPEND.md, and holds every automatically
// triggered workflow to what a pull request from a fork may safely run:
// GitHub-hosted runners, read-only permissions, no secrets.
import { readdirSync, readFileSync } from "node:fs";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);

// Public-repository decision, 2026-10-01: hosted Linux minutes are free on a
// public repository, and outside contributors need hosted proof on their pull
// requests. The canary stays manual forever: it runs on a self-hosted machine
// holding operator credentials, which a fork's pull request must never reach.
const DECIDED_TRIGGERS = {
  "codex-app-server-canary.yml": "on:\n  workflow_dispatch:",
  "kernel.yml": "on:\n  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch:",
};

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

function forkSafetyProblems(file, source) {
  const problems = [];
  if (/runs-on:[^\n]*self-hosted/.test(source)) problems.push("uses a self-hosted runner");
  if (/\$\{\{\s*secrets\./.test(source)) problems.push("references secrets");
  if (!/^permissions:\n  contents: read\n/m.test(source)) problems.push("does not pin top-level permissions to contents: read");
  if (/^[ \t]+permissions:/m.test(source)) problems.push("widens permissions at job level");
  if (/pull_request_target/.test(source)) problems.push("uses pull_request_target");
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
    const source = readFileSync(new URL(file, workflowsDir), "utf8");
    const triggers = declaredTriggers(source);
    if (triggers !== DECIDED_TRIGGERS[file]) {
      problems.push(`${file} triggers differ from the recorded decision`);
      continue;
    }
    if (triggers !== "on:\n  workflow_dispatch:") problems.push(...forkSafetyProblems(file, source));
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  console.log("GitHub Actions trigger budget: PASS (decided triggers; automatic workflows are fork-safe)");
} catch (error) {
  console.error(`GitHub Actions trigger budget: FAIL: ${error.message}`);
  process.exitCode = 1;
}
