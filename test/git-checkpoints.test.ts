import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCandidatePathsAllowed,
  preserveCandidate,
  promoteVerifiedCandidate,
} from "../adapters/git/checkpoints.js";
import { digestExecutionRoot } from "../src/workspace-digest.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Harness Test",
      "-c",
      "user.email=harness-test@localhost.invalid",
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
    ],
    { cwd, stdio: "ignore" },
  );
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rhiz-checkpoint-test-"));
  git(root, ["init"]);
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, ["add", "base.txt"]);
  commit(root, "base");
  const base = git(root, ["rev-parse", "HEAD"]);
  const worktree = join(root, "worktree");
  git(root, ["worktree", "add", "--detach", worktree, base]);
  return {
    root,
    worktree,
    base,
    close() {
      try {
        git(root, ["worktree", "remove", "--force", worktree]);
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Harness rescue ref preserves a candidate after the disposable worktree is removed", async () => {
  const value = await fixture();
  try {
    writeFileSync(join(value.worktree, "src.txt"), "candidate\n");
    const identity = await digestExecutionRoot(value.worktree);
    const saved = preserveCandidate({
      executionRoot: value.worktree,
      expectedBaseRevision: value.base,
      workId: "work:customer-zero",
      attemptId: "attempt:one",
      snapshot: {
        workspaceId: "workspace:one",
        head: value.base,
        digest: identity.digest,
        digestScope: identity.scope,
        changedPaths: ["src.txt"],
        observedAt: "2026-08-28T04:40:00.000Z",
      },
      allowed: [{ path: "src.txt", kind: "file" }],
    });

    assert.equal(git(value.worktree, ["rev-parse", saved.rescueRef]), saved.head);
    git(value.root, ["worktree", "remove", "--force", value.worktree]);
    assert.equal(git(value.root, ["rev-parse", saved.rescueRef]), saved.head);
    assert.equal(git(value.root, ["show", `${saved.head}:src.txt`]), "candidate");
  } finally {
    value.close();
  }
});

test("candidate preservation fails closed when observed writes exceed the allowed Work scope", async () => {
  const value = await fixture();
  try {
    writeFileSync(join(value.worktree, "allowed.txt"), "allowed\n");
    writeFileSync(join(value.worktree, "forbidden.txt"), "forbidden\n");
    const identity = await digestExecutionRoot(value.worktree);

    assert.throws(
      () =>
        preserveCandidate({
          executionRoot: value.worktree,
          expectedBaseRevision: value.base,
          workId: "work:scope",
          attemptId: "attempt:scope",
          snapshot: {
            workspaceId: "workspace:scope",
            head: value.base,
            digest: identity.digest,
            digestScope: identity.scope,
            changedPaths: ["allowed.txt", "forbidden.txt"],
            observedAt: "2026-08-28T04:40:00.000Z",
          },
          allowed: [{ path: "allowed.txt", kind: "file" }],
        }),
      /outside Work write scope: forbidden\.txt/,
    );
    assert.equal(git(value.worktree, ["rev-parse", "HEAD"]), value.base);
  } finally {
    value.close();
  }
});

test("verified candidate promotion points the Work ref at the exact candidate commit", async () => {
  const value = await fixture();
  try {
    writeFileSync(join(value.worktree, "feature.txt"), "verified\n");
    const identity = await digestExecutionRoot(value.worktree);
    const saved = preserveCandidate({
      executionRoot: value.worktree,
      expectedBaseRevision: value.base,
      workId: "work:verified",
      attemptId: "attempt:verified",
      snapshot: {
        workspaceId: "workspace:verified",
        head: value.base,
        digest: identity.digest,
        digestScope: identity.scope,
        changedPaths: ["feature.txt"],
        observedAt: "2026-08-28T04:40:00.000Z",
      },
      allowed: [{ path: "feature.txt", kind: "file" }],
    });

    const ref = promoteVerifiedCandidate({
      executionRoot: value.worktree,
      workId: "work:verified",
      candidateHead: saved.head,
    });
    assert.equal(ref, "refs/rhiz/work/work-verified/candidate");
    assert.equal(git(value.root, ["rev-parse", ref]), saved.head);
  } finally {
    value.close();
  }
});

test("path-scope helper refuses traversal and permits directory descendants", () => {
  assert.deepEqual(
    assertCandidatePathsAllowed(
      ["apps/example/a.ts", "apps/example/nested/b.ts"],
      [{ path: "apps/example", kind: "directory" }],
    ),
    ["apps/example/a.ts", "apps/example/nested/b.ts"],
  );
  assert.throws(
    () => assertCandidatePathsAllowed(["../escape"], [{ path: "apps", kind: "directory" }]),
    /invalid candidate path/,
  );
});
