import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readRepositoryWorkLedgers } from "../adapters/local/work-ledgers.js";

import { HOUR, hostScript, convergenceFixture } from "./horizon-convergence-fixture.js";

test("remote artifacts retain complete packet and projected objects; interrupted effects recover without reapplying", async () => {
  const f = await convergenceFixture();
  try {
    const interrupted = f.run("crash-after-add");
    assert.equal(interrupted.signal, "SIGKILL");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    const records = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    assert.equal(records.unreadable.length, 0);
    const events = records.ledgers.flatMap(item => item.events);
    const intentEvent = events.find(event => event.evidence.some(entry => entry.id === "convergence:intent"));
    assert.ok(intentEvent);
    assert.ok(!events.some(event => event.evidence.some(entry => entry.id === "convergence:effect")));
    const intentEvidence = intentEvent.evidence.find(entry => entry.id === "convergence:intent")!;
    const intentHead = /^git:([^:]+):artifact.json$/.exec(intentEvidence.uri!)![1];
    const fresh = join(f.root, "fresh");
    execFileSync("git", ["clone", "-q", "--no-local", f.remote, fresh]);
    const freshGit = (args: string[]) => execFileSync("git", args, { cwd: fresh, encoding: "utf8" }).trim();
    const refs = f.git(["ls-remote", "origin", "refs/rhiz/work/*/intent"]).split("\n").map(row => row.split("\t")[1]);
    assert.equal(refs.length, 1);
    freshGit(["fetch", "-q", "origin", refs[0]!]);
    const intent = JSON.parse(freshGit(["show", `${intentHead}:artifact.json`]));
    assert.equal(intent.packet.request.patch, f.request.patch);
    const reviewMaterial = JSON.parse(freshGit(["show", `${intent.reviewMaterial.head}:artifact.json`]));
    for (const entry of reviewMaterial.blobs.filter((item: { blob?: string }) => item.blob)) assert.ok(freshGit(["cat-file", "blob", entry.blob]));
    const semanticBytes = freshGit(["show", `${intent.reviewObservation.head}:artifact.json`]);
    const semantic = JSON.parse(semanticBytes);
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(semanticBytes).digest("hex"), intent.reviewObservation.digest);
    assert.equal(semantic.parts[0].result.verdict.status, "pass");
    assert.ok(semantic.parts[0].prompt.includes("original:source.txt"));
    assert.ok(semantic.parts[0].prompt.includes("accepted-main:source.txt"));
    assert.equal(semantic.candidateHead, intent.artifactHead);
    const { validateReviewObservation } = await import(new URL(hostScript.replace("horizon.mjs", "rhiz-harness.mjs"), "file:").href);
    const expected = { workId: intent.workId, revision: 1, head: intent.artifactHead, materialDigest: intent.reviewMaterial.digest };
    assert.doesNotThrow(() => validateReviewObservation(semantic, intent.receipt.reviewCoverage, expected));
    assert.throws(() => validateReviewObservation({ ...semantic, parts: [] }, intent.receipt.reviewCoverage, expected));
    const altered = structuredClone(semantic); altered.parts[0].result.verdict.summary += "forged";
    assert.throws(() => validateReviewObservation(altered, intent.receipt.reviewCoverage, expected));
    const replayed = structuredClone(semantic); replayed.candidateHead = "0".repeat(40);
    assert.throws(() => validateReviewObservation(replayed, intent.receipt.reviewCoverage, expected));

    assert.equal(freshGit(["rev-parse", `${intent.packet.projected.tree}^{tree}`]), intent.packet.projected.tree);
    assert.equal(freshGit(["show", `${intent.packet.projected.tree}:source.txt`]), "resolved");
    const calls = await readFile(f.calls, "utf8");
    await writeFile(join(f.repo, "extra-untracked.txt"), "divergent");
    assert.notEqual(f.recover(intent.workId).status, 0, "foreign source state cannot be reconstructed as the reviewed effect");
    await rm(join(f.repo, "extra-untracked.txt"));
    const recovered = f.recover(intent.workId);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).recovered, true);
    assert.equal(await readFile(f.calls, "utf8"), calls, "readback recovery does not invoke a worker or reapply source");
    const afterEvents = (await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events);
    const effect = afterEvents.find(event => event.evidence.some(entry => entry.id === "convergence:effect"))!;
    assert.ok(effect);
    const effectUri = effect.evidence.find(entry => entry.id === "convergence:effect")!.uri!;
    const effectHead = /^git:([^:]+):artifact.json$/.exec(effectUri)![1];
    const receipt = JSON.parse(f.git(["show", `${effectHead}:artifact.json`]));
    assert.equal(receipt.sourceAfter, JSON.parse(recovered.stdout).sourceAfter);
    assert.notEqual(f.recover(intent.workId).status, 0, "completed recovery cannot produce another effect receipt");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recovery refuses a recorded intent whose source effect never ran", async () => {
  const f = await convergenceFixture();
  try {
    const interrupted = f.run("crash-before-apply");
    assert.equal(interrupted.signal, "SIGKILL");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
    const events = (await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events);
    const intent = events.find(event => event.evidence.some(entry => entry.id === "convergence:intent"))!;
    assert.ok(intent);
    assert.notEqual(f.recover(intent.workId!).status, 0);
    assert.ok(!(await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events).some(event => event.evidence.some(entry => entry.id === "convergence:effect")));
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("late interruption reuses the exact durable receipt despite operator identity changes", async () => {
  const f = await convergenceFixture();
  try {
    assert.equal(f.run("crash-after-effect-push").signal, "SIGKILL");
    const events = (await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events);
    const intent = events.find(event => event.evidence.some(entry => entry.id === "convergence:intent"))!;
    assert.ok(intent);
    assert.ok(!events.some(event => event.evidence.some(entry => entry.id === "convergence:effect")));
    const remoteBefore = f.git(["ls-remote", "origin", "refs/rhiz/work/*/effect"]);
    assert.ok(remoteBefore);
    f.git(["config", "user.name", "Changed operator"]); f.git(["config", "user.email", "changed@example.invalid"]);
    const recovered = f.recover(intent.workId!, true);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(f.git(["ls-remote", "origin", "refs/rhiz/work/*/effect"]), remoteBefore);
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
