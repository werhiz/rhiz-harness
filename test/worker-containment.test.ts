// Worker containment proofs — issue #11.
//
// Authority reached workers as prompt text and nothing else. These tests prove
// the other kind of boundary: a write-enabled worker executes inside an
// operating-system confinement derived from its WorkContract, escape attempts
// are refused by the OS and evidenced as authority events at the seam that
// imposed the boundary, and unknown (host-policy) write authority is denied.
//
// The macOS sandbox-exec tests prove the BOUNDARY and run only on darwin. The
// wiring, fail-closed, derivation, projection, and git-hardening tests prove
// the rest on every platform. See ADR 0017 (verifier containment) and ADR 0020
// (extending that seam to workers).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitWorktreeWorkspaceProvider } from "../adapters/git/worktrees.js";
import { LocalCommandWorkerProvider, LocalContainedWorkerHost } from "../adapters/local/command-worker.js";
import { MacosSandboxExecLauncher } from "../adapters/local/sandbox.js";
import { projectBoard } from "../src/board.js";
import type {
  CrewWorkspace,
  CrewWorkspaceAcquireRequest,
  CrewWorkspaceProvider,
  CrewWorkspaceSnapshot,
} from "../src/crew.js";
import { CrewSupervisor, parseCrewPlan } from "../src/crew.js";
import type { HarnessEvent, WorkContract } from "../src/schemas.js";
import type { HarnessHost, WorkerObservation, WorkerProvider, WorkerStartRequest } from "../src/host.js";
import { InMemoryEventLedger } from "../src/ledger.js";
import type { SandboxLauncher } from "../src/sandbox.js";
import { parseSandboxPolicy, SandboxPolicyError, SandboxUnavailableError, workerSandboxPolicy } from "../src/sandbox.js";
import { parseWorkContract } from "../src/schemas.js";
import { selectWorkerProvider, WorkerCatalog, WorkerSelectionError } from "../src/workers.js";
import { human, sandboxCapableCatalog } from "./helpers.js";

const darwin = process.platform === "darwin";
const skipUnlessDarwin = darwin ? false : "sandbox-exec containment requires darwin";

/** A minimal committed repository with a src/ directory the writeScope can name. */
function fixtureRepository(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rhiz-worker-repo-"));
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "probe@rhiz.test"]);
  run(["config", "user.name", "Rhiz Probe"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "fixture base"]);
  return root;
}

function containmentWork(id: string): WorkContract {
  return parseWorkContract({
    id,
    objective: "Probe the OS boundary around a write-enabled worker",
    type: "SHIP",
    scope: [{ uri: "repo://fixture", kind: "repository" }],
    writeScope: [{ uri: "repo://fixture/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [{ action: "write", resources: [{ uri: "repo://fixture/src", kind: "directory" }], constraints: [] }],
      requiresHumanApproval: [],
    },
    acceptanceCriteria: [{ id: "criterion:containment", description: "escapes are refused by the OS", required: true }],
    requiredEvidence: [],
    context: { strategy: "minimal", resources: [], includeHistory: true },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false, explicitProviderAuthorizations: [] },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: { id: "human:owner", kind: "human" },
    createdAt: "2026-08-22T10:00:00.000Z",
  });
}

/**
 * The escape probe: attempts the three writes named by issue #11 and reports
 * which side of the boundary it landed on. Exit 42 means every write was
 * refused by the operating system (the open failed; the shell never ran the
 * redirect). Exit 7 with ESCAPED:<path> means a write landed.
 */
function escapeProbe(targets: readonly string[]): { command: string; args: string[] } {
  const script = [
    `for t in ${targets.map((t) => `"${t}"`).join(" ")}; do`,
    `  if (echo rhiz-escape-probe >> "$t") 2>/dev/null; then echo "ESCAPED:$t"; exit 7; fi`,
    `done`,
    `echo ALL_REFUSED`,
    `exit 42`,
  ].join("\n");
  return { command: "/bin/sh", args: ["-c", script] };
}

test("worker cannot write outside its execution root", { skip: skipUnlessDarwin }, async () => {
  const repository = fixtureRepository();
  const worktreeArea = mkdtempSync(join(realpathSync(tmpdir()), "rhiz-worker-area-"));
  const fakeHome = mkdtempSync(join(realpathSync(tmpdir()), "rhiz-worker-home-"));
  const tmpTarget = join(realpathSync(tmpdir()), `rhiz-worker-escape-${process.pid}.txt`);
  const parentGitConfig = join(repository, ".git", "config");
  const homeTarget = join(fakeHome, ".ssh", "authorized_keys");
  mkdirSync(join(fakeHome, ".ssh"));

  const workspaceProvider = new GitWorktreeWorkspaceProvider({
    repositoryRoot: repository,
    worktreeRoot: worktreeArea,
  });
  const probe = escapeProbe([tmpTarget, parentGitConfig, homeTarget]);
  const worker = new LocalCommandWorkerProvider({
    id: "worker:escape-probe",
    command: probe.command,
    args: probe.args,
    deniedExitCodes: [42],
    sandbox: new MacosSandboxExecLauncher(),
    timeoutMs: 60_000,
  });
  try {
    const contract = containmentWork("work:escape-probe");
    const workspace = await workspaceProvider.acquire({
      crewId: "crew:containment-proof",
      work: contract,
      baseRevision: "HEAD",
      mode: "isolated-write",
    });
    // #40 deliberately refuses this provider through Crew: it has no native
    // permission callback and declares guardedToolMediation=false. This test
    // still needs to execute the OS seam itself; Crew-to-Ledger forwarding is
    // proven independently below on a read-only seam fixture.
    const handle = await worker.start({
      work: contract,
      taskId: "task:escape-probe",
      attemptId: "attempt:escape-probe",
      objective: contract.objective,
      authority: contract.authority,
      context: contract.context,
      workspace,
    });
    const observations: WorkerObservation[] = [];
    const collect = (async () => {
      for await (const observation of handle.observe()) observations.push(observation);
    })();
    const workerResult = await handle.result();
    await collect;

    // The worker reported the OS refused every write, so the attempt cannot
    // count as finished work.
    assert.equal(workerResult.status, "failed");

    // The three escape targets named by the issue must not exist. This is the
    // OS-boundary claim: the writes were attempted (the probe only exits 42
    // when every attempt failed to open the target) and none landed.
    assert.equal(existsSync(tmpTarget), false, "the contained worker wrote to os.tmpdir()");
    assert.equal(
      existsSync(parentGitConfig) && execFileSync("git", ["-C", repository, "config", "--local", "--list"], { encoding: "utf8" }).includes("rhiz-escape-probe"),
      false,
      "the contained worker wrote to the parent repository's .git/config",
    );
    assert.equal(existsSync(homeTarget), false, "the contained worker wrote to a HOME path");

    // Authority evidence comes from the enforcement seam, in order: granted
    // when the boundary was imposed, denied when the OS refused the worker.
    const granted = observations.filter((observation) => observation.authority?.decision === "granted");
    const denied = observations.filter((observation) => observation.authority?.decision === "denied");
    assert.equal(granted.length, 1, "the seam did not emit authority.granted when it imposed the boundary");
    assert.equal(denied.length, 1, "the seam did not emit authority.denied when the OS refused the worker");
    const deniedReason = JSON.stringify(denied[0]!.authority);
    assert.match(deniedReason, /exit 42/, "the denial must carry the worker's OS-refusal report");
  } finally {
    await workspaceProvider.close().catch(() => undefined);
    rmSync(repository, { recursive: true, force: true });
    rmSync(worktreeArea, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(tmpTarget, { force: true });
  }
});

test("git subcommands ignore repository-supplied config", async () => {
  const repository = fixtureRepository();
  const worktreeArea = mkdtempSync(join(realpathSync(tmpdir()), "rhiz-git-hardening-"));
  const marker = join(worktreeArea, "HOSTILE-RAN");
  const hostile = join(worktreeArea, "hostile-hook.sh");
  writeFileSync(hostile, `#!/bin/sh\necho RAN >> ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });

  const workspaceProvider = new GitWorktreeWorkspaceProvider({
    repositoryRoot: repository,
    worktreeRoot: join(worktreeArea, "worktrees"),
  });
  try {
    const workspace = await workspaceProvider.acquire({
      crewId: "crew:git-hardening",
      work: containmentWork("work:git-hardening"),
      baseRevision: "HEAD",
      mode: "isolated-write",
    });

    // Plant hostile config exactly where a worker (or a poisoned dependency)
    // would: the repository's own config, read by every git subcommand the
    // harness runs during snapshot and release. fsmonitor is queried by the
    // index refresh inside `git diff` / `git ls-files`, which is what makes
    // this leg falsifiable; core.pager is planted too and asserted for the
    // same reason, though piped output means git would not page regardless.
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["-C", workspace.executionRoot, "config", "core.fsmonitor", hostile], { env: gitEnv });
    execFileSync("git", ["-C", workspace.executionRoot, "config", "core.pager", hostile], { env: gitEnv });

    const snapshot = await workspaceProvider.snapshot(workspace);
    assert.ok(snapshot.digest.length > 0, "snapshot failed under hostile config");
    await workspaceProvider.release(workspace.workspaceId);
    await workspaceProvider.close();

    assert.equal(
      existsSync(marker),
      false,
      "a repository-supplied core.fsmonitor/core.pager executed during snapshot or release",
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(worktreeArea, { recursive: true, force: true });
  }
});

test("host-policy write authority is denied, not permitted", async () => {
  // The provider describes itself exactly as the DSH product routes do on
  // main: writeAccess "host-policy", meaning the host will not say what the
  // worker can write. Crew must refuse it for a SHIP (write-enabled) mission.
  const hostPolicyProvider: WorkerProvider = {
    id: "worker:host-policy",
    async describe() {
      return {
        id: "worker:host-policy",
        displayName: "host-policy worker",
        description: "declares writeAccess host-policy",
        adapter: "test",
        product: "test",
        execution: "one-shot",
        context: "standalone",
        authorityMode: "host-policy",
        writeAccess: "host-policy",
        dangerous: false,
        bindsWorkspace: true,
        credentialEnv: [],
      };
    },
    async capabilities() {
      return { streamingObservations: true, cancel: false, resume: false, guardedToolMediation: false };
    },
    async start() {
      throw new Error("must never be started");
    },
  };

  const catalog = new WorkerCatalog(hostPolicyProvider);
  const ship = containmentWork("work:host-policy-deny");
  await assert.rejects(
    () => selectWorkerProvider(catalog, ship, {
      allowedWriteAccess: ship.type === "SHIP" ? ["workspace"] : ["none"],
      requireWorkspaceBinding: true,
      requireSandboxCapableHost: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerSelectionError);
      const reasons = error.rejections.map((item) => item.reason);
      assert.ok(
        reasons.some((reason) => reason.includes("write access host-policy is not allowed")),
        `selection must refuse host-policy write access, got: ${reasons.join("; ")}`,
      );
      return true;
    },
  );

  // And through Crew, the real supervision path: a SHIP mission whose only
  // candidate is host-policy fails closed before any worker starts.
  //
  // The provider is registered through a host that DOES impose containment, so
  // the sandbox-capable-host gate cannot be what refuses it. Without that, this
  // leg passes for the wrong reason: the containment gate rejects first, and
  // the rejection string happens to contain "host-policy" because that is the
  // provider's id rather than because unknown write authority was denied. That
  // exact vacuity was found by mutation (flipping Crew's allowedWriteAccess
  // back to permit host-policy left this test green) and is why the assertion
  // below names the write-access reason verbatim.
  const workspaceProvider = new FakeWorkspaceProvider();
  const run = await new CrewSupervisor({
    plan: parseCrewPlan({
      id: "crew:host-policy-deny",
      objective: "Unknown write authority must deny, never permit",
      baseRevision: "abc123",
      missions: [{
        work: ship,
        workspace: { strategy: "fresh", mode: "isolated-write" },
        requiredCapabilities: [],
      }],
    }),
    ledger: new InMemoryEventLedger(),
    workerCatalog: sandboxCapableCatalog(hostPolicyProvider),
    workspaceProvider,
    actor: human,
  }).run();
  await run.close();

  const mission = run.receipt.missions[0]!;
  assert.equal(mission.status, "failed");
  assert.equal(mission.workerProviderId, undefined, "an authority-denied provider must never start an attempt");
  assert.match(mission.error ?? "", /no capable worker provider/);
  // The verbatim reason, not merely the substring "host-policy": the provider's
  // own id contains that string, so matching on it alone proves nothing.
  assert.match(mission.error ?? "", /write access host-policy is not allowed/);
});

test("the worker executes the launcher's rewritten command, not the original", async () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rhiz-worker-wrap-")));
  const marker = join(root, "WRAPPED.txt");
  let wrapCalls = 0;
  let disposeCalls = 0;
  const recording: SandboxLauncher = {
    id: "sandbox:recording",
    available: async () => true,
    wrap: async () => {
      wrapCalls += 1;
      return {
        command: "/bin/sh",
        args: ["-c", `echo wrapped > ${JSON.stringify(marker)}`],
        dispose: async () => { disposeCalls += 1; },
      };
    },
  };
  const worker = new LocalCommandWorkerProvider({
    id: "worker:wrap-proof",
    command: "/bin/sh",
    args: ["-c", `echo original > ${JSON.stringify(join(root, "ORIGINAL.txt"))}`],
    sandbox: recording,
    timeoutMs: 20_000,
  });
  try {
    const handle = await worker.start({
      work: containmentWork("work:wrap-proof"),
      taskId: "task:wrap-proof",
      attemptId: "attempt:wrap-proof",
      objective: "prove the seam executes the wrapped argv",
      authority: { grants: [], requiresHumanApproval: [] },
      context: { strategy: "minimal", resources: [], includeHistory: true },
      workspace: {
        workspaceId: "workspace:wrap",
        leaseId: "lease:wrap",
        uri: `file://${root}`,
        executionRoot: root,
        mode: "isolated-write",
        baseRevision: "0".repeat(40),
      },
    });
    const result = await handle.result();
    assert.equal(wrapCalls, 1, "the worker never asked the launcher to wrap the command");
    assert.equal(result.status, "finished");
    assert.equal(existsSync(marker), true, "the worker did not execute the rewritten command");
    assert.equal(existsSync(join(root, "ORIGINAL.txt")), false, "the sandbox wrapping was bypassed");
    assert.equal(disposeCalls, 1, "the wrapping artifact was never disposed");
    const observations: WorkerObservation[] = [];
    for await (const observation of handle.observe()) observations.push(observation);
    const granted = observations.find((observation) => observation.authority?.decision === "granted");
    assert.ok(granted, "the seam did not report authority.granted when it imposed the boundary");
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("requiring containment with an unavailable launcher refuses to start, never runs unconfined", async () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rhiz-worker-failclosed-")));
  const worker = new LocalCommandWorkerProvider({
    id: "worker:fail-closed",
    command: "/bin/sh",
    args: ["-c", "echo ran > RAN.txt"],
    sandbox: {
      id: "sandbox:never-available",
      available: async () => false,
      wrap: async () => { throw new Error("must not be reached"); },
    },
    timeoutMs: 20_000,
  });
  try {
    await assert.rejects(
      () => worker.start({
        work: containmentWork("work:fail-closed"),
        taskId: "task:fail-closed",
        attemptId: "attempt:fail-closed",
        objective: "prove fail-closed",
        authority: { grants: [], requiresHumanApproval: [] },
        context: { strategy: "minimal", resources: [], includeHistory: true },
        workspace: {
          workspaceId: "workspace:fail-closed",
          leaseId: "lease:fail-closed",
          uri: `file://${root}`,
          executionRoot: root,
          mode: "isolated-write",
          baseRevision: "0".repeat(40),
        },
      }),
      SandboxUnavailableError,
    );
    assert.equal(existsSync(join(root, "RAN.txt")), false, "a worker whose boundary cannot be imposed ran anyway");
  } finally {
    await worker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker sandbox policy is derived from the Work writeScope, fail-closed", () => {
  const root = "/exec/root";
  const home = "/scratch/home";
  const request = (writeScope: WorkContract["writeScope"]): WorkerStartRequest => ({
    work: { ...containmentWork("work:policy"), writeScope },
    taskId: "task:policy",
    attemptId: "attempt:policy",
    objective: "policy derivation",
    authority: { grants: [], requiresHumanApproval: [] },
    context: { strategy: "minimal", resources: [], includeHistory: true },
    workspace: {
      workspaceId: "workspace:policy",
      leaseId: "lease:policy",
      uri: "file:///exec/root",
      executionRoot: root,
      mode: "isolated-write",
      baseRevision: "0".repeat(40),
    },
  });

  // A repository-wide write scope maps to the execution root itself.
  assert.deepEqual(
    workerSandboxPolicy(request([{ uri: "repo://fixture", kind: "repository" }]), home).writableRoots,
    ["/exec/root", home],
  );
  // A directory scope maps to that subpath only.
  assert.deepEqual(
    workerSandboxPolicy(request([{ uri: "repo://fixture/src", kind: "directory" }]), home).writableRoots,
    ["/exec/root/src", home],
  );
  // Relative file/dir/path URIs resolve inside the root.
  assert.deepEqual(
    workerSandboxPolicy(request([{ uri: "dir://src", kind: "directory" }]), home).writableRoots,
    ["/exec/root/src", home],
  );
  // An absolute path outside the execution root cannot be derived into an
  // allow rule: refusing is the only fail-closed answer.
  assert.throws(
    () => workerSandboxPolicy(request([{ uri: "file:///etc/passwd", kind: "file" }]), home),
    SandboxPolicyError,
  );
  // Neither can traversal.
  assert.throws(
    () => workerSandboxPolicy(request([{ uri: "repo://fixture/../..", kind: "directory" }]), home),
    SandboxPolicyError,
  );
  // Neither can an unrecognised URI scheme.
  assert.throws(
    () => workerSandboxPolicy(request([{ uri: "weird://thing", kind: "other" }]), home),
    SandboxPolicyError,
  );
  // No write scope at all means the scratch home only.
  assert.deepEqual(
    workerSandboxPolicy(request([]), home).writableRoots,
    [home],
  );
  // The derived policy stays deny-by-default for network.
  assert.equal(workerSandboxPolicy(request([]), home).allowNetwork, false);
  assert.equal(parseSandboxPolicy(workerSandboxPolicy(request([]), home)).allowProcessExec, true);
});

test("authority decisions are projected onto the Board, not dropped", async () => {
  const work = containmentWork("work:authority-projection");
  const ledger = new InMemoryEventLedger();
  const streamId = "stream:authority-projection";
  const append = async (type: HarnessEvent["type"], payload: unknown): Promise<void> => {
    await ledger.append({
      id: `event:${type}`,
      type,
      schemaVersion: 1,
      streamId,
      workId: work.id,
      actor: human,
      occurredAt: "2026-08-22T10:00:01.000Z",
      recordedAt: "2026-08-22T10:00:01.000Z",
      evidence: [],
      payload,
    } as never);
  };
  await append("work.created", { contract: work, revision: 1 });
  await append("authority.granted", { policy: work.authority, reason: "OS confinement imposed at the start seam" });
  await append("authority.denied", { policy: work.authority, reason: "OS boundary refused a write outside the writable roots" });

  const board = projectBoard(await ledger.replay(streamId));
  assert.deepEqual(
    board.authorityDecisions.map((decision) => ({ decision: decision.decision, reason: decision.reason })),
    [
      { decision: "granted", reason: "OS confinement imposed at the start seam" },
      { decision: "denied", reason: "OS boundary refused a write outside the writable roots" },
    ],
  );
  assert.equal(board.violations.length, 0, "authority events must not be projection violations");
});

// Minimal local workspace provider for the host-policy Crew path (no git).
class FakeWorkspaceProvider implements CrewWorkspaceProvider {
  readonly id = "workspace:fake";
  #counter = 0;
  async acquire(request: CrewWorkspaceAcquireRequest): Promise<CrewWorkspace> {
    this.#counter += 1;
    return {
      leaseId: `lease:${this.#counter}`,
      workspaceId: `workspace:${this.#counter}`,
      uri: `memory://workspace/${this.#counter}`,
      executionRoot: `/memory/workspace/${this.#counter}`,
      baseRevision: request.baseRevision,
      mode: request.mode,
      ...(request.sourceWorkId === undefined ? {} : { sourceWorkId: request.sourceWorkId }),
    };
  }
  async snapshot(workspace: CrewWorkspace): Promise<CrewWorkspaceSnapshot> {
    return {
      workspaceId: workspace.workspaceId,
      head: workspace.baseRevision,
      digest: `sha256:${"0".repeat(64)}`,
      digestScope: {
        algorithm: "sha256",
        strategy: "execution-root-content",
        exclusions: [".git"],
        fileCount: 0,
        totalBytes: 0,
        symlinkCount: 0,
      },
      changedPaths: [],
      observedAt: "2026-08-22T10:00:00.000Z",
    };
  }
  async release(): Promise<void> {}
  async close(): Promise<void> {}
}

test("a host that does not impose containment cannot take write-enabled work", async () => {
  // Same provider, two hosts. The only difference is whether the host's
  // capabilities report an OS boundary, and that alone must decide it.
  const provider: WorkerProvider = {
    id: "worker:uncontained",
    async describe() {
      return {
        id: "worker:uncontained",
        displayName: "uncontained worker",
        description: "declares workspace write access but has no OS boundary behind it",
        adapter: "test",
        product: "test",
        execution: "one-shot",
        context: "standalone",
        authorityMode: "prompt-text",
        writeAccess: "workspace",
        dangerous: false,
        bindsWorkspace: true,
        credentialEnv: [],
      };
    },
    async capabilities() {
      return { streamingObservations: true, cancel: false, resume: false, guardedToolMediation: false };
    },
    async start() {
      throw new Error("must never be started");
    },
  };

  const hostWith = (sandbox: boolean): HarnessHost => ({
    id: `host:sandbox-${sandbox}`,
    async capabilities() {
      return { workers: true, processes: true, sessions: false, filesystem: false, sandbox, tools: false };
    },
    workers() {
      return { list: () => [provider], get: (id: string) => (id === provider.id ? provider : undefined) };
    },
    processes: () => null,
    sessions: () => null,
    filesystem: () => null,
    sandbox: () => null,
    tools: () => null,
    async close() {},
  });

  const ship = containmentWork("work:uncontained-host");

  // sandbox: false — refused, and the reason names the missing boundary.
  const denying = new WorkerCatalog();
  denying.registerHost(hostWith(false));
  await assert.rejects(
    () => selectWorkerProvider(denying, ship, {
      allowedWriteAccess: ["workspace"],
      requireWorkspaceBinding: true,
      requireSandboxCapableHost: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerSelectionError);
      assert.ok(
        error.rejections.some((item) => item.reason.includes("requires a host that imposes OS containment")),
        `got: ${error.rejections.map((item) => item.reason).join("; ")}`,
      );
      return true;
    },
  );

  // sandbox: true — the same provider is admitted. Without this leg the test
  // above would pass for any reason at all, including an unrelated rejection.
  const permitting = new WorkerCatalog();
  permitting.registerHost(hostWith(true));
  const selection = await selectWorkerProvider(permitting, ship, {
    allowedWriteAccess: ["workspace"],
    requireWorkspaceBinding: true,
    requireSandboxCapableHost: true,
  });
  assert.equal(selection.provider.id, provider.id);
});

test("HostCapabilities.sandbox is derived from a working launcher, never asserted", async () => {
  // A host must not be able to advertise containment it does not have: the
  // sandbox-capable-host gate above is only worth what this makes true.
  const unavailable: SandboxLauncher = {
    id: "sandbox:never-available",
    available: async () => false,
    wrap: async () => { throw new Error("must not be reached"); },
  };
  const working: SandboxLauncher = {
    id: "sandbox:working",
    available: async () => true,
    wrap: async () => ({ command: "/bin/sh", args: ["-c", "true"], dispose: async () => {} }),
  };

  const hostFor = (sandbox: SandboxLauncher): LocalContainedWorkerHost =>
    new LocalContainedWorkerHost({
      worker: new LocalCommandWorkerProvider({ id: "worker:derived", command: "/bin/sh", args: ["-c", "true"], sandbox }),
    });

  const broken = hostFor(unavailable);
  const sound = hostFor(working);
  try {
    assert.equal((await broken.capabilities()).sandbox, false, "a host with an unavailable launcher claimed containment");
    assert.equal((await sound.capabilities()).sandbox, true, "a host with a working launcher denied its own containment");
  } finally {
    await broken.close();
    await sound.close();
  }
});

test("a seam's authority report reaches the Ledger and the Board, on every platform", async () => {
  // This proves the EVIDENCE CHANNEL, not the boundary.
  //
  // The escape test above proves both at once, and it is darwin-gated because
  // sandbox-exec is. CI runs Linux, so on CI that test skips -- and with it went
  // the only thing falsifying the Crew append, leaving the declared guard
  // crew/authority-evidence-reaches-the-ledger-from-the-seam unproven on the
  // very platform the gate runs on. A guard proven only where the gate does not
  // run is not a guard.
  //
  // So the channel is proven separately, with a stub provider standing in for a
  // seam. What that stub asserts is exactly and only this: when a provider
  // reports an authority decision, Crew turns it into a durable ledger fact and
  // the Board projects it. It asserts NOTHING about whether an operating system
  // refused anything -- a stub cannot prove a boundary, and this test must never
  // be read as if it did.
  const work = parseWorkContract({
    ...containmentWork("work:authority-channel"),
    type: "SCOUT",
    writeScope: [],
    authority: {
      grants: [{ action: "read", resources: [{ uri: "repo://fixture", kind: "repository" }], constraints: [] }],
      requiresHumanApproval: [],
    },
  });
  const reports: WorkerObservation[] = [
    {
      kind: "diagnostic",
      occurredAt: "2026-08-22T10:00:01.000Z",
      detail: "OS containment imposed",
      authority: {
        decision: "granted",
        boundary: "sandbox:stub-seam",
        reason: "writes confined to /memory/workspace/1/src; network denied",
      },
    },
    {
      kind: "blocked",
      occurredAt: "2026-08-22T10:00:02.000Z",
      detail: "the OS boundary refused the worker (exit 42)",
      authority: {
        decision: "denied",
        boundary: "sandbox:stub-seam",
        reason: "contained worker reported OS refusal (exit 42)",
      },
    },
  ];

  const seam: WorkerProvider = {
    id: "worker:stub-seam",
    async describe() {
      return {
        id: "worker:stub-seam",
        displayName: "stub seam",
        description: "stands in for an enforcement seam to prove the evidence channel only",
        adapter: "test",
        product: "test",
        execution: "one-shot",
        context: "standalone",
        authorityMode: "os-contained:write-scope",
        writeAccess: "none",
        dangerous: false,
        bindsWorkspace: true,
        credentialEnv: [],
      };
    },
    async capabilities() {
      return { streamingObservations: true, cancel: false, resume: false, guardedToolMediation: false };
    },
    async start(request) {
      return {
        workerId: "worker:stub-seam",
        attemptId: request.attemptId,
        async *observe() { for (const report of reports) yield report; },
        async result() {
          return { status: "failed" as const, summary: "refused by the boundary", artifacts: [], evidence: [] };
        },
        async cancel() {},
      };
    },
  };

  const ledger = new InMemoryEventLedger();
  const run = await new CrewSupervisor({
    plan: parseCrewPlan({
      id: "crew:authority-channel",
      objective: "A seam's authority report must become a durable fact",
      baseRevision: "abc123",
      missions: [{
        work,
        workspace: { strategy: "fresh", mode: "read-only" },
        requiredCapabilities: [],
      }],
    }),
    ledger,
    workerCatalog: sandboxCapableCatalog(seam),
    workspaceProvider: new FakeWorkspaceProvider(),
    actor: human,
  }).run();
  await run.close();

  const mission = run.receipt.missions[0]!;
  assert.equal(mission.workerProviderId, "worker:stub-seam", "the stub seam never ran");

  const events = await ledger.replay(mission.streamId!);
  const granted = events.filter((event) => event.type === "authority.granted");
  const denied = events.filter((event) => event.type === "authority.denied");
  assert.equal(granted.length, 1, "a seam's authority.granted report never reached the Ledger");
  assert.equal(denied.length, 1, "a seam's authority.denied report never reached the Ledger");

  // The reason must survive the trip intact, carrying the boundary that imposed
  // it. An event that arrives stripped of why is not evidence of anything.
  assert.match(JSON.stringify(granted[0]!.payload), /network denied/);
  assert.match(JSON.stringify(denied[0]!.payload), /exit 42/);
  assert.match(JSON.stringify(denied[0]!.payload), /sandbox:stub-seam/);

  const board = projectBoard(events);
  assert.deepEqual(
    board.authorityDecisions.map((decision) => decision.decision),
    ["granted", "denied"],
    "authority events fell through the Board projection",
  );
});
