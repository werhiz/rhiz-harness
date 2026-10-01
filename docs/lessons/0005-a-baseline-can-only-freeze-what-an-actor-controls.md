# Lesson 0005: A baseline can only freeze a signal the actor controls

## Observation

The calibrated integration horizon (ADR 0023) shipped with a grandfathering baseline whose stated purpose was to avoid refusing every existing branch on the day enforcement switched on. It froze four volume signals per branch: `commitsAhead`, `commitsBehind`, `divergenceAgeMs`, and `diffLines`.

Every layer of proof passed. 597 unit tests, 53 falsified guards, a calibration proof against the real repository with sentinels recomputed in raw Git, and a green CI run on both required checks. The baseline had direct unit coverage asserting that drift inside a frozen baseline was grandfathered and that advancing past it tripped. That test passed.

Then the baseline was frozen over all 176 drifted branches in the consuming repository and the census re-run. **172 of 176 branches were still tripped.** The mechanism did precisely the thing the baseline existed to prevent.

## Root cause

Two of the four frozen signals are not under the control of the actor being judged.

- `commitsBehind` grows every time the integration ref advances. It moved 321 to 329 during a single working session on a branch nobody touched.
- `divergenceAgeMs` grows with the clock. A frozen `elapsedMs` is exceeded one second after the freeze.

Freezing a passive signal is not a lenient bar, it is a bar that rises on its own. The grandfathering was fictional: a branch was measured against a limit that outran it without anyone acting.

The unit test could not see this, because a unit test supplies both observations. It froze a baseline and then handed the decision a second observation that it had also written, in which only the active signals had moved. The real world moves the passive ones for free, and no fixture did.

This is the same shape as Lesson 0001. The test proved the decision was internally consistent with the inputs it was given. It did not prove the inputs resembled what the world actually produces.

## Mechanized correction

- `volumeReasons` now separates active signals (`commitsAhead`, `diffLines`), which a baseline raises, from passive ones (`commitsBehind`, `divergenceAgeMs`), which a baseline suspends for an already-forgiven candidate.
- A candidate with no baseline is judged on all four exactly as before, so nothing is loosened for new work.
- Tests assert the case fixtures had missed: a grandfathered candidate whose passive signals advanced while its active signals did not must stay grandfathered, and must trip the moment either active signal advances by one.
- Durability remains outside the baseline entirely, including in combination with advanced passive signals, which has its own test and its own falsified guard.

## Reusable rule

**A baseline, allowance, or exemption may only be frozen over a signal the judged actor controls.** Freezing a signal that advances on its own produces an allowance that expires without anyone acting, and the expiry is silent.

Before freezing any threshold, ask of each signal: can this value change while the thing being judged is untouched? If yes, it cannot be baselined. Suspend it, measure it relative to the freeze, or leave it on the absolute threshold — but never store its instantaneous value as a limit.

The corollary is about proof, not policy. **A mechanism that forgives, throttles, or exempts must be exercised against real state before it is believed.** Fixtures move only the variables the author thought to move, so a fixture cannot falsify an assumption about which variables move on their own. Every gate here passed on a baseline that did nothing.

## Compound destination

This belongs wherever the Harness stores a remembered value and later compares a live observation against it: the integration horizon, Router quota and cost allowances, Refiner learning thresholds, and any future rate limit or budget.

The generalized check for Verify is that a stored allowance carries the identity of what it forgives and an assertion that the forgiven quantity is actor-controlled. An allowance over an ambient quantity is a timer wearing the costume of a policy.
