import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import {
  assertDerivativeIsOutside,
  candidateIdentityDifferences,
  DerivativeCleanupError,
  DerivativeContainmentError,
  DerivativeEscapeError,
  requireProven,
  runDisposableProof,
  TempDirectoryDerivativeFactory,
  type DisposableDerivative,
  type DisposableProofReceipt,
} from "../src/disposable.js";

/**
 * The failure cases from issue #63, executed.
 *
 * Every test here builds a real git checkout, runs a real proof against it, and
 * re-reads the checkout afterwards. Nothing is asserted about a mock. The three
 * cases that require the process to actually die live in
 * `disposable-proof-kill.test.ts`, because a crash cannot be expressed in-process.
 *
 * The mutation used throughout is the one from the RH-14 canary:
 * `const acceptable = true` written into `src/board.ts`.
 */

const CANARY_MUTATION = "export const acceptable = true;\n";
const CANDIDATE_SOURCE = "export const acceptable = false;\n";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeCandidate(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rhiz-candidate-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/board.ts"), CANDIDATE_SOURCE, "utf8");
  await writeFile(join(root, "package.json"), '{"name":"candidate","private":true}\n', "utf8");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=proof@example.com", "-c", "user.name=Proof", "commit", "-q", "-m", "base"]);
  return root;
}

async function makeReapRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "rhiz-reap-")));
}

/** Assert a receipt is invalidated, and narrow it so the absent result is visible to the compiler. */
function invalidated<T>(receipt: DisposableProofReceipt<T>): Extract<DisposableProofReceipt<T>, { outcome: "invalidated" }> {
  assert.equal(receipt.outcome, "invalidated");
  return receipt as Extract<DisposableProofReceipt<T>, { outcome: "invalidated" }>;
}

test("candidate identity is content level: an uncommitted edit moves the digest while HEAD and tree stand still", async (t) => {
  const root = await makeCandidate();
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = new GitCandidateIdentityProbe();

  const before = await probe.pin(root);
  // Exactly what the RH-14 worker left behind.
  await writeFile(join(root, "src/board.ts"), CANARY_MUTATION, "utf8");
  const after = await probe.pin(root);

  // This is the whole reason identity is three facts and not one. A receipt that
  // pinned HEAD would have reported this candidate unchanged.
  assert.equal(after.head, before.head, "HEAD does not move on an uncommitted edit");
  assert.equal(after.tree, before.tree, "HEAD^{tree} does not move on an uncommitted edit");
  assert.notEqual(after.digest, before.digest);
  assert.deepEqual(candidateIdentityDifferences(before, after), ["digest"]);
});

test("candidate identity also moves on a commit, so an amended candidate cannot pass as the pinned one", async (t) => {
  const root = await makeCandidate();
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = new GitCandidateIdentityProbe();

  const before = await probe.pin(root);
  await writeFile(join(root, "src/board.ts"), CANARY_MUTATION, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=proof@example.com", "-c", "user.name=Proof", "commit", "-q", "-m", "mutate"]);
  const after = await probe.pin(root);

  assert.deepEqual(candidateIdentityDifferences(before, after), ["head", "tree", "digest"]);
});

test("a derivative inside the candidate is refused, including through a symlink", async (t) => {
  const root = await makeCandidate();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "rhiz-outside-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  const inside = join(root, ".proof-workspace");
  await mkdir(inside, { recursive: true });
  await assert.rejects(
    () => assertDerivativeIsOutside(inside, root),
    (error: unknown) => error instanceof DerivativeContainmentError,
  );

  // The string check on its own is defeated by one symlink, which is why the
  // assertion realpaths both sides before it compares them.
  const disguised = join(outside, "looks-external");
  await symlink(inside, disguised);
  await assert.rejects(
    () => assertDerivativeIsOutside(disguised, root),
    (error: unknown) => error instanceof DerivativeContainmentError,
  );

  // And the other direction: destroying that derivative would destroy the candidate.
  await assert.rejects(
    () => assertDerivativeIsOutside(dirname(root), root),
    (error: unknown) => error instanceof DerivativeContainmentError,
  );

  await assert.doesNotReject(() => assertDerivativeIsOutside(outside, root));
});

test("a proof cannot address the candidate: escaping mutation paths are refused before any write", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);

  const receipt = await runDisposableProof({
    candidateRoot: root,
    probe,
    factory,
    proof: async (derivative: DisposableDerivative) => {
      // A careless proof reaching for the candidate by relative path, which is
      // how the RH-14 mutation would have been written.
      assert.throws(() => derivative.resolve("../../src/board.ts"), DerivativeEscapeError);
      assert.throws(() => derivative.resolve(join(root, "src/board.ts")), DerivativeEscapeError);
      await assert.rejects(
        () => derivative.mutate("../".repeat(12) + "src/board.ts", CANARY_MUTATION, "escape attempt"),
        (error: unknown) => error instanceof DerivativeEscapeError,
      );
      // A legitimate mutation inside the derivative still works.
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
      return "escape refused";
    },
  });

  assert.equal(requireProven(receipt), "escape refused");
  assert.equal(await readFile(join(root, "src/board.ts"), "utf8"), CANDIDATE_SOURCE);
  assert.deepEqual(candidateIdentityDifferences(before, receipt.candidateAfter!), []);
});

test("the lifecycle: mutation lands only in the derivative, the result is recorded, the derivative is destroyed, the candidate is proven unchanged", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);

  let derivativeRoot = "";
  const receipt = await runDisposableProof({
    candidateRoot: root,
    probe,
    factory,
    mutate: async (derivative) => {
      derivativeRoot = derivative.root;
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
    },
    // The proof reads what the mutation wrote and reports what it saw. This
    // stands in for "run the load-bearing gate and watch it fail".
    proof: async (derivative) => readFile(derivative.resolve("src/board.ts"), "utf8"),
  });

  assert.equal(receipt.outcome, "proven");
  assert.equal(requireProven(receipt), CANARY_MUTATION, "the proof observed the mutation it applied");
  assert.equal(receipt.derivative.destroyed, true);
  assert.equal(receipt.derivative.residualPath, null);
  assert.equal(existsSync(derivativeRoot), false, "the derivative is gone");
  assert.deepEqual(receipt.mutations.map((mutation) => mutation.path), ["src/board.ts"]);

  // The derivative was byte-faithful to the pin before the mutation, so the
  // proof ran against the candidate's content and not something adjacent to it.
  assert.equal(receipt.derivative.digest, before.digest);

  assert.deepEqual(receipt.candidateDifferences, []);
  assert.equal(receipt.candidateAfter!.head, before.head);
  assert.equal(receipt.candidateAfter!.tree, before.tree);
  assert.equal(receipt.candidateAfter!.digest, before.digest);
  assert.equal(await readFile(join(root, "src/board.ts"), "utf8"), CANDIDATE_SOURCE);
});

test("a derivative preserves relative symlink text so its pinned digest is reproducible", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  // The relative target itself is execution-root content. Resolving it to an
  // absolute target during copy makes an otherwise faithful derivative fail the
  // pin before a falsifier has even begun.
  await symlink("./board.ts", join(root, "src/board-link.ts"));
  const probe = new GitCandidateIdentityProbe();
  const before = await probe.pin(root);
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const derivative = await factory.create(before);

  assert.equal(derivative.baselineDigest, before.digest);
  await factory.destroy(derivative);
});

test("failure case 4: a proof that throws is invalidated, the derivative is still destroyed, the candidate is untouched", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);
  let derivativeRoot = "";

  const receipt = await runDisposableProof<string>({
    candidateRoot: root,
    probe,
    factory,
    mutate: async (derivative) => {
      derivativeRoot = derivative.root;
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
    },
    // Not "the gate reported failure", which is a legitimate observation. This
    // is the proof harness itself coming apart, which is not an observation.
    proof: async () => { throw new Error("proof command exited with SIGSEGV"); },
  });

  const refused = invalidated(receipt);
  assert.deepEqual(refused.invalidations.map((item) => item.code), ["proof-failed"]);
  assert.match(refused.observation ?? "", /SIGSEGV/);
  assert.equal("result" in refused, false, "an invalidated receipt has no conclusion to read");
  assert.throws(() => requireProven(receipt), /did not count/);

  assert.equal(refused.derivative.destroyed, true);
  assert.equal(existsSync(derivativeRoot), false);
  assert.deepEqual(refused.candidateDifferences, []);
  assert.equal(await readFile(join(root, "src/board.ts"), "utf8"), CANDIDATE_SOURCE);
  assert.equal(refused.candidateAfter!.digest, before.digest);
});

test("failure case 5: a derivative that cannot be destroyed fails the proof closed and records where the bytes are", async (t) => {
  // Real permission failure, not a stubbed one: the proof removes write
  // permission from its own container, so unlinking its contents genuinely
  // fails. Root ignores directory permissions, so there is no honest version of
  // this case for a root user and it is skipped loudly rather than silently.
  // GitHub Actions ubuntu-latest runs as uid 1001, so CI executes it.
  const uid = process.getuid?.();
  if (uid === 0) {
    t.skip("running as root (uid 0): directory permissions cannot make a removal fail, so this case cannot be executed honestly here");
    return;
  }

  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  let container = "";
  t.after(async () => {
    if (container) await chmod(container, 0o700).catch(() => undefined);
    await rm(reapRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);

  const receipt = await runDisposableProof<string>({
    candidateRoot: root,
    probe,
    factory,
    mutate: async (derivative) => {
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
    },
    proof: async (derivative) => {
      container = dirname(derivative.root);
      await chmod(container, 0o500);
      return "observed";
    },
  });

  const refused = invalidated(receipt);
  assert.deepEqual(refused.invalidations.map((item) => item.code), ["cleanup-failed"]);
  assert.equal("result" in refused, false);
  assert.equal(refused.derivative.destroyed, false);
  assert.equal(refused.derivative.residualPath, container, "the receipt names where the surviving mutated copy is");
  assert.equal(existsSync(container), true, "the residue is real, not asserted");

  // The candidate is still provably intact. Both halves are reported: the proof
  // does not count AND the artifact it was about is unchanged.
  assert.deepEqual(refused.candidateDifferences, []);
  assert.equal(refused.candidateAfter!.digest, before.digest);
  assert.equal(await readFile(join(root, "src/board.ts"), "utf8"), CANDIDATE_SOURCE);
});

test("a surviving derivative invalidates the proof on every uid and its residual is removed after inspection", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  let residualPath = "";
  t.after(async () => {
    if (residualPath) await rm(residualPath, { recursive: true, force: true });
    await rm(reapRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const probe = new GitCandidateIdentityProbe();
  const baseFactory = new TempDirectoryDerivativeFactory({ reapRoot });
  const factory = {
    id: "test:surviving-derivative",
    create: (candidate: Parameters<typeof baseFactory.create>[0]) => baseFactory.create(candidate),
    destroy: async (derivative: DisposableDerivative) => {
      // Keep the real temporary derivative on disk. This deterministic factory
      // seam exercises the same residual detection as a real removal failure,
      // without depending on uid-sensitive directory permissions.
      residualPath = dirname(derivative.root);
      throw new DerivativeCleanupError("deliberately left derivative for the portable cleanup proof", residualPath);
    },
    sweepAbandoned: () => baseFactory.sweepAbandoned(),
  };
  const before = await probe.pin(root);

  const receipt = await runDisposableProof<string>({
    candidateRoot: root,
    probe,
    factory,
    mutate: async (derivative) => {
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
    },
    proof: async (derivative) => readFile(derivative.resolve("src/board.ts"), "utf8"),
  });

  const refused = invalidated(receipt);
  assert.deepEqual(refused.invalidations.map((item) => item.code), ["cleanup-failed"]);
  assert.equal("result" in refused, false, "a surviving mutated copy cannot yield a proof result");
  assert.throws(() => requireProven(receipt), /cleanup-failed/);
  assert.equal(refused.derivative.destroyed, false);
  assert.equal(refused.derivative.residualPath, residualPath);
  assert.equal(existsSync(residualPath), true, "the residual is a real temporary directory");
  assert.equal(await readFile(join(residualPath, "root/src/board.ts"), "utf8"), CANARY_MUTATION);
  assert.deepEqual(refused.candidateDifferences, []);
  assert.equal(refused.candidateAfter!.digest, before.digest);
  assert.equal(await readFile(join(root, "src/board.ts"), "utf8"), CANDIDATE_SOURCE);

  // The deliberate leak is evidence only for this test. Remove it after
  // inspecting the receipt and verify the actual derivative is gone.
  await rm(residualPath, { recursive: true, force: true });
  assert.equal(existsSync(residualPath), false);
});

test("failure case 6: a candidate that changes mid-proof invalidates the receipt instead of reporting it", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });

  const receipt = await runDisposableProof<string>({
    candidateRoot: root,
    probe,
    factory,
    mutate: async (derivative) => {
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
    },
    proof: async () => {
      // The test reaches around the API on purpose: this is a CONCURRENT ACTOR,
      // not the proof. A rebase, another agent, an editor save. The machinery
      // cannot prevent it and must not pretend the proof still means anything.
      await writeFile(join(root, "src/board.ts"), "export const acceptable = false; // edited by someone else\n", "utf8");
      return "the gate failed under mutation";
    },
  });

  const refused = invalidated(receipt);
  assert.deepEqual(refused.invalidations.map((item) => item.code), ["candidate-drifted"]);
  assert.deepEqual(refused.candidateDifferences, ["digest"]);
  assert.equal("result" in refused, false, "the conclusion is about an artifact that no longer exists");
  assert.match(refused.invalidations[0]!.detail, /no longer exists/);
  assert.throws(() => requireProven(receipt), /candidate-drifted/);
});

test("failure case 6: a candidate whose HEAD moves mid-proof is invalidated too", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });

  const receipt = await runDisposableProof<string>({
    candidateRoot: root,
    probe,
    factory,
    proof: async () => {
      // An empty commit: HEAD moves, the tree does not, the working tree does not.
      git(root, ["-c", "user.email=other@example.com", "-c", "user.name=Other", "commit", "-q", "--allow-empty", "-m", "concurrent"]);
      return "observed";
    },
  });

  const refused = invalidated(receipt);
  assert.deepEqual(refused.candidateDifferences, ["head"]);
  assert.deepEqual(refused.invalidations.map((item) => item.code), ["candidate-drifted"]);
});

test("in-process cancellation invalidates the proof and still destroys the derivative", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const controller = new AbortController();
  let derivativeRoot = "";

  const receipt = await runDisposableProof<string>({
    candidateRoot: root,
    probe,
    factory,
    signal: controller.signal,
    mutate: async (derivative) => {
      derivativeRoot = derivative.root;
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
      controller.abort(new Error("operator cancelled"));
    },
    // Never settles. If cancellation waited for the proof, this test would hang.
    proof: () => new Promise<string>(() => undefined),
  });

  const refused = invalidated(receipt);
  assert.deepEqual(refused.invalidations.map((item) => item.code), ["proof-aborted"]);
  assert.equal(refused.derivative.destroyed, true);
  assert.equal(existsSync(derivativeRoot), false);
  assert.deepEqual(refused.candidateDifferences, []);
  assert.equal(await readFile(join(root, "src/board.ts"), "utf8"), CANDIDATE_SOURCE);
});

test("in-process timeout invalidates the proof and still destroys the derivative", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  let derivativeRoot = "";

  const receipt = await runDisposableProof<string>({
    candidateRoot: root,
    probe,
    factory,
    timeoutMs: 150,
    mutate: async (derivative) => {
      derivativeRoot = derivative.root;
      await derivative.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
    },
    proof: () => new Promise<string>(() => undefined),
  });

  const refused = invalidated(receipt);
  assert.deepEqual(refused.invalidations.map((item) => item.code), ["proof-aborted"]);
  assert.match(refused.observation ?? "", /cancelled/);
  assert.equal(existsSync(derivativeRoot), false);
  assert.deepEqual(refused.candidateDifferences, []);
});

test("the sweep reclaims a derivative whose owning process is gone, and never one whose owner is alive", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const before = await probe.pin(root);

  const live = new TempDirectoryDerivativeFactory({ reapRoot });
  const orphan = await live.create(before);
  await orphan.mutate("src/board.ts", CANARY_MUTATION, "RH-14 canary mutation");
  assert.equal(existsSync(orphan.root), true);

  // The owner of that lease is this process, which is alive.
  assert.deepEqual(await live.sweepAbandoned(), [], "a live owner's derivative is never reclaimed");
  assert.equal(existsSync(orphan.root), true);

  // Same reap root, read by a factory that reports every owner dead: exactly the
  // situation a later run finds after the previous run was killed.
  const afterCrash = new TempDirectoryDerivativeFactory({ reapRoot, processAlive: () => false });
  assert.deepEqual(await afterCrash.sweepAbandoned(), [orphan.root]);
  assert.equal(existsSync(orphan.root), false);
  assert.deepEqual(await afterCrash.sweepAbandoned(), [], "the sweep is idempotent");
});

test("a derivative created from a candidate that moves during creation is refused rather than proven against", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const stale = await probe.pin(root);
  await writeFile(join(root, "src/board.ts"), "export const acceptable = false; // moved\n", "utf8");

  await assert.rejects(() => factory.create(stale), /does not match the pinned candidate/);
});
