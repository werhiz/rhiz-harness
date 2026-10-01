import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalCommandVerifierProvider } from "../adapters/local/command-verifier.js";
import type { CrewWorkspace } from "../src/crew.js";
import { parseWorkContract } from "../src/schemas.js";
import { human, testDigestScope } from "./helpers.js";

function work() {
  return parseWorkContract({
    id: "work:command",
    objective: "Run deterministic local command verification",
    type: "SHIP",
    scope: [{ uri: "repo://command", kind: "repository" }],
    writeScope: [{ uri: "repo://command/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [{ action: "read", resources: [{ uri: "repo://command", kind: "repository" }], constraints: [] }],
      requiresHumanApproval: ["write", "publish"],
    },
    acceptanceCriteria: [{ id: "criterion:command", description: "Command behaves as expected", required: true }],
    requiredEvidence: [{ id: "requirement:test", description: "Test evidence", acceptedKinds: ["test"], required: true }],
    context: { strategy: "minimal", resources: [], includeHistory: false },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-08-20T17:00:00.000Z",
  });
}

function request(root: string, input: { id?: string; negativeControlFor?: string; config: Record<string, unknown> }) {
  const workspace: CrewWorkspace = {
    leaseId: "lease:command",
    workspaceId: "workspace:command",
    uri: "file:///tmp/command",
    executionRoot: root,
    baseRevision: "abc123",
    mode: "read-only",
  };
  return {
    work: work(),
    contractRevision: 1,
    workspace,
    target: {
      workspaceId: workspace.workspaceId,
      uri: workspace.uri,
      head: workspace.baseRevision,
      digest: "sha256:command-target",
      digestScope: testDigestScope,
      changedPaths: [],
    },
    check: {
      id: input.id ?? "check:command",
      providerId: "verifier:local-command",
      description: "command check",
      criterionIds: [],
      requirementIds: [],
      config: input.config,
      ...(input.negativeControlFor === undefined ? {} : {
        negativeControlFor: input.negativeControlFor,
        perturbation: {
          kind: "overwrite-file" as const,
          path: "src/subject.ts",
          content: "export const broken = true;\n",
          description: "subject replaced so the command has a known failure to detect",
        },
      }),
    },
  };
}

test("local command verifier runs explicit argv without a shell and emits digest evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-verifier-"));
  const provider = new LocalCommandVerifierProvider({ now: () => "2026-08-20T17:00:00.000Z" });
  try {
    const result = await provider.verify(request(root, {
      config: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('verified')"],
        expectedExitCodes: [0],
        evidenceKind: "test",
      },
    }));
    assert.equal(result.status, "pass");
    assert.match(result.summary, /exit 0/);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]!.kind, "test");
    assert.match(result.evidence[0]!.digest!, /^sha256:/);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local command verifier supports a real negative control through expected failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-control-"));
  const provider = new LocalCommandVerifierProvider();
  try {
    const result = await provider.verify(request(root, {
      id: "check:negative-control",
      negativeControlFor: "check:primary",
      config: {
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        expectedExitCodes: [3],
        evidenceKind: "test",
      },
    }));
    assert.equal(result.status, "pass");
    assert.match(result.summary, /exit 3; expected 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected exit and missing executable fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-failure-"));
  const provider = new LocalCommandVerifierProvider();
  try {
    const unexpected = await provider.verify(request(root, {
      config: { command: process.execPath, args: ["-e", "process.exit(4)"], expectedExitCodes: [0] },
    }));
    assert.equal(unexpected.status, "fail");

    const missing = await provider.verify(request(root, {
      id: "check:missing",
      config: { command: "rhiz-command-that-does-not-exist", expectedExitCodes: [0] },
    }));
    assert.equal(missing.status, "error");
    assert.equal(missing.evidence.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command timeout produces a failed bounded receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-timeout-"));
  const provider = new LocalCommandVerifierProvider();
  try {
    const result = await provider.verify(request(root, {
      id: "check:timeout",
      config: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        expectedExitCodes: [0],
        timeoutMs: 100,
      },
    }));
    assert.equal(result.status, "fail");
    assert.match(result.summary, /timed out/);
    assert.equal(result.evidence.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
