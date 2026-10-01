import { DurableEventLedger } from "../../adapters/local/durable-ledger.js";
import { event, work, worker } from "../helpers.js";

const directory = process.argv[2];
if (!directory) throw new Error("ledger directory argument is required");

const contract = work();
const streamId = "stream:work:1";
const taskId = "task:crash";
const attemptId = "attempt:crash";
const ledger = await DurableEventLedger.open({ directory, ledgerId: "ledger:crash-child" });

await ledger.append(event("work.created", { contract, revision: 1 }));
await ledger.append(event("task.created", { objective: contract.objective }, { taskId }));
await ledger.append(event("task.assigned", { worker }, { taskId }));
await ledger.append(event(
  "attempt.started",
  { worker, contractRevision: 1 },
  { taskId, attemptId, actor: worker },
));

process.stdout.write(`${JSON.stringify({ ready: true, streamId, taskId, attemptId, workId: contract.id })}\n`);
setInterval(() => undefined, 60_000);
