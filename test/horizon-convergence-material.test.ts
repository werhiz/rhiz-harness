import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readRepositoryWorkLedgers } from "../adapters/local/work-ledgers.js";

import { HOUR, hostScript, convergenceFixture } from "./horizon-convergence-fixture.js";

test("convergence delivers whole independent review material and requires its raw identity before effects", async () => {
  const f = await convergenceFixture();
  try {
    const result = f.run("requires-material");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { readRepositoryWorkLedgers } = await import("../adapters/local/work-ledgers.js");
    const reading = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    const events = reading.ledgers.flatMap((ledger) => ledger.events);
    const review = events.find((event) => event.type === "review.result");
    assert.ok(review?.evidence.some((entry) => entry.id.startsWith("review-material:") && entry.uri?.startsWith("git:") && entry.digest?.length === 64));
    assert.ok(review?.evidence.some((entry) => entry.id.startsWith("review-material-parts:") && entry.digest?.length === 64));
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("convergence material preserves actual typed absence for an accepted-main-only helper", async () => {
  const f = await convergenceFixture();
  try {
    const request = { ...f.request, paths: ["source.txt", "helper.txt"], patch: f.request.patch + "--- a/helper.txt\n+++ b/helper.txt\n@@ -1 +1 @@\n-main helper\n+main helper adapted\n" };
    await writeFile(f.inputFile, JSON.stringify(request));
    const result = f.run("requires-material");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { readRepositoryWorkLedgers } = await import("../adapters/local/work-ledgers.js");
    const reading = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    const event = reading.ledgers.flatMap((ledger) => ledger.events).find((item) => item.evidence.some((entry) => entry.id === "convergence:review-material"));
    assert.ok(event);
    const uri = event.evidence[0]?.uri;
    assert.ok(uri);
    const material = JSON.parse(f.git(["show", uri.slice(4)]));
    assert.ok(material.blobs.some((entry: { label: string; tree: string; absent?: boolean }) => entry.label === "original:helper.txt" && entry.tree === f.head && entry.absent === true));
    assert.equal(await readFile(join(f.repo, "helper.txt"), "utf8"), "main helper adapted\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("convergence reads a production-sized real Git index beyond the default exec buffer before forge refusal", async () => {
  const f = await convergenceFixture();
  try {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: "", encoding: "utf8" }).trim();
    const entries = Array.from({ length: 12_000 }, (_, n) => `100644 ${blob}\tfixture-index-${String(n).padStart(5, "0")}-${"code".repeat(18)}.txt\n`).join("");
    execFileSync("git", ["update-index", "--index-info"], { cwd: f.repo, input: entries });
    const index = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: f.repo, maxBuffer: 64 * 1024 * 1024 });
    assert.ok(index.byteLength > 1024 * 1024, "real production boundary form exceeds default exec buffer");
    const result = f.run("forge-failure");
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /ENOBUFS/, "source snapshot must be read fully before intentional forge failure");
    assert.match(result.stderr, /gh/);
    assert.equal(await readFile(f.calls, "utf8"), "", "no provider can run on unavailable forge evidence");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
