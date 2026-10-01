# Troubleshooting

Status: current private-dogfood troubleshooting guide.

Start with the smallest failing boundary. Rhiz Harness is intentionally layered, so a provider-auth failure, workspace-binding failure, Guard denial, verification failure, Board violation, and Ledger-integrity failure should be diagnosed as different problems.

## `npm run check` fails

Run the failing stage directly rather than repeatedly running the entire gate.

```bash
npm run check:portable-boundary
npm run check:barrel
npm run check:operator-scripts
npm run build
npm test
npm run check:guards
npm run proof:falsifiability
npm run check:ci-parity
```

### Portable boundary failure

Cause: portable core imported a concrete host, adapter, or organization-specific dependency.

Fix: move the concrete behavior behind a portable interface or into `adapters/`. Do not whitelist a convenience import that violates the dependency direction.

### Barrel failure

Cause: `src/index.ts` is generated/sorted and a new module was added without reconciling the barrel.

Fix:

```bash
node scripts/check-barrel.mjs --write
```

Review the resulting export before committing it.

### Guard falsifiability failure

Cause: a declared guard no longer has a passing discriminating proof, the manifest drifted, or the guard mechanism changed without its falsifier changing.

Fix the guard or the proof. Do not remove the guard from the manifest merely to make CI green unless the architectural protection itself is intentionally being retired and the relevant decision is updated.

## TypeScript build succeeds locally but tests behave strangely

The build step deletes `dist` before compiling. This is intentional. Stale compiled output can otherwise mask source mutations during proof/falsifiability tests.

Use the repository scripts rather than invoking old files directly from `dist`.

## Codex canary fails before worker execution

Run:

```bash
codex --version
```

Then confirm the CLI is authenticated in the same environment running the Harness.

Override the executable when needed:

```bash
RHIZ_CODEX_COMMAND=/absolute/path/to/codex npm run canary:codex
```

The canary expects a real App Server turn. A mocked provider does not satisfy this proof.

## Codex canary changes more than one file

The canary contract authorizes exactly one fixture path. Any other changed path is a real contract-boundary failure.

Inspect:

- mission `changedPaths`;
- Guard evaluations;
- worker activity observations;
- the bound worktree rather than your source checkout.

Do not broaden the canary write scope to accommodate unexplained writes.

## `repository Work runner v0 accepts SHIP Work only`

The current runner is deliberately SHIP-only. Use Crew/programmatic APIs for other Work forms during pre-alpha, or add a separately reviewed operator path rather than bypassing the runner check.

## `repository runner requires Work created by a human audit actor`

The current runner requires the creator record to declare `createdBy.kind = "human"`.

This validates an audit label, not authenticated identity. If the record is wrong, correct it rather than relabeling an agent to pass the check. Current private dogfood relies on the operator boundary around contract creation. A multi-user/public surface must authenticate and authorize the person before writing a human-only actor claim.

## `verification plan must target this Work at contract revision 1`

The plan's `workId` or `contractRevision` does not match the Work being executed.

Regenerate or correct the plan against the current contract. Proof for another Work or revision is not reusable by identity alone.

## Preparation fails

`--prepare` is trusted pre-baseline repository preparation. It may materialize ignored dependencies, but tracked source edits or `HEAD` movement are refused.

Use preparation for commands such as deterministic dependency installation. Move implementation changes into SHIP execution.

If lifecycle scripts mutate tracked files, use a safer install mode such as `--ignore-scripts` where compatible.

## No eligible worker provider

Inspect the provider descriptor and mission requirements.

Common causes:

- provider does not support the Work type;
- provider is missing a descriptor and is therefore treated conservatively;
- write access is `unrestricted` or `host-policy` where the mission requires bounded behavior;
- `bindsWorkspace` is false;
- `guardedToolMediation` is false for isolated-write Work;
- provider was excluded for REVIEW independence;
- provider authentication is unavailable at runtime.

An explicit provider-authorization record can address only the narrow exception defined by the schema. Its `authorizedBy.kind = "human"` field is an audit claim, so a real product must authenticate that approval before recording it. Even a valid approval record cannot manufacture workspace binding or Guard mediation.

## Workspace binding error

A worker must execute inside the absolute `WorkspaceBinding.executionRoot` it was given.

Do not add a fallback to `process.cwd()` for Crew-launched work. Fix the adapter so it honors the binding or declare `bindsWorkspace: false` and let selection reject it.

## Read-only Work changed the workspace

SCOUT and REVIEW must remain read-only under current Crew policy.

Treat drift as a failure. Identify whether it came from:

- worker execution;
- a tool or formatter;
- dependency install/setup happening at the wrong lifecycle stage;
- verifier mutation;
- host side effects.

Move unavoidable setup before baseline identity only when it is trusted preparation and does not alter tracked source.

## SHIP changed paths outside `writeScope`

The contract and actual candidate disagree.

Choose the truthful repair:

- narrow the implementation to the existing contract; or
- explicitly amend/create Work with the broader authorized scope if the additional changes are genuinely required.

Do not silently broaden `writeScope` after seeing what the agent happened to modify.

## Guard returns `forbid`

Read the verdict rationale, risk level, rule hits, and tool category.

A Guard denial means the effect is outside current policy. The normal paths are:

- change the implementation so it does not require the forbidden effect;
- change the Work authority through the authenticated organizational decision path that owns that authority;
- fix a misclassified tool or broken Guard rule with tests if the denial is technically wrong.

Do not tell the model to ignore the denial.

## Guard returns `prompt`

The policy requires a decision path. The provider must not treat `prompt` as automatic permission.

Current operator surfaces may require programmatic handling until the full `rhiz decide` experience ships. Any human-only prompt resolution still needs a real identity/permission boundary outside the self-declared ActorRef label.

## Dependency output appears to instruct a downstream worker

Dependency summaries and artifact claims must travel through `taintedAttachments`, never by concatenation into `objective`.

Check:

- `renderCrewMissionContext` output;
- `WorkerStartRequest.taintedAttachments`;
- adapter rendering under the untrusted-data section;
- guard `crew/dependency-output-is-not-spliced-into-objective`.

A regression here is a security defect.

## Verification primary check passes but negative control fails

This means the verifier did not demonstrate that it can distinguish the declared known-bad perturbation.

Common causes:

- test does not cover the perturbed behavior;
- verification command always exits successfully;
- perturbation targets the wrong file;
- test configuration ignores the changed file;
- the check is vacuous.

Strengthen the verifier or correct the perturbation. Do not invert the control expectation.

## Verification reports target drift

The candidate changed while or after it was being checked.

Discard the stale proof and rerun verification on the exact final candidate. Investigate the process that mutated the target because verifier paths are expected to be read-only.

## Board remains `verifying`

Execution completion alone leaves Work awaiting verification. Inspect verification events and required criterion/evidence coverage.

If verification passed but Board did not become ready, inspect projection violations, review requirements, open decisions, active lifecycles, and current-revision proof.

## Board is `ready` but not `accepted`

This is expected. `ready` means Board's current acceptance-readiness conditions are satisfied. It does not mean an authorized product decision has occurred.

The current repository runner intentionally stops with `accepted: false`. Board also refuses `work.accepted` from any actor that executed the Work. It does not authenticate actor identity or consult an organization-level permission registry, so any product surface that emits acceptance must supply that boundary itself.

## Projection violation appears

A durable event was recorded that Board refuses to use for a state mutation.

Treat the violation as evidence of a lifecycle or authority defect. Find the event, its actor, and the previous projected state. Fix the producer or sequence rather than teaching Board to accept an illegal transition without an architecture decision.

## Ledger is locked

Another live process may own the Ledger file.

Check the owning process before removing anything. `DurableEventLedger` can recover a stale lock when the recorded owner is no longer alive.

Do not run two independent writers against the same local Ledger file.

## Ledger reports a torn tail

The local durable implementation repairs an incomplete final record on open by default and records repaired tail bytes in its integrity report.

A repair is evidence that the prior process ended during append. Review the surrounding Work state before continuing consequential execution.

## Ledger integrity failure

Treat this as a high-severity durability defect.

Do not continue from a corrupted record chain as though state were trustworthy. Preserve the ledger directory, capture the error, and diagnose record/digest/sequence corruption before resuming Work.

## Candidate ref exists after a failed operator flow

This may be intentional rescue behavior. Inspect whether the ref is a WIP rescue or verified candidate and correlate it with the Work/Attempt receipt.

Never infer verification from the existence of a Git ref alone.

## CI and local results disagree

Use `npm run check:ci-parity` and confirm:

- same commit SHA;
- same Node/npm expectations;
- generated/stale `dist` is not involved;
- optional host credentials are not changing which paths execute;
- the exact workflow and local command invoke the same proof gates.

For live canaries, distinguish deterministic repository tests from credential-dependent external integration proof.

## Documentation contradicts code

Use the authority order:

1. Constitution;
2. shipped code and executable safety contracts;
3. Kernel/System Boundaries/Vocabulary;
4. accepted ADR;
5. design documents;
6. reviews/lessons.

If code violates a constitutional invariant, the code is a defect unless an explicit constitutional amendment has been made.

If a design document describes an unshipped experience, label it as proposed rather than rewriting current operator truth to match it.

## When to open an architecture issue

Escalate beyond a local fix when the problem would change:

- canonical fact ownership;
- Work meaning;
- authority boundaries;
- completion/verification/acceptance separation;
- host portability;
- Ledger/replay semantics;
- public command ontology;
- falsifiability policy;
- provenance obligations.

Those changes should be resolved through the ADR or constitutional process rather than buried in an implementation patch.
