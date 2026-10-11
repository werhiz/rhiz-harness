import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const HOUR = 60 * 60 * 1000;
const hostScript = resolve("scripts/horizon.mjs");

// Fresh repositories and a local bare remote exercise real measurement and
// durability. Only the external forge transport is controlled by this fixture.
test("host requires an open exact-pushed-head review for bounded-age corrections", async () => {
  const root = await mkdtemp(join(tmpdir(), "horizon-review-host-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  await Promise.all([mkdir(repo), mkdir(bin)]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Horizon", GIT_AUTHOR_EMAIL: "horizon@example.invalid", GIT_COMMITTER_NAME: "Horizon", GIT_COMMITTER_EMAIL: "horizon@example.invalid" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    execFileSync("git", ["init", "--bare", "-q", remote]);
    git(["init", "-q", "--initial-branch=main"]);
    await writeFile(join(repo, "base.txt"), "base\n");
    await writeFile(join(repo, "historical-only.txt"), "old\n".repeat(1000));
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    const olderBase = git(["rev-parse", "HEAD"]);
    await rm(join(repo, "historical-only.txt"));
    git(["add", "."]);
    git(["commit", "-qm", "current integration base"]);
    const baseHead = git(["rev-parse", "HEAD"]);
    git(["remote", "add", "origin", remote]);
    git(["push", "-qu", "origin", "main"]);
    git(["checkout", "-qb", "feature"]);
    await writeFile(join(repo, "feature.txt"), "line\n".repeat(500));
    git(["add", "."]);
    const when = new Date(Date.now() - 25.6 * HOUR).toISOString();
    execFileSync("git", ["commit", "-q", "-m", "reviewed change"], { cwd: repo, env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
    git(["push", "-qu", "origin", "feature"]);
    const head = git(["rev-parse", "HEAD"]);
    const calls = join(root, "forge-calls.txt");
    await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.FORGE_CALLS,'called\\n');if(process.env.FORGE_MODE==='failure')process.exit(1);console.log(JSON.stringify({number:4375,state:process.env.FORGE_MODE==='closed'?'CLOSED':'OPEN',headRefOid:process.env.FORGE_MODE==='wrong-head'?'0'.repeat(40):process.env.FORGE_HEAD}));\n`, { mode: 0o755 });
    const check = (mode: string) => {
      const childEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), FORGE_MODE: mode, FORGE_HEAD: head, FORGE_CALLS: calls };
      delete (childEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: childEnv, encoding: "utf8" });
      assert.equal(result.error, undefined);
      return { status: result.status, payload: JSON.parse(result.stdout) };
    };
    const accepted = check("open");
    assert.equal(accepted.status, 0);
    assert.equal(accepted.payload.state, "in_review");
    assert.ok(accepted.payload.signals.divergenceAgeMs > 25 * HOUR);
    for (const mode of ["closed", "wrong-head", "failure"]) {
      const refused = check(mode);
      assert.equal(refused.status, 1, mode);
      assert.equal(refused.payload.state, "tripped", mode);
    }
    // A local head behind its upstream is durable, but is not the reviewed head.
    git(["checkout", "-qb", "remote-ahead"]);
    await writeFile(join(repo, "remote-only.txt"), "new reviewed head\n");
    git(["add", "remote-only.txt"]);
    git(["commit", "-qm", "remote ahead"]);
    const otherHead = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/feature", otherHead]);
    git(["checkout", "-q", "feature"]);
    const mismatchEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), FORGE_MODE: "open", FORGE_HEAD: otherHead, FORGE_CALLS: calls };
    delete (mismatchEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
    const mismatch = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: mismatchEnv, encoding: "utf8" });
    assert.equal(mismatch.status, 1, "forge and upstream agreement cannot substitute for exact local head");
    assert.equal(JSON.parse(mismatch.stdout).state, "tripped");
    git(["update-ref", "refs/remotes/origin/feature", head]);
    const reviewPath = join(repo, ".rhiz-horizon-reviews.json");
    await writeFile(reviewPath, JSON.stringify({ reviews: { feature: { change: 4375, anchorDiffLines: 400, recordedAt: when } } }));
    assert.equal(check("open").status, 1, "inclusive 125% bound still refuses");
    // A real review of this newer exact head is a distinct convergence round.
    const commentUrl = "https://github.com/example/project/pull/4375#issuecomment-123";
    const comment = { id: 123, html_url: commentUrl, issue_url: "https://api.github.com/repos/example/project/issues/4375", author_association: "MEMBER", user: { login: "independent-checker" }, body: `## NOT READY at ${head}\n\n<!-- rhiz-review-agent -->\nIndependent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${head}\`.\n\nRequired authority repair.` };
    await writeFile(join(bin, "gh"), `#!${process.execPath}\nif(process.env.FORGE_MODE==='failure')process.exit(1);if(process.argv[2]==='api'){const c=JSON.parse(process.env.FORGE_COMMENT);if(process.env.FORGE_MODE==='bad-body')c.body='no reviewed head';if(process.env.FORGE_MODE==='untrusted')c.author_association='NONE';console.log(JSON.stringify(c));}else{console.log(JSON.stringify({number:4375,state:process.env.FORGE_MODE==='closed'?'CLOSED':'OPEN',headRefOid:process.env.FORGE_HEAD,baseRefOid:'${baseHead}',url:'https://github.com/example/project/pull/4375'}));}\n`, { mode: 0o755 });
    const receiptEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), FORGE_HEAD: head, FORGE_COMMENT: JSON.stringify(comment) };
    delete (receiptEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
    const record = (mode: string, url = commentUrl, integration = "origin/main") => spawnSync(process.execPath, [hostScript, "converge", "--repo", repo, "--integration-ref", integration, "--review-receipt", url], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: mode }, encoding: "utf8" });
    const original = await readFile(reviewPath, "utf8");
    for (const mode of ["bad-body", "untrusted", "closed", "failure"]) {
      assert.notEqual(record(mode).status, 0, mode);
      assert.equal(await readFile(reviewPath, "utf8"), original, "invalid receipt cannot alter an anchor");
    }
    assert.notEqual(record("open", "https://github.com/other/project/pull/4375#issuecomment-123").status, 0);
    assert.equal(await readFile(reviewPath, "utf8"), original);
    const dry = spawnSync(process.execPath, [hostScript, "converge", "--repo", repo, "--review-receipt", commentUrl, "--dry-run"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(await readFile(reviewPath, "utf8"), original, "dry run preserves all anchors");
    assert.notEqual(record("open", commentUrl, olderBase).status, 0, "recording cannot choose an older base than the forge");
    assert.equal(await readFile(reviewPath, "utf8"), original);
    const recorded = record("open");
    assert.equal(recorded.status, 0, recorded.stderr);
    const rounds = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.equal(rounds.reviews.feature.anchorDiffLines, 400, "first anchor remains unchanged");
    assert.equal(rounds.reviews.feature.correctionReceipts.length, 1);
    assert.equal(rounds.reviews.feature.correctionReceipts[0].head, head);
    assert.equal(rounds.reviews.feature.correctionReceipts[0].anchorDiffLines, 500);
    assert.equal(record("open").status, 0, "identical receipt replay is idempotent");
    assert.equal(JSON.parse(await readFile(reviewPath, "utf8")).reviews.feature.correctionReceipts.length, 1);
    const roundCheck = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(roundCheck.status, 0, roundCheck.stderr);
    assert.equal(JSON.parse(roundCheck.stdout).decision.anchorDiffLines, 500);
    const pinnedRound = await readFile(reviewPath, "utf8");
    rounds.reviews.feature.correctionReceipts[0].anchorDiffLines = 50_000;
    await writeFile(reviewPath, JSON.stringify(rounds));
    const forgedAnchor = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(forgedAnchor.status, 1, "cached size cannot exceed the measured reviewed commit");
    await writeFile(reviewPath, pinnedRound);
    rounds.reviews.feature.correctionReceipts[0].integrationHead = olderBase;
    rounds.reviews.feature.correctionReceipts[0].anchorDiffLines = 1500;
    await writeFile(reviewPath, JSON.stringify(rounds));
    const forgedBase = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(forgedBase.status, 1, "changing both cached base and size cannot increase the correction round");
    await writeFile(reviewPath, pinnedRound);
    const invalidated = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "bad-body" }, encoding: "utf8" });
    assert.equal(invalidated.status, 1, "a receipt edited on the forge stops granting correction authority");
    await writeFile(join(repo, "unpushed.txt"), "not durable\n");
    git(["add", "unpushed.txt"]);
    git(["commit", "-qm", "not pushed"]);
    const callsBefore = await readFile(calls, "utf8");
    const unpushed = check("open");
    assert.equal(unpushed.status, 1);
    assert.ok(unpushed.payload.decision.reasons.some((reason: { signal: string }) => reason.signal === "upstreamState"));
    assert.equal(await readFile(calls, "utf8"), callsBefore, "durability refuses before consulting forge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
