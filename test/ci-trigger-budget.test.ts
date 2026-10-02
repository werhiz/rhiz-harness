import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts/check-ci-trigger-budget.mjs");
const KERNEL = readFileSync(resolve(ROOT, ".github/workflows/kernel.yml"), "utf8");

function budget(mutate: (kernel: string) => string, file = "kernel.yml") {
  const dir = mkdtempSync(join(tmpdir(), "rhiz-ci-budget-"));
  try {
    cpSync(resolve(ROOT, ".github/workflows"), dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(path, mutate(readFileSync(path, "utf8")));
    return spawnSync(process.execPath, [SCRIPT, "--workflows", dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function replaceOnce(source: string, from: string, to: string): string {
  assert.ok(source.includes(from), `fixture anchor missing: ${from}`);
  return source.replace(from, to);
}

const RUNS_ON = "    runs-on: ubuntu-latest\n";

test("the recorded workflows pass", () => {
  const result = budget((kernel) => kernel);
  assert.equal(result.status, 0, result.stderr);
});

test("CRLF line endings do not change the verdict", () => {
  const result = budget((kernel) => kernel.replace(/\n/g, "\r\n"));
  assert.equal(result.status, 0, result.stderr);
});

const UNSAFE: Record<string, (kernel: string) => string> = {
  "self-hosted label": (k) => replaceOnce(k, RUNS_ON, "    runs-on: self-hosted\n"),
  "bare macOS label routes to a self-hosted Mac": (k) => replaceOnce(k, RUNS_ON, "    runs-on: [macOS]\n"),
  "multi-line label list": (k) => replaceOnce(k, RUNS_ON, "    runs-on:\n      - self-hosted\n      - macOS\n"),
  "quoted runs-on key": (k) => replaceOnce(k, RUNS_ON, '    "runs-on": [self-hosted]\n'),
  "runner group": (k) => replaceOnce(k, RUNS_ON, "    runs-on:\n      group: operators\n"),
  "runner chosen by expression": (k) => replaceOnce(k, RUNS_ON, `    runs-on: \${{ fromJSON('["self-hosted"]') }}\n`),
  "dotted secret": (k) => k.replace("run: npm ci --ignore-scripts --no-audit --no-fund", "run: echo ${{ secrets.TOKEN }}"),
  "secret without spaces": (k) => k.replace("run: npm ci --ignore-scripts --no-audit --no-fund", "run: echo ${{secrets.TOKEN}}"),
  "secret by index": (k) => k.replace("run: npm ci --ignore-scripts --no-audit --no-fund", "run: echo ${{ secrets['TOKEN'] }}"),
  "all secrets serialized": (k) => k.replace("run: npm ci --ignore-scripts --no-audit --no-fund", "run: echo ${{ toJSON(secrets) }}"),
  "extra top-level write permission": (k) => replaceOnce(k, "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  pull-requests: write\n"),
  "write-all": (k) => replaceOnce(k, "permissions:\n  contents: read\n", "permissions: write-all\n"),
  "job-level permissions": (k) => replaceOnce(k, RUNS_ON, `    permissions:\n      contents: write\n${RUNS_ON}`),
  "reusable workflow with inherited secrets": (k) => k + "\n  external:\n    uses: someone/repo/.github/workflows/x.yml@main\n    secrets: inherit\n",
  "reusable workflow without secrets": (k) => k + "\n  external:\n    uses: someone/repo/.github/workflows/x.yml@main\n",
};

for (const [name, mutate] of Object.entries(UNSAFE)) {
  test(`an automatic workflow is refused: ${name}`, () => {
    const result = budget(mutate);
    assert.equal(result.status, 1, `${name} passed the guard:\n${result.stdout}`);
    assert.match(result.stderr, /kernel\.yml/);
  });
}

test("a privileged trigger or a new trigger is refused", () => {
  for (const mutate of [
    (k: string) => replaceOnce(k, "  pull_request:\n", "  pull_request_target:\n"),
    (k: string) => replaceOnce(k, "  workflow_dispatch:\n", "  workflow_dispatch:\n  workflow_run:\n    workflows: [x]\n"),
  ]) {
    assert.equal(budget(mutate).status, 1);
  }
});

test("the canary stays manual", () => {
  const result = budget((canary) => replaceOnce(canary, "on:\n  workflow_dispatch:\n", "on:\n  pull_request:\n  workflow_dispatch:\n"), "codex-app-server-canary.yml");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /codex-app-server-canary\.yml triggers differ/);
});

test("the kernel fixture actually uses a GitHub-hosted runner", () => {
  assert.ok(KERNEL.includes(RUNS_ON));
});
