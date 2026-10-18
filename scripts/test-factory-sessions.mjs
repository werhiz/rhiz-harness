import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {parseProcessRows,processSource,validateProcessSnapshot,sessionOwnership,attachProcessCensus} from './factory-sessions.mjs';
import {scopeClaimsFile,ownershipScopes,agentCensus} from './factory-dispatch.mjs';
import {bindSession} from './factory-session.mjs';
import {work} from '../dist/test/helpers.js';
import {readRepositoryWorkEvents} from '../dist/adapters/local/work-ledgers.js';
const a={pid:'123',ppid:'1',uid:process.getuid(),birth:'a'.repeat(64),command:'codex',cwd:'/repo'};
const board=(overrides={})=>({workId:'work:owner',state:'running',sessionBindingSource:processSource(a),contract:{writeScope:[{uri:'repo://studio/src/a.ts',kind:'file'}]},integration:{latestExecutionObservation:{state:'running',source:processSource(a),observedAt:'2000-01-01T00:00:00Z'}},...overrides});
const classify=(agents,boards,snapshot=[a])=>sessionOwnership(agents,boards,['/repo'],snapshot);
test('unknown primary owner remains ambiguous with exact PID and a resolution action',()=>{const r=classify([a],[])[0];assert.equal(r.status,'ambiguous');assert.match(r.resolution,/PID 123.*factory-session/);});
test('scoped primary owner preserves full Work claims; unrelated file remains eligible',()=>{const b=board();assert.equal(classify([a],[b])[0].status,'scoped');const scopes=ownershipScopes(b,{});assert(scopeClaimsFile(scopes,'src/a.ts'));assert(!scopeClaimsFile(scopes,'docs/reference/b.md'));});
test('running session cannot narrow canonical directory to a prior completed checkpoint file',()=>{const b=board({contract:{writeScope:[{uri:'repo://studio/docs/reference',kind:'directory'}]}});assert(scopeClaimsFile(ownershipScopes(b,{}),'docs/reference/b.md'));});
test('live nonrunning observations preserve full scope regardless checkpoint narrowing',()=>{for(const state of ['blocked','verifying','parked']){const b=board({integration:{latestExecutionObservation:{state,source:processSource(a)}}});assert.equal(classify([a],[b])[0].status,'scoped');assert(scopeClaimsFile(ownershipScopes(b,{},true),'src/a.ts'));}});
test('one unknown overlapping session still blocks; no ownership inferred from another process',()=>{const other={...a,pid:'124'};assert.deepEqual(classify([a,other],[board()],[a,other]).map(x=>x.status),['scoped','ambiguous']);});
test('delayed heartbeat and expired attempt do not expire live Work scope',()=>{assert.equal(classify([a],[board()])[0].status,'scoped');});
test('PID reuse does not inherit a prior birth binding',()=>{assert.equal(classify([a],[board()],[{...a,birth:'b'.repeat(64)}])[0].status,'ambiguous');});
test('resumed worker requires explicit binding to the new process identity',()=>{const resumed={...a,pid:'124',birth:'b'.repeat(64)};assert.equal(classify([resumed],[board()],[resumed])[0].status,'ambiguous');const source=processSource(resumed);assert.equal(classify([resumed],[board({sessionBindingSource:source,integration:{latestExecutionObservation:{source}}})],[resumed])[0].status,'scoped');});
test('terminal Work and worker-authored observations cannot resolve live sessions',()=>{assert.equal(classify([a],[board({state:'accepted'})])[0].status,'ambiguous');assert.equal(classify([a],[board({sessionBindingSource:null})])[0].status,'ambiguous');});
test('owned Node child inherits only an actually observed live ancestor binding',()=>{const child={...a,pid:'124',ppid:'123',command:'node'};assert.equal(classify([child],[board()],[a,child])[0].status,'scoped');assert.equal(classify([child],[board()],[{...a,birth:'b'.repeat(64)},child])[0].status,'ambiguous');});
test('unrelated repository sessions do not block target dispatch',()=>{assert.deepEqual(classify([{...a,cwd:'/other'}],[]),[]);});
test('birth census parses exact uid and parent/start identity, not elapsed age',()=>{const rows=parseProcessRows(`123 1 ${process.getuid()} Sun Oct 18 13:00:00 2026 /usr/bin/codex\n124 1 999 Sun Oct 18 13:00:00 2026 /usr/bin/claude`,process.getuid());assert.equal(rows.size,1);assert.match(rows.get('123').birth,/^[a-f0-9]{64}$/);assert.throws(()=>parseProcessRows('',process.getuid()),/unavailable/);});
test('old snapshot cannot resolve a reused PID even if lsof tuple is unchanged',()=>{const now=Date.now(),s={schema:'rhiz/process-census/v1',at:new Date(now-1).toISOString(),uid:process.getuid(),processes:[a]};assert.throws(()=>validateProcessSnapshot(s,[a],now,now),/Fresh/);});
test('fresh census rejects changed processes, duplicate identities and future observations',()=>{const now=Date.now(),s={schema:'rhiz/process-census/v1',at:new Date(now).toISOString(),uid:process.getuid(),processes:[a]};assert.equal(validateProcessSnapshot(s,[a],now,now)[0].pid,'123');assert.throws(()=>validateProcessSnapshot(s,[{...a,cwd:'/changed'}],now,now),/changed/);assert.throws(()=>validateProcessSnapshot({...s,processes:[a,a]},[a],now,now),/Invalid/);assert.throws(()=>validateProcessSnapshot({...s,at:new Date(now+2000).toISOString()},[a],now,now),/Fresh/);});
test('unattended worker cannot bind itself or change coordination scope',async()=>{const before=process.env.RHIZ_AUTONOMOUS_CONTEXT;process.env.RHIZ_AUTONOMOUS_CONTEXT='1';try{await assert.rejects(bindSession({}),/trusted operator/);}finally{if(before===undefined)delete process.env.RHIZ_AUTONOMOUS_CONTEXT;else process.env.RHIZ_AUTONOMOUS_CONTEXT=before;}});
test('native sandbox gets a minimal fresh birth census through existing host IPC',{skip:process.platform!=='darwin'},async()=>{
 const mod=new URL('./factory-sessions.mjs',import.meta.url).href;
 const child=spawn('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)',''+process.execPath,'--input-type=module','-e',`import{freshProcessSnapshot}from ${JSON.stringify(mod)};const rows=await freshProcessSnapshot([]);console.log(rows.some(p=>p.pid===String(process.pid)));process.disconnect();`],{stdio:['ignore','pipe','pipe','ipc']});
 attachProcessCensus(child,()=>[{pid:String(child.pid),command:path.basename(process.execPath),cwd:process.cwd()}]);let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);const code=await new Promise(r=>child.once('close',r));assert.equal(code,0,errors);assert.match(output,/true/);
});
test('operator binding appends canonical Work observations, never acceptance; repeat keeps one Work',{skip:process.platform!=='darwin'},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'factory-bind-test-'));
 const git=args=>{const r=spawnSync('/usr/bin/git',args,{cwd:dir,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{git(['init','-q']);git(['-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid','commit','--allow-empty','-m','fixture','-q']);const contract=work({id:'work:session-fixture'}),file=path.join(dir,'work.json');fs.writeFileSync(file,JSON.stringify(contract));const r=await bindSession({repo:dir,contractFile:file,pid:process.pid});assert.equal(r.workId,contract.id);assert.equal(r.accepted,false);await bindSession({repo:dir,contractFile:file,pid:process.pid});const snapshot=await readRepositoryWorkEvents(path.join(dir,'.git'));assert.equal(snapshot.unreadable.length,0);assert.equal(snapshot.events.filter(e=>e.type==='work.created').length,1);assert.equal(snapshot.events.filter(e=>e.type==='integration.execution-observed').length,2);assert(!snapshot.events.some(e=>e.type==='work.accepted'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
