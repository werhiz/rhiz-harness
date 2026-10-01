import { DigestScopeSchema } from "../workspace-digest.js";
import { z } from "zod";
import { ActorRefSchema, EvidenceKindSchema, EvidenceRefSchema, FalsifiabilityReportSchema, TimestampSchema, WorkContractSchema, WorkStateSchema } from "../schemas.js";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1);
const digest = z.string().trim().min(1).max(300);

export const VerificationTargetSchema = z.object({
  workspaceId: id,
  uri: text.max(2048),
  head: text.max(300),
  digest,
  /**
   * The coverage of `digest`, carried into every receipt. A reader can then see
   * exactly which bytes the attestation speaks for, instead of inferring that it
   * speaks for all of them. See issue #10.
   */
  digestScope: DigestScopeSchema,
  changedPaths: z.array(text.max(4096)),
}).strict();
export type VerificationTarget = z.infer<typeof VerificationTargetSchema>;

/**
 * What a negative control deliberately breaks.
 *
 * A control exists to show that a check can distinguish a known failure from a
 * pass. That is only demonstrated if something is actually broken and the check
 * actually notices, so the perturbation is part of the contract rather than an
 * optional courtesy. It is recorded in the receipt so a reader can see exactly
 * what was falsified. See issue #13.
 */
export const NegativeControlPerturbationSchema = z.object({
  /** Human-readable statement of what is broken and why the check should notice. */
  description: text.max(1000),
  /**
   * v0 supports one mechanism. A new mechanism must add a literal here rather
   * than widening this one, so a receipt never has to guess what was done.
   */
  kind: z.literal("overwrite-file"),
  /** Path inside the ISOLATED copy. Never applied to the canonical target. */
  path: text.max(4096),
  content: z.string().max(64 * 1024),
}).strict().superRefine((value, ctx) => {
  const path = value.path;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "perturbation path must be relative to the execution root" });
  }
  if (path.split(/[\\/]/).includes("..")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "perturbation path may not escape the execution root" });
  }
  if (path.includes("\u0000")) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "perturbation path must not contain NUL" });
  }
});
export type NegativeControlPerturbation = z.infer<typeof NegativeControlPerturbationSchema>;

export const VerificationCheckSchema = z.object({
  id,
  providerId: id,
  description: text.max(1000),
  criterionIds: z.array(id).default([]),
  requirementIds: z.array(id).default([]),
  negativeControlFor: id.optional(),
  /** Required on a negative control, forbidden on a primary check. */
  perturbation: NegativeControlPerturbationSchema.optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.criterionIds).size !== value.criterionIds.length) {
    ctx.addIssue({ code: "custom", path: ["criterionIds"], message: "criterion ids must be unique within a verification check" });
  }
  if (new Set(value.requirementIds).size !== value.requirementIds.length) {
    ctx.addIssue({ code: "custom", path: ["requirementIds"], message: "requirement ids must be unique within a verification check" });
  }
  if (value.negativeControlFor !== undefined && (value.criterionIds.length > 0 || value.requirementIds.length > 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["negativeControlFor"],
      message: "negative controls cannot directly satisfy Work criteria or evidence requirements",
    });
  }
  // A control with nothing broken is the vacuous case issue #13 exists to kill:
  // it ran the same check against the same bytes and called agreement evidence.
  if (value.negativeControlFor !== undefined && value.perturbation === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["perturbation"],
      message: "a negative control must declare the perturbation it expects the check to detect",
    });
  }
  if (value.negativeControlFor === undefined && value.perturbation !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["perturbation"],
      message: "only a negative control may declare a perturbation",
    });
  }
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const VerificationPlanSchema = z.object({
  id,
  workId: id,
  contractRevision: z.number().int().positive(),
  checks: z.array(VerificationCheckSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const byId = new Map<string, VerificationCheck>();
  for (const [index, check] of value.checks.entries()) {
    if (byId.has(check.id)) ctx.addIssue({ code: "custom", path: ["checks", index, "id"], message: `duplicate verification check id ${check.id}` });
    byId.set(check.id, check);
  }
  for (const [index, check] of value.checks.entries()) {
    if (check.negativeControlFor === undefined) continue;
    const target = byId.get(check.negativeControlFor);
    if (!target) {
      ctx.addIssue({ code: "custom", path: ["checks", index, "negativeControlFor"], message: `negative-control target ${check.negativeControlFor} does not exist` });
    } else if (target.negativeControlFor !== undefined) {
      ctx.addIssue({ code: "custom", path: ["checks", index, "negativeControlFor"], message: "negative controls cannot target another negative control" });
    } else if (target.providerId !== check.providerId) {
      ctx.addIssue({ code: "custom", path: ["checks", index, "providerId"], message: "a negative control must exercise the same VerifierProvider as its primary check" });
    } else if (JSON.stringify(target.config) !== JSON.stringify(check.config)) {
      // Sharing a provider is not enough. Without this, a control may run a
      // DIFFERENT check, fail for its own unrelated reasons, and report itself
      // falsified while the primary cannot fail at all.
      //
      // Demonstrated on this branch before the rule existed: primary
      // `/usr/bin/true` with control `/usr/bin/false` produced a PASSING receipt
      // and left Board `ready`. That is the vacuous pass issue #13 exists to
      // kill, wearing a perturbation as a costume.
      //
      // A control is "the same check against deliberately broken bytes", never
      // "some other check that failed". Only id, description,
      // negativeControlFor and perturbation may differ.
      ctx.addIssue({
        code: "custom",
        path: ["checks", index, "config"],
        message: "a negative control must use the same config as its primary check; only the perturbation may differ",
      });
    }
  }
});
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;

export const VerifierDescriptorSchema = z.object({
  id,
  displayName: text.max(200),
  description: text.max(2000),
  deterministic: z.boolean(),
  readOnly: z.boolean(),
  evidenceKinds: z.array(EvidenceKindSchema).min(1),
}).strict();
export type VerifierDescriptor = z.infer<typeof VerifierDescriptorSchema>;

export const VerificationCheckResultSchema = z.object({
  checkId: id,
  providerId: id,
  status: z.enum(["pass", "fail", "error"]),
  summary: text.max(4000),
  evidence: z.array(EvidenceRefSchema),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "verification check time cannot run backwards" });
  }
});
export type VerificationCheckResult = z.infer<typeof VerificationCheckResultSchema>;

export const VerificationReceiptSchema = z.object({
  schema: z.literal("rhiz/verification-receipt/v1"),
  verificationId: id,
  verificationStartedEventId: id,
  verificationResultEventId: id,
  streamId: id,
  workId: id,
  contractRevision: z.number().int().positive(),
  verifier: ActorRefSchema,
  target: VerificationTargetSchema,
  status: z.enum(["pass", "fail"]),
  checks: z.array(VerificationCheckResultSchema),
  artifactIdentityEvidence: EvidenceRefSchema,
  /**
   * How much of the contract was mechanically falsifiable. Counts first, so a
   * reader sees "2 of 5 proven" without going looking. The categorical rule
   * below only catches total exemption; partial erosion is visible here or
   * nowhere, because nobody exempts everything in one commit.
   */
  falsifiability: FalsifiabilityReportSchema,
  boardState: WorkStateSchema,
  projectionViolationCount: z.number().int().nonnegative(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "verification receipt time cannot run backwards" });
  }
});
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;

export function validateVerificationPlan(plan: VerificationPlan, work: z.infer<typeof WorkContractSchema>, contractRevision: number): VerificationPlan {
  const parsedPlan = VerificationPlanSchema.parse(plan);
  const parsedWork = WorkContractSchema.parse(work);
  if (parsedPlan.workId !== parsedWork.id) throw new Error(`verification plan targets ${parsedPlan.workId}, expected ${parsedWork.id}`);
  if (parsedPlan.contractRevision !== contractRevision) throw new Error(`verification plan targets contract revision ${parsedPlan.contractRevision}, expected ${contractRevision}`);

  const criterionIds = new Set(parsedWork.acceptanceCriteria.map((criterion) => criterion.id));
  const requirementIds = new Set(parsedWork.requiredEvidence.map((requirement) => requirement.id));
  const coveredCriteria = new Set<string>();
  const coveredRequirements = new Set<string>();
  for (const check of parsedPlan.checks) {
    for (const criterionId of check.criterionIds) {
      if (!criterionIds.has(criterionId)) throw new Error(`verification check ${check.id} references unknown criterion ${criterionId}`);
      if (check.negativeControlFor === undefined) coveredCriteria.add(criterionId);
    }
    for (const requirementId of check.requirementIds) {
      if (!requirementIds.has(requirementId)) throw new Error(`verification check ${check.id} references unknown evidence requirement ${requirementId}`);
      if (check.negativeControlFor === undefined) coveredRequirements.add(requirementId);
    }
  }
  // A required criterion needs a check that CAN fail, not merely a check.
  //
  // Coverage was already enforced; provability was not, so a plan whose primary
  // check was /usr/bin/true satisfied every rule here and produced a passing
  // receipt. See issue #32. Falsifiability is established by a negative control
  // on the covering check, or waived by a named human on the contract.
  const exempted = new Map(
    parsedWork.verificationPolicy.falsifiabilityExemptions.map((item) => [item.criterionId, item] as const),
  );
  const controlledCheckIds = new Set(
    parsedPlan.checks
      .filter((check) => check.negativeControlFor !== undefined)
      .map((check) => check.negativeControlFor!),
  );
  for (const criterion of parsedWork.acceptanceCriteria) {
    if (!criterion.required) continue;
    if (!coveredCriteria.has(criterion.id)) throw new Error(`required acceptance criterion ${criterion.id} has no primary verification check`);
    if (exempted.has(criterion.id)) continue;
    const falsifiable = parsedPlan.checks.some(
      (check) => check.negativeControlFor === undefined
        && check.criterionIds.includes(criterion.id)
        && controlledCheckIds.has(check.id),
    );
    if (!falsifiable) {
      throw new Error(
        `required acceptance criterion ${criterion.id} is proven by a check with no negative control, so nothing establishes that check can detect a failure; `
        + "add a negative control, or record a falsifiability exemption on the Work contract naming a human",
      );
    }
  }
  for (const requirement of parsedWork.requiredEvidence) {
    if (requirement.required && !coveredRequirements.has(requirement.id)) throw new Error(`required evidence requirement ${requirement.id} has no primary verification check`);
  }
  return parsedPlan;
}

export function parseVerificationPlan(input: unknown): VerificationPlan {
  return VerificationPlanSchema.parse(input);
}

export function parseVerificationReceipt(input: unknown): VerificationReceipt {
  return VerificationReceiptSchema.parse(input);
}
