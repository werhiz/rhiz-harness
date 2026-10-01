import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  preserveCandidateRemotely,
  pushHarnessCheckpoint,
} from "../adapters/git/checkpoints.js";
import { GitWorkIntegrationExecutor } from "../adapters/git/integration.js";
import type { IntegrationExecutionRequest } from "../src/integration.js";
import { digestExecutionRoot } from "../src/workspace-digest.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): string {
  execFileSync("git", [
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness-test@localhost.invalid",
    "commit", "--no-gpg-sign", "-m", message,
  ], { cwd, stdio: "ignore" });
  return git(cwd, ["rev-parse", "HEAD"]);
}

function remoteHead(cwd: string, ref: string): string | null {
  const value = git(cwd, ["ls-remote", "--refs", "origin", ref]);
  return value.length === 0 ? null : value.split(/\s+/)[0] ?? null;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rhiz-integration-git-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  git(root, ["init", "--bare", remote]);
  git(root, ["clone", remote, repo]);
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, ["add", "shared.txt"]);
  const base = commit(repo, "base");
  git(repo, ["push", "origin", `HEAD:refs/heads/main`]);
  return {
    root,
    repo,
    base,
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

function request(input: {
  base: string;
  candidate: string;
  tree: string;
  checkpointRef: string;
  integrationRef: string;
  purpose?: "integrate-candidate" | "reconcile-stale-attempt";
}): IntegrationExecutionRequest {
  return {
    purpose: input.purpose ?? "integrate-candidate",
    workId: "work:git-integration",
    taskId: "task:one",
    attemptId: "attempt:one",
    integrationRef: input.integrationRef,
    integrationHead: input.base,
    checkpoint: {
      id: "checkpoint:one",
      class: input.purpose === "reconcile-stale-attempt" ? "wip-rescue" : "integration-candidate",
      parentIntegrationHead: input.base,
      workspaceId: "workspace:one",
      changedResources: [{ kind: "path", resource: "candidate.txt" }],
      head: input.candidate,
      tree: input.tree,
      proofState: input.purpose === "reconcile-stale-attempt" ? "not-run" : "passed",
      ...(input.purpose === "reconcile-stale-attempt" ? {} : {
        proofHead: input.candidate,
        verificationEventId: "event:candidate-proof",
      }),
      remoteRef: input.checkpointRef,
      remoteStatus: "pushed",
    },
  };
}

test("candidate preservation pushes immutable bytes before the disposable workspace is removed", async () => {
  const value = fixture();
  const worktree = join(value.root, "candidate-worktree");
  try {
    git(value.repo, ["worktree", "add", "--detach", worktree, value.base]);
    writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
    const identity = await digestExecutionRoot(worktree);
    const saved = preserveCandidateRemotely({
      repositoryRoot: value.repo,
      executionRoot: worktree,
      expectedBaseRevision: value.base,
      workId: "work:git-integration",
      attemptId: "attempt:one",
      snapshot: {
        workspaceId: "workspace:one",
        head: value.base,
        digest: identity.digest,
        digestScope: identity.scope,
        changedPaths: ["candidate.txt"],
        observedAt: "2026-08-29T12:00:00.000Z",
      },
      allowed: [{ path: "candidate.txt", kind: "file" }],
    });
    git(value.repo, ["worktree", "remove", "--force", worktree]);
    assert.equal(saved.remoteStatus, "pushed");
    assert.equal(remoteHead(value.repo, saved.remoteRef), saved.head);
    assert.equal(git(value.repo, ["show", `${saved.head}:candidate.txt`]), "candidate");

    const secondWorktree = join(value.root, "candidate-worktree-two");
    git(value.repo, ["worktree", "add", "--detach", secondWorktree, saved.head]);
    writeFileSync(join(secondWorktree, "candidate.txt"), "candidate two\n");
    const secondIdentity = await digestExecutionRoot(secondWorktree);
    const second = preserveCandidateRemotely({
      repositoryRoot: value.repo,
      executionRoot: secondWorktree,
      expectedBaseRevision: saved.head,
      workId: "work:git-integration",
      attemptId: "attempt:one",
      snapshot: {
        workspaceId: "workspace:one",
        head: saved.head,
        digest: secondIdentity.digest,
        digestScope: secondIdentity.scope,
        changedPaths: ["candidate.txt"],
        observedAt: "2026-08-29T12:01:00.000Z",
      },
      allowed: [{ path: "candidate.txt", kind: "file" }],
    });
    assert.notEqual(second.remoteRef, saved.remoteRef);
    assert.equal(remoteHead(value.repo, saved.remoteRef), saved.head);
    assert.equal(remoteHead(value.repo, second.remoteRef), second.head);
  } finally {
    value.close();
  }
});

test("the executor advances one remote Work ref by compare-and-swap and restart is idempotent", async () => {
  const value = fixture();
  try {
    const integrationRef = "refs/rhiz/work/work-git-integration/candidate";
    git(value.repo, ["update-ref", integrationRef, value.base]);
    git(value.repo, ["push", "origin", `${value.base}:${integrationRef}`]);
    writeFileSync(join(value.repo, "candidate.txt"), "candidate\n");
    git(value.repo, ["add", "candidate.txt"]);
    const candidate = commit(value.repo, "candidate");
    const tree = git(value.repo, ["rev-parse", "HEAD^{tree}"]);
    const checkpointRef = "refs/rhiz/rescue/work-git-integration/attempt-one";
    pushHarnessCheckpoint({ repositoryRoot: value.repo, ref: checkpointRef, head: candidate });
    const integrationRequest = request({ base: value.base, candidate, tree, checkpointRef, integrationRef });
    let proofs = 0;
    const executor = new GitWorkIntegrationExecutor({
      repositoryRoot: value.repo,
      prove: async ({ targetHead }) => {
        proofs += 1;
        return {
          status: "passed",
          proofHead: targetHead,
          verificationEventId: "event:final-head-proof",
          evidence: [{ id: `evidence:${proofs}`, kind: "test", digest: `sha256:${proofs}` }],
        };
      },
    });

    const first = await executor.reconcile(integrationRequest);
    const restartRepo = join(value.root, "restart-repo");
    git(value.root, ["clone", join(value.root, "remote.git"), restartRepo]);
    const afterRestart = await new GitWorkIntegrationExecutor({
      repositoryRoot: restartRepo,
      prove: async ({ targetHead }) => {
        proofs += 1;
        return {
          status: "passed",
          proofHead: targetHead,
          verificationEventId: "event:final-head-proof",
          evidence: [{ id: `evidence:${proofs}`, kind: "test", digest: `sha256:${proofs}` }],
        };
      },
    }).reconcile(integrationRequest);
    assert.equal(first.status, "integrated");
    assert.equal(afterRestart.status, "integrated");
    assert.equal(remoteHead(value.repo, integrationRef), candidate);
    assert.equal(proofs, 2, "restart reruns proof rather than trusting the interrupted process");
  } finally {
    value.close();
  }
});

test("a stale task is reconciled in a disposable worktree, reproven, and pushed without moving the Work ref", async () => {
  const value = fixture();
  const candidateWorktree = join(value.root, "stale-candidate");
  try {
    git(value.repo, ["worktree", "add", "--detach", candidateWorktree, value.base]);
    writeFileSync(join(candidateWorktree, "candidate.txt"), "stale task bytes\n");
    git(candidateWorktree, ["add", "candidate.txt"]);
    const candidate = commit(candidateWorktree, "stale task");
    const tree = git(candidateWorktree, ["rev-parse", "HEAD^{tree}"]);
    const checkpointRef = "refs/rhiz/rescue/work-git-integration/stale-attempt";
    pushHarnessCheckpoint({ repositoryRoot: value.repo, ref: checkpointRef, head: candidate });

    writeFileSync(join(value.repo, "integration.txt"), "integrated first\n");
    git(value.repo, ["add", "integration.txt"]);
    const integrationHead = commit(value.repo, "advance integration");
    const integrationRef = "refs/rhiz/work/work-git-integration/candidate";
    git(value.repo, ["update-ref", integrationRef, integrationHead]);
    git(value.repo, ["push", "origin", `${integrationHead}:${integrationRef}`]);

    const result = await new GitWorkIntegrationExecutor({
      repositoryRoot: value.repo,
      worktreeRoot: join(value.root, "reconciliation-worktrees"),
      prove: async ({ targetHead }) => ({
        status: "passed",
        proofHead: targetHead,
        evidence: [{ id: "evidence:reconciled", kind: "test", digest: "sha256:reconciled" }],
      }),
    }).reconcile(request({
      base: integrationHead,
      candidate,
      tree,
      checkpointRef,
      integrationRef,
      purpose: "reconcile-stale-attempt",
    }));

    assert.equal(result.status, "reconciled");
    assert.equal(remoteHead(value.repo, integrationRef), integrationHead);
    if (result.status === "reconciled") assert.equal(remoteHead(value.repo, result.remoteRef), result.head);
  } finally {
    value.close();
  }
});

test("semantic conflict preserves both remote states and never advances the Work ref", async () => {
  const value = fixture();
  const candidateWorktree = join(value.root, "conflicting-candidate");
  try {
    git(value.repo, ["worktree", "add", "--detach", candidateWorktree, value.base]);
    writeFileSync(join(candidateWorktree, "shared.txt"), "candidate version\n");
    git(candidateWorktree, ["add", "shared.txt"]);
    const candidate = commit(candidateWorktree, "candidate conflict");
    const tree = git(candidateWorktree, ["rev-parse", "HEAD^{tree}"]);
    const checkpointRef = "refs/rhiz/rescue/work-git-integration/conflict";
    pushHarnessCheckpoint({ repositoryRoot: value.repo, ref: checkpointRef, head: candidate });

    writeFileSync(join(value.repo, "shared.txt"), "integration version\n");
    git(value.repo, ["add", "shared.txt"]);
    const integrationHead = commit(value.repo, "integration conflict");
    const integrationRef = "refs/rhiz/work/work-git-integration/candidate";
    git(value.repo, ["update-ref", integrationRef, integrationHead]);
    git(value.repo, ["push", "origin", `${integrationHead}:${integrationRef}`]);

    const result = await new GitWorkIntegrationExecutor({
      repositoryRoot: value.repo,
      worktreeRoot: join(value.root, "conflict-worktrees"),
      prove: async () => { throw new Error("proof must not run across a Git conflict"); },
    }).reconcile(request({
      base: integrationHead,
      candidate,
      tree,
      checkpointRef,
      integrationRef,
      purpose: "reconcile-stale-attempt",
    }));

    assert.equal(result.status, "conflict");
    assert.equal(remoteHead(value.repo, integrationRef), integrationHead);
    if (result.status === "conflict") {
      assert.equal(result.preservedRefs.length, 2);
      assert.deepEqual(result.preservedRefs.map((ref) => remoteHead(value.repo, ref)), [integrationHead, candidate]);
    }
  } finally {
    value.close();
  }
});
