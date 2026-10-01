# Proof Admissibility 0.1 — NON-AUTHORITATIVE working design

> ## ⚠ This document is not authority. It is thinking, not law.
>
> **Status: unresolved working design. Known to be internally unsound in the ways listed below.**
>
> ADR 0021 records the settled doctrine. This document is the *attempted* executable form of it, and
> five rounds of exact-head review found real defects in it every round. It is kept in the
> repository because the reasoning is worth having, not because it is correct.
>
> - **Do not implement this as specified.** Do not cite it as a contract.
> - **Do not treat it as ADR 0021's normative annex.** The repository's authority order
>   (`decisions/README.md`) already ranks design documents below ADRs; this one sits there
>   deliberately.
> - Runtime admissibility enforcement **cannot ship** until the defects below are resolved by a
>   further ADR with its own review and its own guards.
>
> ### Known unsound, and not repaired here
>
> 1. **A declared probe arm can be omitted and the attestation still derive success.** When a
>    capability declares the optional `work` arm, an attestation carrying only `present` and
>    `control` results still derives `discriminated` — defeating the stated reason for the third arm.
>    A containment mechanism that blocks legitimate work can omit that failing observation and still
>    satisfy the capability.
> 2. **The program digest is not bound to program content.** §5 compares two independently writable
>    digest fields and defines neither a canonical digest recomputation nor a resolver guaranteeing
>    the returned bytes hash to the lookup key. A malformed bundle can keep the required digest while
>    changing `expectedOutcomes` to match its own receipt.
> 3. **Duplicate capability definitions are not rejected.** For a required set `{A, B}`, a bundle
>    carrying `[A, A]` satisfies the cardinality invariant while `B`'s definition is absent,
>    contradicting the closed-bundle claim.
> 4. **The state and invalidation table below still derives a verdict from a field this document
>    deletes.** §0.5 removes the stored `verdict`; the table appended at the end still names it.
>    Documentation drifting from design inside one document.
>
> Beyond those four, the schema, the reason vocabulary, the bundle shape, the event additions, the
> ledger-record change and the implementation order are all **unresolved**.
>
> ### Where the current defect list lives
>
> The exact-head reviews on PR #75 are the running enumeration of this document's known defects.
> They are recorded there rather than transcribed here, and they are **deliberately not repaired**:
> findings against this document confirm the label above rather than contradicting any authority, so
> chasing them re-enters the loop that demoting this document existed to end. A future ADR that
> resolves these mechanics should start from that list.

Companion to **ADR 0021**. Nothing here is implemented and nothing is enforced. No file under
`src/` is added by that ADR.

Why doc-only rather than `src/proof/*.ts`: landing unexercised types in the portable core produces
code no guard covers, which ADR 0016 records as invisible by construction. The types land with the
first behaviour that uses them.

Where the ten design questions of issue #73 are answered:

| # | question | answered by |
|---|---|---|
| 1 | who declares the property | ADR 0021 **D2**; `PropertyDefinition`, `PropertyCatalog` |
| 2 | how a property specifies required environment capabilities | **D3**; `PropertyDefinition.requiredCapabilities`, resolution rule |
| 3 | how the environment is attested rather than self-labelled | **D3 + D4**; `DiscriminatingProbe`, `EnvironmentAttestation` |
| 4 | how an executed falsifier is bound to that environment | **D5**; `EnvironmentSession`, `ExecutedFalsifier.sessionId` |
| 5 | how it binds to exact candidate identity | **D5/D6**; `CandidateIdentity` reused verbatim from `src/disposable.ts` |
| 6 | what invalidates a proof | **D1** + the invalidation table; `InadmissibleReason`, `UnknownReason` |
| 7 | how replay reconstructs admissibility | **D7**; `AdmissibilityBundle` closed and re-derived, append-stamped `origin`, no execution in projection |
| 8 | prepared program vs executed receipt vs admissible proof | **D6**; `ProofProgram` / `ProofExecution` / derived `AdmissibleProof` |
| 9 | provider claims without self-certification | **D4**; `CapabilityOffer` vs `EnvironmentAttestation` |
| 10 | how #62 binds producer/check identity without duplicating | **D8**; `EvidenceRef.producedBy: ProofExecutionRef` |

---

## 0. Reused unchanged

Nothing below redefines an existing type. These are imported:

- `CandidateIdentity`, `CandidateIdentitySchema`, `DisposableProofReceipt`,
  `DisposableProofEnvelopeSchema`, `AppliedMutation`, `InvalidationCode`, `InvalidationSchema`,
  `candidateIdentityDifferences` — `src/disposable.ts`
- `ActorRef`, `EvidenceRef`, `EvidenceKind`, `AcceptanceCriterion`, `WorkContract`, `TimestampSchema`
  — `src/schemas.ts`
- `NegativeControlPerturbation`, `VerificationTarget` — `src/verify/schema.ts`
- `SandboxPolicy`, `SandboxLauncher` — `src/sandbox.ts`

```ts
const id     = z.string().trim().min(1).max(200);
const text   = z.string().trim().min(1);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be a sha256 content digest");
/** `sha256:<hex>` over UTF-8 bytes — the same form `AppliedMutation.digest` records. */
declare function sha256(content: string): string;
```

---

## 0.5 Every field is an observation, a derivation, or a label

Four review rounds produced the same defect fourteen times, in fourteen different places: a summary
field — `proven`, `admissible`, `satisfied`, `discriminated`, a verdict, a boolean — was **accepted
as bundle input** rather than **derived from the recorded observations underneath it**. Patching each
one produced the next one. So the rule is structural, and it governs every schema in this document:

> **No summary, verdict, boolean, or status field in the durable bundle may be an input the
> derivation trusts.** Every one of them is computed from the recorded observations. Where the
> observations cannot support it, the value does not exist in v1.

Every field in this contract therefore sits in exactly one of three categories, and the category is
stated at the field:

| category | what it is | rule |
|---|---|---|
| **Observation** | recorded by the Harness at the moment it observed the thing, summarising nothing else in the bundle — `ProbeOutcome`, `CandidateIdentity`, `AppliedMutation`, timestamps, `origin` | may be consumed directly; these are the ground |
| **Derivation** | a conclusion about observations — arm satisfaction, attestation verdict, whether a receipt stands, which identity fields moved | **never stored as trusted input**; computed on every read |
| **Label** | carried for a human reader — `attestorId`, closure `reason`, every `description` | **never consumed by the derivation**, and said so at the field |

What that removed, in this pass:

- `ProbeArmResult.satisfied` — **deleted**. A conclusion about `observed`, stored beside it. Setting
  every boolean true passed the refinement while the recorded observations said the probe
  discriminated nothing.
- `EnvironmentAttestation.verdict` — **deleted** as a stored field, and computed by
  `attestationVerdict(arms, definition)`. It was a conclusion the derivation then read back as
  though it were evidence.
- `ProofExecution.candidateBinding` — **deleted**. An asserted classification of how the candidate
  was held that nothing corroborated and no step consumed.
- An `invalidated` `DisposableProofReceipt` — **cannot enter an execution**. See below; this is the
  one place a discriminant is required, and the reason it is not an exception to the rule.

Every remaining boolean, enum and literal in this document, so the next reviewer can audit the rule
instead of re-deriving it:

| field | category |
|---|---|
| `ProbeOutcome.exists` / `.resolves` / `.rows` / `.code` | observation — this *is* the measurement |
| `EnvironmentIdentity.recipeDigest` / `.hostFingerprint` | observation |
| `AttestationValidity.origin`, `AdmissibilityBundle.executionOrigin` | observation, stamped at append |
| `AttestationValidity.freshnessObservedAt` | observation (`null` = not observed) |
| `DisposableProofEnvelope.derivative.residualPath`, `.mutations` | observation |
| `AcceptanceCriterion.required`, `PropertyDefinition.requiredCapabilities`, `ProbeArm.expected`, `ProofProgram.expectedOutcomes` | declaration — the contract observations are compared *against* |
| `ProbeArmRole` | declaration |
| `AttestationVerdict` | **derivation** — computed by `attestationVerdict()`, never stored |
| arm satisfaction, receipt standing, candidate differences | **derivation** — no stored field exists |
| `DerivativeRecord.destroyed` | conclusion in a reused type; checked against `residualPath`, never read in its place |
| `CapabilityOffer.assurance`, `EnvironmentSessionClosure.reason`, `attestorId`, every `description` | label — never consumed |
| `InadmissibleReason`, `UnknownReason`, `Admissibility.verdict` | derivation **output**, not bundle input |

The single subtlety, stated because it looks like an exception. `DisposableProofReceipt` is a
discriminated union whose branches carry **different evidence**: `proven` has `result`, `invalidated`
has `invalidations` and no result at all. Requiring the `proven` branch is not trusting a status
flag beside the data — it is requiring that the evidence be present, and every fact inside it is
still recomputed. A status field on one shape would be the thing this rule forbids; a union that
withholds the conclusion on the failing branch is the thing ADR 0019 built on purpose.

---

## 1. Property

```ts
export const PropertyIdSchema = z.string().regex(
  /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
  "a property id is lower-kebab and must resolve in the PropertyCatalog",
).max(100);

/**
 * One property, declared once for the whole repository.
 *
 * Declared here rather than on a WorkContract because a contract that defines
 * the property it wants proven is the actor that wants acceptance authoring the
 * definition of proof. See ADR 0021 D2.
 */
export const PropertyDefinitionSchema = z.object({
  propertyId: PropertyIdSchema,
  /** What holds when this property holds. Prose, for a human; not parsed. */
  statement: text.max(2000),
  /** The defect class this property exists to make impossible. Names the incident. */
  defectClass: text.max(1000),
  /** Every id MUST resolve in the CapabilityCatalog, or this definition fails to parse. */
  requiredCapabilities: z.array(CapabilityIdSchema).min(1),
  /** The falsifier program that can refute this property, by content digest. */
  falsifierProgramDigest: digest,
  /** A human. A schema rule, NOT authentication — see ADR 0021 "What is NOT closed". */
  declaredBy: ActorRefSchema.refine((a) => a.kind === "human"),
  /** The ADR that governs this property. */
  adr: z.string().regex(/^\d{4}$/),
}).strict();

export interface PropertyCatalog {
  get(propertyId: string): PropertyDefinition | undefined;
  /** Digest over the whole catalog, recorded on executions so a redefinition is visible. */
  digest(): string;
}
```

**Citation, not definition.** The only change to the Work contract:

```ts
// src/schemas.ts — AcceptanceCriterionSchema gains ONE optional field
export const AcceptanceCriterionSchema = z.object({
  id,
  description: nonEmpty.max(1000),
  required: z.boolean().default(true),
  /** Cites a PropertyDefinition. A criterion may cite; it may never define. */
  property: PropertyIdSchema.optional(),
}).strict();
```

---

## 2. Capability, and the probe that *is* the capability

```ts
export const CapabilityIdSchema = z.string().regex(
  /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/,
  "a capability id is dotted lower-kebab and must resolve in the CapabilityCatalog",
).max(120);

/**
 * A typed observation of state. NEVER an exit code and never an exception.
 *
 * An exception proves that something failed. It does not prove that the boundary
 * refused: the measured `MacosSandboxExecLauncher.available()` returns true for a
 * launcher whose sandbox binary does not exist, because a spawn failure and a
 * denial are the same value to it.
 */
export const ProbeOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path-exists"),   path: text.max(4096), exists: z.boolean() }).strict(),
  z.object({ kind: z.literal("row-count"),     query: text.max(2000), rows: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("sqlstate"),      code: z.string().regex(/^[0-9A-Z]{5}$/) }).strict(),
  z.object({ kind: z.literal("module-resolves"), specifier: text.max(500), resolves: z.boolean() }).strict(),
  z.object({ kind: z.literal("absent"),        detail: text.max(500) }).strict(),
]);

export const ProbeArmRoleSchema = z.enum([
  /** Run in the candidate environment. Must produce the capability-specific outcome. */
  "present",
  /** Run in a deliberately capability-free control. Must produce the OPPOSITE outcome. */
  "control",
  /** Optional. The legitimate operation must still succeed. */
  "work",
]);

export const ProbeArmSchema = z.object({
  role: ProbeArmRoleSchema,
  /** How the environment for this arm is built, by content digest. Harness-owned. */
  fixtureRecipeDigest: digest,
  expected: ProbeOutcomeSchema,
}).strict();

/**
 * A capability is not a tag. It is a pair of executions with OPPOSITE required
 * outcomes, and if both arms agree the probe discriminates nothing.
 */
export const DiscriminatingProbeSchema = z.object({
  /** The probe program, content-addressed. Candidate-independent by construction. */
  programDigest: digest,
  arms: z.array(ProbeArmSchema).min(2).max(4),
}).strict().superRefine((value, ctx) => {
  const roles = value.arms.map((a) => a.role);
  const present = value.arms.find((a) => a.role === "present");
  const control = value.arms.find((a) => a.role === "control");
  if (present === undefined) {
    ctx.addIssue({ code: "custom", path: ["arms"], message: "a probe must have a present arm" });
  }
  // THE RULE. Without it this whole design is the defect one level up.
  if (control === undefined) {
    ctx.addIssue({
      code: "custom", path: ["arms"],
      message: "a probe with no control arm cannot discriminate: it proves the outcome happened, "
             + "not that the capability caused it",
    });
  }
  if (new Set(roles).size !== roles.length) {
    ctx.addIssue({ code: "custom", path: ["arms"], message: "each arm role appears at most once" });
  }
  // Compare expectations only once BOTH arms were found. A manifest supplying two
  // arms that are not these two — `control` plus `work`, say — has already had its
  // real error reported above; dereferencing a missing arm here would throw a
  // TypeError out of `parse()` instead of returning that structured failure, and
  // the missing-control guard reads the structured failure.
  if (present !== undefined && control !== undefined
      && JSON.stringify(present.expected) === JSON.stringify(control.expected)) {
    ctx.addIssue({
      code: "custom", path: ["arms"],
      message: "present and control arms expect the same outcome, so the probe distinguishes nothing",
    });
  }
});

export const CapabilityDefinitionSchema = z.object({
  capabilityId: CapabilityIdSchema,
  statement: text.max(2000),
  probe: DiscriminatingProbeSchema,
  declaredBy: ActorRefSchema.refine((a) => a.kind === "human"),
  adr: z.string().regex(/^\d{4}$/),
}).strict();

export interface CapabilityCatalog {
  get(capabilityId: string): CapabilityDefinition | undefined;
  digest(): string;
}
```

---

## 3. Offer vs attestation — the self-certification split

```ts
/**
 * What a PROVIDER says it can do. Routing input. Zero evidentiary weight.
 *
 * `RouterWorkerDescriptor.capabilityTags` (src/router.ts:31) becomes this.
 * Structurally incapable of entering an AdmissibleProof: nothing in
 * EnvironmentAttestation accepts a value of this type.
 */
export const CapabilityOfferSchema = z.object({
  capabilityId: CapabilityIdSchema,
  /** A LABEL, and the only value it can take. Structurally cannot enter a proof. */
  assurance: z.literal("advertised"),
  offeredBy: id,
}).strict();

export const EnvironmentIdentitySchema = z.object({
  environmentId: id,
  /** How the environment was built, by content digest. Moving it invalidates. */
  recipeDigest: digest,
  /** Platform / kernel / image fingerprint. Moving it invalidates. */
  hostFingerprint: text.max(500),
}).strict();

/**
 * One arm's RECORDED OBSERVATION. There is no `satisfied` boolean.
 *
 * A stored `satisfied: true` is a conclusion about `observed`, and a conclusion
 * stored beside its own evidence is exactly what this ADR refuses everywhere
 * else. It was also forgeable in one keystroke: set every boolean true and the
 * refinement passed while the recorded observations said the probe discriminated
 * nothing. Satisfaction is now computed from `observed` against the bundled
 * current `CapabilityDefinition`'s arm of the same role.
 */
export const ProbeArmResultSchema = z.object({
  role: ProbeArmRoleSchema,
  observed: ProbeOutcomeSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
}).strict();

/**
 * A DERIVED value, never a stored field. Computed from the recorded arms against
 * the capability definition, by `attestationVerdict()` below.
 */
export const AttestationVerdictSchema = z.enum([
  /** Every declared arm produced its expected outcome. The only admissible verdict. */
  "discriminated",
  /** The candidate environment behaved like the capability-free control. */
  "refuted",
  /** The arms did not distinguish anything, or an arm is missing. NEVER admissible. */
  "indeterminate",
]);

/**
 * The verdict, computed. Pure, and the only place a verdict is ever produced.
 */
export declare function attestationVerdict(
  arms: ReadonlyArray<ProbeArmResult>,
  definition: CapabilityDefinition,
): AttestationVerdict;
// present and control arms must both be recorded          -> otherwise indeterminate
// every recorded arm's `observed` equals its `expected`    -> discriminated
// the present arm observed what the CONTROL arm expects    -> refuted
// anything else                                            -> indeterminate

/**
 * What the HARNESS measured. Produced only by an EnvironmentProber the Harness
 * owns, running the catalog's program and reading the outcome itself.
 *
 * There is no field in which a provider states what the outcome was. That
 * absence is the answer to "how can an environment claim a capability without
 * self-certification": it cannot write the claim anywhere.
 */
export const EnvironmentAttestationSchema = z.object({
  schema: z.literal("rhiz/environment-attestation/v1"),
  attestationId: id,
  /** The session that produced it. An attestation does not outlive its session. */
  sessionId: id,
  /**
   * A DIAGNOSTIC LABEL. Carries no trust weight, because it is a caller-supplied
   * string and a hostile stream can copy any value into it. Provenance is decided
   * by `AttestationValidity`, which the payload cannot write. See ADR 0021 D7.
   */
  attestorId: id,
  capabilityId: CapabilityIdSchema,
  capabilityDefinitionDigest: digest,
  environment: EnvironmentIdentitySchema,
  probeProgramDigest: digest,
  arms: z.array(ProbeArmResultSchema).min(2),
  observedAt: TimestampSchema,
  /**
   * REQUIRED wall-clock cap (ADR 0021 ruling 1). Not optional: an optional TTL is
   * an attestation that outlives every replay, because an omitted field cannot
   * expire. The session lease bounds it further, and whichever comes first wins.
   */
  expiresAt: TimestampSchema,
}).strict().superRefine((value, ctx) => {
  // No verdict/satisfied cross-checks here any more: there is no stored verdict and
  // no stored satisfaction to cross-check. Both are computed against the bundled
  // capability definition, which this schema does not have and must not guess at.
  if (new Set(value.arms.map((a) => a.role)).size !== value.arms.length) {
    ctx.addIssue({
      code: "custom", path: ["arms"], message: "each arm role appears at most once",
    });
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({
      code: "custom", path: ["expiresAt"],
      message: "an attestation must expire strictly after it was observed",
    });
  }
  if (Date.parse(value.expiresAt) - Date.parse(value.observedAt) > MAX_ATTESTATION_TTL_MS) {
    ctx.addIssue({
      code: "custom", path: ["expiresAt"],
      message: `an attestation TTL may not exceed ${MAX_ATTESTATION_TTL_MS}ms; a longer cap is a `
             + "standing claim about an environment nobody re-measured",
    });
  }
});

/** The cap on ruling 1's cap. A catalog cannot raise it; only an ADR amendment can. */
export const MAX_ATTESTATION_TTL_MS = 24 * 60 * 60 * 1000;
```

**Origin needs a durable home, and it does not have one yet.** The append path is the only place
that knows how a record entered this store, but `HarnessEventBaseSchema` (`src/schemas.ts:278`) and
`LedgerRecordSchema` (`src/ledger.ts:17`) are both `.strict()` and neither has a field for it. Saying
"the append path stamps it" is not a design until the stamp has somewhere to live, so:

```ts
// src/ledger.ts — rhiz/ledger-record/v2 = v1 + this one field.
schema: z.literal("rhiz/ledger-record/v2"),
/**
 * How this record entered the store, decided BY THE APPEND PATH. Not on the
 * event: the event is the payload a writer controls, and this must be the one
 * thing a writer cannot choose.
 *
 * `recordDigest()` covers the whole unsigned record, and `previousDigest` chains
 * them, so once stamped this is protected by the same hash chain that protects
 * the events. Classification happens once, at a boundary; tampering with it
 * afterwards breaks the chain.
 */
origin: z.enum(["local", "imported"]),
```

Two consequences, both stated rather than assumed:

- **A v1 record has no origin, and absent is not `local`.** Assembly treats a record with no origin
  as not locally earned, which is the fail-closed reading. This costs nothing to migrate: no
  attestation or execution exists anywhere yet, and this ADR already records that nothing previously
  accepted counts as a property proof.
- **Origin does not reach assembly through the event stream.** `LedgerReader.read()` yields
  `record.event` (`adapters/local/durable-ledger.ts:278-284`), so a record-level read is required
  before assembly can fill `origin` at all. That is an ordering constraint on the implementation,
  not a detail — without it this whole field is unreadable.

**An attestation does not carry its own validity.** Nothing above establishes *who* produced this
attestation or *whether it is still good*: `attestorId` is a string the writer chose, and `expiresAt`
is a claim made at write time by the thing being judged. Both facts are recorded separately, by the
Harness, at the moment it observes them:

```ts
/**
 * The durable validity facts for one attestation. Assembled from the append
 * record and the session events — never from the attestation payload, which is
 * written by whatever produced it.
 *
 * This type is why there is no `trustedAttestorIds` anywhere in this contract.
 * Membership in a set of ids establishes that a writer knew a name; `origin`
 * establishes how the event entered this store, and a payload cannot reach it.
 */
export const AttestationValiditySchema = z.object({
  attestationId: id,
  /**
   * The session whose lease and closure the times below were taken FROM.
   *
   * Without it a validity record binds only by `attestationId`, so lease expiry
   * and closure can be lifted from a different session while the attestation and
   * the execution agree with each other perfectly. Freshness then passes with no
   * evidence that the cited lease ever governed this execution — the record
   * would say "something's lease was still open", not "this one's was".
   */
  sessionId: id,
  /**
   * The environment named by `environment.session-opened` for that lease.
   * Compared three ways in the derivation: lease, attestation, and execution.
   */
  environment: EnvironmentIdentitySchema,
  /**
   * Stamped by the APPEND PATH. Events arriving through the import path are
   * `imported` by construction, whatever `attestorId` they claim. Ruling 2 reads
   * off this and nothing else: imported evidence is stored and displayed, and
   * never satisfies a proof requirement in v1.
   */
  origin: z.enum(["local", "imported"]),
  /** From `environment.session-opened`. The session's lease, whether or not close() ran. */
  leaseExpiresAt: TimestampSchema,
  /** From `environment.session-closed`, when one was recorded. */
  closedAt: TimestampSchema.nullable(),
  /**
   * When the Harness last OBSERVED that this attestation is still good — not when
   * the attestation was written, and not when somebody last read it.
   *
   * `null` means freshness could not be observed. That is a first-class answer and
   * it is NOT "the last recorded value is probably still true": a recorded state is
   * not current state unless freshness is itself observed. A null here derives
   * `unknown`, never `admissible` and never `inadmissible`.
   */
  freshnessObservedAt: TimestampSchema.nullable(),
}).strict();
```

```ts
/**
 * The Harness's own prober. An environment provider supplies the ENVIRONMENT;
 * this supplies the PROBE and reads the RESULT.
 */
export interface EnvironmentProber {
  readonly attestorId: string;
  /** Opens a session. Both attestation and falsifier execution happen inside one. */
  open(request: { recipeDigest: string }): Promise<EnvironmentSession>;
}

export interface EnvironmentSession {
  /** Minted by the Harness. Cannot be named by anything that was not inside it. */
  readonly sessionId: string;
  readonly environment: EnvironmentIdentity;
  /** The lease this session was opened under. Durable before the first attestation. */
  readonly lease: EnvironmentSessionLease;
  attest(capability: CapabilityDefinition): Promise<EnvironmentAttestation>;
  execute(program: ProofProgram, candidate: CandidateIdentity): Promise<ProofExecution>;
  /** Ends the session. Every attestation it produced expires with it. */
  close(): Promise<void>;
}
```

**A session's lifetime is durable, or the session bound nothing.** ADR 0021 D5 binds a falsifier to
its environment by session, and ruling 1 scopes an attestation to that session. Neither is derivable
unless the session's own lifetime survives the process that held it — an in-memory session is a
binding that evaporates on the first crash and leaves its attestations looking live forever:

```ts
export const EnvironmentSessionLeaseSchema = z.object({
  schema: z.literal("rhiz/environment-session-lease/v1"),
  sessionId: id,
  attestorId: id,
  environment: EnvironmentIdentitySchema,
  openedAt: TimestampSchema,
  /**
   * REQUIRED. The wall-clock instant after which this session binds nothing, even
   * if `close()` never ran because the process died. This is what makes crash the
   * same as closure to the derivation instead of the state that keeps a proof alive.
   */
  leaseExpiresAt: TimestampSchema,
}).strict();

export const EnvironmentSessionClosureSchema = z.object({
  schema: z.literal("rhiz/environment-session-closure/v1"),
  sessionId: id,
  closedAt: TimestampSchema,
  /** A DIAGNOSTIC LABEL, never consumed by the derivation. `closedAt` is the fact. */
  reason: z.enum(["closed", "lease-expired", "abandoned"]),
}).strict();

```

These two events are what bundle assembly reads to fill `AttestationValidity.leaseExpiresAt` and
`.closedAt`. There is deliberately **no ledger interface** on the derivation: a session whose lease
was never recorded produces no validity record, so no bundle forms, so the answer is `unknown`. The
absence is handled by the bundle failing to close, not by a reason code the derivation has to
remember to emit.

---

## 4. Program vs execution — the structural split

```ts
/**
 * A PREPARED, REUSABLE proof program.
 *
 * There is deliberately NO field capable of naming an artifact: no workId, no
 * digest, no head, no sha, no candidate. `.strict()` makes adding one a parse
 * error. That is what stops the 97c700ce case — a lane preparing an attack
 * suite CAN write this and CANNOT write the receipt it later had to quarantine.
 *
 * It declares what it EXPECTS. Only a ProofExecution records what was OBSERVED.
 */
export const ProofProgramSchema = z.object({
  schema: z.literal("rhiz/proof-program/v1"),
  programDigest: digest,
  /** What refuting this program would refute. */
  propertyId: PropertyIdSchema,
  description: text.max(2000),
  /** Environment capabilities required before this program may be executed at all. */
  requiredCapabilities: z.array(CapabilityIdSchema).min(1),
  /**
   * ADR 0018 D1, generalized: a falsifier that cannot fail proves nothing. The
   * program must state both the candidate arm and the perturbed arm.
   */
  expectedOutcomes: z.object({
    /** Against an unperturbed candidate. */
    candidate: ProbeOutcomeSchema,
    /** Against a disposable derivative carrying this perturbation. */
    perturbed: ProbeOutcomeSchema,
    perturbation: NegativeControlPerturbationSchema,
  }).strict(),
  authoredBy: ActorRefSchema,
}).strict().superRefine((value, ctx) => {
  if (JSON.stringify(value.expectedOutcomes.candidate)
      === JSON.stringify(value.expectedOutcomes.perturbed)) {
    ctx.addIssue({
      code: "custom", path: ["expectedOutcomes"],
      message: "candidate and perturbed arms expect the same outcome, so this program cannot falsify",
    });
  }
});

/** The contract state a claim is about. Pinned on the execution and on the bundle's `current`. */
export const ContractPinSchema = z.object({
  workId: id,
  /** The revision in force when the falsifier ran. Matches `work.amended.revision`. */
  revision: z.number().int().min(1),
  /** Digest over the criterion set, so an in-place edit at one revision is still visible. */
  criterionDigest: digest,
}).strict();

/**
 * What the proof callback returns, and therefore what `runDisposableProof` records
 * as `result`. Typed, so the receipt states its own observations and the execution
 * cannot state different ones beside it.
 */
export const ProofRunResultSchema = z.object({
  candidate: ProbeOutcomeSchema,
  perturbed: ProbeOutcomeSchema,
}).strict();

/**
 * The disposable-proof receipt, stored WHOLE and as the same discriminated union
 * `runDisposableProof` returns.
 *
 * An earlier draft of this contract embedded a three-field summary — `proofId`,
 * `outcome`, `candidateDifferences`. That was forgeable, and forgeable in the
 * exact way this ADR exists to stop: `{ outcome: "proven", candidateDifferences:
 * [] }` parses with no pinned before/after identity, no derivative record, no
 * mutation list and no cleanup result, so a caller could hand `admissibility()`
 * its accepted branch without `runDisposableProof` ever having run. A summary of
 * evidence is an assertion about evidence.
 *
 * The envelope is reused verbatim rather than restated, so a field added to
 * `src/disposable.ts` cannot be silently dropped here.
 */
export const DisposableProofReceiptSchema = z.discriminatedUnion("outcome", [
  DisposableProofEnvelopeSchema.extend({
    outcome: z.literal("proven"),
    /**
     * The outcomes the proof callback ACTUALLY returned.
     *
     * `DisposableProofReceipt<T>` is generic in `src/disposable.ts`; a proof
     * execution instantiates `T = ProofRunResult` rather than leaving it opaque.
     * An earlier draft typed this `z.unknown()` and said admissibility never reads
     * it — which left `execution.observedOutcomes` independently writable beside a
     * receipt whose safety envelope was genuine. A callback returning an outcome
     * that does not match the program could then keep the real `proven` envelope
     * (candidate intact, derivative destroyed) and have matching observations
     * written in next to it. The envelope proved the candidate was safe; nothing
     * tied it to what was observed.
     */
    result: ProofRunResultSchema,
  }),
  DisposableProofEnvelopeSchema.extend({
    outcome: z.literal("invalidated"),
    /** `runDisposableProof` never returns this branch empty. */
    invalidations: z.array(InvalidationSchema).min(1),
    observation: text.max(2000).nullable(),
  }),
]);

/**
 * An EXECUTED, NON-REUSABLE receipt. Requires a candidate identity, so it cannot
 * be minted before the artifact it judges exists.
 */
export const ProofExecutionSchema = z.object({
  schema: z.literal("rhiz/proof-execution/v1"),
  executionId: id,
  /** The session that ran it. Must equal the session of every attestation it relies on. */
  sessionId: id,
  programDigest: digest,
  propertyId: PropertyIdSchema,
  propertyCatalogDigest: digest,
  /** Reused verbatim from src/disposable.ts. Not redefined. */
  candidate: CandidateIdentitySchema,
  /**
   * The base the claim is made against, for a merge claim; `null` otherwise.
   *
   * Without it `candidate-drifted` is underivable for a merge property: the only
   * execution-side artifact would be the candidate, so once the base moved there
   * would be no prior base to compare it to.
   */
  mergeBase: CandidateIdentitySchema.nullable(),
  /**
   * The environment the falsifier ACTUALLY ran in.
   *
   * Without it `environment-drifted` is underivable: the execution would carry
   * only a session id and its attestations, and nothing would establish that
   * those attestations describe the environment the falsifier ran in rather than
   * some other environment of the same session's making.
   */
  environment: EnvironmentIdentitySchema,
  /** The attestations this execution relies on, all from `sessionId`. */
  attestations: z.array(EnvironmentAttestationSchema).min(1),
  /**
   * The Work contract state this execution proved against, captured AT EXECUTION
   * TIME. Without it `contract-stale` is not derivable: the derivation
   * would hold the Board's current revision and have nothing to compare it to, so
   * an execution from before an amendment would keep satisfying the criterion the
   * amendment rewrote.
   */
  contract: ContractPinSchema,
  observedOutcomes: z.object({
    candidate: ProbeOutcomeSchema,
    perturbed: ProbeOutcomeSchema,
  }).strict(),
  /** The whole disposable-proof receipt, not a summary of it. */
  disposableReceipt: DisposableProofReceiptSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
}).strict().superRefine((value, ctx) => {
  for (const [i, a] of value.attestations.entries()) {
    if (a.sessionId !== value.sessionId) {
      ctx.addIssue({
        code: "custom", path: ["attestations", i, "sessionId"],
        message: "an execution may only rely on attestations produced by its own session",
      });
    }
  }
  // The receipt must be about the artifact this execution names. Otherwise a
  // genuine `proven` receipt for some other candidate can be lifted into an
  // execution that pins the one being judged.
  const before = value.disposableReceipt.candidateBefore;
  const moved = candidateIdentityDifferences(before, value.candidate);
  if (moved.length > 0) {
    ctx.addIssue({
      code: "custom", path: ["disposableReceipt", "candidateBefore"],
      message: `the disposable receipt pins a different candidate than this execution names (${moved.join(", ")})`,
    });
  }
  // An INVALIDATED receipt cannot enter an execution at all.
  //
  // This is the case the envelope alone cannot catch: apply the mutation, have the
  // proof throw or time out, let cleanup succeed, and the candidate is still intact
  // — so every envelope condition holds. The invalidated branch carries no `result`,
  // so the binding below never fires, and independently written observations pass
  // unchallenged. A failed run becomes a proof.
  //
  // Requiring the `proven` branch is NOT trusting a status flag. The two branches
  // carry different evidence: `proven` has `result`; `invalidated` has
  // `invalidations` and no result to bind anything to. Requiring the branch is
  // requiring the evidence to be present, and every fact in it is still recomputed.
  if (value.disposableReceipt.outcome !== "proven") {
    ctx.addIssue({
      code: "custom", path: ["disposableReceipt", "outcome"],
      message: "an invalidated disposable receipt carries no proof result to bind observations to, "
             + "so it cannot support an execution: "
             + value.disposableReceipt.invalidations.map((i) => i.code).join(", "),
    });
  } else {
    // The receipt's own observations and the execution's must be the same
    // observations, or the genuine safety envelope vouches for a run whose results
    // were replaced.
    const r = value.disposableReceipt.result;
    if (JSON.stringify(r.candidate) !== JSON.stringify(value.observedOutcomes.candidate)
        || JSON.stringify(r.perturbed) !== JSON.stringify(value.observedOutcomes.perturbed)) {
      ctx.addIssue({
        code: "custom", path: ["observedOutcomes"],
        message: "the execution's observed outcomes differ from the ones the proof callback "
               + "returned, so the receipt's safety envelope is vouching for a different run",
      });
    }
  }
  // ADR 0018 D1 at the receipt level: the perturbed arm is only meaningful if a
  // perturbation was actually applied inside the derivative.
  if (value.disposableReceipt.outcome === "proven" && value.disposableReceipt.mutations.length === 0) {
    ctx.addIssue({
      code: "custom", path: ["disposableReceipt", "mutations"],
      message: "a proven receipt carrying no applied mutation never ran a perturbed arm, so this "
             + "execution observed one state twice and falsified nothing",
    });
  }
});

export const ProofExecutionRefSchema = z.object({
  executionId: id,
  executionDigest: digest,
}).strict();
```

**The one change to Evidence** — no second Evidence system:

```ts
// src/schemas.ts — EvidenceRefSchema gains ONE optional field.
// Optional at introduction; #62 makes it required for REQUIRED requirements.
export const EvidenceRefSchema = z.object({
  id,
  kind: EvidenceKindSchema,
  uri: nonEmpty.max(2048).optional(),
  digest: nonEmpty.max(300).optional(),
  /** Binds this evidence to the execution that produced it. Issue #62 builds on this. */
  producedBy: ProofExecutionRefSchema.optional(),
}).strict();
```

---

## 5. Admissibility — a pure derivation over one closed bundle

Everything the derivation may consult is in **one durable value**. There is no catalog handle, no
ledger interface, no clock, and no `now` parameter — those are all doors through which a fact that
was never recorded can walk in and become a conclusion.

```ts
/**
 * The closed evidence bundle.
 *
 * Assembly OBSERVES; derivation DECIDES. Assembly resolves catalogs, reads the
 * append record, projects the session events, and checks freshness — and records
 * what it found, including that it could not find something. It concludes nothing.
 * `admissibility()` then reads only this, so the same bundle derives the same
 * verdict forever, which is what makes replay a derivation rather than a re-run.
 *
 * Every field is a durable recorded fact or a by-value resolution of one. Nothing
 * here is a handle to something that could answer differently next time.
 */
export const AdmissibilityBundleSchema = z.object({
  schema: z.literal("rhiz/admissibility-bundle/v1"),

  /** The cited property, BY VALUE. A criterion citing an unresolvable id makes no bundle. */
  property: PropertyDefinitionSchema,
  /** The catalog the execution ran under is compared against this. */
  propertyCatalogDigest: digest,

  /**
   * The CURRENT definition of every capability required by the property **or the
   * program**, BY VALUE — their union, not the property's list alone.
   *
   * Two independent reasons this is the union. A program declares its own
   * `requiredCapabilities`, and checking only the property's lets a bundle reach
   * `admissible` in an environment the program's own contract forbids it to run
   * in. And without the definitions at all, a capability whose probe was corrected
   * under the same id keeps accepting the attestation the defective probe earned,
   * until its TTL lapses: an attestation records `capabilityDefinitionDigest` and
   * `probeProgramDigest` precisely so they can be checked, and nothing could check
   * them.
   */
  capabilities: z.array(CapabilityDefinitionSchema).min(1),
  capabilityCatalogDigest: digest,

  /**
   * The proof program, BY VALUE, resolved from `execution.programDigest`.
   * A digest states which program ran; only the program states what it predicted,
   * and `falsifier-did-not-falsify` is a claim about the prediction.
   */
  program: ProofProgramSchema,

  /**
   * The executed falsifier. Carries, inside itself: the attestations, the session,
   * the contract revision it proved, the pinned candidate, the observed outcomes,
   * and the whole discriminated `DisposableProofReceipt`.
   */
  execution: ProofExecutionSchema,

  /** One per attestation the execution relies on. Freshness observed, never assumed. */
  environmentValidity: z.array(AttestationValiditySchema).min(1),

  /**
   * How the EXECUTION itself entered the store.
   *
   * Provenance on attestations alone leaves the obvious hole: an imported
   * `falsifier.executed` can embed a copied, still-fresh local attestation and
   * fabricate its own outcomes and receipt around it. The attestation resolves as
   * locally earned and nothing exposes that the execution was not. D7's rule is
   * that an imported stream transfers a recipe rather than a proof, and a recipe
   * includes the falsifier run.
   */
  executionOrigin: z.enum(["local", "imported"]),   // OBSERVATION, stamped at append

  /** What the Board holds RIGHT NOW, pinned into the bundle at assembly. */
  current: z.object({
    candidate: CandidateIdentitySchema,
    contract: ContractPinSchema,
    /**
     * The base the claim is made against, for a merge claim. `null` for a property
     * about the candidate alone. A merge claim whose base moved is about a merge
     * that is no longer the merge in question.
     */
    mergeBase: CandidateIdentitySchema.nullable(),
  }).strict(),

  /** When this bundle was assembled. Every freshness comparison is against this. */
  assembledAt: TimestampSchema,
}).strict().superRefine((b, ctx) => {
  // ---- Identity bindings. A bundle whose parts are not tied to each other
  // ---- does not exist, rather than deriving a verdict about being untied.
  const fail = (path, message) => ctx.addIssue({ code: "custom", path, message });

  if (b.program.programDigest !== b.execution.programDigest) {
    fail(["program", "programDigest"],
      "the bundled program is not the program the execution ran: an unbound program lets a "
    + "hostile bundle keep the required digest while substituting expectations that match the "
    + "observations, so `falsifier-did-not-falsify` would pass for a program that never ran");
  }
  if (b.property.propertyId !== b.program.propertyId
      || b.property.propertyId !== b.execution.propertyId) {
    fail(["property", "propertyId"],
      "property, program and execution must name the same property: two properties may legitimately "
    + "share a falsifier digest, and an unbound bundle could then pair one property's execution with "
    + "the other and report a propertyId that execution never claimed to prove");
  }
  // The UNION. A program that requires a capability its property omits still
  // requires it; checking the property's list alone admits the environment the
  // program's own contract forbids.
  const required = new Set([
    ...b.property.requiredCapabilities,
    ...b.program.requiredCapabilities,
  ]);
  if (b.capabilities.length !== required.size
      || !b.capabilities.every((c) => required.has(c.capabilityId))) {
    fail(["capabilities"],
      "the bundle must carry exactly the current definition of each capability required by the "
    + "property or the program");
  }
  const attested = b.execution.attestations.map((a) => a.attestationId).sort();
  const validated = b.environmentValidity.map((v) => v.attestationId).sort();
  if (JSON.stringify(attested) !== JSON.stringify(validated)) {
    fail(["environmentValidity"],
      "every attestation the execution relies on must carry exactly one validity record, and no "
    + "validity record may describe an attestation the execution does not rely on");
  }
  // A validity record must be THIS session's lease. Binding by attestationId alone
  // lets expiry and closure be lifted from another session while the attestation
  // and execution agree with each other.
  const byId = new Map(b.execution.attestations.map((a) => [a.attestationId, a]));
  for (const [i, v] of b.environmentValidity.entries()) {
    const a = byId.get(v.attestationId);
    if (a !== undefined && (v.sessionId !== a.sessionId || v.sessionId !== b.execution.sessionId)) {
      fail(["environmentValidity", i, "sessionId"],
        "a validity record must carry the lease of the session that produced its attestation and "
      + "ran this execution, or it is evidence about some other session's lease");
    }
  }
  // The mutation the derivative actually carried must be the perturbation the
  // program declared. Otherwise "a perturbation was applied" is true of any edit.
  const perturbation = b.program.expectedOutcomes.perturbation;
  const applied = b.execution.disposableReceipt.mutations;
  if (applied.length !== 1
      || applied[0].path !== perturbation.path
      || applied[0].bytes !== Buffer.byteLength(perturbation.content, "utf8")
      || applied[0].digest !== sha256(perturbation.content)) {
    fail(["execution", "disposableReceipt", "mutations"],
      "the applied mutation must be exactly the perturbation the program declared, by path, byte "
    + "length and content digest");
  }
  if ((b.current.mergeBase === null) !== (b.execution.mergeBase === null)) {
    fail(["current", "mergeBase"],
      "a merge claim must be a merge claim on both sides: an execution with no pinned base cannot "
    + "answer a claim about a base, and a base pinned against no claim is not evidence of one");
  }
  if (Date.parse(b.assembledAt) < Date.parse(b.execution.finishedAt)) {
    fail(["assembledAt"], "a bundle cannot be assembled before the execution it carries finished");
  }
  for (const [i, v] of b.environmentValidity.entries()) {
    if (v.freshnessObservedAt !== null
        && Date.parse(v.freshnessObservedAt) > Date.parse(b.assembledAt)) {
      fail(["environmentValidity", i, "freshnessObservedAt"],
        "freshness cannot have been observed after the bundle was assembled");
    }
  }
});
```

### The verdict has three branches, not two

```ts
export type Admissibility =
  /** The bundle derives the proof. */
  | { verdict: "admissible"; propertyId: string; executionId: string; candidateDigest: string }
  /** A fact IN THE BUNDLE refutes the claim. We know it does not hold. */
  | { verdict: "inadmissible"; reasons: ReadonlyArray<{ code: InadmissibleReason; detail: string }> }
  /** The facts do not answer the question. We do not know, and we say so. */
  | { verdict: "unknown";      reasons: ReadonlyArray<{ code: UnknownReason;      detail: string }> };
```

`unknown` is a first-class result, not a polite `inadmissible`. The two are different facts about
the world and collapsing them loses the difference that matters operationally: an **inadmissible**
claim was refuted and re-running the same proof will refute it again; an **unknown** claim was never
answered and re-earning the attestation may answer it. Both refuse acceptance. Only one is worth
retrying.

This is the machinery form of the standing rule that a recorded state is not current state unless
freshness is itself observed. When freshness lapses, the answer is `unknown` — never the last value
that happened to be recorded, and never a refutation the facts do not support.

```ts
export const UnknownReasonSchema = z.enum([
  /** `freshnessObservedAt` is null: freshness could not be observed at all. */
  "environment-freshness-unobserved",
  /** Freshness was observed, but before the TTL, the lease, or a recorded closure elapsed. */
  "environment-freshness-stale",
]);

export const InadmissibleReasonSchema = z.enum([
  "property-redefined",
  "capability-unattested", "attestation-indeterminate", "environment-drifted",
  /** The capability's definition or probe was corrected after this attestation was earned. */
  "capability-redefined",
  /** Ruling 2: imported evidence is stored and displayed; it never satisfies a requirement. */
  "evidence-not-locally-earned",
  "falsifier-program-changed", "falsifier-did-not-falsify", "falsifier-unbound",
  "falsifier-invalidated",
  "candidate-drifted", "contract-stale",
]);
```

### Binding, and why it is not a verdict

Every comparison the derivation makes falls into exactly one of two kinds, and confusing them is
what produced this whole family of defects:

- **An identity binding** — "these two parts of the bundle are about the same thing." Program to
  execution digest, the three `propertyId`s, validity records to attestations, a merge base present
  on both sides or neither. These are enforced as **parse invariants**, so a bundle whose parts are
  not tied together *does not exist*. There is no reason code for being unbound, because an unbound
  bundle never reaches the derivation.
- **A state comparison** — "this recorded value no longer matches that recorded value." Drift,
  redefinition, staleness, refutation. Both sides are durably recorded and both are carried in the
  bundle. These are **verdicts**.

The rule that follows, and that the earlier drafts kept violating: **the derivation never compares a
value the bundle does not carry.** Each of these was that same mistake — comparing an attestation to
a capability definition the bundle omitted, an observation to a program the bundle did not bind, an
attestation to an execution environment that was never recorded. The comparison was written down; the
second operand was not there.

### The design test every reason had to pass

> Name the exact durable bundle fields this verdict is derived from. If you cannot, it is not
> implementable, and it does not appear in the v1 contract.

| reason | derived from |
|---|---|
| `property-redefined` | `execution.propertyCatalogDigest` vs `propertyCatalogDigest` |
| `capability-unattested` | union of `property`/`program` `requiredCapabilities` vs `execution.attestations[].capabilityId` |
| `attestation-indeterminate` | `attestationVerdict(attestations[].arms, capabilities[])` — computed, not read |
| `capability-redefined` | attestation's `capabilityDefinitionDigest` / `probeProgramDigest` vs `capabilities[]` |
| `environment-drifted` | `environmentValidity[].environment`, attestation `environment`, `execution.environment` |
| `evidence-not-locally-earned` | `environmentValidity[].origin`, `executionOrigin` |
| `falsifier-program-changed` | `execution.programDigest` vs `property.falsifierProgramDigest` |
| `falsifier-did-not-falsify` | `execution.observedOutcomes` vs `program.expectedOutcomes` |
| `falsifier-unbound` | `execution.attestations[].sessionId` vs `execution.sessionId` |
| `falsifier-invalidated` | `execution.disposableReceipt` envelope fields |
| `candidate-drifted` | `execution.candidate` vs `current.candidate`; `execution.mergeBase` vs `current.mergeBase` |
| `contract-stale` | `execution.contract` vs `current.contract` |
| `environment-freshness-unobserved` | `environmentValidity[].freshnessObservedAt === null` |
| `environment-freshness-stale` | `environmentValidity[].freshnessObservedAt` vs `expiresAt`, `leaseExpiresAt`, `closedAt`, `assembledAt` |

**Deleted from the vocabulary, because a closed bundle cannot produce them.** Each was a verdict
about a fact the derivation would have had to go looking for:

| deleted | why it cannot arise |
|---|---|
| `property-unknown` | `property` is carried by value; an unresolvable citation makes no bundle |
| `falsifier-program-unresolved` | `program` is carried by value; an unresolvable digest makes no bundle |
| `attestation-session-unknown` | a session with no recorded lease makes no `AttestationValidity`, so no bundle |
| `attestation-untrusted` | there is no trusted-id set to fail against; `origin` replaced it |
| `attestation-expired` | split into the two freshness reasons, which are `unknown`, not refutations |
| `candidate-unpinned` | `ProofExecution` requires `candidate`; the shape cannot exist |
| `falsifier-receipt-mismatch` | a parse-level invariant of `ProofExecutionSchema`, not a verdict |
| `contract-mismatched-work` | folded into `contract-stale`, which compares the whole pin |
| `producer-unauthorized` | never derivable in v1. #62 adds it when #62 lands |

That is thirteen reasons where the reviewed head had nineteen, and the deletions are not
concessions: every one of them names a case where **no bundle closes**, and a bundle that does not
close is already the honest answer.

```ts
/**
 * Pure, total, and closed over its argument. Executes nothing, reads no
 * filesystem, opens no session, resolves no catalog, and consults no clock.
 *
 * There is no `execution: ProofExecution | null` and no `unknown property` branch,
 * because a claim with no execution or no property produces no bundle at all —
 * the Board never gets as far as calling this. The null branch is not handled
 * here; it is unrepresentable.
 *
 * Purity is also a security property. Replay of an imported or hostile stream must
 * never be able to cause execution.
 */
export declare function admissibility(bundle: AdmissibilityBundle): Admissibility;
```

The derivation, in order — each step maps to one axis of the equation. Freshness is evaluated
**first**, because a refutation computed from facts that may be stale is not a refutation:

0. **Freshness.** For each `environmentValidity` entry, let

       validUntil = min(attestation.expiresAt, leaseExpiresAt, closedAt ?? +infinity)

   and require **both** of:
   - `freshnessObservedAt !== null` — freshness was observed, not assumed;
   - `freshnessObservedAt < validUntil` **and** `assembledAt < validUntil` — the observation happened
     while the attestation was still valid, and it is still valid now.

   The direction matters and an earlier draft of this contract had it backwards. It required
   `freshnessObservedAt` to be *not earlier than* the cutoffs, which is true only once the
   attestation has already lapsed: a healthy attestation is observed fresh *before* its future
   expiry, so the reversed test returned `unknown` for the whole valid lifetime and `admissible`
   never. A freshness rule that never passes is not a strict freshness rule; it is a broken one, and
   it fails in the direction that looks safe, which is why it survived a reading.

   The TTL cap is itself the staleness bound — `MAX_ATTESTATION_TTL_MS` is how long a measurement is
   allowed to stand for "now" — so no second lag constant is introduced.

   Any failure ends the derivation as `unknown`.
   → `environment-freshness-unobserved`, `environment-freshness-stale`
1. **Property.** `execution.propertyCatalogDigest === propertyCatalogDigest`. The three propertyIds
   are already bound at parse, so this step is only about redefinition.
   → `property-redefined`
2. **Environment.** Every id in the **union** of `property.requiredCapabilities` and
   `program.requiredCapabilities` has an attestation; `attestationVerdict(a.arms, definition)`
   **computes** `discriminated` from the recorded arms — no stored verdict is read, because none is
   stored; each has
   `origin === "local"` and so does `executionOrigin`; each attestation's
   `capabilityDefinitionDigest` and `probeProgramDigest` still match the bundled current definition;
   and the environment agrees three ways — the lease's `environment`, the attestation's, and
   `execution.environment` — since the session that leased the environment, the attestation earned
   in it, and the falsifier run there must all describe one environment.
   → `capability-unattested`, `attestation-indeterminate`, `capability-redefined`,
   `evidence-not-locally-earned`, `environment-drifted`
3. **Falsifier.** `execution.programDigest === property.falsifierProgramDigest`;
   `execution.observedOutcomes` match `program.expectedOutcomes` arm for arm and differ from each
   other; every attestation's `sessionId` equals the execution's; and the receipt holds.
   The receipt must be on the `proven` branch — the `invalidated` branch carries no `result` to
   bind observations to, and its envelope can otherwise satisfy every condition below when the
   mutation applied and the proof then threw. Beyond that branch requirement **the derivation reads
   no conclusion off the receipt**; it recomputes each fact from the envelope, for the reason D1
   recomputes admissibility instead of storing it: `candidateAfter`
   non-null, `candidateIdentityDifferences(candidateBefore, candidateAfter)` empty,
   `residualPath === null` with `derivative.destroyed` required to agree with it — the surviving
   path is the observation and `destroyed` is a conclusion about it, so the conclusion is checked
   against the fact rather than read in its place; and `candidateBefore` equal to
   `execution.candidate`. The stored `candidateDifferences` array is likewise never read: the
   difference set is recomputed from the two pinned identities. The receipt's own `result` is bound to `observedOutcomes` at parse, and
   its applied mutation to the program's declared perturbation, so by this point "what was observed"
   and "what the safe run returned" are the same values rather than two that happen to agree.
   → `falsifier-program-changed`, `falsifier-did-not-falsify`, `falsifier-unbound`,
   `falsifier-invalidated`
4. **Artifact.** `execution.candidate` equals `current.candidate` under
   `candidateIdentityDifferences`; when `current.mergeBase` is non-null, `execution.mergeBase` equals
   it under the same comparison — the presence of a base on both sides is bound at parse, so this
   step compares two recorded identities rather than discovering one is missing; and
   `execution.contract` equals `current.contract` in all three fields.
   → `candidate-drifted`, `contract-stale`

Reaching the end with no reason is the only way to `admissible`. There is no branch that concludes
from an absence.

## 6. Events (resolved)

`environment.attested` and `falsifier.executed` are new durable, non-state-changing facts:

```ts
event("environment.attested", z.object({ attestation: EnvironmentAttestationSchema }).strict())
event("falsifier.executed",   z.object({ execution: ProofExecutionSchema }).strict())
```

Two more join them, because ruling 1 is not derivable without them. A session-scoped attestation
whose session lifetime lives only in a process is a binding that disappears when that process does,
and leaves its attestations looking live to every later reader:

```ts
event("environment.session-opened", z.object({ lease:   EnvironmentSessionLeaseSchema }).strict())
event("environment.session-closed", z.object({ closure: EnvironmentSessionClosureSchema }).strict())
```

This **extends** the list ruling 6 named; it does not revise rulings 1–6. Ruling 6 settled that
attestation and execution are new durable facts rather than riders on `verification.result`, and the
same argument carries: a session lease is a fact about what was measured and when it stopped
counting, not a state transition.

All four are **evidence, not state transitions** — projected the way `authorityDecisions` are
(`src/board.ts`), never changing `WorkState` on their own. Board acceptance is unchanged by ADR 0021;
the acceptance reason that consumes them arrives at step 8 of the implementation order, with its own
amendment and its own guard.

**Origin is not in the payload.** `AttestationValidity.origin` is stamped by the append path onto
the envelope of `environment.attested`. It is deliberately not a payload field: a field inside the
payload is a field the writer of the payload controls, and an imported stream would arrive carrying
`origin: "local"`.

---

## 7. Receipt versioning

```ts
// rhiz/verification-receipt/v2 = v1 + this one field.
// Every existing v1 receipt is exactly v2 with `properties: []`.
properties: z.array(z.object({
  propertyId: PropertyIdSchema,
  criterionId: id,
  executionId: id,
}).strict()).default([]),
```

---

# Appendix: mechanics demoted from ADR 0021

The sections below were removed from ADR 0021 when it was reduced to settled doctrine. They are
kept here for the reasoning. Like everything else in this document they are **non-authoritative**,
and the state table in particular carries defect 4 above.

## Ownership map

| Concern | Owner | New? |
|---|---|---|
| `PropertyDefinition`, `PropertyCatalog` | portable core, new module | **new** |
| `CapabilityDefinition`, `CapabilityCatalog`, `DiscriminatingProbe` | portable core, new module | **new** |
| `EnvironmentProber`, `EnvironmentSession`, `EnvironmentAttestation` | portable interface, new; implementations in adapters | **new** |
| `EnvironmentSessionLease` — durable session lifetime | portable core, new module | **new** |
| `AttestationValidity` — origin, lease, closure, freshness | assembly; `origin` stamped by the event append path | **new** |
| `AdmissibilityBundle`, its identity bindings, and its assembly | portable core, new module. Assembly observes; it concludes nothing | **new** |
| Append-stamped `origin` on the ledger record | `src/ledger.ts` — `rhiz/ledger-record/v2`, one field | existing |
| `ProofProgram` / `ProofExecution` split | portable core, new module | **new** |
| `admissibility()` and its typed reasons | portable core, new pure function | **new** |
| Provisioning a real Postgres, a production-layout Python image, a sandbox-capable host | Host / adapter layer only. The portable core never learns one runtime's shape (Constitution §2) | extends existing |
| Disposable derivative, candidate identity, cleanup refusal | `src/disposable.ts` — **reused verbatim, unchanged** | existing |
| Sandbox policy and launcher | `src/sandbox.ts` — becomes one `CapabilityDefinition` among several | existing |
| Perturbation and negative-control semantics | `src/verify/schema.ts` — **generalized, not replaced**; the applied mutation is bound to the declared perturbation by path, length and digest | existing |
| Evidence | `EvidenceRef` — one optional field | existing |
| Acceptance | `src/board.ts` — one new reason, eventually. No rewrite | existing |
| Free-string capability tags | `src/router.ts:31` re-typed as `CapabilityOffer` | existing |

## State and invalidation model

An `AdmissibleProof` exists only as the `Admissible` branch of a derivation. Every reason below is a
refusal, never a downgrade, in the manner of `InvalidationCode` in `src/disposable.ts`:

| axis | reason | derived from |
|---|---|---|
| property | `property-redefined` | `execution.propertyCatalogDigest` vs the bundle's |
| environment | `capability-unattested` | `property.requiredCapabilities` vs the execution's attestations |
| environment | `attestation-indeterminate` | the attestation's own `verdict` |
| environment | `capability-redefined` | the attestation's capability/probe digests vs the bundled current definition |
| environment | `evidence-not-locally-earned` | `environmentValidity[].origin` and `executionOrigin` |
| environment | `environment-drifted` | the lease's, the attestation's and the execution's `environment` |
| falsifier | `falsifier-program-changed` | `execution.programDigest` vs `property.falsifierProgramDigest` |
| falsifier | `falsifier-did-not-falsify` | `execution.observedOutcomes` vs `program.expectedOutcomes` |
| falsifier | `falsifier-unbound` | each attestation's `sessionId` vs the execution's |
| falsifier | `falsifier-invalidated` | the receipt envelope: pinned identities, derivative, cleanup |
| artifact | `candidate-drifted` | `execution.candidate` vs `current.candidate`; `execution.mergeBase` vs `current.mergeBase` |
| artifact | `contract-stale` | `execution.contract` vs `current.contract` |

And two that are **not refusals**. They are `unknown`, because an unmeasured environment has not been
refuted and saying otherwise would be a conclusion the facts do not carry:

| axis | reason | derived from |
|---|---|---|
| environment | `environment-freshness-unobserved` | `freshnessObservedAt === null` |
| environment | `environment-freshness-stale` | `freshnessObservedAt` vs `expiresAt`, `leaseExpiresAt`, `closedAt`, `assembledAt` |

Nine reasons that appeared in earlier drafts are **gone**, each because a closed bundle makes it
unreachable rather than because it stopped mattering: `property-unknown` and
`falsifier-program-unresolved` (carried by value — an unresolvable citation makes no bundle),
`attestation-session-unknown` (no lease, no validity record, no bundle), `attestation-untrusted`
(no trusted-id set exists to fail against), `attestation-expired` (became the two freshness
reasons), `candidate-unpinned` (`ProofExecution` requires a candidate; the shape cannot exist),
`falsifier-receipt-mismatch` (a parse invariant, not a verdict), `contract-mismatched-work` (folded
into `contract-stale`), and `producer-unauthorized` (never derivable in v1 — #62 adds it when #62
lands, rather than this ADR shipping a reason nothing can emit).

Each of the four axes has at least one reason, and moving any of the four flips the derivation on the
next read. That is the invalidation model in full: there is nothing else, because there is nothing
stored.

Every row above names the durable fields it reads. That is not documentation of the table — it is
the admission test for entering it, per D1's corollary. A row that could not fill its right-hand
column was deleted rather than shipped.

## Worked contracts

Concretely, against the four real incidents. Each shows the discriminating probe (with its control
arm, which is the part that catches the incident) and the falsifier.

### 1. `postgres-rls` — an RLS policy inert because RLS was never enabled

Required capabilities:

- `db.postgres.row-level-security`. Probe against a Harness fixture schema, not the candidate.
  - *present arm*: with the fixture policy enabled, `owner_b` selecting `owner_a`'s row observes
    **0 rows**.
  - *control arm*: the same program against a fixture with the policy **not** enabled observes
    **1 row**.
  - **This is the arm that catches the incident.** An environment where RLS was never enabled
    returns 1 row on both arms. Same outcome twice → `indeterminate` → inadmissible. Under a tag
    scheme it would have read `"environment": "postgres-rls"` and passed.
- `db.postgres.role.non-bypass`.
  - *present arm*: the connected role has neither `rolsuper` nor `rolbypassrls`, observed by the
    fixture query returning 0 rows.
  - *control arm*: the same query as a bypass role returns the row.
  - Without this second capability a superuser silently bypasses every policy and the first probe
    reports 0/1 for the wrong reason.

Falsifier `falsifier:rls-cross-tenant-read`: as owner B, read owner A's rows through the
application's real query path.
- against the candidate: **0 rows**.
- against a disposable derivative with the policy dropped: **≥1 row**. If this arm also returns 0,
  the falsifier is not observing what it claims and the execution is refused.

Invalidated by: candidate migration digest, Postgres major version, connected role, fixture recipe.

### 2. `transaction-rollback` — a failure receipt written inside an already-aborted transaction

Required capability `db.postgres.transaction-semantics`.
- *present arm*: `BEGIN`; insert; force an error; attempt a second statement and observe SQLSTATE
  `25P02` (`in_failed_sql_transaction`); `ROLLBACK`; then select → **0 rows**.
- *control arm*: the same statements with no transaction → the first insert **survives**, 1 row.
- A mock driver, or a connection pooler in statement mode, returns "row survives" on both arms.
  Same outcome twice → `indeterminate`. This is the mock-only-coverage case issue #73 names, caught
  by the control arm rather than by a reviewer.

Falsifier `falsifier:receipt-survives-abort`: run the application's failure path and require the
receipt row to be **present** after the aborted transaction; on a derivative where the receipt write
is moved back inside the aborted transaction, require it **absent**.

Invalidated by: pooler mode, driver version, candidate.

### 3. `production-import-shape` — `app.main` in the suite, `backend.app.main` in production

Required capability `python.production-layout`. The delicate one, because the layout is close to the
thing under test; the separation is that the probe runs against a **fixture package**, never the
candidate.
- *present arm*: in the environment, `importlib.util.find_spec("fixture_inner")` is `None` while
  `find_spec("fixture_outer.fixture_inner")` resolves — the marker of a production layout where the
  inner directory is not itself on `sys.path`.
- *control arm*: the same program with the fixture's inner directory prepended to `sys.path` →
  `find_spec("fixture_inner")` resolves.
- A dev-layout image resolves both on both arms. Same outcome twice → `indeterminate`. The six
  failed deploys are the case where the environment silently permitted both module graphs and
  nothing could tell which one production would use.

Falsifier `falsifier:production-entrypoint-boots`:
- `import backend.app.main` (or the real ASGI import string) **succeeds** against the candidate;
- the bare `import app.main` **fails** in the same environment — otherwise the environment does not
  distinguish the two graphs and cannot prove the property at all;
- on a derivative with the entrypoint module renamed, the import **fails**.

Invalidated by: image digest, `PYTHONPATH`, working directory, candidate.

### 4. `filesystem-containment` — a derivative that could rewrite a symlink back into its source (#72)

Required capability `host.filesystem-containment`. This is `test/containment.test.ts` promoted out of
the test suite and into the capability definition, which is the correction the measurement in this
ADR's Context section demands.
- *present arm*: a contained write to a path outside the execution root — the file **does not exist**
  afterwards. The target is a `mkdtemp` directory, not `/`, so the arm means something.
- *control arm*: the same write, uncontained — the file **does exist**. This is the arm the shipped
  `available()` lacks.
- *work arm*: a contained write **inside** the root — the file **does exist**. Required by ADR 0017's
  own reasoning: a boundary that also blocks the work gets switched off, and a boundary that blocks
  everything discriminates nothing.

Falsifier `falsifier:derivative-escape`: run the escape program — including the relative-symlink case
from #72 — against the candidate's derivative factory. Every escape target absent against the
candidate; present against a derivative with `DisposableDerivative.resolve`'s prefix check removed.

Invalidated by: platform, launcher id, OS fingerprint, candidate.

**The pattern across all four**: the attestation is per-environment-session and candidate-independent;
the falsifier is per-candidate and session-bound. That line is the reuse boundary, and it is the same
line as D6's program/receipt split, one level out.

## Migration from the receipts the fleet already has

Two durable receipt schemas exist: `rhiz/verification-receipt/v1` (`src/verify/schema.ts:170`) and
`rhiz/disposable-proof-receipt/v1` (`src/disposable.ts:173`).

1. **No existing receipt is rewritten.** They remain accurate records of what happened. Admissibility
   is computed *about* them, never stored *in* them.
2. `rhiz/verification-receipt/v2` adds `properties: PropertyProofRef[]`, which may be empty. Every
   existing v1 receipt migrates **by interpretation, not by edit**: v1 ≡ v2 with `properties: []`.
   A parser accepts both.
3. Consequently nothing previously accepted becomes retroactively rejected, and nothing previously
   accepted counts as a property proof. That is the honest reading and it should not be softened.
4. `EvidenceRef.producedBy` is optional at introduction and stays optional until #62 makes it
   required for *required* requirements. Two phases, so this ADR breaks no existing stream.
5. **Quarantined receipts migrate by deletion.** A provisional receipt like the `97c700ce` one
   becomes a `ProofProgram` by dropping its candidate fields; the program survives, the receipt does
   not. One-way, deliberately.
6. `RouterWorkerDescriptor.capabilityTags` is re-typed as `CapabilityOffer` with no behavioural
   change to routing. The point is only that it can no longer be mistaken for an attestation.
7. `rhiz/ledger-record/v2` adds the append-stamped `origin`. Existing v1 records are **not**
   rewritten and are **not** read as `local`; they carry no origin, and a record with no origin is
   not locally earned. Nothing is lost by that, because no attestation or execution exists yet — the
   fail-closed reading is free here and will never be this cheap again.

## Implementation order

Sequenced so that nothing lands on a path another lane is holding, and so that no step changes
acceptance until the step that is supposed to.

0. **Wait for #70.** Do not touch `src/verify/engine.ts` or `src/board.ts` until the evidence-path
   falsifiers land.
1. **Fix the measured defect on its own.** Make `MacosSandboxExecLauncher.available()` a real
   discriminating probe: write into a `mkdtemp` directory, observe the effect rather than the exit
   code, and require the uncontained control to succeed. Guard entry
   `sandbox/availability-requires-a-positive-control`. **This does not depend on the rest of this ADR
   and should not wait for it.**
2. Capability vocabulary and probe contract types, parsing only. A `CapabilityDefinition` whose probe
   has no control arm must fail to parse, and that must be a guard.
3. `EnvironmentProber` / `EnvironmentSession` interfaces and the `indeterminate` outcome. No adapters.
   Includes the durable session lease: `environment.session-opened` / `environment.session-closed`
   and a required `leaseExpiresAt`. Guard: an attestation whose session has no recorded lease must
   fail to assemble into a bundle, and the verdict must be `unknown`, not a pass.
4. `PropertyCatalog` plus the optional `AcceptanceCriterion.property` citation, and the program
   catalog assembly resolves against. Parsing only; no acceptance change. Ruling 3 places all three
   beside `scripts/guard-manifest.json`, validated in `npm run check`.
5. The `ProofProgram` / `ProofExecution` split, with the structural rule that a program cannot name a
   candidate. Guard: a program carrying a digest field fails to parse. `ProofExecution` embeds the
   whole `DisposableProofReceipt` and its own `contract` revision; guard: an execution carrying a
   receipt that pins a different candidate fails to parse.
6. `rhiz/ledger-record/v2` and append-path `origin` stamping, including the record-level read that
   assembly needs — `LedgerReader.read()` yields events, so without it the field is unreadable.
   Guard: a record with no origin is not locally earned.
7. `AdmissibilityBundle`, its assembly, and `admissibility()` as a pure function over it,
   unit-tested against synthetic bundles. Still not consulted by Board. The guards, chosen because
   each is a branch that fails in the direction that looks safe:
   - an attestation stamped `imported`, and an **execution** stamped `imported` carrying a genuine
     local attestation, both derive inadmissible;
   - a bundle whose `freshnessObservedAt` is null derives `unknown`, **not** `inadmissible`;
   - a lapsed TTL derives `unknown` while the attestation still contains a `discriminated` verdict —
     the falsifier for the freshness rule, since reading the stale verdict is the shorter code path;
   - **a healthy, unexpired attestation derives `admissible`.** This is the positive control, and it
     is not optional: the reviewed draft's freshness test was inverted and returned `unknown` for
     every valid attestation, which no negative-only test could have caught;
   - a bundle whose program digest, propertyIds, validity records, merge-base presence, session
     leases, applied perturbation, or receipt-to-observation agreement are unbound fails to
     **parse**, rather than deriving a verdict;
   - an execution whose `observedOutcomes` differ from the receipt's own `result` fails to parse,
     even when the receipt is genuinely `proven` — that is the case where every individual record is
     authentic and only their relationship is forged.
8. **#62** lands producer authorization, binding to `ProofExecution.executionId`.
9. **Only then**: `EvidenceRef.producedBy` becomes required for required requirements, and
   `acceptanceReadiness` gains one reason. This is the first step that changes acceptance and needs
   its own amendment to this ADR plus its own guard.
10. Adapters, one PR each with its own discrimination test: disposable Postgres, production-layout
   Python, non-darwin sandbox.
