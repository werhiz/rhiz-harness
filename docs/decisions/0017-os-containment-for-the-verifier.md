# ADR 0017: OS containment for the verifier path

Status: accepted for Verify v1.2. Partially addresses issue #11, which stays open.

## Context

Every other authority mechanism in this Kernel bounds behavior by describing it. A `WorkContract` states a `writeScope`. A `WorkerDescriptor` states a `writeAccess`. A `PolicyOracle` states a verdict. `workspaceChangeViolations` compares snapshots after the fact.

None of that stops a process. A verifier runs the repository's own test command, which is untrusted code, with the operator's uid. It can write anywhere that uid can write. The 2026-08-20 review recorded this as #11 and called it the gate before write-enabled production work.

ADR 0012 narrowed the blast radius at this seam: an allow-listed environment, a scrubbed `HOME`, a process group that gets killed as a unit. It says explicitly under "What this does not do" that none of that is containment.

## Decision

### D1. The Kernel describes a boundary and imposes none

`src/sandbox.ts` owns `SandboxPolicy` (writable roots, network, sub-process execution) and the `SandboxLauncher` interface. It contains nothing about how any operating system enforces those, because that is per-platform, deprecated on a schedule Rhiz does not control, and replaceable.

### D2. Containment is fail-closed at the type level

`requireSandbox` is the only supported entry point. A null launcher and an unavailable launcher raise the same `SandboxUnavailableError` as a refusing one. There is no best-effort return value and no boolean for a caller to ignore, because a boundary that silently degrades to no boundary is worse than none: it is the same absence, wearing a guarantee.

### D3. macOS is implemented, Linux is absent rather than approximated

`MacosSandboxExecLauncher` generates a deny-default `sandbox-exec` profile. `createDefaultSandboxLauncher()` returns null on every other platform. An unimplemented backend must not read as an available one.

Two properties the implementation checks rather than assumes:

- **Paths are resolved before they enter a profile.** On macOS `/tmp` is a symlink to `/private/tmp`, and a `subpath` rule written against the unresolved path matches nothing. The deny rules still work, so the result is a sandbox that appears to contain and actually breaks the work: the failure most likely to get containment switched off by an operator in a hurry. An unresolvable root is a `SandboxPolicyError`.
- **`available()` proves a boundary, not a binary.** It runs a deny-default profile and requires a write to fail. The presence of `/usr/bin/sandbox-exec` is not evidence that it confines anything.

### D4. The verifier is the first consumer

`LocalCommandVerifierProvider` takes a launcher and a `requireContainment` flag. The policy for a check is the workspace it verifies plus the scratch `HOME` it was given, everything else read-only, network closed.

## What is proven

By escape attempt, not by inspection. `test/containment.test.ts` runs real commands under the real sandbox and requires the operating system to stop them: a write outside the execution root, and a write to the operator's `HOME`. A third test requires the legitimate write inside the root to succeed, because containment that also blocks the work is the version that gets disabled.

Both escape tests were mutation-checked: with the wrapping disabled they go red and the escapes land on disk.

Two manifest entries make this permanent: `sandbox/require-fails-closed-without-a-launcher` and `sandbox/verifier-actually-wraps-the-command`. The second is the whole claim for this seam. Without that one line the policy is computed, the profile is written, and the command runs unconfined.

## What is NOT closed

**Issue #11 stays open.** This contains the verifier. It does not contain workers.

- **DSH workers run unconfined.** Codex and Claude Code execute through the DSH subagent runtime, which resolves and spawns its own processes. Nothing in this ADR touches that path, and it is the path that edits the repository.
- **Linux and Windows have no backend.** `createDefaultSandboxLauncher()` returns null, and any caller requiring containment on those hosts fails closed. Correct, and not coverage.
- **Reads are unrestricted.** A contained check can still read `~/.ssh` and `~/.aws`. It cannot write them and, with the network denied by default, cannot trivially exfiltrate them, but "cannot read secrets" is not claimed.
- **`sandbox-exec` is deprecated** by Apple. It is behind the portable interface precisely so replacing it does not reach the Kernel.
- **Containment is opt-in.** A provider constructed without a launcher runs unconfined, which is the pre-existing behavior. Making it the default is a separate decision with a compatibility cost, and it should be made deliberately rather than smuggled in here.

Nothing in this ADR may be cited as evidence that #11 is met. The honest statement is that one of the two untrusted-execution paths now has an operating-system boundary, and the more dangerous one does not.

## References

- `src/sandbox.ts`, `adapters/local/sandbox.ts`, `adapters/local/command-verifier.ts`
- `test/containment.test.ts`, `scripts/guard-manifest.json`
- ADR 0012, issue #11, issue #40
