import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { realpathSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import { requireProven, runDisposableProof, TempDirectoryDerivativeFactory, type DisposableDerivative } from "../src/disposable.js";
import { DEFAULT_EXECUTION_ROOT_LIMITS, DigestScopeSchema, digestExecutionRoot as digestBareExecutionRoot, WorkspaceDigestLimitError } from "../src/workspace-digest.js";
import { nativeReviewCandidate } from "./fixtures/native-review.js";
import { resolveNativeArtifactAllowances } from "../adapters/codex/native-artifact-identity.js";
import type { ExecutionRootDigestLimits } from "../src/workspace-digest.js";
import { GitWorktreeWorkspaceProvider } from "../adapters/git/worktrees.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import { VerificationEngine, VerifierCatalog, type VerifierProvider } from "../src/verify.js";
import { successfulExecution, work } from "./helpers.js";

const ordinary = 256 * 1024 * 1024, allowance = 512 * 1024 * 1024;
const paths = {
  arm64: "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
  x64: "node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex",
};
const declarations = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const locked = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
const fixturePath = "test/fixtures/native-tools", owner = "@werhiz/native-review-test-tools";
const tools = JSON.parse(await readFile(new URL("../../test/fixtures/native-tools/package.json", import.meta.url), "utf8"));

async function digestExecutionRoot(root: string, options: { limits?: Partial<ExecutionRootDigestLimits> } = {}) {
  return digestBareExecutionRoot(root, { ...options, fileSizeAllowances: await resolveNativeArtifactAllowances(root) });
}

async function fixture(proof: (derivative: DisposableDerivative) => Promise<void>): Promise<void> {
  const candidate = await nativeReviewCandidate({ "marker.txt": "large sparse native artifact proof\n" });
  try {
    requireProven(await runDisposableProof({
      candidateRoot: candidate, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(), proof,
    }));
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

async function sparse(derivative: Pick<DisposableDerivative, "resolve">, path: string, size: number): Promise<void> {
  await mkdir(dirname(derivative.resolve(path)), { recursive: true });
  const handle = await open(derivative.resolve(path), "w");
  try { await handle.truncate(size); } finally { await handle.close(); }
}

async function seed(derivative: Pick<DisposableDerivative, "root" | "resolve" | "mutate">, arch: keyof typeof paths, size: number): Promise<void> {
  await derivative.mutate("package.json", JSON.stringify({ devDependencies: declarations.devDependencies }), "seed exact native artifact declarations");
  await derivative.mutate("package-lock.json", JSON.stringify({ packages: locked.packages }), "seed exact pinned lock metadata");
  await mkdir(derivative.resolve(fixturePath), { recursive: true });
  await derivative.mutate(`${fixturePath}/package.json`, JSON.stringify(tools), "seed dev-only native artifact owner");
  const alias = `node_modules/@openai/codex-darwin-${arch}`, metadata = locked.packages[alias];
  await mkdir(derivative.resolve(alias), { recursive: true });
  await derivative.mutate(`${alias}/package.json`, JSON.stringify({ name: metadata.name, version: metadata.version, os: metadata.os, cpu: metadata.cpu }), "seed exact platform package metadata");
  await sparse(derivative, paths[arch], size);
}

test("native test dependency placement declares only exact Darwin artifacts", () => {
  assert.equal(declarations.devDependencies["@openai/codex"], undefined);
  assert.equal(declarations.optionalDependencies, undefined);
  assert.equal(declarations.devDependencies[owner], `file:${fixturePath}`);
  assert.deepEqual(Object.keys(tools.optionalDependencies).sort(), ["@openai/codex-darwin-arm64", "@openai/codex-darwin-x64"]);
  for (const arch of ["arm64", "x64"] as const) {
    const alias = `@openai/codex-darwin-${arch}`;
    assert.equal(tools.optionalDependencies[alias], `npm:@openai/codex@0.162.1-darwin-${arch}`);
    assert.equal(locked.packages[`node_modules/${alias}`].dev, true);
    assert.deepEqual(locked.packages[`node_modules/${alias}`].os, ["darwin"]);
    assert.deepEqual(locked.packages[`node_modules/${alias}`].cpu, [arch]);
  }
  assert(!Object.keys(locked.packages).some((path) => /codex-(linux|win32)|@openai\/codex$/.test(path)));
});

test("concrete native recognition never reads through external artifact or fixture parent links", { skip: process.platform === "win32" }, async () => {
  await fixture(async (derivative) => {
    const selected = {
      root: derivative.resolve("selected"),
      resolve: (path: string) => derivative.resolve(`selected/${path}`),
      mutate: (path: string, content: string, reason: string) => derivative.mutate(`selected/${path}`, content, reason),
    };
    await mkdir(selected.root);
    await seed(selected, "arm64", ordinary + 1);
    const original = fs.createReadStream;
    let foreignReads = 0;
    const root = realpathSync(selected.root);
    fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
      const actual = realpathSync(args[0]);
      if (actual !== root && !actual.startsWith(root + "/")) foreignReads += 1;
      return original(...args);
    }) as typeof fs.createReadStream;
    syncBuiltinESMExports();
    try {
      for (const [path, foreign] of [["node_modules/@openai", "foreign-artifacts"], ["test/fixtures/native-tools", "foreign-fixture"]] as const) {
        const source = selected.resolve(path), outside = derivative.resolve(foreign);
        await rename(source, outside);
        await symlink(outside, source, "dir");
        assert.deepEqual(await resolveNativeArtifactAllowances(selected.root), []);
        assert.equal(foreignReads, 0, "recognition must reject linked parents before any foreign content stream");
        await rm(source);
        await rename(outside, source);
      }
    } finally { fs.createReadStream = original; syncBuiltinESMExports(); }
  });
});

test("generic allowance descriptors reject invalid paths, duplicates and an unbounded ceiling", async () => {
  await fixture(async (derivative) => {
    const policy = { policy: "fixture", path: "artifact", maxFileBytes: allowance, evidenceDigest: `sha256:${"1".repeat(64)}` };
    for (const path of ["../artifact", "/artifact", "a\\b", "a//b", "a/./b"]) {
      await assert.rejects(digestBareExecutionRoot(derivative.root, { fileSizeAllowances: [{ ...policy, path }] }));
    }
    await assert.rejects(digestBareExecutionRoot(derivative.root, { fileSizeAllowances: [policy, policy] }), /duplicate/);
    await assert.rejects(digestBareExecutionRoot(derivative.root, { fileSizeAllowances: [{ ...policy, maxFileBytes: allowance + 1 }] }));
  });
});

test("exact oversized artifact is fully streamed, scope-bound and identical in the disposable copy", async () => {
  await fixture(async (derivative) => {
    const size = ordinary + 1;
    await seed(derivative, "arm64", size);
    await assert.rejects(digestBareExecutionRoot(derivative.root), WorkspaceDigestLimitError, "portable default has no provider-specific inference");
    const identity = await digestExecutionRoot(derivative.root);
    const hash = createHash("sha256"), zero = Buffer.alloc(1024 * 1024);
    for (let bytes = 0; bytes < ordinary; bytes += zero.length) hash.update(zero);
    hash.update(Buffer.alloc(1));
    assert.equal(identity.manifest.get(paths.arm64), `file:sha256:${hash.digest("hex")}`);
    assert(identity.scope.totalBytes >= size);
    assert.deepEqual(identity.scope.exclusions, [".git"]);
    assert.equal(identity.scope.fileSizeAllowances?.[0]?.path, paths.arm64);
    assert.equal(identity.scope.fileSizeAllowances?.[0]?.maxFileBytes, allowance);
    assert.equal(identity.scope.fileSizeAllowances?.[0]?.policy, "codex-0.162.1-darwin-native");
    const changedEvidence = await digestBareExecutionRoot(derivative.root, { fileSizeAllowances: [{ ...identity.scope.fileSizeAllowances![0]!, evidenceDigest: `sha256:${"f".repeat(64)}` }] });
    assert.deepEqual(changedEvidence.manifest, identity.manifest);
    assert.notEqual(changedEvidence.digest, identity.digest, "policy evidence enters aggregate identity even with identical file bytes");
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q"], { cwd: derivative.root });
    const pinned = await new GitCandidateIdentityProbe().pin(derivative.root);
    const factory = new TempDirectoryDerivativeFactory();
    const copied = await factory.create(pinned);
    try {
      const again = await digestExecutionRoot(copied.root);
      assert.equal(again.digest, identity.digest);
      assert.deepEqual(again.scope, identity.scope);
    } finally { await factory.destroy(copied); }
    await assert.rejects(new TempDirectoryDerivativeFactory({ digestLimits: { maxFileBytes: ordinary } }).create(pinned), WorkspaceDigestLimitError,
      "a tighter factory budget also wins over pinned policy");
    const handle = await open(derivative.resolve(paths.arm64), "r+");
    try { await handle.write(Buffer.from([1]), 0, 1, size - 1); } finally { await handle.close(); }
    assert.notEqual((await digestExecutionRoot(derivative.root)).digest, identity.digest, "the byte beyond the old cap is part of identity");
  });
});

test("Git workspace acquire and snapshot carry native identity through real Verify negative controls", async () => {
  await fixture(async (derivative) => {
    await seed(derivative, "arm64", ordinary + 1);
    await derivative.mutate(".gitignore", "node_modules/\n.worktrees/\n", "ignore only installed dependencies and local worktrees in fixture Git");
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: derivative.root });
    git(["init", "-q"]); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    const platformMetadata = await readFile(derivative.resolve("node_modules/@openai/codex-darwin-arm64/package.json"));
    const provider = new GitWorktreeWorkspaceProvider({
      repositoryRoot: derivative.root, worktreeRoot: derivative.resolve(".worktrees"), idFactory: () => "1",
      prepareWorkspace: async (root) => {
        const binary = join(root, paths.arm64);
        await mkdir(dirname(binary), { recursive: true });
        await writeFile(join(root, "node_modules/@openai/codex-darwin-arm64/package.json"), platformMetadata);
        const handle = await open(binary, "w");
        try { await handle.truncate(ordinary + 1); } finally { await handle.close(); }
      },
    });
    const contract = work({ requiredEvidence: [] });
    try {
      const workspace = await provider.acquire({ crewId: "crew:1", work: contract, baseRevision: "HEAD", mode: "isolated-write" });
      const snapshot = await provider.snapshot(workspace);
      assert.equal(snapshot.digestScope.fileSizeAllowances?.[0]?.path, paths.arm64);
      assert.equal((await new GitCandidateIdentityProbe().pin(workspace.executionRoot)).digest, snapshot.digest);
      const ledger = new InMemoryEventLedger();
      for (const event of successfulExecution(contract)) await ledger.append(event);
      let controlSeen = false;
      const verifier: VerifierProvider = {
        id: "verifier:native-policy",
        async describe() { return { id: this.id, displayName: "Sparse identity fixture", description: "Reads a marker and hashes exact native execution bytes", deterministic: true, readOnly: true, evidenceKinds: ["test"] }; },
        async verify(request) {
          const actual = await digestExecutionRoot(request.workspace.executionRoot);
          assert.equal(actual.digest, request.target.digest);
          assert.equal(actual.scope.fileSizeAllowances?.[0]?.path, paths.arm64);
          const broken = (await readFile(join(request.workspace.executionRoot, "marker.txt"), "utf8")) === "broken";
          if (broken) { controlSeen = true; assert.notEqual(request.workspace.executionRoot, workspace.executionRoot); }
          return { checkId: request.check.id, providerId: this.id, status: broken ? "fail" : "pass", summary: "marker checked", evidence: [{ id: `evidence:${request.check.id}`, kind: "test", digest: `sha256:${"1".repeat(64)}` }], startedAt: "2026-08-20T04:00:02.000Z", finishedAt: "2026-08-20T04:00:03.000Z" };
        },
        async close() {},
      };
      const receipt = await new VerificationEngine({ ledger, workspaceProvider: provider, verifierCatalog: new VerifierCatalog(verifier), verifier: { id: "verifier:independent", kind: "verifier" } }).verify({
        streamId: "stream:work:1", work: contract, contractRevision: 1, workspace, expectedSnapshot: snapshot,
        plan: { id: "plan:native", workId: contract.id, contractRevision: 1, checks: [
          { id: "primary", providerId: verifier.id, description: "marker remains valid", criterionIds: ["criterion:tests"], requirementIds: [], config: {} },
          { id: "control", providerId: verifier.id, description: "broken marker is detected", criterionIds: [], requirementIds: [], negativeControlFor: "primary", perturbation: { description: "break marker", kind: "overwrite-file", path: "marker.txt", content: "broken" }, config: {} },
        ] },
      });
      assert.equal(receipt.status, "pass");
      assert(controlSeen);
      assert.notEqual(await readFile(join(workspace.executionRoot, "marker.txt"), "utf8"), "broken");
    } finally { await provider.close(); }
  });
});

test("native size allowance preserves explicit caller and aggregate budgets and has a hard ceiling", async () => {
  await fixture(async (derivative) => {
    await seed(derivative, "x64", ordinary + 1);
    await assert.rejects(digestExecutionRoot(derivative.root, { limits: { maxFileBytes: ordinary } }), WorkspaceDigestLimitError);
    await assert.rejects(digestExecutionRoot(derivative.root, { limits: { maxTotalBytes: ordinary } }), /byte digest limit/);
    await sparse(derivative, paths.x64, allowance);
    assert.equal((await digestExecutionRoot(derivative.root)).scope.fileSizeAllowances?.[0]?.maxFileBytes, allowance);
    await sparse(derivative, paths.x64, allowance + 1);
    await assert.rejects(digestExecutionRoot(derivative.root), /536870912 byte per-file digest limit/);
    assert.deepEqual(DEFAULT_EXECUTION_ROOT_LIMITS, { maxFiles: 200_000, maxFileBytes: ordinary, maxTotalBytes: 4 * 1024 * 1024 * 1024 });
  });
});

test("native allowance refuses lookalike paths, package drift and substituted metadata", async () => {
  await fixture(async (derivative) => {
    await seed(derivative, "arm64", ordinary + 1);
    const alias = "node_modules/@openai/codex-darwin-arm64/package.json";
    const originalMetadata = await readFile(derivative.resolve(alias), "utf8");
    for (const metadata of [
      { name: "other", version: "0.162.1-darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
      { name: "@openai/codex", version: "wrong", os: ["darwin"], cpu: ["arm64"] },
      { name: "@openai/codex", version: "0.162.1-darwin-arm64", os: ["linux"], cpu: ["arm64"] },
    ]) {
      await derivative.mutate(alias, JSON.stringify(metadata), "plant incompatible platform metadata");
      await assert.rejects(digestExecutionRoot(derivative.root), WorkspaceDigestLimitError);
    }
    await derivative.mutate(alias, originalMetadata, "restore exact platform metadata");
    const originalLock = await readFile(derivative.resolve("package-lock.json"), "utf8");
    const wrongLock = JSON.parse(originalLock);
    wrongLock.packages["node_modules/@openai/codex-darwin-arm64"].integrity = "wrong";
    await derivative.mutate("package-lock.json", JSON.stringify(wrongLock), "plant incorrect artifact integrity pin");
    await assert.rejects(digestExecutionRoot(derivative.root), WorkspaceDigestLimitError);
    await derivative.mutate("package-lock.json", originalLock, "restore exact lock");
    await derivative.mutate("package.json", JSON.stringify({ devDependencies: {} }), "remove artifact declaration");
    await assert.rejects(digestExecutionRoot(derivative.root), WorkspaceDigestLimitError);
    await derivative.mutate("package.json", JSON.stringify({ devDependencies: declarations.devDependencies }), "restore exact declaration");
    await rm(derivative.resolve(paths.arm64));
    for (const path of [paths.arm64 + "-helper", paths.arm64.replace("aarch64-apple-darwin", "x86_64-apple-darwin"), "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"]) {
      await sparse(derivative, path, ordinary + 1);
      await assert.rejects(digestExecutionRoot(derivative.root), WorkspaceDigestLimitError);
      await rm(derivative.resolve(path));
    }
    await sparse(derivative, "ordinary.bin", ordinary);
    const identity = await digestExecutionRoot(derivative.root);
    assert.equal(identity.scope.fileSizeAllowances, undefined);
    assert.deepEqual(DigestScopeSchema.parse(identity.scope), identity.scope, "ordinary persisted scope shape remains unchanged");
    await sparse(derivative, "ordinary.bin", ordinary + 1);
    await assert.rejects(digestExecutionRoot(derivative.root), WorkspaceDigestLimitError);
  });
});
