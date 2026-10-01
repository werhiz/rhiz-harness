# Containment and Sandboxing

Status: current containment guide. Exact portable contracts live in `src/sandbox.ts`; concrete behavior lives in adapters, tests, ADR 0017, and ADR 0020.

## Why containment exists

A WorkContract can describe authority. Guard can deny supported native tool calls. Neither fact by itself stops an arbitrary process running with the operator's user permissions from writing elsewhere on the machine.

OS containment creates a physical execution boundary beneath the portable authority model.

```text
WorkContract writeScope
        |
        v
portable SandboxPolicy
        |
        v
platform SandboxLauncher
        |
        v
operating-system enforced process boundary
```

Rhiz keeps these layers separate so a semantic authorization claim is not confused with a physical containment claim.

## Portable contract

`SandboxPolicy` currently defines:

- `writableRoots`: absolute paths the contained process may write;
- `allowRead`: currently fixed to `true` because toolchains require broad system reads;
- `allowNetwork`: false by default;
- `allowProcessExec`: true by default because test runners and development tools spawn subprocesses.

Read containment is therefore outside the current contract's claimed protection. Documentation and receipts should not imply otherwise.

## Fail closed

A caller that requires containment uses `requireSandbox`.

Containment succeeds only when:

1. a `SandboxLauncher` is configured;
2. that launcher reports itself available on the current host;
3. it can wrap the command with the requested policy.

If any condition fails, the operation errors. There is no best-effort return path that silently degrades required containment into uncontained execution.

## Sandbox launcher

A platform-specific launcher implements:

```text
id
available()
wrap(policy, command, args)
```

The portable core does not depend on one operating system's sandbox syntax. Concrete platform mechanics live behind the launcher interface.

The wrapped command also supplies a cleanup/dispose hook for any temporary sandbox artifact.

## Mapping Work authority to writable roots

`workResourceWritableRoot` is the shared mapping from portable `ResourceRef` write scope into a concrete absolute filesystem root under the execution root.

Supported mappings include repository-wide scope and recognized repository/path URI forms.

The function refuses:

- path traversal;
- absolute paths outside the execution root;
- unrecognized resource URI forms where no safe allow rule can be derived.

This mapping is shared by OS containment and contract-bound authority so two safety mechanisms do not silently interpret the same Work resource differently.

## Worker policy

`workerSandboxPolicy` derives the worker's writable roots from the WorkContract plus a dedicated scratch home.

Current worker posture:

```text
writes: Work writeScope + scratch home only
reads: allowed
network: denied
subprocess execution: allowed
```

An empty `writeScope` gives the worker no Work-owned writable root. Scratch home remains available so ordinary tools can maintain temporary user state without receiving repository-wide authority.

## Verifier policy

The local command verifier has a separate containment path. When containment is required, the verifier refuses to run if a launcher is missing or unavailable.

Verifier execution also hardens the environment:

- only a small allowlist of ambient variables is forwarded;
- a scratch `HOME` is used by default;
- known code-injection environment variables such as `NODE_OPTIONS`, preload variables, language startup hooks, and Git execution hooks are refused as overrides;
- ambient Git configuration is neutralized;
- command and argv are executed without shell interpolation;
- timeout/output bounds apply;
- child process groups are terminated as a group to avoid leaked descendants continuing after a verdict.

This protects the independence of the check from ambient operator credentials/configuration and from common process-injection paths.

## Workspace isolation is different

Git worktree isolation and OS containment prove different properties.

**Git worktree isolation** gives the Work a separate repository checkout and exact artifact identity.

**OS containment** limits what the executing process can physically mutate beyond its allowed roots.

A provider can be bound to the correct worktree yet still have broad operating-system permissions unless containment is active. A sandboxed process can also be pointed at the wrong workspace unless workspace binding is correct.

Rhiz uses both where the safety claim requires both.

## Guard mediation is different

Guard controls supported native tool effects before they occur. OS containment constrains the process even when a path bypasses a particular high-level tool seam.

Defense in depth for SHIP Work is therefore:

```text
explicit Work authority
+ bound isolated workspace
+ OS containment where required/available by the shipped path
+ Guard native-tool mediation
+ post-execution changed-path validation
+ independent verification
```

A sandbox does not replace Guard because policy includes more than filesystem writes. Guard can reason about shell, network, credentials, external mutation, human approval, and Rules.

Guard does not replace a sandbox because a process can have effects outside the Guard's known native tool seam.

## Network

Current portable sandbox policy defaults `allowNetwork` to false. This is especially important for verification, where nondeterministic external calls undermine the meaning of a repeatable local check and can expose credentials/data.

A future network-capable path should make the allowed external boundary explicit rather than flipping the default globally.

## Scratch homes

Worker and verifier processes may need a writable `HOME` for harmless tool state. Rhiz uses scratch homes so the process does not inherit the operator's ordinary credential-bearing home directory by default.

Scratch state is runtime support. It is not Work-owned output and should not be confused with candidate artifact scope.

## Process trees and cleanup

Development commands frequently spawn subprocesses. A timeout or cancellation that kills only the immediate child can leave descendants running and mutating the workspace after a result is recorded.

Containment/verification paths therefore need process-group ownership and cleanup semantics appropriate to the platform. Proof should include the descendant process case, not only a single-process fixture.

## Claims and evidence

Use precise language:

- "workspace bound" means the provider executes at the supplied execution root;
- "isolated worktree" means repository changes occur in a separate Git worktree;
- "contained" means an OS launcher actually imposed a declared policy;
- "Guard-mediated" means supported native tool effects were synchronously evaluated before execution;
- "write-scope validated" means actual candidate changes were compared against the contract after execution.

Do not compress those into a generic "sandboxed" claim.

## When containment is unavailable

When a path declares containment required, unavailability is a failure condition.

The correct repair is one of:

- supply a compatible concrete launcher;
- run on a supported host;
- deliberately use a path whose security contract does not claim containment, while documenting that weaker claim.

Do not catch `SandboxUnavailableError` and continue uncontained under the same advertised security posture.

## Adding a containment implementation

A platform launcher should prove:

1. writable-root enforcement;
2. network posture;
3. subprocess behavior;
4. cleanup;
5. fail-closed handling of unsupported policy;
6. paths containing spaces/special characters;
7. symlink and path-escape behavior;
8. no silent fallback when the OS primitive is missing;
9. exact command/argv preservation;
10. compatibility with the Work/verification receipts that claim containment.

## Read deeper

- [Security Model](SECURITY_MODEL.md)
- [Guard and Authority](GUARD_AND_AUTHORITY.md)
- [Verification and Acceptance](VERIFICATION_AND_ACCEPTANCE.md)
- [Hosts, Providers, and Integrations](HOSTS_PROVIDERS_INTEGRATIONS.md)
- ADR 0017 and ADR 0020 in [Architecture Decision Records](decisions/README.md)