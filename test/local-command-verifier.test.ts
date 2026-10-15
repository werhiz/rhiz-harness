import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalCommandVerifierProvider, type LocalCommandExecutionCapture } from "../adapters/local/command-verifier.js";
import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import { requireProven, runDisposableProof, TempDirectoryDerivativeFactory } from "../src/disposable.js";
import type { CrewWorkspace } from "../src/crew.js";
import { parseWorkContract } from "../src/schemas.js";
import { human, testDigestScope } from "./helpers.js";

function work() {
  return parseWorkContract({
    id: "work:command",
    objective: "Run deterministic local command verification",
    type: "SHIP",
    scope: [{ uri: "repo://command", kind: "repository" }],
    writeScope: [{ uri: "repo://command/src", kind: "directory" }],
    nonGoals: [],
    authority: {
      grants: [{ action: "read", resources: [{ uri: "repo://command", kind: "repository" }], constraints: [] }],
      requiresHumanApproval: ["write", "publish"],
    },
    acceptanceCriteria: [{ id: "criterion:command", description: "Command behaves as expected", required: true }],
    requiredEvidence: [{ id: "requirement:test", description: "Test evidence", acceptedKinds: ["test"], required: true }],
    context: { strategy: "minimal", resources: [], includeHistory: false },
    dependencies: [],
    workerPolicy: { preferredProviders: [], maxAttempts: 1, allowParallelAttempts: false },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: false },
    createdBy: human,
    createdAt: "2026-08-20T17:00:00.000Z",
  });
}

function request(root: string, input: { id?: string; negativeControlFor?: string; config: Record<string, unknown> }) {
  const workspace: CrewWorkspace = {
    leaseId: "lease:command",
    workspaceId: "workspace:command",
    uri: "file:///tmp/command",
    executionRoot: root,
    baseRevision: "abc123",
    mode: "read-only",
  };
  return {
    work: work(),
    contractRevision: 1,
    workspace,
    target: {
      workspaceId: workspace.workspaceId,
      uri: workspace.uri,
      head: workspace.baseRevision,
      digest: "sha256:command-target",
      digestScope: testDigestScope,
      changedPaths: [],
    },
    check: {
      id: input.id ?? "check:command",
      providerId: "verifier:local-command",
      description: "command check",
      criterionIds: [],
      requirementIds: [],
      config: input.config,
      ...(input.negativeControlFor === undefined ? {} : {
        negativeControlFor: input.negativeControlFor,
        perturbation: {
          kind: "overwrite-file" as const,
          path: "src/subject.ts",
          content: "export const broken = true;\n",
          description: "subject replaced so the command has a known failure to detect",
        },
      }),
    },
  };
}

test("local command verifier runs explicit argv without a shell and emits digest evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-verifier-"));
  const provider = new LocalCommandVerifierProvider({ now: () => "2026-08-20T17:00:00.000Z" });
  try {
    const result = await provider.verify(request(root, {
      config: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('verified')"],
        expectedExitCodes: [0],
        evidenceKind: "test",
      },
    }));
    assert.equal(result.status, "pass");
    assert.match(result.summary, /exit 0/);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0]!.kind, "test");
    assert.match(result.evidence[0]!.digest!, /^sha256:/);
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("local command verifier supports a real negative control through expected failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-control-"));
  const provider = new LocalCommandVerifierProvider();
  try {
    const result = await provider.verify(request(root, {
      id: "check:negative-control",
      negativeControlFor: "check:primary",
      config: {
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        expectedExitCodes: [3],
        evidenceKind: "test",
      },
    }));
    assert.equal(result.status, "pass");
    assert.match(result.summary, /exit 3; expected 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unexpected exit and missing executable fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-failure-"));
  const provider = new LocalCommandVerifierProvider();
  try {
    const unexpected = await provider.verify(request(root, {
      config: { command: process.execPath, args: ["-e", "process.exit(4)"], expectedExitCodes: [0] },
    }));
    assert.equal(unexpected.status, "fail");

    const missing = await provider.verify(request(root, {
      id: "check:missing",
      config: { command: "rhiz-command-that-does-not-exist", expectedExitCodes: [0] },
    }));
    assert.equal(missing.status, "error");
    assert.equal(missing.evidence.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command timeout produces a failed bounded receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-timeout-"));
  const provider = new LocalCommandVerifierProvider();
  try {
    const result = await provider.verify(request(root, {
      id: "check:timeout",
      config: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        expectedExitCodes: [0],
        timeoutMs: 100,
      },
    }));
    assert.equal(result.status, "fail");
    assert.match(result.summary, /timed out/);
    assert.equal(result.evidence.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const captureDigest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

async function captureFixture(proof: Parameters<typeof runDisposableProof<boolean>>[0]["proof"]) {
  const root = mkdtempSync(join(tmpdir(), "rhiz-command-capture-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "fixture.txt"), "immutable command capture fixture");
  try {
    requireProven(await runDisposableProof({
      candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(), proof,
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("trusted outcome retention binds immutable actual command, target, bytes and time", async () => {
  await captureFixture(async (derivative) => {
    mkdirSync(derivative.resolve("workspace"));
    const receipt = derivative.resolve("receipt.json");
    let observed: LocalCommandExecutionCapture | undefined;
    const retained = { id: "receipt:command", kind: "receipt" as const, uri: receipt, digest: "" };
    const provider = new LocalCommandVerifierProvider({
      now: () => "2026-10-15T22:00:00.000Z",
      retainOutcome: async (capture) => {
        observed = capture;
        assert.throws(() => Object.assign(capture.config, { command: "FORGED" }), TypeError);
        assert.throws(() => Object.assign(capture.target.changedPaths, { 0: "FORGED" }), TypeError);
        writeFileSync(receipt, JSON.stringify(capture), { flag: "wx", mode: 0o600 });
        retained.digest = captureDigest(capture);
        return retained;
      },
    });
    try {
      const input = request(derivative.resolve("workspace"), { config: {
        command: process.execPath, args: ["-e", "process.stdout.write(Buffer.from([0,255,10]));process.stderr.write('diagnostic')"],
      } });
      const pending = provider.verify(input);
      input.target.head = "late-caller-mutation";
      input.check.id = "late-caller-mutation";
      const result = await pending;
      assert.equal(result.status, "pass"); assert.equal(result.evidence.length, 2);
      assert(observed); assert.equal(observed.schema, "rhiz/local-command-execution/v1");
      assert.equal(observed.workId, input.work.id); assert.equal(observed.contractRevision, 1);
      assert.equal(observed.checkId, "check:command"); assert.equal(result.checkId, "check:command");
      assert.equal(observed.workspace.executionRoot, derivative.resolve("workspace"));
      assert.equal(observed.target.head, "abc123"); assert.equal(observed.config.command, process.execPath);
      assert.equal(observed.startedAt, "2026-10-15T22:00:00.000Z"); assert.equal(observed.finishedAt, observed.startedAt);
      assert.deepEqual(Buffer.from(observed.outcome.stdoutBase64, "base64"), Buffer.from([0,255,10]));
      assert.equal(Buffer.from(observed.outcome.stderrBase64, "base64").toString(), "diagnostic");
      assert.equal(observed.outcomeDigest, result.evidence[0]!.digest);
      assert.equal(captureDigest(JSON.parse(readFileSync(receipt, "utf8"))), result.evidence[1]!.digest);
      retained.digest = "MUTATED_AFTER_RETURN";
      assert.notEqual(result.evidence[1]!.digest, retained.digest);
    } finally { await provider.close(); }
    return true;
  });
});

test("retention failure or altered command, target or output refuses captured success", async () => {
  await captureFixture(async (derivative) => {
    for (const alter of ["throw", "command", "target", "output", "kind", "missing-uri"]) {
      const provider = new LocalCommandVerifierProvider({ retainOutcome: async (capture) => {
        if (alter === "throw") throw new Error("SECRET_SINK_DIAGNOSTIC");
        const changed = JSON.parse(JSON.stringify(capture));
        if (alter === "command") changed.config.command = "forged";
        if (alter === "target") changed.target.head = "forged";
        if (alter === "output") changed.outcome.stdoutBase64 = "Zm9yZ2Vk";
        await derivative.mutate("altered-receipt.json", JSON.stringify(changed), "alter actual retained command evidence");
        return { id: "receipt:changed", kind: alter === "kind" ? "artifact-identity" : "receipt", ...(alter === "missing-uri" ? {} : { uri: derivative.resolve("altered-receipt.json") }), digest: captureDigest(changed) };
      } });
      try {
        const result = await provider.verify(request(derivative.root, { config: { command: process.execPath, args: ["-e", "process.stdout.write('actual')"] } }));
        assert.equal(result.status, "error", alter); assert.deepEqual(result.evidence, []);
        assert.match(result.summary, /command outcome retention failed/); assert(!result.summary.includes("SECRET_"));
      } finally { await provider.close(); }
    }
    return true;
  });
});

test("trusted outcome retention has a deadline and ignores late sink settlement", async () => {
  await captureFixture(async (derivative) => {
    for (const late of [false, true]) {
      let aborted = false;
      const provider = new LocalCommandVerifierProvider({
        outcomeRetentionTimeoutMs: 10,
        retainOutcome: async (capture, signal) => {
          signal.addEventListener("abort", () => { aborted = true; }, { once: true });
          if (!late) return new Promise(() => {});
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { id: "receipt:late", kind: "receipt", uri: "memory://late", digest: captureDigest(capture) };
        },
      });
      let watchdog: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          provider.verify(request(derivative.root, { config: { command: process.execPath, args: ["-e", "process.exit(0)"] } })),
          new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("test watchdog: retention deadline did not settle")), 500); }),
        ]);
        assert.equal(result.status, "error"); assert.deepEqual(result.evidence, []);
        assert.match(result.summary, /command outcome retention timed out/); assert(aborted);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(result.status, "error"); assert.deepEqual(result.evidence, []);
      } finally { if (watchdog) clearTimeout(watchdog); await provider.close(); }
    }
    for (const value of [0, 120001, Number.NaN]) assert.throws(() => new LocalCommandVerifierProvider({ outcomeRetentionTimeoutMs: value }), RangeError);
    return true;
  });
});

test("captured outcomes preserve nonzero, signal, timeout and bounded bytes without inferring cause", async () => {
  await captureFixture(async (derivative) => {
    const captures: LocalCommandExecutionCapture[] = [];
    const provider = new LocalCommandVerifierProvider({ retainOutcome: async (capture) => {
      captures.push(capture);
      return { id: `receipt:${captures.length}`, kind: "receipt", uri: `memory://capture/${captures.length}`, digest: captureDigest(capture) };
    } });
    try {
      for (const [source, expected, timeoutMs] of [
        ["process.exit(3)", "nonzero", 2000],
        ["process.kill(process.pid,'SIGTERM')", "signal", 2000],
        ["setTimeout(()=>{},1000)", "timeout", 50],
        ["process.stdout.write('x'.repeat(100));process.stderr.write('y'.repeat(100))", "bounded", 2000],
      ] as const) {
        const result = await provider.verify(request(derivative.root, { config: { command: process.execPath, args: ["-e", source], timeoutMs, maxOutputBytes: 16 } }));
        const capture = captures.at(-1)!;
        assert.equal(result.status, expected === "bounded" ? "pass" : "fail");
        assert.equal(capture.outcome.timedOut, expected === "timeout");
        if (expected === "nonzero") assert.equal(capture.outcome.exitCode, 3);
        if (expected === "signal") { assert.equal(capture.outcome.exitCode, null); assert.equal(capture.outcome.signal, "SIGTERM"); }
        if (expected === "bounded") {
          assert(capture.outcome.stdoutTruncated && capture.outcome.stderrTruncated);
          assert.equal(Buffer.from(capture.outcome.stdoutBase64, "base64").length, 16);
          assert.equal(Buffer.from(capture.outcome.stderrBase64, "base64").length, 16);
        }
        assert.equal(typeof capture.outcome.processLeak, "boolean");
      }
      const count = captures.length;
      const missing = await provider.verify(request(derivative.root, { config: { command: derivative.resolve("missing") } }));
      assert.equal(missing.status, "error"); assert.equal(captures.length, count);
      await assert.rejects(provider.verify(request(derivative.root, { config: { command: process.execPath, retainOutcome: "untrusted" } })));
    } finally { await provider.close(); }
    return true;
  });
});
