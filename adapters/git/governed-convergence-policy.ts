import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { z } from "zod";
import { WorkContractSchema } from "../../src/schemas.js";
import { HARDENED_GIT_FLAGS, hardenedGitEnv } from "./worktrees.js";
import { harnessGitRefSegment } from "./checkpoints.js";

const FIXED_HOOK = ".claude/hooks/horizon-check.sh" as const;
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const stable = (value: unknown) => JSON.stringify(value);

const EnvelopeSchema = z.object({
  schema: z.literal("rhiz/governed-convergence-policy-envelope/v1"),
  workId: z.string().regex(/^work:horizon-convergence-[a-f0-9]{40}$/),
  manifest: z.record(z.string(), z.unknown()),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputCheckpointDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const sha = (value: string) => `sha256:${hash(value)}`;

export function canonicalGovernedReviewHeading(body: string, head: string, allowReady = true): { verdict: "READY" | "NOT READY"; namedHead: string } | undefined {
  if (!/^[a-f0-9]{40}$/.test(head)) return undefined;
  const pattern = allowReady ? /^## (NOT READY|READY) at ([a-f0-9]{7,40})\s*$/m : /^## (NOT READY) at ([a-f0-9]{7,40})\s*$/m;
  const match = pattern.exec(body);
  if (!match) return undefined;
  if (!head.startsWith(match[2]!) || !body.includes("<!-- rhiz-review-agent -->") || !body.includes(`Independent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${head}\`.`)) return undefined;
  return { verdict: match[1] as "READY" | "NOT READY", namedHead: match[2]! };
}

export function assertGovernedExecutionRootIdentity(workerDigest: string | undefined, verifierDigest: string | undefined): void {
  if (!workerDigest || workerDigest !== verifierDigest) throw new Error("worker and verifier did not observe the same governed execution-root digest");
}

export function governedConvergenceObjective(artifactPath: string, packetBlob: string): string {
  return `Artifact producer only: Copy the complete JSON manifest supplied in the Context into ${artifactPath}, retaining every field and its order. The manifest is the complete producer input; packetBlob and inputCheckpoint intentionally reference a separate immutable packet, not missing patch data. Use the native file-change tool to create only this artifact; its parent directories are already prepared. Do not run shell commands, inspect the referenced packet/source blobs, perform review, or satisfy the separate reviewer obligations. Packaging makes no authorship, semantic correctness, verification, acceptance, or source-application claim. Do not modify any source file. Independent review only: After the producer has completed its packaging and Verify has passed, the separate independent reviewer must read the WHOLE immutable packet via git cat-file blob ${packetBlob}, inspect the actual original and accepted-main blobs, and judge preservation of both source legs and repair-only scope against its active findings. The reviewer must refuse if the whole patch or its source evidence cannot be inspected. These obligations belong to the reviewer, not the artifact producer. Deterministic identity checks do not prove these semantics.`;
}
const git = (cwd: string, args: string[]) => execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
  cwd, encoding: "utf8", maxBuffer: MAX_ENVELOPE_BYTES, env: hardenedGitEnv(),
}).trim();
const gitBytes = (cwd: string, args: string[]) => execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], {
  cwd, maxBuffer: MAX_ENVELOPE_BYTES, env: hardenedGitEnv(),
});
function safeSourcePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.includes("\n") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("governed source snapshot contains an unsafe path");
  return value;
}
function verifySourceSnapshot(root: string, expected: Record<string, unknown>): void {
  const branch = git(root, ["branch", "--show-current"]);
  const head = git(root, ["rev-parse", branch]);
  const status = gitBytes(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const rows = status.toString("utf8").split("\0").filter(Boolean);
  const dirty = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    dirty.add(safeSourcePath(row.slice(3)));
    if (row[0] === "R" || row[1] === "R" || row[0] === "C" || row[1] === "C") dirty.add(safeSourcePath(rows[++i] ?? ""));
  }
  const files = [...dirty].sort().map((name) => {
    const filename = join(root, name);
    try {
      const stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(filename) !== resolve(realpathSync(root), name)) throw new Error(`governed source file is not a regular in-root file: ${name}`);
      return [name, { digest: hash(readFileSync(filename)), mode: stat.mode & 0o777 }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, null];
      throw error;
    }
  });
  const index = gitBytes(root, ["ls-files", "--stage", "-z"]);
  const unmerged = gitBytes(root, ["ls-files", "--unmerged", "-z"]);
  let mergeHead: string | null = null;
  try { mergeHead = git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]); } catch { /* no in-progress merge */ }
  const state = { head, currentBranch: branch, mergeHead, statusDigest: hash(status), indexDigest: hash(index), unmergedDigest: hash(unmerged), files };
  const unmergedPaths = [...new Set(unmerged.toString("utf8").split("\0").filter(Boolean).map((row) => safeSourcePath(row.slice(row.indexOf("\t") + 1))))].sort();
  if (hash(stable(state)) !== expected.digest || state.head !== expected.head || state.currentBranch !== expected.currentBranch || state.mergeHead !== expected.mergeHead || stable(files) !== stable(expected.files) || stable(unmergedPaths) !== stable(expected.unmergedPaths)) throw new Error("governed source checkout changed since the immutable packet was captured");
}
function verifyConvergencePacket(root: string, packet: Record<string, unknown>, sourceHead: string, acceptedHead: string): void {
  const packetKeys = ["schema", "request", "source", "forge", "originals", "projected", "mergeStages", "executionPolicy"].sort();
  if (stable(Object.keys(packet).sort()) !== stable(packetKeys) || packet.schema !== "rhiz/convergence-artifact/v1") throw new Error("retained convergence packet has unsupported shape");
  const policy = packet.executionPolicy as Record<string, unknown>;
  if (!policy || (policy.mode !== "overlay" && policy.mode !== "no-overlay")) throw new Error("retained convergence policy mode is unsupported");
  const expectedPolicyKeys = policy.mode === "overlay" ? ["mode", "workId", "purpose", "path", "source", "accepted"].sort() : ["mode", "workId", "purpose", "path"].sort();
  if (stable(Object.keys(policy).sort()) !== stable(expectedPolicyKeys) || policy.workId === undefined || policy.path !== FIXED_HOOK || policy.purpose !== "horizon-governed-detached-workspace") throw new Error("retained convergence policy descriptor is unsupported");
  const request = packet.request as Record<string, unknown>;
  if (!request || stable(Object.keys(request).sort()) !== stable(["schema", "purpose", "paths", "patch", "reviewCommentUrl"].sort()) || request.schema !== "rhiz/convergence-request/v1" || !["resolve-integration", "repair-reviewed-target"].includes(String(request.purpose)) || typeof request.patch !== "string" || !request.patch.trim() || request.patch.includes("\0") || request.patch.includes("GIT binary patch") || /^(?:deleted file mode|new file mode|rename from|rename to|old mode|new mode) /m.test(request.patch) || !Array.isArray(request.paths) || request.paths.length < 1 || request.paths.length > 64 || new Set(request.paths).size !== request.paths.length || request.paths.some((path) => typeof path !== "string" || !/^[A-Za-z0-9._/-]+$/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") || path.split("/").some((part) => [".git", ".codex", ".context", "node_modules"].includes(part) || part.startsWith(".env") || part.startsWith(".rhiz-horizon"))) || stable(request.paths) !== stable([...request.paths].sort())) throw new Error("retained convergence request is unsupported or unsafe");
  if (typeof request.reviewCommentUrl !== "string") throw new Error("retained convergence review URL is invalid");
  const numstat = execFileSync("git", [...HARDENED_GIT_FLAGS, "apply", "--numstat", "-z", "-"], { cwd: root, input: request.patch, maxBuffer: MAX_ENVELOPE_BYTES, env: hardenedGitEnv() }).toString("utf8").split("\0").filter(Boolean);
  const patchPaths = numstat.map((row) => {
    const [added, removed, ...name] = row.split("\t");
    if (!/^\d+$/.test(added ?? "") || !/^\d+$/.test(removed ?? "")) throw new Error("governed patch has unmeasurable or binary changes");
    return safeSourcePath(name.join("\t"));
  }).sort();
  if (stable(patchPaths) !== stable(request.paths)) throw new Error("governed patch paths differ from exact retained request scope");
  const forge = packet.forge as Record<string, unknown>;
  const comment = forge.comment as Record<string, unknown>;
  if (request.reviewCommentUrl !== comment.commentUrl || forge.head !== sourceHead || forge.integration !== acceptedHead || (request.purpose === "resolve-integration" && forge.integration !== (packet.source as Record<string, unknown>).mergeHead) || (request.purpose === "repair-reviewed-target" && ((packet.source as Record<string, unknown>).mergeHead !== null || ((packet.source as Record<string, unknown>).unmergedPaths as unknown[]).length !== 0))) throw new Error("retained convergence source and forge legs do not match the governed purpose");

  const actualStages = gitBytes(root, ["ls-files", "--unmerged", "-z"]).toString("utf8").split("\0").filter(Boolean).map((row) => {
    const [metadata, path] = row.split("\t");
    const [mode, blob, stage] = (metadata ?? "").split(" ");
    return { path, mode, blob, stage: Number(stage) };
  });
  const stages = packet.mergeStages as Array<{ path: string; mode: string; blob: string; stage: number }>;
  if (!Array.isArray(stages)) throw new Error("retained merge stages are invalid");
  if (request.purpose === "resolve-integration") {
    const bases = git(root, ["merge-base", "--all", sourceHead, acceptedHead]).split("\n");
    const sortedStages = [...stages].sort((a, b) => a.path.localeCompare(b.path) || a.stage - b.stage);
    const sortedActual = [...actualStages].sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "") || a.stage - b.stage);
    if (bases.length !== 1 || !stages.length || stable(sortedActual) !== stable(sortedStages)) throw new Error("live merge stages differ from retained convergence evidence");
    for (const stage of stages) {
      const ref = stage.stage === 1 ? bases[0]! : stage.stage === 2 ? sourceHead : stage.stage === 3 ? acceptedHead : "";
      if (!ref) throw new Error("retained merge stage number is unsupported");
      const row = gitBytes(root, ["ls-tree", "-z", ref, "--", stage.path]).toString("utf8").split("\0").filter(Boolean);
      if (row.length !== 1 || row[0]!.split("\t")[0] !== `${stage.mode} blob ${stage.blob}`) throw new Error("retained merge stage differs from source, accepted main, or merge base");
    }
    const conflictPaths = [...new Set(stages.map((stage) => stage.path))].sort();
    if (conflictPaths.some((path) => !(request.paths as string[]).includes(path))) throw new Error("convergence request omits a live conflict path");
  } else {
    try { git(root, ["merge-base", "--is-ancestor", acceptedHead, sourceHead]); } catch { throw new Error("repair-reviewed target is not fully integrated with accepted main"); }
    if (actualStages.length || stages.length) throw new Error("repair-reviewed target cannot carry unresolved merge stages");
  }
}
function sameRepositoryOrigin(root: string, prUrl: string): boolean {
  const target = new URL(prUrl);
  const parts = target.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull") return false;
  const [owner, repo] = parts;
  const configured = git(root, ["config", "--get", "remote.origin.url"]);
  const normalized = configured
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
  return normalized === `${target.origin}/${owner}/${repo}`;
}

const brand: unique symbol = Symbol("ValidatedGovernedConvergencePolicy");
type GovernedPolicyCommon = Readonly<{
  [brand]: true;
  workId: string;
  sourceHead: string;
  acceptedHead: string;
  path: typeof FIXED_HOOK;
  packetDigest: string;
  manifestDigest: string;
  inputCheckpoint: Readonly<{ ref: string; head: string; blob: string; digest: string }>;
  manifestBytes: Buffer;
  envelopeBytes: Buffer;
}>;
type HookIdentity = Readonly<{ mode: "100755"; blob: string; sha256: string }>;
export type ValidatedGovernedConvergencePolicy = GovernedPolicyCommon & (
  | Readonly<{ mode: "overlay"; source: HookIdentity; accepted: HookIdentity; acceptedBytes: Buffer }>
  | Readonly<{ mode: "no-overlay"; source: null; accepted: null; acceptedBytes: null }>
);

function readEnvelope(filename: string): { bytes: Buffer; value: z.infer<typeof EnvelopeSchema> } {
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ENVELOPE_BYTES) throw new Error("governed convergence envelope must be a bounded regular file");
    const bytes = readFileSync(fd);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = EnvelopeSchema.parse(JSON.parse(text));
    if (bytes.includes(0) || stable(value) !== text.trim()) throw new Error("governed convergence envelope is not canonical UTF-8 JSON");
    return { bytes, value };
  } finally { closeSync(fd); }
}

function treeBlob(root: string, commit: string, path: string): { mode: "100755"; blob: string } | null {
  const rows = gitBytes(root, ["ls-tree", "-z", commit, "--", path]).toString("utf8").split("\0").filter(Boolean);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error(`governed hook is ambiguous at ${commit}`);
  const match = /^(100755) blob ([a-f0-9]{40})\t\.claude\/hooks\/horizon-check\.sh$/.exec(rows[0]!);
  if (!match) throw new Error(`governed hook must be absent or a tracked regular 100755 file at ${commit}`);
  return { mode: "100755", blob: match[2]! };
}

function verifyHook(root: string, commit: string): { mode: "100755"; blob: string; sha256: string; bytes: Buffer } {
  const entry = treeBlob(root, commit, FIXED_HOOK);
  if (!entry) throw new Error(`governed hook is absent at ${commit}`);
  const bytes = gitBytes(root, ["cat-file", "blob", entry.blob]);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (bytes.includes(0)) throw new Error("governed hook must be UTF-8 shell text without NUL");
  return { mode: "100755", blob: entry.blob, sha256: hash(bytes), bytes };
}

/** Validate authority from retained Git/forge evidence; JSON is transport only. */
export function validateGovernedConvergencePolicy(options: {
  repositoryRoot: string;
  baseRevision: string;
  contract: unknown;
  envelopeFilename: string;
}): ValidatedGovernedConvergencePolicy {
  const root = resolve(options.repositoryRoot);
  const contract = WorkContractSchema.parse(options.contract);
  const { value } = readEnvelope(options.envelopeFilename);
  const manifest = value.manifest;
  if (hash(stable(manifest)) !== value.manifestDigest || stable(manifest) !== stable(value.manifest)) throw new Error("governed manifest digest mismatch");
  if (manifest.workId !== value.workId || manifest.schema !== "rhiz/convergence-artifact/v1") throw new Error("governed manifest does not bind the requested Work");

  // Authority comes from the immutable retained input ref derived from Work id.
  const inputRef = `refs/rhiz/work/${harnessGitRefSegment(value.workId)}/convergence-input`;
  const localInputHead = git(root, ["rev-parse", "--verify", inputRef]);
  const origin = git(root, ["remote", "get-url", "origin"]);
  const remote = execFileSync("git", [...HARDENED_GIT_FLAGS, "ls-remote", origin, inputRef], { cwd: root, encoding: "utf8", maxBuffer: MAX_ENVELOPE_BYTES, env: hardenedGitEnv() }).trim().split("\t")[0];
  if (!remote || remote !== localInputHead) throw new Error("governed input checkpoint is not durably retained at the exact remote ref");
  const checkpointBlob = git(root, ["rev-parse", `${localInputHead}:artifact.json`]);
  const checkpointParent = git(root, ["rev-parse", `${localInputHead}^1`]);
  const checkpointParentTree = git(root, ["rev-parse", `${checkpointParent}^{tree}`]);
  const checkpointParentLegs = git(root, ["rev-list", "--parents", "-n", "1", checkpointParent]).split(" ").slice(1);
  const packetBytes = gitBytes(root, ["cat-file", "blob", checkpointBlob]);
  const packetText = new TextDecoder("utf-8", { fatal: true }).decode(packetBytes);
  const packet = JSON.parse(packetText);
  const packetDigest = hash(packetText);
  const inputCheckpoint = manifest.inputCheckpoint as Record<string, unknown> | undefined;
  if (packetDigest !== value.inputCheckpointDigest || inputCheckpoint?.head !== localInputHead || inputCheckpoint?.blob !== checkpointBlob || inputCheckpoint?.ref !== inputRef || manifest.packetBlob !== checkpointBlob) throw new Error("governed input checkpoint identity mismatch");
  if (packet.schema !== "rhiz/convergence-artifact/v1" || manifest.packetDigest !== hash(stable(packet))) throw new Error("retained convergence packet digest mismatch");

  const request = packet.request;
  const expectedWorkId = `work:horizon-convergence-${hash(stable([packet.forge.prUrl, packet.forge.head, packet.forge.comment.commentId, request.purpose])).slice(0, 40)}`;
  if (expectedWorkId !== value.workId || contract.id !== value.workId || options.baseRevision !== packet.source.head || packet.forge.head !== packet.source.head) throw new Error("governed Work/source identity mismatch");
  const artifactPath = `tools/horizon-convergence-artifacts/${value.workId.slice(-40)}/artifact.json`;
  const contextPath = `.context/horizon-convergence/${value.workId.slice(-40)}.json`;
  const expectedWriteScope = [`repo://source/${artifactPath}`, ...request.paths.map((path: string) => `repo://source/${path}`)].sort();
  const actualWriteScope = contract.writeScope.map((resource) => resource.uri).sort();
  const objective = governedConvergenceObjective(artifactPath, checkpointBlob);
  const expectedResources = [{ uri: `repo://source/${artifactPath}`, kind: "file" }, ...request.paths.map((path: string) => ({ uri: `repo://source/${path}`, kind: "file" }))];
  const expectedAuthority = { grants: [
    { action: "read", resources: [{ uri: "repo://source", kind: "repository" }], constraints: [] },
    { action: "write", resources: expectedResources, constraints: [] },
  ], requiresHumanApproval: ["publish", "external-mutate", "spend"] };
  const expectedNonGoals = ["No source writes in this attempt", "No application effects or accepted Outcome", "No new feature scope, clock reset, authority widening, or fabricated proof"];
  const expectedCriteria = [{ id: "criterion:exact-convergence-artifact", description: "Artifact exactly retains the captured source snapshot, explicit source scope and proposed patch; no other candidate file changes.", required: true }];
  const expectedEvidence = [{ id: "evidence:convergence-check", description: "Actual exact-artifact check with an altered-artifact negative control", acceptedKinds: ["test"], required: true }];
  const auditEmail = git(root, ["config", "user.email"]);
  const contractFailures = [
    contract.type !== "SHIP" && "type",
    stable(actualWriteScope) !== stable(expectedWriteScope) && "writeScopeUris",
    stable(contract.scope) !== stable([{ uri: "repo://source", kind: "repository" }]) && "scope",
    stable(contract.writeScope) !== stable(expectedResources) && "writeScope",
    stable(contract.authority) !== stable(expectedAuthority) && "authority",
    stable(contract.nonGoals) !== stable(expectedNonGoals) && "nonGoals",
    stable(contract.acceptanceCriteria) !== stable(expectedCriteria) && "acceptanceCriteria",
    stable(contract.requiredEvidence) !== stable(expectedEvidence) && "requiredEvidence",
    (contract.createdBy.kind !== "human" || contract.createdBy.id !== `human:${auditEmail}`.slice(0, 200)) && "creator",
    !Number.isFinite(Date.parse(contract.createdAt)) && "createdAt",
    contract.dependencies.length !== 0 && "dependencies",
    contract.objective !== objective && "objective",
    contract.context.strategy !== "explicit" && "contextStrategy",
    stable(contract.context.resources) !== stable([{ uri: `repo://source/${contextPath}`, kind: "file" }]) && "contextResources",
    contract.context.tokenBudget !== 32768 && "contextBudget",
    contract.context.includeHistory !== false && "contextHistory",
    contract.verificationPolicy.required !== true && "verificationRequired",
    contract.verificationPolicy.reviewRequired !== true && "reviewRequired",
    contract.verificationPolicy.independentActor !== true && "independentActor",
    stable(contract.workerPolicy.preferredProviders) !== stable(["worker:codex-app-server"]) && "preferredProviders",
    contract.workerPolicy.maxAttempts !== 1 && "attempts",
    contract.workerPolicy.allowParallelAttempts !== false && "parallelAttempts",
  ].filter(Boolean);
  if (contractFailures.length) throw new Error(`governed policy is limited to the exact fixed convergence contract (${contractFailures.join(", ")})`);

  const sourceHead = packet.source.head;
  const acceptedHead = packet.forge.integration;
  verifyConvergencePacket(root, packet as Record<string, unknown>, sourceHead, acceptedHead);
  if (checkpointParentTree !== packet.projected.tree || stable(checkpointParentLegs) !== stable([sourceHead, acceptedHead])) throw new Error("retained checkpoint parent does not bind the exact projected tree and both source legs");
  if (!/^[a-f0-9]{40}$/.test(sourceHead) || !/^[a-f0-9]{40}$/.test(acceptedHead) || git(root, ["rev-parse", `${options.baseRevision}^{commit}`]) !== sourceHead) throw new Error("governed source or accepted head is unavailable");
  verifySourceSnapshot(root, packet.source as Record<string, unknown>);
  const pr = JSON.parse(execFileSync("gh", ["pr", "view", String(packet.forge.prNumber), "--json", "number,url,state,headRefOid,baseRefName,baseRefOid,comments"], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: MAX_ENVELOPE_BYTES }));
  const branch = git(root, ["branch", "--show-current"]);
  const upstream = git(root, ["rev-parse", `${branch}@{upstream}`]);
  const remoteMain = JSON.parse(execFileSync("gh", ["api", "--hostname", new URL(packet.forge.prUrl).hostname, `repos/${new URL(packet.forge.prUrl).pathname.split("/").filter(Boolean).slice(0, 2).join("/")}/git/ref/heads/main`], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: MAX_ENVELOPE_BYTES }));
  const staleAuthority = [
    !sameRepositoryOrigin(root, packet.forge.prUrl) && "repository",
    pr.state !== "OPEN" && "pull-request-state",
    pr.number !== packet.forge.prNumber && "pull-request-number",
    pr.url !== packet.forge.prUrl && "pull-request-url",
    pr.baseRefName !== "main" && "base-name",
    pr.baseRefOid !== packet.forge.reviewBase && "review-base",
    pr.headRefOid !== sourceHead && "forge-head",
    upstream !== sourceHead && "upstream-head",
    branch !== packet.source.currentBranch && "branch",
    git(root, ["rev-parse", branch]) !== sourceHead && "local-head",
    remoteMain.ref !== "refs/heads/main" && "main-ref",
    remoteMain.object?.type !== "commit" && "main-object-type",
    remoteMain.object?.sha !== acceptedHead && "forge-main-head",
    git(root, ["rev-parse", "refs/remotes/origin/main"]) !== acceptedHead && "local-main-head",
  ].filter(Boolean);
  if (staleAuthority.length) throw new Error(`governed PR head or accepted main moved since packet creation (${staleAuthority.join(",")})`);
  const review = packet.forge.comment;
  const latest = [...(pr.comments ?? [])].reverse().find((comment: { body?: unknown }) => typeof comment.body === "string" && comment.body.includes("<!-- rhiz-review-agent -->"));
  if (!latest || (latest.url ?? latest.html_url) !== review.commentUrl) throw new Error("governed review is no longer the latest canonical review");
  const comment = JSON.parse(execFileSync("gh", ["api", "--hostname", new URL(packet.forge.prUrl).hostname, `repos/${new URL(packet.forge.prUrl).pathname.split("/").filter(Boolean).slice(0, 2).join("/")}/issues/comments/${review.commentId}`], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: MAX_ENVELOPE_BYTES }));
  const body = comment.body;
  const heading = typeof body === "string" ? canonicalGovernedReviewHeading(body, sourceHead) : undefined;
  const verdict = heading?.verdict;
  if (String(comment.id) !== String(review.commentId) || comment.html_url !== review.commentUrl || hash(body ?? "") !== review.commentDigest || comment.user?.login !== review.reviewerLogin || !["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association) || !heading || !verdict || verdict !== review.verdict) throw new Error("governed review identity changed since packet creation");
  const createdAt = Date.parse(comment.created_at);
  if (!Number.isFinite(createdAt) || createdAt > Date.now() || Date.now() - createdAt >= 4 * 60 * 60 * 1000 || comment.created_at !== review.createdAt) throw new Error("governed review is stale or changed");
  const sourceEntry = treeBlob(root, sourceHead, FIXED_HOOK);
  const acceptedEntry = treeBlob(root, acceptedHead, FIXED_HOOK);
  const recorded = packet.executionPolicy as Record<string, unknown>;
  if (recorded.workId !== value.workId || recorded.purpose !== "horizon-governed-detached-workspace" || recorded.path !== FIXED_HOOK) throw new Error("governed policy descriptor does not bind this exact Work");
  let policyMode: "overlay" | "no-overlay";
  let source: HookIdentity | null = null;
  let accepted: HookIdentity | null = null;
  let acceptedBytes: Buffer | null = null;
  if (sourceEntry === null && acceptedEntry === null) {
    if (recorded.mode !== "no-overlay") throw new Error("hook-free source and accepted main require the derived no-overlay policy descriptor");
    policyMode = "no-overlay";
  } else {
    if (sourceEntry === null || acceptedEntry === null || recorded.mode !== "overlay") throw new Error("governed overlay requires matching valid hooks at both source and accepted main");
    const sourceHook = verifyHook(root, sourceHead);
    const acceptedHook = verifyHook(root, acceptedHead);
    const recordedSource = recorded.source as Record<string, unknown>;
    const recordedAccepted = recorded.accepted as Record<string, unknown>;
    if (stable(Object.keys(recorded).sort()) !== stable(["mode", "workId", "purpose", "path", "source", "accepted"].sort()) || stable(Object.keys(recordedSource ?? {}).sort()) !== stable(["mode", "blob", "sha256"].sort()) || stable(Object.keys(recordedAccepted ?? {}).sort()) !== stable(["mode", "blob", "sha256"].sort()) || recordedSource?.mode !== sourceHook.mode || recordedSource?.blob !== sourceHook.blob || recordedSource?.sha256 !== sourceHook.sha256 || recordedAccepted?.mode !== acceptedHook.mode || recordedAccepted?.blob !== acceptedHook.blob || recordedAccepted?.sha256 !== acceptedHook.sha256) throw new Error("governed hook identities differ from retained packet");
    policyMode = "overlay";
    source = sourceHook;
    accepted = acceptedHook;
    acceptedBytes = acceptedHook.bytes;
  }
  if (contract.writeScope.some((item) => item.uri === `repo://source/${FIXED_HOOK}`)) throw new Error("governed policy path intersects Work write scope");

  const expectedManifest = {
    schema: "rhiz/convergence-artifact/v1",
    workId: value.workId,
    sourceHead,
    integrationHead: acceptedHead,
    sourceDigest: packet.source.digest,
    packetBlob: manifest.packetBlob,
    packetDigest: hash(stable(packet)),
    scope: packet.request.paths,
    projectedTree: packet.projected.tree,
    executionPolicy: packet.executionPolicy,
    inputCheckpoint: manifest.inputCheckpoint,
  };
  if (stable(expectedManifest) !== stable(manifest)) throw new Error("governed manifest differs from reconstructed packet and accepted policy");
  const manifestBytes = Buffer.from(stable(manifest));
  const common = {
    [brand]: true as const,
    workId: value.workId,
    sourceHead,
    acceptedHead,
    path: FIXED_HOOK,
    packetDigest: manifest.packetDigest as string,
    manifestDigest: value.manifestDigest,
    inputCheckpoint: { ref: inputRef, head: localInputHead, blob: checkpointBlob, digest: value.inputCheckpointDigest },
    manifestBytes,
    envelopeBytes: Buffer.from(stable(value)),
  };
  if (policyMode === "no-overlay") return Object.freeze({ ...common, mode: policyMode, source: null, accepted: null, acceptedBytes: null });
  if (!source || !accepted || !acceptedBytes) throw new Error("governed overlay identities were not reconstructed");
  return Object.freeze({ ...common, mode: policyMode, source, accepted, acceptedBytes });
}

export function isValidatedGovernedConvergencePolicy(value: unknown): value is ValidatedGovernedConvergencePolicy {
  return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[brand] === true;
}
