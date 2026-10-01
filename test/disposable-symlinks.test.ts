import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import {
  assertEverySymlinkResolvesInside,
  DerivativeLinkEscapeError,
  runDisposableProof,
  TempDirectoryDerivativeFactory,
  type DisposableDerivative,
  type DisposableProofReceipt,
} from "../src/disposable.js";
import { digestExecutionRoot } from "../src/workspace-digest.js";

/**
 * The eight falsifier cases from issue #72, executed against real candidates.
 *
 * The previous behaviour failed closed for ALL of them: `fs.cp` with
 * `dereference: false` rewrote every relative symlink into an absolute path
 * back into the source tree, so the digest check refused the copy. Correct,
 * but blind — a caller learned "derivative-unavailable: digest does not match"
 * and not which link was the problem, and candidates with perfectly safe
 * links could not be derived at all.
 *
 * The cases split three ways here:
 *
 *   - ACCEPTED (1, 2, 3, 5): the link kernel-resolves inside the derivative.
 *     For each, the test proves the landing point is inside the derivative
 *     root AND that writing through the link changes only derivative bytes —
 *     the candidate file is re-read after the write and shown unchanged.
 *   - REFUSED (4, 6, 7): the link resolves outside, is absolute, or is
 *     broken. Each refusal must name the exact offending link, and the
 *     candidate must be unchanged afterwards.
 *   - DRIFTED (8): the candidate moves during derivation. This is the
 *     pre-existing digest-equality gate doing its job; executed here because
 *     the brief for #72 names it, and because a verbatim link copy must not
 *     weaken it: if the candidate changes mid-copy the digest still refuses.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A git candidate with one file at `pkg/bin.js`, committed. */
async function makeCandidate(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rh72-link-cand-")));
  await mkdir(join(root, "pkg"), { recursive: true });
  await writeFile(join(root, "pkg", "bin.js"), "console.log('authoritative')\n", "utf8");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=proof@example.com", "-c", "user.name=Proof", "commit", "-q", "-m", "base"]);
  return root;
}

async function makeReapRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "rh72-link-reap-")));
}

/** The candidate's committed content, re-read from disk. */
async function candidateBytes(root: string): Promise<string> {
  return readFile(join(root, "pkg", "bin.js"), "utf8");
}

/** Assert a receipt is invalidated, and narrow it so the absent result is visible to the compiler. */
function invalidated<T>(receipt: DisposableProofReceipt<T>): Extract<DisposableProofReceipt<T>, { outcome: "invalidated" }> {
  assert.equal(receipt.outcome, "invalidated");
  return receipt as Extract<DisposableProofReceipt<T>, { outcome: "invalidated" }>;
}

/**
 * The shared ACCEPTED proof: run a disposable proof whose mutation writes
 * through the derivative's symlink, and prove both halves of the brief —
 * the link never resolves into the candidate, and the write through it
 * changed only derivative bytes.
 */
async function proveAccepted(
  t: test.TestContext,
  build: (root: string) => Promise<{ linkRel: string; description: string }>,
): Promise<void> {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const { linkRel, description } = await build(root);
  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);
  const authoritativeBytes = await candidateBytes(root);

  const observed: { value: { landing: string; derivativeRoot: string; throughLink: string } | null } = { value: null };

  const receipt = await runDisposableProof({
    candidateRoot: root,
    probe,
    factory,
    mutate: async (derivative: DisposableDerivative) => {
      // Write THROUGH the link. If the link pointed into the candidate, this
      // is the line that would damage the authoritative artifact.
      await derivative.mutate(linkRel, "console.log('mutated through the link')\n", description);
    },
    proof: async (derivative: DisposableDerivative) => {
      observed.value = {
        landing: await realpath(join(derivative.root, linkRel)),
        derivativeRoot: derivative.root,
        throughLink: await readFile(join(derivative.root, linkRel), "utf8"),
      };
      return observed.value;
    },
  });

  assert.equal(receipt.outcome, "proven", `the derivation must be accepted (${description})`);
  const observation = observed.value;
  assert.ok(observation, "the proof ran");
  // Half 1: the link resolves inside the derivative root, never into the candidate.
  assert.equal(
    observation.landing === observation.derivativeRoot || observation.landing.startsWith(observation.derivativeRoot + "/"),
    true,
    `${description}: the link must resolve inside the derivative root`,
  );
  // Half 2: the write through the link changed only derivative bytes.
  assert.equal(observation.throughLink, "console.log('mutated through the link')\n", "the write went through the link");
  assert.equal(await candidateBytes(root), authoritativeBytes, `${description}: the candidate's bytes are unchanged`);
  assert.deepEqual(receipt.candidateDifferences, [], `${description}: the candidate's identity is unchanged`);
  assert.equal(receipt.candidateAfter!.head, before.head);
  assert.equal(receipt.candidateAfter!.digest, before.digest);
}

/**
 * The shared REFUSED proof: run a disposable proof against a candidate whose
 * link cannot be safely represented, and prove both halves of the brief —
 * the refusal names the exact offending link, and the candidate is unchanged.
 */
async function proveRefused(
  t: test.TestContext,
  build: (root: string) => Promise<{ linkRel: string; description: string }>,
  expectedDetail: RegExp,
): Promise<void> {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  const { linkRel, description } = await build(root);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=proof@example.com", "-c", "user.name=Proof", "commit", "-q", "-m", "links"]);

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);
  const authoritativeBytes = await candidateBytes(root);
  const proofRan = { value: false };

  const receipt = await runDisposableProof({
    candidateRoot: root,
    probe,
    factory,
    proof: async () => {
      proofRan.value = true;
      return "the proof must not run";
    },
  });

  const refused = invalidated(receipt);
  assert.equal(proofRan.value, false, `${description}: a refused derivation must not reach the proof`);
  assert.deepEqual(refused.candidateDifferences, [], `${description}: the candidate's identity is unchanged`);
  assert.equal(await candidateBytes(root), authoritativeBytes, `${description}: the candidate's bytes are unchanged`);
  assert.equal(refused.candidateAfter!.head, before.head);
  assert.equal(refused.candidateAfter!.digest, before.digest);

  // The refusal must name why, with the exact offending path — not a generic
  // digest mismatch. `derivative-unavailable` is the code; the detail carries
  // the typed error naming the link.
  const unavailable = refused.invalidations.find((item) => item.code === "derivative-unavailable");
  assert.ok(unavailable, `${description}: the refusal must be derivative-unavailable`);
  assert.match(
    unavailable.detail,
    expectedDetail,
    `${description}: the refusal must name the exact offending link`,
  );
  assert.match(unavailable.detail, new RegExp(linkRel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the offending path is named");
}

// ---------------------------------------------------------------------------
// Cases 1-3, 5: ACCEPTED. The link kernel-resolves inside the derivative.
// ---------------------------------------------------------------------------

test("case 1 ACCEPTED: an ordinary relative symlink pointing inside the tree is derived faithfully", async (t) => {
  await proveAccepted(t, async (root) => {
    await mkdir(join(root, "bin"), { recursive: true });
    await symlink("../pkg/bin.js", join(root, "bin", "tool"));
    return { linkRel: "bin/tool", description: "ordinary relative link" };
  });
});

test("case 2 ACCEPTED: a nested relative symlink is derived faithfully", async (t) => {
  await proveAccepted(t, async (root) => {
    await mkdir(join(root, "pkg", "deep"), { recursive: true });
    await mkdir(join(root, "bin", "nested"), { recursive: true });
    await symlink("../../pkg/bin.js", join(root, "bin", "nested", "tool"));
    return { linkRel: "bin/nested/tool", description: "nested relative link" };
  });
});

test("case 3 ACCEPTED: a ../-traversal symlink whose resolution stays inside the tree is derived faithfully", async (t) => {
  await proveAccepted(t, async (root) => {
    await mkdir(join(root, "pkg", "inner"), { recursive: true });
    await symlink("../../pkg/bin.js", join(root, "pkg", "inner", "up-and-back"));
    return { linkRel: "pkg/inner/up-and-back", description: "traversal link that resolves inside" };
  });
});

test("case 5 ACCEPTED: a chain of two relative symlinks whose endpoint stays inside the tree is derived faithfully", async (t) => {
  await proveAccepted(t, async (root) => {
    await mkdir(join(root, "bin"), { recursive: true });
    await symlink("../pkg/bin.js", join(root, "bin", "endpoint"));
    await symlink("endpoint", join(root, "bin", "via"));
    return { linkRel: "bin/via", description: "two-link chain" };
  });
});

// ---------------------------------------------------------------------------
// Cases 4, 6, 7: REFUSED. The refusal names the offending link.
// ---------------------------------------------------------------------------

test("case 4 REFUSED: a symlink resolving outside the candidate is refused with the offending link named", async (t) => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "rh72-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await proveRefused(
    t,
    async (root) => {
      await symlink(join(outside, "hostage.txt"), join(root, "escape"));
      return { linkRel: "escape", description: "absolute link outside" };
    },
    /absolute target/,
  );
});

test("case 4b REFUSED: a relative symlink that escapes the candidate root is refused with the offending link named", async (t) => {
  // Target `..`: in the candidate it resolves to the candidate's parent —
  // outside the candidate. In the derivative it resolves to the derivative's
  // own container (which exists, holding the lease), so the kernel witnesses
  // a resolution outside the derivative root and the refusal names it.
  await proveRefused(
    t,
    async (root) => {
      await symlink("..", join(root, "climb"));
      return { linkRel: "climb", description: "relative link escaping the root" };
    },
    /outside the derivative root/,
  );
});

test("case 6 REFUSED: an absolute symlink is refused even when it points inside the candidate", async (t) => {
  await proveRefused(
    t,
    async (root) => {
      // Absolute, and today it lands inside the candidate. Still refused: an
      // absolute target's resolution is a function of filesystem state the
      // derivative does not own, so containment is not provable even when it
      // happens to hold right now.
      await symlink(join(root, "pkg", "bin.js"), join(root, "self-absolute"));
      return { linkRel: "self-absolute", description: "absolute link pointing inside" };
    },
    /absolute target/,
  );
});

test("case 7 REFUSED: a broken symlink is refused with the offending link named", async (t) => {
  await proveRefused(
    t,
    async (root) => {
      await symlink("pkg/does-not-exist.js", join(root, "broken"));
      return { linkRel: "broken", description: "broken link" };
    },
    /broken/,
  );
});

test("a cyclic symlink is refused with the offending link named", async (t) => {
  await proveRefused(
    t,
    async (root) => {
      await symlink("loop-b", join(root, "loop-a"));
      await symlink("loop-a", join(root, "loop-b"));
      return { linkRel: "loop-a", description: "cyclic links" };
    },
    /cannot be resolved by the kernel/,
  );
});

// ---------------------------------------------------------------------------
// Case 8: DRIFT. The candidate moves during derivation.
// ---------------------------------------------------------------------------

test("case 8 DRIFTED: a candidate that changes during derivation is refused, not derived", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  await mkdir(join(root, "bin"), { recursive: true });
  await symlink("../pkg/bin.js", join(root, "bin", "tool"));
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=proof@example.com", "-c", "user.name=Proof", "commit", "-q", "-m", "links"]);

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);

  const receipt = await runDisposableProof({
    candidateRoot: root,
    probe,
    factory,
    // A concurrent actor edits the candidate while the derivation is being
    // asked for. The digest-equality gate must refuse: the derivative would
    // describe an artifact that no longer exists.
    mutate: async (derivative: DisposableDerivative) => {
      await derivative.mutate("pkg/bin.js", "console.log('in-derivative')\n", "legitimate derivative mutation");
      await writeFile(join(root, "pkg", "bin.js"), "console.log('moved mid-derivation')\n", "utf8");
    },
    proof: async () => "observed against the derivative",
  });

  const refused = invalidated(receipt);
  // The proof callback runs (the machinery cannot stop a concurrent actor);
  // what it must NOT do is count. The receipt has no result to read.
  assert.equal("result" in refused, false, "a drifted proof has no conclusion to read");
  assert.deepEqual(refused.candidateDifferences, ["digest"], "the drift is the concurrent actor's edit");
  assert.notEqual(refused.candidateAfter!.digest, before.digest);
  assert.ok(
    refused.invalidations.some((item) => item.code === "candidate-drifted"),
    "the receipt invalidates on drift",
  );
});

// ---------------------------------------------------------------------------
// The unit gate: assertEverySymlinkResolvesInside, and the shapes that make a
// weaker check fail open.
// ---------------------------------------------------------------------------

test("assertEverySymlinkResolvesInside: a lexical check would pass a link the kernel resolves outside — the kernel check refuses it", async (t) => {
  // This is the shape that decides the design. `a -> ../other` is a link
  // whose lexical resolution is inside the root, and `L -> a/../../escaped`
  // is LEXICALLY inside too (resolve normalises the dots before any link is
  // consulted). The kernel resolves L by following `a` FIRST, so its `..`
  // climbs out of the root and lands outside. A containment rule that
  // computed resolution itself would have to reimplement exactly this order;
  // the kernel check has no such gap because the kernel IS the witness.
  const container = await mkdtemp(join(tmpdir(), "rh72-lex-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "root");
  await mkdir(join(root, "deep"), { recursive: true });
  await mkdir(join(root, "other"), { recursive: true });
  await writeFile(join(container, "escaped"), "AUTHORITATIVE BYTES\n", "utf8");
  await symlink("../other", join(root, "deep", "a"));
  await symlink("a/../../escaped", join(root, "deep", "L"));
  const realContainer = await realpath(container);

  await assert.rejects(
    () => assertEverySymlinkResolvesInside(root),
    (error: unknown) => {
      assert.ok(error instanceof DerivativeLinkEscapeError, "the refusal is typed");
      assert.equal(error.linkPath, "deep/L", "the exact offending link is named");
      assert.equal(error.linkTarget, "a/../../escaped");
      assert.equal(error.resolved, join(realContainer, "escaped"), "the refusal shows where the link actually landed");
      return true;
    },
  );
});

test("assertEverySymlinkResolvesInside: accepts a tree whose links all kernel-resolve inside, including a link to the root itself", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "rh72-ok-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "root");
  await mkdir(join(root, "a"), { recursive: true });
  await mkdir(join(root, "b"), { recursive: true });
  await writeFile(join(root, "b", "real.txt"), "x\n", "utf8");
  await symlink("../b", join(root, "a", "l"));
  await symlink(".", join(root, "self"));
  await symlink("..", join(root, "a", "parent"));
  await assert.doesNotReject(() => assertEverySymlinkResolvesInside(root));
});

test("assertEverySymlinkResolvesInside: refuses an absolute link, a broken link and an escaping link, naming each", async (t) => {
  const container = await mkdtemp(join(tmpdir(), "rh72-bad-"));
  t.after(() => rm(container, { recursive: true, force: true }));

  // `../escaped` from the tree lands in the container, which exists: the
  // kernel witnesses a resolution outside the tree.
  await writeFile(join(container, "escaped"), "outside bytes\n", "utf8");

  const cases: Array<{ name: string; target: (tree: string) => string; match: RegExp; targetText: string }> = [
    // Absolute, landing outside: the kernel could witness the escape.
    { name: "abs", target: () => "/etc/hosts", match: /absolute target/, targetText: "/etc/hosts" },
    // Absolute, landing INSIDE the tree. Nothing but the absolute-target rule
    // refuses this: the kernel resolves it to a contained file. It is refused
    // because the resolution is a function of absolute path state the
    // derivative does not own — move the tree and the link silently points
    // somewhere else.
    { name: "abs-inside", target: (tree) => join(tree, "pkg", "bin.js"), match: /absolute target/, targetText: "<absolute path inside the tree>" },
    { name: "broken", target: () => "pkg/missing.js", match: /broken/, targetText: "pkg/missing.js" },
    { name: "climb", target: () => "../escaped", match: /outside the derivative root/, targetText: "../escaped" },
  ];
  for (const { name, target, match, targetText } of cases) {
    const tree = join(container, `tree-${name}`);
    await mkdir(join(tree, "pkg"), { recursive: true });
    await writeFile(join(tree, "pkg", "bin.js"), "x\n", "utf8");
    const linkTarget = target(tree);
    await symlink(linkTarget, join(tree, name));
    await assert.rejects(
      () => assertEverySymlinkResolvesInside(tree),
      (error: unknown) => {
        assert.ok(error instanceof DerivativeLinkEscapeError, `${name}: the refusal is typed`);
        assert.equal(error.linkPath, name, `${name}: the exact offending link is named`);
        assert.equal(error.linkTarget, linkTarget, `${name}: the target is reported (${targetText})`);
        assert.match(error.message, match, `${name}: the refusal names why`);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Faithfulness: the copy must preserve link target strings verbatim.
// ---------------------------------------------------------------------------

test("the copy preserves symlink target strings verbatim, so the digest proves faithfulness", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  await mkdir(join(root, "bin"), { recursive: true });
  await symlink("../pkg/bin.js", join(root, "bin", "tool"));
  await symlink("tool", join(root, "bin", "via"));
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.email=proof@example.com", "-c", "user.name=Proof", "commit", "-q", "-m", "links"]);

  const probe = new GitCandidateIdentityProbe();
  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  const before = await probe.pin(root);
  const derivative = await factory.create(before);
  t.after(() => factory.destroy(derivative).catch(() => undefined));

  // Not rewritten into an absolute path back into the candidate — the exact
  // defect the issue was filed over.
  assert.equal(await readlink(join(derivative.root, "bin", "tool")), "../pkg/bin.js");
  assert.equal(await readlink(join(derivative.root, "bin", "via")), "tool");

  // And the derivative's digest matches the pin, which is only possible
  // because the digest hashes link targets as content and the copy preserved
  // them verbatim.
  assert.equal(derivative.baselineDigest, before.digest);
});

test("createFromRoot refuses a source with an unsafe link with the link named, and the typed error escapes for direct callers", async (t) => {
  const root = await makeCandidate();
  const reapRoot = await makeReapRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(reapRoot, { recursive: true, force: true }));

  await symlink("/etc/hosts", join(root, "escape"));
  const identity = await digestExecutionRoot(root);

  const factory = new TempDirectoryDerivativeFactory({ reapRoot });
  await assert.rejects(
    () => factory.createFromRoot({
      sourceRoot: root,
      expectedDigest: identity.digest,
      expectedFileCount: identity.scope.fileCount,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DerivativeLinkEscapeError);
      assert.equal(error.linkPath, "escape");
      return true;
    },
  );

  // A refused derivation leaves nothing behind: the container is removed, so
  // the refusal cannot litter the reap root with half-derivatives.
  const residue = (await readdir(reapRoot)).filter((entry) => entry.startsWith("derivative-"));
  assert.deepEqual(residue, [], "a refused derivation leaves no container behind");
  assert.equal(existsSync(join(reapRoot, "derivative-")), false);
});
