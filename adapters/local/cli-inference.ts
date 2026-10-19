import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { requireSandbox } from "../../src/sandbox.js";
import { createDefaultSandboxLauncher } from "./sandbox.js";
import { LocalReplacementSchema, localEditablePath, type LocalInference } from "./model-worker.js";
// Pinned GGUF identities this bridge has been proven with; the file digest is still required.
export const CLI_MODELS = ["qwen2.5-7b-instruct-q4_k_m", "qwen3-8b-q4_k_m"] as const;
export const CliWorkerConfigSchema = z.object({
  backend: z.literal("llama-cli"), model: z.enum(CLI_MODELS),
  executable: z.string().startsWith("/"), executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelPath: z.string().startsWith("/"), digest: z.string().regex(/^[a-f0-9]{64}$/),
  autonomousPaidBudgetUsd: z.literal(0), cloudFallback: z.literal(false),
  permittedPaths: z.array(z.string().refine(localEditablePath)).min(1).max(10),
}).strict();
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export class CliLocalInference implements LocalInference {
  readonly model: (typeof CLI_MODELS)[number];
  constructor(readonly config: z.infer<typeof CliWorkerConfigSchema>) { this.model = CliWorkerConfigSchema.parse(config).model; }
  async replace(prompt: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const c = CliWorkerConfigSchema.parse(this.config);
    if (Buffer.byteLength(prompt) > 5500) throw new Error("CLI context budget exceeded");
    if (await fileDigest(c.executable) !== c.executableDigest || await fileDigest(c.modelPath) !== c.digest)
      throw new Error("Pinned executable or model changed; no fallback");
    signal.throwIfAborted();
    const schema = JSON.stringify({ type: "object", additionalProperties: false,
      required: ["path", "oldText", "newText"], properties: {
        path: { type: "string", enum: c.permittedPaths }, oldText: { type: "string" }, newText: { type: "string" } } });
    const wrapped = await requireSandbox(createDefaultSandboxLauncher(), {
      writableRoots: [], allowRead: true, allowNetwork: false, allowProcessExec: true,
    }, await realpath(c.executable), ["-m", await realpath(c.modelPath), "--offline", "--device", "none",
      "--no-op-offload", "--fit", "off", "-ngl", "0", "-t", "4", "-tb", "4", "-c", "2048",
      "-n", "220", "-no-cnv", "--temp", "0", "--seed", "42", "--no-display-prompt", "--simple-io",
      "--json-schema", schema, "-p",
      `<|im_start|>system\nReturn only a JSON object with path, oldText, newText for the exact replacement. You cannot execute or accept work.<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`]);
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(wrapped.command, wrapped.args, { env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" },
          stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
        let out = "", err = "";
        child.stdout.on("data", b => { out += b; if (Buffer.byteLength(out) > 65536) { child.kill("SIGKILL"); reject(new Error("CLI response exceeds byte budget")); } });
        child.stderr.on("data", b => { err = (err + b).slice(-2000); });
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve(out) : reject(new Error(`Offline CLI failed (${code}): ${err}`)));
      });
      return LocalReplacementSchema.parse(JSON.parse(output.replace(/\s*\[end of text\]\s*$/, "").trim()));
    } finally { await wrapped.dispose(); }
  }
}
