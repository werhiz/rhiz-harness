import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { TimestampSchema } from "./schemas.js";
import {
  DigestScopeSchema,
  digestExecutionRoot,
  type ExecutionRootDigestLimits,
} from "./workspace-digest.js";

/**
 * Why this module exists.
 *
 * A falsifier has to break something to be worth anything. Every mutation test,
 * negative control and proof-by-perturbation in this Harness works by making the
 * candidate wrong on purpose and watching a check notice. That makes the
 * proof machinery the one part of the system whose *job* is to write damage.
 *
 * On 2026-08-20, during the RH-14 canary, it wrote that damage into the real
 * candidate worktree. A worker mutated `src/board.ts` to `const acceptable =
 * true`, stalled, and was killed. The mutation stayed. The ordinary suite stayed
 * green on the mutated tree, so the only thing standing between that tree and a
 * commit was somebody noticing. See issue #63.
 *
 * The protocol that would have prevented it already existed, written down:
 * clone, mutate the clone, prove, destroy, re-check. It was prose. A worker
 * that crashes does not execute prose.
 *
 * So this module makes the protocol machinery, and it is built around one
 * sentence:
 *
 *   A proof operation must be PHYSICALLY INCAPABLE of leaving modified bytes in
 *   the authoritative candidate.
 *
 * "Physically" rules out the obvious design. A `finally` that restores the file
 * is not a boundary: SIGKILL does not run `finally`, and neither does a stalled
 * model. Anything whose safety depends on the proof behaving is compliance
 * wearing a boundary's clothes.
 *
 * Five mechanisms carry that sentence, and each one holds when the caller is
 * careless, crashed, or hostile:
 *
 *   1. **The candidate is not addressable.** `runDisposableProof` hands the
 *      mutation and the proof a `DisposableDerivative` and nothing else. The
 *      candidate's path is never passed to either callback, and the derivative's
 *      only write API resolves through `DisposableDerivative.resolve`, which
 *      refuses any path that lands outside the derivative root.
 *   2. **The derivative is provably elsewhere.** `assertDerivativeIsOutside`
 *      realpaths both roots and refuses containment in either direction, so a
 *      factory cannot hand back `<candidate>/.tmp` and turn every mutation into
 *      a write to the thing being judged.
 *   3. **A crash cannot write what was never writable.** Because 1 and 2 hold
 *      for the whole lifetime of the proof, killing the process at any instant
 *      leaves the candidate untouched: no code path to it existed. What a crash
 *      *can* leave is an orphaned derivative, so every derivative records a
 *      lease naming its owner pid before its first byte exists, and
 *      `sweepAbandoned` reclaims the ones whose owner is gone.
 *   4. **The conclusion fails closed.** The candidate's identity is pinned
 *      before and recomputed after at content level, and a receipt that cannot
 *      prove equality is `invalidated` — a shape that has no `result` field to
 *      read.
 *   5. **The derivative's own links stay inside it (#72).** A candidate may
 *      contain relative symlinks; the copy preserves their target strings
 *      verbatim and every link must kernel-resolve inside the derivative root
 *      or the derivation is refused with the offending link named. A link
 *      whose landing the kernel cannot witness — absolute, broken, cyclic —
 *      is refused rather than guessed at, because a containment proof that is
 *      clever is a containment proof that will eventually be wrong.
 *
 * Point 4 is what makes the guarantee survive a mechanism the first three miss.
 * The invariant this module ships is therefore: the candidate is unchanged, OR
 * the proof does not count.
 */

const text = z.string().trim().min(1);
const identifier = text.max(200);
const absolutePathText = text.max(4096).refine((value) => isAbsolute(value), "must be an absolute path");
const contentDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be a sha256 content digest");

/**
 * A git object id, or the literal `unborn` for a repository with no commit yet.
 *
 * `unborn` is a value rather than an absent field on purpose: two unborn
 * repositories compare equal on `head`, which is correct, and a field that can
 * go missing would compare equal by being missing on both sides for reasons a
 * reader cannot see.
 */
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|unborn)$/, "must be a git object id or \"unborn\"");

/**
 * Content-level identity of an authoritative candidate.
 *
 * All three of these are recorded because each is blind to something the others
 * see, and the RH-14 mutation was invisible to two of them:
 *
 *   - `head` moves on commit, and not on an uncommitted edit.
 *   - `tree` is the committed content, so it distinguishes an amend from a
 *     reword — and, like `head`, it did not move when `src/board.ts` was
 *     mutated in the working tree.
 *   - `digest` is the bytes that will actually execute, `.gitignore` and all.
 *     It is the only one of the three that saw the mutation.
 *
 * A timestamp is deliberately NOT identity. "I observed it at 12:04 and did not
 * touch it" is the assertion this module exists to stop accepting.
 */
export const CandidateIdentitySchema = z.object({
  /** Realpath-resolved root of the authoritative candidate. */
  executionRoot: absolutePathText,
  head: objectId,
  tree: objectId,
  digest: contentDigest,
  /** What the digest covers, so a receipt can never imply more coverage than it has. */
  digestScope: DigestScopeSchema,
  observedAt: TimestampSchema,
}).strict();
export type CandidateIdentity = z.infer<typeof CandidateIdentitySchema>;

export const AppliedMutationSchema = z.object({
  /** Path relative to the derivative root, POSIX separators. */
  path: text.max(4096),
  description: text.max(500),
  bytes: z.number().int().nonnegative(),
  /** Digest of the bytes written, so a receipt names the mutation and not merely its intent. */
  digest: contentDigest,
}).strict();
export type AppliedMutation = z.infer<typeof AppliedMutationSchema>;

export const DerivativeRecordSchema = z.object({
  derivativeId: identifier,
  factoryId: identifier,
  root: absolutePathText,
  /** Content identity of the derivative at creation, before any mutation. */
  digest: contentDigest,
  /** True only when the factory proved every byte is gone. */
  destroyed: z.boolean(),
  /**
   * Where the surviving bytes are when `destroyed` is false. Recorded rather
   * than logged: a residual mutated copy of the candidate is a thing somebody
   * has to go and remove, and a receipt that knows about it and does not say
   * where is not much better than one that never noticed.
   */
  residualPath: absolutePathText.nullable(),
}).strict();
export type DerivativeRecord = z.infer<typeof DerivativeRecordSchema>;

/**
 * Why a proof did not count. Every code is a refusal, never a downgrade: there
 * is no partial credit shape in this module.
 */
export const InvalidationCodeSchema = z.enum([
  /** The candidate's identity moved between the pin and the recheck. */
  "candidate-drifted",
  /** The candidate's identity could not be recomputed, so equality is unknown. */
  "candidate-unreadable",
  /** The derivative could not be created, or was not a faithful copy of the pin. */
  "derivative-unavailable",
  /** The mutation could not be applied inside the derivative. */
  "mutation-failed",
  /** The proof threw instead of returning an observation. */
  "proof-failed",
  /** The proof was cancelled or timed out before it returned. */
  "proof-aborted",
  /** The derivative survived destruction. */
  "cleanup-failed",
]);
export type InvalidationCode = z.infer<typeof InvalidationCodeSchema>;

export const InvalidationSchema = z.object({
  code: InvalidationCodeSchema,
  detail: text.max(2000),
}).strict();
export type Invalidation = z.infer<typeof InvalidationSchema>;

/** Receipt fields that do not depend on what the proof returned. */
export const DisposableProofEnvelopeSchema = z.object({
  schema: z.literal("rhiz/disposable-proof-receipt/v1"),
  proofId: identifier,
  factoryId: identifier,
  probeId: identifier,
  candidateBefore: CandidateIdentitySchema,
  candidateAfter: CandidateIdentitySchema.nullable(),
  /** Fields of the identity that moved. Empty when equality was proven. */
  candidateDifferences: z.array(text.max(100)),
  derivative: DerivativeRecordSchema,
  mutations: z.array(AppliedMutationSchema),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
}).strict();
export type DisposableProofEnvelope = z.infer<typeof DisposableProofEnvelopeSchema>;

/**
 * The receipt.
 *
 * This is a discriminated union rather than one shape with a status field, and
 * that is the point: on the `invalidated` branch there is no `result` property
 * at all. A consumer cannot read the proof's conclusion off a receipt that could
 * not establish the candidate was intact, because the conclusion is not there to
 * read. Issue #63 asks that a stale proof "be invalidated, not reported"; a
 * status flag would have left the value sitting next to the flag, one careless
 * destructure away from being reported anyway.
 *
 * `observation` on the invalidated branch is a bounded diagnostic string, never
 * the typed result, for the same reason.
 */
export type DisposableProofReceipt<T> =
  | (DisposableProofEnvelope & { outcome: "proven"; result: T })
  | (DisposableProofEnvelope & {
      outcome: "invalidated";
      invalidations: readonly Invalidation[];
      observation: string | null;
    });

export class DerivativeEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivativeEscapeError";
  }
}

export class DerivativeContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivativeContainmentError";
  }
}

export class DerivativeCleanupError extends Error {
  readonly residualPath: string;
  constructor(message: string, residualPath: string) {
    super(message);
    this.name = "DerivativeCleanupError";
    this.residualPath = residualPath;
  }
}

/**
 * A candidate contained a symlink the derivative cannot safely represent.
 *
 * #72. The refusal names the exact offending link so a caller learns why the
 * derivation failed instead of seeing a generic digest mismatch. `linkPath`
 * is relative to the derivative root with POSIX separators; `linkTarget` is
 * the verbatim target string; `resolved` is where the kernel actually landed
 * the link, when it landed anywhere.
 */
export class DerivativeLinkEscapeError extends Error {
  readonly linkPath: string;
  readonly linkTarget: string;
  /** Kernel resolution of the link, when it resolves. Null when broken, cyclic or otherwise unresolvable. */
  readonly resolved: string | null;
  constructor(message: string, linkPath: string, linkTarget: string, resolved: string | null = null) {
    super(message);
    this.name = "DerivativeLinkEscapeError";
    this.linkPath = linkPath;
    this.linkTarget = linkTarget;
    this.resolved = resolved;
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Prove the derivative is not the candidate and neither contains the other.
 *
 * Both paths are realpath'd first. Comparing the strings as given would be
 * defeated by a symlink, which is the one trick available to a factory that
 * wants its "isolated" copy to land inside the tree it is isolating from, and
 * it is exactly the trick nobody notices in review.
 *
 * Containment is refused in both directions. Derivative-inside-candidate is the
 * obvious hazard. Candidate-inside-derivative is the less obvious one: destroying
 * the derivative would then delete the candidate, which fails the invariant from
 * the other side.
 */
export async function assertDerivativeIsOutside(derivativeRoot: string, candidateRoot: string): Promise<void> {
  const derivative = await realpath(resolve(derivativeRoot));
  const candidate = await realpath(resolve(candidateRoot));
  if (derivative === candidate) {
    throw new DerivativeContainmentError(`derivative root ${derivative} IS the candidate root; a proof would mutate the artifact it is judging`);
  }
  if (contains(candidate, derivative)) {
    throw new DerivativeContainmentError(`derivative root ${derivative} is inside candidate ${candidate}; every mutation would land in the candidate`);
  }
  if (contains(derivative, candidate)) {
    throw new DerivativeContainmentError(`candidate root ${candidate} is inside derivative ${derivative}; destroying the derivative would destroy the candidate`);
  }
}

/**
 * Why symlinks get their own gate (#72).
 *
 * `fs.cp` with `dereference: false` does not preserve a relative symlink: it
 * rewrites the target into an absolute path back into the SOURCE tree. A
 * derivative carrying that link would hand every proof operation a path
 * straight into the authoritative candidate — the one thing this module
 * exists to make impossible. The digest check catches the rewrite (the
 * target string is hashed as content), which is why the machinery refused
 * every symlink-bearing candidate: fail closed, but blind to why.
 *
 * The fix copies link targets verbatim and then proves containment with the
 * kernel as the only witness:
 *
 *   1. The target must be RELATIVE. An absolute target resolves as a function
 *      of filesystem state outside the derivative — state no digest covers and
 *      no boundary controls — so it is refused even when it happens to land
 *      inside the derivative today.
 *   2. `realpath(link)` must resolve and land inside (or on) the derivative
 *      root. Realpath is the kernel's own resolution: it follows chains,
 *      applies `..` after links exactly as the kernel does, and detects
 *      cycles. Accepting on anything other than kernel truth is how a
 *      containment check fails open (a lexical check does: a link whose
 *      target mentions another link can be lexically inside and kernel
 *      outside — `test/disposable-symlinks.test.ts` executes that shape).
 *   3. A link that does not resolve (broken, cyclic, ENOTDIR) is refused.
 *      Where a broken link WOULD land once its target exists cannot be
 *      witnessed by the kernel, and computing it means reimplementing partial
 *      path resolution — exactly the kind of clever containment proof that
 *      eventually misses a case. Refused costs a proof; accepted-but-wrong
 *      costs the invariant.
 *
 * Why containment proven here holds for the derivative's whole lifetime: the
 * write surface (`DisposableDerivative.mutate`) can create files and
 * directories but never symlinks, and `writeFile` through an existing link
 * writes the link's target rather than replacing the link, so the link set is
 * frozen at creation. Nothing inside the derivative can change where a link
 * resolves; only a proof reaching around the API with direct `fs` calls can,
 * and a proof that does that could address the candidate by absolute path
 * anyway — the boundary this module draws is structural, not a sandbox.
 */
export async function assertEverySymlinkResolvesInside(root: string): Promise<void> {
  const realRoot = await realpath(root);
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      // lstat rather than the dirent type, for the same reason as the digest
      // walk: the same answer on every platform, without following anything.
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        await assertLinkResolvesInside(realRoot, root, absolutePath);
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(absolutePath);
      }
    }
  }
}

async function assertLinkResolvesInside(realRoot: string, root: string, absolutePath: string): Promise<void> {
  const relPath = relative(root, absolutePath).split(sep).join("/");
  const target = await readlink(absolutePath);

  if (isAbsolute(target)) {
    throw new DerivativeLinkEscapeError(
      `symlink ${relPath} -> ${target} has an absolute target; its resolution depends on filesystem state outside the derivative, which no digest covers`,
      relPath,
      target,
    );
  }

  let resolved: string | null = null;
  let unresolvable: string | null = null;
  try {
    resolved = await realpath(absolutePath);
  } catch (error) {
    unresolvable = (error as NodeJS.ErrnoException).code ?? String(error);
  }

  if (resolved !== null) {
    if (resolved !== realRoot && !contains(realRoot, resolved)) {
      throw new DerivativeLinkEscapeError(
        `symlink ${relPath} -> ${target} resolves to ${resolved}, outside the derivative root; a proof would hold a path out of the derivative`,
        relPath,
        target,
        resolved,
      );
    }
    return;
  }

  // The link does not resolve. Where it WOULD land once its target exists is
  // not something the kernel can witness, and computing it would mean
  // reimplementing partial path resolution. Refuse.
  throw new DerivativeLinkEscapeError(
    unresolvable === "ENOENT"
      ? `symlink ${relPath} -> ${target} is broken; where it would resolve once its target exists cannot be proven, so the derivative is refused`
      : `symlink ${relPath} -> ${target} cannot be resolved by the kernel (${unresolvable}); a link with no kernel witness of where it lands cannot be proven contained`,
    relPath,
    target,
  );
}

/**
 * The only handle a mutation or a proof is given.
 *
 * It carries the derivative root and no reference of any kind to the candidate.
 * That is the first of the four mechanisms: the callbacks cannot address the
 * candidate because they are never told where it is.
 */
export class DisposableDerivative {
  readonly derivativeId: string;
  readonly factoryId: string;
  /** Absolute derivative root. Proven outside the candidate before construction. */
  readonly root: string;
  /** Content identity at creation, before any mutation. */
  readonly baselineDigest: string;
  readonly #mutations: AppliedMutation[] = [];

  constructor(options: { derivativeId: string; factoryId: string; root: string; baselineDigest: string }) {
    this.derivativeId = identifier.parse(options.derivativeId);
    this.factoryId = identifier.parse(options.factoryId);
    this.root = absolutePathText.parse(options.root);
    this.baselineDigest = contentDigest.parse(options.baselineDigest);
  }

  /**
   * Resolve a path inside the derivative, or refuse.
   *
   * `resolve()` is the authority, not the string: `../../src/board.ts` and an
   * absolute path both normalise before the check, so neither reaches the
   * filesystem. This is what stops a careless proof from writing the RH-14
   * mutation straight back into the candidate by relative path.
   */
  resolve(relativePath: string): string {
    const resolved = resolve(this.root, relativePath);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new DerivativeEscapeError(
        `path ${relativePath} resolves to ${resolved}, outside derivative ${this.root}; a proof may only write inside its derivative`,
      );
    }
    return resolved;
  }

  /** Apply one mutation inside the derivative and record what was written. */
  async mutate(relativePath: string, content: string | Uint8Array, description: string): Promise<AppliedMutation> {
    const target = this.resolve(relativePath);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    const mutation = AppliedMutationSchema.parse({
      path: relative(this.root, target).split(sep).join("/"),
      description,
      bytes: bytes.byteLength,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    this.#mutations.push(mutation);
    return mutation;
  }

  get mutations(): readonly AppliedMutation[] {
    return [...this.#mutations];
  }
}

/** Produces the content-level identity of an authoritative candidate. */
export interface CandidateIdentityProbe {
  readonly id: string;
  pin(executionRoot: string): Promise<CandidateIdentity>;
}

/** Creates, destroys, and reclaims disposable derivatives. */
export interface DisposableWorkspaceFactory {
  readonly id: string;
  /** Create a derivative faithful to the pinned candidate, outside it. */
  create(candidate: CandidateIdentity): Promise<DisposableDerivative>;
  /** Destroy it completely. MUST throw `DerivativeCleanupError` if any byte survives. */
  destroy(derivative: DisposableDerivative): Promise<void>;
  /** Reclaim derivatives whose owning process is gone. Returns the roots reclaimed. */
  sweepAbandoned(): Promise<readonly string[]>;
}

const LeaseSchema = z.object({
  derivativeId: identifier,
  root: absolutePathText,
  candidateRoot: absolutePathText,
  ownerPid: z.number().int().positive(),
  createdAt: TimestampSchema,
}).strict();
type Lease = z.infer<typeof LeaseSchema>;

export interface TempDirectoryDerivativeFactoryOptions {
  /** Where derivatives and their leases live. Defaults under the OS temp directory. */
  reapRoot?: string;
  now?: () => string;
  idFactory?: () => string;
  digestLimits?: Partial<ExecutionRootDigestLimits>;
  /** Reports whether a pid is alive. Injectable so the sweep can be tested against a known-dead pid. */
  processAlive?: (pid: number) => boolean;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else. Only ESRCH
    // proves it is gone, and only that answer may license a removal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Derivatives as content copies under the OS temp directory.
 *
 * Two decisions worth stating.
 *
 * **`.git` is not copied.** In a git worktree `.git` is a *file* containing
 * `gitdir: <canonical>`. Copying it verbatim would leave the derivative pointing
 * at the real repository, so a proof that ran anything git-mutating would write
 * through to the candidate's repository from inside the copy that exists to
 * prevent exactly that. Excluding it also makes the derivative comparable to the
 * pin for free, because `digestExecutionRoot` excludes `.git` as well.
 *
 * **The lease is written before the copy.** A crash between "directory exists"
 * and "copy finished" still leaves a lease naming the owner, so the sweep can
 * find the partial derivative. Writing it afterwards would create a window whose
 * whole content is unreclaimable litter.
 */
export class TempDirectoryDerivativeFactory implements DisposableWorkspaceFactory {
  readonly id = "disposable:tempdir-content-copy";
  readonly reapRoot: string;
  readonly #now: () => string;
  readonly #idFactory: () => string;
  readonly #digestLimits: Partial<ExecutionRootDigestLimits>;
  readonly #processAlive: (pid: number) => boolean;
  readonly #containers = new Map<string, string>();

  constructor(options: TempDirectoryDerivativeFactoryOptions = {}) {
    this.reapRoot = resolve(options.reapRoot ?? join(tmpdir(), "rhiz-disposable-derivatives"));
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.#digestLimits = options.digestLimits ?? {};
    this.#processAlive = options.processAlive ?? defaultProcessAlive;
  }

  async create(rawCandidate: CandidateIdentity): Promise<DisposableDerivative> {
    const candidate = CandidateIdentitySchema.parse(rawCandidate);
    return this.createFromRoot({
      sourceRoot: candidate.executionRoot,
      expectedDigest: candidate.digest,
      expectedFileCount: candidate.digestScope.fileCount,
    });
  }

  /**
   * Create a derivative from a root that has been identified by content but not
   * by git.
   *
   * Verify's negative controls reach the same machinery through here. Their
   * notion of a base revision is a `CrewWorkspace` field that a provider may
   * fill with any string, so requiring a git object id would have meant either
   * weakening `CandidateIdentity` to accept one or keeping a second, softer copy
   * of this code. Both are worse than one primitive with two entry points.
   */
  async createFromRoot(options: {
    sourceRoot: string;
    /** Content digest the copy must reproduce exactly. */
    expectedDigest: string;
    /** File count of the source, used to bound the copy before it is made. */
    expectedFileCount: number;
  }): Promise<DisposableDerivative> {
    // `resolve` before the absolute-path check, not instead of it. A
    // `CrewWorkspace.executionRoot` is only constrained to be text, so a
    // relative one is schema-valid, and resolving it against cwd is exactly what
    // the `cp` this replaced already did. Refusing it outright would have been a
    // silent behaviour change on the Verify path; resolving it and THEN
    // requiring absolute keeps the old semantics and still gives the
    // containment check a path it can reason about.
    const sourceRoot = absolutePathText.parse(resolve(options.sourceRoot));
    const expectedDigest = contentDigest.parse(options.expectedDigest);
    await mkdir(this.reapRoot, { recursive: true });
    const container = await mkdtemp(join(this.reapRoot, "derivative-"));
    const derivativeId = `derivative:${this.#idFactory()}`;
    const root = join(container, "root");

    try {
      const lease: Lease = LeaseSchema.parse({
        derivativeId,
        root,
        candidateRoot: sourceRoot,
        ownerPid: process.pid,
        createdAt: this.#now(),
      });
      await writeFile(join(container, "lease.json"), `${JSON.stringify(lease)}\n`, "utf8");

      await mkdir(root, { recursive: true });
      await assertDerivativeIsOutside(root, sourceRoot);

      // dereference:false keeps links as links, so the copy has the same shape
      // as the thing it stands in for and cannot pull foreign bytes inward.
      // verbatimSymlinks:true preserves each link's target STRING: without it
      // fs.cp rewrites a relative target into an absolute path back into the
      // SOURCE tree (#72) — a path a proof could follow straight into the
      // authoritative candidate. With targets verbatim, the digest check
      // below (which hashes target strings) proves the copy faithful, and
      // assertEverySymlinkResolvesInside proves every link lands inside.
      await cp(sourceRoot, root, {
        recursive: true,
        dereference: false,
        // Preserve relative link text. Resolving it during copy changes the
        // content-level identity and makes a faithful derivative impossible.
        verbatimSymlinks: true,
        force: true,
        filter: (source) => basename(source) !== ".git",
      });

      const identity = await digestExecutionRoot(root, {
        limits: {
          ...this.#digestLimits,
          // The copy cannot legitimately exceed what the pin measured.
          maxFiles: Math.max(1, options.expectedFileCount + 1),
        },
      });
      if (identity.digest !== expectedDigest) {
        // Either the candidate moved while we copied it, or the copy is not
        // faithful. Both make every later conclusion about the wrong artifact.
        throw new Error(
          `derivative digest ${identity.digest} does not match the pinned candidate ${expectedDigest}; `
          + "the candidate changed during creation or the copy is not faithful",
        );
      }

      // The copy is faithful; now prove it is safe. Every symlink must
      // kernel-resolve inside the derivative root or the derivation is
      // refused with the offending link named. On refusal the container is
      // removed below and the typed error reaches the caller (through
      // runDisposableProof it becomes `derivative-unavailable` with the link
      // named in the detail).
      await assertEverySymlinkResolvesInside(root);

      this.#containers.set(derivativeId, container);
      return new DisposableDerivative({
        derivativeId,
        factoryId: this.id,
        root,
        baselineDigest: identity.digest,
      });
    } catch (error) {
      await rm(container, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async destroy(derivative: DisposableDerivative): Promise<void> {
    const container = this.#containers.get(derivative.derivativeId) ?? dirname(derivative.root);
    try {
      await rm(container, { recursive: true, force: true });
    } catch (error) {
      throw new DerivativeCleanupError(
        `derivative ${derivative.derivativeId} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
        container,
      );
    }
    // rm resolving without throwing is not proof that the bytes are gone. This
    // is the check that turns "cleanup was attempted" into "cleanup happened".
    if (existsSync(container)) {
      throw new DerivativeCleanupError(
        `derivative ${derivative.derivativeId} still exists at ${container} after removal`,
        container,
      );
    }
    this.#containers.delete(derivative.derivativeId);
  }

  /**
   * Reclaim derivatives whose owner is gone.
   *
   * This is the half of the guarantee a crashed process cannot provide for
   * itself. It never removes a derivative whose owner is alive, so pid reuse can
   * only cause litter to persist, never a live proof's workspace to vanish.
   */
  async sweepAbandoned(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.reapRoot);
    } catch {
      return [];
    }
    const reclaimed: string[] = [];
    for (const entry of entries.sort()) {
      const container = join(this.reapRoot, entry);
      let lease: Lease;
      try {
        lease = LeaseSchema.parse(JSON.parse(await readFile(join(container, "lease.json"), "utf8")));
      } catch {
        // No readable lease means no owner can be established. Leaving it is the
        // conservative answer: an unreadable lease is not evidence of death.
        continue;
      }
      if (this.#processAlive(lease.ownerPid)) continue;
      await rm(container, { recursive: true, force: true }).catch(() => undefined);
      if (!existsSync(container)) reclaimed.push(lease.root);
    }
    return reclaimed;
  }
}

export interface DisposableProofRequest<T> {
  /** Root of the authoritative candidate. Never passed to either callback. */
  candidateRoot: string;
  probe: CandidateIdentityProbe;
  factory: DisposableWorkspaceFactory;
  /** Applies the mutation. Receives the derivative and nothing else. */
  mutate?: (derivative: DisposableDerivative) => Promise<void>;
  /** The declared proof. Receives the derivative and nothing else. */
  proof: (derivative: DisposableDerivative) => Promise<T>;
  /** Cancellation. An abort invalidates the proof; it never downgrades it. */
  signal?: AbortSignal;
  /** Wall-clock bound on mutate + proof. */
  timeoutMs?: number;
  now?: () => string;
  idFactory?: () => string;
}

function describe(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 2000);
}

class ProofAbortedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProofAbortedError";
  }
}

/**
 * Race a proof against cancellation.
 *
 * The pending promise is NOT awaited once the abort wins. A proof that hangs
 * hangs forever by definition, and waiting for it would make the timeout a
 * suggestion. The orphan gets a no-op catch so a later rejection from a proof
 * nobody is listening to cannot take the process down.
 */
async function withCancellation<T>(work: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<T> {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return work;

  const combined = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  if (combined.aborted) {
    work.catch(() => undefined);
    throw new ProofAbortedError("proof was cancelled before it started");
  }
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      work.catch(() => undefined);
      rejectPromise(new ProofAbortedError(
        combined.reason instanceof Error ? `proof was cancelled: ${combined.reason.message}` : "proof was cancelled",
      ));
    };
    combined.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { combined.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error) => { combined.removeEventListener("abort", onAbort); rejectPromise(error); },
    );
  });
}

/**
 * Run one proof through the full disposable lifecycle.
 *
 *   candidate pinned
 *     -> disposable derivative created
 *       -> mutation applied ONLY there
 *         -> declared proof executed
 *           -> actual result recorded
 *         -> derivative destroyed
 *     -> candidate identity recomputed
 *   -> equality mechanically proven
 *
 * The order is not cosmetic. Destruction happens before the recheck so that a
 * derivative which refuses to die is itself part of what the recheck reports on,
 * and the recheck happens last so nothing in the lifecycle can run after the
 * identity that the receipt attests to.
 *
 * Every path AFTER the candidate is pinned returns a receipt, because a caller
 * that has to wrap this in try/catch to learn whether the candidate survived is
 * a caller that can forget to.
 *
 * The initial pin is the single exception and throws. Without it there is no
 * `candidateBefore`, so there is no identity to attest to and no receipt worth
 * making — and a receipt that reported an unpinnable candidate would be
 * asserting something about an artifact it never saw.
 */
export async function runDisposableProof<T>(request: DisposableProofRequest<T>): Promise<DisposableProofReceipt<T>> {
  const now = request.now ?? (() => new Date().toISOString());
  const idFactory = request.idFactory ?? (() => globalThis.crypto.randomUUID());
  const proofId = `proof:${idFactory()}`;
  const startedAt = now();

  const before = CandidateIdentitySchema.parse(await request.probe.pin(request.candidateRoot));

  const invalidations: Invalidation[] = [];
  let derivative: DisposableDerivative | null = null;
  let observation: string | null = null;
  let result: { value: T } | null = null;
  let residualPath: string | null = null;
  let destroyed = false;

  try {
    derivative = await request.factory.create(before);
  } catch (error) {
    invalidations.push({ code: "derivative-unavailable", detail: describe(error) });
  }

  if (derivative !== null) {
    try {
      await withCancellation(
        (async () => {
          if (request.mutate) {
            try {
              await request.mutate(derivative!);
            } catch (error) {
              throw Object.assign(new Error(describe(error)), { rhizPhase: "mutation" as const });
            }
          }
          return await request.proof(derivative!);
        })(),
        request.signal,
        request.timeoutMs,
      ).then((value) => { result = { value }; });
    } catch (error) {
      if (error instanceof ProofAbortedError) {
        invalidations.push({ code: "proof-aborted", detail: describe(error) });
      } else if ((error as { rhizPhase?: string }).rhizPhase === "mutation") {
        invalidations.push({ code: "mutation-failed", detail: describe(error) });
      } else {
        invalidations.push({ code: "proof-failed", detail: describe(error) });
      }
      observation = describe(error);
    }

    // Destruction is attempted on every path, including the ones that already
    // failed. A proof that gave up still has a mutated copy of the candidate on
    // disk, and that copy is the thing this module promises to remove.
    try {
      await request.factory.destroy(derivative);
      destroyed = true;
    } catch (error) {
      residualPath = error instanceof DerivativeCleanupError ? error.residualPath : derivative.root;
      invalidations.push({ code: "cleanup-failed", detail: describe(error) });
    }
  }

  let after: CandidateIdentity | null = null;
  try {
    after = CandidateIdentitySchema.parse(await request.probe.pin(request.candidateRoot));
  } catch (error) {
    invalidations.push({ code: "candidate-unreadable", detail: describe(error) });
  }

  const differences = after === null ? [] : candidateIdentityDifferences(before, after);
  if (differences.length > 0) {
    invalidations.push({
      code: "candidate-drifted",
      detail:
        `the authoritative candidate changed during the proof (${differences.join(", ")}); `
        + "this proof's conclusion is about an artifact that no longer exists",
    });
  }

  const envelope = DisposableProofEnvelopeSchema.parse({
    schema: "rhiz/disposable-proof-receipt/v1",
    proofId,
    factoryId: request.factory.id,
    probeId: request.probe.id,
    candidateBefore: before,
    candidateAfter: after,
    candidateDifferences: differences,
    derivative: {
      derivativeId: derivative?.derivativeId ?? "derivative:none",
      factoryId: request.factory.id,
      root: derivative?.root ?? before.executionRoot,
      digest: derivative?.baselineDigest ?? before.digest,
      // A derivative that was never created leaves no bytes, which is what this
      // field means. `derivative-unavailable` is already in the invalidations,
      // so nothing here reads as a proof that ran and tidied up after itself.
      destroyed: derivative === null ? true : destroyed,
      residualPath,
    },
    mutations: derivative?.mutations ?? [],
    startedAt,
    finishedAt: now(),
  });

  if (invalidations.length > 0 || result === null) {
    if (result === null && invalidations.length === 0) {
      invalidations.push({ code: "proof-failed", detail: "the proof produced no result" });
    }
    return { ...envelope, outcome: "invalidated", invalidations, observation };
  }
  return { ...envelope, outcome: "proven", result: (result as { value: T }).value };
}

/**
 * Fields of the candidate's identity that moved.
 *
 * `digestScope` is not compared separately because the aggregate digest binds
 * the scope, so a scope change is already a digest change. Comparing it again
 * would create a second answer to one question.
 */
export function candidateIdentityDifferences(before: CandidateIdentity, after: CandidateIdentity): string[] {
  const differences: string[] = [];
  if (before.executionRoot !== after.executionRoot) differences.push("executionRoot");
  if (before.head !== after.head) differences.push("head");
  if (before.tree !== after.tree) differences.push("tree");
  if (before.digest !== after.digest) differences.push("digest");
  return differences;
}

/**
 * Read a proof's conclusion, or refuse.
 *
 * Callers that would rather have an exception than a union get this. It exists
 * so "I forgot to check the outcome" cannot be spelled the same way as "the
 * proof held".
 */
export function requireProven<T>(receipt: DisposableProofReceipt<T>): T {
  if (receipt.outcome !== "proven") {
    throw new Error(
      `disposable proof ${receipt.proofId} did not count: ${receipt.invalidations.map((item) => `${item.code} (${item.detail})`).join("; ")}`,
    );
  }
  return receipt.result;
}
