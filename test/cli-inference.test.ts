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
test("CLI accepts only pinned model identities and reports the configured one", () => {
  assert.equal(new CliLocalInference(CliWorkerConfigSchema.parse({ ...config, model: "qwen3-8b-q4_k_m" })).model, "qwen3-8b-q4_k_m");
  assert.equal(new CliLocalInference(CliWorkerConfigSchema.parse(config)).model, "qwen2.5-7b-instruct-q4_k_m");
  for (const model of ["qwen3-coder:30b", "qwen3:8b", "qwen3-8b"])
    assert.equal(CliWorkerConfigSchema.safeParse({ ...config, model }).success, false);
});
test("CLI cancellation refuses before reading a model", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new CliLocalInference(CliWorkerConfigSchema.parse(config)).replace("fix", controller.signal), /abort/i);
});
test("CLI keeps admitted model and path authority when the caller changes its config", () => {
  const input = CliWorkerConfigSchema.parse({ ...config, model: "qwen3-8b-q4_k_m" });
  const worker = new CliLocalInference(input);
  input.model = "qwen2.5-7b-instruct-q4_k_m";
  input.executable = "/another-cli";
  input.permittedPaths[0] = "docs/another.md";
  assert.equal(worker.model, "qwen3-8b-q4_k_m");
  const bound = CliWorkerConfigSchema.parse(worker.config);
  assert.equal(bound.model, worker.model);
  assert.equal(bound.executable, config.executable);
  assert.deepEqual(bound.permittedPaths, config.permittedPaths);
});
test("CLI public configuration cannot rebind the admitted inference identity", () => {
  const worker = new CliLocalInference(CliWorkerConfigSchema.parse({ ...config, model: "qwen3-8b-q4_k_m" }));
  assert.equal(Reflect.set(worker.config, "model", "qwen2.5-7b-instruct-q4_k_m"), false);
  assert.equal(Reflect.set(worker.config.permittedPaths, "0", "docs/another.md"), false);
  assert.equal(Reflect.set(worker, "config", CliWorkerConfigSchema.parse(config)), false);
  assert.equal(Reflect.set(worker, "model", "qwen2.5-7b-instruct-q4_k_m"), false);
  assert.equal(worker.model, "qwen3-8b-q4_k_m");
  assert.equal(CliWorkerConfigSchema.parse(worker.config).model, worker.model);
});
test("CLI oversized prompts refuse before executable access", async () => {
  await assert.rejects(new CliLocalInference(CliWorkerConfigSchema.parse(config)).replace("x".repeat(5501), new AbortController().signal), /context budget/);
});
