import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../src/", import.meta.url);
const forbidden = [
  /(?:from|import\()\s*["'][^"']*(?:deepseek|@deepseek-ai|\bdsh\b)[^"']*["']/i,
  /(?:from|import\()\s*["'][^"']*rhizprotocol[^"']*["']/i,
];

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if ([".ts", ".mts", ".js", ".mjs"].includes(extname(entry.name))) output.push(path);
  }
  return output;
}

const sourceRoot = new URL(root).pathname;
const violations = [];
for (const file of await files(sourceRoot)) {
  const content = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) violations.push(relative(sourceRoot, file));
  }
}

if (violations.length > 0) {
  console.error(`portable core imports a concrete host/product: ${[...new Set(violations)].join(", ")}`);
  process.exit(1);
}

console.log("portable boundary: PASS");
