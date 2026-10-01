#!/usr/bin/env node
/**
 * Prove every declared safety guard is load bearing.
 *
 * Each mutation is made through `runDisposableProof`: the authoritative
 * candidate is pinned, a derivative is mutated, the named test observes the
 * missing enforcement, and the candidate is re-pinned after cleanup. This is
 * deliberately not a convenience copy routine. A falsifier must never write
 * the candidate it is judging (ADR 0019).
 *
 * Each guard costs a full derivative copy, a compile and a test run, so the
 * guards are judged concurrently. Every proof is independent by construction —
 * it reads the candidate and writes only its own derivative — so the only thing
 * serialising them bought was wall clock, which is what pushed this gate past
 * the CI job budget.
 *
 * Usage: node scripts/check-guard-falsifiability.mjs [--only <guard-id>]
 *        [--manifest <path>] [--concurrency <n>]
 */

import { execFile } from "node:child_process";
import { lstat, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { GitCandidateIdentityProbe } from "../dist/adapters/git/candidate-identity.js";
import { TempDirectoryDerivativeFactory, runDisposableProof } from "../dist/src/disposable.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const REQUIRED_GUARDS = ["worker/guarded-tool-mediation"];
// A linked Git worktree may inherit dependencies from its primary checkout.
// Disposable derivatives deliberately sit outside that checkout, so resolve the
// compiler before we enter one rather than assuming it has node_modules.
const require = createRequire(import.meta.url);
const typescriptCli = require.resolve("typescript/bin/tsc");
const dependencyRoot = dirname(dirname(dirname(typescriptCli)));
const childEnvironment = { ...process.env };
// This gate is itself exercised from `node --test`. A nested test process that
// inherits Node's private runner marker exits successfully without executing
// its files, which would report every removed guard as harmless.
delete childEnvironment.NODE_TEST_CONTEXT;

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const execFileAsync = promisify(execFile);

async function run(root, args) {
  return await execFileAsync(process.execPath, args, {
    cwd: root,
    env: childEnvironment,
    encoding: "utf8",
    // A compile or test run that talks a lot must fail on what it said, not on
    // the size of what it said.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The derivative intentionally lives outside the linked worktree, so Node and
 * TypeScript cannot walk upward to the worktree's inherited dependencies. The
 * link is support tooling, not candidate content: it is added only after the
 * derivative's faithful baseline is checked, and derivative cleanup removes
 * the link rather than its target.
 */
async function bindDependencies(root) {
  const modules = join(root, "node_modules");
  try {
    await lstat(modules);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await symlink(dependencyRoot, modules, "dir");
  }
}

/**
 * Compile a derivative and run one falsifier inside it.
 *
 * The same routine judges the control run and the mutated run, so a red result
 * is only ever compared against a green one produced the same way.
 */
async function runFalsifier(root, testFile) {
  await bindDependencies(root);
  // A derivative copies the candidate's build output and incremental state.
  // Reusing either would let TypeScript judge the pre-mutation JavaScript when
  // the copied source, tsbuildinfo and mutation share indistinguishable mtimes.
  // A falsifier must compile the bytes it actually changed.
  await rm(join(root, "dist"), { recursive: true, force: true });
  try {
    await run(root, [typescriptCli, "-p", join(root, "tsconfig.json")]);
  } catch (error) {
    return { kind: "uncompilable", detail: String(error.stdout ?? error).slice(0, 600) };
  }
  try {
    await run(root, ["--test", join(root, testFile)]);
    return { kind: "test-passed" };
  } catch (error) {
    return { kind: "test-failed", detail: String(error.stdout ?? error).slice(0, 600) };
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the results. Order matters here: the report a human reads must not
 * depend on which derivative finished first.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function main() {
  const only = readOption("--only");
  const rawManifestPath = readOption("--manifest");
  const manifestPath = rawManifestPath === null
    ? join(repoRoot, "scripts/guard-manifest.json")
    : resolve(rawManifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const declared = new Set(manifest.guards.map((guard) => guard.id));
  const missingRequired = REQUIRED_GUARDS.filter((id) => !declared.has(id));
  if (missingRequired.length > 0) {
    for (const id of missingRequired) console.error(`required guard missing: ${id}`);
    process.exitCode = 1;
    return;
  }

  const guards = only === null ? manifest.guards : manifest.guards.filter((guard) => guard.id === only);
  if (guards.length === 0) {
    console.error(only === null ? "manifest declares no guards" : `no guard with id ${only}`);
    process.exitCode = 1;
    return;
  }

  const rawConcurrency = readOption("--concurrency") ?? process.env.RHIZ_GUARD_CONCURRENCY ?? null;
  const concurrency = rawConcurrency === null
    ? Math.max(1, Math.min(4, availableParallelism() - 1))
    : Number.parseInt(rawConcurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`concurrency must be a positive integer, got ${rawConcurrency}`);
    process.exitCode = 1;
    return;
  }

  // A falsifier that cannot pass in an unmutated derivative proves nothing:
  // its red result would be about the derivative, not about the guard. The
  // control is computed once per falsifier under the same pinned candidate,
  // and every other guard sharing that falsifier awaits that one answer.
  const controls = new Map();

  const results = await mapWithConcurrency(guards, concurrency, async (guard) => {
    const source = await readFile(join(repoRoot, guard.file), "utf8");
    if (!source.includes(guard.remove)) {
      return {
        id: guard.id,
        outcome: "DRIFTED",
        failure: `${guard.id}: the declared enforcing code was not found in ${guard.file}. The guard moved or changed; update the manifest deliberately rather than deleting the entry.`,
      };
    }

    const receipt = await runDisposableProof({
      candidateRoot: repoRoot,
      probe: new GitCandidateIdentityProbe(),
      factory: new TempDirectoryDerivativeFactory(),
      mutate: async (derivative) => {
        if (!controls.has(guard.testFile)) {
          // Claim the control synchronously, then wait for it here: this
          // derivative is still unmutated, and it stops being a control the
          // moment the guard is removed below.
          const control = runFalsifier(derivative.root, guard.testFile);
          controls.set(guard.testFile, control);
          await control;
        }
        await derivative.mutate(
          guard.file,
          source.replace(guard.remove, ""),
          `remove falsifiability guard ${guard.id}`,
        );
      },
      proof: async (derivative) => runFalsifier(derivative.root, guard.testFile),
    });

    if (receipt.outcome !== "proven") {
      return {
        id: guard.id,
        outcome: "INVALIDATED",
        failure: `${guard.id}: disposable proof was invalidated (${receipt.invalidations.map((item) => item.code).join(", ")}); no falsifier conclusion is valid.`,
      };
    }
    const control = await controls.get(guard.testFile);
    if (control === undefined || control.kind !== "test-passed") {
      return {
        id: guard.id,
        outcome: "NO-CONTROL",
        failure: `${guard.id}: ${guard.testFile} does not pass in an unmutated derivative (${control?.kind ?? "control-not-run"}), `
          + `so its failure with the guard removed proves nothing about the guard.\n${control?.detail ?? ""}`,
      };
    }
    if (receipt.result.kind === "uncompilable") {
      return {
        id: guard.id,
        outcome: "UNCOMPILABLE",
        failure: `${guard.id}: removing the guard broke the build, so the test could not judge it. Narrow the declared snippet to the enforcement itself.\n${receipt.result.detail}`,
      };
    }
    if (receipt.result.kind === "test-passed") {
      return {
        id: guard.id,
        outcome: "UNPROVEN",
        failure: `${guard.id}: ${guard.testFile} still PASSES with the guard removed, so nothing proves this guard holds.\n    why it matters: ${guard.why}`,
      };
    }
    return { id: guard.id, outcome: "proven", failure: null };
  });

  // Reported in manifest order, not completion order: a concurrent gate must
  // still read the same way twice.
  const failures = results.filter((result) => result.failure !== null).map((result) => result.failure);

  const width = Math.max(...results.map((result) => result.id.length));
  for (const result of results) {
    const mark = result.outcome === "proven" ? "proven" : result.outcome;
    console.log(`  ${result.id.padEnd(width)}  ${mark}`);
  }
  if (failures.length > 0) {
    console.error(`\nguard falsifiability: FAIL (${failures.length} of ${guards.length})\n`);
    for (const failure of failures) console.error(`- ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nguard falsifiability: PASS (${guards.length} guards, each proven by a test that fails without it)`);
}

await main();
