import assert from "node:assert/strict";
import test from "node:test";
import { HttpEffectBroker, getHttpEffectPolicyBindings, httpEffectResourceUri, type HttpEffectBinding } from "../src/http-effects.js";
import { createGuardedToolMediation, createDefaultPolicyOracle, GuardianRejectionCircuitBreaker, GuardPolicySchema } from "../src/guard.js";
import type { GuardedToolMediation } from "../src/guard.js";
import { human, work } from "./helpers.js";

const credential="test-secret-not-for-ledger";
const binding:HttpEffectBinding={toolName:"studio.create",method:"POST",url:"https://example.invalid/api/create",credential:()=>credential};
const contract=()=>work({authority:{grants:[{action:"external-mutate",resources:[{uri:httpEffectResourceUri(binding.method,binding.url)}],constraints:[]}],requiresHumanApproval:[]}});
function mediation(decision:"allow"|"prompt"|"forbid"="allow",records:unknown[]=[]):GuardedToolMediation {
 const policy=GuardPolicySchema.parse({workId:"work:1",perToolMode:{[binding.toolName]:{decision}}});
 return createGuardedToolMediation({oracle:createDefaultPolicyOracle(policy),policy,circuitBreaker:new GuardianRejectionCircuitBreaker(policy.circuitBreaker),workId:"work:1",taskId:"task:1",attemptId:"attempt:1",actor:human,writeScope:"workspace",contextHash:"fixture",record:async record=>{records.push(record);}});
}
const options=()=>({bindings:[binding],work:contract(),guard:mediation(),signal:new AbortController().signal,isActive:()=>true});

test("exact immutable policy bindings reject ambiguous URLs and duplicate tools",()=>{
 const definitions=[{...binding}];const broker=new HttpEffectBroker({...options(),bindings:definitions});
 definitions[0]!.url="https://attacker.invalid/";
 assert.equal(broker.policyBindings()[0]!.url,binding.url);
 assert.equal(Object.isFrozen(broker.policyBindings()[0]),true);
 assert.throws(()=>getHttpEffectPolicyBindings([binding,binding]));
 for(const url of ["http://example.invalid/","https://u:p@example.invalid/","https://example.invalid/?token=x","https://example.invalid/#secret"])
  assert.throws(()=>getHttpEffectPolicyBindings([{...binding,url}]));
 assert.notEqual(httpEffectResourceUri("GET",binding.url),httpEffectResourceUri("POST",binding.url));
 assert.equal(getHttpEffectPolicyBindings([{...binding,url:"https://example.invalid/api/read?executionEvidence=1"}])[0]!.url,"https://example.invalid/api/read?executionEvidence=1");
});

test("canonical Guard precedes one exact HTTP call and credentials never reach its durable records",async()=>{
 const records:unknown[]=[];let calls=0;
 const result=await new HttpEffectBroker({...options(),guard:mediation("allow",records),fetch:async(url,init)=>{
  calls++;assert.equal(records.length,1);assert.equal(url,binding.url);assert.equal(init?.redirect,"error");assert.equal(init?.method,"POST");
  assert.equal(new Headers(init?.headers).get("Authorization"),`Bearer ${credential}`);
  return new Response('{"receipt":"private evidence"}',{status:201});
 }}).invoke(binding.toolName,{intent:"private brief"});
 assert.equal(calls,1);assert.equal(result.outcome,"responded");assert.equal(result.httpStatus,201);
 assert.equal(JSON.stringify(records).includes(credential),false);assert.equal(JSON.stringify(records).includes("private brief"),false);
});

test("missing exact grants, approval requirements and Guard denial prevent credentials and HTTP",async()=>{
 const refusedContracts=[work(),contract(),contract()];
 refusedContracts[1]!.authority.requiresHumanApproval=["external-mutate"];
 refusedContracts[2]!.authority.grants[0]!.resources[0]!.uri=httpEffectResourceUri("GET",binding.url);
 for(const work of refusedContracts){
  const result=await new HttpEffectBroker({...options(),work,bindings:[{...binding,credential:()=>{assert.fail("credential retrieved");}}],fetch:async()=>{assert.fail("HTTP invoked");}}).invoke(binding.toolName);
  assert.equal(result.outcome,"not-sent");
 }
 for(const decision of ["prompt","forbid"] as const){
  const result=await new HttpEffectBroker({...options(),guard:mediation(decision),fetch:async()=>{assert.fail("HTTP invoked");}}).invoke(binding.toolName);
  assert.equal(result.reason,"guard-refused");
 }
});

test("closed Attempt during Guard or asynchronous credential lookup never dispatches",async()=>{
 for(const phase of ["guard","credential"]){
  let active=true;const original=mediation();
  const guard:GuardedToolMediation={evaluate:async call=>{const value=await original.evaluate(call);if(phase==="guard")active=false;return value;}};
  const result=await new HttpEffectBroker({...options(),guard,isActive:()=>active,bindings:[{...binding,credential:async()=>{if(phase==="credential")active=false;return credential;}}],fetch:async()=>{assert.fail("closed Attempt dispatched");}}).invoke(binding.toolName);
  assert.equal(result.outcome,"not-sent");assert.equal(result.reason,"attempt-inactive");
 }
});

test("POST transport errors and aborted responses retain unknown outcome without retry or raw error",async()=>{
 let calls=0;
 const result=await new HttpEffectBroker({...options(),fetch:async()=>{calls++;throw new Error(credential);}}).invoke(binding.toolName);
 assert.equal(calls,1);assert.equal(result.outcome,"unknown");assert.equal(JSON.stringify(result).includes(credential),false);
 const controller=new AbortController();
 const interrupted=await new HttpEffectBroker({...options(),signal:controller.signal,fetch:async()=>{
  const stream=new ReadableStream<Uint8Array>({start(){setTimeout(()=>controller.abort(),5);}});
  return new Response(stream,{status:202});
 }}).invoke(binding.toolName);
 assert.equal(interrupted.outcome,"unknown");assert.equal(interrupted.httpStatus,202);
});

test("bounded bodies and secret echoes fail closed without losing observed status",async()=>{
 const large=await new HttpEffectBroker({...options(),maxResponseBytes:3,fetch:async()=>new Response("four",{status:201})}).invoke(binding.toolName);
 assert.equal(large.outcome,"unknown");assert.equal(large.httpStatus,201);assert.equal(large.body,undefined);
 const echo=await new HttpEffectBroker({...options(),fetch:async()=>new Response(credential)}).invoke(binding.toolName);
 assert.equal(echo.reason,"credential-echo-refused");assert.equal(echo.body,undefined);
 const request=await new HttpEffectBroker({...options(),maxRequestBytes:1,fetch:async()=>{assert.fail("large request sent");}}).invoke(binding.toolName,{a:1});
 assert.equal(request.outcome,"not-sent");
});

test("GET requires read grant and refuses payloads; caller body cannot override immutable target",async()=>{
 const get={...binding,method:"GET" as const};const work=contract();work.authority.grants=[{action:"read",resources:[{uri:httpEffectResourceUri("GET",get.url)}],constraints:[]}];
 const broker=new HttpEffectBroker({...options(),bindings:[get],work,fetch:async(url,init)=>{assert.equal(url,get.url);assert.equal(init?.method,"GET");return new Response("readback");}});
 assert.equal((await broker.invoke(get.toolName,{url:"https://attacker.invalid"})).reason,"get-body-forbidden");
 assert.equal((await broker.invoke(get.toolName)).outcome,"responded");
 assert.equal((await broker.invoke("unregistered")).outcome,"not-sent");
});

test("immutable public headers carry correlation and forbidden headers are rejected",async()=>{
 const headers={"x-rhiz-build-correlation":"correlation:fixture"};
 const broker=new HttpEffectBroker({...options(),bindings:[{...binding,headers}],fetch:async(_url,init)=>{assert.equal(new Headers(init?.headers).get("x-rhiz-build-correlation"),"correlation:fixture");return new Response("ok");}});
 headers["x-rhiz-build-correlation"]="mutated";
 assert.equal((await broker.invoke(binding.toolName)).outcome,"responded");
 for(const name of ["authorization","host","cookie","connection","content-length","x-api-key"])
  assert.throws(()=>getHttpEffectPolicyBindings([{...binding,headers:{[name]:"forbidden"}}]));
});

test("real exact-binding policy refuses altered call fields and failed durable recording",async()=>{
 const {guardPolicyFromWorkContract}=await import("../src/guard.js");
 const policy=guardPolicyFromWorkContract(contract(),{httpEffects:getHttpEffectPolicyBindings([binding]).map(item=>({...item,decision:"forbid" as const}))});
 const make=(record:()=>Promise<void>)=>createGuardedToolMediation({oracle:createDefaultPolicyOracle(policy),policy,circuitBreaker:new GuardianRejectionCircuitBreaker(policy.circuitBreaker),workId:"work:1",taskId:"task:1",attemptId:"attempt:1",actor:human,writeScope:"workspace",contextHash:"fixture",record,requireRecordBeforeEffect:true});
 const guard=make(async()=>{});
 for(const patch of [{method:"GET"},{url:"https://attacker.invalid/"},{resourceUri:"wrong"}]){
  const value=await guard.evaluate({requestId:crypto.randomUUID(),tool:{name:binding.toolName,category:"external-mutate",args:{method:binding.method,url:binding.url,resourceUri:httpEffectResourceUri(binding.method,binding.url),...patch}}});
  assert.equal(value.verdict.decision,"forbid");
 }
 const wrongCategory=await make(async()=>{}).evaluate({requestId:"wrong-category",tool:{name:binding.toolName,category:"read",args:{method:binding.method,url:binding.url,resourceUri:httpEffectResourceUri(binding.method,binding.url)}}});
 assert.equal(wrongCategory.verdict.decision,"forbid");
 const good=await new HttpEffectBroker({...options(),guard:make(async()=>{}),fetch:async()=>new Response("ok")}).invoke(binding.toolName);
 assert.equal(good.outcome,"responded");
 const refused=await new HttpEffectBroker({...options(),guard:make(async()=>{throw new Error("disk full");}),fetch:async()=>{assert.fail("undurable Guard reached HTTP");}}).invoke(binding.toolName);
 assert.equal(refused.outcome,"not-sent");
 const denied=guardPolicyFromWorkContract(work(),{httpEffects:getHttpEffectPolicyBindings([binding]).map(item=>({...item,decision:"allow" as const}))});
 assert.equal(denied.httpEffects[0]!.decision,"forbid");
 for (const patch of [{action:"read" as const},{resourceUri:"http-effect:POST:https://elsewhere.invalid/"}]) {
  assert.throws(()=>guardPolicyFromWorkContract(contract(),{httpEffects:getHttpEffectPolicyBindings([binding]).map(item=>({...item,...patch}))}),/HTTP effect action\/resource/);
 }
});

test("invocation cancellation narrows Attempt authority before delayed credential completes",async()=>{
 const invocation=new AbortController();let release:(value:string)=>void=()=>{};let fetchingCredential:()=>void=()=>{};
 const started=new Promise<void>(resolve=>{fetchingCredential=resolve;});
 const pending=new Promise<string>(resolve=>{release=resolve;});
 const broker=new HttpEffectBroker({...options(),bindings:[{...binding,credential:()=>{fetchingCredential();return pending;}}],fetch:async()=>{assert.fail("cancelled invocation dispatched");}});
 const running=broker.invoke(binding.toolName,undefined,{signal:invocation.signal});await started;invocation.abort();release(credential);
 assert.equal((await running).outcome,"not-sent");
});
