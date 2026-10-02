#!/usr/bin/env node
// Every workflow's triggers are a decision about cost and about who may run
// code on which machine. This gate holds each workflow to the triggers decided
// for it in docs/AGENT_PROOF_AND_CI_SPEND.md, and holds every automatically
// triggered workflow to what a pull request may safely run: free
// GitHub-hosted runners only, exactly `contents: read`, no secrets, no
// reusable workflows.
//
// It judges the parsed YAML, never the text. Flow collections, quoted or
// escaped keys, and complex keys all decode to the same structure GitHub
// reads, so a disguised key cannot pass where a plain one fails. Duplicate
// keys and any YAML the parser reports as an error or warning are refused.
//
// Scope, stated so nobody over-reads a pass: on a pull_request event GitHub
// runs the workflow files from the pull request itself, so a hostile fork can
// edit any workflow before this gate ever runs. This gate stops a maintainer
// from merging an unsafe workflow by accident. What stops a hostile fork is
// the repository's fork pull request approval policy, and runners that are not
// available to this public repository; the decision document names both.
//
// Usage: node scripts/check-ci-trigger-budget.mjs [--workflows <dir>]
import { isDeepStrictEqual } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const flag = process.argv.indexOf("--workflows");
const workflowsDir = flag === -1
  ? new URL("../.github/workflows/", import.meta.url)
  : pathToFileURL(`${resolve(process.argv[flag + 1])}/`);

// Public-repository decision, 2026-10-01: standard hosted minutes are free on
// a public repository, and outside contributors need hosted proof on their
// pull requests. The canary stays manual: it needs a self-hosted machine
// holding operator credentials.
const DECIDED_TRIGGERS = {
  "codex-app-server-canary.yml": { workflow_dispatch: null },
  "kernel.yml": { pull_request: null, push: { branches: ["main"] }, workflow_dispatch: null },
};

// Standard GitHub-hosted labels, which cost nothing on a public repository.
// Larger runners (e.g. macos-14-xlarge, ubuntu-22.04-64core) bill per minute
// even here, and any other label can route to a self-hosted machine.
const FREE_HOSTED_RUNNERS = new Set([
  "ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04",
  "windows-latest", "windows-2025", "windows-2022",
  "macos-latest", "macos-15", "macos-14",
]);

function parseWorkflow(file, source) {
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0) throw new Error(`${file} is not clean YAML: ${issues[0].message}`);
  const value = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${file} is not a mapping`);
  return value;
}

/** Every decoded string anywhere in the workflow: keys and values alike. */
function* strings(value) {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      yield key;
      yield* strings(item);
    }
  }
}

function forkSafetyProblems(file, workflow) {
  const problems = [];
  if (!isDeepStrictEqual(workflow.permissions, { contents: "read" })) {
    problems.push("does not set top-level permissions to exactly contents: read");
  }
  const jobs = workflow.jobs;
  if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
    problems.push("has no jobs mapping");
  } else {
    for (const [name, job] of Object.entries(jobs)) {
      if (job === null || typeof job !== "object" || Array.isArray(job)) {
        problems.push(`job ${name} is not a mapping`);
        continue;
      }
      if ("uses" in job) problems.push(`job ${name} calls a reusable workflow`);
      if ("permissions" in job) problems.push(`job ${name} sets job-level permissions`);
      if (typeof job["runs-on"] !== "string" || !FREE_HOSTED_RUNNERS.has(job["runs-on"])) {
        problems.push(`job ${name} runs-on ${JSON.stringify(job["runs-on"] ?? null)} is not a free GitHub-hosted runner label`);
      }
      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        const uses = step && typeof step === "object" ? step.uses : undefined;
        if (typeof uses === "string" && uses.includes(".github/workflows/")) {
          problems.push(`job ${name} calls a reusable workflow from a step`);
        }
      }
    }
  }
  for (const text of strings(workflow)) {
    if (text === "secrets") {
      problems.push("declares a secrets key");
      break;
    }
    const expressions = text.match(/\$\{\{[\s\S]*?\}\}/g) ?? [];
    if (expressions.some((expression) => /\bsecrets\b/.test(expression))) {
      problems.push("references secrets in an expression");
      break;
    }
  }
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
    let workflow;
    try {
      workflow = parseWorkflow(file, readFileSync(new URL(file, workflowsDir), "utf8"));
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    if (!isDeepStrictEqual(workflow.on, DECIDED_TRIGGERS[file])) {
      problems.push(`${file} triggers differ from the recorded decision`);
      continue;
    }
    if (!isDeepStrictEqual(workflow.on, { workflow_dispatch: null })) {
      problems.push(...forkSafetyProblems(file, workflow));
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
  console.log("GitHub Actions trigger budget: PASS (decided triggers; automatic workflows use free hosted runners, read-only, secret-free)");
} catch (error) {
  console.error(`GitHub Actions trigger budget: FAIL: ${error.message}`);
  process.exitCode = 1;
}
