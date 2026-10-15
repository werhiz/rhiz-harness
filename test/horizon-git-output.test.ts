import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const MAX_BUFFER = 64 * 1024 * 1024;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("captureSourceState hashes complete large Git output and refuses overflow", async () => {
  const root = mkdtempSync(join(tmpdir(), "horizon-git-output-"));
  const aliasPath = `${root}.alias.mjs`;
  const files = join(root, "files");
  mkdirSync(files);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Horizon fixture",
    GIT_AUTHOR_EMAIL: "horizon@example.invalid",
    GIT_COMMITTER_NAME: "Horizon fixture",
    GIT_COMMITTER_EMAIL: "horizon@example.invalid",
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, maxBuffer: MAX_BUFFER });
  try {
    git(["init", "-q", "--initial-branch=main"]);
    const names = Array.from({ length: 10_000 }, (_, index) => `index-entry-${String(index).padStart(5, "0")}-${"x".repeat(112)}.txt`);
    for (const name of names) writeFileSync(join(files, name), "fixture\n");
    git(["add", "--all"]);
    git(["commit", "-q", "-m", "large tracked index"]);

    const rawIndex = git(["ls-files", "--stage", "-z"]);
    assert.ok(rawIndex.byteLength > 1024 * 1024, `fixture index was only ${rawIndex.byteLength} bytes`);
    const horizon = await import(pathToFileURL(resolve("scripts/horizon.mjs")).href);
    const clean = horizon.captureSourceState(root, "main");
    assert.equal(clean.indexDigest, sha(rawIndex), "source capture hashes the complete NUL-delimited index bytes");

    const sourcePath = resolve("scripts/horizon.mjs");
    symlinkSync(sourcePath, aliasPath);
    const runCheck = (script: string) => spawnSync(process.execPath, [script, "check", "--repo", root, "--integration-ref", "main", "--json"], { cwd: root, encoding: "utf8" });
    const direct = runCheck(sourcePath);
    const throughAlias = runCheck(aliasPath);
    assert.equal(direct.error, undefined);
    assert.equal(throughAlias.error, undefined);
    assert.notEqual(direct.stdout, "", "the direct executable produces its documented command output");
    assert.equal(throughAlias.status, direct.status);
    assert.equal(throughAlias.stdout, direct.stdout, "a symlinked CLI entry executes the same command");

    for (const name of names) writeFileSync(join(files, name), "changed fixture\n");
    const rawStatus = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    assert.ok(rawStatus.byteLength > 1024 * 1024, `fixture status was only ${rawStatus.byteLength} bytes`);
    const dirty = horizon.captureSourceState(root, "main");
    assert.equal(dirty.statusDigest, sha(rawStatus), "source capture hashes the complete NUL-delimited status bytes");
    assert.throws(() => horizon.captureSourceState(root, "main", 1024 * 1024), { code: "ENOBUFS" });

    git(["checkout", "--", "."]);
    assert.throws(() => horizon.captureSourceState(root, "main", 1024 * 1024), { code: "ENOBUFS" });
  } finally {
    rmSync(aliasPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
