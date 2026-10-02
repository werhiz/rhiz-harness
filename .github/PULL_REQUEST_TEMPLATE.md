## Why

<!-- The problem, issue, or evidence this change answers. -->

## What

<!-- The change, and the module that owns it. -->

## Proof

<!-- Commands you ran on this exact head, with results. Name anything you did not run. -->

- [ ] `npm run check` passes locally (build, tests, portable boundary, guard falsifiers, CI parity)
- [ ] A new guard or invariant has a falsifier that fails without it (`scripts/guard-manifest.json`)
- [ ] No claim in docs is stronger than the code and tests behind it; proposed behavior is labeled proposed
- [ ] No authority, Guard, or verification boundary is weakened, or the PR says exactly which and why
- [ ] Third-party code, if any, is recorded in `provenance/` and `THIRD_PARTY_NOTICES.md`
