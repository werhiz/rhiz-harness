import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultPolicyOracle,
  guardPolicyFromWorkContract,
  parseGuardRequest,
} from "../src/guard.js";
import type { AuthorityPolicy } from "../src/schemas.js";
import { work } from "./helpers.js";

function request(
  toolName: string,
  category: "write" | "shell" | "network" = "write",
) {
  return parseGuardRequest({
    requestId: `request:${toolName}`,
    workId: "work:1",
    taskId: "task:1",
    attemptId: "attempt:1",
    actor: { id: "agent:worker", kind: "agent" },
    tool: {
      name: toolName,
      category,
      args: {
        paths: ["src/example.ts"],
        boundary: "already-validated-by-provider-adapter",
      },
    },
    writeScope: "workspace",
    contextHash: "context:contract-authority",
    evidenceRefs: [],
    timestampMs: 1_700_000_000_000,
  });
}

function writeAuthority(requiresHumanApproval: boolean = false): AuthorityPolicy {
  return {
    grants: [
      {
        action: "write",
        resources: [{ uri: "repo://example/src", kind: "directory" }],
        constraints: [],
      },
    ],
    requiresHumanApproval: requiresHumanApproval ? ["write"] : [],
  };
}

function contractBoundPolicy(authority: AuthorityPolicy = writeAuthority()) {
  return guardPolicyFromWorkContract(
    work({ authority }),
    { contractBoundCategoryAuthority: true },
  );
}

test("Work write authority remains dormant until the execution seam proves contract-bound containment", async () => {
  const policy = guardPolicyFromWorkContract(work({ authority: writeAuthority() }));
  const oracle = createDefaultPolicyOracle(policy);
  const verdict = await oracle.evaluate(request("codex:file-change"), policy);
  assert.equal(verdict.decision, "forbid");
});

test("contract-bound Work write authority applies to the portable write category, not provider tool names", async () => {
  const policy = contractBoundPolicy();
  const oracle = createDefaultPolicyOracle(policy);

  for (const toolName of ["codex:file-change", "claude:edit-file", "future-provider:patch"]) {
    const verdict = await oracle.evaluate(request(toolName), policy);
    assert.equal(
      verdict.decision,
      "allow",
      `${toolName} should inherit the Work's write authority through category=write once the execution boundary is proven`,
    );
  }
});

test("absent Work write authority keeps an otherwise identical contract-bound write request forbidden", async () => {
  const policy = contractBoundPolicy({
    grants: [{ action: "read", resources: [{ uri: "repo://example", kind: "repository" }], constraints: [] }],
    requiresHumanApproval: [],
  });
  const oracle = createDefaultPolicyOracle(policy);

  const verdict = await oracle.evaluate(request("codex:file-change"), policy);
  assert.equal(verdict.decision, "forbid");
});

test("contract-bound Work write authority requiring human approval remains a prompt at the policy layer", async () => {
  const policy = contractBoundPolicy(writeAuthority(true));
  const oracle = createDefaultPolicyOracle(policy);

  const verdict = await oracle.evaluate(request("codex:file-change"), policy);
  assert.equal(verdict.decision, "prompt");
});

test("contract-bound write authority does not leak into shell or network categories", async () => {
  const policy = contractBoundPolicy();
  const oracle = createDefaultPolicyOracle(policy);

  const shell = await oracle.evaluate(request("codex:command", "shell"), policy);
  const network = await oracle.evaluate(request("codex:network", "network"), policy);

  assert.equal(shell.decision, "forbid");
  assert.equal(network.decision, "forbid");
});
