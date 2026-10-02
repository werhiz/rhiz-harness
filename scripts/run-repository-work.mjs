#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CodexAppServerHost } from "../dist/adapters/codex/app-server.js";
import { createRepositoryBenchmarkRun, repositoryRunContext } from "../dist/src/benchmark.js";
import {
  candidatePathScopesFromResources,
  GitWorkIntegrationExecutor,
  GitWorktreeWorkspaceProvider,
  harnessGitRefSegment,
  initializeWorkIntegrationRef,
  preserveCandidateRemotely,
} from "../dist/adapters/git/index.js";
import { DurableEventLedger } from "../dist/adapters/local/durable-ledger.js";
import { readRepositoryWorkEvents } from "../dist/adapters/local/work-ledgers.js";
import { LocalCommandVerifierProvider } from "../dist/adapters/local/command-verifier.js";
import { projectBoard } from "../dist/src/board.js";
import { closeOrphanedAttempts } from "../dist/src/operator.js";
import { streamIdForWork } from "../dist/src/refiner.js";
import { ContextBridge } from "../dist/src/context-bridge.js";
import { CrewSupervisor, parseCrewPlan } from "../dist/src/crew.js";
import {
  IntegrationController,
  PROVISIONAL_INTEGRATION_HORIZON,
} from "../dist/src/integration.js";
import { parseHarnessEvent, parseWorkContract } from "../dist/src/schemas.js";
import { RefinerBridge } from "../dist/src/refiner-bridge.js";
import {
  defaultRouterWorkerDescriptor,
  RouterBridge,
} from "../dist/src/router-bridge.js";
import { InMemoryRouterWorkerRegistry } from "../dist/src/router.js";
import {
  parseVerificationPlan,
  VerificationEngine,
  VerifierCatalog,
} from "../dist/src/verify.js";
import { describeWorkerProvider, WorkerCatalog } from "../dist/src/workers.js";

const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  }).trim();
}

function usage() {
  return [
    "Usage:",
    "  npm run work:repository -- --repo <path> --contract <work.json> --verify <plan.json> [--prepare <prepare.json>] [--base <rev>] [--ledger <dir>] [--output <receipt.json>] [--resume true] [--benchmark-case <id>] [--benchmark-variant <id>]",
    "",
    "--resume true continues the same Work in its existing Ledger: an attempt",
    "whose process ended without a terminal event is closed as a recoverable",
    "failure, and the remaining attempt budget is spent. Terminal or verified",
    "Work is refused; there is nothing left to execute.",
    "",
    "The durable event Ledger is preserved under the repository's Git metadata",
    "by default. --ledger supplies an explicit base directory; benchmark runs",
    "receive isolated subdirectories beneath that base.",
    "",
    "prepare.json is optional trusted operator setup:",
    '  {"command":"pnpm","args":["install","--frozen-lockfile","--ignore-scripts"]}',
    "It runs inside the isolated worktree before baseline identity is pinned and",
    "may materialize ignored dependencies only; source edits or HEAD movement fail.",
    "",
    "The target Work must be SHIP work. workerPolicy.maxAttempts is the repair",
    "budget: after a failed independent verification the runner spends another",
    "attempt and hands the worker the verifier's own refusal as untrusted data.",
    "It never hands the worker a candidate.",
    "",
    "The runner uses the",
    "real Codex App Server HostAdapter, isolated Git worktrees, contract-bound",
    "Guard, independent local-command verification, durable Ledger evidence, and",
    "Harness-owned remote refs, and serialized Work-ref convergence. It never",
    "merges a PR, deploys, publishes, or accepts the Work.",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--help" || value === "-h") return { help: true };
    if (!value?.startsWith("--")) throw new Error(`unexpected argument ${value}`);
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${value}`);
    values[key] = next;
    i += 1;
  }
  return values;
}

function validatePreparation(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("prepare config must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.some((key) => key !== "args" && key !== "command")) {
    throw new Error("prepare config accepts only command and args");
  }
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error("prepare command must be a non-empty string");
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new Error("prepare args must be an array of strings");
  }
  return { command: value.command, args: value.args };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
const benchmarkCaseId = args["benchmark-case"] ?? null;
const benchmarkVariantId = args["benchmark-variant"] ?? null;
const benchmarkStartedAt = new Date().toISOString();
const benchmarkRunId = benchmarkCaseId === null ? null : globalThis.crypto.randomUUID();
let benchmarkHarnessVersion;
let benchmarkFailureRecorded = false;
let earlyLedger = null;
let earlyWorkspaceProvider = null;
let earlyHost = null;
let earlyVerifierProvider = null;
let resolvedRepositoryRoot = null;
let resolvedBaseRevision = null;
let resolvedWorkId = null;
let resolvedTaskIdentity;
let resolvedPreparationIdentity;
// Unknown until the Work contract is parsed; an early failure omits it rather
// than recording a strategy the run never used.
let recordedContextStrategy;
// Set only after the replay packet and exposure digest pass validation.
let capabilityExposureDigest;

async function emitEarlyBenchmarkFailure(error) {
  if (benchmarkCaseId === null) return;
  const endedAt = new Date().toISOString();
  const benchmarkRun = createRepositoryBenchmarkRun({
    benchmarkCaseId,
    taskIdentity: resolvedTaskIdentity,
    preparationIdentity: resolvedPreparationIdentity,
    variantId: benchmarkVariantId ?? undefined,
    capabilityExposureDigest,
    workId: resolvedWorkId ?? undefined,
    baseIdentity: resolvedBaseRevision ?? undefined,
    attemptIds: [],
    harnessVersion: benchmarkHarnessVersion,
    contextStrategy: recordedContextStrategy,
    startedAt: benchmarkStartedAt,
    endedAt,
    outcome:
      /interrupt|abort|cancel|signal/i.test(
        error instanceof Error ? error.message : String(error),
      )
        ? "interrupted"
        : "failed",
    verified: false,
    repairRequired: false,
    evidenceRefs: [],
  });
  const receipt = {
    schema: "rhiz/repository-work-run/v1",
    generatedAt: endedAt,
    outcome: "initialization-error",
    repositoryRoot: resolvedRepositoryRoot,
    workId: resolvedWorkId,
    baseRevision: resolvedBaseRevision,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
    benchmarkRun,
  };
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) {
    const output = resolve(args.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, rendered, "utf8");
  }
  process.stdout.write(rendered);
}

try {
for (const required of ["repo", "contract", "verify"]) {
  if (!args[required]) throw new Error(`${usage()}\n\nMissing --${required}`);
}
if (benchmarkVariantId !== null && benchmarkCaseId === null) {
  throw new Error("--benchmark-variant requires --benchmark-case");
}
const harnessPackage = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
benchmarkHarnessVersion = harnessPackage.version;

const repositoryRoot = git(resolve(args.repo), ["rev-parse", "--show-toplevel"]);
resolvedRepositoryRoot = repositoryRoot;
const remoteName = args.remote ?? "origin";
const baseRevision = git(repositoryRoot, ["rev-parse", `${args.base ?? "HEAD"}^{commit}`]);
resolvedBaseRevision = baseRevision;
const work = parseWorkContract(JSON.parse(await readFile(resolve(args.contract), "utf8")));
resolvedWorkId = work.id;
recordedContextStrategy = work.context.strategy;
const verificationPlan = parseVerificationPlan(
  JSON.parse(await readFile(resolve(args.verify), "utf8")),
);
resolvedTaskIdentity = `sha256:${createHash("sha256").update(JSON.stringify({ work, verificationPlan })).digest("hex")}`;
const preparation = args.prepare
  ? validatePreparation(JSON.parse(await readFile(resolve(args.prepare), "utf8")))
  : null;
resolvedPreparationIdentity = preparation === null
  ? null
  : `sha256:${createHash("sha256").update(JSON.stringify(preparation)).digest("hex")}`;
if (work.type !== "SHIP") throw new Error("repository runner v0 accepts SHIP Work only");
if (verificationPlan.workId !== work.id || verificationPlan.contractRevision !== 1) {
  throw new Error("verification plan must target this Work at contract revision 1");
}

// Protocol replay packets are adapter inputs, never portable kernel authority.
let benchmarkExposure = null;
if (args["benchmark-replay-packet"]) {
  const packet = JSON.parse(await readFile(resolve(args["benchmark-replay-packet"]), "utf8"));
  if (packet.schema !== "rhiz-factory-replay-packet/v1" ||
      packet.measurement?.benchmarkCaseId !== benchmarkCaseId ||
      packet.measurement?.benchmarkVariantId !== benchmarkVariantId ||
      packet.repository?.baseSha !== baseRevision) {
    throw new Error("benchmark replay packet case, variant, or base mismatch");
  }
  benchmarkExposure = packet.task?.capabilityExposure ?? null;
  const parsedExposureDigest = packet.measurement?.capabilityExposureDigest;
  if (benchmarkExposure) {
    if (typeof benchmarkExposure.content !== "string" || !benchmarkExposure.content.trim() ||
        createHash("sha256").update(benchmarkExposure.content).digest("hex") !== parsedExposureDigest ||
        benchmarkExposure.sha256 !== parsedExposureDigest) {
      throw new Error("benchmark replay capability exposure digest mismatch");
    }
  } else if (parsedExposureDigest !== null) {
    throw new Error("benchmark baseline requires explicit null capability exposure");
  }
  capabilityExposureDigest = parsedExposureDigest;
} else if (benchmarkCaseId !== null) {
  // This runner can attest that no replay exposure was injected.
  capabilityExposureDigest = null;
}

const actor = work.createdBy;
if (actor.kind !== "human") {
  throw new Error("repository runner requires Work created by a human audit actor");
}
const verifierActor = {
  id: `verifier:repository-work:${work.id}`.slice(0, 200),
  kind: "verifier",
  displayName: "Repository Work Verifier",
};

const runRoot = await mkdtemp(join(tmpdir(), "rhiz-repository-work-"));
const worktreeRoot = join(runRoot, "worktrees");
// The Ledger is the durable authority for what happened, including failures.
// Keep the default outside ephemeral scratch worktrees, under Git metadata so
// it neither changes the candidate tree nor disappears when this process ends.
const gitCommonDir = resolve(repositoryRoot, git(repositoryRoot, ["rev-parse", "--git-common-dir"]));
const ledgerBaseRoot = args.ledger
  ? resolve(args.ledger)
  : join(gitCommonDir, "rhiz-harness", "ledgers", harnessGitRefSegment(work.id));
// A/B variants and repeated trials share the same Work contract, but each
// execution needs a fresh durable stream so the prior arm never owns this run.
const ledgerRoot = benchmarkRunId === null
  ? ledgerBaseRoot
  : join(ledgerBaseRoot, "benchmark-runs", benchmarkRunId);
await mkdir(ledgerRoot, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });

let ledger = await DurableEventLedger.open({
  directory: ledgerRoot,
  ledgerId: benchmarkRunId === null
    ? `ledger:${work.id}`.slice(0, 200)
    : `ledger:${benchmarkRunId}`,
});
earlyLedger = ledger;
const workspaceProvider = new GitWorktreeWorkspaceProvider({
  repositoryRoot,
  worktreeRoot,
  prepareWorkspace:
    preparation === null
      ? undefined
      : (executionRoot) => {
          execFileSync(preparation.command, preparation.args, {
            cwd: executionRoot,
            stdio: "inherit",
            env: process.env,
            maxBuffer: MAX_BUFFER,
          });
        },
});
earlyWorkspaceProvider = workspaceProvider;
const host = new CodexAppServerHost({
  stdio: { command: process.env.RHIZ_CODEX_COMMAND || "codex" },
});
earlyHost = host;
const workers = new WorkerCatalog();
workers.registerHost(host);
const routerRegistry = new InMemoryRouterWorkerRegistry();
for (const provider of workers.list()) {
  const descriptor = await describeWorkerProvider(provider);
  routerRegistry.register(
    defaultRouterWorkerDescriptor(provider.id, {
      adapter: descriptor.adapter,
      product: descriptor.product,
      supportedWorkTypes: ["SCOUT", "SHIP", "REVIEW"],
      writeAccess: descriptor.writeAccess,
    }),
  );
}
// Accepted outcomes from this repository's other Work are what the Router
// learns from. Each Work owns its own Ledger, so without this source the
// Router would only ever see the stream it is about to create.
const routerEvidenceSources = { works: 0, unreadable: [] };
const router = new RouterBridge({
  registry: routerRegistry,
  ledger,
  evidenceEvents: async () => {
    const prior = await readRepositoryWorkEvents(gitCommonDir, { excludeDirectories: [ledgerRoot] });
    routerEvidenceSources.works = new Set(prior.events.map((event) => event.workId)).size;
    routerEvidenceSources.unreadable = prior.unreadable;
    for (const item of prior.unreadable) {
      process.stderr.write(`router evidence: Ledger ${item.directory} is unreadable and was not counted: ${item.error}\n`);
    }
    return prior.events;
  },
});

const contextFiles = {};
for (const resource of work.context.resources) {
  if (resource.kind !== "file") continue;
  const match = /^repo:\/\/[^/]+\/(.+)$/.exec(resource.uri);
  if (match === null) continue;
  const relativePath = match[1];
  const absolutePath = resolve(repositoryRoot, relativePath);
  if (!absolutePath.startsWith(`${repositoryRoot}/`)) {
    throw new Error(`context resource escapes repository root: ${resource.uri}`);
  }
  contextFiles[relativePath] = await readFile(absolutePath, "utf8");
}
const runContext = repositoryRunContext({
  work,
  files: contextFiles,
  exposure: benchmarkExposure
    ? { content: benchmarkExposure.content, sha256: capabilityExposureDigest }
    : null,
});
work.context.resources.splice(0, work.context.resources.length, ...runContext.resources);
const context = new ContextBridge({
  ledger,
  config: runContext.config,
  source: {
    files: runContext.files,
    symbols: [],
    history: [],
    rules: [],
    architectureDocs: [],
    skills: [],
  },
});
const refiner = new RefinerBridge({ ledger });
const verifierProvider = new LocalCommandVerifierProvider({
  id: "verifier:local-command",
  displayName: "Independent Repository Command Verifier",
});
earlyVerifierProvider = verifierProvider;

let run;
let candidate;
let verification;
let candidateRef;
let checkpoint;
let persistedBoard;
let ledgerHeadDigest;

/**
 * Turn a failed verification into evidence the next attempt may READ.
 *
 * The verifier's own words are the only honest description of what was
 * refused, and they are untrusted bytes: they travel in the tainted
 * attachment channel so a provider renders them as data. Nothing here is
 * allowed to reach the objective, and nothing here tells the worker what to
 * write. A repair attempt that cannot work out the fix from the refusal is a
 * failed attempt, not a licence to hand it the answer.
 */
function priorAttemptEvidenceFrom(attemptNumber, verificationResult, workId) {
  return verificationResult.checks
    .filter((check) => check.status !== "pass")
    .slice(0, 8)
    .map((check) => ({
      id: `attachment:${workId}:attempt-${attemptNumber}:${check.checkId}`.slice(0, 200),
      label: "error-message",
      source: {
        value: `check ${check.checkId} reported ${check.status}\n${check.summary}`.slice(0, 4000),
        provenance: { kind: "error-message", workId },
      },
    }));
}

function benchmarkRunFor({
  outcome,
  verified,
  resultIdentity,
  evidenceRefs,
}) {
  if (benchmarkCaseId === null) return null;
  const workerProviderId = mission?.workerProviderId ?? undefined;
  const runtime = mission?.workerResult?.runtime;
  const attemptIds = attempts.map((attempt) => attempt.attemptId);
  if (mission?.attemptId && !attemptIds.includes(mission.attemptId)) {
    attemptIds.push(mission.attemptId);
  }
  return createRepositoryBenchmarkRun({
    benchmarkCaseId,
    taskIdentity: resolvedTaskIdentity,
    preparationIdentity: resolvedPreparationIdentity,
    variantId: benchmarkVariantId ?? undefined,
    capabilityExposureDigest,
    workId: work.id,
    attemptIds,
    attemptRuntimeControls: attemptRuntimeControls.filter((attempt) => attemptIds.includes(attempt.attemptId)),
    baseIdentity: baseRevision,
    resultIdentity,
    hostId: host.id,
    workerProviderId,
    harnessVersion: benchmarkHarnessVersion,
    model: runtime?.model,
    effortLevel: runtime?.effortLevel,
    contextStrategy: recordedContextStrategy,
    verificationPolicyId: verificationPlan.id,
    startedAt: benchmarkStartedAt,
    endedAt: new Date().toISOString(),
    outcome,
    verified,
    repairRequired: attemptIds.length > 1,
    evidenceRefs,
  });
}

function benchmarkOutcomeForError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /interrupt|abort|cancel|signal/i.test(message) ? "interrupted" : "failed";
}

async function emitReceipt(receipt) {
  const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
  if (args.output) {
    const output = resolve(args.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, rendered, "utf8");
  }
  process.stdout.write(rendered);
}

const verifierCatalog = new VerifierCatalog(verifierProvider);
// The Work contract's own attempt budget. Crew runs exactly one attempt per
// mission, so the repair loop lives here, where the verifier's verdict is
// known. A budget of 1 keeps the previous one-shot behaviour exactly.
const attemptBudget = work.workerPolicy.maxAttempts;
const attempts = [];
const attemptRuntimeControls = [];
let priorAttemptEvidence = [];
let mission;
let workspace;

// Resume continues the Work this Ledger already holds. The Ledger, not this
// process, says how many attempts were spent and whether any is still open.
const resuming = args.resume === "true";
if (args.resume !== undefined && args.resume !== "true") throw new Error("--resume accepts only true");
if (resuming && benchmarkCaseId !== null) throw new Error("--resume cannot be combined with a benchmark run");
let firstAttemptNumber = 1;
let closedOrphanedAttemptIds = [];
if (resuming) {
  const streamId = streamIdForWork(work.id);
  const existing = projectBoard(await ledger.replay(streamId));
  if (!existing.contract) throw new Error(`--resume found no Work ${work.id} in ${ledgerRoot}`);
  if (JSON.stringify(existing.contract) !== JSON.stringify(work)) {
    throw new Error("--resume requires the exact contract the Work was opened with; amend the Work instead");
  }
  if (["accepted", "rejected", "cancelled"].includes(existing.state)) {
    throw new Error(`Work ${work.id} is ${existing.state}; there is nothing to resume`);
  }
  if (existing.state === "ready" || existing.state === "reviewing") {
    throw new Error(`Work ${work.id} is verified and ${existing.state}; review or accept it rather than resuming`);
  }
  closedOrphanedAttemptIds = await closeOrphanedAttempts({
    ledger,
    streamId,
    actor: { id: "service:repository-runner-resume", kind: "service" },
  });
  const spent = Object.keys(projectBoard(await ledger.replay(streamId)).attempts).length;
  if (spent >= attemptBudget) throw new Error(`Work ${work.id} has spent its attempt budget of ${attemptBudget}`);
  firstAttemptNumber = spent + 1;
}

try {
  repositoryRun: {
  for (let attemptNumber = firstAttemptNumber; attemptNumber <= attemptBudget; attemptNumber += 1) {
    run = await new CrewSupervisor({
      plan: parseCrewPlan({
        id: `crew:${work.id}:attempt-${attemptNumber}`.slice(0, 200),
        objective: work.objective,
        baseRevision,
        maxParallel: 1,
        missions: [
          {
            work,
            workspace: { strategy: "fresh", mode: "isolated-write" },
            requiredCapabilities: ["guardedToolMediation"],
            allowDangerousWorker: false,
            // The Work is opened once, by the first attempt. Every later
            // attempt joins that same open Work rather than declaring a
            // second one.
            continuesWork: resuming || attemptNumber > 1,
            priorAttemptEvidence,
          },
        ],
      }),
      ledger,
      workerCatalog: workers,
      workspaceProvider,
      router,
      context,
      refiner,
      actor,
    }).run();

    mission = run.receipt.missions[0];
    assert.ok(mission, "Crew returned no mission receipt");
    if (mission.attemptId) {
      attemptRuntimeControls.push({
        attemptId: mission.attemptId,
        workerProviderId: mission.workerProviderId ?? undefined,
        model: mission.workerResult?.runtime?.model,
        effortLevel: mission.workerResult?.runtime?.effortLevel,
      });
    }
    assert.equal(
      mission.status,
      "execution-finished",
      mission.error ?? "repository Work did not finish execution",
    );
    assert.equal(mission.projectionViolationCount, 0, "Crew produced Board violations");
    assert.deepEqual(mission.changeViolations, [], "worker exceeded Work write scope");
    assert.ok(mission.streamId && mission.taskId && mission.attemptId && mission.workspace);

    workspace = run.workspaces.find(
      (item) => item.workspaceId === mission.workspace.workspaceId,
    );
    assert.ok(workspace, "Crew did not retain the SHIP workspace for verification");
    const preCommitSnapshot = await workspaceProvider.snapshot(workspace);
    candidate = preserveCandidateRemotely({
      repositoryRoot,
      remoteName,
      executionRoot: workspace.executionRoot,
      expectedBaseRevision: baseRevision,
      workId: work.id,
      attemptId: mission.attemptId,
      snapshot: preCommitSnapshot,
      allowed: candidatePathScopesFromResources(work.writeScope),
    });

    const committedSnapshot = await workspaceProvider.snapshot(workspace);
    assert.equal(committedSnapshot.head, candidate.head);
    assert.deepEqual(committedSnapshot.changedPaths, candidate.changedPaths);

    verification = await new VerificationEngine({
      ledger,
      workspaceProvider,
      verifierCatalog,
      verifier: verifierActor,
    }).verify({
      streamId: mission.streamId,
      work,
      contractRevision: 1,
      workspace,
      expectedSnapshot: committedSnapshot,
      plan: verificationPlan,
    });
    assert.equal(verification.target.head, candidate.head);
    assert.equal(verification.projectionViolationCount, 0);

    attempts.push({
      attemptNumber,
      attemptId: mission.attemptId,
      candidateHead: candidate.head,
      verificationStatus: verification.status,
      failedCheckIds: verification.checks
        .filter((check) => check.status !== "pass")
        .map((check) => check.checkId),
    });

    if (verification.status === "pass") break;
    priorAttemptEvidence = priorAttemptEvidenceFrom(attemptNumber, verification, work.id);
  }

  if (verification.status !== "pass") {
    const rejectedAt = new Date().toISOString();
    await ledger.append(parseHarnessEvent({
      id: `event:repository-runner:${globalThis.crypto.randomUUID()}`,
      schemaVersion: 1,
      type: "work.rejected",
      streamId: mission.streamId,
      workId: work.id,
      actor,
      occurredAt: rejectedAt,
      recordedAt: rejectedAt,
      evidence: verification.checks.flatMap((check) => check.evidence),
      payload: {
        reason: `independent verification failed on every one of ${attempts.length} attempt(s)`,
        contractRevision: 1,
      },
    }));
    const rejectionEvents = await ledger.replay(mission.streamId);
    const refinement = await refiner.consume({ workId: work.id, events: rejectionEvents });
    const events = await ledger.replay(mission.streamId);
    persistedBoard = projectBoard(events);
    assert.equal(persistedBoard.state, "rejected");
    assert.equal(persistedBoard.violations.length, 0);

    await ledger.close();
    ledger = null;
    const reopened = await DurableEventLedger.open({
      directory: ledgerRoot,
      ledgerId: `ledger:${work.id}`.slice(0, 200),
    });
    try {
      const replayed = projectBoard(await reopened.replay(mission.streamId));
      assert.equal(replayed.state, "rejected");
      ledgerHeadDigest = (await reopened.integrity()).headDigest;
    } finally {
      await reopened.close();
    }

    await emitReceipt({
      schema: "rhiz/repository-work-run/v1",
      generatedAt: new Date().toISOString(),
      outcome: "verification-exhausted",
      repositoryRoot,
      workId: work.id,
      baseRevision,
      remoteName,
      preparation: preparation === null ? null : { command: preparation.command, args: preparation.args },
      workerProviderId: mission.workerProviderId ?? null,
      attempts,
      attemptBudget,
      ledgerRoot,
      composition: {
        routerDecisionEventIds: events.filter((event) => event.type === "router.decision-made").map((event) => event.id),
        contextPackEventIds: events.filter((event) => event.type === "context.pack-selected").map((event) => event.id),
        refiner: refinement.analysis,
        refinerProposalEventIds: events.filter((event) => event.type === "refiner.proposed").map((event) => event.id),
      },
      candidate: {
        head: candidate.head,
        tree: candidate.tree,
        rescueRef: candidate.rescueRef,
        remoteRef: candidate.remoteRef,
        remoteStatus: candidate.remoteStatus,
        verifiedRef: null,
        changedPaths: candidate.changedPaths,
      },
      verification: {
        id: verification.verificationId,
        resultEventId: verification.verificationResultEventId,
        status: verification.status,
        falsifiability: verification.falsifiability,
        checks: verification.checks.map((check) => ({
          id: check.checkId,
          status: check.status,
          summary: check.summary,
          evidence: check.evidence,
        })),
      },
      board: {
        state: persistedBoard.state,
        violationCount: persistedBoard.violations.length,
        accepted: false,
        integration: persistedBoard.integration,
      },
      checkpoint: null,
      ledgerHeadDigest,
      ...(benchmarkCaseId === null
        ? {}
        : {
            benchmarkRun: benchmarkRunFor({
              outcome: "rejected",
              verified: false,
              resultIdentity: candidate?.head,
              evidenceRefs: verification?.verificationResultEventId
                ? [verification.verificationResultEventId]
                : [],
            }),
          }),
    });
    process.exitCode = 1;
    break repositoryRun;
  }

  // Comparable benchmark arms deliberately share Work id and base, so each
  // execution integrates into its own run-scoped ref. Normal Work keeps the
  // one Work-scoped ref.
  candidateRef = benchmarkRunId === null
    ? `refs/rhiz/work/${harnessGitRefSegment(work.id)}/candidate`
    : `refs/rhiz/work/${harnessGitRefSegment(work.id)}/benchmark-runs/${harnessGitRefSegment(benchmarkRunId)}/candidate`;
  initializeWorkIntegrationRef({
    repositoryRoot,
    remoteName,
    ref: candidateRef,
    head: baseRevision,
  });

  const integration = await IntegrationController.initialize({
    ledger,
    actor: { id: "service:repository-work-runner", kind: "service" },
    workId: work.id,
    configuration: {
      ref: candidateRef,
      head: baseRevision,
      horizonPolicyId: PROVISIONAL_INTEGRATION_HORIZON.id,
      provisionalHorizon: true,
    },
  });
  await integration.recordCheckpoint({
    taskId: mission.taskId,
    attemptId: mission.attemptId,
    checkpoint: {
      id: `checkpoint:${work.id}`.slice(0, 200),
      class: "integration-candidate",
      parentIntegrationHead: baseRevision,
      workspaceId: workspace.workspaceId,
      changedResources: candidate.changedPaths.map((path) => ({
        kind: "path",
        resource: path,
      })),
      head: candidate.head,
      tree: candidate.tree,
      proofState: "passed",
      proofHead: candidate.head,
      verificationEventId: verification.verificationResultEventId,
      remoteRef: candidate.remoteRef,
      remoteStatus: candidate.remoteStatus,
    },
  });
  await integration.integrateNext(new GitWorkIntegrationExecutor({
    repositoryRoot,
    remoteName,
    worktreeRoot: join(runRoot, "integration-worktrees"),
    prove: async ({ targetHead }) => ({
      status: "passed",
      proofHead: targetHead,
      verificationEventId: verification.verificationResultEventId,
      evidence: verification.checks.flatMap((check) => check.evidence),
    }),
  }));
  await integration.authorizeCleanup({
    attemptId: mission.attemptId,
    checkpointId: `checkpoint:${work.id}`.slice(0, 200),
    disposition: "integrated",
  });
  checkpoint = integration.board.integration?.checkpoints[`checkpoint:${work.id}`]?.checkpoint;
  assert.ok(checkpoint, "Integration Controller did not retain the verified checkpoint");

  const events = await ledger.replay(mission.streamId);
  persistedBoard = projectBoard(events);
  // A verified candidate whose Work requires independent review waits in
  // "reviewing" until a passing review is recorded; otherwise it is "ready".
  const verifiedState = work.verificationPolicy.reviewRequired ? "reviewing" : "ready";
  assert.equal(persistedBoard.state, verifiedState);
  assert.equal(persistedBoard.violations.length, 0);

  const sourceRefHead = git(repositoryRoot, ["rev-parse", candidateRef]);
  assert.equal(sourceRefHead, candidate.head, "candidate ref is not durable in the target repository");

  await ledger.close();
  ledger = null;
  const reopened = await DurableEventLedger.open({
    directory: ledgerRoot,
    ledgerId: `ledger:${work.id}`.slice(0, 200),
  });
  try {
    const replayed = projectBoard(await reopened.replay(mission.streamId));
    assert.equal(replayed.state, verifiedState);
    assert.equal(
      replayed.integration?.checkpoints[`checkpoint:${work.id}`]?.checkpoint.head,
      candidate.head,
    );
    ledgerHeadDigest = (await reopened.integrity()).headDigest;
  } finally {
    await reopened.close();
  }

  const receipt = {
    schema: "rhiz/repository-work-run/v1",
    generatedAt: new Date().toISOString(),
    repositoryRoot,
    workId: work.id,
    baseRevision,
    remoteName,
    preparation:
      preparation === null
        ? null
        : { command: preparation.command, args: preparation.args },
    workerProviderId: mission.workerProviderId ?? null,
    // Every attempt this Work cost, in order, with the candidate each one
    // authored and what the independent verifier said about it. A run that
    // converged on the second attempt says so here rather than presenting
    // only the attempt that happened to pass.
    attempts,
    attemptBudget,
    resume: resuming ? { firstAttemptNumber, closedOrphanedAttemptIds } : null,
    // Durable replay location. The default lives under Git metadata; an
    // explicit --ledger selects the base for isolated benchmark run directories.
    ledgerRoot,
    composition: {
      routerDecisionEventIds: events
        .filter((event) => event.type === "router.decision-made")
        .map((event) => event.id),
      contextPackEventIds: events
        .filter((event) => event.type === "context.pack-selected")
        .map((event) => event.id),
      // Refiner consumes closed Work. `ready` is explicitly not closed, so
      // this successful run has no outcome analysis until acceptance.
      refiner: null,
      routerEvidence: routerEvidenceSources,
      refinerProposalEventIds: events
        .filter((event) => event.type === "refiner.proposed")
        .map((event) => event.id),
    },
    candidate: {
      head: candidate.head,
      tree: candidate.tree,
      rescueRef: candidate.rescueRef,
      remoteRef: candidate.remoteRef,
      remoteStatus: candidate.remoteStatus,
      verifiedRef: candidateRef,
      changedPaths: candidate.changedPaths,
    },
    verification: {
      id: verification.verificationId,
      resultEventId: verification.verificationResultEventId,
      status: verification.status,
      falsifiability: verification.falsifiability,
      checks: verification.checks.map((check) => ({
        id: check.checkId,
        status: check.status,
        summary: check.summary,
        evidence: check.evidence,
      })),
    },
    board: {
      state: persistedBoard.state,
      violationCount: persistedBoard.violations.length,
      accepted: false,
      integration: persistedBoard.integration,
    },
    checkpoint,
    ledgerHeadDigest,
    ...(benchmarkCaseId === null
      ? {}
      : {
          benchmarkRun: benchmarkRunFor({
            outcome: "verified",
            verified: true,
            resultIdentity: candidate.head,
            evidenceRefs: [verification.verificationResultEventId],
          }),
        }),
  };
  await emitReceipt(receipt);
  }
} catch (error) {
  if (benchmarkCaseId !== null) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failureEvents = mission?.streamId && ledger
      ? (await ledger.replay(mission.streamId).catch(() => []))
          .filter((event) => event.type === "attempt.failed" && event.attemptId === mission.attemptId)
          .map((event) => event.id)
      : [];
    const evidenceRefs = [
      ...(verification?.verificationResultEventId ? [verification.verificationResultEventId] : []),
      ...failureEvents.slice(-1),
    ];
    const benchmarkRun = benchmarkRunFor({
      outcome: benchmarkOutcomeForError(error),
      verified: verification?.status === "pass",
      resultIdentity: candidate?.head,
      evidenceRefs,
    });
    await emitReceipt({
      schema: "rhiz/repository-work-run/v1",
      generatedAt: new Date().toISOString(),
      outcome: "runner-error",
      repositoryRoot,
      workId: work.id,
      baseRevision,
      remoteName,
      preparation:
        preparation === null
          ? null
          : { command: preparation.command, args: preparation.args },
      workerProviderId: mission?.workerProviderId ?? null,
      attempts,
      attemptBudget,
      ledgerRoot,
      candidate:
        candidate === undefined
          ? null
          : {
              head: candidate.head,
              tree: candidate.tree,
              rescueRef: candidate.rescueRef,
              remoteRef: candidate.remoteRef,
              remoteStatus: candidate.remoteStatus,
              verifiedRef: candidateRef ?? null,
              changedPaths: candidate.changedPaths,
            },
      verification:
        verification === undefined
          ? null
          : {
              id: verification.verificationId,
              resultEventId: verification.verificationResultEventId,
              status: verification.status,
              falsifiability: verification.falsifiability,
              checks: verification.checks.map((check) => ({
                id: check.checkId,
                status: check.status,
                summary: check.summary,
                evidence: check.evidence,
              })),
            },
      board:
        persistedBoard === undefined
          ? null
          : {
              state: persistedBoard.state,
              violationCount: persistedBoard.violations.length,
              accepted: false,
              integration: persistedBoard.integration,
            },
      checkpoint: checkpoint ?? null,
      ledgerHeadDigest: ledgerHeadDigest ?? null,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: errorMessage,
      },
      benchmarkRun,
    });
    benchmarkFailureRecorded = true;
  }
  throw error;
} finally {
  if (run) await run.close().catch(() => undefined);
  if (ledger) await ledger.close().catch(() => undefined);
  await verifierProvider.close().catch(() => undefined);
  await host.close().catch(() => undefined);
  await workspaceProvider.close().catch(() => undefined);
  // Scratch worktrees go; the Ledger stays in its durable location.
  await rm(runRoot, { recursive: true, force: true });
}
} catch (error) {
  if (!benchmarkFailureRecorded) {
    await emitEarlyBenchmarkFailure(error);
    await earlyVerifierProvider?.close?.().catch(() => undefined);
    await earlyHost?.close?.().catch(() => undefined);
    await earlyWorkspaceProvider?.close?.().catch(() => undefined);
    await earlyLedger?.close?.().catch(() => undefined);
  }
  throw error;
}
