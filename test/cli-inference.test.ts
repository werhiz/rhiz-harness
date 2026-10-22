import test from "node:test";
import assert from "node:assert/strict";
import { CliWorkerConfigSchema, CliLocalInference } from "../adapters/local/cli-inference.js";
const config = { backend: "llama-cli", model: "qwen2.5-7b-instruct-q4_k_m",
  executable: "/missing-cli", executableDigest: "0".repeat(64),
  modelPath: "/missing-model", digest: "0".repeat(64),
  autonomousPaidBudgetUsd: 0, cloudFallback: false, permittedPaths: ["docs/quickstart.md"] };
test("CLI rejects paid routing, cloud fallback and reserved mutation paths", () => {
  for (const change of [{ autonomousPaidBudgetUsd: 1 }, { cloudFallback: true },
    { permittedPaths: ["scripts/worker.mjs"] }, { model: "other" }])
    assert.equal(CliWorkerConfigSchema.safeParse({ ...config, ...change }).success, false);
});
test("CLI cancellation refuses before reading a model", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new CliLocalInference(CliWorkerConfigSchema.parse(config)).replace("fix", controller.signal), /abort/i);
});
test("CLI oversized prompts refuse before executable access", async () => {
  await assert.rejects(new CliLocalInference(CliWorkerConfigSchema.parse(config)).replace("x".repeat(5501), new AbortController().signal), /context budget/);
});
