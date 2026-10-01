# DSH Product Worker Operator Proof v0

This gate proves that the locally authenticated Codex and Claude Code products can execute the same bounded Rhiz `WorkContract` through DSH without changing the source repository or their disposable proof workspaces.

It is an operator proof, not a CI credential test. Credentials and native account state remain local.

## What the command does

For each product route, Rhiz:

1. creates a disposable detached Git worktree from the same exact HEAD;
2. constructs one shared read-only `SCOUT` WorkContract;
3. starts the canonical `worker:codex` or `worker:claude` route through DSH;
4. requires the final answer to echo a unique nonce and the exact HEAD;
5. records validated observations and the portable WorkerResult;
6. projects the event stream through Board;
7. requires Board to reach `verifying`, never `accepted`;
8. fingerprints the disposable worktree before and after execution;
9. removes the disposable worktree;
10. fingerprints the source workspace again and fails if anything changed.

The receipt stores hashes and booleans rather than raw worker summaries. Credential values are never included.

## Install the pinned local runtime

From the Rhiz Harness repository:

```sh
npm ci
npm run setup:dsh-products
```

The setup command installs the pinned DSH, Codex, and Claude Code runtime closure under:

```text
.context/rhiz-harness/dsh-products
```

This directory is ignored by Git. The install is intentionally separate from the repository package lock because the product payloads are large, platform-specific operator dependencies.

## Authentication

The product providers use the products' native account and project configuration.

Codex may use its existing local login. `OPENAI_API_KEY` is passed explicitly only when it already exists in the launching environment.

Claude Code may use its existing local login. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are passed explicitly only when they already exist in the launching environment.

The setup and proof commands never write credential values to the receipt.

## Run the proof

```sh
npm run proof:dsh-products
```

To save the JSON receipt outside the repository:

```sh
RHIZ_DSH_PRODUCT_PROOF_OUTPUT="$HOME/rhiz-dsh-product-proof.json" \
  npm run proof:dsh-products
```

The output path must be outside the repository.

## Required success state

Both worker receipts must prove:

```text
outcome               finished
nonceEchoed           true
headEchoed            true
observationCount      at least 2
boardState             verifying
violationCount         0
artifactCount          0
evidenceCount          0
workspaceUnchanged     true
```

The source workspace must also remain byte-identical according to the proof fingerprint.

The command exits nonzero when either route is unavailable, unauthenticated, produces no final answer, changes its worktree, leaves Board in the wrong state, fails to echo the nonce or HEAD, or reports projection violations.

## Native safety modes

The proof uses:

- Codex: `never`
- Claude Code: `plan`

Claude plan mode is selected specifically for this read-only gate. Production SHIP routes will require separate authority, Guard, and workspace-isolation proof.

## What this proves

This proof establishes that:

- the named local product route exists;
- the product can execute through DSH;
- Rhiz can validate its portable result;
- the exact WorkContract remains shared across both routes;
- Board advances to verification rather than accepting worker claims;
- the repository and disposable workspaces remain unchanged.

It does not prove SHIP authority enforcement, autonomous repairs, cost quality, routing superiority, artifact collection, or independent verification quality. Those remain later gates.
