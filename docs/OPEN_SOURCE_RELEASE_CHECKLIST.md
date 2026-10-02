# Open Source Release Checklist

Status: release gate for the intended public Rhiz Harness open-source release.

Rhiz Harness is a public alpha under Apache-2.0 (decided by the founder on 2026-10-01). A further release claim, such as a published npm package or a supported release line, is earned only when repository, package, legal, security, documentation, provenance, and distribution state agree.

## Release principle

Do not announce the Harness as open source while any of these remain true:

- GitHub repository is private;
- package is marked `private`;
- no license has been selected and committed;
- public contribution/security processes are absent;
- the older embedded Harness authority in Rhiz Protocol still creates an ambiguous product boundary;
- public install instructions do not work from a clean machine;
- public documentation describes proposed behavior as shipped;
- provenance or upstream license obligations are unresolved.

## 1. Product boundary

- [x] Confirm `werhiz/rhiz-harness` is the canonical standalone Harness repository.
- [ ] Confirm Rhiz Protocol consumes Harness rather than owning a competing portable Harness implementation.
- [ ] Inventory the older `rhizprotocol/harness/` corpus and identify live callers.
- [ ] Move organization-specific Rules into a Rhiz Protocol-owned Rule catalog/plugin.
- [ ] Reconcile generated instruction/CI obligations that still depend on the old Harness.
- [ ] Retire or clearly deprecate obsolete duplicate runtime/compiler paths only after consumers migrate.
- [x] Confirm the standalone package has zero Rhiz Protocol dependency.

## Publication record (2026-10-01)

- License: Apache-2.0, chosen by the founder. `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md` are present, and `test/package-consumer.test.ts` fails if a package build drops them.
- Provenance re-verified against each upstream's own LICENSE. Two records were wrong and are corrected in place: LangChain is MIT, not Apache-2.0; the DSH npm packages declare BSD-3-Clause, while their repository declares MIT. The OpenAI Codex NOTICE that the Guard and Context derivations inherit is now carried in `NOTICE`.
- History is fresh. A full audit of the private repository, covering every reachable ref, every pull-request ref, and every PR and issue body, found customer-private evidence in a closed pull request. GitHub keeps pull-request refs after a branch is deleted, so that repository could not be made public safely. It remains private as the archive. This repository starts from a scrubbed export of its `main`. Repository paths, private branch names, private issue links, customer brand identifiers in fixtures, and billing figures were removed or generalized; no behavior changed.
- The npm package stays `private` until a publication decision is made.

## 2. License and legal

- [x] Select the project license with counsel/founder approval.
- [x] Add the exact `LICENSE` file.
- [x] Add package metadata for the chosen license.
- [x] Audit third-party source/adaptations against their licenses.
- [x] Confirm attribution and notice obligations.
- [ ] Confirm trademarks/brand usage policy if needed.
- [x] Verify every provenance manifest has a resolvable upstream identity and license classification.

This checklist deliberately does not choose a license. That is a legal/product decision and should not be inferred from the intent to open source.

## 3. Repository visibility and governance

- [x] Make repository public only after the preceding legal checks are complete.
- [ ] Keep `CONTRIBUTING.md` current.
- [x] Keep `SECURITY.md` current with a private vulnerability reporting channel.
- [x] Adopt and publish `CODE_OF_CONDUCT.md`.
- [x] Configure issue templates for bug, security-redirection, feature, and architecture proposals.
- [x] Configure pull-request template with proof and authority checkboxes.
- [ ] Document maintainer and merge authority.
- [ ] Protect `main` with required Kernel CI checks on the exact head, now that
      hosted CI runs on every pull request.
- [x] Require maintainer approval before any external contributor's workflow
      runs (`all_external_contributors`).
- [ ] Confirm no organization runner group allows public repositories.
- [ ] Require review for architecture/security boundary changes.
- [ ] Protect release tags.

## 4. Package publication

Current package state is `@werhiz/rhiz-harness`, version `0.0.1-kernel.0`, with `private: true`.

Before publication:

- [ ] Decide final npm package name and scope.
- [ ] Remove `private: true` only in the release change.
- [ ] Set `license`, `repository`, `homepage`, `bugs`, and `funding` metadata as applicable.
- [ ] Confirm files included in the published tarball.
- [ ] Exclude private fixtures, credentials, internal-only artifacts, and accidental repository data.
- [ ] Verify every declared export exists in the built package.
- [ ] Verify TypeScript declarations for every public export.
- [ ] Verify optional peer-dependency behavior on a clean environment.
- [ ] Publish a prerelease version first.
- [ ] Install the actual published tarball/package in a clean test project.
- [ ] Run the public quickstart against that installed artifact.

## 5. Install experience

The intended Developer Experience describes npm/npx and later single-binary/brew paths. Public docs must match what actually ships at release.

Minimum public-alpha proof:

- [ ] one supported install command works from a clean documented environment;
- [ ] Node version requirement is explicit when Node is required;
- [ ] no hidden monorepo dependency is needed;
- [ ] no private registry is required;
- [ ] no private repository import is required;
- [ ] first executable example completes end to end;
- [ ] unconfigured optional providers fail clearly;
- [ ] one healthy provider is sufficient for the supported quickstart;
- [ ] uninstall leaves no hidden daemon/process behind.

## 6. Documentation

- [ ] `README.md` reflects current public status.
- [ ] `docs/README.md` is the canonical documentation index.
- [ ] Getting Started has been executed from a clean environment.
- [ ] Architecture accurately matches code and accepted ADRs.
- [ ] Work/authority/verification/acceptance concepts are documented.
- [ ] Security model is public and claim-bounded.
- [ ] Current providers/hosts and compatibility ranges are documented.
- [ ] API reference matches generated declarations.
- [ ] Repository Work runner or public CLI guide has a real copy-paste example.
- [ ] Troubleshooting covers common auth, workspace, Guard, Verify, Board, and Ledger failures.
- [ ] Current identity/authorization limitations are stated anywhere `ActorRef.kind` could be mistaken for authentication.
- [ ] Proposed features are labeled proposed.
- [ ] Historical reviews are not presented as current status.
- [ ] All internal links resolve.
- [ ] No private URLs, tokens, emails, customer data, or inaccessible evidence paths remain in public docs.

## 7. Security

- [ ] Threat model reviewed against the public execution paths.
- [ ] Worker OS containment claims match shipped mechanisms.
- [ ] Verifier containment claims match shipped mechanisms.
- [ ] Guard native-tool mediation tested on every advertised write-capable provider.
- [ ] Unknown provider capability fails closed.
- [ ] Workspace binding is required and tested.
- [ ] Write-scope escape is tested.
- [ ] Tainted dependency output remains outside downstream instruction strings.
- [ ] Credential environment handling is reviewed.
- [ ] Durable Guard records do not persist raw secrets/tool bodies by default.
- [ ] Negative controls run in disposable derivatives and cannot mutate canonical candidates.
- [ ] Every declared guard has a passing falsifier.
- [ ] Human-only decisions are bound to authenticated identity rather than trusting self-declared `ActorRef.kind`.
- [ ] Any public acceptance surface enforces organization-level acceptance permission before emitting `work.accepted`.
- [ ] Any acceptance/merge/publish surface proves it is acting on the intended verified candidate when mutable state can change after verification.
- [ ] Dependency audit completed.
- [ ] Vulnerability reporting path tested before visibility changes.

## 8. Proof and CI

Before the release tag:

```bash
npm run check
```

must be green on the exact release candidate.

Also prove the relevant live integrations on the exact candidate:

- [ ] Codex App Server canary passes when advertised.
- [ ] DSH smoke/proof paths pass when advertised.
- [ ] repository Work runner succeeds against at least one clean external fixture/repository.
- [ ] exact-SHA CI is green.
- [ ] no required guard is skipped in release CI.
- [ ] CI parity check is green.
- [ ] build starts from clean `dist`.
- [ ] generated barrel is current.
- [ ] portable-boundary check is green.

## 9. Benchmarks and claims

- [ ] Establish at least one reproducible benchmark case.
- [ ] Record agent-alone baseline where fair.
- [ ] Record Rhiz Harness result on same Work/base/provider where practical.
- [ ] Count human interventions honestly.
- [ ] Keep failed/interrupted attempts in aggregates.
- [ ] Bind benchmark claims to exact Harness version.
- [ ] Avoid broad autonomy/performance claims from a single task class.

The first public release may precede a sweeping performance claim. Public claims should never outrun evidence.

## 10. Provenance

- [ ] Run provenance inventory across source and docs.
- [ ] Confirm invented, adapted, derived, vendored, and integrated work are distinguishable.
- [ ] Confirm copied algorithms/code preserve required notices.
- [ ] Confirm external design inspiration has not been represented as original implementation when materially derived.
- [ ] Ensure provenance manifests do not expose private credentials or inaccessible internal paths as the only supporting evidence.

See [Provenance](PROVENANCE.md).

## 11. Release artifact

- [ ] Version chosen under documented prerelease/version policy.
- [ ] Changelog/release notes generated from the actual release diff.
- [ ] Release commit/tag points to the exact tested tree.
- [ ] npm artifact digest recorded.
- [ ] GitHub release references the same tag.
- [ ] install verification uses the published artifact, not a local checkout.
- [ ] rollback/unpublish policy is understood before publication.

## 12. Public alpha exit criteria

A reasonable public-alpha gate is:

```text
public repository
+ explicit license
+ publishable package
+ clean install
+ one real bounded Work path
+ Guard enforcement
+ exact-target independent verification
+ authenticated authority for consequential human-only decisions
+ durable Ledger replay
+ contribution/security process
+ green exact-SHA proof gate
+ truthful documentation
```

Public alpha does not require every proposed CLI feature or every future Host. It requires the part being released to be coherent, safe enough for its stated use, and reproducible by someone outside WeRhiz.

## Release owner sign-off

Before changing visibility or publishing the package, record explicit sign-off for:

- product boundary;
- license/legal;
- security;
- release candidate SHA;
- CI/proof status;
- package artifact identity;
- documentation truthfulness;
- known limitations.

The release should be a durable organizational decision, not an accidental side effect of toggling repository visibility or package metadata.
