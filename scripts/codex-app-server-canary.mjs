import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAppServerHost } from "../dist/adapters/codex/app-server.js";
import { GitWorktreeWorkspaceProvider } from "../dist/adapters/git/worktrees.js";
import { DurableEventLedger } from "../dist/adapters/local/durable-ledger.js";
import { CrewSupervisor, parseCrewPlan } from "../dist/src/crew.js";
import { parseWorkContract } from "../dist/src/schemas.js";
import { WorkerCatalog } from "../dist/src/workers.js";

const repositoryRoot = process.cwd();
const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== baseRevision) {
  throw new Error(`canary checkout ${baseRevision} does not match pinned GitHub candidate ${process.env.GITHUB_SHA}`);
}
const canaryRoot = await mkdtemp(join(tmpdir(), "rhiz-codex-canary-"));
const worktreeRoot = join(canaryRoot, "worktrees");
const ledgerRoot = join(canaryRoot, "ledger");
await mkdir(worktreeRoot, { recursive: true });
const targetPath = "test/fixtures/codex-app-server-canary.txt";
const nonce = (process.env.GITHUB_SHA ?? baseRevision).slice(0, 12);
const expected = `RHIZ CODEX APP SERVER CANARY ${nonce}`;
const actor = { id: "human:codex-canary", kind: "human", displayName: "Codex Canary" };
const work = parseWorkContract({
  id: `work:codex-canary-${nonce}`,
  objective: `Create ${targetPath} containing exactly: ${expected}. Do not edit any other file.`,
  type: "SHIP",
  scope: [{ uri: "repo://rhiz-harness", kind: "repository" }],
  writeScope: [{ uri: `repo://rhiz-harness/${targetPath}`, kind: "file" }],
  nonGoals: [
    "Do not run shell commands.",
    "Do not access the network.",
    "Do not modify any file other than the named canary file.",
  ],
  authority: {
    grants: [
      { action: "read", resources: [{ uri: "repo://rhiz-harness", kind: "repository" }], constraints: [] },
      { action: "write", resources: [{ uri: `repo://rhiz-harness/${targetPath}`, kind: "file" }], constraints: [] },
    ],
    requiresHumanApproval: [],
  },
  acceptanceCriteria: [{
    id: "criterion:codex-canary-file",
    description: "The exact canary file is created with the expected content and no other path changes.",
    required: true,
  }],
  requiredEvidence: [],
  context: { strategy: "minimal", resources: [], includeHistory: false },
  dependencies: [],
  workerPolicy: {
    preferredProviders: ["worker:codex-app-server"],
    maxAttempts: 1,
    allowParallelAttempts: false,
    explicitProviderAuthorizations: [],
  },
  verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
  createdBy: actor,
  createdAt: new Date().toISOString(),
});

let ledger = await DurableEventLedger.open({
  directory: ledgerRoot,
  ledgerId: `ledger:codex-canary-${nonce}`,
});
const workspaceProvider = new GitWorktreeWorkspaceProvider({ repositoryRoot, worktreeRoot });
const host = new CodexAppServerHost({
  stdio: {
    command: process.env.RHIZ_CODEX_COMMAND || "codex",
  },
});
const workers = new WorkerCatalog();
workers.registerHost(host);
let run;
let persistedGuardCount = 0;
let ledgerHeadDigest = null;

try {
  run = await new CrewSupervisor({
    plan: parseCrewPlan({
      id: `crew:codex-canary-${nonce}`,
      objective: "Prove a real Codex App Server turn can make one contract-bounded file edit through Crew and Guard.",
      baseRevision,
      maxParallel: 1,
      missions: [{
        work,
        workspace: { strategy: "fresh", mode: "isolated-write" },
        requiredCapabilities: ["guardedToolMediation"],
        allowDangerousWorker: false,
      }],
    }),
    ledger,
    workerCatalog: workers,
    workspaceProvider,
    actor,
  }).run();

  const mission = run.receipt.missions[0];
  assert.ok(mission, "canary produced no mission receipt");
  const events = await ledger.replay(mission.streamId);
  const guardRecords = events.filter((event) => event.type === "guard.evaluated");
  const activities = events
    .filter((event) => event.type === "attempt.activity-observed")
    .map((event) => event.payload.detail)
    .slice(-30);
  const guardDecisions = guardRecords.map((event) => ({
    tool: event.payload.request.tool.name,
    category: event.payload.request.tool.category,
    decision: event.payload.verdict.decision,
    rationale: event.payload.verdict.rationale,
    ruleHits: event.payload.verdict.ruleHits,
  }));

  console.log(JSON.stringify({
    status: "DIAGNOSTIC",
    provider: mission.workerProviderId ?? null,
    missionStatus: mission.status,
    error: mission.error ?? null,
    changedPaths: mission.changedPaths,
    observationCount: mission.observationCount,
    summary: mission.workerResult?.summary ?? null,
    guardEvaluations: guardDecisions,
    activities,
  }, null, 2));

  assert.equal(mission.status, "execution-finished", mission.error ?? "Codex canary did not finish");
  assert.deepEqual(mission.changedPaths, [targetPath], `Codex changed paths outside the Work contract: ${mission.changedPaths.join(", ")}`);

  const workspace = run.workspaces.find((item) => item.workspaceId === mission.workspace?.workspaceId);
  assert.ok(workspace, "canary workspace was not retained for inspection");
  const actual = (await readFile(join(workspace.executionRoot, targetPath), "utf8")).trim();
  assert.equal(actual, expected, "Codex did not produce the exact bounded canary content");

  assert.ok(guardRecords.length >= 1, "real Codex write produced no durable Guard evaluation");
  assert.ok(
    guardRecords.some((event) => event.payload.verdict.decision === "allow" && event.payload.request.tool.category === "write"),
    "no Guard-authorized write was recorded for the real Codex file change",
  );

  // Completion is not persistence proof. Close and reopen the hash-chained
  // Ledger, then re-read the exact Work stream before calling the canary green.
  await ledger.close();
  ledger = null;
  const reopened = await DurableEventLedger.open({
    directory: ledgerRoot,
    ledgerId: `ledger:codex-canary-${nonce}`,
  });
  try {
    const persistedEvents = await reopened.replay(mission.streamId);
    const persistedGuards = persistedEvents.filter((event) => event.type === "guard.evaluated");
    persistedGuardCount = persistedGuards.length;
    assert.ok(
      persistedGuards.some((event) => event.payload.verdict.decision === "allow" && event.payload.request.tool.category === "write"),
      "the Guard-authorized write did not survive durable Ledger reopen",
    );
    ledgerHeadDigest = (await reopened.integrity()).headDigest;
  } finally {
    await reopened.close();
  }

  console.log(JSON.stringify({
    status: "PASS",
    candidateSha: baseRevision,
    provider: mission.workerProviderId,
    changedPaths: mission.changedPaths,
    guardEvaluations: persistedGuardCount,
    ledgerHeadDigest,
    summary: mission.workerResult?.summary ?? null,
  }, null, 2));
} finally {
  if (run) await run.close().catch(() => undefined);
  if (ledger) await ledger.close().catch(() => undefined);
  await host.close().catch(() => undefined);
  await workspaceProvider.close().catch(() => undefined);
  const registeredWorktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(registeredWorktrees.includes(worktreeRoot), false, "canary left a registered Git worktree behind");
  await rm(canaryRoot, { recursive: true, force: true });
  await assert.rejects(() => stat(canaryRoot), (error) => error?.code === "ENOENT");
}
