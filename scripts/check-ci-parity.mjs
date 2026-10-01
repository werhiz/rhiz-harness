#!/usr/bin/env node
// The local gate must know what it does not cover, and say so.
//
// On 2026-08-21 `main` was red for roughly forty minutes while two sessions
// independently reported it green. Both reports were true statements about
// `npm run check` and false statements about the repository, because the
// failing job was `smoke:dsh-products`, which `check` does not run: it needs a
// DSH package closure that only CI installs.
//
// A gate that omits a job silently is indistinguishable from a gate that covers
// it. This makes the omission mechanical: every npm script CI runs must either
// be reachable from `check`, or be listed here as deliberately out of local
// reach, and the list is PRINTED at the end of every `check` so nobody can read
// a green gate as a green repository.
//
// This does not make the local gate stronger. It makes it honest, which is the
// property it was missing.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Scripts CI runs that cannot run locally, each with the reason. A script may
 * only appear here deliberately: adding an entry is a decision to accept a
 * blind spot, and it shows up in every gate run from then on.
 */
const NOT_COVERED_LOCALLY = {
  "canary:codex": "requires the self-hosted Mac operator's existing Codex authentication and performs a real model-backed App Server write; it runs as the separately observed candidate-SHA canary rather than inside the deterministic local gate",
  "smoke:dsh-products": "needs the pinned @deepseek-ai package closure installed separately from the local gate",
  "smoke:dsh": "needs the keyless DSH runtime fixture and the same separately installed package closure",
};

/**
 * The inverse blind spot, and the more dangerous one.
 *
 * NOT_COVERED_LOCALLY exists because a job CI runs and the local gate does not
 * makes a local pass mean less than it looks. This exists because of the
 * opposite: a proof the LOCAL gate runs and CI does not makes a CI pass mean
 * less than it looks, and CI is what gates the merge.
 *
 * PR #68 found it the hard way. The test that proves write-enabled workers are
 * confined by the operating system requires darwin, because sandbox-exec is the
 * only mechanism this project has. CI runs ubuntu. So the single test proving
 * the boundary skipped on every CI run, and the gate went green having never
 * executed the enforcement it certifies -- in the pull request whose entire
 * purpose was to stop exactly that. It also silently took a declared guard with
 * it: with the darwin test skipped, nothing falsified the guard it proved, and
 * `check:guards` reported it UNPROVEN.
 *
 * So: every darwin-gated test file must be declared here, with where the proof
 * IS executed. Adding an entry is a decision to accept that CI does not prove
 * something, and it prints on every gate run from then on.
 */
const NOT_PROVEN_IN_CI = {
  "test/containment.test.ts": {
    reason: "verifier OS containment is proven by real sandbox-exec escape attempts; sandbox-exec is darwin-only",
    provenOn: "a darwin workstation running `npm run check` (ADR 0017)",
  },
  "test/worker-containment.test.ts": {
    reason: "the worker OS boundary is proven by a real escape attempt at the local-command seam; sandbox-exec is darwin-only",
    provenOn: "a darwin workstation running `npm run check` (ADR 0020). CI still proves the fail-closed half, the derivation, and the evidence channel, which are platform independent",
  },
};

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const scripts = manifest.scripts ?? {};

/** Every npm script reachable from `check`, following `npm run` chains. */
function reachableFrom(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const body = scripts[name];
    if (typeof body !== "string") continue;
    for (const match of body.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) stack.push(match[1]);
  }
  return seen;
}

const covered = reachableFrom("check");

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
let workflowFiles = [];
try {
  workflowFiles = (await readdir(workflowsDir)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
} catch {
  console.log("ci parity: no workflows directory, nothing to compare");
  process.exit(0);
}

const ciScripts = new Map();
const workflowTexts = new Map();
for (const file of workflowFiles) {
  const text = await readFile(new URL(file, workflowsDir), "utf8");
  workflowTexts.set(file, text);
  for (const match of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    const name = match[1];
    if (!ciScripts.has(name)) ciScripts.set(name, file);
  }
}

const undeclared = [];
for (const [name, file] of ciScripts) {
  if (covered.has(name)) continue;
  if (Object.hasOwn(NOT_COVERED_LOCALLY, name)) continue;
  undeclared.push({ name, file });
}

const stale = Object.keys(NOT_COVERED_LOCALLY).filter((name) => !ciScripts.has(name));

if (undeclared.length > 0 || stale.length > 0) {
  console.error("ci parity: FAIL\n");
  for (const { name, file } of undeclared) {
    console.error(
      `- ${file} runs "npm run ${name}", which the local gate does not reach.\n` +
      "    Either add it to check, or declare it in NOT_COVERED_LOCALLY with the reason it cannot run locally.\n" +
      "    Leaving it in neither is how a green local gate comes to mean nothing about the repository.",
    );
  }
  for (const name of stale) {
    console.error(
      `- "${name}" is declared as not covered locally, but no workflow runs it.\n` +
      "    Remove the entry: a stale blind spot advertises a gap that does not exist and hides one that might.",
    );
  }
  process.exit(1);
}

// Which platform does CI actually run on? If a macOS runner ever appears, the
// darwin declarations below become stale rather than staying true by habit.
const ciRunsOnDarwin = workflowFiles.some((file) => workflowTexts.get(file)?.match(/runs-on:\s*macos/i));

const testDir = new URL("../test/", import.meta.url);
const testFiles = (await readdir(testDir)).filter((name) => name.endsWith(".test.ts"));
const darwinGated = [];
for (const name of testFiles) {
  const text = await readFile(new URL(name, testDir), "utf8");
  // Requires darwin, so a Linux runner skips it. A file that merely skips on
  // win32 still runs on CI and is deliberately not caught here.
  if (/process\.platform\s*[!=]==\s*"darwin"/.test(text)) darwinGated.push(`test/${name}`);
}

const undeclaredProofs = ciRunsOnDarwin ? [] : darwinGated.filter((file) => !Object.hasOwn(NOT_PROVEN_IN_CI, file));
const staleProofs = Object.keys(NOT_PROVEN_IN_CI).filter((file) => ciRunsOnDarwin || !darwinGated.includes(file));

if (undeclaredProofs.length > 0 || staleProofs.length > 0) {
  console.error("ci parity: FAIL\n");
  for (const file of undeclaredProofs) {
    console.error(
      `- ${file} requires darwin, so every Linux CI run skips it.\n` +
      "    Declare it in NOT_PROVEN_IN_CI with where the proof IS executed, or make it run everywhere.\n" +
      "    A proof that only runs where the merge gate does not is not protecting the merge.",
    );
  }
  for (const file of staleProofs) {
    console.error(
      `- "${file}" is declared as not proven in CI, but ${ciRunsOnDarwin ? "CI now has a macOS runner" : "it is no longer darwin-gated"}.\n` +
      "    Remove the entry: a stale blind spot advertises a gap that does not exist and hides one that might.",
    );
  }
  process.exit(1);
}

/**
 * The third blind spot: a proof that nothing runs.
 *
 * The disposable falsifiability proofs pin, copy and recompile the whole
 * candidate, so they are deliberately kept out of the unit glob
 * (`dist/test/*.test.js`) and executed by their own script. That separation is
 * only safe while something checks it: a proof sitting in a directory no
 * command names is a proof that never runs, and it looks exactly like one that
 * does. So the gate proves the directory is non-empty, that a script reachable
 * from `check` executes it, and that the unit glob still cannot reach it.
 */
const PROOF_DIR = "test/proofs";
const proofFailures = [];
let proofFiles = [];
try {
  proofFiles = (await readdir(new URL(`../${PROOF_DIR}/`, import.meta.url))).filter((name) => name.endsWith(".test.ts"));
} catch {
  proofFailures.push(`${PROOF_DIR}/ does not exist, so the disposable falsifiability proofs are not anywhere this gate can execute them.`);
}
if (proofFiles.length === 0 && proofFailures.length === 0) {
  proofFailures.push(`${PROOF_DIR}/ declares no *.test.ts proof, so the explicit proof command runs nothing.`);
}

const proofRunners = [...covered].filter((name) => (scripts[name] ?? "").includes(`dist/${PROOF_DIR}/`));
if (proofFiles.length > 0 && proofRunners.length === 0) {
  proofFailures.push(
    `no npm script reachable from \`check\` runs dist/${PROOF_DIR}/, so ${proofFiles.length} disposable proof file(s) execute nowhere.\n` +
    "    Add the proof command back to check: a proof outside the unit glob and outside the gate is not a proof.",
  );
}

for (const [name, body] of Object.entries(scripts)) {
  if (/node --test [^&|]*dist\/test\/\*\*/.test(body)) {
    proofFailures.push(
      `script "${name}" widens the unit glob to dist/test/**, which pulls the disposable proofs into ordinary test runs.\n` +
      `    Keep them behind their own command; they recompile the whole candidate.`,
    );
  }
}

if (proofFailures.length > 0) {
  console.error("ci parity: FAIL\n");
  for (const failure of proofFailures) console.error(`- ${failure}`);
  process.exit(1);
}

const gaps = Object.entries(NOT_COVERED_LOCALLY);
const proofGaps = Object.entries(NOT_PROVEN_IN_CI);
console.log(`ci parity: PASS (${ciScripts.size} CI scripts, ${gaps.length} declared out of local reach, ${proofGaps.length} declared out of CI's reach, ${proofFiles.length} disposable proof file(s) run by ${proofRunners.join(", ")})`);
if (gaps.length > 0) {
  console.log("\n  NOT COVERED BY THIS GATE. A pass here is not a green repository:");
  for (const [name, reason] of gaps) console.log(`    ${name}  ${reason}`);
  console.log("    Record the independent exact-candidate check receipt and name the DSH/canary gaps before integration.\n");
}
if (proofGaps.length > 0) {
  console.log("  NOT PROVEN BY CI. A green CI run is not proof of these:");
  for (const [file, { reason, provenOn }] of proofGaps) {
    console.log(`    ${file}`);
    console.log(`      why CI skips it: ${reason}`);
    console.log(`      proven instead on: ${provenOn}`);
  }
  console.log("");
}
