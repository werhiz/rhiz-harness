import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function nativeReviewCandidate(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rhiz-native-review-test-")));
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root });
  git(["init", "-q", "-b", "main"]); git(["add", "."]);
  git(["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "fixture"]);
  return root;
}

export async function nativeReviewExecutable(
  home: string,
  packageRoot = fileURLToPath(new URL("../../../", import.meta.url)),
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<string> {
  const triples: Readonly<Record<string, string>> = {
    arm64: "aarch64-apple-darwin",
    x64: "x86_64-apple-darwin",
  };
  if (platform !== "darwin" || !triples[arch]) throw new Error("unsupported native fixture platform or architecture");
  const local = join(packageRoot, "node_modules/@openai/codex/package.json");
  const wrapper = createRequire(join(packageRoot, "package.json")).resolve("@openai/codex/package.json");
  if (await realpath(wrapper) !== await realpath(local)) throw new Error("native fixture requires the local Codex dependency");
  const metadata = JSON.parse(await readFile(wrapper, "utf8")), alias = `@openai/codex-darwin-${arch}`;
  if (metadata.name !== "@openai/codex" || metadata.version !== "0.162.1"
    || metadata.optionalDependencies?.[alias] !== `npm:@openai/codex@0.162.1-darwin-${arch}`) throw new Error("native fixture wrapper metadata mismatch");
  const packaged = await realpath(createRequire(wrapper).resolve(`${alias}/package.json`));
  if (!packaged.startsWith((await realpath(join(packageRoot, "node_modules"))) + "/")) throw new Error("native fixture requires a local platform package");
  const details = JSON.parse(await readFile(packaged, "utf8"));
  if (details.name !== "@openai/codex" || details.version !== `0.162.1-darwin-${arch}`
    || !Array.isArray(details.os) || !details.os.includes("darwin")
    || !Array.isArray(details.cpu) || !details.cpu.includes(arch)) throw new Error("native fixture platform metadata mismatch");
  const executable = await realpath(join(dirname(packaged), "vendor", triples[arch]!, "bin/codex"));
  const version = execFileSync(executable, ["--version"], {
    env: { HOME: home, CODEX_HOME: home, PATH: "" }, encoding: "utf8", timeout: 5000,
  }).trim();
  if (version !== "codex-cli 0.162.1") throw new Error("native fixture executable version mismatch");
  return executable;
}
