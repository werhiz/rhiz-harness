import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readRepositoryWorkLedgers } from "../adapters/local/work-ledgers.js";

import { HOUR, hostScript, convergenceFixture } from "./horizon-convergence-fixture.js";

test("fixed convergence executes new Work/Verify/Review before one bounded real merge effect", async () => {
  const f = await convergenceFixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    assert.equal(f.git(["ls-files", "--unmerged"]), "");
    assert.equal(f.git(["rev-parse", "MERGE_HEAD"]), f.base);
    assert.equal(f.git(["rev-parse", "HEAD"]), f.head, "effect does not commit or wash history");
    assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n");
    const replay = f.run();
    assert.notEqual(replay.status, 0, "replay cannot create another window or skip invocation");
    f.git(["commit", "-qm", "complete genuine reconciliation"]);
    f.git(["push", "-qu", "origin", "feature"]);
    const ordinary = spawnSync(process.execPath, [hostScript, "check", "--repo", f.repo, "--integration-ref", "origin/main", "--json"], { cwd: f.repo, encoding: "utf8" });
    const measured = JSON.parse(ordinary.stdout);
    assert.equal(measured.signals.commitsAhead, 10);
    assert.equal(measured.signals.commitsBehind, 0);
    assert.equal(measured.state, "tripped", "complete convergence does not forgive subsequent general writes");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("actual failed verification, failed review and concurrent extra state cannot authorize source writes", async () => {
  for (const mode of ["bad-artifact", "review-refuses", "concurrent-state"]) {
    const f = await convergenceFixture();
    try {
      const result = f.run(mode);
      assert.notEqual(result.status, 0, mode);
      assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
      const calls = await readFile(f.calls, "utf8");
      assert.equal(calls, mode === "bad-artifact" ? "worker\n" : "worker\nreview\n", "the intended boundary, not an earlier failure, must refuse");
      assert.match(result.stderr, mode === "bad-artifact" ? /controlled start failed/ : mode === "review-refuses" ? /controlled review failed/ : /convergence effect refused/);
      assert.ok(f.git(["ls-files", "--unmerged"]).length > 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("convergence rejects foreign scope, changed merge state and author-supplied evidence fields without execution", async () => {
  for (const scenario of ["foreign-scope", "wrong-merge", "caller-proof", "changed-stage"]) {
    const f = await convergenceFixture();
    try {
      if (scenario === "foreign-scope") await writeFile(f.inputFile, JSON.stringify({ ...f.request, paths: ["foreign.txt"] }));
      if (scenario === "caller-proof") await writeFile(f.inputFile, JSON.stringify({ ...f.request, verified: true, reviewer: "author" }));
      if (scenario === "wrong-merge") await writeFile(join(f.repo, ".git", "MERGE_HEAD"), f.head + "\n");
      if (scenario === "changed-stage") {
        // Preserve working conflict bytes but alter the actual stage2 identity.
        const blobFile = join(f.root, "wrong-stage.txt");
        await writeFile(blobFile, "wrong stage\n");
        const blob = f.git(["hash-object", "-w", blobFile]);
        execFileSync("git", ["update-index", "--index-info"], { cwd: f.repo, input: `100644 ${blob} 2\tsource.txt\n`, encoding: "utf8" });
      }
      const result = f.run();
      assert.notEqual(result.status, 0, scenario);
      assert.equal(await readFile(f.calls, "utf8"), "", scenario);
      assert.equal(f.git(["rev-parse", "HEAD"]), f.head);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("nested custody links refuse before native invocation and cannot write outside source", async () => {
  const f = await convergenceFixture();
  try {
    const outside = join(f.root, "outside");
    await mkdir(outside); await mkdir(join(f.repo, ".context"));
    await symlink(outside, join(f.repo, ".context/horizon-convergence"));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /custody ancestor/);
    assert.equal(await readFile(f.calls, "utf8"), "");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
