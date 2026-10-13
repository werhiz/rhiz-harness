import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm, cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRepositoryWorkLedgers } from "../adapters/local/work-ledgers.js";
import { convergenceFixture } from "./horizon-convergence-fixture.js";

test("retained observations use complete private file bytes and bound failure after actual scripted Review", async () => {
  for (const mode of ["retainer-file", "retainer-timeout"]) {
    const f = await convergenceFixture();
    try {
      f.git(["merge", "--abort"]); f.git(["checkout", "-q", "main"]);
      for (const name of ["helper.txt", "evidence-helper.txt"]) await writeFile(join(f.repo, name), "main helper\n" + "preserved coordination\n".repeat(32_000));
      f.git(["add", "."]); f.git(["commit", "-qm", "accepted large source legs"]); f.git(["push", "-qu", "origin", "main"]);
      const main = f.git(["rev-parse", "HEAD"]), gh = join(f.root, "bin", "gh");
      await writeFile(gh, (await readFile(gh, "utf8")).replaceAll(f.base, main));
      f.git(["checkout", "-q", "feature"]); assert.throws(() => f.git(["merge", "--no-commit", "origin/main"]));
      const patch = f.request.patch + ["helper.txt", "evidence-helper.txt"].map(name => `--- a/${name}\n+++ b/${name}\n@@ -1,2 +1,2 @@\n-main helper\n+main helper adapted\n preserved coordination\n`).join("");
      await writeFile(f.inputFile, JSON.stringify({ ...f.request, paths: ["source.txt", "helper.txt", "evidence-helper.txt"], patch }));
      const result = f.run(mode), events = (await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events);
      if (!events.some(event => event.type === "review.result")) { const retained = await mkdtemp(join(tmpdir(), "rhiz-retainer-control-failure-")); await cp(f.root, retained + "/fixture", { recursive: true }); console.error("Retained actual pre-review failure fixture: " + retained); }
      assert.ok(events.some(event => event.type === "review.result"), "actual scripted part/final Review completed before retention: " + result.stderr);
      if (mode === "retainer-file") assert.equal(result.status, 0, result.stderr);
      const records = (await readFile(f.calls + ".retention", "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const large = records.find(record => record.bytes > 5 * 1024 * 1024); assert.ok(large, "complete actual prompts/ranges exceed 5 MiB");
      assert.equal(large.regular, true); assert.equal(large.mode, 0o600); assert.equal(existsSync(large.file), false, "temporary bytes are cleaned on success or timeout");
      if (mode === "retainer-file") {
        const evidence = events.flatMap(event => event.evidence).find(entry => entry.id === "convergence:review-observation")!;
        const bytes = execFileSync("git", ["show", evidence.uri!.slice(4)], { cwd: f.repo, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(createHash("sha256").update(bytes).digest("hex"), large.digest); assert.equal(evidence.digest, large.digest);
      } else {
        assert.notEqual(result.status, 0); assert.match(result.stderr, /ETIMEDOUT/); assert.ok(Date.now() - large.started < 39_000);
        assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original); assert.ok(!events.some(event => event.evidence.some(entry => entry.id === "convergence:effect")));
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
