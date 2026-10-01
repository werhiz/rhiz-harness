# ADR 0012: Verifier execution containment and checked dormancy

Status: accepted for Verify v1.1 and the DSH product runtime

Refines Constitution §9 (authority is explicit and bounded) and §10 (mechanical supervision precedes cognitive supervision) at two seams where the Harness executes code it does not trust. Closes issues #17 and #19 from `docs/reviews/2026-08-20-stack-review.md`.

## Context

Two seams run untrusted code, and both were governed by assumption rather than by a checked property.

The local command verifier runs an explicit argv with no shell, which reads as conservative. In practice the command it runs is the repository's own test command, so the bytes executed are attacker-controlled whenever the repository under verification is. That process was handed `NODE_OPTIONS`, `NODE_PATH`, and the operator's `HOME`, and on timeout it was signalled as a single pid.

Dormant DSH composition disabled spawning by subclassing `SubprocessRuntime` and overriding three methods. The dependency is pinned to a `0.1.0-rc` prerelease, where internal renames are expected. A rename does not fail: it removes the override from the call path and restores spawning silently.

## Decision

### D1. The checked process is contained, not merely un-shelled

Environment forwarding is an allow list: `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `CI`. `FORBIDDEN_VERIFIER_ENV` enumerates loader and startup variables that are never inherited and are refused as operator overrides, so a verifier cannot be turned into an execution vector by its own configuration. `NEUTRALIZED_VERIFIER_ENV` forces git configuration to safe values after overrides are applied, so a hostile repository cannot reach the verifier through `core.pager`, `core.fsmonitor`, or an external diff driver.

`HOME` defaults to a disposable scratch directory removed on `close()`. The operator's home is the path to every ambient credential on the machine and is not a verification input.

### D2. A check owns a process group, and a leak is never a pass

Checks spawn detached. The timeout signals the group and escalates `SIGTERM` to `SIGKILL`. A group still alive after escalation is recorded as a process leak, and a leaking or timed-out check fails.

This is a correctness property, not only a hygiene one. A surviving process keeps writing to the workspace that Verify has already pinned as its exact target, which means a result recorded against that target is not a result about the artifact anyone will inspect.

### D3. Dormancy is a checked property, within a stated scope

Composition refuses any **named prototype** method that reaches a process and is not overridden, refuses a base that implements only part of the guarded surface, and asserts each guarded method resolves to the Rhiz implementation rather than the upstream one. Every failure is a `DshDormantCompositionError` at mount time.

**Amended 2026-08-21.** As first written this decision also required the guarded methods to exist on the upstream prototype. Upstream ships `SubprocessRuntime` as an ABSTRACT class whose execution surface is `abstract` declarations emitting no runtime body, so its prototype carries only `constructor` and that requirement could never be satisfied. It was not caught before merge because every fixture in `test/dormant-composition.test.ts` was a concrete class, so the suite was green against a shape the dependency does not have. The requirement is replaced by the partial-implementation refusal above, which is what an upstream rename actually looks like, and the abstract base is now the stronger case rather than the failing one: there is no inherited implementation for a dead override to re-expose.

The scope of that claim is narrow and is stated here rather than implied:

- **Prototype chain only.** An execution path assigned in the constructor (`this.spawnWorker = ...`) is invisible to the scan whatever it is named. The same function is refused on the prototype and accepted as an instance field. Enumerating instance fields would require constructing `Base`, which means executing upstream code to decide whether executing upstream code is safe, so the scan deliberately does not.
- **Name matching only.** `system()` and `popen()` reach a process and compose cleanly.

So D3 establishes that dormant composition refuses *named prototype* execution paths it does not override. It does **not** establish that the composition cannot spawn. Closing that gap needs enforcement at call time, a Proxy trap around the mounted runtime that refuses any invocation not on the allow list, rather than a scan at mount time. That is deferred, and until it lands the dormant mode is a strong guard against upstream drift and not a containment boundary.

## Consequences

Positive: a timed-out check can no longer report success; the verifier no longer forwards an execution vector; named prototype drift upstream fails loudly at composition instead of quietly at runtime.

Negative and compatibility:

- Checks that relied on inheriting the operator's `HOME` must pass `homeDirectory` explicitly. Tools needing a populated home for credentials will not find one by default, which is the intent.
- Checks that relied on inheriting `NODE_OPTIONS` or `PYTHONPATH` will change behavior. There is no override path; supply the setting inside the check's own argv or configuration.
- A `LocalCommandVerifierProvider` now holds a scratch directory and must be closed. `VerifierCatalog.close()` already does this.
- `detached: true` requires POSIX process-group semantics. On platforms without them the implementation falls back to signalling the direct child and still reports a leak, so behavior degrades to the previous guarantee rather than failing.
- Dormant composition against a DSH build that renames a guarded method now refuses to mount, either because the surface is left partly implemented or because the new name is still execution-named. That is intended: the alternative is mounting something that reports itself as dormant and is not.
- A rename that escapes both checks fails closed rather than open. Callers invoke a name neither Rhiz nor an abstract base implements, which is a `TypeError`, not a spawn.

## What this does not do

This does not sandbox the checked process. It runs with the operator's uid, its own `PATH`, and unrestricted filesystem and network access. Environment scrubbing raises the cost of one class of injection; it is not containment.

**Issue #11 remains an open P0.** OS-level containment, meaning a container, seccomp, Landlock, or `sandbox-exec` boundary derived from `WorkContract.scope` and `writeScope`, is still the gate before the Harness can be trusted to execute write-enabled production work. Nothing in this ADR may be cited as evidence that it has been met.

## Compliance check

- Constitution §9: partially advanced. Authority at this seam is now bounded by an allow list and a process group, and remains unbounded at the OS level. See #11.
- Constitution §10: satisfied. Every guarantee added here is mechanical and consumes zero model tokens.
- Constitution §5: satisfied for verifier outcomes. A process leak is recorded in the check summary and in the outcome digest.

## References

- `adapters/local/command-verifier.ts`, `adapters/dsh/product-runtime.ts`
- `test/verifier-containment.test.ts`, `test/dormant-composition.test.ts`
- `docs/reviews/2026-08-20-stack-review.md` issues #17 and #19
