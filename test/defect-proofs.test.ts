// EXECUTION INTEGRITY REGRESSION PROTECTIONS.
//
// These tests began as characterization tests that asserted the defective behavior
// found in the 2026-08-20 stack review. Each has since been inverted: every
// assertion below describes the INTENDED SAFE behavior, and a failure here means a
// real execution-integrity guarantee has regressed.
//
// Issues: #9 workspace binding, #10 execution-root identity, #13 falsifying
// negative controls, #18 fail-closed worker classification.
//
// Review: docs/reviews/2026-08-20-stack-review.md

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitWorktreeWorkspaceProvider } from "../adapters/git/worktrees.js";
import { digestExecutionRoot } from "../src/workspace-digest.js";
import { projectBoard } from "../src/board.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import {
  parseHarnessEvent,
  parseWorkContract,
  type ActorRef,
  type HarnessEvent,
  type WorkContract,
} from "../src/schemas.js";
import {
  parseVerificationPlan,
  VerificationCheckResultSchema,
  VerificationEngine,
  VerifierCatalog,
  type VerificationCheckResult,
  type VerifierDescriptor,
  type VerifierProvider,
  type VerifierRequest,
} from "../src/verify.js";
import {
  describeWorkerProvider,
  selectWorkerProvider,
  WorkerCatalog,
  WorkerSelectionError,
  type WorkerCapabilities,
  type WorkerHandle,
  type WorkerProvider,
  type WorkerStartRequest,
} from "../src/index.js";
import { requireBoundExecutionRoot, WorkerStartRequestSchema } from "../src/host.js";
import type { CrewWorkspace, CrewWorkspaceProvider, CrewWorkspaceSnapshot, CrewWorkspaceAcquireRequest } from "../src/crew.js";

const human: ActorRef = { id: "human:owner", kind: "human" };
const boundWorkspace = {
  workspaceId: "workspace:proof",
  leaseId: "lease:proof",
  uri: "file:///memory/proof",
  executionRoot: "/memory/proof",
  mode: "isolated-write" as const,
  baseRevision: "0".repeat(40),
};
const workerActor: ActorRef = { id: "agent:shipper", kind: "agent" };
const verifierActor: ActorRef = { id: "verifier:independent", kind: "verifier" };

function contract(overrides: Record<string, unknown> = {}): WorkContract {
  return parseWorkContract({
    id: "work:proof",
    objective: "Prove an open defect",
    type: "SHIP",
    scope: [{ uri: "repo://example", kind: "repository" }],
    writeScope: [{ uri: "repo://example/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [{ action: "write", resources: [{ uri: "repo://example/src", kind: "directory" }], constraints: [] }],
      requiresHumanApproval: ["publish"],
    },
    acceptanceCriteria: [{ id: "criterion:behavior", description: "Behavior is proven", required: true }],
    requiredEvidence: [{ id: "requirement:test", description: "Passing test output", acceptedKinds: ["test"], required: true }],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-08-20T17:00:00.000Z",
    ...overrides,
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Rhiz Proof",
      GIT_AUTHOR_EMAIL: "proof@example.invalid",
      GIT_COMMITTER_NAME: "Rhiz Proof",
      GIT_COMMITTER_EMAIL: "proof@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

// ---------------------------------------------------------------------------
// Issue #10 (P0): the workspace digest is git-scoped, so it is not exact.
// ---------------------------------------------------------------------------

test("PROOF #10: an ignored-path write changes workspace identity and is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-proof-digest-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.js"), "export const value = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed"]);

    const provider = new GitWorktreeWorkspaceProvider({ repositoryRoot: root });
    try {
      const workspace = await provider.acquire({
        crewId: "crew:proof",
        work: contract(),
        baseRevision: "HEAD",
        mode: "isolated-write",
      });
      const before = await provider.snapshot(workspace);

      // A worker writes executable code into a gitignored path. This is exactly the
      // payload path a poisoned dependency would take, and it is what the verifier
      // will later load when it runs the repository's own test command.
      mkdirSync(join(workspace.executionRoot, "node_modules/evil"), { recursive: true });
      writeFileSync(join(workspace.executionRoot, "node_modules/evil/index.js"), "process.exit(0);\n");

      const after = await provider.snapshot(workspace);

      // Identity now covers the bytes that execute, so the write moves it.
      assert.notEqual(after.digest, before.digest);
      assert.ok(
        after.changedPaths.includes("node_modules/evil/index.js"),
        `expected the ignored write to be reported, got ${JSON.stringify(after.changedPaths)}`,
      );

      // The receipt must never imply more coverage than the walk provided, so the
      // scope travels with the digest and says what it skipped.
      assert.equal(after.digestScope.strategy, "execution-root-content");
      assert.deepEqual(after.digestScope.exclusions, [".git"]);
      assert.ok(after.digestScope.fileCount > 0);

      // Control, preserved from the original proof: a tracked write is still
      // detected. Without this, a digest that changed on every call for unrelated
      // reasons would satisfy the assertion above while proving nothing.
      writeFileSync(join(workspace.executionRoot, "src/index.js"), "export const value = 2;\n");
      const tracked = await provider.snapshot(workspace);
      assert.notEqual(tracked.digest, after.digest);
      assert.ok(tracked.changedPaths.includes("src/index.js"));

      // Identity is stable when nothing changes. This is what makes the two
      // assertions above evidence of detection rather than of churn.
      const repeated = await provider.snapshot(workspace);
      assert.equal(repeated.digest, tracked.digest);

      // A symlink is identified by its target, not followed. A link that points
      // outside the root must not be able to pull foreign bytes into identity.
      symlinkSync("/etc/hosts", join(workspace.executionRoot, "node_modules/escape"));
      const linked = await provider.snapshot(workspace);
      assert.notEqual(linked.digest, tracked.digest);
      assert.equal(linked.digestScope.symlinkCount, 1);
    } finally {
      await provider.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #13 (P1): negative controls must be able to falsify.
// ---------------------------------------------------------------------------

/** A verifier that cannot fail, standing in for a deleted test script. */
class AlwaysPassVerifier implements VerifierProvider {
  readonly id = "verifier:always-pass";
  readonly seen: string[] = [];
  readonly roots: string[] = [];
  async describe(): Promise<VerifierDescriptor> {
    return {
      id: this.id,
      displayName: "Always Pass",
      description: "A verifier that cannot fail, standing in for a deleted test script",
      deterministic: true,
      readOnly: true,
      evidenceKinds: ["test"],
    };
  }
  async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
    this.seen.push(request.check.id);
    this.roots.push(request.workspace.executionRoot);
    return VerificationCheckResultSchema.parse({
      checkId: request.check.id,
      providerId: this.id,
      status: "pass",
      summary: `${request.check.id} passed, as this verifier always does`,
      evidence: [{ id: `evidence:${request.check.id}`, kind: "test", digest: `sha256:${"0".repeat(64)}` }],
      startedAt: "2026-08-20T17:00:02.000Z",
      finishedAt: "2026-08-20T17:00:03.000Z",
    });
  }
  async close(): Promise<void> {}
}

/** An honest verifier: it reads a file and fails when the contents are wrong. */
class ContentVerifier implements VerifierProvider {
  readonly id = "verifier:content";
  readonly roots: string[] = [];
  async describe(): Promise<VerifierDescriptor> {
    return {
      id: this.id,
      displayName: "Content",
      description: "Passes only when src/index.js still exports the expected value",
      deterministic: true,
      readOnly: true,
      evidenceKinds: ["test"],
    };
  }
  async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
    this.roots.push(request.workspace.executionRoot);
    const source = readFileSync(join(request.workspace.executionRoot, "src/index.js"), "utf8");
    const ok = source.includes("export const value = 1;");
    return VerificationCheckResultSchema.parse({
      checkId: request.check.id,
      providerId: this.id,
      status: ok ? "pass" : "fail",
      summary: ok ? "source is intact" : "source does not export the expected value",
      evidence: [{ id: `evidence:${request.check.id}`, kind: "test", digest: `sha256:${"1".repeat(64)}` }],
      startedAt: "2026-08-20T17:00:02.000Z",
      finishedAt: "2026-08-20T17:00:03.000Z",
    });
  }
  async close(): Promise<void> {}
}

/** A workspace on a real directory, so control isolation actually has bytes to copy. */
class DirectoryWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:directory";
  readonly workspace: CrewWorkspace;
  constructor(root: string) {
    this.workspace = {
      leaseId: "lease:proof",
      workspaceId: "workspace:proof",
      uri: `file://${root}`,
      executionRoot: root,
      baseRevision: "abc123",
      mode: "isolated-write",
    };
  }
  async acquire(_request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> { return this.workspace; }
  async snapshot(workspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot> {
    const identity = await digestExecutionRoot(workspace.executionRoot);
    return {
      workspaceId: workspace.workspaceId,
      head: "abc123",
      digest: identity.digest,
      digestScope: identity.scope,
      changedPaths: ["src/index.js"],
      observedAt: "2026-08-20T17:00:00.000Z",
    };
  }
  async release(_workspaceId: string): Promise<void> {}
  async close(): Promise<void> {}
}

async function verifyWithControl(root: string, provider: VerifierProvider) {
  const ledger = new InMemoryEventLedger();
  const work = contract();
  const streamId = "stream:proof";
  let counter = 0;
  const append = async (type: HarnessEvent["type"], payload: unknown, extra: Partial<HarnessEvent> = {}) => {
    counter += 1;
    await ledger.append(parseHarnessEvent({
      id: `event:proof:${counter}`,
      type,
      schemaVersion: 1,
      streamId,
      workId: work.id,
      actor: human,
      occurredAt: "2026-08-20T17:00:00.000Z",
      recordedAt: "2026-08-20T17:00:00.000Z",
      evidence: [],
      payload,
      ...extra,
    }));
  };
  await append("work.created", { contract: work, revision: 1 });
  await append("task.created", { objective: work.objective }, { taskId: "task:proof" });
  await append("task.assigned", { worker: workerActor }, { taskId: "task:proof" });
  await append("attempt.started", { worker: workerActor, contractRevision: 1, lease: { id: "lease:proof", workspaceId: "workspace:proof", resourceClaims: [{ kind: "path" as const, resource: "src" }], acquiredAt: "2026-08-20T04:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" } }, { taskId: "task:proof", attemptId: "attempt:proof", actor: workerActor });
  // Execution evidence; the Board requires it before calling a Work done.
  await append("attempt.activity-observed", { state: "working", detail: "message: worker edited src/feature.ts", source: workerActor.id, authority: "observation" }, { taskId: "task:proof", attemptId: "attempt:proof", actor: workerActor });
  await append("guard.evaluated", {
    request: { requestId: "guard:attempt:proof", workId: "work:1", taskId: "task:proof", attemptId: "attempt:proof", actor: workerActor, writeScope: "workspace" as const, contextHash: "ctx:attempt:proof", evidenceRefs: [], timestampMs: 1787000000000, tool: { name: "worker:file-change", category: "write" as const, args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } } },
    verdict: { requestId: "guard:attempt:proof", decision: "allow" as const, rationale: "fixture write authorized", riskLevel: "medium" as const, ruleHits: ["per-category-mode:write:allow"], evaluatedAt: "2026-08-20T04:00:00.500Z", durationMs: 1, policyBackend: "rhiz-native", policyBackendVersion: "0.1.0" },
  }, { taskId: "task:proof", attemptId: "attempt:proof", actor: workerActor });
  await append("attempt.finished", { resultSummary: "done", artifactRefs: [] }, { taskId: "task:proof", attemptId: "attempt:proof", actor: workerActor });
  assert.equal(projectBoard(await ledger.replay(streamId)).state, "verifying");

  const workspaceProvider = new DirectoryWorkspaceProvider(root);
  const snapshot = await workspaceProvider.snapshot(workspaceProvider.workspace);
  let ids = 0;
  const engine = new VerificationEngine({
    ledger,
    workspaceProvider,
    verifierCatalog: new VerifierCatalog(provider),
    verifier: verifierActor,
    now: () => "2026-08-20T17:00:05.000Z",
    idFactory: () => `proof-${++ids}`,
  });

  const receipt = await engine.verify({
    streamId,
    work,
    contractRevision: 1,
    workspace: workspaceProvider.workspace,
    expectedSnapshot: snapshot,
    plan: parseVerificationPlan({
      id: "plan:proof",
      workId: work.id,
      contractRevision: 1,
      checks: [
        {
          id: "check:primary",
          providerId: provider.id,
          description: "Primary check",
          criterionIds: ["criterion:behavior"],
          requirementIds: ["requirement:test"],
          config: {},
        },
        {
          id: "check:control",
          providerId: provider.id,
          description: "Negative control, which proves the check can detect a known failure",
          negativeControlFor: "check:primary",
          perturbation: {
            kind: "overwrite-file",
            path: "src/index.js",
            content: "export const value = 999;\n",
            description: "src/index.js rewritten to export the wrong value",
          },
          config: {},
        },
      ],
    }),
  });
  return receipt;
}

test("PROOF #13: a verifier that cannot fail is rejected by its own negative control", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-proof-control-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.js"), "export const value = 1;\n");
    const canonical = await digestExecutionRoot(root);

    const provider = new AlwaysPassVerifier();
    const receipt = await verifyWithControl(root, provider);

    // The control ran, the verifier reported pass against a deliberately broken
    // copy, and that is now a failed control rather than a satisfied one.
    assert.equal(receipt.status, "fail");
    assert.notEqual(receipt.boardState, "ready");
    const control = receipt.checks.find((result: { checkId: string }) => result.checkId === "check:control")!;
    assert.equal(control.status, "fail");
    assert.match(control.summary, /did not falsify/);

    // The control executed somewhere else. The canonical target is untouched.
    const controlRoot = provider.roots[provider.roots.length - 1]!;
    assert.notEqual(controlRoot, root);
    const after = await digestExecutionRoot(root);
    assert.equal(after.digest, canonical.digest);
    assert.equal(readFileSync(join(root, "src/index.js"), "utf8"), "export const value = 1;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PROOF #13: an honest check passes its negative control", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-proof-control-ok-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.js"), "export const value = 1;\n");

    const receipt = await verifyWithControl(root, new ContentVerifier());

    // The primary passed on the real target and the same check failed on the
    // perturbed copy, which is exactly what a control is supposed to show.
    assert.equal(receipt.status, "pass");
    const control = receipt.checks.find((result: { checkId: string }) => result.checkId === "check:control")!;
    assert.equal(control.status, "pass");
    assert.match(control.summary, /negative control satisfied/);
    assert.equal(readFileSync(join(root, "src/index.js"), "utf8"), "export const value = 1;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PROOF #13: a control that runs a different check than its primary is rejected", () => {
  // The bypass an independent review found on this branch before this rule
  // existed. Sharing a providerId was enough, so a control could run a
  // completely different command, fail for its own unrelated reasons, report
  // itself falsified, and let an always-passing primary produce a PASSING
  // receipt with Board left `ready`.
  //
  // Measured with the real LocalCommandVerifierProvider:
  //   primary { command: "/usr/bin/true"  } // cannot fail
  //   control { command: "/usr/bin/false" } // fails for an unrelated reason
  //   => receipt status: pass, board: ready
  //
  // The earlier inverted proof did not catch it because its control shares the
  // primary's config, which is the honest case. A test that shows a fix works
  // when used correctly is not a test that the fix cannot be bypassed.
  assert.throws(() => parseVerificationPlan({
    id: "plan:costume",
    workId: "work:proof",
    contractRevision: 1,
    checks: [
      {
        id: "check:primary",
        providerId: "verifier:x",
        description: "Primary that cannot fail",
        config: { command: "/usr/bin/true", expectedExitCodes: [0] },
      },
      {
        id: "check:control",
        providerId: "verifier:x",
        description: "A different check entirely, wearing a perturbation as a costume",
        negativeControlFor: "check:primary",
        perturbation: {
          kind: "overwrite-file",
          path: "a.txt",
          content: "broken\n",
          description: "irrelevant to the command this control actually runs",
        },
        config: { command: "/usr/bin/false", expectedExitCodes: [0] },
      },
    ],
  }), /same config as its primary check/);
});

test("PROOF #13: a control with no declared perturbation is rejected at plan validation", () => {
  assert.throws(() => parseVerificationPlan({
    id: "plan:vacuous",
    workId: "work:proof",
    contractRevision: 1,
    checks: [
      { id: "check:primary", providerId: "verifier:x", description: "Primary", config: {} },
      {
        id: "check:control",
        providerId: "verifier:x",
        description: "Control that breaks nothing and therefore proves nothing",
        negativeControlFor: "check:primary",
        config: {},
      },
    ],
  }), /must declare the perturbation/);
});

// ---------------------------------------------------------------------------
// Issue #18 (P1): worker selection fails open for providers without a descriptor.
// ---------------------------------------------------------------------------

class UndescribedWorker implements WorkerProvider {
  readonly id = "worker:undescribed";
  async capabilities(): Promise<WorkerCapabilities> {
    return { streamingObservations: true, cancel: false, resume: false, guardedToolMediation: false };
  }
  async start(_input: WorkerStartRequest): Promise<WorkerHandle> {
    throw new Error("not started in this proof");
  }
}

test("PROOF #18: a provider that publishes no descriptor is refused for a read-only mission", async () => {
  const catalog = new WorkerCatalog(new UndescribedWorker());
  const scout = contract({ id: "work:scout", type: "SCOUT", writeScope: [] });

  // The exact policy Crew applies to SCOUT and REVIEW missions. "host-policy"
  // is no longer in the allow list: unknown authority is denied authority.
  const requirements = {
    allowedWriteAccess: ["none"] as const,
    allowDangerous: false,
    requireWorkspaceBinding: true,
  };

  await assert.rejects(
    () => selectWorkerProvider(catalog, scout, { ...requirements, allowedWriteAccess: ["none"] }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerSelectionError, "selection must fail with the named error type");
      assert.equal(error.workId, scout.id);
      // The reason is pinned, not merely present: the provider is refused
      // because its unknown authority is treated as the worst case.
      const reasons = error.rejections.map((item) => item.reason);
      assert.deepEqual(error.rejections.map((item) => item.providerId), ["worker:undescribed"]);
      // The dangerous gate fires first. Pin that exact reason rather than
      // accepting any rejection, so the test cannot pass for a wrong reason.
      assert.deepEqual(reasons, ["dangerous worker authority is not allowed by this supervision policy"]);
      return true;
    },
  );

  // Pin the second gate too: even with dangerous workers permitted, the
  // synthesised unrestricted write access is refused for read-only work.
  await assert.rejects(
    () => selectWorkerProvider(catalog, scout, { allowedWriteAccess: ["none"], allowDangerous: true }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerSelectionError);
      assert.deepEqual(
        error.rejections.map((item) => item.reason),
        ["write access unrestricted is not allowed by this supervision policy"],
      );
      return true;
    },
  );

  // The synthesised descriptor itself is conservative, which is what makes the
  // rejection above happen for the right reason rather than by accident.
  const descriptor = await describeWorkerProvider(new UndescribedWorker());
  assert.equal(descriptor.writeAccess, "unrestricted");
  assert.equal(descriptor.dangerous, true);
  assert.equal(descriptor.bindsWorkspace, false);
});

test("PROOF #18: an undescribed provider is admitted only by an explicit, auditable human authorization", async () => {
  const catalog = new WorkerCatalog(new UndescribedWorker());
  const scout = contract({
    id: "work:scout-authorized",
    type: "SCOUT",
    writeScope: [],
    workerPolicy: {
      preferredProviders: [],
      maxAttempts: 1,
      allowParallelAttempts: false,
      explicitProviderAuthorizations: [{
        providerId: "worker:undescribed",
        reason: "operator vetted this provider by hand for a one-off diagnostic",
        authorizedBy: human,
      }],
    },
  });

  const selection = await selectWorkerProvider(catalog, scout, {
    allowedWriteAccess: ["none"],
    allowDangerous: false,
  });
  assert.equal(selection.provider.id, "worker:undescribed");
  assert.equal(selection.authorization?.authorizedBy.kind, "human");
  assert.equal(selection.authorization?.providerId, "worker:undescribed");

  // The authorization admits the provider past authority classification. It does
  // NOT buy workspace binding, which no human may vouch for on a provider's
  // behalf, so a Crew mission still refuses it.
  await assert.rejects(
    () => selectWorkerProvider(catalog, scout, {
      allowedWriteAccess: ["none"],
      allowDangerous: false,
      requireWorkspaceBinding: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerSelectionError);
      assert.ok(error.rejections.some((item) => item.reason.includes("does not guarantee workspace binding")));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Issue #9 (P0): a Worker cannot be told which workspace to execute in.
// ---------------------------------------------------------------------------

test("PROOF #9: WorkerStartRequest carries the exact workspace, and fails closed without one", () => {
  const base = {
    work: contract(),
    taskId: "task:proof",
    attemptId: "attempt:proof",
    objective: "Do the bounded work",
    authority: contract().authority,
    context: contract().context,
  };

  // The portable contract now carries execution identity, so a provider can
  // learn exactly where the mission expects it to run.
  const request = WorkerStartRequestSchema.parse({ ...base, workspace: boundWorkspace });
  assert.equal(request.workspace.executionRoot, boundWorkspace.executionRoot);
  assert.equal(request.workspace.workspaceId, boundWorkspace.workspaceId);
  assert.equal(request.workspace.mode, "isolated-write");
  assert.equal(requireBoundExecutionRoot("worker:test", request), boundWorkspace.executionRoot);

  // Omitting the binding fails closed rather than defaulting to anywhere.
  assert.equal(WorkerStartRequestSchema.safeParse(base).success, false);

  // A relative or empty execution root is refused, so "" can never resolve to cwd.
  for (const executionRoot of ["", "relative/path", "./somewhere"]) {
    const parsed = WorkerStartRequestSchema.safeParse({
      ...base,
      workspace: { ...boundWorkspace, executionRoot },
    });
    assert.equal(parsed.success, false, `executionRoot ${JSON.stringify(executionRoot)} must be refused`);
  }

  // Read-only work cannot be bound to a writable workspace.
  const scoutBound = WorkerStartRequestSchema.safeParse({
    ...base,
    work: contract({ id: "work:scout", type: "SCOUT", writeScope: [] }),
    workspace: boundWorkspace,
  });
  assert.equal(scoutBound.success, false, "SCOUT work must not accept an isolated-write binding");
});
