import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { GitCandidateIdentityProbe } from "../../adapters/git/candidate-identity.js";
import { TempDirectoryDerivativeFactory, runDisposableProof } from "../../src/disposable.js";

test("the falsifiability gate rejects a disposable candidate with the guarded-mediation manifest entry removed", async () => {
  let mutatedManifestPath = "";
  const receipt = await runDisposableProof({
    candidateRoot: process.cwd(),
    probe: new GitCandidateIdentityProbe(),
    factory: new TempDirectoryDerivativeFactory(),
    mutate: async (derivative) => {
      const manifestPath = derivative.resolve("scripts/guard-manifest.json");
      mutatedManifestPath = manifestPath;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { guards: Array<{ id: string }> };
      const remaining = manifest.guards.filter((guard) => guard.id !== "worker/guarded-tool-mediation");
      assert.equal(remaining.length, manifest.guards.length - 1, "candidate did not declare guarded tool mediation as a falsifiable guard");
      await derivative.mutate("scripts/guard-manifest.json", `${JSON.stringify({ guards: remaining }, null, 2)}\n`, "remove guarded mediation guard");
    },
    proof: async (derivative) => {
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "scripts/check-guard-falsifiability.mjs"),
          "--manifest",
          mutatedManifestPath,
          "--only",
          "worker/guarded-tool-mediation",
        ],
        { cwd: derivative.root, encoding: "utf8" },
      );
      return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
    },
  });

  if (receipt.outcome !== "proven") {
    assert.fail(
      `the candidate did not survive this proof unchanged (${receipt.invalidations.map((item) => item.code).join(", ")}); `
      + "nothing in this run is a statement about the manifest",
    );
  }
  assert.notEqual(receipt.result.status, 0, "the falsifiability gate accepted a manifest with no mediation guard");
  assert.match(receipt.result.output, /required guard.*worker\/guarded-tool-mediation/i);
});


test("the falsifiability gate refuses to call a guard proven when its falsifier cannot pass unmutated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhiz-guard-control-"));
  try {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "scripts/guard-manifest.json"), "utf8"),
    ) as { guards: Array<{ id: string; file: string; remove: string; testFile: string; why: string }> };
    const guard = manifest.guards.find((entry) => entry.id === "worker/guarded-tool-mediation");
    assert.ok(guard, "candidate did not declare guarded tool mediation as a falsifiable guard");

    // The falsifier cannot run at all, so its red result says nothing about
    // the guard. A gate that accepted it would report every such guard proven.
    const manifestPath = join(directory, "guard-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ guards: [{ ...guard, testFile: "dist/test/no-such-falsifier.test.js" }] }, null, 2)}\n`,
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/check-guard-falsifiability.mjs"),
        "--manifest",
        manifestPath,
        "--only",
        guard.id,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(
      output,
      /disposable proof was invalidated/,
      `the candidate changed while the gate was running, so this run judged nothing:\n${output}`,
    );
    assert.notEqual(result.status, 0, `the gate accepted a guard whose falsifier never passes:\n${output}`);
    assert.match(output, /does not pass in an unmutated derivative/);
    assert.doesNotMatch(output, /\bproven\b/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
