import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readRepositoryWorkLedgers } from "../adapters/local/work-ledgers.js";

import { HOUR, hostScript, convergenceFixture } from "./horizon-convergence-fixture.js";

test("convergence refuses stale, altered, unavailable and foreign forge evidence before model invocation", async () => {
  for (const mode of ["stale-review", "altered-review", "forge-failure", "wrong-base"]) {
    const f = await convergenceFixture();
    try {
      const result = f.run(mode);
      assert.notEqual(result.status, 0, mode);
      assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
      assert.equal(await readFile(f.calls, "utf8"), "", "failed mechanical predicates spend no model calls");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("READY integration context still requires actual execution and cannot become a terminal correction receipt", async () => {
  const f = await convergenceFixture();
  try {
    const reviewCommentUrl = f.request.reviewCommentUrl.replace("101", "102");
    await writeFile(f.inputFile, JSON.stringify({ ...f.request, reviewCommentUrl, purpose: "repair-reviewed-target" }));
    const terminal = f.run("ready-review");
    assert.notEqual(terminal.status, 0);
    assert.match(terminal.stderr, /exact-head correction review/);
    assert.equal(await readFile(f.calls, "utf8"), "");
    await writeFile(f.inputFile, JSON.stringify({ ...f.request, reviewCommentUrl }));
    const resolution = f.run("ready-review");
    assert.equal(resolution.status, 0, resolution.stderr);
    assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n", "READY context does not skip live Work/Verify/Review");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    assert.equal(f.git(["rev-parse", "HEAD"]), f.head);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("convergence binds actual repository main even when PR comparison base is historical", async () => {
  for (const mode of ["historical-base", "wrong-main-ref"]) {
    const f = await convergenceFixture();
    try {
      const result = f.run(mode);
      if (mode === "wrong-main-ref") {
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(f.calls, "utf8"), "");
        assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n");
        assert.equal(f.git(["rev-parse", "MERGE_HEAD"]), f.base);
        assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
