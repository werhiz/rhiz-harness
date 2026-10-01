# ADR 0021: Admissibility is derived from property, attested environment, executed falsifier, and exact candidate

Status: **proposed** for Kernel 0.1. Design record for issue #73.

**Nothing in this ADR is enforced.** It adds no runtime behaviour, changes no acceptance rule, and
must not be cited as evidence that any property is proven.

This ADR is deliberately **minimal**. It records the doctrine that is settled — the proof equation,
the six captain rulings, and the principles below — and it does **not** specify the executable
mechanics. Five rounds of exact-head review on the full contract found real internal unsoundness in
the schema and algorithm each time, and a document that reads as law while containing derivable
falsehoods is worse than a smaller one that is true. So the mechanics are demoted rather than
canonized:

> `docs/PROOF_ADMISSIBILITY_0_1.md` is a **NON-AUTHORITATIVE working design**. It is thinking, not
> law. It is known to contain unresolved defects, listed under "What is deferred". It must not be
> cited as a contract, implemented as specified, or treated as this ADR's normative annex.

Generalizes ADR 0013 (execution integrity), ADR 0016 (guard falsifiability), ADR 0018
(falsifiability and named exemptions), ADR 0019 (disposable proof lifecycle) and ADR 0020 (OS
containment for workers). Blocks on #70 and orders itself around #62.

## Context

Three mechanisms in this repository each own one third of the same sentence and none owns the whole
of it.

- **ADR 0019 / #63** made the *artifact* half real: a proof runs in a disposable derivative, the
  candidate's identity is pinned before and recomputed after, and a receipt that cannot prove
  equality is `invalidated` with no `result` field to read.
- **ADR 0017 / ADR 0020 / #11** made the *environment* half real for one property on one platform:
  containment is proven by an escape attempt, not by inspection.
- **ADR 0016 / ADR 0018 / #32 / #65** made the *falsifier* half real: a check that cannot fail does
  not prove, and a criterion whose negative control is missing is refused, or exempted per-criterion
  by a named human for one of four reasons.

Issue #73 asks for the type that binds them, so that a claim of the form *"property P holds"* is
admissible only when it carries the environment that can physically exhibit P, a falsifier that
actually executed there, and the exact artifact identity it ran against — and becomes inadmissible
the moment any of the four moves.

Four incidents motivate it, each drawn from real fleet work in the last day: an RLS policy that was
inert because row-level security was never enabled on the table; a failure receipt written inside an
already-aborted transaction, so the receipt rolled back with it; a test suite importing `app.main`
while production imported `backend.app.main`, costing six consecutive failed deploys; and a
disposable derivative that could rewrite a symlink back into its source (#72).

### The defect is already in this repository, one level up

The hard part of #73 is stated in the issue: a string tag can be asserted, so `"environment":
"postgres-rls"` proves nothing. This is not a hypothetical, and it is not only in the fleet's other
repositories.

`RouterWorkerDescriptor.capabilityTags` (`src/router.ts:31`) is exactly that free string array. It
is only a routing input today, which is why it has not caused harm.

The sharper case is the one that *is* load-bearing. ADR 0017 D3 states:

> **`available()` proves a boundary, not a binary.** It runs a deny-default profile and requires a
> write to fail. The presence of `/usr/bin/sandbox-exec` is not evidence that it confines anything.

That intent is right and the implementation does not carry it
(`adapters/local/sandbox.ts:43-67`). Two independent reasons, both executed:

1. The probe writes to `/probe-should-be-denied`. On a macOS signed system volume `/` is read-only
   for every process, so the write fails whether or not a sandbox exists. The probe has a negative
   arm and **no positive control**, and therefore discriminates nothing.
2. Any rejection of the child counts as denial, including a failure to spawn the sandbox binary.
   Measured: a launcher constructed with `binary: "/usr/bin/false"` — which imposes no boundary of
   any kind — returns `available() === true`.

Both are reproducible from this repository, and are stated here in full rather than cited, so that
a reader can re-run them instead of taking this ADR's word for it.

The first, on any darwin host — the write fails identically with no sandbox involved, because the
target is on the read-only system volume:

```console
$ /bin/sh -c 'echo probe > /probe-should-be-denied'; echo "exit=$?"
/bin/sh: /probe-should-be-denied: Read-only file system
exit=2
$ ls -la /probe-should-be-denied
ls: /probe-should-be-denied: No such file or directory
```

The second, after `npm run build`:

```js
console.log("shipped launcher      available() =", await new MacosSandboxExecLauncher().available());
console.log("bogus binary          available() =",
  await new MacosSandboxExecLauncher({ binary: "/usr/bin/definitely-not-sandbox-exec" }).available());
console.log("/usr/bin/false        available() =",
  await new MacosSandboxExecLauncher({ binary: "/usr/bin/false" }).available());
```

```
shipped launcher      available() = true
bogus binary          available() = true
/usr/bin/false        available() = true
```

`/usr/bin/false` imposes no boundary of any kind, and the attestation says the host is contained.

`HostCapabilities.sandbox` is derived from that probe
(`adapters/local/command-worker.ts:501-513`), and it is the gate that decides whether a
write-enabled worker may run at all (`src/workers.ts:261`, ADR 0020 D4). ADR 0020 D4 says the
capability is "**derived**, never asserted … a host able to advertise containment it does not have
would turn the gate back into a label". On a host with a broken or substituted `sandbox-exec`, it
is a label.

The boundary itself is genuinely real on a working darwin host — `test/containment.test.ts` executes
seven escape and control tests and all seven pass. The finding is narrow and exact: **the boundary
is real; the attestation of it is not a proof.** And the shape of the fix is already in the
repository, in the tests rather than in the attestation: `test/containment.test.ts:136-150` writes
its escape target into a `mkdtemp` directory that *is* writable unsandboxed, asserts on
`existsSync(...) === false` rather than on an exit code, and `test/containment.test.ts:173-186`
supplies the positive control by requiring the allowed write to succeed.

That contrast is the whole of this ADR. The test discriminates; the capability claim does not.

## Decision — the settled doctrine

Everything in this section is authoritative. Nothing in it is a schema, an algorithm, or a field
name, because those are exactly what is not settled.

### D1. The proof equation

```
Property × EnvironmentAttestation × ExecutedFalsifier × ArtifactIdentity  →  AdmissibleProof
```

A claim that *property P holds* is admissible only when it carries all four: the environment that
can physically exhibit P, a falsifier that actually executed there, and the exact artifact identity
it ran against. Weakening any term weakens the claim to nothing — the four are conjunctive, not a
scoring rubric.

### D2. A capability is proven by discrimination, never asserted by a tag

An environment cannot label itself. A capability claim counts only when a probe distinguishes the
environment that has the capability from one that does not: the same program, run against a
deliberately capability-free control, must produce the **opposite** observable outcome. If both arms
agree, the probe distinguishes nothing and the claim is not evidence.

Two supporting rules, both drawn from the measured defect above:

- **An outcome is an observed effect, never an exit code and never an exception.** An exception
  proves something failed; it does not prove the boundary refused.
- **A boundary that also blocks the legitimate work discriminates nothing useful.** Where a
  capability's meaning requires it, the allowed operation must be shown to still succeed.

### D3. A provider may advertise; only the Harness may attest

What a provider says about its environment is a routing input with zero evidentiary weight. What the
Harness measured is evidence. The provider supplies the environment; the Harness supplies the probe
and reads the result. There is no channel through which the thing being judged states its own
verdict.

The honest limit: the control arm is itself an environment the Harness constructs, so the recursion
stops at the Harness's own execution. If the machine running the Harness is compromised, nothing
here helps, and it does not claim to.

### D4. Proof is earned locally in v1

Imported evidence may be stored and displayed. It never satisfies a Harness proof requirement.
An imported stream transfers a *recipe for re-proving locally*; it never transfers the proof.

This is a refusal, not a weaker tier of trust: there is no configured peer set and no partial
credit. Authenticated cross-Harness proof would require verifiable provenance and is deliberately a
separate future decision.

### D5. Admissibility binds to exact artifact identity

A proof is about the artifact it ran against and no other. The identity is pinned before the run and
rechecked after, and a proof whose artifact has since moved is not a proof of the current one. This
reuses ADR 0019's candidate identity unchanged; it does not introduce a second notion of what an
artifact is.

### D6. Freshness must be observed, and `unknown` is a first-class result

A recorded state is not current state unless freshness is itself observed or proven. When freshness
lapses **on evidence that had established the claim**, the verdict is **`unknown`** — never the last
value that happened to be recorded.

Freshness does not override the conjunction. D1's four terms are conjunctive, so if any one of them
was **never produced at all** — no falsifier execution, no pinned artifact identity — the claim is
`inadmissible` no matter how fresh or stale some other term is. Lapse yields `unknown` only when the
remaining evidence had established the claim and its currency is the single thing now missing.

*Stale* is not a fourth state. It describes **why** a claim is unknown — evidence that once
succeeded, whose currency has expired — and belongs to the reason, not the verdict. The standing
rule's phrase "unknown or stale" names the answer and its commonest cause together; there are three
verdicts and no more.

`unknown` is a verdict in its own right, not a polite refusal. There are three states, and they have
three different causes:

- **admissible** — the evidence establishes the claim.
- **inadmissible** — the claim is not established, for either of two distinct reasons: a recorded
  fact **refutes** it (a probe that failed to discriminate, an artifact that moved), or the required
  evidence was **never produced at all**. Ruling 4 places the never-measured capability here
  deliberately: the claim fails closed, and **there is no exemption path out of it**. If the
  environment cannot physically exhibit a required capability, `AdmissibleProof` is impossible for
  that property in that environment — see the narrowing of ruling 4 below.
- **unknown** — the evidence was produced and did establish the claim, and its currency can no
  longer be derived.

Note carefully what `inadmissible` does **not** assert. On the never-measured branch nothing refuted
anything; the claim simply has no support, and reporting a refutation would be claiming a fact the
record does not contain — the same defect one level up. Fail-closed is a *policy* about absent
evidence, not a finding about the environment. And `unknown` is not a weaker refutation either: the
environment was shown to have the capability, and only the showing stopped being current.

What separates them is **what new evidence would change the answer** — not whether a retry succeeds.
Re-deriving over unchanged evidence never moves any of the three; that is D7's recompute property,
not a property of the verdicts. They differ in what would have to become true:

- a **refutation** stands until the refuting fact itself changes — a probe that discriminates on
  re-measurement, or, where the artifact moved, a fresh run against the new exact identity (D5);
- a **never-measured** capability needs the attestation *earned*, for the first time;
- an **unknown** needs freshness re-observed for evidence that already succeeded once.

Collapsing them discards which of those three moves is the one that would help.

The failure this forbids is the tempting one: a lapsed attestation still *contains* its old
verdict, and reading it is shorter than refusing to. That reading answers "what did we once observe"
while appearing to answer "what is true now".

### D7. Admissibility is derived from closed durable evidence, never stored — as a direction

`AdmissibleProof` is not a durable fact and not an event. It is recomputed, so a proof stops holding
the instant an input moves and no revocation subsystem has to remember anything. The intended shape
is a **pure derivation over a closed, durable, replayable evidence bundle**: if a required fact is
absent the answer is inadmissible or unknown, never inferred, never trusted by label, never supplied
from process-local state. Two corollaries the review process established and this ADR keeps as
doctrine:

- **A verdict that cannot name the durable facts it derives from should not exist.** Delete it
  rather than ship it underivable.
- **No stored conclusion is an input.** A summary field — a verdict, a boolean, a status — must be
  computed from the observations underneath it, not accepted beside them.

This is recorded as **direction, not specification.** The executable form of it is exactly what
remains unresolved.

## Resolved — captain's rulings

The six open design calls have been ruled by the captain:

1. **Attestation lifetime.** Environment attestation is session/execution-scoped, with a TTL cap.
   *(Ruled)*
2. **Do imported attestations ever count?** Proof is earned LOCALLY for v1. Imported attestations do
   not count. *(Ruled)*
3. **Where the catalogs live.** Catalogs ship as a JSON property manifest beside guard-manifest.json,
   validated in check. *(Ruled)*
4. **Missing capability: block or exempt?** A missing capability makes the claim INADMISSIBLE.
   *(Ruled; **narrowed** — see "The scope of ADR 0018" below. As first ruled this said an ADR 0018
   named exemption was "the only escape". Direct verification of ADR 0018 established that its
   exemption has no such scope, and the captain narrowed the ruling to the authority ADR 0018
   actually has. There is no exemption path for a missing physical capability in v1.)*
5. **Property granularity.** Environment capabilities are fine-grained; semantic properties are coarse
   per defect class. *(Ruled)*
6. **New events or ride `verification.result`?** `environment.attested` and `falsifier.executed`
   are new durable, non-state-changing facts. *(Ruled)*

The rulings stand as written and are authoritative. How each one would be *mechanised* is an open
question, not a settled one — see "What is deferred" below and the non-authoritative working
design.

### Captain's correction

> ADR 0018 may waive a proof REQUIREMENT, but it cannot turn a missing physical capability into
> proof. If the environment cannot exhibit Postgres RLS, the claim remains inadmissible as
> postgres-rls proof. Human authorization can accept an attestation-only exception; it cannot certify
> physics.

> **⚠ SUPERSEDED IN SCOPE.** The two clauses about what ADR 0018 may waive are superseded by the
> captain's narrowing below, which controls wherever they differ. Only the final clause — *it cannot
> certify physics* — stands unchanged, and it is law.

**Scope note — this correction predates the direct verification of ADR 0018, and is preserved
verbatim rather than rewritten**, so the record shows what was corrected instead of erasing it. Its
standing point is unchanged: *it cannot certify physics.* The two superseded clauses:

- *"may waive a proof REQUIREMENT"* means specifically a **criterion's negative-control
  requirement** under ADR 0018 D1/D2. It is not a waiver of the requirement to carry an admissible
  proof; no such waiver exists in v1.
- *"can accept an attestation-only exception"* refers to ADR 0018's own attestation-only path
  (D4), which then requires independent review. It does **not** permit accepting a claim whose
  required physical capability is absent — that claim is inadmissible and has no exemption path.

Read with those two narrowings, the correction and the ruling below say one thing, not two.

**Ruling 4 does not overlap D6**, and the two must not be collapsed. D6 defines the three states and
their causes; ruling 4 decides only *where the never-measured capability sits* — inadmissible, by the
fail-closed policy D6 names, with no exemption path out of it.

### The scope of ADR 0018

Ruling 4 originally named an ADR 0018 exemption as the escape for a missing capability. Direct
verification of ADR 0018 established that it has no such power, and the captain narrowed the ruling
rather than extend ADR 0018 by implication. The canonical statement:

> A human may authorize a named ADR 0018 exemption from a criterion's negative-control requirement
> where ADR 0018 permits it. **No human authorization can make an unavailable physical capability
> present or convert missing physics into `AdmissibleProof`.**

What ADR 0018 actually owns (D1, D2, D4, and `FalsifiabilityExemptionSchema` in `src/schemas.ts`):
a required criterion may omit its **negative control** for one of four named reasons —
`external-receipt`, `static-analysis`, `browser-observation`, `human-judgment` — authorized by a
named human and visible in the receipt. Per criterion. That is the whole of it.

Three questions, three different owners, and an exemption touches exactly one:

| question | owned by | an ADR 0018 exemption |
|---|---|---|
| Is the property proven? | the proof verdict (D1–D7 here) | **never changes it.** A missing capability stays `inadmissible`, exempted or not |
| Is this criterion's negative control required? | ADR 0018 D1/D2 | **this, and only this** — per criterion, four named reasons, named authorizer |
| May Work be accepted when every required criterion is exempted? | ADR 0018 D4 | attestation-only; the verification cannot carry Work to `ready` without independent review |

So an ADR 0018 exemption does not prove a capability exists, does not waive artifact identity, does
not waive execution, and does not turn missing physics into proof. It remains visible as
exempted/attestation evidence under ADR 0018's own semantics.

**There is no general proof-requirement exemption in v1**, and this ADR does not create one. If the
fleet ever wants one it requires a separate, explicit authority decision. This ADR also makes **no
amendment to ADR 0018** — narrowing ruling 4 was the correct repair precisely because extending
ADR 0018 by implication would have manufactured the authority fiction this ADR exists to eliminate.

## What is deferred, and why enforcement cannot ship

**Runtime admissibility enforcement cannot ship until the executable mechanics are resolved.** Board
acceptance is unchanged by this ADR and must stay unchanged until a further ADR, with its own review
and its own guards, settles the items below. A Work item citing a property with no proof at all is
accepted today exactly as it was yesterday.

These are known unsoundness in the working design, not open questions of taste. Each was found by
exact-head review of `docs/PROOF_ADMISSIBILITY_0_1.md` and none is fixed there:

1. **A declared probe arm can be omitted and the attestation still derive success.** When a
   capability declares the optional `work` arm, an attestation carrying only `present` and `control`
   results still derives `discriminated`. That defeats D2's own reason for the third arm: a
   containment mechanism that blocks legitimate work can omit the failing observation and still
   satisfy the capability. The derivation must require a result for **every arm the current
   capability definition declares**.
2. **The program digest is not bound to program content.** The working design compares two
   independently writable digest fields and defines neither a canonical digest recomputation nor a
   resolver guaranteeing the returned bytes hash to the lookup key. A malformed bundle can retain
   the required digest while changing the expected outcomes to match its own receipt. A content
   address must be *verified*, not compared.
3. **Duplicate capability definitions are not rejected.** For a required set `{A, B}`, a bundle
   carrying `[A, A]` satisfies the cardinality invariant while the definition for `B` is absent,
   contradicting the closed-bundle claim. Set comparison must run in both directions and reject
   duplicate ids.
4. **The working design's state table still derives a verdict from a field the same document
   deletes.** Documentation drifting from design inside one change. This ADR no longer carries that
   table — the table is mechanics — but the drift remains in the working design and is not repaired
   there.

Beyond those four, the whole of the schema, the reason vocabulary, the bundle shape, the event
additions, the ledger record change, and the implementation order are **unresolved**.

What is **not** deferred, and must not be read as an open question: there is no exemption path for a
missing physical capability. That is settled and closed — see "The scope of ADR 0018". A future
general proof-requirement exemption would need its own explicit authority decision, and no part of
this ADR anticipates one. They are
recorded in the working design as thinking, and none of them is authority.

## What is NOT closed

Stated plainly, because the non-goals of this work include claiming that doctrine is enforcement.

- **Nothing here is enforced.** Board acceptance is unchanged. A Work item citing a property with no
  proof at all is accepted today exactly as it was yesterday.
- **No probe is executed by anything.** There is no prober, no session, no adapter, and no code.
- **The measured `available()` defect is still present.** Making
  `MacosSandboxExecLauncher.available()` a real discriminating probe — write into a `mkdtemp`
  directory, observe the effect rather than the exit code, require the uncontained control to
  succeed — depends on nothing else in this ADR and should not wait for it.
- **No actor authentication exists in this repository, and this ADR adds none.** Anyone who can
  write a catalog can name a human as its author. The same caveat already applies to ADR 0018's
  exemptions.
- **Discrimination does not make a probe correct.** It establishes that a probe distinguishes two
  states. It does not establish that they are the right two states — the same limit ADR 0018 records
  for negative controls, and it does not go away by being restated one level up.
- **Determinism is a contract, not a check.** A nondeterministic probe produces flapping
  attestations and nothing here catches it.
- **A capability whose probe cannot run on the merge-gate platform is not proven there.** That is
  correct and it is not coverage. `scripts/check-ci-parity.mjs:55-64` already declares this class of
  gap for containment; property proofs would widen it, and the widening must stay declared.
- **Freshness ultimately rests on a clock nobody attests.** D6 requires freshness to be observed
  rather than assumed, and the observation is still stamped from a machine clock. No monotonic or
  attested time exists in this repository.
- **A catalog is authority by convention.** Content-addressing proves bytes match what a manifest
  names; it does not prove the manifest is authorized. Placing catalogs beside
  `scripts/guard-manifest.json` (ruling 3) makes a change a reviewed diff, which is a review control
  and not a derivation.
- **Provenance would be classified, not authenticated.** Any local-versus-imported distinction is
  drawn by the boundary that classifies, not proved by a signature. D4 makes that acceptable for v1
  by *refusing* imported evidence rather than weighing it — the unauthenticated case is the one that
  gets rejected — and nothing here designs the authenticated alternative.

## References

- Non-authoritative working design: `../PROOF_ADMISSIBILITY_0_1.md`
- Issue #73; issues #62, #63, #65, #72, #11; PR #70 (active), PR #68, PR #71
- ADR 0013, ADR 0016, ADR 0017, ADR 0018, ADR 0019, ADR 0020
- `src/disposable.ts`, `src/sandbox.ts`, `src/verify/schema.ts`, `src/board.ts`, `src/schemas.ts`,
  `src/router.ts`, `adapters/local/sandbox.ts`, `adapters/local/command-worker.ts`,
  `test/containment.test.ts`, `scripts/check-ci-parity.mjs`
