/**
 * Sensor tests against real Git repositories built in temp directories.
 *
 * Fixtures that are cleaner than reality are how three guards in this
 * organization recently passed against the thing they were supposed to catch,
 * so these build actual commits, actual binary files, and actual remotes rather
 * than stubbing `git`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  baselineFromSignals,
  currentBranch,
  driftedBranches,
  measureBranchDrift,
  measureUpstreamState,
} from "../adapters/git/drift.js";
import { decideHorizon } from "../src/horizon.js";

const HOUR_MS = 60 * 60 * 1000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Horizon Test",
      GIT_AUTHOR_EMAIL: "horizon@example.invalid",
      GIT_COMMITTER_NAME: "Horizon Test",
      GIT_COMMITTER_EMAIL: "horizon@example.invalid",
    },
  }).trim();
}

async function commit(root: string, name: string, body: string, when?: string): Promise<void> {
  await writeFile(join(root, name), body, "utf8");
  git(root, ["add", "-A"]);
  const args = ["commit", "-q", "-m", `add ${name}`];
  if (when !== undefined) {
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Horizon Test",
        GIT_AUTHOR_EMAIL: "horizon@example.invalid",
        GIT_COMMITTER_NAME: "Horizon Test",
        GIT_COMMITTER_EMAIL: "horizon@example.invalid",
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      },
    });
    return;
  }
  git(root, args);
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "horizon-drift-"));
  git(root, ["init", "-q", "--initial-branch=main"]);
  await commit(root, "base.txt", "base\n");
  return root;
}

async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await repository();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("ahead and behind are measured against a real merge base", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt", "a\n");
    await commit(root, "b.txt", "b\n");
    git(root, ["checkout", "-q", "main"]);
    await commit(root, "c.txt", "c\n");

    const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "feature" });
    assert.equal(measurement.kind, "measured");
    if (measurement.kind !== "measured") return;
    assert.equal(measurement.signals.commitsAhead, 2);
    assert.equal(measurement.signals.commitsBehind, 1);
  });
});

test("divergence age tracks the oldest branch-only commit, not the merge base", async () => {
  await withRepository(async (root) => {
    // An ancient base. Divergence has not been happening for that long.
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "recent.txt", "recent\n", "2026-09-13T00:00:00Z");

    const now = Date.parse("2026-09-13T02:00:00Z");
    const measurement = measureBranchDrift({
      repositoryRoot: root,
      integrationRef: "main",
      branch: "feature",
      now: () => now,
    });
    assert.equal(measurement.kind, "measured");
    if (measurement.kind !== "measured") return;
    assert.equal(measurement.signals.divergenceAgeMs, 2 * HOUR_MS, "two hours since divergence began");
  });
});

test("divergence age is the oldest branch-only commit even when newer ones exist", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "old.txt", "old\n", "2026-09-10T00:00:00Z");
    await commit(root, "new.txt", "new\n", "2026-09-13T00:00:00Z");

    const now = Date.parse("2026-09-13T00:00:00Z");
    const measurement = measureBranchDrift({
      repositoryRoot: root,
      integrationRef: "main",
      branch: "feature",
      now: () => now,
    });
    assert.equal(measurement.kind, "measured");
    if (measurement.kind !== "measured") return;
    assert.equal(measurement.signals.divergenceAgeMs, 3 * 24 * HOUR_MS);
  });
});

test("changed lines are counted and a binary file is never read as zero drift", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await writeFile(join(root, "text.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 7]));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "text and binary"]);

    const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "feature" });
    assert.equal(measurement.kind, "measured");
    if (measurement.kind !== "measured") return;
    assert.equal(measurement.signals.diffLines, 3, "three added lines");
    assert.equal(measurement.signals.binaryFilesChanged, 1, "the binary file is counted, not coerced to zero");
  });
});

test("a branch with no upstream reports no-upstream and therefore trips", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt", "a\n");

    assert.equal(measureUpstreamState(root, "feature"), "no-upstream");

    const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "feature" });
    assert.equal(measurement.kind, "measured");
    if (measurement.kind !== "measured") return;
    assert.equal(decideHorizon(measurement.signals).kind, "tripped", "unique local bytes must trip");
  });
});

test("a pushed branch reports pushed, and advancing past it reports ahead-of-remote", async () => {
  await withRepository(async (root) => {
    const remote = await mkdtemp(join(tmpdir(), "horizon-remote-"));
    try {
      git(remote, ["init", "-q", "--bare"]);
      git(root, ["remote", "add", "origin", remote]);
      git(root, ["checkout", "-q", "-b", "feature"]);
      await commit(root, "a.txt", "a\n");
      git(root, ["push", "-q", "-u", "origin", "feature"]);

      assert.equal(measureUpstreamState(root, "feature"), "pushed");

      await commit(root, "b.txt", "b\n");
      assert.equal(measureUpstreamState(root, "feature"), "ahead-of-remote");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});

test("a detached HEAD has no branch to measure and is not reported as clear", async () => {
  await withRepository(async (root) => {
    await commit(root, "a.txt", "a\n");
    git(root, ["checkout", "-q", "--detach", "HEAD"]);

    assert.equal(currentBranch(root), undefined, "a detached HEAD names no branch");

    const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "HEAD" });
    assert.equal(measurement.kind, "unavailable", "measurement fails; it does not report clear");
  });
});

test("an unresolvable integration ref is unavailable, never clear and never tripped", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt", "a\n");

    const measurement = measureBranchDrift({
      repositoryRoot: root,
      integrationRef: "origin/does-not-exist",
      branch: "feature",
    });
    assert.equal(measurement.kind, "unavailable");
    if (measurement.kind !== "unavailable") return;
    assert.match(measurement.reason, /does not resolve/);
  });
});

test("a directory that is not a repository is unavailable rather than an exception", async () => {
  const root = await mkdtemp(join(tmpdir(), "horizon-bare-"));
  try {
    const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "feature" });
    assert.equal(measurement.kind, "unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing branch is unavailable rather than an exception", async () => {
  await withRepository(async (root) => {
    const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "ghost" });
    assert.equal(measurement.kind, "unavailable");
    if (measurement.kind !== "unavailable") return;
    assert.match(measurement.reason, /no such branch/);
  });
});

test("the integration ref measured against itself is measured and clear when durable", async () => {
  await withRepository(async (root) => {
    const remote = await mkdtemp(join(tmpdir(), "horizon-remote-"));
    try {
      git(remote, ["init", "-q", "--bare"]);
      git(root, ["remote", "add", "origin", remote]);
      git(root, ["push", "-q", "-u", "origin", "main"]);

      const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "main" });
      assert.equal(measurement.kind, "measured");
      if (measurement.kind !== "measured") return;
      assert.equal(measurement.signals.commitsAhead, 0);
      assert.equal(measurement.signals.divergenceAgeMs, 0);
      assert.equal(decideHorizon(measurement.signals).kind, "clear");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});

test("driftedBranches finds only branches with unique commits", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "ahead"]);
    await commit(root, "a.txt", "a\n");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["branch", "level"]);

    const drifted = driftedBranches(root, "main");
    assert.deepEqual([...drifted].sort(), ["ahead"]);
  });
});

test("a frozen baseline grandfathers the exact drift it recorded and nothing further", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    for (let index = 0; index < 12; index += 1) await commit(root, `f${index}.txt`, `${index}\n`);

    const first = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "feature" });
    assert.equal(first.kind, "measured");
    if (first.kind !== "measured") return;

    // Past the calibrated threshold, so it trips with no baseline.
    assert.equal(decideHorizon(first.signals).kind, "tripped");

    // Frozen at exactly this drift, it is grandfathered. Durability still
    // trips, so the branch is measured as if it were already pushed.
    const durable = { ...first.signals, upstreamState: "pushed" as const };
    const baseline = baselineFromSignals(durable);
    assert.equal(decideHorizon(durable, baseline).kind, "grandfathered");

    // One more commit is advancing past what was forgiven.
    await commit(root, "one-more.txt", "more\n");
    const second = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "feature" });
    assert.equal(second.kind, "measured");
    if (second.kind !== "measured") return;
    assert.equal(decideHorizon({ ...second.signals, upstreamState: "pushed" }, baseline).kind, "tripped");
  });
});

// Durability is reachability from any remote ref, not upstream bookkeeping.
// Seven real branches whose own upstreams had diverged were preserved under
// rescue/* refs; their bytes were safe and an upstream-tracking check still
// called them at risk.
test("a branch preserved under a rescue ref is durable even though its upstream diverged", async () => {
  await withRepository(async (root) => {
    const remote = await mkdtemp(join(tmpdir(), "horizon-remote-"));
    try {
      git(remote, ["init", "-q", "--bare"]);
      git(root, ["remote", "add", "origin", remote]);
      git(root, ["checkout", "-q", "-b", "feature"]);
      await commit(root, "a.txt", "a\n");
      git(root, ["push", "-q", "-u", "origin", "feature"]);

      // The branch advances locally: its upstream no longer holds these bytes.
      await commit(root, "b.txt", "b\n");
      assert.equal(measureUpstreamState(root, "feature"), "ahead-of-remote");

      // Preserved under a rescue ref, overwriting nothing.
      git(root, ["push", "-q", "origin", "feature:refs/heads/rescue/feature"]);
      git(root, ["fetch", "-q", "origin"]);

      assert.equal(
        measureUpstreamState(root, "feature"),
        "pushed",
        "bytes reachable from any remote ref are durable",
      );

      const measurement = measureBranchDrift({ repositoryRoot: root, integrationRef: "main", branch: "feature" });
      assert.equal(measurement.kind, "measured");
      if (measurement.kind !== "measured") return;
      assert.equal(decideHorizon(measurement.signals).kind, "clear", "a rescued branch no longer trips on durability");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});

test("a branch on no remote at all is still not durable", async () => {
  await withRepository(async (root) => {
    git(root, ["checkout", "-q", "-b", "feature"]);
    await commit(root, "a.txt", "a\n");
    assert.equal(measureUpstreamState(root, "feature"), "no-upstream");
  });
});
