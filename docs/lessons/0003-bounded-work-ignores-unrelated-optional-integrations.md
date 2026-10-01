# Lesson 0003: Bounded work must not depend on unrelated optional integrations

## Observation

The live Codex operator proof emitted a Stripe MCP OAuth refresh error because the user's unrelated Stripe refresh token was stale. Codex still completed the exact read-only WorkContract, returned the required nonce and HEAD, left the workspace unchanged, and produced a valid Rhiz proof receipt.

## Finding

A worker may load a broad personal or organizational capability environment even when a bounded Work item needs only repository inspection. Optional integration startup noise must not become canonical Work failure unless the integration is required by the contract or actually prevents the requested outcome.

## Mechanized direction

- Success gates evaluate exact Work acceptance facts rather than unrelated stderr.
- Worker observations preserve optional integration diagnostics as evidence.
- Future Context and Runtime isolation should construct the smallest required capability set for each mission.
- Crew and Router must distinguish required capability failure from optional capability degradation.

## Reusable rule

Bounded Work success is owned by its explicit contract, required capabilities, evidence, and end state. Unrelated optional integration failures remain diagnostics unless they obstruct those requirements.

## Compound destination

This lesson should later influence ContextPack capability selection, Host profiles, MCP isolation, and Router health scoring.
