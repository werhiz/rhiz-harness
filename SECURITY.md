# Security Policy

Rhiz Harness executes coding agents and tools against repositories. Security reports that affect authority, containment, credentials, artifact identity, verification, durable evidence, actor identity, or provider boundaries are treated as product-critical.

## Current release status

Rhiz Harness is a public alpha. No release line is supported yet; fixes land on `main`.

When versioned prereleases begin, this file will list supported release lines and their security-fix policy explicitly.

## Report vulnerabilities privately

Do not open a public GitHub issue containing exploit details, credentials, sensitive repository contents, or a working bypass of a Harness security boundary.

Report it through GitHub's private vulnerability reporting for this repository: the **Security** tab, then **Report a vulnerability**. That channel is visible only to maintainers.

Include enough information to reproduce the issue safely:

- affected commit/version;
- affected Host/provider/adapter;
- Work type and authority boundary involved;
- expected behavior;
- actual behavior;
- minimum reproduction;
- whether the issue caused a real external effect or was contained to a proof fixture;
- relevant logs/evidence with secrets removed;
- whether the issue remains reproducible on current `main`.

Never include live credentials unless a maintainer explicitly provides an approved secure channel for them.

## High-priority vulnerability classes

Examples include:

- worker escapes `writeScope` without the Harness detecting it;
- provider executes outside the supplied workspace binding;
- a Guard `forbid` is ignored by a write-capable provider;
- shell/network/credential/external mutation occurs without required authority;
- SCOUT or REVIEW gains production mutation capability;
- executing worker can satisfy an independence requirement for verification/review/acceptance through identity confusion;
- proof for one candidate is accepted for another candidate;
- verifier or negative control mutates the canonical target;
- a vacuous verifier is accepted as falsifiable proof;
- untrusted dependency/model output reaches a downstream instruction/authority channel;
- credentials or sensitive raw tool arguments are persisted unexpectedly in durable evidence;
- Ledger corruption or replay behavior can silently change organizational state;
- a runtime observation silently overwrites Board canonical state;
- an agent/service actor can obtain a human-only decision path by supplying `ActorRef.kind = "human"` without real authentication;
- a product surface emits `work.accepted` without enforcing its organization-level identity/permission policy;
- containment claims are reported as active when the real boundary was not established.

## Actor identity boundary

`ActorRef.kind` is self-declared audit metadata in the portable schema. It is not an authentication factor and does not prove permission to perform a human-only action.

Board currently enforces acceptance readiness and refuses acceptance by actors that executed the Work. A concrete product or integration that exposes acceptance, exemptions, provider authorization, or another human-only decision must authenticate the person and enforce organization-level permission before recording the portable actor claim or decision event.

## Security model

Read [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) before evaluating a report. It defines the current trust assumptions and layers:

```text
WorkContract authority
+ provider capability classification
+ workspace binding
+ containment
+ Guard mediation
+ write-scope validation
+ tainted-data separation
+ exact artifact identity
+ independent verification
+ falsifiability
+ Board acceptance readiness and executor exclusion
+ authenticated product authority for human-only decisions
+ durable replayable evidence
```

A report is valuable when it shows one of those layers does not establish the property the project claims it establishes.

## Safe reproduction

Prefer a disposable fixture/repository with fake credentials and no production services.

Do not test an authority bypass against third-party systems, customer repositories, production infrastructure, or accounts you do not own or have explicit authorization to test.

For mutation/falsifier tests, use the Harness disposable-derivative path rather than intentionally corrupting a canonical candidate.

## Handling secrets

When sharing evidence:

- redact API keys, tokens, cookies, session material, private keys, and credentials;
- minimize proprietary source excerpts;
- prefer digests, bounded summaries, and synthetic fixtures;
- do not paste raw durable Ledger files publicly when they may contain sensitive evidence references;
- invalidate/rotate credentials immediately if real secrets were exposed.

## Fix standard

A security fix should normally include:

1. a minimal reproduction of the defect;
2. the mechanical boundary that failed;
3. a fail-closed repair;
4. an executable regression test;
5. a falsifier when the change declares a Guard/security invariant;
6. documentation/ADR updates when the security claim or authority model changes;
7. provenance review when upstream code is involved;
8. exact validation commands and candidate SHA.

Stronger prompt wording alone is insufficient for a consequential authority defect.

## Disclosure

The project will coordinate disclosure after a fix and affected-release analysis exist. Public details should explain the affected boundary, impact, fixed versions/commits, and any operator action required without exposing unrelated private data.

During pre-alpha, there is no promised stable security-support window. Public release policy will be added before the first supported public release.
