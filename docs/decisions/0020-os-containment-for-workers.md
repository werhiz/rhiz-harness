# ADR 0020: OS containment for the worker path

Status: accepted for Crew v0.5. Addresses the worker half of issue #11, which stays open.

## Context

ADR 0017 gave the verifier an operating-system boundary and closed its own section on what it did
not do with this sentence: *"Issue #11 stays open. This contains the verifier. It does not contain
workers."* It then named the worker path as the more dangerous of the two, because it is the one
that edits the repository.

That was accurate. Before this ADR, authority reached a worker as prompt text and nothing else. The
DSH adapters render the `AuthorityPolicy` into a prompt (`adapters/dsh/index.ts:167-206`,
`adapters/dsh/product-routes.ts:261-299`) and return `null` from `sandbox()`
(`adapters/dsh/index.ts:423`, `adapters/dsh/product-routes.ts:546`). `src/crew.ts:429-432` compares
changed paths against `writeScope` **after** the worker has finished. `authority.granted` and
`authority.denied` existed in the event schema and fell through the Board's `default: break`
(`src/board.ts:632`).

Measured rather than assumed, on pristine `main`, a worker spawned the way every worker was spawned
wrote all three targets issue #11 names — `os.tmpdir()`, the parent repository's `.git/config`, and
a `$HOME` path — and produced zero authority events, because there was no seam to produce them.

Constitution §9: prompt text alone is not an enforcement boundary.

## Decision

### D1. Extend the ADR 0017 seam; do not build a second sandbox

`src/sandbox.ts` already owned `SandboxPolicy` and `SandboxLauncher`, and
`adapters/local/sandbox.ts` already owned the macOS backend. Workers reuse both unchanged. The only
addition to the portable core is `workerSandboxPolicy(request, home)`, which derives a policy from a
`WorkerStartRequest`. No second mechanism, no second profile generator, no second notion of what a
boundary is.

### D2. The allow-list is derived from the contract, and refuses rather than guesses

`workerSandboxPolicy` maps each `WorkContract.writeScope` entry onto an absolute writable root under
the `WorkspaceBinding.executionRoot`, then appends the scratch `HOME`. Contract-derived roots come
first and in `writeScope` order, because `authority.granted` names them verbatim and a reader should
see what the contract asked for before what the harness added.

Three things are refusals, not defaults, because both ways of guessing are fatal here — a rule that
silently matches nothing produces a boundary that appears to contain and actually breaks the work,
and a rule that admits too much produces a boundary that is not one:

- an absolute path outside the execution root,
- any path traversal (`..` or `.`),
- an unrecognised URI scheme.

An empty `writeScope` yields the scratch `HOME` and nothing else, which is the honest reading of a
contract that grants no writes.

### D3. One assignment is the whole claim

`LocalCommandWorkerProvider.start` computes the policy, calls `requireSandbox`, and assigns the
rewritten argv over the original **before** `spawn` is reached. That single assignment is the
containment claim for this path, deliberately shaped the same way as the verifier's
(`sandbox/verifier-actually-wraps-the-command`) so it can be removed by the falsifiability harness.
Remove it and everything else still happens — policy derived, profile written, launcher consulted,
`authority.granted` emitted — while the worker runs unconfined. The guard
`sandbox/worker-actually-wraps-the-command` proves that mutation goes red.

### D4. Fail closed, at selection and at start

Two independent gates, neither overridable by human authorization:

- **Selection.** `WorkerSelectionRequirements.requireSandboxCapableHost`, set by Crew whenever
  `workspace.mode === "isolated-write"`, refuses any provider whose host does not report
  `HostCapabilities.sandbox === true`. A provider with no host, or a host whose `capabilities()`
  throws, is refused: a capability failure is a refusal, never a pass.
- **Start.** `requireSandbox` raises `SandboxUnavailableError` for a null launcher, an unavailable
  launcher and a refusing launcher alike, so "there was no boundary" cannot take the code path of
  "the boundary allowed it".

`HostCapabilities.sandbox` on `LocalContainedWorkerHost` is **derived** from
`SandboxLauncher.available()`, never asserted. The selection gate is only worth what that makes
true; a host able to advertise containment it does not have would turn the gate back into a label.

### D5. `writeAccess: "host-policy"` denies

Already true on `main` at `src/crew.ts:664-668` (`SHIP` allows only `workspace`, everything else
only `none`), and previously unguarded. It is now locked by
`workers/unknown-write-authority-is-denied-not-permitted`.

### D6. Authority becomes evidence at the seam, and the two claims are kept apart

`WorkerObservation` gains an optional typed `authority` field. Only the provider that imposed the
boundary fills it; Crew turns it into an `authority.granted` / `authority.denied` ledger event at the
moment it arrives, and the Board projects both into `authorityDecisions` instead of dropping them.

What each claim rests on, stated separately because neither should be asked to carry the other:

- **`authority.granted`** is first-hand. It is emitted only on the code path where `requireSandbox`
  returned a wrapped argv, and it names the writable roots the kernel is actually holding.
- **`authority.denied`** is the seam's report that the process it contained terminated reporting
  refusal, through that command's declared refusal-reporting contract (`deniedExitCodes`). The seam
  does **not** observe the individual `EPERM`; that happens in the kernel, inside the child.
- **The boundary itself** is proven by the escape targets not existing on disk after a real run —
  not by either event.

## What is proven

By escape attempt at the real local-command seam, not by inspection.
`test/worker-containment.test.ts` starts a `LocalCommandWorkerProvider` in a real
`GitWorktreeWorkspaceProvider` workspace and attempts the three writes issue #11 names. All three
fail and the provider emits one `authority.granted` and one `authority.denied`. Crew-to-Ledger
forwarding is proven separately by the same test file's read-only seam fixture. The local-command
provider is deliberately refused for Crew `isolated-write` work because it cannot mediate native
tool calls synchronously; that fail-closed result is issue #40's boundary, not evidence that the
OS containment seam disappeared.

Seven manifest entries make it permanent, each mutation-checked by
`scripts/check-guard-falsifiability.mjs`: the wrapping itself, the sandbox-capable-host gate, the
host-policy denial, the write-scope widening refusal, the git `core.fsmonitor` hardening, the Board
projection, and the Crew ledger append. None survived removal.

## What is NOT closed

**Issue #11 stays open.** This contains the *local command* worker path and gives the Kernel the
seam. It does not contain every worker.

- **DSH workers are still unconfined.** Codex and Claude Code execute through the DSH subagent
  runtime, which resolves and spawns its own processes; `sandbox()` still returns `null` at
  `adapters/dsh/index.ts:423` and `adapters/dsh/product-routes.ts:546`, so those hosts now fail the
  selection gate for `isolated-write` work rather than running unbounded. That is fail-closed, and
  it is not coverage. Containing DSH means either a DSH-side sandbox hook or wrapping its runtime,
  and it is deliberately not attempted here.
- **macOS only, via a deprecated mechanism.** `sandbox-exec` is deprecated by Apple and remains the
  only mechanism available without a signed entitlement or a container runtime. It is behind the
  portable interface precisely so replacing it does not reach the Kernel. On Linux and Windows
  `createDefaultSandboxLauncher()` returns null and every write-enabled start fails closed.
- **Writes are contained; reads are not.** A contained worker can still read `~/.ssh` and `~/.aws`.
  With the network denied by default it cannot trivially exfiltrate them, but "cannot read secrets"
  is not claimed. Unchanged from ADR 0017.
- **`sandbox-exec` confines filesystem and network syscalls, not everything.** It does not provide a
  separate uid, a pid namespace, or a resource limit. A contained worker can still exhaust CPU or
  memory, and can still write freely *inside* its granted roots — including the worktree's own
  `.git`, which is why the git-config hardening in `adapters/git/worktrees.ts` is load-bearing
  rather than belt-and-braces.
- **The git hardening was already on `main`** (`6675319`) and is unchanged here. It ships in this
  ADR only as a guarded regression lock, and must not be read as new work.
- **CI does not prove the boundary.** CI runs ubuntu; `sandbox-exec` is darwin-only; the escape test
  therefore skips on every CI run. A green CI run proves the fail-closed gates, the policy
  derivation, and the evidence channel -- all platform independent -- and proves nothing about the
  boundary itself, which is executed on a darwin workstation. This is declared mechanically in
  `scripts/check-ci-parity.mjs` under `NOT_PROVEN_IN_CI` and printed on every gate run, because the
  first version of this ADR shipped with that gap undeclared and a green gate that had never
  executed the enforcement it certified.

  That gap had a second, sharper consequence, and it is the reason the declaration is mechanical
  rather than a sentence in this file: with the darwin test skipped, nothing on CI falsified
  `crew/authority-evidence-reaches-the-ledger-from-the-seam`, and `check:guards` correctly reported
  it UNPROVEN. A guard proven only on the platform where the merge gate does not run is not a
  guard. The evidence channel is now proven separately by a platform-independent test that asserts
  the durable ledger fact, with a stub standing in for the seam -- and that test proves the channel
  only. It cannot and does not prove that an operating system refused anything.

## References

- `src/sandbox.ts`, `adapters/local/command-worker.ts`, `adapters/local/sandbox.ts`
- `src/workers.ts`, `src/crew.ts`, `src/board.ts`, `src/host.ts`
- `test/worker-containment.test.ts`, `scripts/guard-manifest.json`
- ADR 0012, ADR 0016, ADR 0017, issue #11
