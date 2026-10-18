import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
test("Factory dispatch safety and native lifecycle falsifiers",()=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const p=spawnSync(process.execPath,["--test","scripts/test-factory-dispatch.mjs"],{encoding:"utf8",timeout:15000,env});assert.equal(p.status,0,p.stdout+p.stderr);});
test("Factory session ownership regression proofs",()=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const p=spawnSync(process.execPath,["--test","scripts/test-factory-sessions.mjs"],{encoding:"utf8",timeout:15000,env});assert.equal(p.status,0,p.stdout+p.stderr);});
