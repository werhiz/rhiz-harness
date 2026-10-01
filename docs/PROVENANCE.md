# Open-Source Provenance and Upstream Policy

Rhiz Harness is intended to become an open-source project that learns aggressively from the best systems in the ecosystem while remaining able to explain exactly what it owns and what it inherited.

This document is architectural policy, not legal advice. License compatibility must be verified before public redistribution.

## Adoption strategies

Every meaningful upstream relationship is classified as one of:

- `inspiration`: concept studied; no source code copied.
- `adapted`: implementation written by Rhiz from a documented idea/API with material Rhiz-specific design.
- `derived`: Rhiz code is based on upstream source and retains required attribution/license notices.
- `vendored`: upstream code is included substantially as-is.
- `dependency`: upstream package/library is consumed through its published interface.
- `backend`: upstream executable/service remains a replaceable external implementation behind a Rhiz interface.

The classification must reflect reality, not marketing preference.

## Required provenance record

Before adapted/derived/vendored source enters the public project, record:

```yaml
source_repository: owner/name
upstream_commit: <sha>
license: <SPDX expression>
strategy: inspiration | adapted | derived | vendored | dependency | backend
upstream_paths: []
rhiz_paths: []
purpose: <what capability we use>
material_changes: []
reviewed_at: <date>
reviewed_by: <actor>
```

A future machine-readable registry should live under `provenance/` and generate human-readable notices.

## License posture

The intended Rhiz Harness core license is Apache-2.0, subject to formal review before public release.

Permissive upstream licenses such as Apache-2.0, MIT, BSD, and ISC are generally compatible candidates, but the exact license and notice obligations must still be recorded.

Copyleft, source-available, custom, ambiguous, or missing licenses require explicit review before code reuse. When license compatibility is unclear, treat the project as inspiration only until resolved.

## Preliminary upstream map

These are research conclusions, not permission to copy code blindly. Re-verify the exact repository, commit, and license before import.

| Project | Preliminary role in Rhiz | Strategy preference |
| --- | --- | --- |
| DeepSeek Harness | first execution host, plugin/capability architecture | dependency/backend through DSH HostAdapter; derive only if evidence later justifies it |
| Herdr canonical repo | persistent process/session/runtime patterns | study first; selectively derive generic runtime pieces only with recorded provenance |
| First Mate | crew supervision, worktrees, SCOUT/SHIP patterns, mechanical watcher ideas | primarily adapted concepts; selectively derive small utilities if clearly superior |
| HAR | exact-tree verification, work/run identity, validation control-plane patterns | adapted concepts and compatibility inspiration |
| Aider | repository mapping and context-selection ideas | inspiration/adapted concepts |
| OpenCode / Goose | worker/provider interoperability and UX/plugin patterns | backend compatibility + inspiration |
| OpenHands / E2B | sandbox/remote execution patterns | backend compatibility + inspiration |
| SWE-agent | benchmark and agent-computer-interface methodology | inspiration |

## Upstream update loop

Rhiz should continuously monitor selected upstreams, but never blindly merge them.

```text
upstream change
  → classify relevance
  → inspect license/provenance impact
  → SCOUT technical delta
  → compatibility tests
  → benchmark when performance-relevant
  → REVIEW proposal
  → adopt / reject / defer with evidence
```

The long-term upstream registry should track repository, pinned commit/version, latest known version, license, capabilities studied/derived, compatibility status, last review, and benchmark impact.

## Attribution artifacts

Before public distribution, the project should generate and verify:

- `LICENSE`;
- `NOTICE` when required;
- `THIRD_PARTY_NOTICES.md`;
- machine-readable provenance registry;
- dependency-license report;
- a guard preventing unregistered derived/vendored paths from shipping.

## Rule of restraint

Rhiz does not become better by owning the most code. Prefer the smallest amount of upstream-derived code necessary to create a durable Rhiz capability. Keep excellent external systems as replaceable dependencies/backends when doing so preserves leverage and reduces maintenance.
