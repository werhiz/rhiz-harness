import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  InMemoryEventLedger,
  parseHarnessEvent,
  parseWorkContract,
  projectBoard,
  startWorkerAttempt,
} from "../dist/src/index.js";
import {
  assertDshProductOperatorProof,
  createDshProductWorkerHost,
  evaluateDshProductOperatorProof,
  resolveDshProductRoutes,
} from "../dist/adapters/dsh/products.js";

const MAX_BUFFER = 64 * 1024 * 1024;

function gitText(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER }).trim();
}

function gitBuffer(cwd, args) {
  return execFileSync("git", args, { cwd, maxBuffer: MAX_BUFFER });
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 4000);
}

function workspaceDigest(cwd) {
  const hash = createHash("sha256");
  const add = (label, value) => {
    hash.update(label);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  };

  add("head", gitBuffer(cwd, ["rev-parse", "HEAD"]));
  add("status", gitBuffer(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  add("unstaged", gitBuffer(cwd, ["diff", "--binary", "--no-ext-diff"]));
  add("staged", gitBuffer(cwd, ["diff", "--cached", "--binary", "--no-ext-diff"]));

  const untracked = gitBuffer(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const relativePath of untracked) {
    const absolutePath = join(cwd, relativePath);
    const stat = lstatSync(absolutePath);
    add("untracked-path", relativePath);
    if (stat.isSymbolicLink()) add("untracked-link", readlinkSync(absolutePath));
    else if (stat.isFile()) add("untracked-file", readFileSync(absolutePath));
  }

  return `sha256:${hash.digest("hex")}`;
}

function explicitEnv(names) {
  const env = {};
  const present = [];
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    env[name] = value;
    present.push(name);
  }
  return { env, present };
}

const root = gitText(process.cwd(), ["rev-parse", "--show-toplevel"]);
const repository = basename(root);
const branch = gitText(root, ["branch", "--show-current"]) || "(detached)";
const head = gitText(root, ["rev-parse", "HEAD"]);
const dependencyHome = resolve(
  process.env.RHIZ_DSH_PRODUCT_HOME ?? join(root, ".context/rhiz-harness/dsh-products"),
);
const dependencyManifest = join(dependencyHome, "package.json");
if (!existsSync(dependencyManifest)) {
  throw new Error("DSH product dependencies are not installed; run npm run setup:dsh-products first");
}

const dependencyRequire = createRequire(dependencyManifest);
const requiredModules = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-subagent",
  "@deepseek-ai/dsh-subprocess",
  "@deepseek-ai/dsh-subprocess-local",
  "@deepseek-ai/dsh-subagent-codex",
  "@deepseek-ai/dsh-subagent-claude-code",
];
for (const specifier of requiredModules) dependencyRequire.resolve(specifier);
const loadModule = async (specifier) => import(pathToFileURL(dependencyRequire.resolve(specifier)).href);

const nonce = `RHIZ-PROOF-${randomUUID()}`;
const human = { id: "human:dsh-product-operator-proof", kind: "human" };
const sourceBefore = workspaceDigest(root);
const createdAt = new Date().toISOString();
const contract = parseWorkContract({
  id: `work:dsh-product-operator-proof:${nonce}`,
  objective: [
    "Perform a read-only repository diagnostic in the disposable proof worktree.",
    `Return the exact marker ${nonce} and exact HEAD ${head} in the first two lines of the final answer.`,
    "Then report the current repository name and one sentence describing Rhiz Harness.",
  ].join(" "),
  type: "SCOUT",
  scope: [{ uri: "repo://rhiz-harness", kind: "repository" }],
  writeScope: [],
  nonGoals: [
    "Do not modify, create, delete, stage, commit, stash, or publish any file or ref",
    "Do not access or reveal credentials, tokens, account data, or unrelated user files",
    "Do not contact external systems or expand the task",
  ],
  authority: {
    grants: [
      {
        action: "read",
        resources: [{ uri: "repo://rhiz-harness", kind: "repository" }],
        constraints: ["repository inspection only"],
      },
      {
        action: "execute",
        resources: [{ uri: "repo://rhiz-harness", kind: "repository" }],
        constraints: ["non-mutating inspection commands only"],
      },
    ],
    requiresHumanApproval: ["write", "publish", "external-mutate"],
  },
  acceptanceCriteria: [
    { id: "criterion:nonce", description: "Final answer carries the exact proof nonce", required: true },
    { id: "criterion:head", description: "Final answer carries the exact repository HEAD", required: true },
    { id: "criterion:unchanged", description: "Disposable workspace digest remains byte-identical", required: true },
  ],
  requiredEvidence: [],
  context: {
    strategy: "minimal",
    resources: [{ uri: "repo://rhiz-harness", kind: "repository" }],
    includeHistory: false,
  },
  dependencies: [],
  workerPolicy: {
    preferredProviders: ["worker:codex", "worker:claude"],
    maxAttempts: 1,
    allowParallelAttempts: false,
  },
  verificationPolicy: {
    required: true,
    independentActor: true,
    reviewRequired: false,
  },
  createdBy: human,
  createdAt,
});
const contractDigest = sha256(JSON.stringify(contract));

const codexCredentials = explicitEnv(["OPENAI_API_KEY"]);
const claudeCredentials = explicitEnv(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
const routes = [
  {
    product: "codex",
    workerId: "worker:codex",
    providerName: "rhiz-codex",
    permissionMode: "never",
    env: codexCredentials.env,
  },
  {
    product: "claude-code",
    workerId: "worker:claude",
    providerName: "rhiz-claude",
    permissionMode: "plan",
    env: claudeCredentials.env,
  },
];

async function runWorker(rawRoute, index) {
  const route = resolveDshProductRoutes([rawRoute])[0];
  const workerActor = { id: route.workerId, kind: "agent" };
  const taskId = `task:dsh-product-operator-proof:${index}`;
  const attemptId = `attempt:dsh-product-operator-proof:${index}:${Date.now()}`;
  const streamId = `stream:dsh-product-operator-proof:${index}`;
  const container = mkdtempSync(join(tmpdir(), `rhiz-${route.product}-proof-`));
  const proofWorkspace = join(container, "repo");
  const ledger = new InMemoryEventLedger();
  const observations = [];
  let eventCounter = 0;
  let host;
  let before = sha256("worktree-not-created");
  let after = before;
  let outcome = "error";
  let summary = "operator proof did not start";
  let artifactCount = 0;
  let evidenceCount = 0;
  let boardState = "error";
  let violationCount = 0;
  let errorMessage;
  let worktreeAdded = false;

  const event = (type, payload, extra = {}) => {
    eventCounter += 1;
    const timestamp = new Date().toISOString();
    return parseHarnessEvent({
      id: `event:dsh-product-operator-proof:${index}:${eventCounter}`,
      type,
      schemaVersion: 1,
      streamId,
      workId: contract.id,
      actor: human,
      occurredAt: timestamp,
      recordedAt: timestamp,
      evidence: [],
      payload,
      ...extra,
    });
  };

  try {
    execFileSync("git", ["worktree", "add", "--detach", proofWorkspace, head], {
      cwd: root,
      stdio: "ignore",
    });
    worktreeAdded = true;
    before = workspaceDigest(proofWorkspace);

    // Host-level cwd is gone since issue #9. Execution location now travels with
    // the attempt as a WorkspaceBinding, which is what this script had to work
    // around by hand before the portable contract could carry it.
    host = createDshProductWorkerHost({
      routes: [rawRoute],
      loadModule,
      subprocessMode: "local",
    });

    await ledger.append(event("work.created", { contract, revision: 1 }));
    await ledger.append(event("task.created", { objective: contract.objective }, { taskId }));
    await ledger.append(event("task.assigned", { worker: workerActor }, { taskId }));
    await ledger.append(event(
      "attempt.started",
      { worker: workerActor, contractRevision: 1 },
      { taskId, attemptId, actor: workerActor },
    ));

    const provider = host.workers().get(route.workerId);
    if (!provider) throw new Error(`Host exposed no ${route.workerId} provider`);
    const started = await startWorkerAttempt(provider, {
      work: contract,
      taskId,
      attemptId,
      objective: contract.objective,
      authority: contract.authority,
      context: contract.context,
      workspace: {
        workspaceId: `workspace:operator-proof:${attemptId}`,
        leaseId: `lease:operator-proof:${attemptId}`,
        uri: pathToFileURL(proofWorkspace).href,
        executionRoot: proofWorkspace,
        mode: "isolated-write",
        baseRevision: head,
        expectedHead: head,
      },
    });
    const collecting = (async () => {
      for await (const observation of started.handle.observe()) observations.push(observation);
    })();
    const result = await started.handle.result();
    await collecting;

    outcome = result.status;
    summary = result.summary;
    artifactCount = result.artifacts.length;
    evidenceCount = result.evidence.length;
    if (result.status === "finished") {
      await ledger.append(event(
        "attempt.finished",
        { resultSummary: result.summary, artifactRefs: result.artifacts },
        { taskId, attemptId, actor: workerActor },
      ));
    } else {
      await ledger.append(event(
        "attempt.failed",
        { reason: result.summary, recoverable: false },
        { taskId, attemptId, actor: workerActor },
      ));
    }
    const board = projectBoard(await ledger.replay(streamId));
    boardState = board.state;
    violationCount = board.violations.length;
  } catch (error) {
    errorMessage = safeError(error);
    summary = errorMessage;
    try {
      await ledger.append(event(
        "attempt.failed",
        { reason: errorMessage, recoverable: false },
        { taskId, attemptId, actor: workerActor },
      ));
      const board = projectBoard(await ledger.replay(streamId));
      boardState = board.state;
      violationCount = board.violations.length;
    } catch {
      boardState = "error";
    }
  } finally {
    if (host) {
      try {
        await host.close();
      } catch (error) {
        errorMessage ??= safeError(error);
      }
    }
    if (worktreeAdded) {
      try {
        after = workspaceDigest(proofWorkspace);
      } catch (error) {
        errorMessage ??= safeError(error);
      }
      try {
        execFileSync("git", ["worktree", "remove", "--force", proofWorkspace], {
          cwd: root,
          stdio: "ignore",
        });
      } catch (error) {
        errorMessage ??= `worktree cleanup failed: ${safeError(error)}`;
      }
    }
    rmSync(container, { recursive: true, force: true });
  }

  const credentialNames = Object.keys(route.env).sort();
  return {
    workerId: route.workerId,
    product: route.product,
    productVersion: route.descriptor.productVersion,
    authorityMode: route.descriptor.authorityMode,
    credentialSource: credentialNames.length > 0 ? "explicit-env" : "native-account-or-settings",
    credentialEnvNames: credentialNames,
    attemptId,
    contractDigest,
    outcome,
    summaryDigest: sha256(summary),
    summaryLength: summary.length,
    nonceEchoed: summary.includes(nonce),
    headEchoed: summary.includes(head),
    observationCount: observations.length,
    boardState,
    violationCount,
    artifactCount,
    evidenceCount,
    workspaceBefore: before,
    workspaceAfter: after,
    workspaceUnchanged: before === after,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  };
}

const workers = [];
for (const [index, route] of routes.entries()) workers.push(await runWorker(route, index));
const sourceAfter = workspaceDigest(root);
const proof = {
  schema: "rhiz/dsh-product-operator-proof/v0",
  generatedAt: new Date().toISOString(),
  source: {
    repository,
    branch,
    head,
    workspaceBefore: sourceBefore,
    workspaceAfter: sourceAfter,
    workspaceUnchanged: sourceBefore === sourceAfter,
  },
  nonce,
  contractDigest,
  workers,
};
const evaluation = evaluateDshProductOperatorProof(proof);
const receipt = { ...proof, evaluation: { ok: evaluation.ok, failures: evaluation.failures } };
const rendered = `${JSON.stringify(receipt, null, 2)}\n`;

const output = process.env.RHIZ_DSH_PRODUCT_PROOF_OUTPUT;
if (output) {
  const outputPath = resolve(output);
  if (outputPath === root || outputPath.startsWith(`${root}${sep}`)) {
    throw new Error("RHIZ_DSH_PRODUCT_PROOF_OUTPUT must point outside the repository");
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered, "utf8");
}

process.stdout.write(rendered);
assertDshProductOperatorProof(proof);
