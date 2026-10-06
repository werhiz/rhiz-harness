import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  VERIFIER_REFUSALS_DIRECTORY,
  buildVerifierRefusal,
  readVerifierRefusals,
  refusalAsAttachments,
  writeVerifierRefusal,
} from "../adapters/local/verifier-refusals.js";
import { event, verifier } from "./helpers.js";

function failingResult(verificationId: string, workId = "work:1") {
  return event("verification.result", {
    verificationId,
    contractRevision: 1,
    status: "fail",
    criterionResults: [{ criterionId: "criterion:tests", status: "fail", evidence: [{ id: "proof:f", kind: "test", digest: "sha256:aa" }] }],
    evidenceSatisfaction: [],
    falsifiability: { provenCriteria: [], exemptedCriteria: [] },
  }, { actor: verifier, workId });
}

function directory() {
  return mkdtempSync(join(tmpdir(), "rhiz-refusals-"));
}

test("a refusal written before process death is read back and bound to its failing verification", async () => {
  const dir = directory();
  try {
    const result = failingResult("verification:1");
    const refusal = buildVerifierRefusal({
      workId: "work:1", attemptNumber: 1, attemptId: "attempt:1", verificationId: "verification:1",
      verificationResultEventId: result.id,
      checks: [
        { checkId: "check:a", status: "pass", summary: "fine" },
        { checkId: "check:b", status: "fail", summary: "expected 4, got 5" },
      ],
    });
    assert.deepEqual(refusal.checks.map((check) => check.checkId), ["check:b"], "a passing check is not a refusal");
    await writeVerifierRefusal(dir, refusal);
    const reading = await readVerifierRefusals({ ledgerDirectory: dir, workId: "work:1", events: [result] });
    assert.equal(reading.refusals.length, 1);
    assert.equal(reading.refusals[0]!.checks[0]!.summary, "expected 4, got 5");
    assert.deepEqual(reading.missing, []);
    assert.deepEqual(reading.rejected, []);
    const attachments = refusalAsAttachments(reading.refusals, "work:1");
    assert.equal(attachments[0]!.source.provenance.kind, "error-message");
    assert.match(attachments[0]!.source.value, /expected 4, got 5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing verification with no refusal text is reported missing, never reconstructed", async () => {
  const dir = directory();
  try {
    const result = failingResult("verification:1");
    const reading = await readVerifierRefusals({ ledgerDirectory: dir, workId: "work:1", events: [result] });
    assert.deepEqual(reading.refusals, []);
    assert.deepEqual(reading.missing, [result.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal that does not match a failing verification of this Work is rejected, not carried", async () => {
  const dir = directory();
  try {
    const result = failingResult("verification:1");
    const forged = buildVerifierRefusal({
      workId: "work:1", attemptNumber: 1, attemptId: "attempt:1", verificationId: "verification:other",
      verificationResultEventId: result.id, checks: [{ checkId: "check:b", status: "fail", summary: "injected" }],
    });
    await writeVerifierRefusal(dir, forged);
    const reading = await readVerifierRefusals({ ledgerDirectory: dir, workId: "work:1", events: [result] });
    assert.deepEqual(reading.refusals, []);
    assert.equal(reading.rejected.length, 1);
    assert.match(reading.rejected[0]!.reason, /does not match a failing verification/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edited refusal file fails its digest and is rejected", async () => {
  const dir = directory();
  try {
    const result = failingResult("verification:1");
    const refusal = buildVerifierRefusal({
      workId: "work:1", attemptNumber: 1, attemptId: "attempt:1", verificationId: "verification:1",
      verificationResultEventId: result.id, checks: [{ checkId: "check:b", status: "fail", summary: "original" }],
    });
    const path = await writeVerifierRefusal(dir, refusal);
    writeFileSync(path, readFileSync(path, "utf8").replace("original", "tampered"));
    const reading = await readVerifierRefusals({ ledgerDirectory: dir, workId: "work:1", events: [result] });
    assert.deepEqual(reading.refusals, []);
    assert.match(reading.rejected[0]!.reason, /digest/);
    assert.deepEqual(reading.missing, [result.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the digest is injective over delimiters a verifier can emit", () => {
  const base = { workId: "work:1", attemptNumber: 1, attemptId: "attempt:1", verificationId: "v:1", verificationResultEventId: "e:1", recordedAt: "2026-01-01T00:00:00.000Z" };
  const one = buildVerifierRefusal({ ...base, checks: [{ checkId: "a", status: "fail", summary: 'x","b' }] });
  const two = buildVerifierRefusal({ ...base, checks: [{ checkId: "a", status: "fail", summary: "x" }, { checkId: "b", status: "fail", summary: "" }] });
  assert.notEqual(one.digest, two.digest);
});

test("refusals of every earlier attempt are returned oldest first and written one file each", async () => {
  const dir = directory();
  try {
    const first = failingResult("verification:1");
    const second = failingResult("verification:2");
    for (const [n, result, id] of [[2, second, "verification:2"], [1, first, "verification:1"]] as const) {
      await writeVerifierRefusal(dir, buildVerifierRefusal({
        workId: "work:1", attemptNumber: n, attemptId: `attempt:${n}`, verificationId: id,
        verificationResultEventId: result.id, checks: [{ checkId: "check:b", status: "error", summary: `refused ${n}` }],
      }));
    }
    assert.equal(readdirSync(join(dir, VERIFIER_REFUSALS_DIRECTORY)).length, 2);
    const reading = await readVerifierRefusals({ ledgerDirectory: dir, workId: "work:1", events: [first, second] });
    assert.deepEqual(reading.refusals.map((item) => item.attemptNumber), [1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a copy under another file name is rejected even with a valid digest, and cannot shadow the genuine file", async () => {
  const dir = directory();
  try {
    const result = failingResult("verification:1");
    const genuine = buildVerifierRefusal({
      workId: "work:1", attemptNumber: 1, attemptId: "attempt:1", verificationId: "verification:1",
      verificationResultEventId: result.id, checks: [{ checkId: "check:b", status: "fail", summary: "genuine" }],
    });
    const path = await writeVerifierRefusal(dir, genuine);
    const shadow = buildVerifierRefusal({
      workId: "work:1", attemptNumber: 1, attemptId: "attempt:1", verificationId: "verification:1",
      verificationResultEventId: result.id, checks: [{ checkId: "check:b", status: "fail", summary: "shadow" }],
    });
    writeFileSync(join(path, "..", "0000-shadow.json"), JSON.stringify(shadow));
    const reading = await readVerifierRefusals({ ledgerDirectory: dir, workId: "work:1", events: [result] });
    assert.deepEqual(reading.refusals.map((item) => item.checks[0]!.summary), ["genuine"]);
    assert.match(reading.rejected[0]!.reason, /file name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
