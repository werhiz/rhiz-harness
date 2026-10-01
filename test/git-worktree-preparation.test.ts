import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitWorktreeWorkspaceProvider } from "../adapters/git/worktrees.js";
import { work } from "./helpers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string): void {
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
      "base",
    ],
    { cwd, stdio: "ignore" },
  );
}

function oneAttemptWorkerPolicy() {
  return {
    preferredProviders: [],
    maxAttempts: 1,
    allowParallelAttempts: false,
    explicitProviderAuthorizations: [],
  };
}

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "rhiz-prepare-test-"));
  git(root, ["init"]);
  writeFileSync(join(root, ".gitignore"), "deps/\n");
  writeFileSync(join(root, "source.txt"), "base\n");
  git(root, ["add", ".gitignore", "source.txt"]);
  commit(root);
  return {
    root,
    head: git(root, ["rev-parse", "HEAD"]),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("trusted preparation becomes baseline execution identity while later ignored dependency mutation is visible", async () => {
  const value = repositoryFixture();
  const worktreeRoot = mkdtempSync(join(tmpdir(), "rhiz-prepared-worktrees-"));
  const provider = new GitWorktreeWorkspaceProvider({
    repositoryRoot: value.root,
    worktreeRoot,
    prepareWorkspace(executionRoot) {
      mkdirSync(join(executionRoot, "deps"), { recursive: true });
      writeFileSync(join(executionRoot, "deps/tool.js"), "export const value = 1;\n");
    },
  });
  try {
    const workspace = await provider.acquire({
      crewId: "crew:prepare",
      work: work({ workerPolicy: oneAttemptWorkerPolicy() }),
      baseRevision: value.head,
      mode: "isolated-write",
    });
    const baseline = await provider.snapshot(workspace);
    assert.deepEqual(baseline.changedPaths, []);
    assert.ok(baseline.digestScope.fileCount >= 3, "prepared ignored dependency must be hashed");

    writeFileSync(join(workspace.executionRoot, "deps/tool.js"), "export const value = 2;\n");
    const mutated = await provider.snapshot(workspace);
    assert.deepEqual(mutated.changedPaths, ["deps/tool.js"]);
  } finally {
    await provider.close().catch(() => undefined);
    rmSync(worktreeRoot, { recursive: true, force: true });
    value.close();
  }
});

test("trusted preparation cannot smuggle source edits into the admitted baseline", async () => {
  const value = repositoryFixture();
  const worktreeRoot = mkdtempSync(join(tmpdir(), "rhiz-prepare-refusal-"));
  const provider = new GitWorktreeWorkspaceProvider({
    repositoryRoot: value.root,
    worktreeRoot,
    prepareWorkspace(executionRoot) {
      writeFileSync(join(executionRoot, "source.txt"), "changed before worker\n");
    },
  });
  try {
    await assert.rejects(
      () =>
        provider.acquire({
          crewId: "crew:prepare-refusal",
          work: work({ workerPolicy: oneAttemptWorkerPolicy() }),
          baseRevision: value.head,
          mode: "isolated-write",
        }),
      /preparation changed non-ignored source paths.*source\.txt/,
    );
  } finally {
    await provider.close().catch(() => undefined);
    rmSync(worktreeRoot, { recursive: true, force: true });
    value.close();
  }
});
