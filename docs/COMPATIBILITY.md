# Compatibility and Versioning

Status: current pre-alpha compatibility guide. Package manifests, workflow pins, and adapter tests remain executable authority when this document and source differ.

## Current package status

```text
package: @werhiz/rhiz-harness
version: 0.0.1-kernel.0
visibility: private
module format: ESM
```

The package is pre-alpha and has not crossed the public compatibility boundary. Portable concepts are intentionally stable at the architecture level, while TypeScript APIs and adapter details may still change before a public release.

## Runtime toolchain

| Component | Current contract |
| --- | --- |
| Node.js package engine | `>=20` |
| Repository / CI Node pin | `24.19.0` from `.node-version` |
| npm package-manager pin | `11.17.0` |
| TypeScript dev dependency | `6.0.3` |
| Zod runtime dependency | `4.4.3` |
| Module system | ESM (`"type": "module"`) |

The package engine is the broad declared runtime floor. Repository CI and dogfood use the narrower pinned Node/npm toolchain. When diagnosing a discrepancy, reproduce first on the repository pins.

## Git

Git is required for the current repository Work path and Git worktree adapter.

The adapter depends on capabilities used for:

- detached isolated worktrees;
- exact revision/tree identity;
- changed-path inspection;
- Harness-owned candidate refs;
- rescue/verified-candidate preservation.

No portable Work contract requires Git in principle. Git is the current repository implementation beneath the portable workspace/artifact contracts.

## Codex App Server

The direct Codex adapter speaks the Codex App Server JSON-RPC protocol through a Rhiz-owned worker adapter.

Current live CI canary pin:

```text
@openai/codex 0.148.0
```

The self-hosted macOS canary installs that exact CLI version and requires an existing usable Codex login before running `npm run canary:codex`.

Local dogfood defaults to the `codex` executable on `PATH`. Override the executable path with:

```bash
RHIZ_CODEX_COMMAND=/absolute/path/to/codex npm run canary:codex
```

The repository Work runner uses the same Codex App Server adapter.

### Compatibility claim

The strongest current compatibility claim is the version exercised by the real canary. Other Codex CLI versions may work when they preserve the expected App Server protocol, but they are not considered proven merely because the process starts.

When changing the Codex pin:

1. run the full repository gate;
2. run the real Codex canary on the exact candidate;
3. confirm Guard native-tool mediation still occurs;
4. confirm workspace binding and changed-path enforcement;
5. confirm durable Guard evidence survives Ledger reopen;
6. update this document and release notes if the supported pin changes.

## DeepSeek Harness optional peers

DSH dependencies are optional peer dependencies so the portable package can function without DSH installed.

Current peer versions:

| Package | Version |
| --- | --- |
| `@deepseek-ai/cordis` | `4.0.1` |
| `@deepseek-ai/dsh-sdk-client` | `0.1.0-rc.8` |
| `@deepseek-ai/dsh-subagent` | `0.1.0-rc.8` |
| `@deepseek-ai/dsh-subagent-claude-code` | `0.1.0-rc.8` |
| `@deepseek-ai/dsh-subagent-codex` | `0.1.0-rc.8` |
| `@deepseek-ai/dsh-subprocess` | `0.1.0-rc.8` |
| `@deepseek-ai/dsh-subprocess-local` | `0.1.0-rc.8` |

DSH-specific operator paths include:

```bash
npm run setup:dsh-products
npm run proof:dsh-products
npm run smoke:dsh
npm run smoke:dsh-products
```

The root portable import must remain usable without these peers installed.

## Operating systems

The portable TypeScript contracts are designed to be host-independent. Concrete integrations have narrower proof coverage.

### Current proven/used environments

- Kernel CI runs on every pull request and push to `main` in the GitHub
  Actions environment defined in `.github/workflows/kernel.yml`. The darwin
  containment suites and the Codex canary are proven by the independent check
  described in `docs/AGENT_PROOF_AND_CI_SPEND.md`.
- The real Codex App Server canary runs on a self-hosted macOS runner.
- Git worktree behavior depends on a compatible Git installation.
- OS containment depends on an available concrete `SandboxLauncher` for the host platform.

A feature that requires containment must fail closed when the platform launcher is unavailable. Do not translate "portable interface" into "every operating system has a proven containment implementation."

## Package exports

Current public-shaped entry points inside the private package are:

```text
@werhiz/rhiz-harness
@werhiz/rhiz-harness/codex
@werhiz/rhiz-harness/dsh
@werhiz/rhiz-harness/dsh-products
@werhiz/rhiz-harness/git-worktrees
@werhiz/rhiz-harness/local-verify
@werhiz/rhiz-harness/durable-ledger
```

See [API Reference](API_REFERENCE.md) for responsibilities.

## Versioning before public release

The current version `0.0.1-kernel.0` signals pre-release development. Until the first declared public compatibility line:

- exact package and workflow pins are the compatibility authority;
- portable architecture changes still require appropriate ADR/constitutional discipline;
- serialization and durable-event changes deserve migration thought even at `0.x`;
- adapter internals may change faster than Work/Board/Ledger meaning;
- a successful build on an untested provider/runtime version is evidence of compatibility for that run, not a project-wide support promise.

## Public compatibility policy to establish before release

Before public alpha, define and publish:

- supported Node line(s);
- npm/package-manager expectations;
- supported Codex CLI/App Server version range;
- supported DSH peer range;
- tested OS matrix;
- containment availability by OS;
- duration of prerelease support;
- deprecation policy for package exports and durable event schemas;
- migration policy for breaking Work/Event/Rule/verification contract changes.

The [Open Source Release Checklist](OPEN_SOURCE_RELEASE_CHECKLIST.md) treats compatibility documentation and clean-install proof as release gates.
