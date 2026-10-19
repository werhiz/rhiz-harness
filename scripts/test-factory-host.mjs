import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {executionPlan,attachFactoryHost} from './factory-host.mjs';
import {dispatchInputs,runtimeDigest} from './factory-dispatch.mjs';
const workId='work:studio-link-'+'a'.repeat(24),file='docs/reference/a.md';
const approved={backend:'llama-cli',model:'qwen2.5-7b-instruct-q4_k_m',executable:'/opt/homebrew/bin/llama-completion',executableDigest:'1'.repeat(64),modelPath:'/m.gguf',digest:'2'.repeat(64),autonomousPaidBudgetUsd:0,cloudFallback:false,permittedPaths:['docs/quickstart.md']};
const task={file,oldText:'old',newText:'new',before:'old\n',after:'new\n',destination:'docs/reference/b.md'};
function fixture(){
 const d=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'factory-host-')));
 const git=(cwd,...args)=>{const r=spawnSync('/usr/bin/git',['-c','user.name=Fixture','-c','user.email=fixture@localhost.invalid',...args],{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 const runtime=path.join(d,'runtime'),repo=path.join(d,'repo'),marker=path.join(d,'out');
 for(const dir of [path.join(runtime,'dist'),path.join(runtime,'scripts'),repo,marker])fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(runtime,'dist/x.js'),'');
 fs.writeFileSync(path.join(runtime,'scripts/rhiz-harness.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(marker,'ran'))},JSON.stringify(process.argv.slice(2)));`);
 for(const r of [runtime,repo]){git(r,'init','-q');git(r,'add','-A');git(r,'commit','-q','--allow-empty','-m','fixture');}
 fs.writeFileSync(path.join(d,'local.json'),JSON.stringify(approved));
 const profile=path.join(d,'profile.json');
 fs.writeFileSync(profile,JSON.stringify({repo,coordinationRepo:repo,githubRepo:'fixture/repo',runtime,localConfig:path.join(d,'local.json'),allowedFiles:[file],runtimeHead:git(runtime,'rev-parse','HEAD'),runtimeDigest:runtimeDigest(runtime),scannerDigest:'3'.repeat(64),maxTasks:1,autonomousPaidBudgetUsd:0,cloudFallback:false,enabled:true,minFreePercent:25}));
 const inputDir=path.join(repo,'.git/rhiz-harness/dispatch-inputs',workId);fs.mkdirSync(inputDir,{recursive:true});
 const write=(inputs)=>{for(const [name,value] of Object.entries(inputs))fs.writeFileSync(path.join(inputDir,name+'.json'),JSON.stringify(value));};
 write(dispatchInputs(workId,task,approved));
 return {d,profile,runtime,inputDir,marker,write,cleanup:()=>fs.rmSync(d,{recursive:true,force:true})};
}
const request={type:'factory-execute',workId};
test('host rebuilds the pinned start invocation for exact Dispatch inputs',()=>{const f=fixture();try{const plan=executionPlan(f.profile,request);assert.equal(plan.command,'/usr/bin/perl');assert(plan.args.includes(path.join(f.runtime,'scripts/rhiz-harness.mjs')));assert(plan.args.includes(path.join(f.inputDir,'verify.json')));assert.equal(plan.log,path.join(f.inputDir,'execution.log'));}finally{f.cleanup();}});
test('host refuses every input Dispatch would not generate',()=>{
 const f=fixture();
 const refuse=(label,mutate,req=request)=>{const inputs=dispatchInputs(workId,task,approved);mutate(inputs);f.write(inputs);assert.throws(()=>executionPlan(f.profile,req),undefined,label);f.write(dispatchInputs(workId,task,approved));};
 try{
  refuse('arbitrary verifier code',i=>{for(const c of i.verify.checks)c.config.args[1]="require('node:child_process').execSync('touch /tmp/x')";});
  refuse('extra check',i=>{i.verify.checks.push({...i.verify.checks[0],id:'check:extra'});});
  refuse('other verifier command',i=>{for(const c of i.verify.checks)c.config.command='/bin/sh';});
  refuse('escaping destination',i=>{const code=i.verify.checks[0].config.args[1].replace('"docs/reference/b.md"','"../../etc/passwd"');for(const c of i.verify.checks)c.config.args[1]=code;});
  refuse('cloud fallback',i=>{i.local.cloudFallback=true;});
  refuse('different model executable',i=>{i.local.executable='/bin/sh';});
  refuse('unapproved file',i=>{i.local.permittedPaths=['docs/reference/other.md'];});
  refuse('paid provider',i=>{i.work.workerPolicy.preferredProviders=['worker:codex-app-server'];});
  refuse('wider write scope',i=>{i.work.writeScope=[{uri:'repo://studio',kind:'repository'}];});
  refuse('more attempts',i=>{i.work.workerPolicy.maxAttempts=3;});
  refuse('malformed Work id',()=>{},{type:'factory-execute',workId:'work:../../x'});
  fs.rmSync(path.join(f.inputDir,'local.json'));fs.symlinkSync(path.join(f.d,'local.json'),path.join(f.inputDir,'local.json'));
  assert.throws(()=>executionPlan(f.profile,request),/regular file/);fs.rmSync(path.join(f.inputDir,'local.json'));f.write(dispatchInputs(workId,task,approved));
  fs.appendFileSync(path.join(f.runtime,'dist/x.js'),'changed');assert.throws(()=>executionPlan(f.profile,request),/runtime changed/);
 }finally{f.cleanup();}
});
test('sandboxed dispatcher reaches the host; host-run Work escapes the dispatch sandbox only through the pinned plan',{skip:process.platform!=='darwin'},async()=>{
 const f=fixture();
 try{
  const profile=`(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(f.marker)}))`;
  const script=`const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(path.join(f.marker,'direct'))},'x');console.log('direct-write');}catch{}process.on('message',m=>{console.log(JSON.stringify(m));process.disconnect();});process.send({type:'factory-execute',nonce:'n1',workId:${JSON.stringify(workId)}});`;
  const child=spawn('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'-e',script],{stdio:['ignore','pipe','pipe','ipc']});
  attachFactoryHost(child,{profilePath:f.profile,getAgents:()=>[]});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  assert.equal(await new Promise(r=>child.once('close',r)),0,err);
  assert.doesNotMatch(out,/direct-write/,'dispatch sandbox must still deny the write');
  assert.match(out,/"type":"factory-execute-result","nonce":"n1".*"code":0/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.marker,'ran'),'utf8')).slice(0,1),['start']);
 }finally{f.cleanup();}
});
