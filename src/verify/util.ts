import type { CrewWorkspace, CrewWorkspaceSnapshot } from "../crew.js";
import type { EvidenceRef, WorkContract } from "../schemas.js";
import { EvidenceRefSchema } from "../schemas.js";
import { VerificationTargetSchema, type VerificationTarget } from "./schema.js";

export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 4000);
}

export function exactContract(left: WorkContract, right: WorkContract): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function targetFrom(workspace: CrewWorkspace, snapshot: CrewWorkspaceSnapshot): VerificationTarget {
  if (workspace.workspaceId !== snapshot.workspaceId) throw new Error("verification workspace and snapshot identities do not match");
  return VerificationTargetSchema.parse({
    workspaceId: workspace.workspaceId,
    uri: workspace.uri,
    head: snapshot.head,
    digest: snapshot.digest,
    digestScope: snapshot.digestScope,
    changedPaths: [...snapshot.changedPaths].sort(),
  });
}

export function sameTarget(snapshot: CrewWorkspaceSnapshot, target: VerificationTarget): boolean {
  return snapshot.workspaceId === target.workspaceId
    && snapshot.head === target.head
    && snapshot.digest === target.digest
    // Scope is compared, not assumed: a snapshot taken with a wider exclusion
    // list describes a different thing even when the aggregate happens to match.
    && JSON.stringify(snapshot.digestScope) === JSON.stringify(target.digestScope)
    && JSON.stringify([...snapshot.changedPaths].sort()) === JSON.stringify(target.changedPaths);
}

export function artifactIdentityEvidence(target: VerificationTarget): EvidenceRef {
  return EvidenceRefSchema.parse({
    id: `artifact-identity:${target.workspaceId}:${target.digest}`.slice(0, 200),
    kind: "artifact-identity",
    uri: target.uri,
    digest: target.digest,
  });
}

export function uniqueEvidence(evidence: readonly EvidenceRef[]): EvidenceRef[] {
  const byId = new Map<string, EvidenceRef>();
  for (const item of evidence) byId.set(item.id, EvidenceRefSchema.parse(item));
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}
