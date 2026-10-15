# Native independent review adapter

Status: implementation candidate, October 15, 2026. This is a local runner under
the existing Codex adapter, exported by `@werhiz/rhiz-harness/codex`. It does not
parse review verdicts, write Ledger events, post PR comments, or authorize integration.
Existing consumers retain exact-candidate/material binding, actor independence,
verdict/leak checks, quota selection, durable evidence and acceptance authority.

`runNativeCodexReview` invokes the installed Darwin native `codex-cli 0.162.1`.
The caller provides a trusted absolute executable, explicit eligible model,
trusted reviewer instructions, unchanged untrusted packet, explicit high reasoning, detached disposable
checkout, separate scratch, common Git directory and reviewed toolchain roots.
The executable and catalog must remain outside model-writable scopes.

The canonical operator auth backend must actually be `file`, with a signed-in
ChatGPT account reported by native metadata. A new 0700 control directory contains
an empty trusted cwd, private host HOME, native model catalog snapshot and an auth-only
CODEX_HOME alias. Its sole credential path is a symlink to the operator-owned
private regular canonical `auth.json`. The adapter never reads, hashes, copies,
prints, logs in, logs out, or explicitly refreshes credential contents. Native
metadata compares original and alias account type/email/plan in memory without
returning the principal. Cleanup unlinks the alias and removes only this control
directory. The native host remains the sole auth consumer; model tools are denied
both original auth home and private control paths.

The reviewed model record fingerprint is a required trusted policy input. The
source must be the canonical operator-owned regular `models_cache.json`, and may
not be an auth hardlink. The exact unmodified selected record is SHA256-hashed as
`JSON.stringify(record)` and copied into a private per-run catalog. Drift refuses
before inference. Do not derive the expected fingerprint automatically from the
supplied source. Do not edit model metadata to manufacture a narrower registry.

The October 15 installed-host probe admitted the unmodified `gpt-6-astra` record
with fingerprint
`3734f758dc47ef93a1dde955cdd9382cc5decf678e125439cfedfd1cc6f3b285`.
That observation does not admit another model, version or updated catalog.
Its actual native registry included `functions.exec`, `functions.wait` and
`functions.request_user_input_async`; the request tool remains present despite
its configuration switch. Nested exec exposed only patch, exec, stdin, three
MCP resource metadata/read methods and clock. The admission evidence must include
normal startup and effectless unavailable/unsolicited tool handling, alongside
positive sandboxed command/patch proof. A startup failure is never a no-tool contract.

The native process ignores user configuration/repository rules, disables skills,
hooks, apps/plugins, browser/computer, images, memory, delegation and shell snapshots,
and supplies a named managed permission profile without legacy sandbox overrides.
Child commands receive scratch HOME/TMPDIR, a fixed PATH and null global/system Git
configuration, without inherited loader variables, provider keys or CODEX_HOME.
ZDOTDIR points at a separate empty read-only directory inside private control;
BASH_ENV and ENV are fixed to `/dev/null`. Disabling login shells alone is
insufficient: the installed non-login zsh executes scratch HOME/.zshenv.
The trusted native host has a separate fixed environment. The profile denies
home, real temporary roots, canonical auth and control, writes only checkout/scratch,
and admits only explicit toolchain/common-Git reads. Native-managed executable shims
are the sole permitted extra read entry at startup.

The result requires successful process exit, exactly one anchored native
SessionConfiguredEvent matching model/provider/high reasoning/profile/cwd/filesystem/network,
and one completed JSON event turn with a nonempty final and valid usage. Errors,
unknown tool items, failed non-command or unfinished items, conflicting final, malformed or
truncated output, process failure and timeout refuse. This conservative parser may
refuse native commentary emitted as a separate agent message; it never promotes
partial output. Paired completed commands may report exit 0/completed or 1..127/failed
with string output; 126/127 are failed shell evidence, never passing tests or
READY. Native host launch failures, signal-style exits, malformed status/exit pairs
and unpaired completions refuse. Item identities are single-use and completion types
must match their starts; only agent messages and reasoning may omit a start. Failure diagnostics contain only bounded
lifecycle metadata, without command/output/provider/account text. Reported model identity is native startup evidence, not a claim
about an undisclosed backend implementation.

Command text must be nonblank at both start and completion; silent output is valid.
File payloads require an array of nonblank, NUL-free paths with add/update/delete
kinds at both lifecycle positions. An explicit empty array records zero changes,
never positive file mutation evidence. These checks validate evidence shape;
the sandbox and detached checkout retain path authority. The wire fields follow
the [pinned native schema](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/exec_events.rs).

File changes must end with `status: completed`; missing, cancelled, in-progress
or failed completions refuse before the active item is retired. Process stdout
and stderr use streaming UTF-8 decoders so a split codepoint cannot change a
finding, event or startup path.

Trusted developer instructions require exactly one assistant text message after
all work finishes, without intermediate commentary. The parser still refuses
multiple distinct messages. Native 0.162.1 JSON omits their phase, and its
output-last-message file can contain commentary or silently select one of two
finals; neither is a final-phase discriminator. Existing consumers must still
validate their verdict grammar. This instruction never suppresses tool errors
or relaxes completion, transport or model/profile checks.

`nativeCodexReviewInvocation` is a module-level deterministic probe seam, absent
from the package barrel. Tests may override its provider flags only against a
local fake endpoint. The public production runner has no provider/test override.
No upstream source was copied: this is original integration code invoking an
external native backend through its installed CLI/RPC interfaces.

## Proof and remaining acceptance

The current correction automates file-status and actual split-pipe UTF-8
regressions through disposable fixtures. CI parity explicitly lists the Darwin
process/alias fixtures; those scripted executables do not prove native isolation.
The installed native dummy-auth suite now runs through the ordinary Darwin gate:
cached identity, refresh/save, rejected refresh without canonical corruption,
canonical file replacement, and concurrent original/alias refresh custody. It
uses only disposable dummy bytes and a loopback server, with no model inference.
Native file-URL paths decode once before exact scope/access and duplicate checks.
Installed-host tool/startup/network/socket/PTY containment and paid canary evidence
orchestration still lack checked-in automation. P1 remains open; this checkpoint
does not claim that a passing portable suite proves the native boundary.
Clean local native provisioning also remains open: the dummy-auth test still
assumes the operator's global ARM64 installation beside the running Node prefix.

The scoped implementation executor used deterministic shell, TypeScript and Node
on Darwin. No model inference, operator credential mutation, install, push, PR or full gate
was used for this candidate. Existing Codex adapter tests plus the new native suite
pass locally; destructive/negative fixtures run through `src/disposable.ts` and
re-pin their source after removal. Scripted executables test metadata/process/cleanup
custody only and are never evidence of OS containment or model access.

Before an existing consumer can use the runner's review: independently review this
exact candidate; repeat installed-native tool/startup/network/socket/auth/env canaries
against its exact invocation; prove dummy file refresh/save/replacement/concurrency;
run a real independently reviewed planted defect and repaired exact head under fresh
eligible quota; retain native model/usage evidence; run all existing consumer
wrong-head/material/actor/leak/interruption tests and normal integration gates.
The first real defect canary on the prior candidate found the planted defect but
could not execute file-based Node tests: denying shared temp also denied ancestor
metadata resolution. That result was refused and is not successful acceptance.
The successor admits the native Minimal platform preset explicitly, with bounded
overriding `/dev/tty*` and `/dev/ptmx*` deny globs alongside it. Literal
device carveouts did not override the native baseline and were rejected. This preset supports metadata traversal and
fixed platform services, including selected system Mach IPC and system logging;
it does not mean that every local IPC channel is denied. Arbitrary TCP/UNIX
socket tests and private directory listing must still fail. Bare Minimal grants
unconditional terminal writes and is inadmissible for this runner. The combined
installed-native successor fixture denied private PTY reads/writes, `/dev/ptmx`
and noncontrolling `/dev/tty`, while actual Node file tests and Git still ran.
Its strict parser accepted the exact Minimal, two deny globs and high reasoning.

The separate successor shell fixture used the exact production builder with a
local deterministic provider and fake credentials. Before its first command,
scratch contained a planted `.zshenv`. The hook did not run; writing the trusted
shell directory returned EPERM; a real file-based Node test passed, Git returned
the fixture SHA, and home/auth/listing/network refusals remained intact. This is
physical shell-startup boundary evidence, not real model review evidence.

The real operator credentials must never be used in login/refresh experiments.
Packet consumers still must prove their capability contract; this runner exposes
bounded test-running tools and does not promise a tool-free packet session.
