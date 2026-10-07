import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { ContainedHttpEffectHost, ContainedHttpEffectWorkerProvider } from "../adapters/local/http-effect-worker.js";
import { MacosSandboxExecLauncher } from "../adapters/local/sandbox.js";
import { parseWorkerStartRequest } from "../src/host.js";
import type { SandboxLauncher } from "../src/sandbox.js";
import { createDefaultPolicyOracle, createGuardedToolMediation, guardPolicyFromWorkContract, GuardianRejectionCircuitBreaker } from "../src/guard.js";
import { human, work } from "./helpers.js";

const artifactPath="evidence/private-response.json";

test("a child crash after response write preserves unconfirmed private evidence", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "rhiz-http-post-write-crash-")));
  const launcher = new MacosSandboxExecLauncher();
  const crash: SandboxLauncher = { id: launcher.id, available: () => launcher.available(), wrap: async (policy, command, args) => {
    const program = args[1]!;
    assert.ok(program.includes("fs.writeFileSync(fd,m.content);"));
    return launcher.wrap(policy, command, ["-e", program.replace("fs.writeFileSync(fd,m.content);", "fs.writeFileSync(fd,m.content);process.exit(74);")]);
  } };
  try {
    await mkdir(path.join(root, "evidence"));
    const worker = new ContainedHttpEffectWorkerProvider({ sandbox: crash, toolName: "fixture.post", artifactPath });
    const input = request(root);
    const handle = await worker.start(input, { guardedToolMediation: guard(input), httpEffects: { invoke: async () => ({
      invocationId: "http:crash-fixture", toolName: "fixture.post", outcome: "responded", reason: "http-success", httpStatus: 201, body: "retained-response",
    }) } });
    const result = await handle.result();
    assert.equal(result.status, "failed");
    assert.equal(result.artifacts.length, 0);
    assert.equal(JSON.parse(await readFile(path.join(root, artifactPath), "utf8")).body, "retained-response");
    await worker.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
function request(root:string){const contract=work({writeScope:[{uri:"dir://evidence",kind:"directory"}],authority:{grants:[{action:"write",resources:[{uri:"dir://evidence",kind:"directory"}],constraints:[]}],requiresHumanApproval:[]}});return parseWorkerStartRequest({work:contract,taskId:"task:1",attemptId:"attempt:1",objective:contract.objective,context:contract.context,authority:contract.authority,workspace:{workspaceId:"workspace:1",leaseId:"lease:1",uri:`file://${root}`,executionRoot:root,mode:"isolated-write",baseRevision:"fixture"}});}
function guard(input:ReturnType<typeof request>){const policy=guardPolicyFromWorkContract(input.work,{contractBoundCategoryAuthority:true});return createGuardedToolMediation({oracle:createDefaultPolicyOracle(policy),policy,circuitBreaker:new GuardianRejectionCircuitBreaker(policy.circuitBreaker),workId:input.work.id,taskId:input.taskId,attemptId:input.attemptId,actor:human,writeScope:"workspace",contextHash:"fixture",record:async()=>{}});}

test("missing sandbox or canonical mediation refuses before the effect",async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"rhiz-http-worker-test-")));
 try{
  await mkdir(path.join(root,"evidence"));
  const worker=new ContainedHttpEffectWorkerProvider({sandbox:null,toolName:"fixture.post",artifactPath});
  const host=new ContainedHttpEffectHost(worker);assert.equal((await host.capabilities()).sandbox,false);
  await assert.rejects(worker.start(request(root)),/broker and Guard/);
  await assert.rejects(worker.start(request(root),{guardedToolMediation:guard(request(root)),httpEffects:{invoke:async()=>{assert.fail("uncontained effect");}}}),/containment/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("real OS-contained child has no credentials, outside writes or network; actual broker response is guarded and saved",{skip:process.platform!=="darwin"},async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"rhiz-http-worker-proof-")));
 await mkdir(path.join(root,"evidence"));
 const outside=path.join(path.dirname(root),`${path.basename(root)}-escape`);
 const server=createServer(socket=>socket.end());await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
 const address=server.address();assert.ok(address&&typeof address!=="string");
 const launcher=new MacosSandboxExecLauncher();
 const probe:SandboxLauncher={id:launcher.id,available:()=>launcher.available(),wrap:async(policy,command,args)=>{
  assert.equal(policy.allowNetwork,false);
  const preflight=`if(process.env.RHIZ_HTTP_PROOF_SECRET)process.exit(71);try{require('node:fs').writeFileSync(${JSON.stringify(outside)},'escape');process.exit(72);}catch{}const s=require('node:net').connect(${address.port},'127.0.0.1');s.once('connect',()=>process.exit(73));s.once('error',()=>{${args[1]}});`;
  return launcher.wrap(policy,command,["-e",preflight]);
 }};
 process.env.RHIZ_HTTP_PROOF_SECRET="fixture-ambient-secret";
 try{
  assert.equal(await launcher.available(),true,"real sandbox must be available for this proof");
  const worker=new ContainedHttpEffectWorkerProvider({sandbox:probe,toolName:"fixture.post",body:{intent:"synthetic private brief"},artifactPath});
  const input=request(root);let calls=0;const mediation=guard(input);
  const handle=await worker.start(input,{guardedToolMediation:mediation,httpEffects:{invoke:async(name,body)=>{calls++;assert.equal(name,"fixture.post");assert.deepEqual(body,{intent:"synthetic private brief"});return {invocationId:"http:fixture",toolName:name,outcome:"responded",reason:"http-success",httpStatus:201,body:'{"actualResponse":"synthetic-private-evidence"}'};}}});
  const result=await handle.result();assert.equal(result.status,"finished");assert.equal(calls,1);
  const persisted=JSON.parse(await readFile(path.join(root,artifactPath),"utf8"));assert.equal(persisted.body,'{"actualResponse":"synthetic-private-evidence"}');
  assert.equal((await stat(path.join(root,artifactPath))).mode&0o777,0o600);
  await assert.rejects(stat(outside));await worker.close();
 }finally{delete process.env.RHIZ_HTTP_PROOF_SECRET;await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});await rm(outside,{force:true});}
});

test("symlink write scope is refused before any broker effect",async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"rhiz-http-symlink-")));const outside=await realpath(await mkdtemp(path.join(tmpdir(),"rhiz-http-outside-")));
 try{await symlink(outside,path.join(root,"evidence"));const worker=new ContainedHttpEffectWorkerProvider({sandbox:null,toolName:"fixture",artifactPath});await assert.rejects(worker.start(request(root),{guardedToolMediation:guard(request(root)),httpEffects:{invoke:async()=>{assert.fail("symlink effect");}}}),/Symlink/);}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test("existing receipt refuses before HTTP, preserving its owner",{skip:process.platform!=="darwin"},async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"rhiz-http-collision-")));
 try{await mkdir(path.join(root,"evidence"));await writeFile(path.join(root,artifactPath),"existing-owner");const worker=new ContainedHttpEffectWorkerProvider({sandbox:new MacosSandboxExecLauncher(),toolName:"fixture",artifactPath});
 const handle=await worker.start(request(root),{guardedToolMediation:guard(request(root)),httpEffects:{invoke:async()=>{assert.fail("receipt collision sent HTTP");}}});
 assert.equal((await handle.result()).status,"failed");assert.equal(await readFile(path.join(root,artifactPath),"utf8"),"existing-owner");await worker.close();
 }finally{await rm(root,{recursive:true,force:true});}
});

test("actual Crew and contained host retain real observations and zero Board violations",{skip:process.platform!=="darwin"},async()=>{
 const {execFileSync}=await import("node:child_process");const {CrewSupervisor,parseCrewPlan}=await import("../src/crew.js");
 const {GitWorktreeWorkspaceProvider}=await import("../adapters/git/worktrees.js");const {WorkerCatalog}=await import("../src/workers.js");const {InMemoryEventLedger}=await import("../src/ledger.js");const {httpEffectResourceUri}=await import("../src/http-effects.js");
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"rhiz-http-crew-")));const repo=path.join(root,"repo");await mkdir(path.join(repo,"evidence"),{recursive:true});await writeFile(path.join(repo,"evidence/.gitkeep"),"");
 const git=(...args:string[])=>execFileSync("git",["-C",repo,...args],{encoding:"utf8"}).trim();git("init","-q");git("add",".");git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixture");
 const worker=new ContainedHttpEffectWorkerProvider({sandbox:new MacosSandboxExecLauncher(),toolName:"fixture.post",artifactPath});const host=new ContainedHttpEffectHost(worker);const catalog=new WorkerCatalog();catalog.registerHost(host);
 const workspaceProvider=new GitWorktreeWorkspaceProvider({repositoryRoot:repo,worktreeRoot:path.join(root,"worktrees")});
 const contract=request(repo).work;const url="https://example.invalid/fixed-post";contract.authority.grants.push({action:"external-mutate",resources:[{uri:httpEffectResourceUri("POST",url)}],constraints:[]});
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{"fixture":true}',{status:201});
 try{const run=await new CrewSupervisor({plan:parseCrewPlan({id:"crew:http-proof",objective:contract.objective,baseRevision:git("rev-parse","HEAD"),maxParallel:1,missions:[{work:contract,workspace:{strategy:"fresh",mode:"isolated-write"},requiredCapabilities:["guardedToolMediation"]}]}),ledger:new InMemoryEventLedger(),workerCatalog:catalog,workspaceProvider,actor:human,httpEffects:[{toolName:"fixture.post",method:"POST",url,credential:()=>"fixture-credential"}]}).run();
 const mission=run.receipt.missions[0]!;assert.equal(mission.status,"execution-finished",mission.error ?? "Crew failed");assert.equal(mission.projectionViolationCount,0);assert.ok(mission.observationCount>0);assert.deepEqual(mission.changeViolations,[]);await run.close();
 }finally{globalThis.fetch=originalFetch;await host.close();await workspaceProvider.close();await rm(root,{recursive:true,force:true});}
});

test("cancelling contained host during credential retrieval prevents actual broker fetch",{skip:process.platform!=="darwin"},async()=>{
 const {HttpEffectBroker,httpEffectResourceUri,getHttpEffectPolicyBindings}=await import("../src/http-effects.js");
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"rhiz-http-cancel-")));await mkdir(path.join(root,"evidence"));
 let release:(value:string)=>void=()=>{};let credentialStarted:()=>void=()=>{};const started=new Promise<void>(resolve=>{credentialStarted=resolve;});const delayed=new Promise<string>(resolve=>{release=resolve;});
 const binding={toolName:"fixture.post",method:"POST" as const,url:"https://example.invalid/fixed",credential:()=>{credentialStarted();return delayed;}};
 const input=request(root);input.work.authority.grants.push({action:"external-mutate",resources:[{uri:httpEffectResourceUri("POST",binding.url)}],constraints:[]});
 const policy=guardPolicyFromWorkContract(input.work,{httpEffects:getHttpEffectPolicyBindings([binding]).map(item=>({...item,decision:"forbid" as const}))});
 const mediation=createGuardedToolMediation({oracle:createDefaultPolicyOracle(policy),policy,circuitBreaker:new GuardianRejectionCircuitBreaker(policy.circuitBreaker),workId:input.work.id,taskId:input.taskId,attemptId:input.attemptId,actor:human,writeScope:"workspace",contextHash:"fixture",record:async()=>{},requireRecordBeforeEffect:true});
 const broker=new HttpEffectBroker({bindings:[binding],work:input.work,guard:mediation,signal:new AbortController().signal,isActive:()=>true,fetch:async()=>{assert.fail("cancelled host dispatched HTTP");}});
 const worker=new ContainedHttpEffectWorkerProvider({sandbox:new MacosSandboxExecLauncher(),toolName:binding.toolName,artifactPath});
 try{const handle=await worker.start(input,{guardedToolMediation:guard(input),httpEffects:broker.port()});const result=handle.result();await Promise.race([started,result.then(value=>assert.fail(`contained worker exited before credential retrieval: ${value.summary}`))]);await handle.cancel("fixture cancellation");release("credential");assert.equal((await result).status,"failed");await assert.rejects(stat(path.join(root,artifactPath)));}
 finally{release("credential");await worker.close();await rm(root,{recursive:true,force:true});}
});
