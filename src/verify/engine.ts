import { pathToFileURL } from "node:url";

import { evidenceSatisfiesRequirement, executionActorIds, projectBoard } from "../board.js";
import type { CrewWorkspace, CrewWorkspaceProvider, CrewWorkspaceSnapshot } from "../crew.js";
import { CrewWorkspaceSchema, CrewWorkspaceSnapshotSchema } from "../crew.js";
import type { EventLedger } from "../ledger.js";
import type { ActorRef, EvidenceRef, HarnessEvent, WorkContract, WorkState } from "../schemas.js";
import { ActorRefSchema, parseHarnessEvent, WorkContractSchema } from "../schemas.js";
import { VerifierCatalog, type VerifierProvider } from "./catalog.js";
import {
  VerificationCheckResultSchema,
  VerificationPlanSchema,
  VerificationReceiptSchema,
  VerifierDescriptorSchema,
  validateVerificationPlan,
  type VerificationCheckResult,
  type VerificationPlan,
  type VerificationReceipt,
  type VerifierDescriptor,
} from "./schema.js";
import { artifactIdentityEvidence, exactContract, safeError, sameTarget, targetFrom, uniqueEvidence } from "./util.js";
import { TempDirectoryDerivativeFactory } from "../disposable.js";
import { digestExecutionRoot } from "../workspace-digest.js";
import type { NegativeControlPerturbation, VerificationCheck } from "./schema.js";


/**
 * Run a negative control against a disposable derivative of the target.
 *
 * Three properties this must have, all of which the first implementation lacked
 * (issue #13):
 *
 *   1. Something is actually broken. The perturbation is declared in the plan
 *      and applied here.
 *   2. It is broken somewhere else.
 *   3. The check has to notice. The caller treats "underlying verifier
 *      reported fail" as the only outcome that satisfies the control.
 *
 * Property 2 used to be five lines of `mkdtemp`, `cp`, a hand-written prefix
 * check and an `rm` whose failure was swallowed by `.catch(() => undefined)`.
 * That is now `src/disposable.ts`, for the reasons issue #63 records: the
 * isolation belongs to the Harness rather than to whichever caller remembered to
 * write it, a perturbation path that escapes is refused by the one place that
 * knows where the derivative ends, and a derivative that survives cleanup is a
 * mutated copy of the target on disk — which the caller below turns into an
 * `error`, because a swallowed cleanup failure is how the residue goes unnoticed.
 */
async function runIsolatedControl(options: {
  provider: VerifierProvider;
  work: WorkContract;
  contractRevision: number;
  workspace: CrewWorkspace;
  check: VerificationCheck;
  perturbation: NegativeControlPerturbation;
  observedAt: string;
}): Promise<{ result: VerificationCheckResult; controlRoot: string }> {
  // Bound the copy BEFORE making it. digestExecutionRoot enforces entry-count,
  // per-file and total-byte limits and throws rather than truncating, so a tree
  // too large to identify is also a tree too large to duplicate per control.
  // Without this the copy was unbounded: gigabytes per control on any repository
  // with a real node_modules, two lines away from a function that fails closed.
  const sourceIdentity = await digestExecutionRoot(options.workspace.executionRoot);

  const factory = new TempDirectoryDerivativeFactory();
  const derivative = await factory.createFromRoot({
    sourceRoot: options.workspace.executionRoot,
    expectedDigest: sourceIdentity.digest,
    expectedFileCount: sourceIdentity.scope.fileCount,
  });
  const controlRoot = derivative.root;
  let result: VerificationCheckResult | null = null;
  let failure: unknown = null;
  try {
    // The perturbation resolves against the derivative root, and a path that
    // escapes it is refused there rather than here. That check is the reason a
    // control cannot perturb the artifact it is a control for.
    await derivative.mutate(options.perturbation.path, options.perturbation.content, options.perturbation.description);

    const identity = await digestExecutionRoot(controlRoot, {
      limits: {
        // The copy cannot legitimately exceed what the source measured.
        maxFiles: Math.max(1, sourceIdentity.scope.fileCount + 1),
      },
    });
    const controlWorkspace = CrewWorkspaceSchema.parse({
      ...options.workspace,
      workspaceId: `${options.workspace.workspaceId}:control:${options.check.id}`.slice(0, 200),
      uri: pathToFileURL(controlRoot).href,
      executionRoot: controlRoot,
      mode: "isolated-write",
    });
    const controlSnapshot = CrewWorkspaceSnapshotSchema.parse({
      workspaceId: controlWorkspace.workspaceId,
      head: options.workspace.baseRevision,
      digest: identity.digest,
      digestScope: identity.scope,
      changedPaths: [options.perturbation.path],
      observedAt: options.observedAt,
    });

    result = VerificationCheckResultSchema.parse(await options.provider.verify({
      work: options.work,
      contractRevision: options.contractRevision,
      workspace: controlWorkspace,
      target: targetFrom(controlWorkspace, controlSnapshot),
      check: options.check,
    }));
  } catch (error) {
    failure = error;
  }

  // Destruction is attempted on every path, and its failure is raised rather
  // than swallowed. A control whose derivative survived cannot pass however
  // convincingly the underlying verifier falsified: a deliberately broken copy
  // of the target is still sitting on disk. Throwing puts it on the caller's
  // existing error path, so the check becomes `error` rather than `pass`.
  //
  // This is deliberately NOT a `finally` containing the return. A `return`
  // inside `try` evaluates its object before `finally` runs, so a cleanup
  // outcome recorded there would always have been reported as its initial value.
  try {
    await factory.destroy(derivative);
  } catch (error) {
    if (failure !== null) throw new AggregateError([failure, error], "negative control failed and its derivative survived");
    throw error;
  }

  if (failure !== null) throw failure;
  return { result: result as VerificationCheckResult, controlRoot };
}

export interface VerificationEngineOptions {
  ledger: EventLedger;
  workspaceProvider: CrewWorkspaceProvider;
  verifierCatalog: VerifierCatalog;
  verifier: ActorRef;
  now?: () => string;
  idFactory?: () => string;
}

export interface VerifyWorkRequest {
  streamId: string;
  work: WorkContract;
  contractRevision: number;
  workspace: CrewWorkspace;
  expectedSnapshot: CrewWorkspaceSnapshot;
  plan: VerificationPlan;
}

interface PreparedVerifier {
  provider: VerifierProvider;
  descriptor: VerifierDescriptor;
}

export class VerificationEngine {
  readonly #ledger: EventLedger;
  readonly #workspaceProvider: CrewWorkspaceProvider;
  readonly #catalog: VerifierCatalog;
  readonly #verifier: ActorRef;
  readonly #now: () => string;
  readonly #idFactory: () => string;

  constructor(options: VerificationEngineOptions) {
    this.#ledger = options.ledger;
    this.#workspaceProvider = options.workspaceProvider;
    this.#catalog = options.verifierCatalog;
    this.#verifier = ActorRefSchema.parse(options.verifier);
    if (this.#verifier.kind !== "verifier" && this.#verifier.kind !== "human") throw new Error("Verify v1 requires a verifier or human actor");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  async verify(raw: VerifyWorkRequest): Promise<VerificationReceipt> {
    const work = WorkContractSchema.parse(raw.work);
    const workspace = CrewWorkspaceSchema.parse(raw.workspace);
    const expected = CrewWorkspaceSnapshotSchema.parse(raw.expectedSnapshot);
    const plan = validateVerificationPlan(VerificationPlanSchema.parse(raw.plan), work, raw.contractRevision);
    const boardBefore = projectBoard(await this.#ledger.replay(raw.streamId));
    if (!boardBefore.contract || boardBefore.workId !== work.id) throw new Error("verification stream does not contain the requested Work");
    if (!exactContract(boardBefore.contract, work)) throw new Error("verification WorkContract does not match the canonical Board contract");
    if (boardBefore.contractRevision !== raw.contractRevision) throw new Error("verification references a stale contract revision");
    if (boardBefore.state !== "verifying") throw new Error(`Work must be in verifying state, received ${boardBefore.state}`);
    if (executionActorIds(boardBefore).has(this.#verifier.id)) {
      throw new Error("an execution actor cannot verify its own Work");
    }

    const target = targetFrom(workspace, expected);
    const initial = CrewWorkspaceSnapshotSchema.parse(await this.#workspaceProvider.snapshot(workspace));
    if (!sameTarget(initial, target)) throw new Error("workspace changed before verification started");

    const prepared = new Map<string, PreparedVerifier>();
    for (const check of plan.checks) {
      if (prepared.has(check.providerId)) continue;
      const provider = this.#catalog.require(check.providerId);
      const descriptor = VerifierDescriptorSchema.parse(await provider.describe());
      if (descriptor.id !== provider.id) throw new Error(`verifier descriptor ${descriptor.id} does not match provider ${provider.id}`);
      if (!descriptor.deterministic) throw new Error(`Verify v1 refuses non-deterministic provider ${provider.id}`);
      if (!descriptor.readOnly) throw new Error(`Verify v1 refuses workspace-mutating provider ${provider.id}`);
      prepared.set(check.providerId, { provider, descriptor });
    }

    const identity = artifactIdentityEvidence(target);
    const verificationId = `verification:${this.#idFactory()}`;
    const startedEventId = `event:verification:${this.#idFactory()}`;
    const resultEventId = `event:verification:${this.#idFactory()}`;
    const startedAt = this.#now();
    const append = async (eventId: string, type: HarnessEvent["type"], payload: unknown, evidence: EvidenceRef[] = []) => {
      const timestamp = this.#now();
      await this.#ledger.append(parseHarnessEvent({
        id: eventId,
        type,
        schemaVersion: 1,
        streamId: raw.streamId,
        workId: work.id,
        actor: this.#verifier,
        occurredAt: timestamp,
        recordedAt: timestamp,
        evidence,
        payload,
      }));
    };

    await append(`event:artifact:${this.#idFactory()}`, "artifact.observed", {
      artifact: { uri: target.uri, kind: "artifact" },
      digest: target.digest,
    }, [identity]);
    await append(startedEventId, "verification.started", {
      verificationId,
      contractRevision: raw.contractRevision,
    }, [identity]);

    const results: VerificationCheckResult[] = [];
    let targetDrifted = false;
    for (const check of plan.checks) {
      let before: CrewWorkspaceSnapshot;
      try {
        before = CrewWorkspaceSnapshotSchema.parse(await this.#workspaceProvider.snapshot(workspace));
      } catch (error) {
        results.push(VerificationCheckResultSchema.parse({
          checkId: check.id,
          providerId: check.providerId,
          status: "error",
          summary: `verification target could not be read: ${safeError(error)}`,
          evidence: [identity],
          startedAt: this.#now(),
          finishedAt: this.#now(),
        }));
        targetDrifted = true;
        break;
      }
      if (!sameTarget(before, target)) {
        results.push(VerificationCheckResultSchema.parse({
          checkId: check.id,
          providerId: check.providerId,
          status: "error",
          summary: "verification target changed before this check",
          evidence: [identity],
          startedAt: this.#now(),
          finishedAt: this.#now(),
        }));
        targetDrifted = true;
        break;
      }

      const preparedVerifier = prepared.get(check.providerId)!;
      const checkStartedAt = this.#now();
      let result: VerificationCheckResult;
      try {
        if (check.negativeControlFor !== undefined) {
          // A control never touches the canonical target. It runs against an
          // isolated copy with a declared perturbation applied, and it counts as
          // satisfied ONLY when the underlying verifier reports that failure.
          // An always-passing verifier therefore fails its own control, which is
          // the whole point of issue #13.
          const perturbation = check.perturbation!;
          const { result: underlying } = await runIsolatedControl({
            provider: preparedVerifier.provider,
            work,
            contractRevision: raw.contractRevision,
            workspace,
            check,
            perturbation,
            observedAt: checkStartedAt,
          });
          const falsified = underlying.status === "fail";
          result = VerificationCheckResultSchema.parse({
            checkId: check.id,
            providerId: preparedVerifier.provider.id,
            status: falsified ? "pass" : "fail",
            summary: falsified
              ? `negative control satisfied: ${preparedVerifier.provider.id} reported fail against an isolated copy perturbed by ${perturbation.description}`
              : `negative control did not falsify: ${preparedVerifier.provider.id} reported ${underlying.status} against an isolated copy perturbed by ${perturbation.description}, so this check cannot distinguish a known failure`,
            // The identity of the canonical target is attached so a control can
            // never be a passing result carrying no evidence at all.
            evidence: uniqueEvidence([identity, ...underlying.evidence]),
            startedAt: checkStartedAt,
            finishedAt: this.#now(),
          });
          results.push(result);
          try {
            const afterControl = CrewWorkspaceSnapshotSchema.parse(await this.#workspaceProvider.snapshot(workspace));
            if (!sameTarget(afterControl, target)) {
              targetDrifted = true;
              results[results.length - 1] = VerificationCheckResultSchema.parse({
                ...result,
                status: "error",
                summary: "negative control changed the canonical target workspace",
                finishedAt: this.#now(),
              });
            }
          } catch (error) {
            targetDrifted = true;
            results[results.length - 1] = VerificationCheckResultSchema.parse({
              ...result,
              status: "error",
              summary: `verification target could not be re-read after a negative control: ${safeError(error)}`,
              finishedAt: this.#now(),
            });
          }
          if (targetDrifted) break;
          continue;
        }
        result = VerificationCheckResultSchema.parse(await preparedVerifier.provider.verify({
          work,
          contractRevision: raw.contractRevision,
          workspace,
          target,
          check,
        }));
        if (result.checkId !== check.id || result.providerId !== preparedVerifier.provider.id) throw new Error("VerifierProvider returned a result for the wrong check or provider");
        const unsupported = result.evidence.find((item) => !preparedVerifier.descriptor.evidenceKinds.includes(item.kind));
        if (unsupported) throw new Error(`VerifierProvider returned undeclared evidence kind ${unsupported.kind}`);
        if (result.status === "pass" && result.evidence.length === 0) {
          result = VerificationCheckResultSchema.parse({ ...result, status: "error", summary: "passing verifier check returned no evidence" });
        }
      } catch (error) {
        result = VerificationCheckResultSchema.parse({
          checkId: check.id,
          providerId: preparedVerifier.provider.id,
          status: "error",
          summary: `verifier check failed: ${safeError(error)}`,
          evidence: [],
          startedAt: checkStartedAt,
          finishedAt: this.#now(),
        });
      }

      try {
        const after = CrewWorkspaceSnapshotSchema.parse(await this.#workspaceProvider.snapshot(workspace));
        if (!sameTarget(after, target)) {
          targetDrifted = true;
          result = VerificationCheckResultSchema.parse({
            ...result,
            status: "error",
            summary: "verifier changed the exact target workspace",
            evidence: uniqueEvidence([...result.evidence, identity]),
            finishedAt: this.#now(),
          });
        }
      } catch (error) {
        targetDrifted = true;
        result = VerificationCheckResultSchema.parse({
          ...result,
          status: "error",
          summary: `verification target could not be re-read: ${safeError(error)}`,
          evidence: uniqueEvidence([...result.evidence, identity]),
          finishedAt: this.#now(),
        });
      }
      results.push(result);
      if (targetDrifted) break;
    }

    const byCheck = new Map(results.map((result) => [result.checkId, result] as const));
    const primary = plan.checks.filter((check) => check.negativeControlFor === undefined);
    const criterionResults = work.acceptanceCriteria.map((criterion) => {
      const checks = primary.filter((check) => check.criterionIds.includes(criterion.id));
      const bound = checks.map((check) => byCheck.get(check.id)).filter((result): result is VerificationCheckResult => result !== undefined);
      const status = checks.length === 0
        ? "not-evaluated" as const
        : bound.length !== checks.length || bound.some((result) => result.status !== "pass")
          ? "fail" as const
          : "pass" as const;
      return {
        criterionId: criterion.id,
        status,
        evidence: status === "pass" ? uniqueEvidence([identity, ...bound.flatMap((result) => result.evidence)]) : [],
      };
    });
    const evidenceSatisfaction = work.requiredEvidence.flatMap((requirement) => {
      const evidence = uniqueEvidence([
        ...primary.filter((check) => check.requirementIds.includes(requirement.id)).flatMap((check) => {
          const result = byCheck.get(check.id);
          return result?.status === "pass" ? result.evidence : [];
        }),
      ]).filter((item) => evidenceSatisfiesRequirement(requirement, item));
      return evidence.length === 0 ? [] : [{ requirementId: requirement.id, evidence }];
    });
    const criteriaPass = work.acceptanceCriteria.every((criterion) => !criterion.required || criterionResults.some((result) => result.criterionId === criterion.id && result.status === "pass"));
    const evidencePass = work.requiredEvidence.every((requirement) => {
      if (!requirement.required) return true;
      return evidenceSatisfaction.find((item) => item.requirementId === requirement.id)?.evidence.some((item) => evidenceSatisfiesRequirement(requirement, item)) === true;
    });
    // The falsifiability picture, computed from the plan that was validated.
    const exemptions = new Map(
      work.verificationPolicy.falsifiabilityExemptions.map((item) => [item.criterionId, item] as const),
    );
    const controlled = new Set(
      plan.checks.filter((check) => check.negativeControlFor !== undefined).map((check) => check.negativeControlFor!),
    );
    const requiredCriteria = work.acceptanceCriteria.filter((criterion) => criterion.required);
    const falsifiability = {
      provenCriteria: requiredCriteria
        .filter((criterion) => !exemptions.has(criterion.id))
        .filter((criterion) => primary.some(
          (check) => check.criterionIds.includes(criterion.id) && controlled.has(check.id),
        ))
        .map((criterion) => criterion.id),
      exemptedCriteria: requiredCriteria
        .filter((criterion) => exemptions.has(criterion.id))
        .map((criterion) => {
          const item = exemptions.get(criterion.id)!;
          return { criterionId: item.criterionId, reason: item.reason, authorizedBy: item.authorizedBy };
        }),
    };

    const allChecksPass = results.length === plan.checks.length && results.every((result) => result.status === "pass");
    const status = !targetDrifted && allChecksPass && criteriaPass && evidencePass ? "pass" as const : "fail" as const;
    await append(resultEventId, "verification.result", {
      verificationId,
      contractRevision: raw.contractRevision,
      status,
      criterionResults,
      evidenceSatisfaction,
      falsifiability,
    }, uniqueEvidence([identity, ...results.flatMap((result) => result.evidence)]));

    const boardAfter = projectBoard(await this.#ledger.replay(raw.streamId));
    // A verification in which nothing could have failed is an attestation, not a
    // verification, and cannot carry Work to ready on its own.
    const attestationOnly = falsifiability.provenCriteria.length === 0 && falsifiability.exemptedCriteria.length > 0;
    const expectedState: WorkState = status === "pass"
      ? (work.verificationPolicy.reviewRequired || attestationOnly) ? "reviewing" : "ready"
      : "verifying";
    if (boardAfter.state !== expectedState) throw new Error(`verification projected Board state ${boardAfter.state}, expected ${expectedState}`);
    return VerificationReceiptSchema.parse({
      schema: "rhiz/verification-receipt/v1",
      verificationId,
      verificationStartedEventId: startedEventId,
      verificationResultEventId: resultEventId,
      streamId: raw.streamId,
      workId: work.id,
      contractRevision: raw.contractRevision,
      verifier: this.#verifier,
      target,
      status,
      checks: results,
      artifactIdentityEvidence: identity,
      falsifiability,
      boardState: boardAfter.state,
      projectionViolationCount: boardAfter.violations.length,
      startedAt,
      finishedAt: this.#now(),
    });
  }
}
