import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

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

const NPM_CI = "run: npm ci --ignore-scripts --no-audit --no-fund";
const appendJob = (job: string) => (k: string) => k.replace(/\n*$/, "\n") + job;

const UNSAFE: Record<string, [(kernel: string) => string, RegExp]> = {
  "self-hosted label": [(k) => replaceOnce(k, RUNS_ON, "    runs-on: self-hosted\n"), /not a free GitHub-hosted runner/],
  "bare macOS label routes to a self-hosted Mac": [(k) => replaceOnce(k, RUNS_ON, "    runs-on: [macOS]\n"), /not a free GitHub-hosted runner/],
  "multi-line label list": [(k) => replaceOnce(k, RUNS_ON, "    runs-on:\n      - self-hosted\n      - macOS\n"), /not a free GitHub-hosted runner/],
  "quoted runs-on key": [(k) => replaceOnce(k, RUNS_ON, '    "runs-on": [self-hosted]\n'), /not a free GitHub-hosted runner/],
  "runner group": [(k) => replaceOnce(k, RUNS_ON, "    runs-on:\n      group: operators\n"), /not a free GitHub-hosted runner/],
  "runner chosen by expression": [(k) => replaceOnce(k, RUNS_ON, `    runs-on: \${{ fromJSON('["self-hosted"]') }}\n`), /not a free GitHub-hosted runner/],
  "paid larger macOS runner": [(k) => replaceOnce(k, RUNS_ON, "    runs-on: macos-14-xlarge\n"), /not a free GitHub-hosted runner/],
  "paid larger Linux runner": [(k) => replaceOnce(k, RUNS_ON, "    runs-on: ubuntu-22.04-64core\n"), /not a free GitHub-hosted runner/],
  "flow-style job on a self-hosted runner": [appendJob("  evil: {runs-on: [self-hosted, macOS], steps: [{run: id}]}\n"), /job evil runs-on/],
  "flow-style job with write-all": [appendJob("  evil: {runs-on: ubuntu-latest, permissions: write-all, steps: [{run: id}]}\n"), /job evil sets job-level permissions/],
  "flow-style reusable workflow": [appendJob("  ext: {uses: someone/repo/.github/workflows/x.yml@main}\n"), /job ext calls a reusable workflow/],
  "escaped runs-on key": [(k) => replaceOnce(k, RUNS_ON, '    "runs\\x2don": [self-hosted, macOS]\n'), /not a free GitHub-hosted runner/],
  "escaped permissions key": [(k) => replaceOnce(k, RUNS_ON, `    "perm\\x69ssions": write-all\n${RUNS_ON}`), /sets job-level permissions/],
  "complex runs-on key": [(k) => replaceOnce(k, RUNS_ON, "    ? runs-on\n    : [self-hosted, macOS]\n"), /not a free GitHub-hosted runner/],
  "dotted secret": [(k) => replaceOnce(k, NPM_CI, "run: echo ${{ secrets.TOKEN }}"), /references secrets/],
  "secret without spaces": [(k) => replaceOnce(k, NPM_CI, "run: echo ${{secrets.TOKEN}}"), /references secrets/],
  "secret by index": [(k) => replaceOnce(k, NPM_CI, "run: echo ${{ secrets['TOKEN'] }}"), /references secrets/],
  "all secrets serialized": [(k) => replaceOnce(k, NPM_CI, "run: echo ${{ toJSON(secrets) }}"), /references secrets/],
  "escaped secret": [(k) => replaceOnce(k, NPM_CI, 'run: "echo ${{ \\x73ecrets.TOKEN }}"'), /references secrets/],
  "upper-case secrets context": [(k) => replaceOnce(k, NPM_CI, 'run: echo "${{ SECRETS.TOKEN }}"'), /references secrets/],
  "mixed-case secrets context": [(k) => replaceOnce(k, NPM_CI, 'run: echo "${{ Secrets.TOKEN }}"'), /references secrets/],
  "closing braces inside a string literal": [(k) => replaceOnce(k, NPM_CI, `run: echo "\${{ format('}}') || secrets.TOKEN }}"`), /references secrets/],
  "closing braces inside a format argument": [(k) => replaceOnce(k, NPM_CI, `run: echo "\${{ format('{0}', '}}') && secrets.TOKEN }}"`), /references secrets/],
  "alias": [(k) => replaceOnce(k, "permissions:\n  contents: read\n", "x-perm: &p\n  contents: read\npermissions: *p\n"), /kernel\.yml is not clean YAML/],
  "extra top-level write permission": [(k) => replaceOnce(k, "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  pull-requests: write\n"), /exactly contents: read/],
  "write-all": [(k) => replaceOnce(k, "permissions:\n  contents: read\n", "permissions: write-all\n"), /exactly contents: read/],
  "job-level permissions": [(k) => replaceOnce(k, RUNS_ON, `    permissions:\n      contents: write\n${RUNS_ON}`), /sets job-level permissions/],
  "reusable workflow with inherited secrets": [appendJob("  external:\n    uses: someone/repo/.github/workflows/x.yml@main\n    secrets: inherit\n"), /calls a reusable workflow/],
  "duplicate key": [(k) => replaceOnce(k, RUNS_ON, `${RUNS_ON}    runs-on: [self-hosted]\n`), /not clean YAML/],
};

for (const [name, [mutate, reason]] of Object.entries(UNSAFE)) {
  test(`an automatic workflow is refused: ${name}`, () => {
    const result = budget(mutate);
    assert.equal(result.status, 1, `${name} passed the guard:\n${result.stdout}`);
    assert.match(result.stderr, reason);
  });
}

test("free single-label and arm runners are accepted", () => {
  for (const runner of ["[ubuntu-latest]", "ubuntu-24.04-arm"]) {
    const result = budget((k) => replaceOnce(k, RUNS_ON, `    runs-on: ${runner}\n`));
    assert.equal(result.status, 0, `${runner}: ${result.stderr}`);
  }
});

test("prose that mentions secrets is not a secret reference", () => {
  const result = budget((k) => replaceOnce(k, NPM_CI, `${NPM_CI}\n        # No secrets here.`).replace("name: Checkout", "name: Checkout without secrets"));
  assert.equal(result.status, 0, result.stderr);
});

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

test("a workflow file with an upper-case extension is part of the inventory", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhiz-ci-budget-"));
  try {
    cpSync(resolve(ROOT, ".github/workflows"), dir, { recursive: true });
    writeFileSync(join(dir, "evil.YML"), "on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: self-hosted\n    steps:\n      - run: id\n");
    const result = spawnSync(process.execPath, [SCRIPT, "--workflows", dir], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workflow inventory changed: .*evil\.YML/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// Compare the decoded hosted stages with the owning local gate, rather than
// maintain another list of what counts as complete validation.
function assertHostedProofPlacement(source: string): void {
  const workflow = parseDocument(source).toJS() as {
    jobs: Record<string, { needs?: string[]; if?: unknown; "continue-on-error"?: unknown;
      steps: Array<{ run?: string; if?: unknown; "continue-on-error"?: unknown }> }>;
  };
  const scripts = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  const check = scripts.check;
  assert.ok(typeof check === "string");
  const stages = check.split(" && ");
  const guards = "npm run check:guards";
  assert.equal(stages.filter((stage) => stage === guards).length, 1);
  const jobs = workflow.jobs;
  assert.deepEqual(Object.keys(jobs).sort(), ["check", "dsh-keyless", "guards"]);
  const dsh = jobs["dsh-keyless"];
  assert.ok(dsh);
  assert.deepEqual(dsh.needs?.slice().sort(), ["check", "guards"]);
  for (const name of ["check", "guards"]) {
    const job = jobs[name];
    assert.ok(job);
    assert.equal(job.needs, undefined, `${name} must execute independently`);
    assert.equal(job.if, undefined, `${name} cannot skip its proof`);
    assert.equal(job["continue-on-error"], undefined, `${name} cannot ignore its proof`);
    for (const step of job.steps) {
      assert.equal(step.if, undefined, `${name} cannot skip a stage`);
      assert.equal(step["continue-on-error"], undefined, `${name} cannot ignore a stage`);
    }
  }
  const commands = (name: string) => {
    const job = jobs[name];
    assert.ok(job);
    return job.steps.flatMap((step) => {
      const lines = (step.run ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
      if (!lines.some((line) => /^npm run |^node --test /.test(line))) return [];
      if (lines.length > 1) assert.equal(lines.shift(), "set -euo pipefail", "proof blocks have one unconditional shell prelude");
      assert.ok(lines.every((line) => /^npm run |^node --test /.test(line)), "a proof cannot early-exit or be wrapped in a conditional");
      return lines;
    });
  };
  assert.deepEqual(commands("check"), stages.filter((stage) => stage !== guards));
  assert.deepEqual(commands("guards"), ["npm run build", guards]);
}

test("hosted Kernel executes every local proof stage with guards isolated and both gates required", () => {
  assertHostedProofPlacement(KERNEL);
});

test("hosted proof placement refuses a missing, narrowed, duplicated or bypassed required stage", () => {
  const mutations = [
    (s: string) => s.replace("needs: [check, guards]", "needs: [check]"),
    (s: string) => s.replace("          npm run check:portable-boundary\n", ""),
    (s: string) => s.replace("          node --test dist/test/*.test.js", "          node --test --test-name-pattern=one dist/test/*.test.js"),
    (s: string) => s.replace("          npm run proof:falsifiability\n", ""),
    (s: string) => s.replace("          npm run check:ci-parity\n", ""),
    (s: string) => s.replace("run: npm run check:guards", "run: npm run check:guards -- --only one"),
    (s: string) => s.replace("          npm run check:barrel\n", "          exit 0\n          npm run check:barrel\n"),
    (s: string) => s.replace("          npm run check:barrel\n", "          if false; then\n          npm run check:barrel\n          fi\n"),
    (s: string) => s.replace("  guards:\n", "  guards:\n    if: false\n"),
    (s: string) => s.replace("  check:\n", "  check:\n    continue-on-error: true\n"),
    (s: string) => s.replace("          npm run check:barrel\n", "          npm run check:barrel\n          npm run check:barrel\n"),
  ];
  for (const mutate of mutations) {
    const candidate = mutate(KERNEL);
    assert.notEqual(candidate, KERNEL, "negative control must change actual workflow bytes");
    assert.throws(() => assertHostedProofPlacement(candidate));
  }
});
