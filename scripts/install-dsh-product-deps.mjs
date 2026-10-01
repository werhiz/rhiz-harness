import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const testedVersion = "0.1.0-rc.8";
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf8",
}).trim();
const home = resolve(process.env.RHIZ_DSH_PRODUCT_HOME ?? join(root, ".context/rhiz-harness/dsh-products"));
const packageJsonPath = join(home, "package.json");
const packageLockPath = join(home, "package-lock.json");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const dependencies = {
  "@deepseek-ai/cordis": "4.0.1",
  "@deepseek-ai/dsh-invariants": testedVersion,
  "@deepseek-ai/dsh-llm": testedVersion,
  "@deepseek-ai/dsh-session": testedVersion,
  "@deepseek-ai/dsh-subagent": testedVersion,
  "@deepseek-ai/dsh-subagent-claude-code": testedVersion,
  "@deepseek-ai/dsh-subagent-codex": testedVersion,
  "@deepseek-ai/dsh-subprocess": testedVersion,
  "@deepseek-ai/dsh-subprocess-local": testedVersion,
  "@deepseek-ai/dsh-timeout": testedVersion,
};

mkdirSync(home, { recursive: true });
const manifest = {
  name: "rhiz-harness-local-dsh-products",
  private: true,
  type: "module",
  dependencies,
};
writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const args = existsSync(packageLockPath)
  ? ["ci", "--prefix", home, "--no-audit", "--no-fund"]
  : ["install", "--prefix", home, "--save-exact", "--no-audit", "--no-fund"];

console.log(`Installing pinned DSH product runtime into ${home}`);
execFileSync(npm, args, {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
console.log(`DSH product runtime ready at ${home}`);
console.log("Credentials were not read, copied, or stored by this setup command.");
