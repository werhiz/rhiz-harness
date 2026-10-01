import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { digestExecutionRoot } from "../src/workspace-digest.js";

async function makeCandidate(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rhiz-digest-git-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "example.ts"), "export const x = 1;\n");
  await writeFile(join(root, "README.md"), "# example\n");
  return root;
}

test("digestExecutionRoot excludes a nested .git file the same way it excludes the top-level .git directory", async (t) => {
  const root = await makeCandidate();
  t.after(() => rm(root, { recursive: true, force: true }));

  // Top-level .git directory (the canonical exclusion shape).
  await mkdir(join(root, ".git"));
  const withTopGit = await digestExecutionRoot(root);

  // Nested .git file (the worktree-pointer shape). Inside `.worktrees/<name>/`
  // a linked worktree stores a `.git` file pointing back to the parent.
  await mkdir(join(root, ".worktrees", "child"), { recursive: true });
  await writeFile(
    join(root, ".worktrees", "child", ".git"),
    "gitdir: /some/parent/.git/worktrees/child\n",
  );
  await writeFile(join(root, ".worktrees", "child", "marker.txt"), "child bytes\n");
  const withNestedGit = await digestExecutionRoot(root);

  // The marker in `.worktrees/<name>/` must still be counted; only the `.git`
  // pointer file is the same fact as the top-level `.git` directory.
  assert.ok(
    withNestedGit.scope.fileCount > withTopGit.scope.fileCount,
    "nested worktree content is still part of the digest",
  );

  // The digests must not differ on the basis of the nested `.git` file: if
  // they did, `TempDirectoryDerivativeFactory` would refuse the derivative
  // because its cp filter drops the `.git` file by basename while the digest
  // counts it.
  await rm(join(root, ".worktrees", "child", ".git"));
  const afterRemovingNestedGitFile = await digestExecutionRoot(root);
  assert.equal(
    afterRemovingNestedGitFile.digest,
    withNestedGit.digest,
    "removing the nested `.git` file must not change the digest",
  );
});

test("digestExecutionRoot counts an honest nested file that happens to be named `.gitignore`", async (t) => {
  const root = await makeCandidate();
  t.after(() => rm(root, { recursive: true, force: true }));

  const before = await digestExecutionRoot(root);
  await mkdir(join(root, "subdir"), { recursive: true });
  await writeFile(join(root, "subdir", ".gitignore"), "node_modules\n", "utf8");

  const after = await digestExecutionRoot(root);
  assert.ok(
    after.scope.fileCount > before.scope.fileCount,
    "a nested .gitignore file must remain in the digest",
  );
});
