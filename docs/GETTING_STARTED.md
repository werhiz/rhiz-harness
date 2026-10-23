# Getting Started

Status: current source-checkout guide for the public alpha and active dogfood.

This guide documents the executable surface that exists now. It deliberately does not present the proposed `rhiz` CLI as shipped behavior.

## Prerequisites

- Git
- Node.js 20 or newer; repository dogfood and CI currently pin Node `24.19.0`
- npm `11.17.0` for parity with the repository `packageManager` and CI gate
- a source checkout of the public `werhiz/rhiz-harness` repository
- Codex CLI with a working ChatGPT/OpenAI login only when running the Codex canary or repository Work runner

The repository is public alpha. The npm package is unpublished, versioned `0.0.1-kernel.0`, and protected by `private: true`. npm/npx distribution commands in `DEVELOPER_EXPERIENCE_V1.md` describe a proposed release experience. Use the source-checkout path below.

See [Compatibility and Versioning](COMPATIBILITY.md) for current pins and provider compatibility claims.

## Install dependencies

For a lockfile-exact source checkout:

```bash
git clone https://github.com/werhiz/rhiz-harness.git
cd rhiz-harness
npm ci --ignore-scripts --no-audit --no-fund
```

Use `npm install` only when intentionally changing dependencies/lockfile state. Do not silently upgrade optional peer host packages as part of unrelated work.

## First local contract example

This example needs no provider login and launches no worker. After dependency installation:

```bash
npm run build
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { parseWorkContract } from "./dist/src/index.js";
const examples = readFileSync("docs/EXAMPLES.md", "utf8");
const json = examples.match(/```json\n([\s\S]*?)```/)[1];
const work = parseWorkContract(JSON.parse(json));
console.log(`${work.id}: ${work.type}`);
JS
```

Expected output: `work:example-message: SHIP`. This parses the actual first [Work example](EXAMPLES.md) with the shipped contract validator. The documentation test also rejects the example when its Work type is invalid. Successful parsing establishes contract structure; worker execution, verification and acceptance require the separate operator path below.

If the build fails, check `node --version` and `npm --version` against the pins above and repeat the lockfile-exact install. See [Troubleshooting](TROUBLESHOOTING.md) for host, verifier and containment failures.

## Validate the repository

The canonical local gate is:

```bash
npm run check
```

The gate currently composes:

```text
CI trigger/spend policy
+ portable boundary
+ generated barrel integrity
+ operator script checks
+ TypeScript build
+ test suite
+ guard falsifiability
+ falsifiability proofs
+ CI parity checks
```

The full gate includes adversarial proofs and can take tens of minutes. A zero exit status is required; inspect reported platform skips and unavailable host proofs before making a broader claim.

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

The runner's creator check validates the recorded actor kind. `ActorRef.kind` is self-declared audit metadata and is not human authentication. The current operator path relies on the operator boundary around contract creation; any multi-user product surface must enforce real identity/permission before writing human-only actor claims. Public source availability does not supply that boundary.

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
