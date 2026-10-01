import assert from "node:assert/strict";
import test from "node:test";
import { WorkContractSchema } from "../src/schemas.js";
import { work } from "./helpers.js";

test("required acceptance proof cannot coexist with verification disabled", () => {
  const base = work();
  const parsed = WorkContractSchema.safeParse({
    ...base,
    verificationPolicy: {
      ...base.verificationPolicy,
      required: false,
    },
  });
  assert.equal(parsed.success, false);
});

test("verification may be disabled only when the contract requires no proof", () => {
  const base = work();
  const parsed = WorkContractSchema.safeParse({
    ...base,
    acceptanceCriteria: base.acceptanceCriteria.map((criterion) => ({ ...criterion, required: false })),
    requiredEvidence: base.requiredEvidence.map((requirement) => ({ ...requirement, required: false })),
    verificationPolicy: {
      ...base.verificationPolicy,
      required: false,
    },
  });
  assert.equal(parsed.success, true);
});
