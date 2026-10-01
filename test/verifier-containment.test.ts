// Execution-integrity regression protections for the local command verifier.
//
// Every assertion describes intended safe behavior. A failure here means the
// verifier can again be used as an execution vector, or can again record a
// verdict while the work it measured is still running.
//
// Issue #17. Review: docs/reviews/2026-08-20-stack-review.md

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FORBIDDEN_VERIFIER_ENV,
  LocalCommandVerifierProvider,
  NEUTRALIZED_VERIFIER_ENV,
  VerifierEnvironmentError,
} from "../adapters/local/command-verifier.js";
import { parseWorkContract, type WorkContract } from "../src/schemas.js";
import type { VerificationCheck, VerificationTarget } from "../src/verify.js";

function work(): WorkContract {
  return parseWorkContract({
    id: "work:containment",
    objective: "Prove the verifier contains what it runs",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: { grants: [], requiresHumanApproval: [] },
    acceptanceCriteria: [{ id: "criterion:behavior", description: "Behavior proven", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: { id: "human:owner", kind: "human" },
    createdAt: "2026-08-20T17:00:00.000Z",
  });
}

const target: VerificationTarget = {
  workspaceId: "workspace:containment",
  uri: "file:///memory/containment",
  head: "0".repeat(40),
  digest: `sha256:${"0".repeat(64)}`,
  digestScope: {
    algorithm: "sha256" as const,
    strategy: "execution-root-content" as const,
    exclusions: [".git"],
    fileCount: 0,
    totalBytes: 0,
    symlinkCount: 0,
  },
  changedPaths: [],
};

function check(config: Record<string, unknown>, id = "check:containment"): VerificationCheck {
  return {
    id,
    providerId: "verifier:local-command",
    description: "Containment check",
    criterionIds: [],
    requirementIds: [],
    config,
  };
}

function request(root: string, config: Record<string, unknown>) {
  return {
    work: work(),
    contractRevision: 1,
    workspace: {
      leaseId: "lease:containment",
      workspaceId: "workspace:containment",
      uri: "file:///memory/containment",
      executionRoot: root,
      baseRevision: "0".repeat(40),
      mode: "isolated-write" as const,
    },
    target,
    check: check(config),
  };
}

test("a timed-out check kills the whole process group instead of leaking its children", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-containment-"));
  const provider = new LocalCommandVerifierProvider();
  try {
    const sentinel = join(root, "orphan-wrote-this.txt");
    // A grandchild that waits, then writes. If the verifier signals only the
    // direct child, this survives and mutates the workspace after the verdict.
    const childPath = join(root, "grandchild.js");
    writeFileSync(
      childPath,
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'orphan'), 1500);`,
    );
    const scriptPath = join(root, "forker.js");
    writeFileSync(
      scriptPath,
      [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, [${JSON.stringify(childPath)}], { stdio: 'ignore' });`,
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
    );

    const result = await provider.verify(request(root, {
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 400,
      expectedExitCodes: [0],
    }));

    assert.equal(result.status, "fail", "a timed-out check can never pass");
    assert.match(result.summary, /timed out|live process group/);

    // Give the orphan longer than its own delay to write, if it survived.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(
      existsSync(sentinel),
      false,
      "a child of the timed-out check survived and kept writing to the workspace",
    );
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the checked process never inherits code-injection environment variables", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-containment-env-"));
  const provider = new LocalCommandVerifierProvider();
  const previous = process.env["NODE_OPTIONS"];
  try {
    // Simulate an operator shell that carries a loader flag.
    process.env["NODE_OPTIONS"] = "--title=leaked";
    const out = join(root, "env.json");
    const scriptPath = join(root, "dump.js");
    writeFileSync(
      scriptPath,
      `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));`,
    );

    const result = await provider.verify(request(root, {
      command: process.execPath,
      args: [scriptPath],
      expectedExitCodes: [0],
    }));
    assert.equal(result.status, "pass");

    const seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
    const neutralized = NEUTRALIZED_VERIFIER_ENV as Record<string, string>;
    for (const name of FORBIDDEN_VERIFIER_ENV) {
      if (Object.hasOwn(neutralized, name)) continue;
      assert.equal(seen[name], undefined, `${name} reached the checked process`);
    }
    // The neutralized set is present at exactly its safe value, never inherited.
    for (const [name, value] of Object.entries(neutralized)) {
      assert.equal(seen[name], value, `${name} must be forced to its safe value`);
    }
    // HOME is present but is a scratch directory, never the operator's home.
    assert.equal(seen["HOME"], provider.homeDirectory);
    assert.notEqual(seen["HOME"], process.env["HOME"]);

  } finally {
    if (previous === undefined) delete process.env["NODE_OPTIONS"];
    else process.env["NODE_OPTIONS"] = previous;
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an operator cannot re-introduce a forbidden variable through overrides", () => {
  for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "GIT_SSH_COMMAND"]) {
    assert.throws(
      () => new LocalCommandVerifierProvider({ environment: { [name]: "anything" } }),
      VerifierEnvironmentError,
      `${name} must be refused as an override`,
    );
  }
});

test("the scratch home is disposable and removed on close", async () => {
  const provider = new LocalCommandVerifierProvider();
  const home = provider.homeDirectory;
  assert.equal(existsSync(home), true);
  await provider.close();
  assert.equal(existsSync(home), false);
});
