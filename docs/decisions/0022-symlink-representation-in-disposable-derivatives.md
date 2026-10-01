# ADR 0022: Symlink representation in disposable derivatives

Status: accepted for Kernel 0.1. Refines ADR 0019; addresses issue #72. ADR 0019's original four mechanisms are unchanged; this adds a fifth and tightens the factory's entry gate.

## Context

`TempDirectoryDerivativeFactory` could not derive any tree containing a relative symlink. `fs.cp` with `dereference: false` does not preserve a relative link's target: it rewrites the target into an absolute path back into the **source** tree. A derivative carrying that link would hand every proof operation a path straight into the authoritative candidate — the exact artifact the machinery exists to protect. The digest-equality gate caught the rewrite (link target strings are hashed as content), so the machinery refused every symlink-bearing candidate. Fail-closed, correct, and blind: the caller learned `derivative-unavailable: digest does not match` and not which link was the problem, and candidates with perfectly safe links could not be proven at all. Found by the PR #68 rebase lane (evidence S6), filed as #72.

Two design probes decided the shape (both executed, see #72's evidence):

1. **A lexical containment rule fails open.** For a link at `root/deep/L -> a/../../escaped`, lexical resolution normalises the dots before consulting any link and lands "inside". The kernel resolves `a` **first** (it is itself a symlink), so the `..`s climb from the link's endpoint — outside the root. A containment check that computes resolution itself must reimplement exactly this order, and gets it wrong exactly when it matters.
2. **Link traversal followed by `..` escapes the root under the kernel.** A sibling link `root/a/l -> ../b` (endpoint strictly inside) combined with the raw path `root/a/l/../../x` writes into the derivative's *container*, not `root/x`. This is a property of caller-constructed raw paths, not of the links; the API's `resolve()` normalises lexically before any kernel operation, so API-mediated writes cannot express it.

## Decision

**D1. Links are copied verbatim and every link must be proven contained by the kernel itself.**

The copy passes `verbatimSymlinks: true`, so link target strings survive byte-for-byte and the existing digest-equality gate doubles as a verbatimness proof. After the copy (and after the digest check) the factory walks the derivative and requires, for every symlink:

1. **The target is relative.** An absolute target resolves as a function of filesystem state outside the derivative — state no digest covers and no boundary controls. Refused even when it lands inside the derivative today; move the tree and it silently points somewhere else.
2. **`realpath(link)` resolves and lands inside (or on) the derivative root.** Realpath is the kernel's own resolution: it follows chains, applies `..` after links exactly as the kernel does, and detects cycles. The kernel is the only witness this module trusts for resolution. `realpath` of the derivative root is used for the comparison so the check is not defeated by a symlinked temp directory (`/var` → `/private/var` on darwin).
3. **A link that does not resolve is refused.** Broken (ENOENT) or cyclic (ELOOP): where a broken link *would* land once its target exists cannot be witnessed by the kernel, and computing it means reimplementing partial path resolution. That is precisely the clever containment proof this repository refuses to ship. A refusal costs a proof; an accepted-but-wrong containment costs the invariant.

Every refusal is a `DerivativeLinkEscapeError` naming the exact offending link path (relative to the derivative root), its target, and where the kernel landed it. Through `runDisposableProof` the refusal becomes `derivative-unavailable` with the link named in the detail.

**D2. Containment proven at creation holds for the derivative's whole lifetime.**

The write surface (`DisposableDerivative.mutate`) can create files and directories but never symlinks, and `writeFile` through an existing link writes the link's target rather than replacing the link, so the link set is frozen at creation. Nothing operating through the API can change where a link resolves.

**D3. The write boundary is unchanged, and its reasoning is now explicit.**

`resolve()` normalises lexically before returning a path, and callers write to the returned string. A normalised, inside-root path contains no `..` components, so descending it can only compose real directories with link endpoints that are themselves proven inside — an API-mediated write cannot land outside the derivative. A proof reaching around the API with direct `fs` calls can construct a raw `link/../../..` path that escapes into the container; that exposure predates this ADR (any absolute link allowed it), is bounded by candidate non-addressability plus the post-proof identity recheck, and is out of scope for the same reason ADR 0019 gives for reads: the boundary is structural, not a sandbox. A proof that addresses the filesystem directly could address the candidate by absolute path anyway.

## Alternatives considered

**Accept broken links whose would-be landing is lexically inside.** Rejected by the gate this repository set itself: the witness must be simple and mechanical. Computing a broken link's would-be landing requires first-existing-ancestor resolution over a frozen link set — three layers of reasoning where the kernel offers none. If broken-link candidates become a real availability problem, the answer is a partial-resolution prover with its own falsifiers, not a guess shipped inside the safety gate.

**Refuse every symlink (keep the pre-#72 behaviour, add a typed error).** Correct but strands the most common shape (`bin/tool -> ../pkg/bin.js`) with no path to ever being provable, and the containment witness for resolving links is as mechanical as witnesses get: the kernel already computes it.

**Kernel-hardening `resolve()` (realpath the resolved path before returning).** Unnecessary: `path.resolve` output contains no `..` when it is inside the root, so the kernel resolution of an API-issued path composes only proven-contained links. Adding a second check would double the enforcement surface for the same guarantee.

## What this does not do

- It does not accept broken, absolute, or cyclic links. Those candidates remain underivable; the typed error names the link so a caller can learn why and fix the tree.
- It does not confine proofs that bypass the derivative API with direct filesystem calls (D3).
- It does not change the receipt contract: refusals surface as `derivative-unavailable` with the typed error in the detail, not a new invalidation code. A new code would make old readers fail to parse new receipts — a contract break bought with nothing.

## References

- `src/disposable.ts` — `assertEverySymlinkResolvesInside`, `DerivativeLinkEscapeError`, the `verbatimSymlinks` copy
- `test/disposable-symlinks.test.ts` — the eight falsifier cases from #72, executed
- `scripts/guard-manifest.json` — five guards, each falsifiable
- Issue #72, ADR 0019, ADR 0016
