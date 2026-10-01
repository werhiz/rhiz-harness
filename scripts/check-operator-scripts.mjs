// Operator scripts parse. That is all this gate establishes.
//
// It derives its membership from the filesystem and states its scope in its
// own output, because both halves of that were wrong here before.
//
// ## Why the membership is derived
//
// This was five script names written by hand into a package.json string. On
// 2026-08-21 a branch replaced that string wholesale and silently dropped two
// of them; the list happened to be complete again by the afternoon, which is
// the dangerous state, because it was correct by someone's attention rather
// than by construction. Reading the directory removes that failure mode: a new
// script is covered on the day it appears, not on the day someone remembers.
//
// ## Why the scope is printed, loudly
//
// `node --check` parses. It does not execute, resolve imports, or type-check.
//
// That matters because of how this gate got widened. On 2026-08-21
// `scripts/dsh-smoke.mjs` called `worker.start()` without the `workspace`
// field that issue #9 had just made required. CI caught it as a runtime
// ZodError. The response was to add that script to this gate, with a commit
// message claiming the next contract change that broke a script would fail
// locally instead of in CI.
//
// That claim was false. The break was a runtime contract violation in
// syntactically perfect code, and `node --check` would have passed it before
// the fix exactly as it passes it after. A syntax gate was widened in response
// to a semantic failure, and the commit message asserted a guarantee the gate
// could not provide.
//
// So the exclusions below are not a disclaimer. They are the specific reason
// someone already misread this gate once, written down so the next reader
// starts where that reader ended up.
//
// Real coverage for these scripts is execution, which happens in the Kernel CI
// jobs that `check:ci-parity` declares are out of local reach.

import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const scriptsDir = fileURLToPath(new URL("../scripts/", import.meta.url));

const entries = await readdir(scriptsDir, { withFileTypes: true });
const scripts = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
  .map((entry) => entry.name)
  .sort();

// A directory holding an operator script would be invisible to the readdir
// above, in the same way `check-barrel.mjs` cannot see `src/verify/` and is
// only correct because someone wrote a shim by hand. Say so rather than let
// "all operator scripts" be inferred from a flat scan.
const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

if (scripts.length === 0) {
  console.error("operator scripts: no scripts/*.mjs found, which is not a passing state");
  process.exit(1);
}

const failures = [];
for (const name of scripts) {
  try {
    execFileSync(process.execPath, ["--check", `${scriptsDir}${name}`], { stdio: "pipe" });
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split("\n").slice(0, 3).join(" ");
    failures.push(`${name}: ${detail}`);
  }
}

if (failures.length > 0) {
  console.error(`\noperator scripts: ${failures.length} of ${scripts.length} failed to parse\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(`operator scripts: PASS (${scripts.length} scripts parse)`);
console.log("");
console.log("  SCOPE OF THIS GATE. Parsing only:");
console.log("    node --check parses. It does not execute, resolve imports, or type-check.");
console.log("    A script that parses can still fail on its first line at runtime.");
console.log("    scripts/dsh-smoke.mjs did exactly that on 2026-08-21: a call missing a");
console.log("    newly required field, syntactically perfect, caught only by CI.");
console.log("    Execution coverage lives in the CI jobs check:ci-parity declares.");
if (directories.length > 0) {
  console.log(`    Directories under scripts/ are not scanned: ${directories.join(", ")}`);
}
console.log("");
