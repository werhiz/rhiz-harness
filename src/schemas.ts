import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const id = nonEmpty.max(200);
export const TimestampSchema = z.iso.datetime({ offset: true });

export const ActorKindSchema = z.enum(["human", "agent", "service", "automation", "verifier"]);
export const ActorRefSchema = z.object({
  id,
  kind: ActorKindSchema,
  displayName: nonEmpty.max(200).optional(),
}).strict();
export type ActorRef = z.infer<typeof ActorRefSchema>;

/** The portable, serializable record of a tool request Guard can evaluate. */
export const ToolCategorySchema = z.enum([
  "read",
  "write",
  "shell",
  "network",
  "credential",
  "external-mutate",
  "other",
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

export const GuardDecisionSchema = z.enum(["allow", "prompt", "forbid"]);
export type GuardDecision = z.infer<typeof GuardDecisionSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const GuardToolCallSchema = z.object({
  requestId: id,
  tool: z.object({
    name: id,
    category: ToolCategorySchema,
    args: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict();
export type GuardToolCall = z.infer<typeof GuardToolCallSchema>;

/**
 * What a durable record keeps about the arguments of a native tool call.
 *
 * Raw arguments are a file body, a diff, or a credential as often as they are a
 * path. They belong to the live authorization decision, not to an append-only
 * ledger that can never redact them, so evidence keeps the shape of the call
 * (which parameters, how large) plus a digest that correlates two records of
 * the same arguments without reproducing them.
 */
export const GuardToolArgsSummarySchema = z.object({
  keys: z.array(nonEmpty.max(200)).max(64),
  keyCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  digest: nonEmpty.max(200),
}).strict();
export type GuardToolArgsSummary = z.infer<typeof GuardToolArgsSummarySchema>;

const guardScope = {
  workId: id,
  taskId: id,
  attemptId: id,
  actor: ActorRefSchema,
  writeScope: z.enum(["none", "workspace", "unrestricted", "host-policy"]),
  contextHash: nonEmpty.max(300),
  evidenceRefs: z.array(id).default([]),
  timestampMs: z.number().int().nonnegative().max(8_640_000_000_000_000),
};

export const GuardRequestRecordSchema = z.object({
  requestId: id,
  tool: z.object({
    name: id,
    category: ToolCategorySchema,
    args: GuardToolArgsSummarySchema,
  }).strict(),
  ...guardScope,
}).strict();
export type GuardRequestRecord = z.infer<typeof GuardRequestRecordSchema>;

export const GuardRequestSchema = GuardToolCallSchema.extend({
  ...guardScope,
}).strict();
export type GuardRequest = z.infer<typeof GuardRequestSchema>;

export const GuardVerdictSchema = z.object({
  requestId: id,
  decision: GuardDecisionSchema,
  rationale: nonEmpty.max(4000),
  riskLevel: RiskLevelSchema,
  ruleHits: z.array(nonEmpty.max(500)).default([]),
  policyBackend: nonEmpty.max(200),
  policyBackendVersion: nonEmpty.max(200).optional(),
  evaluatedAt: TimestampSchema,
  durationMs: z.number().int().nonnegative(),
}).strict();
export type GuardVerdict = z.infer<typeof GuardVerdictSchema>;

const requestIdsMustMatch = (
  value: { request: { requestId: string }; verdict: { requestId: string } },
  ctx: z.RefinementCtx,
): void => {
  if (value.request.requestId !== value.verdict.requestId) {
    ctx.addIssue({
      code: "custom",
      path: ["verdict", "requestId"],
      message: "guard verdict requestId must match the evaluated request",
    });
  }
};

export const GuardEvaluationSchema = z.object({
  request: GuardRequestSchema,
  verdict: GuardVerdictSchema,
}).strict().superRefine(requestIdsMustMatch);
export type GuardEvaluation = z.infer<typeof GuardEvaluationSchema>;

/** The durable, bounded form of an evaluation. This is what evidence keeps. */
export const GuardEvaluationRecordSchema = z.object({
  request: GuardRequestRecordSchema,
  verdict: GuardVerdictSchema,
}).strict().superRefine(requestIdsMustMatch);
export type GuardEvaluationRecord = z.infer<typeof GuardEvaluationRecordSchema>;

export const ResourceKindSchema = z.enum([
  "repository",
  "directory",
  "file",
  "url",
  "service",
  "dataset",
  "artifact",
  "other",
]);
export const ResourceRefSchema = z.object({
  uri: nonEmpty.max(2048),
  kind: ResourceKindSchema.optional(),
}).strict();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const EvidenceKindSchema = z.enum([
  "test",
  "static-analysis",
  "browser",
  "review",
  "diff",
  "log",
  "screenshot",
  "receipt",
  "artifact-identity",
  "other",
]);
export const EvidenceRefSchema = z.object({
  id,
  kind: EvidenceKindSchema,
  uri: nonEmpty.max(2048).optional(),
  digest: nonEmpty.max(300).optional(),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const AuthorityActionSchema = z.enum([
  "read",
  "write",
  "execute",
  "approve",
  "publish",
  "spend",
  "external-mutate",
]);
export const AuthorityGrantSchema = z.object({
  action: AuthorityActionSchema,
  resources: z.array(ResourceRefSchema).default([]),
  constraints: z.array(nonEmpty.max(500)).default([]),
}).strict();
export const AuthorityPolicySchema = z.object({
  grants: z.array(AuthorityGrantSchema).default([]),
  requiresHumanApproval: z.array(AuthorityActionSchema).default([]),
}).strict();
export type AuthorityPolicy = z.infer<typeof AuthorityPolicySchema>;

export const AcceptanceCriterionSchema = z.object({
  id,
  description: nonEmpty.max(1000),
  required: z.boolean().default(true),
}).strict();
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const EvidenceRequirementSchema = z.object({
  id,
  description: nonEmpty.max(1000),
  acceptedKinds: z.array(EvidenceKindSchema).min(1),
  required: z.boolean().default(true),
}).strict();
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

export const ContextRequestSchema = z.object({
  strategy: z.enum(["minimal", "balanced", "broad", "explicit"]).default("minimal"),
  resources: z.array(ResourceRefSchema).default([]),
  includeHistory: z.boolean().default(true),
  tokenBudget: z.number().int().positive().optional(),
}).strict();

/**
 * An explicit, auditable human authorization for one exact worker provider.
 * Required before an undescribed or over-privileged provider may be selected.
 */
export const ProviderAuthorizationGrantSchema = z.object({
  providerId: nonEmpty.max(200),
  reason: nonEmpty.max(1000),
  authorizedBy: ActorRefSchema,
}).strict();

export const WorkerPolicySchema = z.object({
  preferredProviders: z.array(nonEmpty.max(200)).default([]),
  maxAttempts: z.number().int().positive().max(100).default(3),
  allowParallelAttempts: z.boolean().default(false),
  explicitProviderAuthorizations: z.array(ProviderAuthorizationGrantSchema).default([]),
  /**
   * Optional wall-clock budget for one Attempt in milliseconds. Crew turns
   * this into a deadline at attempt start and forces a non-recoverable
   * failure if the worker does not return in time (#16). If absent,
   * Crew derives a sensible default from the Work kind.
   */
  attemptBudgetMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000).optional(),
}).strict().superRefine((value, ctx) => {
  const ids = value.explicitProviderAuthorizations.map((item) => item.providerId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: "custom",
      path: ["explicitProviderAuthorizations"],
      message: "provider authorizations must name each provider at most once",
    });
  }
  for (const [index, item] of value.explicitProviderAuthorizations.entries()) {
    if (item.authorizedBy.kind !== "human") {
      ctx.addIssue({
        code: "custom",
        path: ["explicitProviderAuthorizations", index, "authorizedBy"],
        message: "only a human actor may authorize an unclassified worker provider",
      });
    }
  }
});

/**
 * Why a criterion may be accepted without a falsifiable check.
 *
 * A typed category rather than free text, because free text cannot be counted.
 * Four categories can be, and needing a fifth requires a schema change, which
 * is a conversation rather than a sentence. That is the property an exemption
 * wants: expensive enough to stay rare, cheap enough to stay honest.
 */
export const FalsifiabilityExemptionReasonSchema = z.enum([
  "external-receipt",     // the proof arrives from outside the workspace
  "static-analysis",      // no byte-level perturbation flips the result
  "browser-observation",  // the check observes a running surface
  "human-judgment",       // acceptance is a person's call, not a computation
]);
export type FalsifiabilityExemptionReason = z.infer<typeof FalsifiabilityExemptionReasonSchema>;

export const FalsifiabilityExemptionSchema = z.object({
  criterionId: id,
  reason: FalsifiabilityExemptionReasonSchema,
  justification: nonEmpty.max(1000),
  authorizedBy: ActorRefSchema,
}).strict();
export type FalsifiabilityExemption = z.infer<typeof FalsifiabilityExemptionSchema>;

export const VerificationPolicySchema = z.object({
  required: z.boolean().default(true),
  independentActor: z.boolean().default(true),
  reviewRequired: z.boolean().default(false),
  /**
   * Required criteria that may be proven by a check nothing can falsify. The
   * exemption is per-criterion and named by a human, so the decision has an
   * owner. It does not disappear once made: every receipt states which criteria
   * were proven falsifiably and which were exempted, because an exemption whose
   * off-state is invisible at acceptance is the defect this mechanism exists to
   * remove, one level up.
   */
  falsifiabilityExemptions: z.array(FalsifiabilityExemptionSchema).default([]),
}).strict().superRefine((value, ctx) => {
  const ids = value.falsifiabilityExemptions.map((item) => item.criterionId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: "custom",
      path: ["falsifiabilityExemptions"],
      message: "each criterion may be exempted at most once",
    });
  }
  for (const [index, item] of value.falsifiabilityExemptions.entries()) {
    if (item.authorizedBy.kind !== "human") {
      ctx.addIssue({
        code: "custom",
        path: ["falsifiabilityExemptions", index, "authorizedBy"],
        message: "only a human actor may exempt a criterion from falsifiable proof",
      });
    }
  }
});
export type VerificationPolicy = z.infer<typeof VerificationPolicySchema>;

export const WorkTypeSchema = z.enum(["SCOUT", "SHIP", "REVIEW"]);

/**
 * A string that originated from outside the contract — typically model-authored
 * worker output, free-text dependency reports, or any byte a downstream worker
 * must read as data rather than instruction.
 *
 * The brand is the enforcement: a `TaintedString` cannot be silently
 * concatenated into a contract-shaped instruction because `objective` carries
 * `nonEmpty.max(4000)`, not `TaintedString`. Adapters render tainted content
 * in fenced blocks under the provider's own untrusted-content rules.
 */
export const TaintedStringSchema = z.object({
  /** The text bytes, never to be trusted as instruction. */
  value: nonEmpty.max(4000),
  /** Where these bytes came from. The harness never fabricates provenance. */
  provenance: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("worker-report"),
      workId: id,
      workType: WorkTypeSchema,
      providerId: id.optional(),
    }).strict(),
    z.object({
      kind: z.literal("artifact-claim"),
      workId: id,
      artifactUri: nonEmpty.max(2048),
    }).strict(),
    z.object({
      kind: z.literal("error-message"),
      workId: id,
    }).strict(),
  ]),
}).strict();
export type TaintedString = z.infer<typeof TaintedStringSchema>;

/**
 * A single piece of data a downstream worker must read as data, not as
 * instruction. Carries provenance, a hard cap, and a label that survives into
 * durable storage and adapter rendering.
 */
export const TaintedAttachmentSchema = z.object({
  id,
  /** Stable label the adapter renders to identify the attachment. */
  label: z.enum(["dependency-report", "claimed-artifact", "error-message"]),
  source: TaintedStringSchema,
}).strict();
export type TaintedAttachment = z.infer<typeof TaintedAttachmentSchema>;

export const TAINTED_ATTACHMENT_MAX = 20;

const WorkContractBaseSchema = z.object({
  id,
  objective: nonEmpty.max(4000),
  type: WorkTypeSchema,
  scope: z.array(ResourceRefSchema).default([]),
  writeScope: z.array(ResourceRefSchema).default([]),
  nonGoals: z.array(nonEmpty.max(1000)).default([]),
  authority: AuthorityPolicySchema,
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  requiredEvidence: z.array(EvidenceRequirementSchema).default([]),
  context: ContextRequestSchema,
  dependencies: z.array(id).default([]),
  workerPolicy: WorkerPolicySchema,
  verificationPolicy: VerificationPolicySchema,
  createdBy: ActorRefSchema,
  createdAt: TimestampSchema,
}).strict();

export const WorkContractSchema = WorkContractBaseSchema.superRefine((value, ctx) => {
  if ((value.type === "SCOUT" || value.type === "REVIEW") && value.writeScope.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["writeScope"],
      message: `${value.type} work cannot carry production write scope`,
    });
  }
  if (new Set(value.acceptanceCriteria.map((criterion) => criterion.id)).size !== value.acceptanceCriteria.length) {
    ctx.addIssue({ code: "custom", path: ["acceptanceCriteria"], message: "criterion ids must be unique" });
  }
  if (new Set(value.requiredEvidence.map((requirement) => requirement.id)).size !== value.requiredEvidence.length) {
    ctx.addIssue({ code: "custom", path: ["requiredEvidence"], message: "evidence requirement ids must be unique" });
  }
  if (value.dependencies.includes(value.id)) {
    ctx.addIssue({ code: "custom", path: ["dependencies"], message: "work cannot depend on itself" });
  }
  const requiredCriteria = new Set(
    value.acceptanceCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id),
  );
  for (const [index, exemption] of value.verificationPolicy.falsifiabilityExemptions.entries()) {
    if (!requiredCriteria.has(exemption.criterionId)) {
      ctx.addIssue({
        code: "custom",
        path: ["verificationPolicy", "falsifiabilityExemptions", index, "criterionId"],
        message: `falsifiability exemption names ${exemption.criterionId}, which is not a required acceptance criterion of this Work`,
      });
    }
  }
  const hasRequiredProof =
    value.acceptanceCriteria.some((criterion) => criterion.required)
    || value.requiredEvidence.some((requirement) => requirement.required);
  if (hasRequiredProof && !value.verificationPolicy.required) {
    ctx.addIssue({
      code: "custom",
      path: ["verificationPolicy", "required"],
      message: "verification must be required when acceptance criteria or evidence requirements are required",
    });
  }
});
export type WorkContract = z.infer<typeof WorkContractSchema>;

export const WorkAmendmentSchema = z.object({
  objective: nonEmpty.max(4000).optional(),
  scope: z.array(ResourceRefSchema).optional(),
  writeScope: z.array(ResourceRefSchema).optional(),
  nonGoals: z.array(nonEmpty.max(1000)).optional(),
  authority: AuthorityPolicySchema.optional(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).optional(),
  requiredEvidence: z.array(EvidenceRequirementSchema).optional(),
  context: ContextRequestSchema.optional(),
  dependencies: z.array(id).optional(),
  workerPolicy: WorkerPolicySchema.optional(),
  // `verificationPolicy` is deliberately NOT amendable. It carries the verifier
  // registry, and the amendment path checks only that no lifecycle is active and
  // that the revision advances by one - never who the actor is. With the policy
  // amendable, an actor who did not write `work.created` could append
  // `work.amended`, install a registry naming itself, forge a verification under
  // that registry, and reach `accepted` with zero violations. The registry
  // authorized itself. Executed and reproduced, issue #62 family, 2026-08-24.
  //
  // The registry is therefore fixed at `work.created`. Changing who may verify
  // means creating new Work, which is the honest cost of changing that authority.
  // Note also that `authorizedBy.kind === "human"` is an AUDIT LABEL and not an
  // authorization: it is a self-declared field and a string comparison, so it
  // records a claim about who acted, never a permission to act.
}).strict().refine((value) => Object.keys(value).length > 0, "amendment must change at least one field");
export type WorkAmendment = z.infer<typeof WorkAmendmentSchema>;

export const CriterionResultSchema = z.object({
  criterionId: id,
  status: z.enum(["pass", "fail", "not-evaluated"]),
  evidence: z.array(EvidenceRefSchema).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.status === "pass" && value.evidence.length === 0) {
    ctx.addIssue({ code: "custom", path: ["evidence"], message: "passing criterion requires evidence" });
  }
});

export const EvidenceSatisfactionSchema = z.object({
  requirementId: id,
  evidence: z.array(EvidenceRefSchema).min(1),
}).strict();

export const HarnessEventBaseSchema = z.object({
  id,
  schemaVersion: z.literal(1),
  streamId: id,
  workId: id,
  taskId: id.optional(),
  attemptId: id.optional(),
  actor: ActorRefSchema,
  occurredAt: TimestampSchema,
  recordedAt: TimestampSchema,
  evidence: z.array(EvidenceRefSchema).default([]),
  causationId: id.optional(),
  correlationId: id.optional(),
}).strict();

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return HarnessEventBaseSchema.extend({ type: z.literal(type), payload });
}

const WorkCreatedPayloadSchema = z.object({ contract: WorkContractSchema, revision: z.literal(1) }).strict();
const WorkAmendedPayloadSchema = z.object({
  changes: WorkAmendmentSchema,
  revision: z.number().int().min(2),
  reason: nonEmpty.max(1000),
}).strict();
const TaskCreatedPayloadSchema = z.object({
  objective: nonEmpty.max(2000),
  attachmentIds: z.array(id).max(TAINTED_ATTACHMENT_MAX).optional(),
}).strict();
const TaskAssignedPayloadSchema = z.object({
  worker: ActorRefSchema,
  /**
   * Present only when a human exception admitted this provider past authority
   * classification. Without it on the event, replay cannot reconstruct that an
   * exception was used, so the decision is auditable at the moment it is made
   * and unrecoverable the instant the process ends. Constitution §5.
   */
  authorization: ProviderAuthorizationGrantSchema.optional(),
}).strict();

/**
 * Canonical form of a logical path claim: separators unified, empty and `.`
 * segments dropped, and `..` resolved so equivalent claims compare equal.
 */
export function normalizeLogicalPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** A logical resource a write-capable Attempt claims while it holds a lease. */
export const LogicalResourceClaimSchema = z.object({
  kind: z.enum(["path", "module", "command", "schema", "route", "feature"]),
  resource: nonEmpty.max(2048),
}).strict().superRefine((value, ctx) => {
  if (value.kind !== "path") return;
  const normalized = normalizeLogicalPath(value.resource);
  if (normalized === ".." || normalized.startsWith("../")) {
    ctx.addIssue({
      code: "custom",
      path: ["resource"],
      message: "a logical path claim must stay within the workspace root",
    });
  }
});
export type LogicalResourceClaim = z.infer<typeof LogicalResourceClaimSchema>;

/** A revocable, bounded lease for one Attempt and its logical write scope. */
export const AttemptLeaseSchema = z.object({
  id,
  workspaceId: id,
  resourceClaims: z.array(LogicalResourceClaimSchema).min(1),
  acquiredAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "attempt lease must expire after acquisition" });
  }
  const claims = value.resourceClaims.map((claim) => `${claim.kind}:${claim.resource}`);
  if (new Set(claims).size !== claims.length) {
    ctx.addIssue({ code: "custom", path: ["resourceClaims"], message: "attempt lease resource claims must be unique" });
  }
});
export type AttemptLease = z.infer<typeof AttemptLeaseSchema>;

const AttemptStartedPayloadSchema = z.object({
  worker: ActorRefSchema,
  contractRevision: z.number().int().positive(),
  lease: AttemptLeaseSchema.optional(),
}).strict();
const AttemptLeaseTransferredPayloadSchema = z.object({
  fromLeaseId: id,
  worker: ActorRefSchema,
  lease: AttemptLeaseSchema,
  reason: nonEmpty.max(2000),
}).strict().superRefine((value, ctx) => {
  if (value.fromLeaseId === value.lease.id) {
    ctx.addIssue({ code: "custom", path: ["lease", "id"], message: "attempt takeover must mint a new lease identity" });
  }
});
const AttemptActivityPayloadSchema = z.object({
  state: z.enum(["working", "idle", "waiting", "unknown"]),
  detail: nonEmpty.max(1000).optional(),
  source: nonEmpty.max(200),
  authority: z.literal("observation"),
}).strict();
const AttemptBlockedPayloadSchema = z.object({ reason: nonEmpty.max(1000), decisionId: id.optional() }).strict();
const AttemptFinishedPayloadSchema = z.object({ resultSummary: nonEmpty.max(2000), artifactRefs: z.array(ResourceRefSchema).default([]) }).strict();
const AttemptFailedPayloadSchema = z.object({ reason: nonEmpty.max(2000), recoverable: z.boolean().default(true) }).strict();
const AuthorityPayloadSchema = z.object({ policy: AuthorityPolicySchema, reason: nonEmpty.max(1000).optional() }).strict();
const GuardEvaluatedPayloadSchema = GuardEvaluationRecordSchema;
const ArtifactPayloadSchema = z.object({ artifact: ResourceRefSchema, digest: nonEmpty.max(300).optional() }).strict();
const DecisionRequestedPayloadSchema = z.object({ decisionId: id, question: nonEmpty.max(2000), choices: z.array(nonEmpty.max(1000)).default([]) }).strict();
const DecisionResolvedPayloadSchema = z.object({ decisionId: id, resolution: nonEmpty.max(2000) }).strict();
const VerificationStartedPayloadSchema = z.object({ verificationId: id, contractRevision: z.number().int().positive() }).strict();
export const FalsifiabilityReportSchema = z.object({
  /** Required criteria proven by a check with a satisfied negative control. */
  provenCriteria: z.array(id).default([]),
  /** Required criteria accepted without one, and who said so. */
  exemptedCriteria: z.array(z.object({
    criterionId: id,
    reason: FalsifiabilityExemptionReasonSchema,
    authorizedBy: ActorRefSchema,
  }).strict()).default([]),
}).strict();
export type FalsifiabilityReport = z.infer<typeof FalsifiabilityReportSchema>;

const VerificationResultPayloadSchema = z.object({
  verificationId: id,
  contractRevision: z.number().int().positive(),
  status: z.enum(["pass", "fail"]),
  criterionResults: z.array(CriterionResultSchema),
  evidenceSatisfaction: z.array(EvidenceSatisfactionSchema).default([]),
  /**
   * Present on every result. A reader of one event can see how much of the
   * contract was mechanically falsifiable without reading the plan.
   */
  falsifiability: FalsifiabilityReportSchema.default({ provenCriteria: [], exemptedCriteria: [] }),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.criterionResults.map((result) => result.criterionId)).size !== value.criterionResults.length) {
    ctx.addIssue({ code: "custom", path: ["criterionResults"], message: "verification result criterion ids must be unique" });
  }
  if (new Set(value.evidenceSatisfaction.map((result) => result.requirementId)).size !== value.evidenceSatisfaction.length) {
    ctx.addIssue({ code: "custom", path: ["evidenceSatisfaction"], message: "verification result requirement ids must be unique" });
  }
});
const ReviewStartedPayloadSchema = z.object({ reviewId: id, contractRevision: z.number().int().positive() }).strict();
const ReviewFindingPayloadSchema = z.object({ reviewId: id, severity: z.enum(["info", "low", "medium", "high", "critical"]), summary: nonEmpty.max(2000) }).strict();
const ReviewResultPayloadSchema = z.object({ reviewId: id, contractRevision: z.number().int().positive(), status: z.enum(["pass", "fail"]), summary: nonEmpty.max(2000) }).strict();
const WorkDecisionPayloadSchema = z.object({ reason: nonEmpty.max(2000), contractRevision: z.number().int().positive() }).strict();
const RouterDecisionPayloadSchema = z.object({
  decisionId: id,
  policy: z.enum(["cheapest-capable", "fastest-capable", "highest-confidence", "balanced"]),
  selectedWorkerId: id.nullable(),
  consideredCount: z.number().int().nonnegative(),
  evidenceHash: id,
  expectedCostUsd: z.number().nonnegative(),
  expectedDurationMs: z.number().int().nonnegative(),
}).strict();

/** A Work owns one durable integration ref/head when Git integration is enabled. */
export const WorkIntegrationConfigurationSchema = z.object({
  ref: nonEmpty.max(500),
  head: nonEmpty.max(300),
  horizonPolicyId: nonEmpty.max(200),
  provisionalHorizon: z.literal(true),
}).strict();
export type WorkIntegrationConfiguration = z.infer<typeof WorkIntegrationConfigurationSchema>;

export const IntegrationCheckpointClassSchema = z.enum(["wip-rescue", "integration-candidate"]);
export type IntegrationCheckpointClass = z.infer<typeof IntegrationCheckpointClassSchema>;

export const IntegrationProofStateSchema = z.enum(["not-run", "passed", "failed", "stale"]);
export type IntegrationProofState = z.infer<typeof IntegrationProofStateSchema>;

export const IntegrationRemoteStatusSchema = z.enum(["local-only", "pushed", "push-failed"]);
export type IntegrationRemoteStatus = z.infer<typeof IntegrationRemoteStatusSchema>;

export const IntegrationEligibilitySchema = z.enum([
  "wip",
  "eligible",
  "queued",
  "integrating",
  "stale",
  "integrated",
  "conflict",
  "failed",
]);
export type IntegrationEligibility = z.infer<typeof IntegrationEligibilitySchema>;

export const IntegrationCheckpointSchema = z.object({
  id,
  class: IntegrationCheckpointClassSchema,
  parentIntegrationHead: nonEmpty.max(300),
  workspaceId: id,
  changedResources: z.array(LogicalResourceClaimSchema).min(1),
  head: nonEmpty.max(300),
  tree: nonEmpty.max(300),
  proofState: IntegrationProofStateSchema,
  proofHead: nonEmpty.max(300).optional(),
  verificationEventId: id.optional(),
  remoteRef: nonEmpty.max(500).optional(),
  remoteStatus: IntegrationRemoteStatusSchema.default("local-only"),
}).strict().superRefine((value, ctx) => {
  if (value.class === "wip-rescue") {
    if (value.remoteRef === undefined || !value.remoteRef.startsWith("refs/rhiz/rescue/")) {
      ctx.addIssue({ code: "custom", path: ["remoteRef"], message: "WIP rescue checkpoints require a Harness-owned refs/rhiz/rescue/ ref" });
    }
    return;
  }
  if (value.proofState !== "passed" || value.proofHead !== value.head || value.verificationEventId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["proofState"],
      message: "an integration candidate requires passed verification bound to its exact checkpoint head",
    });
  }
});
export type IntegrationCheckpoint = z.infer<typeof IntegrationCheckpointSchema>;

export const IntegrationPullRequestSchema = z.object({
  id,
  url: z.url(),
  headRef: nonEmpty.max(500),
  status: z.enum(["draft", "open", "ready", "merged", "closed"]),
  splitDecisionId: id.optional(),
}).strict();
export type IntegrationPullRequest = z.infer<typeof IntegrationPullRequestSchema>;

export const IntegrationMergeAuthoritySchema = z.enum(["pending", "authorized", "denied"]);
export type IntegrationMergeAuthority = z.infer<typeof IntegrationMergeAuthoritySchema>;

export const IntegrationMergeStatusSchema = z.enum(["not-requested", "blocked", "ready", "merged", "failed"]);
export type IntegrationMergeStatus = z.infer<typeof IntegrationMergeStatusSchema>;

export const WorkExecutionObservationSchema = z.object({
  state: z.enum(["ready", "running", "blocked", "verifying", "parked", "failed"]),
  source: nonEmpty.max(200),
  observedAt: TimestampSchema,
}).strict();
export type WorkExecutionObservation = z.infer<typeof WorkExecutionObservationSchema>;

const WorkParkedPayloadSchema = z.object({ reason: nonEmpty.max(2000) }).strict();
const WorkReleasedPayloadSchema = z.object({ reason: nonEmpty.max(2000) }).strict();
const IntegrationInitializedPayloadSchema = z.object({ configuration: WorkIntegrationConfigurationSchema }).strict();
const IntegrationCheckpointRecordedPayloadSchema = z.object({ checkpoint: IntegrationCheckpointSchema }).strict();
const IntegrationExecutionObservedPayloadSchema = z.object({ observation: WorkExecutionObservationSchema }).strict();
const IntegrationCandidateQueuedPayloadSchema = z.object({ checkpointId: id }).strict();
const IntegrationLockAcquiredPayloadSchema = z.object({
  lockId: id,
  checkpointId: id,
  expectedHead: nonEmpty.max(300),
}).strict();
const IntegrationTaskReconciledPayloadSchema = z.discriminatedUnion("status", [
  z.object({
    checkpointId: id,
    previousBaseHead: nonEmpty.max(300),
    newBaseHead: nonEmpty.max(300),
    status: z.literal("clean"),
    head: nonEmpty.max(300),
    tree: nonEmpty.max(300),
    proofHead: nonEmpty.max(300),
    remoteRef: nonEmpty.max(500),
    preservedRefs: z.array(nonEmpty.max(500)).default([]),
  }).strict(),
  z.object({
    checkpointId: id,
    previousBaseHead: nonEmpty.max(300),
    newBaseHead: nonEmpty.max(300),
    status: z.literal("conflict"),
    preservedRefs: z.array(nonEmpty.max(500)).min(2),
    reason: nonEmpty.max(4000),
  }).strict(),
]);
const IntegrationHeadAdvancedPayloadSchema = z.object({
  lockId: id,
  checkpointId: id,
  previousHead: nonEmpty.max(300),
  head: nonEmpty.max(300),
  tree: nonEmpty.max(300),
  proofHead: nonEmpty.max(300),
  verificationEventId: id,
  remoteRef: nonEmpty.max(500),
}).strict();
const IntegrationFailedPayloadSchema = z.object({
  lockId: id.optional(),
  checkpointId: id,
  reason: nonEmpty.max(4000),
  semanticConflict: z.boolean().default(false),
  preservedRefs: z.array(nonEmpty.max(500)).default([]),
}).strict();
const IntegrationPullRequestAssociatedPayloadSchema = z.object({
  pullRequest: IntegrationPullRequestSchema,
}).strict();
const IntegrationMergeUpdatedPayloadSchema = z.object({
  authority: IntegrationMergeAuthoritySchema,
  status: IntegrationMergeStatusSchema,
  decisionId: id.optional(),
  detail: nonEmpty.max(4000),
}).strict();
const IntegrationCleanupRecordedPayloadSchema = z.object({
  disposition: z.enum(["integrated", "rescue-preserved", "discarded"]),
  checkpointId: id.optional(),
  authorityDecisionId: id.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.disposition === "discarded" && value.authorityDecisionId === undefined) {
    ctx.addIssue({ code: "custom", path: ["authorityDecisionId"], message: "discarded cleanup requires explicit authority" });
  }
});

export const RefinerProposalKindSchema = z.enum([
  "rule",
  "guard-tuning",
  "test",
  "verifier",
  "context-strategy",
  "routing-policy",
  "worker-profile",
  "tool",
  "capability",
  "documentation",
  "benchmark",
  "adr",
  "recovery-behavior",
  "lesson-fixture",
]);
export type RefinerProposalKind = z.infer<typeof RefinerProposalKindSchema>;

export const RefinerProposalStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "promoted",
]);
export type RefinerProposalStatus = z.infer<typeof RefinerProposalStatusSchema>;

export const RefinerEvidenceRefSchema = z.object({
  ledgerEventId: id,
  reasoning: nonEmpty.max(1000),
}).strict();
export type RefinerEvidenceRef = z.infer<typeof RefinerEvidenceRefSchema>;

export const RefinerDraftSchema = z.object({
  summary: nonEmpty.max(4000),
  rationale: nonEmpty.max(4000),
  reversibleUntil: z.iso.datetime({ offset: true }),
  draftPayload: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type RefinerDraft = z.infer<typeof RefinerDraftSchema>;

export const RefinerProposalSchema = z.object({
  id: id,
  workId: id,
  kind: RefinerProposalKindSchema,
  title: nonEmpty.max(200),
  summary: nonEmpty.max(4000),
  reasoning: nonEmpty.max(8000),
  classification: nonEmpty.max(64),
  evidenceRefs: z.array(RefinerEvidenceRefSchema).min(1),
  draft: RefinerDraftSchema,
  status: RefinerProposalStatusSchema,
  proposedBy: ActorRefSchema,
  proposedAt: TimestampSchema,
  supersedes: z.array(id).default([]),
}).strict();
export type RefinerProposal = z.infer<typeof RefinerProposalSchema>;

const RefinerProposedPayloadSchema = z.object({
  proposal: RefinerProposalSchema,
}).strict();
const RefinerAcceptedPayloadSchema = z.object({
  proposalId: id,
  workId: id,
  acceptedBy: ActorRefSchema,
  rationale: nonEmpty.max(2000),
}).strict();
const RefinerRejectedPayloadSchema = z.object({
  proposalId: id,
  workId: id,
  rejectedBy: ActorRefSchema,
  rationale: nonEmpty.max(2000),
}).strict();
const RefinerPromotedPayloadSchema = z.object({
  proposalId: id,
  workId: id,
  promotedBy: ActorRefSchema,
  appliedSurface: nonEmpty.max(500),
  irreversible: z.boolean().default(false),
}).strict();

/**
 * A ContextBridge produced a ContextPack for one Work. The pack itself
 * travels with the attempt; this event is the durable record that the
 * selection happened, with the identity (id, digest), shape (totalTokens,
 * fragmentCount, strategy), and task-class classification a replay needs
 * to reconstruct what was handed to the worker.
 */
const ContextPackSelectedPayloadSchema = z.object({
  packId: id,
  digest: nonEmpty.max(300),
  taskClass: z.enum(["scout", "ship", "review", "default"]),
  strategy: z.enum(["minimal", "balanced", "broad", "explicit"]),
  totalTokens: z.number().int().nonnegative(),
  fragmentCount: z.number().int().nonnegative(),
  markers: z.array(id),
}).strict();

const HarnessEventUnionSchema = z.discriminatedUnion("type", [
  event("work.created", WorkCreatedPayloadSchema),
  event("work.amended", WorkAmendedPayloadSchema),
  event("task.created", TaskCreatedPayloadSchema),
  event("task.assigned", TaskAssignedPayloadSchema),
  event("context.pack-selected", ContextPackSelectedPayloadSchema),
  event("attempt.started", AttemptStartedPayloadSchema),
  event("attempt.lease-transferred", AttemptLeaseTransferredPayloadSchema),
  event("attempt.activity-observed", AttemptActivityPayloadSchema),
  event("attempt.blocked", AttemptBlockedPayloadSchema),
  event("attempt.finished", AttemptFinishedPayloadSchema),
  event("attempt.failed", AttemptFailedPayloadSchema),
  event("authority.granted", AuthorityPayloadSchema),
  event("authority.denied", AuthorityPayloadSchema),
  event("guard.evaluated", GuardEvaluatedPayloadSchema),
  event("artifact.observed", ArtifactPayloadSchema),
  event("artifact.changed", ArtifactPayloadSchema),
  event("decision.requested", DecisionRequestedPayloadSchema),
  event("decision.resolved", DecisionResolvedPayloadSchema),
  event("verification.started", VerificationStartedPayloadSchema),
  event("verification.result", VerificationResultPayloadSchema),
  event("review.started", ReviewStartedPayloadSchema),
  event("review.finding", ReviewFindingPayloadSchema),
  event("review.result", ReviewResultPayloadSchema),
  event("work.accepted", WorkDecisionPayloadSchema),
  event("work.rejected", WorkDecisionPayloadSchema),
  event("work.cancelled", WorkDecisionPayloadSchema),
  event("work.parked", WorkParkedPayloadSchema),
  event("work.released", WorkReleasedPayloadSchema),
  event("integration.initialized", IntegrationInitializedPayloadSchema),
  event("integration.checkpoint-recorded", IntegrationCheckpointRecordedPayloadSchema),
  event("integration.candidate-queued", IntegrationCandidateQueuedPayloadSchema),
  event("integration.lock-acquired", IntegrationLockAcquiredPayloadSchema),
  event("integration.task-reconciled", IntegrationTaskReconciledPayloadSchema),
  event("integration.head-advanced", IntegrationHeadAdvancedPayloadSchema),
  event("integration.failed", IntegrationFailedPayloadSchema),
  event("integration.pull-request-associated", IntegrationPullRequestAssociatedPayloadSchema),
  event("integration.merge-updated", IntegrationMergeUpdatedPayloadSchema),
  event("integration.cleanup-recorded", IntegrationCleanupRecordedPayloadSchema),
  event("integration.execution-observed", IntegrationExecutionObservedPayloadSchema),
  event("refiner.proposed", RefinerProposedPayloadSchema),
  event("refiner.accepted", RefinerAcceptedPayloadSchema),
  event("refiner.rejected", RefinerRejectedPayloadSchema),
  event("refiner.promoted", RefinerPromotedPayloadSchema),
  event("router.decision-made", RouterDecisionPayloadSchema),
]);

export const HarnessEventSchema = HarnessEventUnionSchema.superRefine((value, ctx) => {
  if ((value.type === "task.created" || value.type === "task.assigned") && !value.taskId) {
    ctx.addIssue({ code: "custom", path: ["taskId"], message: `${value.type} requires taskId` });
  }
  if ((value.type.startsWith("attempt.") || value.type === "guard.evaluated") && (!value.taskId || !value.attemptId)) {
    if (!value.taskId) ctx.addIssue({ code: "custom", path: ["taskId"], message: `${value.type} requires taskId` });
    if (!value.attemptId) ctx.addIssue({ code: "custom", path: ["attemptId"], message: `${value.type} requires attemptId` });
  }
  if ((value.type === "integration.checkpoint-recorded" || value.type === "integration.task-reconciled" || value.type === "integration.cleanup-recorded") && (!value.taskId || !value.attemptId)) {
    if (!value.taskId) ctx.addIssue({ code: "custom", path: ["taskId"], message: `${value.type} requires taskId` });
    if (!value.attemptId) ctx.addIssue({ code: "custom", path: ["attemptId"], message: `${value.type} requires attemptId` });
  }
});
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;

export function parseWorkContract(input: unknown): WorkContract {
  return WorkContractSchema.parse(input);
}

export function parseHarnessEvent(input: unknown): HarnessEvent {
  return HarnessEventSchema.parse(input);
}

export const WorkStateSchema = z.enum([
  "proposed",
  "ready",
  "running",
  "blocked",
  "verifying",
  /**
   * Verification passed, but the Board cannot establish that a worker
   * actually authored the candidate. Not a failure of the work and not a
   * pass: a Work whose authorship is unproven is unfinished, and it must
   * never read as done. See `authorshipUnproven` in board.ts.
   */
  "unverifiable",
  "reviewing",
  "parked",
  "accepted",
  "rejected",
  "cancelled",
  "failed",
]);
export type WorkState = z.infer<typeof WorkStateSchema>;
