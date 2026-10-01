import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);

/**
 * Why this module exists.
 *
 * The previous workspace identity was git's opinion of the tree: HEAD, plus
 * `status`, plus `diff`, plus `ls-files --others --exclude-standard`. Every one
 * of those honours `.gitignore`, so `node_modules/`, `dist/`, `.env` and every
 * build cache sat outside the identity that Verify called exact. A worker could
 * rewrite `node_modules/<dep>/index.js`, the digest would be byte-identical, and
 * the verifier would then load that module while running the repository's own
 * test command. The receipt attested `artifact-identity` for a digest that
 * provably did not cover the bytes that ran. See issue #10.
 *
 * Identity here is therefore a content digest of the execution root as it will
 * actually be executed, and the scope of that digest travels with it so a
 * receipt can never imply more coverage than it has.
 *
 * Three properties this deliberately keeps:
 *
 *   - It fails closed. Exceeding a limit throws rather than truncating, because
 *     a digest that silently covers less than it claims is the same defect this
 *     module exists to remove, one level down.
 *   - It does not follow symlinks. A link is hashed as its target string, so a
 *     link pointing outside the root cannot pull foreign bytes into the identity
 *     and cannot produce an unbounded walk.
 *   - It streams. Files are read in chunks, so a large tree does not have to fit
 *     in memory to be identified.
 */

export const DigestScopeSchema = z.object({
  /** Hash used for both per-file and aggregate digests. */
  algorithm: z.literal("sha256"),
  /**
   * How the identity was derived. A future strategy (for example hashing a
   * freshly materialised tree) must introduce a new literal rather than quietly
   * changing what this one means.
   */
  strategy: z.literal("execution-root-content"),
  /**
   * Relative paths excluded from the walk, recorded so a reader can see exactly
   * what the digest does not cover. Narrow and typed on purpose.
   */
  exclusions: z.array(text.max(200)),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  symlinkCount: z.number().int().nonnegative(),
}).strict();
export type DigestScope = z.infer<typeof DigestScopeSchema>;

/**
 * `.git` is excluded because it is not execution input, it is the mechanism the
 * harness uses to observe the tree. Including it would make every snapshot
 * differ from the last for reasons unrelated to what runs (index mtimes, reflog
 * writes, gc), which destroys the comparison the digest exists to support.
 *
 * Excluding it is only safe because the git invocations that read this workspace
 * are hardened against repository-supplied configuration. See `hardenedGitEnv`
 * and `HARDENED_GIT_FLAGS` in adapters/git/worktrees.ts: without those, a
 * hostile `.git/config` (`core.pager`, `core.fsmonitor`, `core.hooksPath`) would
 * execute during snapshot from inside the very directory we declined to hash.
 */
export const DEFAULT_EXECUTION_ROOT_EXCLUSIONS: readonly string[] = [".git"];

export interface ExecutionRootDigestLimits {
  /** Maximum number of filesystem entries hashed. */
  maxFiles: number;
  /** Maximum size of any single file. */
  maxFileBytes: number;
  /** Maximum total bytes read across the walk. */
  maxTotalBytes: number;
}

export const DEFAULT_EXECUTION_ROOT_LIMITS: ExecutionRootDigestLimits = {
  maxFiles: 200_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
};

export class WorkspaceDigestLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceDigestLimitError";
  }
}

export interface ExecutionRootDigest {
  /** Aggregate identity of the execution root, `sha256:<hex>`. */
  digest: string;
  scope: DigestScope;
  /**
   * Relative path to per-entry digest. Entries are prefixed so a file and a
   * symlink with identical bytes can never collide:
   *   `file:sha256:<hex>` / `link:sha256:<hex>`
   */
  manifest: ReadonlyMap<string, string>;
}

function toPosix(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

async function hashFileStream(absolutePath: string, maxFileBytes: number): Promise<{ digest: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(absolutePath);
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      if (bytes > maxFileBytes) {
        throw new WorkspaceDigestLimitError(
          `file ${absolutePath} exceeds the ${maxFileBytes} byte per-file digest limit`,
        );
      }
      hash.update(buffer);
    }
  } finally {
    stream.destroy();
  }
  return { digest: `file:sha256:${hash.digest("hex")}`, bytes };
}

/**
 * Content-identify an execution root.
 *
 * Ignored paths are included by design: `.gitignore` describes what a human does
 * not want to commit, which has nothing to do with what a process will load.
 */
export async function digestExecutionRoot(
  executionRoot: string,
  options: {
    exclusions?: readonly string[];
    limits?: Partial<ExecutionRootDigestLimits>;
  } = {},
): Promise<ExecutionRootDigest> {
  const exclusions = [...(options.exclusions ?? DEFAULT_EXECUTION_ROOT_EXCLUSIONS)].sort();
  const excluded = new Set(exclusions);
  const limits: ExecutionRootDigestLimits = { ...DEFAULT_EXECUTION_ROOT_LIMITS, ...options.limits };

  const manifest = new Map<string, string>();
  let fileCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;

  // Iterative walk with an explicit stack. Directory entries are sorted so the
  // aggregate digest is deterministic across filesystems that enumerate in
  // different orders.
  const stack: string[] = [executionRoot];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = toPosix(relative(executionRoot, absolutePath));
      if (excluded.has(relativePath)) continue;
      // `.git` is never execution input, at any depth. The top-level directory
      // is already in `excluded`; a git-worktree pointer file named `.git`
      // inside `.worktrees/<name>/` is the same fact in a different shape and
      // would otherwise disagree with `TempDirectoryDerivativeFactory`'s
      // basename filter, leaving the disposable proof unable to construct a
      // faithful derivative of a candidate that lives inside a worktree.
      if (entry.name === ".git") continue;

      // lstat rather than the dirent type: a dirent reports the link, and we
      // want the same answer on every platform without following it.
      const stats = await lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        symlinkCount += 1;
        fileCount += 1;
        if (fileCount > limits.maxFiles) {
          throw new WorkspaceDigestLimitError(
            `execution root ${executionRoot} exceeds the ${limits.maxFiles} entry digest limit`,
          );
        }
        // The link target is hashed as data. Following it could leave the root
        // entirely, and a cycle would never terminate.
        const target = await readlink(absolutePath);
        manifest.set(relativePath, `link:sha256:${createHash("sha256").update(target).digest("hex")}`);
        continue;
      }

      if (stats.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!stats.isFile()) {
        // Sockets, FIFOs and devices are not execution input we can identify by
        // content. Record their presence and kind, never their bytes.
        fileCount += 1;
        // Same bound as the file and symlink branches. A tree of ten million
        // FIFOs is still a tree too large to identify.
        if (fileCount > limits.maxFiles) {
          throw new WorkspaceDigestLimitError(
            `execution root ${executionRoot} exceeds the ${limits.maxFiles} entry digest limit`,
          );
        }
        manifest.set(relativePath, `other:sha256:${createHash("sha256").update(String(stats.mode)).digest("hex")}`);
        continue;
      }

      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw new WorkspaceDigestLimitError(
          `execution root ${executionRoot} exceeds the ${limits.maxFiles} entry digest limit`,
        );
      }
      const hashed = await hashFileStream(absolutePath, limits.maxFileBytes);
      totalBytes += hashed.bytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new WorkspaceDigestLimitError(
          `execution root ${executionRoot} exceeds the ${limits.maxTotalBytes} byte digest limit`,
        );
      }
      manifest.set(relativePath, hashed.digest);
    }
  }

  const scope = DigestScopeSchema.parse({
    algorithm: "sha256",
    strategy: "execution-root-content",
    exclusions,
    fileCount,
    totalBytes,
    symlinkCount,
  });

  // The aggregate binds the scope as well as the contents, so a digest computed
  // with a wider exclusion list can never compare equal to a narrower one.
  const aggregate = createHash("sha256");
  aggregate.update("scope\0");
  aggregate.update(JSON.stringify(scope));
  aggregate.update("\0entries\0");
  for (const relativePath of [...manifest.keys()].sort()) {
    aggregate.update(relativePath);
    aggregate.update("\0");
    aggregate.update(manifest.get(relativePath)!);
    aggregate.update("\0");
  }

  return { digest: `sha256:${aggregate.digest("hex")}`, scope, manifest };
}

/**
 * Paths that differ between two manifests, as a sorted list.
 *
 * Additions, removals and content changes are all reported, because a worker
 * that deletes a file has changed what executes just as surely as one that
 * writes a file.
 */
export function manifestChangedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [path, digest] of after) {
    if (before.get(path) !== digest) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  return [...changed].sort();
}
