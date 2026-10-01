// Containment proofs.
//
// A containment claim is only worth what an escape attempt proves. These tests
// try to escape and require the operating system to stop them, rather than
// asserting that a profile string was generated.
//
// Issue #11 (partial: the verifier path only). Review:
// docs/reviews/2026-08-20-stack-review.md

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MacosSandboxExecLauncher, renderProfile } from "../adapters/local/sandbox.js";
import { LocalCommandVerifierProvider } from "../adapters/local/command-verifier.js";
import { requireSandbox, SandboxUnavailableError, parseSandboxPolicy } from "../src/sandbox.js";
import { parseWorkContract, type WorkContract } from "../src/schemas.js";
import type { VerificationTarget } from "../src/verify.js";

const darwin = process.platform === "darwin";
const skipUnlessDarwin = darwin ? false : "sandbox-exec containment requires darwin";

function work(): WorkContract {
  return parseWorkContract({
    id: "work:containment",
    objective: "Prove the boundary is imposed by the operating system",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: { grants: [], requiresHumanApproval: [] },
    acceptanceCriteria: [{ id: "criterion:behavior", description: "proven", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false, explicitProviderAuthorizations: [] },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: { id: "human:owner", kind: "human" },
    createdAt: "2026-08-21T10:00:00.000Z",
  });
}

const target: VerificationTarget = {
  workspaceId: "workspace:containment",
  uri: "file:///memory/containment",
  head: "0".repeat(40),
  digest: `sha256:${"0".repeat(64)}`,
  digestScope: {
    algorithm: "sha256",
    strategy: "execution-root-content",
    exclusions: [".git"],
    fileCount: 0,
    totalBytes: 0,
    symlinkCount: 0,
  },
  changedPaths: [],
};

function request(root: string, command: string, args: string[]) {
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
    check: {
      id: "check:containment",
      providerId: "verifier:local-command",
      description: "containment probe",
      criterionIds: [],
      requirementIds: [],
      config: { command, args, expectedExitCodes: [0], timeoutMs: 20_000 },
    },
  };
}

// Platform-independent proof that the verifier USES the launcher it was given.
//
// The sandbox-exec tests below prove the BOUNDARY, and they can only run on
// darwin. On every other platform they skip, which means the wiring itself
// would be unproven there: remove the wrapping and a skipped test still passes.
// This test proves the wiring on every platform by handing the verifier a
// launcher that rewrites the argv to something observable.
test("the verifier executes the launcher's rewritten command, not the original", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rhiz-wrap-")));
  const marker = join(root, "WRAPPED.txt");
  let wrapCalls = 0;
  let disposeCalls = 0;
  const recording = {
    id: "sandbox:recording",
    available: async () => true,
    wrap: async () => {
      wrapCalls += 1;
      return {
        command: "/bin/sh",
        args: ["-c", `echo wrapped > ${marker}`],
        dispose: async () => { disposeCalls += 1; },
      };
    },
  };
  const provider = new LocalCommandVerifierProvider({ sandbox: recording, requireContainment: true });
  try {
    // The check asks to write ORIGINAL.txt. If the verifier honours the
    // launcher, WRAPPED.txt appears and ORIGINAL.txt does not.
    const result = await provider.verify(
      request(root, "/bin/sh", ["-c", `echo original > ${join(root, "ORIGINAL.txt")}`]),
    );
    assert.equal(wrapCalls, 1, "the verifier never asked the launcher to wrap the command");
    assert.equal(result.status, "pass");
    assert.equal(existsSync(marker), true, "the verifier did not execute the rewritten command");
    assert.equal(
      existsSync(join(root, "ORIGINAL.txt")),
      false,
      "the verifier executed the original command, so the sandbox wrapping was bypassed",
    );
    // Wrapping writes a profile to disk. Without this the cleanup in
    // command-verifier.ts could be removed and every check would leak one
    // generated profile with no test objecting.
    assert.equal(disposeCalls, 1, "the wrapping artifact was never disposed");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a contained check cannot write outside its execution root", { skip: skipUnlessDarwin }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rhiz-contain-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "rhiz-outside-")));
  const provider = new LocalCommandVerifierProvider({
    sandbox: new MacosSandboxExecLauncher(),
    requireContainment: true,
  });
  try {
    const escapeTarget = join(outside, "ESCAPED.txt");
    const result = await provider.verify(request(root, "/bin/sh", ["-c", `echo escaped > ${escapeTarget}`]));

    assert.equal(result.status, "fail", "a check that could not perform its write must not pass");
    assert.equal(existsSync(escapeTarget), false, "the contained process wrote outside its execution root");
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a contained check cannot write to the operator home directory", { skip: skipUnlessDarwin }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rhiz-contain-home-")));
  const provider = new LocalCommandVerifierProvider({
    sandbox: new MacosSandboxExecLauncher(),
    requireContainment: true,
  });
  const marker = join(process.env["HOME"] ?? "/root", ".rhiz-containment-escape-probe");
  try {
    const result = await provider.verify(request(root, "/bin/sh", ["-c", `echo escaped > ${marker}`]));
    assert.equal(result.status, "fail");
    assert.equal(existsSync(marker), false, "the contained process reached the operator home directory");
  } finally {
    rmSync(marker, { force: true });
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a contained check can still do its work inside the execution root", { skip: skipUnlessDarwin }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rhiz-contain-ok-")));
  const provider = new LocalCommandVerifierProvider({
    sandbox: new MacosSandboxExecLauncher(),
    requireContainment: true,
  });
  try {
    // Containment that also blocks the legitimate work is the failure mode most
    // likely to get containment switched off, so prove the allowed case too.
    const result = await provider.verify(request(root, "/bin/sh", ["-c", `echo ok > ${join(root, "artifact.txt")}`]));
    assert.equal(result.status, "pass");
    assert.equal(existsSync(join(root, "artifact.txt")), true);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requiring containment with no launcher is an error, never an unconfined run", async () => {
  await assert.rejects(
    () => requireSandbox(null, parseSandboxPolicy({ writableRoots: [] }), "/bin/sh", ["-c", "true"]),
    SandboxUnavailableError,
  );

  const unavailable = {
    id: "sandbox:never-available",
    available: async () => false,
    wrap: async () => { throw new Error("must not be reached"); },
  };
  await assert.rejects(
    () => requireSandbox(unavailable, parseSandboxPolicy({ writableRoots: [] }), "/bin/sh", ["-c", "true"]),
    SandboxUnavailableError,
  );
});

test("a profile denies by default and quotes every path it admits", () => {
  const profile = renderProfile(
    parseSandboxPolicy({ writableRoots: [], allowNetwork: false }),
    ["/private/tmp/some dir/with\"quote"],
  );
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.doesNotMatch(profile, /\(allow network\*\)/);
  // The path is quoted, so a directory name cannot terminate the s-expression
  // and inject a rule of its own.
  assert.match(profile, /\(allow file-write\* \(subpath "\/private\/tmp\/some dir\/with\\"quote"\)\)/);
});

test("an unresolvable writable root is refused rather than silently matching nothing", { skip: skipUnlessDarwin }, async () => {
  const launcher = new MacosSandboxExecLauncher();
  await assert.rejects(
    () => launcher.wrap(
      parseSandboxPolicy({ writableRoots: ["/this/path/does/not/exist/anywhere"] }),
      "/bin/sh",
      ["-c", "true"],
    ),
    /could not be resolved/,
  );
});
