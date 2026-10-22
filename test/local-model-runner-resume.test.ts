import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { work } from "./helpers.js";

test("direct runner resume cannot switch a zero-budget local Work to Codex or a different model", () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-local-resume-unit-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git(["init", "-q"]); git(["config", "user.name", "Unit"]); git(["config", "user.email", "unit@localhost.invalid"]);
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/example.ts"), "return 1;\n");
    git(["add", "."]); git(["-c", "commit.gpgsign=false", "commit", "-qm", "unit baseline"]);
    const contract = work({ id: "work:local-resume-unit", workerPolicy: { preferredProviders: ["worker:local-model"], maxAttempts: 1, allowParallelAttempts: false, explicitProviderAuthorizations: [] } });
    const contractPath = join(root, "work.json"); writeFileSync(contractPath, JSON.stringify(contract));
    const plan = { id: "plan:unit", workId: contract.id, contractRevision: 1, checks: [{
      id: "check:unit", providerId: "verifier:local-command", description: "Unit transport gate; not a live candidate proof",
      criterionIds: ["criterion:tests"], requirementIds: ["evidence:tests"],
      config: { command: process.execPath, args: ["-e", "process.exit(0)"], expectedExitCodes: [0], evidenceKind: "test" },
    }] };
    const planPath = join(root, "verify.json"); writeFileSync(planPath, JSON.stringify(plan));
    const config = { backend: "ollama", model: "qwen3:8b", digest: "a".repeat(64), autonomousPaidBudgetUsd: 0, cloudFallback: false, permittedPaths: ["src/example.ts"] };
    const configPath = join(root, "local.json"); writeFileSync(configPath, JSON.stringify(config));
    const marker = join(root, "paid-worker-started");
    const trap = join(root, "codex-trap"); writeFileSync(trap, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    const runner = fileURLToPath(new URL("../../scripts/run-repository-work.mjs", import.meta.url));
    const ledger = join(root, "ledger");
    const base = [runner, "--repo", repo, "--contract", contractPath, "--verify", planPath, "--ledger", ledger];
    const env = { ...process.env, RHIZ_CODEX_COMMAND: trap };
    const first = spawnSync(process.execPath, [...base, "--local-config", configPath], { encoding: "utf8", timeout: 15000, env });
    assert.notEqual(first.status, 0); // absent real host/model/remote; never an end-to-end success claim
    assert.ok(existsSync(join(ledger, "execution-provider.json")), first.stderr);
    assert.equal(existsSync(marker), false);
    const missing = spawnSync(process.execPath, [...base, "--resume", "true"], { encoding: "utf8", timeout: 15000, env });
    assert.match(missing.stderr, /exact persisted provider\/configuration/); assert.equal(existsSync(marker), false);
    writeFileSync(configPath, JSON.stringify({ ...config, digest: "b".repeat(64) }));
    const changed = spawnSync(process.execPath, [...base, "--resume", "true", "--local-config", configPath], { encoding: "utf8", timeout: 15000, env });
    assert.match(changed.stderr, /exact persisted provider\/configuration/); assert.equal(existsSync(marker), false);
    assert.equal(JSON.parse(readFileSync(join(ledger, "execution-provider.json"), "utf8")).config.digest, config.digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
