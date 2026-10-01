# Getting Started

Status: current operator guide for private dogfood.

This guide documents the executable surface that exists now. It deliberately does not present the proposed `rhiz` CLI as shipped behavior.

## Prerequisites

- Git
- Node.js 20 or newer; repository dogfood and CI currently pin Node `24.19.0`
- npm `11.17.0` for parity with the repository `packageManager` and CI gate
- repository access to `werhiz/rhiz-harness`
- Codex CLI with a working ChatGPT/OpenAI login only when running the Codex canary or repository Work runner

The package is currently private and versioned `0.0.1-kernel.0`. Public installation commands in `DEVELOPER_EXPERIENCE_V1.md` describe the intended release experience, not the current pre-alpha installation path.

See [Compatibility and Versioning](COMPATIBILITY.md) for current pins and provider compatibility claims.

## Install dependencies

For a lockfile-exact dogfood checkout:

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

Use `npm install` only when intentionally changing dependencies/lockfile state. Do not silently upgrade optional peer host packages as part of unrelated work.

## Validate the repository

The canonical local gate is:

```bash
npm run check
```

The gate currently composes:

```text
portable boundary
+ generated barrel integrity
+ operator script checks
+ TypeScript build
+ test suite
+ guard falsifiability
+ falsifiability proofs
+ CI parity checks
```

A green unit test subset is not equivalent to a green Harness gate. Safety claims are only as strong as the proof path that exercises them.

Useful narrower commands:

```bash
npm run build
npm test
npm run check:portable-boundary
npm run check:guards
npm run proof:falsifiability
npm run check:ci-parity
```

## Run the real Codex canary

The canary proves a live Codex App Server worker can execute one bounded SHIP task through Crew and Guard, write only the contract-authorized path, record durable Guard evidence, and survive Ledger reopen.

```bash
npm run canary:codex
```

By default the adapter launches `codex`. Override the executable with:

```bash
RHIZ_CODEX_COMMAND=/path/to/codex npm run canary:codex
```

The self-hosted canary workflow currently pins `@openai/codex@0.148.0`. A passing canary proves the live host path exercised by that canary. It does not prove every provider, every capability, organizational acceptance, or a production deployment.

## Run verified Work against a real repository

The strongest current operator surface is:

```bash
npm run work:repository -- \
  --repo /path/to/target-repository \
  --contract /path/to/work.json \
  --verify /path/to/verification.json \
  --output /path/to/receipt.json
```

Optional arguments:

```text
--base <git revision>
--prepare <prepare.json>
--ledger <durable ledger directory>
--output <receipt.json>
```

Read [Repository Work Runner](REPOSITORY_WORK_RUNNER.md) before using this path. The runner has deliberately narrow semantics: SHIP Work only, a contract-bounded attempt budget, a Work creator record declaring `kind: "human"`, isolated Git worktrees, Guard-mediated writes, independent local-command verification, candidate preservation, durable Ledger replay, and no PR merge, deploy, or organizational acceptance. The Ledger is durable under Git metadata by default; `--ledger` chooses another location.

The runner's creator check validates the recorded actor kind. `ActorRef.kind` is self-declared audit metadata and is not human authentication. Current private dogfood relies on the operator boundary around contract creation; a public product surface must enforce real identity/permission before writing human-only actor claims.

## DSH adapter and product proofs

The repository also exposes DSH integration scripts:

```bash
npm run setup:dsh-products
npm run proof:dsh-products
npm run smoke:dsh
npm run smoke:dsh-products
```

DSH is the first Host, not the Rhiz domain model. Portable core code must remain usable without DSH installed.

## Package entry points

The package exports:

```text
@werhiz/rhiz-harness
@werhiz/rhiz-harness/codex
@werhiz/rhiz-harness/dsh
@werhiz/rhiz-harness/dsh-products
@werhiz/rhiz-harness/git-worktrees
@werhiz/rhiz-harness/local-verify
@werhiz/rhiz-harness/durable-ledger
```

See [API Reference](API_REFERENCE.md) for responsibilities and stability notes.

## Recommended first reading after setup

Read these in order:

1. [Architecture](ARCHITECTURE.md)
2. [Work Contracts](WORK_CONTRACTS.md)
3. [Execution Lifecycle](EXECUTION_LIFECYCLE.md)
4. [Security Model](SECURITY_MODEL.md)
5. [Verification and Acceptance](VERIFICATION_AND_ACCEPTANCE.md)

## Current product truth

The system already supports real contract-bounded execution and verification. The zero-ceremony user experience is still converging. Until the public CLI ships, prefer existing operator scripts and exported APIs over creating a second temporary command surface.
