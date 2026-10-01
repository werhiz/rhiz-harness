import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitWorktreeWorkspaceProvider } from "../adapters/git/worktrees.js";
import { workspaceChangeViolations } from "../src/crew.js";
import { parseWorkContract } from "../src/schemas.js";
import { human } from "./helpers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function work(id: string, type: "SHIP" | "REVIEW", dependencies: string[] = []) {
  return parseWorkContract({
    id,
    objective: `${type} through a disposable Git worktree`,
    type,
    scope: [{ uri: "repo://fixture", kind: "repository" }],
    writeScope: type === "SHIP" ? [{ uri: "repo://fixture/src", kind: "directory" }] : [],
    nonGoals: [],
    authority: {
      grants: type === "SHIP"
        ? [
          { action: "read", resources: [{ uri: "repo://fixture", kind: "repository" }], constraints: [] },
          { action: "write", resources: [{ uri: "repo://fixture/src", kind: "directory" }], constraints: [] },
        ]
        : [{ action: "read", resources: [{ uri: "repo://fixture", kind: "repository" }], constraints: [] }],
      requiresHumanApproval: ["publish"],
    },
    acceptanceCriteria: [{ id: `criterion:${id}`, description: "Workspace is inspectable", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: false },
    dependencies,
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-08-20T16:00:00.000Z",
  });
}

test("Git worktree provider creates, snapshots, hands off, and removes one owned workspace", async () => {
  const container = mkdtempSync(join(tmpdir(), "rhiz-crew-git-"));
  const repository = join(container, "repo");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Rhiz Test"]);
  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, "src/base.ts"), "export const base = true;\n");
  git(repository, ["add", "src/base.ts"]);
  git(repository, ["commit", "-m", "fixture"]);
  const head = git(repository, ["rev-parse", "HEAD"]);
  const provider = new GitWorktreeWorkspaceProvider({ repositoryRoot: repository });

  try {
    const shipWork = work("work:ship", "SHIP");
    const shipWorkspace = await provider.acquire({
      crewId: "crew:git",
      work: shipWork,
      baseRevision: head,
      mode: "isolated-write",
    });
    assert.equal(shipWorkspace.baseRevision, head);
    assert.equal(git(shipWorkspace.executionRoot, ["rev-parse", "HEAD"]), head);

    writeFileSync(join(shipWorkspace.executionRoot, "src/feature.ts"), "export const feature = true;\n");
    const shipSnapshot = await provider.snapshot(shipWorkspace);
    assert.deepEqual(shipSnapshot.changedPaths, ["src/feature.ts"]);

    const reviewWork = work("work:review", "REVIEW", [shipWork.id]);
    const reviewWorkspace = await provider.acquire({
      crewId: "crew:git",
      work: reviewWork,
      baseRevision: head,
      mode: "read-only",
      sourceWorkspace: shipWorkspace,
      sourceWorkId: shipWork.id,
    });
    assert.equal(reviewWorkspace.workspaceId, shipWorkspace.workspaceId);
    assert.equal(reviewWorkspace.executionRoot, shipWorkspace.executionRoot);
    assert.equal(reviewWorkspace.sourceWorkId, shipWork.id);
    const reviewSnapshot = await provider.snapshot(reviewWorkspace);
    assert.equal(reviewSnapshot.digest, shipSnapshot.digest);
    assert.deepEqual(provider.activeWorkspaceIds(), [shipWorkspace.workspaceId]);

    await provider.release(shipWorkspace.workspaceId);
    assert.deepEqual(provider.activeWorkspaceIds(), []);
    assert.doesNotMatch(git(repository, ["worktree", "list", "--porcelain"]), new RegExp(shipWorkspace.executionRoot));
    assert.equal(git(repository, ["status", "--short"]), "");
  } finally {
    await provider.close().catch(() => undefined);
    rmSync(container, { recursive: true, force: true });
  }
});

test("Git worktree provider rejects inheritance from a workspace it does not own", async () => {
  const container = mkdtempSync(join(tmpdir(), "rhiz-crew-git-owner-"));
  const repository = join(container, "repo");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Rhiz Test"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "fixture"]);
  const head = git(repository, ["rev-parse", "HEAD"]);
  const provider = new GitWorktreeWorkspaceProvider({ repositoryRoot: repository });

  try {
    await assert.rejects(() => provider.acquire({
      crewId: "crew:git",
      work: work("work:review", "REVIEW", ["work:ship"]),
      baseRevision: head,
      mode: "read-only",
      sourceWorkId: "work:ship",
      sourceWorkspace: {
        leaseId: "lease:foreign",
        workspaceId: "workspace:foreign",
        uri: "file:///tmp/foreign",
        executionRoot: "/tmp/foreign",
        baseRevision: head,
        mode: "isolated-write",
      },
    }), /not owned by this provider/);
  } finally {
    await provider.close().catch(() => undefined);
    rmSync(container, { recursive: true, force: true });
  }
});

test("read-only missions detect an ignored-path write as workspace drift", async () => {
  // Before issue #10 this check was vacuous. The read-only branch of
  // workspaceChangeViolations compares digests, and the digest honoured
  // .gitignore, so a SCOUT writing anything ignored produced no violation at
  // all. The digest now covers the execution root, which is what gives this
  // comparison something to see.
  const root = mkdtempSync(join(tmpdir(), "rhiz-readonly-drift-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.js"), "export const value = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "seed"]);

    const provider = new GitWorktreeWorkspaceProvider({ repositoryRoot: root });
    try {
      const contract = work("work:scout-drift", "REVIEW");
      const workspace = await provider.acquire({
        crewId: "crew:drift",
        work: contract,
        baseRevision: "HEAD",
        mode: "read-only",
      });
      const before = await provider.snapshot(workspace);

      mkdirSync(join(workspace.executionRoot, "node_modules/evil"), { recursive: true });
      writeFileSync(join(workspace.executionRoot, "node_modules/evil/index.js"), "process.exit(0);\n");

      const after = await provider.snapshot(workspace);
      const violations = workspaceChangeViolations(contract, workspace, before, after);
      assert.deepEqual(violations, ["read-only Crew mission changed its workspace"]);

      // Control: an untouched read-only workspace reports no drift, so the
      // assertion above is detection rather than a check that always fires.
      const quiet = workspaceChangeViolations(contract, workspace, after, await provider.snapshot(workspace));
      assert.deepEqual(quiet, []);
    } finally {
      await provider.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
