# Examples

Status: current examples for the shipped pre-alpha contracts. Validate copied JSON with the current parsers before using it against valuable repositories.

Actor records in these examples are audit data. `kind: "human"` is a schema label, not proof that the actor was authenticated or authorized. A real product surface must enforce identity and organizational permission before recording human-only decisions or exceptions.

## Example 1: one bounded repository change

This example asks the Harness to create one file with exact contents, then independently verifies that exact candidate with a positive check and a negative control.

### Work contract

Save as `work.json`:

```json
{
  "id": "work:example-message",
  "objective": "Create src/message.txt containing exactly RHIZ EXAMPLE PASS and do not change any other path.",
  "type": "SHIP",
  "scope": [
    {
      "uri": "repo://target",
      "kind": "repository"
    }
  ],
  "writeScope": [
    {
      "uri": "repo://target/src/message.txt",
      "kind": "file"
    }
  ],
  "nonGoals": [
    "Do not modify any path except src/message.txt.",
    "Do not access external services."
  ],
  "authority": {
    "grants": [
      {
        "action": "read",
        "resources": [
          {
            "uri": "repo://target",
            "kind": "repository"
          }
        ],
        "constraints": []
      },
      {
        "action": "write",
        "resources": [
          {
            "uri": "repo://target/src/message.txt",
            "kind": "file"
          }
        ],
        "constraints": []
      }
    ],
    "requiresHumanApproval": []
  },
  "acceptanceCriteria": [
    {
      "id": "criterion:message",
      "description": "src/message.txt exists and contains exactly RHIZ EXAMPLE PASS.",
      "required": true
    }
  ],
  "requiredEvidence": [
    {
      "id": "evidence:message-check",
      "description": "A deterministic command independently checks the exact file contents.",
      "acceptedKinds": ["test"],
      "required": true
    }
  ],
  "context": {
    "strategy": "minimal",
    "resources": [],
    "includeHistory": false
  },
  "dependencies": [],
  "workerPolicy": {
    "preferredProviders": ["worker:codex-app-server"],
    "maxAttempts": 1,
    "allowParallelAttempts": false,
    "explicitProviderAuthorizations": []
  },
  "verificationPolicy": {
    "required": true,
    "independentActor": true,
    "reviewRequired": false,
    "falsifiabilityExemptions": []
  },
  "createdBy": {
    "id": "human:example-operator",
    "kind": "human",
    "displayName": "Example Operator"
  },
  "createdAt": "2026-08-28T20:00:00-04:00"
}
```

### Verification plan

Save as `verify.json`:

```json
{
  "id": "verification-plan:example-message",
  "workId": "work:example-message",
  "contractRevision": 1,
  "checks": [
    {
      "id": "check:message",
      "providerId": "verifier:local-command",
      "description": "Read src/message.txt and require the exact expected content.",
      "criterionIds": ["criterion:message"],
      "requirementIds": ["evidence:message-check"],
      "config": {
        "command": "node",
        "args": [
          "-e",
          "const fs=require('node:fs'); const v=fs.readFileSync('src/message.txt','utf8').trim(); process.exit(v==='RHIZ EXAMPLE PASS'?0:1);"
        ],
        "expectedExitCodes": [0],
        "timeoutMs": 30000,
        "maxOutputBytes": 65536,
        "evidenceKind": "test"
      }
    },
    {
      "id": "control:message",
      "providerId": "verifier:local-command",
      "description": "Prove the same check fails when the message is deliberately wrong.",
      "criterionIds": [],
      "requirementIds": [],
      "negativeControlFor": "check:message",
      "perturbation": {
        "description": "Replace the expected message with known-wrong content in the disposable derivative.",
        "kind": "overwrite-file",
        "path": "src/message.txt",
        "content": "WRONG\n"
      },
      "config": {
        "command": "node",
        "args": [
          "-e",
          "const fs=require('node:fs'); const v=fs.readFileSync('src/message.txt','utf8').trim(); process.exit(v==='RHIZ EXAMPLE PASS'?0:1);"
        ],
        "expectedExitCodes": [0],
        "timeoutMs": 30000,
        "maxOutputBytes": 65536,
        "evidenceKind": "test"
      }
    }
  ]
}
```

The primary and negative control intentionally use the exact same provider configuration. The only behavioral difference is the declared perturbation applied to the disposable derivative.

### Run

From the Rhiz Harness checkout:

```bash
npm run work:repository -- \
  --repo /path/to/target-repo \
  --contract /path/to/work.json \
  --verify /path/to/verify.json \
  --output /path/to/receipt.json
```

Expected successful end state:

```text
candidate preserved
verification pass
negative control detects WRONG
verified candidate ref exists
integration checkpoint recorded
Board state ready
accepted false
Ledger reopens and replays cleanly
```

The final `accepted false` is expected. The runner does not own organizational acceptance.

## Example 2: preparation without hidden source mutation

If a target repository requires dependencies before execution, save:

```json
{
  "command": "npm",
  "args": ["ci", "--ignore-scripts"]
}
```

as `prepare.json`, then run:

```bash
npm run work:repository -- \
  --repo /path/to/target-repo \
  --contract work.json \
  --verify verify.json \
  --prepare prepare.json
```

Preparation happens before baseline identity is pinned. The runner refuses preparation that changes tracked source or moves `HEAD`.

## Example 3: SCOUT contract shape

SCOUT is read-only by schema and policy. This shape is useful when composing Crew programmatically:

```json
{
  "id": "work:find-auth-boundary",
  "objective": "Identify where authentication tokens enter the request path and return evidence-backed findings.",
  "type": "SCOUT",
  "scope": [
    { "uri": "repo://target", "kind": "repository" }
  ],
  "writeScope": [],
  "nonGoals": ["Do not modify repository files."],
  "authority": {
    "grants": [
      {
        "action": "read",
        "resources": [{ "uri": "repo://target", "kind": "repository" }],
        "constraints": []
      }
    ],
    "requiresHumanApproval": []
  },
  "acceptanceCriteria": [
    {
      "id": "criterion:auth-map",
      "description": "Findings identify the concrete token entry and propagation path with source references.",
      "required": true
    }
  ],
  "requiredEvidence": [],
  "context": {
    "strategy": "minimal",
    "resources": [],
    "includeHistory": true
  },
  "dependencies": [],
  "workerPolicy": {
    "preferredProviders": [],
    "maxAttempts": 1,
    "allowParallelAttempts": false,
    "explicitProviderAuthorizations": []
  },
  "verificationPolicy": {
    "required": true,
    "independentActor": true,
    "reviewRequired": true,
    "falsifiabilityExemptions": [
      {
        "criterionId": "criterion:auth-map",
        "reason": "human-judgment",
        "justification": "The completeness and correctness of the architectural finding requires independent review rather than a byte-level negative control.",
        "authorizedBy": {
          "id": "human:example-operator",
          "kind": "human"
        }
      }
    ]
  },
  "createdBy": {
    "id": "human:example-operator",
    "kind": "human"
  },
  "createdAt": "2026-08-28T20:00:00-04:00"
}
```

The current `work:repository` runner does not accept SCOUT. This example is for the portable Work/Crew APIs and future CLI surface. The falsifiability exemption records a claimed human owner; a real product must authenticate the person before it permits that exemption to be created.

## Example 4: programmatic durable Ledger

```ts
import { projectBoard } from "@werhiz/rhiz-harness";
import { DurableEventLedger } from "@werhiz/rhiz-harness/durable-ledger";

const ledger = await DurableEventLedger.open({
  directory: ".rhiz/ledger",
  ledgerId: "ledger:demo",
});

try {
  const events = await ledger.replay("work:demo");
  const board = projectBoard(events);
  const integrity = await ledger.integrity();

  console.log({
    state: board.state,
    violations: board.violations.length,
    ledgerHead: integrity.headDigest,
  });
} finally {
  await ledger.close();
}
```

## Example rules for production use

- Start with the smallest truthful `writeScope`.
- Give the verifier a real failure it can detect.
- Keep negative-control config identical to its primary check.
- Never put a negative-control perturbation on the canonical candidate.
- Preserve receipt and verified candidate identity for consequential runs.
- Treat Board `ready` as ready for a decision, not as implicit acceptance.
- Authenticate identity outside `ActorRef` before human-only decisions or exceptions.
- Use the current parsers as contract authority when an example and code differ.
