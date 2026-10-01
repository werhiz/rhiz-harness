import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import { candidateIdentityDifferences, TempDirectoryDerivativeFactory } from "../src/disposable.js";

/**
 * Failure cases 1, 2 and 3 from issue #63, with the process actually dying.
 *
 * A test that sets `crashed = true` and checks a `finally` proves nothing about
 * a crash: the whole hazard is that `finally` does not run. So each of these
 * spawns a real child, waits for the child to announce that the mutation is
 * written, and then kills it by signal or by wall-clock timeout at that exact
 * point.
 *
 * Each case asserts three things, and the middle one is what makes the other two
 * mean anything:
 *
 *   1. the child died the way it was supposed to die;
 *   2. the derivative SURVIVED, proving no cleanup ran and the kill genuinely
 *      landed at the dangerous boundary rather than after a tidy exit;
 *   3. the authoritative candidate is byte-identical anyway.
 *
 * Then the sweep reclaims the orphan, which is the half of the guarantee a dead
 * process cannot provide for itself.
 *
 * Platform note: these use POSIX signals (SIGKILL, SIGINT) and pid liveness.
 * They run on Linux and macOS. CI is ubuntu-latest, so CI executes them.
 */

const CANDIDATE_SOURCE = "export const acceptable = false;\n";
const CANARY_MUTATION = "export const acceptable = true;\n";
const childScript = fileURLToPath(new URL("./fixtures/disposable-proof-child.js", import.meta.url));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeCandidate(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rhiz-kill-candidate-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/board.ts"), CANDIDATE_SOURCE, "utf8");
  await writeFile(join(root, "package.json"), '{"name":"candidate","private":true}\n', "utf8");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=proof@example.com", "-c", "user.name=Proof", "commit", "-q", "-m", "base"]);
  return root;
}

interface MutatedAnnouncement {
  phase: "mutated";
  pid: number;
  derivativeRoot: string;
}

/** Resolve when the child announces that the mutation exists inside its derivative. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

function awaitMutation(child: PipedChild): Promise<MutatedAnnouncement> {
  return new Promise((resolvePromise, rejectPromise) => {
    const lines = createInterface({ input: child.stdout });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    lines.on("line", (line) => {
      const parsed = JSON.parse(line) as { phase: string };
      if (parsed.phase === "mutated") {
        lines.close();
        resolvePromise(parsed as unknown as MutatedAnnouncement);
      }
    });
    child.once("exit", () => rejectPromise(new Error(`child exited before mutating: ${stderr.join("")}`)));
  });
}

/** Prove the boundary was real: the mutation is sitting in the abandoned derivative. */
async function assertDerivativeSurvived(derivativeRoot: string): Promise<void> {
  assert.equal(existsSync(derivativeRoot), true, "the derivative survived, so no cleanup ran");
  assert.equal(
    await readFile(join(derivativeRoot, "src/board.ts"), "utf8"),
    CANARY_MUTATION,
    "the abandoned derivative still holds the mutation, so the kill landed after it was written",
  );
}

async function assertCandidateIntact(root: string, before: Awaited<ReturnType<GitCandidateIdentityProbe["pin"]>>): Promise<void> {
  const after = await new GitCandidateIdentityProbe().pin(root);
  assert.deepEqual(candidateIdentityDifferences(before, after), [], "the authoritative candidate did not move");
  assert.equal(await readFile(join(root, "src/board.ts"), "utf8"), CANDIDATE_SOURCE);
  assert.equal(git(root, ["status", "--porcelain=v1"]), "", "the candidate working tree is clean");
}

test("failure case 1: SIGKILL after the mutation leaves the candidate byte-identical", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await realpath(await mkdtemp(join(tmpdir(), "rhiz-kill-reap-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const before = await new GitCandidateIdentityProbe().pin(root);
  const child = spawn(process.execPath, [childScript, root, reapRoot, "hang"], { stdio: ["ignore", "pipe", "pipe"] });
  const announcement = await awaitMutation(child);

  // SIGKILL: uncatchable. No handler, no unwind, no cleanup is even possible.
  child.kill("SIGKILL");
  const [code, signal] = await once(child, "exit") as [number | null, string | null];
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");

  await assertDerivativeSurvived(announcement.derivativeRoot);
  await assertCandidateIntact(root, before);

  const sweeper = new TempDirectoryDerivativeFactory({ reapRoot });
  assert.deepEqual(await sweeper.sweepAbandoned(), [announcement.derivativeRoot]);
  assert.equal(existsSync(announcement.derivativeRoot), false);
});

test("failure case 2: a wall-clock timeout kills the proof mid-flight and the candidate is byte-identical", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await realpath(await mkdtemp(join(tmpdir(), "rhiz-timeout-reap-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const before = await new GitCandidateIdentityProbe().pin(root);
  // The timeout is enforced by the supervisor, not by the proof: the child has
  // no timeout of its own and would hang forever.
  //
  // The deadline is armed once the mutation exists, NOT via spawn's own
  // `timeout` option. That option measures from spawn, so on a slow runner it
  // can fire while the child is still starting up — which would both flake and
  // test the wrong boundary, since the whole point is a kill that arrives after
  // the derivative has been mutated.
  const child = spawn(process.execPath, [childScript, root, reapRoot, "hang"], { stdio: ["ignore", "pipe", "pipe"] });
  const announcement = await awaitMutation(child);

  const deadlineMs = 500;
  const armedAt = Date.now();
  const deadline = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
  const [code, signal] = await once(child, "exit") as [number | null, string | null];
  clearTimeout(deadline);
  assert.equal(signal, "SIGKILL", `expected the deadline to kill the child, got code ${code}`);
  assert.ok(
    Date.now() - armedAt >= deadlineMs,
    "the child outlived its deadline, so the kill was time-driven rather than immediate",
  );

  await assertDerivativeSurvived(announcement.derivativeRoot);
  await assertCandidateIntact(root, before);

  const sweeper = new TempDirectoryDerivativeFactory({ reapRoot });
  assert.deepEqual(await sweeper.sweepAbandoned(), [announcement.derivativeRoot]);
});

test("failure case 3: cancellation that exits from the signal handler leaves the candidate byte-identical", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await realpath(await mkdtemp(join(tmpdir(), "rhiz-cancel-reap-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const before = await new GitCandidateIdentityProbe().pin(root);
  const child = spawn(process.execPath, [childScript, root, reapRoot, "cancel"], { stdio: ["ignore", "pipe", "pipe"] });
  const announcement = await awaitMutation(child);

  child.kill("SIGINT");
  const [code, signal] = await once(child, "exit") as [number | null, string | null];
  assert.equal(signal, null, "the child handled SIGINT rather than being killed by it");
  assert.equal(code, 130, "it aborted and exited from inside the handler, so no cleanup ran");

  await assertDerivativeSurvived(announcement.derivativeRoot);
  await assertCandidateIntact(root, before);

  const sweeper = new TempDirectoryDerivativeFactory({ reapRoot });
  assert.deepEqual(await sweeper.sweepAbandoned(), [announcement.derivativeRoot]);
});
