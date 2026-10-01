import assert from "node:assert/strict";
import test from "node:test";
import { WorkAmendmentSchema } from "../src/schemas.js";

/**
 * Issue #62 family, founder-decided 2026-08-24: the verifier registry lives in
 * `verificationPolicy`, and `verificationPolicy` was amendable. The executed
 * attack: an actor who did NOT write `work.created` appends `work.amended` as a
 * non-human actor, flips the policy at revision 2, forges a verification under
 * the policy it just installed, and reaches `accepted` with zero violations.
 *
 * The registry authorized itself. The stated guarantee - "the attacker did not
 * control work.created, therefore the forgery is refused" - was false for this
 * path.
 *
 * The decision was the smallest change that makes the model tell the truth:
 * fix the registry at `work.created` by removing `verificationPolicy` from the
 * amendment surface entirely. Not an actor check on the amendment - the field
 * simply stops being amendable, so there is no path to check.
 */

test("an amendment cannot change the verification policy", () => {
  // Every other amendable field still parses, so this test fails for the right
  // reason rather than because amendments broke generally.
  assert.ok(WorkAmendmentSchema.safeParse({ objective: "A revised bounded change" }).success);

  const attack = WorkAmendmentSchema.safeParse({
    verificationPolicy: {
      required: true,
      independentActor: false,
      reviewRequired: false,
    },
  });

  assert.equal(
    attack.success,
    false,
    "verificationPolicy must not be amendable: it carries the verifier registry, and an amendable registry authorizes itself",
  );
});

test("an amendment carrying verificationPolicy alongside a legal change is refused whole", () => {
  // The dangerous shape is not a lone policy flip - it is a policy flip hidden
  // in an otherwise ordinary amendment. `.strict()` must refuse the whole
  // amendment rather than silently dropping the unknown key, because a silently
  // dropped key is an attack that reports success.
  const smuggled = WorkAmendmentSchema.safeParse({
    objective: "A revised bounded change",
    verificationPolicy: { required: false, independentActor: false, reviewRequired: false },
  });

  assert.equal(smuggled.success, false, "an amendment must be refused whole rather than partially applied");
});
