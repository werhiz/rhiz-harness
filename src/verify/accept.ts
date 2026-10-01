import { z } from "zod";
import { acceptanceReadiness, projectBoard } from "../board.js";
import type { CrewWorkspace, CrewWorkspaceProvider } from "../crew.js";
import { CrewWorkspaceSchema, CrewWorkspaceSnapshotSchema } from "../crew.js";
import type { EventLedger } from "../ledger.js";
import type { ActorRef, WorkContract, WorkState } from "../schemas.js";
import { ActorRefSchema, parseHarnessEvent, WorkContractSchema } from "../schemas.js";
import { VerificationReceiptSchema, type VerificationReceipt } from "./schema.js";
import { exactContract, sameTarget } from "./util.js";

export interface AcceptVerifiedWorkRequest {
  receipt: VerificationReceipt;
  work: WorkContract;
  ledger: EventLedger;
  workspace: CrewWorkspace;
  workspaceProvider: CrewWorkspaceProvider;
  actor: ActorRef;
  reason: string;
  now?: () => string;
  idFactory?: () => string;
}

export async function acceptVerifiedWork(request: AcceptVerifiedWorkRequest): Promise<WorkState> {
  const receipt = VerificationReceiptSchema.parse(request.receipt);
  const work = WorkContractSchema.parse(request.work);
  const workspace = CrewWorkspaceSchema.parse(request.workspace);
  const actor = ActorRefSchema.parse(request.actor);
  if (actor.kind !== "human") throw new Error(`actor ${actor.id} lacks human acceptance authority`);
  if (receipt.status !== "pass") throw new Error("failed verification cannot be accepted");
  if (receipt.workId !== work.id) throw new Error("verification receipt belongs to another Work item");
  if (receipt.boardState !== "ready") throw new Error("verification receipt did not leave Work ready for acceptance");
  if (workspace.workspaceId !== receipt.target.workspaceId) throw new Error("acceptance workspace does not match verification target");
  const current = CrewWorkspaceSnapshotSchema.parse(await request.workspaceProvider.snapshot(workspace));
  if (!sameTarget(current, receipt.target)) throw new Error("verified target changed before acceptance");

  const before = projectBoard(await request.ledger.replay(receipt.streamId));
  if (before.contractRevision !== receipt.contractRevision || !before.contract || !exactContract(before.contract, work)) throw new Error("canonical Work changed after verification");
  if (!before.verifications.some((verification) => verification.eventId === receipt.verificationResultEventId && verification.status === "pass" && verification.contractRevision === receipt.contractRevision)) {
    throw new Error("verification receipt is not present in the canonical Ledger stream");
  }
  const readiness = acceptanceReadiness(before);
  if (!readiness.ready) throw new Error(`Work is not ready for acceptance: ${readiness.reasons.join("; ")}`);

  const now = request.now ?? (() => new Date().toISOString());
  const idFactory = request.idFactory ?? (() => globalThis.crypto.randomUUID());
  const timestamp = now();
  await request.ledger.append(parseHarnessEvent({
    id: `event:acceptance:${idFactory()}`,
    type: "work.accepted",
    schemaVersion: 1,
    streamId: receipt.streamId,
    workId: work.id,
    actor,
    occurredAt: timestamp,
    recordedAt: timestamp,
    evidence: [receipt.artifactIdentityEvidence],
    payload: {
      reason: z.string().trim().min(1).max(2000).parse(request.reason),
      contractRevision: receipt.contractRevision,
    },
  }));
  const after = projectBoard(await request.ledger.replay(receipt.streamId));
  if (after.state !== "accepted" || after.violations.length !== before.violations.length) throw new Error("acceptance did not produce a clean accepted Board state");
  return after.state;
}
