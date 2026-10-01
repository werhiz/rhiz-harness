import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDshProductOperatorProof,
  type DshProductOperatorProof,
} from "../adapters/dsh/operator-proof.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const head = "c".repeat(40);

function proof(): DshProductOperatorProof {
  return {
    schema: "rhiz/dsh-product-operator-proof/v0",
    generatedAt: "2026-08-20T12:00:00.000Z",
    source: {
      repository: "rhiz-harness",
      branch: "feat/dsh-product-worker-routes-v0",
      head,
      workspaceBefore: digestA,
      workspaceAfter: digestA,
      workspaceUnchanged: true,
    },
    nonce: "RHIZ-PROOF-12345678",
    contractDigest: digestB,
    workers: [
      {
        workerId: "worker:codex",
        product: "codex",
        productVersion: "0.147.0",
        authorityMode: "codex:never",
        credentialSource: "native-account-or-settings",
        credentialEnvNames: [],
        attemptId: "attempt:codex",
        contractDigest: digestB,
        outcome: "finished",
        summaryDigest: digestA,
        summaryLength: 80,
        nonceEchoed: true,
        headEchoed: true,
        observationCount: 2,
        boardState: "verifying",
        violationCount: 0,
        artifactCount: 0,
        evidenceCount: 0,
        workspaceBefore: digestA,
        workspaceAfter: digestA,
        workspaceUnchanged: true,
      },
      {
        workerId: "worker:claude",
        product: "claude-code",
        productVersion: "2.1.220",
        authorityMode: "claude-code:plan",
        credentialSource: "explicit-env",
        credentialEnvNames: ["ANTHROPIC_API_KEY"],
        attemptId: "attempt:claude",
        contractDigest: digestB,
        outcome: "finished",
        summaryDigest: digestB,
        summaryLength: 84,
        nonceEchoed: true,
        headEchoed: true,
        observationCount: 2,
        boardState: "verifying",
        violationCount: 0,
        artifactCount: 0,
        evidenceCount: 0,
        workspaceBefore: digestA,
        workspaceAfter: digestA,
        workspaceUnchanged: true,
      },
    ],
  };
}

test("the dual-product operator proof accepts the exact read-only success state", () => {
  const evaluation = evaluateDshProductOperatorProof(proof());
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failures, []);
});

test("a failed worker cannot be hidden by a verifying-looking receipt", () => {
  const value = proof();
  value.workers[0]!.outcome = "failed";
  const evaluation = evaluateDshProductOperatorProof(value);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join("; "), /worker:codex ended with failed/);
});

test("workspace mutation fails both source and per-worker proof", () => {
  const value = proof();
  value.source.workspaceAfter = digestB;
  value.source.workspaceUnchanged = false;
  value.workers[1]!.workspaceAfter = digestB;
  value.workers[1]!.workspaceUnchanged = false;
  const evaluation = evaluateDshProductOperatorProof(value);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join("; "), /source workspace changed/);
  assert.match(evaluation.failures.join("; "), /worker:claude changed/);
});

test("the proof rejects missing nonce, HEAD, and Board transition evidence", () => {
  const value = proof();
  value.workers[1]!.nonceEchoed = false;
  value.workers[1]!.headEchoed = false;
  value.workers[1]!.boardState = "failed";
  value.workers[1]!.observationCount = 1;
  const evaluation = evaluateDshProductOperatorProof(value);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join("; "), /exact proof nonce/);
  assert.match(evaluation.failures.join("; "), /exact repository HEAD/);
  assert.match(evaluation.failures.join("; "), /instead of verifying/);
  assert.match(evaluation.failures.join("; "), /fewer than two/);
});

test("duplicate routes cannot substitute for the required two-product proof", () => {
  const value = proof();
  value.workers[1] = { ...value.workers[0]!, attemptId: "attempt:codex:duplicate" };
  const evaluation = evaluateDshProductOperatorProof(value);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join("; "), /duplicate worker proof/);
  assert.match(evaluation.failures.join("; "), /missing worker proof for worker:claude/);
});
