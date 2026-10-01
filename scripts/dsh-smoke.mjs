import {
  InMemoryEventLedger,
  parseHarnessEvent,
  parseWorkContract,
  projectBoard,
} from "../dist/src/index.js";
import { createDshSdkHost } from "../dist/adapters/dsh/index.js";
import {
  assertDshSmokeProof,
  DSH_SMOKE_EXPECTED_SUMMARY,
  evaluateDshSmokeProof,
} from "../dist/adapters/dsh/smoke-proof.js";
import { pathToFileURL } from "node:url";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live DSH smoke`);
  return value;
}

function parseArgs() {
  const raw = process.env.RHIZ_DSH_ARGS_JSON ?? "[]";
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("RHIZ_DSH_ARGS_JSON must be a JSON array of strings");
  }
  return value;
}

const command = required("RHIZ_DSH_COMMAND");
const cwd = process.env.RHIZ_DSH_CWD ?? process.cwd();
const provider = process.env.RHIZ_DSH_PROVIDER ?? "deepseek-official";
const model = process.env.RHIZ_DSH_MODEL ?? "deepseek-v4-flash";
const args = parseArgs();
const now = () => new Date().toISOString();
const streamId = "stream:dsh-smoke";
const workId = "work:dsh-smoke";
const taskId = "task:dsh-smoke";
const attemptId = `attempt:dsh-smoke:${Date.now()}`;
const human = { id: "human:dsh-smoke", kind: "human" };
const workerActor = { id: "agent:dsh-sdk", kind: "agent" };
let counter = 0;

const contract = parseWorkContract({
  id: workId,
  objective: "Complete the DSH transport smoke by returning one concise response to Rhiz without invoking tools or mutating any resource.",
  type: "SCOUT",
  scope: [],
  writeScope: [],
  nonGoals: ["Do not inspect or modify files", "Do not execute shell commands", "Do not publish or mutate external systems"],
  authority: {
    grants: [],
    requiresHumanApproval: ["write", "execute", "publish", "external-mutate"],
  },
  acceptanceCriteria: [{
    id: "criterion:dsh-worker-returned",
    description: "The real DSH SDK activity interval returns control to Rhiz with a non-empty worker summary.",
    required: true,
  }],
  requiredEvidence: [],
  context: {
    strategy: "explicit",
    resources: [],
    includeHistory: false,
  },
  dependencies: [],
  workerPolicy: {
    preferredProviders: ["worker:dsh-sdk"],
    maxAttempts: 1,
    allowParallelAttempts: false,
  },
  verificationPolicy: {
    required: true,
    independentActor: true,
    reviewRequired: false,
  },
  createdBy: human,
  createdAt: now(),
});

function event(type, payload, extra = {}) {
  counter += 1;
  const timestamp = now();
  return parseHarnessEvent({
    id: `event:dsh-smoke:${counter}`,
    type,
    schemaVersion: 1,
    streamId,
    workId,
    actor: human,
    occurredAt: timestamp,
    recordedAt: timestamp,
    evidence: [],
    payload,
    ...extra,
  });
}

const host = createDshSdkHost({
  // This Host is constructed for exactly one working directory (`cwd` below),
  // which is the condition DshSdkWorkerProvider requires before it will accept a
  // per-attempt binding: the SDK client resolves its cwd once, at construction,
  // so one client cannot be repointed per attempt. The binding handed to
  // start() below uses this same `cwd`, so the declaration is true rather than
  // convenient.
  bindsWorkspace: true,
  launch: {
    command,
    args,
    cwd,
    requestTimeoutMs: Number(process.env.RHIZ_DSH_TIMEOUT_MS ?? 120000),
  },
  cwd,
  provider,
  model,
  maxTokens: Number(process.env.RHIZ_DSH_MAX_TOKENS ?? 4096),
  sessionPrefix: "rhiz-smoke-",
});
const ledger = new InMemoryEventLedger();
const observations = [];

try {
  await ledger.append(event("work.created", { contract, revision: 1 }));
  await ledger.append(event("task.created", { objective: contract.objective }, { taskId }));
  await ledger.append(event("task.assigned", { worker: workerActor }, { taskId }));
  await ledger.append(event(
    "attempt.started",
    { worker: workerActor, contractRevision: 1 },
    { taskId, attemptId, actor: workerActor },
  ));

  const worker = host.workers().get("worker:dsh-sdk") ?? host.workers().list()[0];
  if (!worker) throw new Error("DSH Host exposed no WorkerProvider");
  // Workspace binding is required since issue #9: a Worker is told where to
  // execute, and a missing binding fails closed before a process starts. It must
  // be the SAME root the Host's SDK client was constructed with, or the
  // declaration above would be a claim the client cannot honour.
  const executionRoot = cwd;
  const handle = await worker.start({
    work: contract,
    taskId,
    attemptId,
    objective: contract.objective,
    authority: contract.authority,
    context: contract.context,
    workspace: {
      workspaceId: `workspace:dsh-smoke:${attemptId}`,
      leaseId: `lease:dsh-smoke:${attemptId}`,
      uri: pathToFileURL(executionRoot).href,
      executionRoot,
      mode: "read-only",
      baseRevision: "dsh-smoke",
    },
  });
  const collecting = (async () => {
    for await (const observation of handle.observe()) observations.push(observation);
  })();
  const result = await handle.result();
  await collecting;

  if (result.status === "finished") {
    await ledger.append(event(
      "attempt.finished",
      { resultSummary: result.summary, artifactRefs: result.artifacts },
      { taskId, attemptId, actor: workerActor },
    ));
  } else {
    await ledger.append(event(
      "attempt.failed",
      { reason: result.summary, recoverable: true },
      { taskId, attemptId, actor: workerActor },
    ));
  }

  const events = await ledger.replay(streamId);
  const board = projectBoard(events);
  const evaluation = evaluateDshSmokeProof({
    workerResult: result,
    observationCount: observations.length,
    boardState: board.state,
    violations: board.violations,
  });
  const proof = {
    workId,
    taskId,
    attemptId,
    dshProvider: provider,
    dshModel: model,
    expectedSummary: DSH_SMOKE_EXPECTED_SUMMARY,
    workerResult: result,
    observationCount: observations.length,
    boardState: board.state,
    expectedState: "verifying",
    violations: board.violations,
    eventCount: events.length,
    proofFailures: evaluation.failures,
  };
  console.log(JSON.stringify(proof, null, 2));
  assertDshSmokeProof({
    workerResult: result,
    observationCount: observations.length,
    boardState: board.state,
    violations: board.violations,
  });
} finally {
  await host.close();
}
