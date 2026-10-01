import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";
import { DurableEventLedger } from "../adapters/local/durable-ledger.js";
import { projectBoard } from "../src/board.js";
import type {
  CrewWorkspace,
  CrewWorkspaceAcquireRequest,
  CrewWorkspaceProvider,
  CrewWorkspaceSnapshot,
} from "../src/crew.js";
import type { ActorRef, HarnessEvent } from "../src/schemas.js";
import { parseHarnessEvent } from "../src/schemas.js";
import {
  acceptVerifiedWork,
  parseVerificationPlan,
  VerificationCheckResultSchema,
  VerificationEngine,
  VerifierCatalog,
  type VerificationCheckResult,
  type VerifierDescriptor,
  type VerifierProvider,
  type VerifierRequest,
} from "../src/verify.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { human, testDigestScope, work, worker } from "./helpers.js";

// Real directory: a negative control copies the execution root, so a fixture
// rooted nowhere would fail its control for the wrong reason.
const recoveryRoot = mkdtempSync(join(tmpdir(), "rhiz-recovery-fixture-"));
mkdirSync(join(recoveryRoot, "src"), { recursive: true });
writeFileSync(join(recoveryRoot, "src/recovered.ts"), "export const recovered = true;\n");
process.on("exit", () => { rmSync(recoveryRoot, { recursive: true, force: true }); });

class RecoveryWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:crash-recovery";
  readonly workspace: CrewWorkspace = {
    leaseId: "lease:crash-recovery",
    workspaceId: "workspace:crash-recovery",
    uri: `file://${recoveryRoot}`,
    executionRoot: recoveryRoot,
    baseRevision: "crash-proof-head",
    mode: "isolated-write",
  };
  readonly snapshotValue: CrewWorkspaceSnapshot = {
    workspaceId: this.workspace.workspaceId,
    head: "crash-proof-head",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digestScope: testDigestScope,
    changedPaths: ["src/recovered.ts"],
    observedAt: "2026-08-20T18:00:00.000Z",
  };
  async acquire(_request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> { return this.workspace; }
  async snapshot(_workspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot> { return structuredClone(this.snapshotValue); }
  async release(_workspaceId: string): Promise<void> {}
  async close(): Promise<void> {}
}

class RecoveryVerifier implements VerifierProvider {
  readonly id = "verifier:crash-recovery";
  async describe(): Promise<VerifierDescriptor> {
    return {
      id: this.id,
      displayName: "Crash Recovery Verifier",
      description: "Deterministically proves the recovered target",
      deterministic: true,
      readOnly: true,
      evidenceKinds: ["test"],
    };
  }
  async verify(request: VerifierRequest): Promise<VerificationCheckResult> {
    const digestCharacter = request.check.id === "check:recovery" ? "b" : "c";
    // Issue #13 cited this stub by name: it always passed, so it satisfied both
    // the primary check and its own negative control and distinguished nothing.
    // It now reads the target, which is the minimum required to be a verifier at
    // all, and fails when the control's perturbation is present.
    const source = readFileSync(join(request.workspace.executionRoot, "src/recovered.ts"), "utf8");
    const intact = !source.includes("broken");
    return VerificationCheckResultSchema.parse({
      checkId: request.check.id,
      providerId: this.id,
      status: intact ? "pass" : "fail",
      summary: intact
        ? `${request.check.id} passed after process recovery`
        : `${request.check.id} detected the perturbed target`,
      evidence: intact ? [{
        id: `evidence:${request.check.id}`,
        kind: "test",
        digest: `sha256:${digestCharacter.repeat(64)}`,
      }] : [],
      startedAt: "2026-08-20T18:00:01.000Z",
      finishedAt: "2026-08-20T18:00:02.000Z",
    });
  }
  async close(): Promise<void> {}
}

function appendEvent(
  ledger: DurableEventLedger,
  sequence: number,
  type: HarnessEvent["type"],
  payload: unknown,
  extra: Partial<HarnessEvent> = {},
): Promise<void> {
  return ledger.append(parseHarnessEvent({
    id: `event:recovery:${sequence}`,
    type,
    schemaVersion: 1,
    streamId: "stream:work:1",
    workId: "work:1",
    actor: human,
    occurredAt: "2026-08-20T18:00:00.000Z",
    recordedAt: "2026-08-20T18:00:00.000Z",
    evidence: [],
    payload,
    ...extra,
  }));
}

test("a killed Harness process reopens exact Work state, continues, verifies, and accepts", {
  skip: process.platform === "win32" ? "SIGKILL crash proof requires POSIX process semantics" : false,
  timeout: 20_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhiz-ledger-crash-"));
  const fixture = fileURLToPath(new URL("./fixtures/ledger-crash-writer.js", import.meta.url));
  let childError = "";
  try {
    const child = spawn(process.execPath, [fixture, directory], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { childError += chunk; });
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, "line") as [string];
    const ready = JSON.parse(line) as { ready: boolean; attemptId: string; streamId: string };
    assert.equal(ready.ready, true);
    assert.equal(ready.streamId, "stream:work:1");
    assert.equal(child.kill("SIGKILL"), true);
    await once(child, "exit");
    lines.close();

    const recovered = await DurableEventLedger.open({ directory, ledgerId: "ledger:recovered" });
    const integrity = await recovered.integrity();
    assert.equal(integrity.recoveredStaleLock, true);
    const running = projectBoard(await recovered.replay(ready.streamId));
    assert.equal(running.state, "running");
    assert.equal(running.attempts[ready.attemptId]?.state, "running");

    await appendEvent(recovered, 1, "attempt.failed", {
      reason: "worker process died before reporting a terminal result",
      recoverable: true,
    }, {
      taskId: "task:crash",
      attemptId: ready.attemptId,
      actor: worker,
    });
    const recoveredAttempt = "attempt:recovered";
    await appendEvent(recovered, 2, "attempt.started", {
      worker,
      contractRevision: 1,
      lease: { id: "lease:crash", workspaceId: "workspace:crash", resourceClaims: [{ kind: "path" as const, resource: "src" }], acquiredAt: "2026-08-20T04:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" },
    }, {
      taskId: "task:crash",
      attemptId: recoveredAttempt,
      actor: worker,
    });
    // Execution evidence; the Board requires it before calling a Work done.
    await appendEvent(recovered, 2.4, "attempt.activity-observed", {
      state: "working",
      detail: "message: worker edited src/feature.ts",
      source: worker.id,
      authority: "observation",
    }, { taskId: "task:crash", attemptId: recoveredAttempt, actor: worker });
    await appendEvent(recovered, 2.7, "guard.evaluated", {
      request: { requestId: "guard:crash", workId: "work:crash", taskId: "task:crash", attemptId: recoveredAttempt, actor: worker, writeScope: "workspace" as const, contextHash: "ctx:crash", evidenceRefs: [], timestampMs: 1787000000000, tool: { name: "worker:file-change", category: "write" as const, args: { keys: ["changes"], keyCount: 1, byteSize: 64, digest: "sha256:fixture" } } },
      verdict: { requestId: "guard:crash", decision: "allow" as const, rationale: "fixture write authorized", riskLevel: "medium" as const, ruleHits: ["per-category-mode:write:allow"], evaluatedAt: "2026-08-20T04:00:00.500Z", durationMs: 1, policyBackend: "rhiz-native", policyBackendVersion: "0.1.0" },
    }, { taskId: "task:crash", attemptId: recoveredAttempt, actor: worker });
    await appendEvent(recovered, 3, "attempt.finished", {
      resultSummary: "recovered execution completed",
      artifactRefs: [],
    }, {
      taskId: "task:crash",
      attemptId: recoveredAttempt,
      actor: worker,
    });
    assert.equal(projectBoard(await recovered.replay(ready.streamId)).state, "verifying");

    const contract = work();
    const workspaceProvider = new RecoveryWorkspaceProvider();
    let id = 0;
    const verifierActor: ActorRef = { id: "verifier:crash-recovery", kind: "verifier" };
    const engine = new VerificationEngine({
      ledger: recovered,
      workspaceProvider,
      verifierCatalog: new VerifierCatalog(new RecoveryVerifier()),
      verifier: verifierActor,
      now: () => "2026-08-20T18:00:03.000Z",
      idFactory: () => `recovery-${++id}`,
    });
    const plan = parseVerificationPlan({
      id: "plan:crash-recovery",
      workId: contract.id,
      contractRevision: 1,
      checks: [
        {
          id: "check:recovery",
          providerId: "verifier:crash-recovery",
          description: "Prove the recovered implementation",
          criterionIds: ["criterion:tests"],
          requirementIds: ["evidence:tests"],
          config: {},
        },
        {
          id: "check:recovery-control",
          providerId: "verifier:crash-recovery",
          description: "Prove the verifier responds to its control",
          negativeControlFor: "check:recovery",
          perturbation: {
            kind: "overwrite-file",
            path: "src/recovered.ts",
            content: "export const broken = true;\n",
            description: "src/recovered.ts replaced so the check has a known failure to detect",
          },
          config: {},
        },
      ],
    });
    const receipt = await engine.verify({
      streamId: ready.streamId,
      work: contract,
      contractRevision: 1,
      workspace: workspaceProvider.workspace,
      expectedSnapshot: workspaceProvider.snapshotValue,
      plan,
    });
    assert.equal(receipt.status, "pass");
    assert.equal(receipt.boardState, "ready");

    const accepted = await acceptVerifiedWork({
      receipt,
      work: contract,
      ledger: recovered,
      workspace: workspaceProvider.workspace,
      workspaceProvider,
      actor: human,
      reason: "Recovered Work was independently verified against the exact target",
      now: () => "2026-08-20T18:00:04.000Z",
      idFactory: () => "recovery-accept",
    });
    assert.equal(accepted, "accepted");
    await recovered.close();

    const finalLedger = await DurableEventLedger.open({ directory, ledgerId: "ledger:final-reopen" });
    const finalBoard = projectBoard(await finalLedger.replay(ready.streamId));
    assert.equal(finalBoard.state, "accepted");
    assert.equal(finalBoard.violations.length, 0);
    const audit = await finalLedger.auditReceipt();
    assert.ok(audit.recordCount >= 11);
    assert.ok(audit.headDigest);
    await finalLedger.close();
  } catch (error) {
    assert.fail(`${error instanceof Error ? error.stack ?? error.message : String(error)}\nchild stderr: ${childError}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
