import assert from "node:assert/strict";
import test from "node:test";
import { DshSdkWorkerProvider, type DshSdkClient } from "../adapters/dsh/index.js";
import type { WorkerStartRequest } from "../src/host.js";
import { boundWorkspace, work } from "./helpers.js";

function request(): WorkerStartRequest {
  const contract = work();
  return {
    work: contract,
    taskId: "task:summary-bound",
    attemptId: "attempt:summary-bound",
    objective: "Return a long but valid response",
    authority: contract.authority,
    workspace: boundWorkspace,
    context: contract.context,
  };
}

test("long DSH responses are bounded as summaries without converting success into failure", async () => {
  const client: DshSdkClient = {
    async run(_input, options) {
      return {
        sessionId: options?.sessionId ?? "session:summary-bound",
        finalResponse: "x".repeat(10000),
        events: [],
        notifications: [],
      };
    },
    async close() {},
  };
  const provider = new DshSdkWorkerProvider({ bindsWorkspace: true, getClient: async () => client });
  const handle = await provider.start(request());
  const result = await handle.result();
  assert.equal(result.status, "finished");
  assert.equal(result.summary.length, 4000);
});
