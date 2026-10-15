import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertGovernedExecutionRootIdentity, canonicalGovernedReviewHeading, governedConvergenceObjective, harnessGitRefSegment, validateGovernedConvergencePolicy } from "../adapters/git/index.js";
import { GitWorktreeWorkspaceProvider } from "../adapters/git/worktrees.js";
import { parseWorkContract } from "../src/schemas.js";

const stable = (value: unknown) => JSON.stringify(value);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...(input === undefined ? {} : { input }) }).trim();
}

function fixedContract(workId: string, paths: string[], packetBlob: string) {
  const artifactPath = `tools/horizon-convergence-artifacts/${workId.slice(-40)}/artifact.json`;
  const contextPath = `.context/horizon-convergence/${workId.slice(-40)}.json`;
  const resources = paths.map((path) => ({ uri: `repo://source/${path}`, kind: "file" }));
  const artifact = { uri: `repo://source/${artifactPath}`, kind: "file" };
  return parseWorkContract({
    id: workId,
    type: "SHIP",
    createdBy: { id: "human:harness-test@localhost.invalid", kind: "human" },
    createdAt: "2026-10-15T00:00:00.000Z",
    objective: governedConvergenceObjective(artifactPath, packetBlob),
    scope: [{ uri: "repo://source", kind: "repository" }],
    writeScope: [artifact, ...resources],
    nonGoals: ["No source writes in this attempt", "No application effects or accepted Outcome", "No new feature scope, clock reset, authority widening, or fabricated proof"],
    authority: { grants: [
      { action: "read", resources: [{ uri: "repo://source", kind: "repository" }], constraints: [] },
      { action: "write", resources: [artifact, ...resources], constraints: [] },
    ], requiresHumanApproval: ["publish", "external-mutate", "spend"] },
    acceptanceCriteria: [{ id: "criterion:exact-convergence-artifact", description: "Artifact exactly retains the captured source snapshot, explicit source scope and proposed patch; no other candidate file changes.", required: true }],
    requiredEvidence: [{ id: "evidence:convergence-check", description: "Actual exact-artifact check with an altered-artifact negative control", acceptedKinds: ["test"], required: true }],
    context: { strategy: "explicit", resources: [{ uri: `repo://source/${contextPath}`, kind: "file" }], tokenBudget: 32768, includeHistory: false },
    dependencies: [],
    workerPolicy: { maxAttempts: 1, attemptBudgetMs: 180000, allowParallelAttempts: false, preferredProviders: ["worker:codex-app-server"] },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] },
  });
}

test("governed worker and verifier execution identities must match", () => {
  assert.doesNotThrow(() => assertGovernedExecutionRootIdentity("sha256:one", "sha256:one"));
  assert.throws(() => assertGovernedExecutionRootIdentity("sha256:worker", "sha256:verifier"), /same governed execution-root digest/);
  assert.throws(() => assertGovernedExecutionRootIdentity(undefined, "sha256:verifier"), /same governed execution-root digest/);
});

test("governed convergence objective separates artifact production from independent review", () => {
  const objective = governedConvergenceObjective("tools/horizon-convergence-artifacts/work/artifact.json", "a".repeat(40));
  assert.match(objective, /^Artifact producer only: Copy the complete JSON manifest/);
  assert.match(objective, /Do not run shell commands, inspect the referenced packet\/source blobs, perform review/);
  assert.match(objective, /Independent review only: After the producer has completed its packaging and Verify has passed/);
  assert.match(objective, /judge preservation of both source legs and repair-only scope/);
});

test("validated convergence policy overlays only runtime bytes and preserves source candidate identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-policy-fixture-"));
  const repository = join(root, "repo");
  const remote = join(root, "origin.git");
  const bin = join(root, "bin");
  const fakeGhData = join(root, "gh-data");
  mkdirSync(repository); mkdirSync(bin); mkdirSync(fakeGhData);
  git(root, ["init", "--bare", remote]);
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Harness Test"]);
  git(repository, ["config", "user.email", "harness-test@localhost.invalid"]);
  const remoteUrl = "https://github.com/werhiz/rhizprotocol.git";
  git(repository, ["remote", "add", "origin", remoteUrl]);
  git(repository, ["config", `url.file://${remote}.insteadOf`, remoteUrl]);
  mkdirSync(join(repository, ".claude/hooks"), { recursive: true });
  writeFileSync(join(repository, ".claude/hooks/horizon-check.sh"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
  writeFileSync(join(repository, "CHANGELOG.md"), "base\n");
  git(repository, ["add", "."]); git(repository, ["commit", "-m", "base"]);
  git(repository, ["switch", "-c", "codex/policy-test"]);
  writeFileSync(join(repository, "CHANGELOG.md"), "source change\n");
  git(repository, ["commit", "-am", "source candidate"]);
  const sourceHead = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["push", "-u", "origin", "codex/policy-test"]);
  git(repository, ["switch", "main"]);
  const acceptedBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  writeFileSync(join(repository, ".claude/hooks/horizon-check.sh"), acceptedBytes, { mode: 0o755 });
  writeFileSync(join(repository, "CHANGELOG.md"), "accepted main change\n");
  git(repository, ["add", ".claude/hooks/horizon-check.sh", "CHANGELOG.md"]); git(repository, ["commit", "-m", "accepted governed hook"]);
  const acceptedHead = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["push", "origin", "main"]); git(repository, ["fetch", "origin"]);
  git(repository, ["switch", "codex/policy-test"]);
  git(repository, ["branch", "--set-upstream-to", "origin/codex/policy-test"]);
  try { git(repository, ["merge", "--no-commit", "origin/main"]); } catch { /* fixture intentionally leaves a real merge conflict */ }
  const sourceBlob = git(repository, ["rev-parse", `${sourceHead}:.claude/hooks/horizon-check.sh`]);
  const acceptedBlob = git(repository, ["rev-parse", `${acceptedHead}:.claude/hooks/horizon-check.sh`]);
  const prUrl = "https://github.com/werhiz/rhizprotocol/pull/4183";
  const reviewUrl = `${prUrl}#issuecomment-9001`;
  const createdAt = new Date().toISOString();
  const body = `## READY at ${sourceHead}\n<!-- rhiz-review-agent -->\nIndependent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${sourceHead}\`.`;
  const review = { commentId: 9001, commentUrl: reviewUrl, commentDigest: sha(body), reviewerLogin: "reviewer", createdAt, verdict: "READY" };
  writeFileSync(join(fakeGhData, "pr.json"), JSON.stringify({ number: 4183, url: prUrl, state: "OPEN", headRefOid: sourceHead, baseRefName: "main", baseRefOid: acceptedHead, comments: [{ id: "PRRC_kwDOExample", url: reviewUrl, body }] }));
  writeFileSync(join(fakeGhData, "main.json"), JSON.stringify({ ref: "refs/heads/main", object: { sha: acceptedHead, type: "commit" } }));
  writeFileSync(join(fakeGhData, "comment.json"), JSON.stringify({ id: 9001, html_url: reviewUrl, body, user: { login: "reviewer" }, author_association: "OWNER", created_at: createdAt }));
  const ghPath = join(bin, "gh");
  writeFileSync(ghPath, "#!/bin/sh\ncase \"$*\" in *git/ref/heads/main) cat \"$GH_FIXTURE_DIR/main.json\";; *issues/comments/*) cat \"$GH_FIXTURE_DIR/comment.json\";; *) cat \"$GH_FIXTURE_DIR/pr.json\";; esac\n", { mode: 0o755 });
  chmodSync(ghPath, 0o755);
  const paths = ["CHANGELOG.md"];
  const workId = `work:horizon-convergence-${sha(stable([prUrl, sourceHead, review.commentId, "resolve-integration"])).slice(0, 40)}`;
  const policy = {
    mode: "overlay",
    workId,
    purpose: "horizon-governed-detached-workspace",
    path: ".claude/hooks/horizon-check.sh",
    source: { mode: "100755", blob: sourceBlob, sha256: sha("#!/bin/sh\nexit 2\n") },
    accepted: { mode: "100755", blob: acceptedBlob, sha256: sha(acceptedBytes) },
  };
  const statusBytes = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repository });
  const indexBytes = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: repository });
  const unmergedBytes = execFileSync("git", ["ls-files", "--unmerged", "-z"], { cwd: repository });
  const dirtyPaths = [...new Set(statusBytes.toString("utf8").split("\0").filter(Boolean).map((row) => row.slice(3)))].sort();
  const sourceFiles = dirtyPaths.map((path) => [path, { digest: sha(execFileSync("cat", [join(repository, path)])), mode: path.endsWith(".sh") ? 0o755 : 0o644 }]);
  const sourceStateBase = { head: sourceHead, currentBranch: "codex/policy-test", mergeHead: acceptedHead, statusDigest: sha(statusBytes), indexDigest: sha(indexBytes), unmergedDigest: sha(unmergedBytes), files: sourceFiles };
  const sourceState = { ...sourceStateBase, digest: sha(stable(sourceStateBase)), unmergedPaths: ["CHANGELOG.md"] };
  const mergeStages = unmergedBytes.toString("utf8").split("\0").filter(Boolean).map((row) => {
    const [metadata, path] = row.split("\t");
    const [mode, blob, stage] = (metadata ?? "").split(" ");
    return { path, mode, blob, stage: Number(stage) };
  });
  const packet = {
    schema: "rhiz/convergence-artifact/v1",
    request: { schema: "rhiz/convergence-request/v1", purpose: "resolve-integration", paths, patch: "diff --git a/CHANGELOG.md b/CHANGELOG.md\n--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n", reviewCommentUrl: reviewUrl },
    source: sourceState,
    forge: { head: sourceHead, integration: acceptedHead, reviewBase: acceptedHead, prNumber: 4183, prUrl, comment: review },
    originals: [],
    projected: { tree: git(repository, ["rev-parse", `${acceptedHead}^{tree}`]) },
    mergeStages,
    executionPolicy: policy,
  };
  const packetBytes = Buffer.from(stable(packet));
  const packetBlob = git(repository, ["hash-object", "-w", "--stdin"], packetBytes.toString("utf8"));
  const checkpointTree = git(repository, ["mktree"], `100644 blob ${packetBlob}\tartifact.json\n`);
  const projectedHead = git(repository, ["commit-tree", packet.projected.tree, "-p", sourceHead, "-p", acceptedHead], "projected\n");
  const checkpointHead = git(repository, ["commit-tree", checkpointTree, "-p", projectedHead], "checkpoint\n");
  const checkpointRef = `refs/rhiz/work/${harnessGitRefSegment(workId)}/convergence-input`;
  git(repository, ["update-ref", checkpointRef, checkpointHead]);
  git(repository, ["push", "origin", `${checkpointHead}:${checkpointRef}`]);
  const artifactPath = `tools/horizon-convergence-artifacts/${workId.slice(-40)}/artifact.json`;
  const inputCheckpoint = { ref: checkpointRef, head: checkpointHead, blob: packetBlob, digest: sha(packetBytes) };
  const manifest = { schema: "rhiz/convergence-artifact/v1", workId, sourceHead, integrationHead: acceptedHead, sourceDigest: packet.source.digest, packetBlob, packetDigest: sha(packetBytes), scope: paths, projectedTree: packet.projected.tree, executionPolicy: policy, inputCheckpoint };
  const manifestDigest = sha(stable(manifest));
  const envelope = { schema: "rhiz/governed-convergence-policy-envelope/v1", workId, manifest, manifestDigest, inputCheckpointDigest: sha(packetBytes) };
  const envelopePath = join(root, "envelope.json"); writeFileSync(envelopePath, stable(envelope), { mode: 0o600 });
  const work = fixedContract(workId, paths, packetBlob);
  const previousPath = process.env.PATH;
  const previousFixtureDir = process.env.GH_FIXTURE_DIR;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.GH_FIXTURE_DIR = fakeGhData;
  const runRoot = mkdtempSync(join(tmpdir(), "rhiz-repository-work-"));
  let provider: GitWorktreeWorkspaceProvider | undefined;
  try {
    const hostileEnvelopePath = join(root, "hostile-envelope.json");
    writeFileSync(hostileEnvelopePath, stable({ ...envelope, acceptedHead, path: ".claude/hooks/horizon-check.sh" }));
    assert.throws(() => validateGovernedConvergencePolicy({ repositoryRoot: repository, baseRevision: sourceHead, contract: work, envelopeFilename: hostileEnvelopePath }), /Unrecognized key/);
    const symlinkEnvelopePath = join(root, "symlink-envelope.json");
    symlinkSync(envelopePath, symlinkEnvelopePath);
    assert.throws(() => validateGovernedConvergencePolicy({ repositoryRoot: repository, baseRevision: sourceHead, contract: work, envelopeFilename: symlinkEnvelopePath }), /ELOOP|symbolic link|regular file/);
    const canonicalBody = `## NOT READY at ${sourceHead.slice(0, 10)}\n<!-- rhiz-review-agent -->\nIndependent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${sourceHead}\`.`;
    assert.deepEqual(canonicalGovernedReviewHeading(canonicalBody, sourceHead), { verdict: "NOT READY", namedHead: sourceHead.slice(0, 10) });
    assert.equal(canonicalGovernedReviewHeading(canonicalBody.replace(sourceHead.slice(0, 10), "0".repeat(10)), sourceHead), undefined);
    assert.equal(canonicalGovernedReviewHeading(canonicalBody.replace(`head \`${sourceHead}\``, `head \`${"0".repeat(40)}\``), sourceHead), undefined);
    assert.throws(() => validateGovernedConvergencePolicy({ repositoryRoot: repository, baseRevision: sourceHead, contract: { ...work, id: "work:other" }, envelopeFilename: envelopePath }), /Work\/source identity mismatch/);
    const validated = validateGovernedConvergencePolicy({ repositoryRoot: repository, baseRevision: sourceHead, contract: work, envelopeFilename: envelopePath });
    assert.equal(validated.acceptedHead, acceptedHead);
    assert.equal(validated.mode, "overlay");
    if (validated.mode === "overlay") assert.equal(validated.source.blob, sourceBlob);
    provider = new GitWorktreeWorkspaceProvider({ repositoryRoot: repository, worktreeRoot: join(runRoot, "worktrees"), idFactory: () => "fixed-id", governedConvergencePolicy: validated });
    const workspace = await provider.acquire({ crewId: `crew:${workId}`, work, baseRevision: sourceHead, mode: "isolated-write" });
    await assert.rejects(provider.acquire({ crewId: `crew:${workId}`, work: { ...work, id: "work:dependent", dependencies: [workId] }, baseRevision: sourceHead, mode: "isolated-write", sourceWorkspace: workspace, sourceWorkId: workId }), /cannot inherit another workspace/);
    const hookPath = join(workspace.executionRoot, validated.path);
    assert.equal(git(workspace.executionRoot, ["rev-parse", "HEAD"]), sourceHead);
    assert.equal(sha(readFileSyncBytes(hookPath)), policy.accepted.sha256);
    assert.equal(execFileSync("sh", [hookPath], { cwd: workspace.executionRoot, stdio: "pipe" }).toString(), "");
    assert.deepEqual((await provider.snapshot(workspace)).changedPaths, []);
    mkdirSync(join(workspace.executionRoot, artifactPath.slice(0, artifactPath.lastIndexOf("/")),), { recursive: true });
    writeFileSync(join(workspace.executionRoot, artifactPath), "{}\n");
    const changed = await provider.snapshot(workspace);
    assert.deepEqual(changed.changedPaths, [artifactPath]);
    const hooksDirectory = join(workspace.executionRoot, ".claude/hooks");
    const savedHooksDirectory = join(workspace.executionRoot, ".claude/hooks.saved");
    renameSync(hooksDirectory, savedHooksDirectory);
    symlinkSync(savedHooksDirectory, hooksDirectory);
    await assert.rejects(provider.snapshot(workspace), /ancestors must be owned nonsymlink directories/);
    rmSync(hooksDirectory);
    renameSync(savedHooksDirectory, hooksDirectory);
    git(workspace.executionRoot, ["add", artifactPath]);
    git(workspace.executionRoot, ["-c", "user.name=Harness Test", "-c", "user.email=harness-test@localhost.invalid", "commit", "-m", "fixture candidate"]);
    const candidate = git(workspace.executionRoot, ["rev-parse", "HEAD"]);
    const candidateSnapshot = await provider.snapshot(workspace);
    assert.equal(candidateSnapshot.head, candidate);
    assert.deepEqual(candidateSnapshot.changedPaths, [artifactPath]);
    assert.equal(git(repository, ["rev-parse", `${candidate}:.claude/hooks/horizon-check.sh`]), sourceBlob);
    assert.deepEqual(git(repository, ["diff", "--name-only", `${sourceHead}..${candidate}`]).split("\n"), [artifactPath]);
    writeFileSync(join(workspace.executionRoot, "unexpected.txt"), "outside the exact checkpoint\n");
    git(workspace.executionRoot, ["add", "unexpected.txt"]);
    git(workspace.executionRoot, ["-c", "user.name=Harness Test", "-c", "user.email=harness-test@localhost.invalid", "commit", "-m", "unexpected follow-on"]);
    await assert.rejects(provider.snapshot(workspace), /exact one-artifact checkpoint lineage/);
    git(workspace.executionRoot, ["reset", "--hard", candidate]);
    writeFileSync(hookPath, acceptedBytes, { mode: 0o755 });
    git(workspace.executionRoot, ["add", validated.path]);
    await assert.rejects(provider.snapshot(workspace), /source hook HEAD or index identity changed/);
    git(workspace.executionRoot, ["reset", "HEAD", "--", validated.path]);
    writeFileSync(hookPath, "#!/bin/sh\nexit 5\n", { mode: 0o755 });
    await assert.rejects(provider.snapshot(workspace), /runtime policy bytes or mode changed/);
    await provider.release(workspace.workspaceId);
    git(repository, ["update-ref", "refs/remotes/origin/main", sourceHead]);
    assert.throws(() => validateGovernedConvergencePolicy({ repositoryRoot: repository, baseRevision: sourceHead, contract: work, envelopeFilename: envelopePath }), /accepted main moved/);
  } finally {
    await provider?.close().catch(() => undefined);
    rmSync(runRoot, { recursive: true, force: true });
    process.env.PATH = previousPath;
    if (previousFixtureDir === undefined) delete process.env.GH_FIXTURE_DIR; else process.env.GH_FIXTURE_DIR = previousFixtureDir;
    rmSync(root, { recursive: true, force: true });
  }
});

function readFileSyncBytes(path: string): Buffer {
  return execFileSync("cat", [path]);
}
