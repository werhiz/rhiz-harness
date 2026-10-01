import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { converge, convergeRawBranch, convergenceRouteFor } from "../adapters/git/converge.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Converge Test",
      GIT_AUTHOR_EMAIL: "converge@example.invalid",
      GIT_COMMITTER_NAME: "Converge Test",
      GIT_COMMITTER_EMAIL: "converge@example.invalid",
    },
  }).trim();
}

async function withRemoteRepository(
  run: (root: string, remote: string) => Promise<void>,
): Promise<void> {
  const remote = await mkdtemp(join(tmpdir(), "converge-remote-"));
  const root = await mkdtemp(join(tmpdir(), "converge-root-"));
  try {
    git(remote, ["init", "-q", "--bare"]);
    git(root, ["init", "-q", "--initial-branch=main"]);
    await writeFile(join(root, "base.txt"), "base\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "base"]);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "-u", "origin", "main"]);
    await run(root, remote);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
}

async function commit(root: string, name: string): Promise<void> {
  await writeFile(join(root, name), `${name}\n`, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", name]);
}

test("a branch with no Work integration ref routes to the raw-branch path", async () => {
  await withRemoteRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt");
    assert.equal(convergenceRouteFor(root, "feature"), "raw-branch");
  });
});

// The dispatch must be established, never inferred from a name that merely
// looks like Harness Work.
test("a branch named like Work still routes raw when no durable Work ref exists", async () => {
  await withRemoteRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "harness/work/looks-official"]);
    await commit(root, "a.txt");
    assert.equal(convergenceRouteFor(root, "harness/work/looks-official"), "raw-branch");
  });
});

test("converging an unpushed branch makes it durable and verifies the remote holds it", async () => {
  await withRemoteRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt");

    const result = converge({ repositoryRoot: root, branch: "feature" });
    assert.equal(result.kind, "durable");
    if (result.kind !== "durable") return;

    const remote = git(root, ["ls-remote", "origin", "refs/heads/feature"]).split("\t")[0];
    assert.equal(remote, result.head, "the remote must actually hold the head we reported durable");
  });
});

test("a branch already on the remote is reported already-durable and pushes nothing new", async () => {
  await withRemoteRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt");
    git(root, ["push", "-q", "-u", "origin", "feature"]);

    const before = git(root, ["ls-remote", "origin", "refs/heads/feature"]).split("\t")[0];
    const result = convergeRawBranch({ repositoryRoot: root, branch: "feature" });
    assert.equal(result.kind, "already-durable");
    assert.equal(git(root, ["ls-remote", "origin", "refs/heads/feature"]).split("\t")[0], before);
  });
});

test("a dry run sends nothing", async () => {
  await withRemoteRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt");

    convergeRawBranch({ repositoryRoot: root, branch: "feature", dryRun: true });
    assert.equal(
      git(root, ["ls-remote", "origin", "refs/heads/feature"]),
      "",
      "a dry run must leave the remote without the branch",
    );
  });
});

test("convergence never advances the integration ref", async () => {
  await withRemoteRepository(async (root) => {
    const mainBefore = git(root, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0];

    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt");
    converge({ repositoryRoot: root, branch: "feature" });

    assert.equal(
      git(root, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0],
      mainBefore,
      "convergence makes bytes durable; it must not merge",
    );
  });
});

test("a branch that does not resolve fails rather than throwing", async () => {
  await withRemoteRepository(async (root) => {
    const result = convergeRawBranch({ repositoryRoot: root, branch: "ghost" });
    assert.equal(result.kind, "failed");
  });
});
