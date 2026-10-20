import test from "node:test";
import assert from "node:assert/strict";
import { recommendEngineeringDecision as decide } from "../src/router.js";
test("an advisory high value never overrides ownership or budget", () => {
  for (const facts of [{duplicate:true}, {authorized:false}, {paidCostUsd:1,budgetUsd:0}])
    assert.notEqual(decide({kind:"priority",facts:{priorityValue:1000,...facts}}),"execute");
});
test("unverified evidence and unconfirmed regressions do not authorize execution", () => {
  assert.equal(decide({kind:"evidence",facts:{authorized:true,verificationAvailable:true,evidenceSufficient:false}}),"revise");
  assert.equal(decide({kind:"regression",facts:{regressionConfirmed:false}}),"park");
});
test("bounded retries stop and lessons require evidence and compatible scope", () => {
  assert.equal(decide({kind:"recovery",facts:{retryCount:2,transientFailure:true}}),"stop");
  assert.equal(decide({kind:"reuse",facts:{verifiedLesson:true,compatibleScope:false}}),"park");
});
test("mechanical decisions consume no inference and invalid facts refuse", () => {
  assert.equal(decide({kind:"inference",facts:{deterministicAnswerAvailable:true,inferenceExpectedValue:100}}),"skip");
  assert.throws(()=>decide({kind:"authority",facts:{authorized:"true"}}));
});
