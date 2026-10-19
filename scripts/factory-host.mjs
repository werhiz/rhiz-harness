// Host side of Factory dispatch. macOS refuses a nested sandbox_apply, so the
// worker's own containment cannot start inside the dispatch sandbox. The
// sandboxed dispatcher selects Work and writes its inputs; this unsandboxed host
// rebuilds the one permitted `rhiz-harness start` invocation from the pinned
// profile and runs it only when every input matches what Dispatch generates.
// The model process and its file write stay in the worker's own OS sandbox.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {attachProcessCensus,excludeProcess} from './factory-sessions.mjs';
import {Profile,runtimeDigest,workerLockArgs,verifyCheck,agentCensus} from './factory-dispatch.mjs';

const WORK_ID=/^work:studio-link-[a-f0-9]{24}$/;
const SAFE_PATH=/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Validate a dispatch request and return the exact command the host may run. */
export function executionPlan(profilePath,request,node=process.execPath){
 const p=Profile.parse(JSON.parse(fs.readFileSync(profilePath)));
 if(!p.enabled)throw Error('Execution disabled');
 if(request?.type!=='factory-execute'||!WORK_ID.test(request.workId??''))throw Error('Malformed execution request');
 const git=(...args)=>{const r=spawnSync('/usr/bin/git',args,{cwd:p.repo,encoding:'utf8'});if(r.status!==0)throw Error('Host git census failed');return r.stdout.trim();};
 if(git('-C',p.runtime,'rev-parse','HEAD')!==p.runtimeHead||runtimeDigest(p.runtime)!==p.runtimeDigest)throw Error('Pinned runtime changed');
 const root=path.join(git('rev-parse','--path-format=absolute','--git-common-dir'),'rhiz-harness');
 const inputDir=path.join(root,'dispatch-inputs',request.workId);
 const read=name=>{const f=path.join(inputDir,name+'.json'),st=fs.lstatSync(f);if(!st.isFile()||st.nlink!==1)throw Error('Dispatch input must be a regular file');return JSON.parse(fs.readFileSync(f,'utf8'));};
 const work=read('work'),verify=read('verify'),local=read('local'),approved=JSON.parse(fs.readFileSync(p.localConfig,'utf8'));
 const file=local.permittedPaths?.[0];
 if(local.permittedPaths?.length!==1||!p.allowedFiles.includes(file)||!same({...local,permittedPaths:approved.permittedPaths},approved))throw Error('Local worker config differs from the approved offline config');
 if(approved.backend!=='llama-cli'||approved.autonomousPaidBudgetUsd!==0||approved.cloudFallback!==false)throw Error('Only pinned offline CLI execution is eligible');
 const resource={uri:'repo://studio/'+file,kind:'file'};
 if(work.id!==request.workId||work.type!=='SHIP'||!same(work.writeScope,[resource])||!same(work.authority?.grants?.[1],{action:'write',resources:[resource],constraints:[]})||work.authority.grants.length!==2
  ||!same(work.workerPolicy,{preferredProviders:['worker:local-model'],maxAttempts:1,attemptBudgetMs:120000,allowParallelAttempts:false,explicitProviderAuthorizations:[]}))throw Error('Work contract is not a Dispatch broken-link repair');
 // Verifier commands are not separately sandboxed, so only Dispatch's exact template runs.
 const checks=verify.checks??[],config=checks[0]?.config,code=config?.args?.[1]??'';
 const m=code.match(/^const fs=require\('node:fs'\),crypto=require\('node:crypto'\);if\(crypto\.createHash\('sha256'\)\.update\(fs\.readFileSync\(("[^"\\]*")\)\)\.digest\('hex'\)!==("[a-f0-9]{64}")\|\|!fs\.existsSync\(("[^"\\]*")\)\)process\.exit\(1\);$/);
 const destination=m&&JSON.parse(m[3]);
 if(verify.workId!==request.workId||checks.length!==2||!m||JSON.parse(m[1])!==file||!SAFE_PATH.test(destination)||destination.split('/').includes('..')||code!==verifyCheck(file,JSON.parse(m[2]),destination)
  ||!same(config,{command:node,args:['-e',code],expectedExitCodes:[0],evidenceKind:'test'})||!same(checks[1].config,config)
  ||checks.some(c=>c.providerId!=='verifier:local-command')||checks[1].negativeControlFor!==checks[0].id||checks[1].perturbation?.kind!=='overwrite-file'||checks[1].perturbation.path!==file)throw Error('Verify plan is not the Dispatch template');
 const args=[path.join(p.runtime,'scripts/rhiz-harness.mjs'),'start','--repo',p.repo,'--contract',path.join(inputDir,'work.json'),'--verify',path.join(inputDir,'verify.json'),'--local-config',path.join(inputDir,'local.json'),'--json'];
 return {command:'/usr/bin/perl',args:workerLockArgs(path.join(root,'factory-worker.lock'),node,args),cwd:p.repo,log:path.join(inputDir,'execution.log')};
}

/** Engineering processes the host sees in the profile's target roots, minus the dispatcher. */
export function rootAgents(profilePath,dispatcherPid){
 const p=Profile.parse(JSON.parse(fs.readFileSync(profilePath))),roots=[p.repo,p.coordinationRepo];
 const r=spawnSync('/usr/sbin/lsof',['-a','-u',String(process.getuid()),'-d','cwd','-Fpcn','+c','0'],{encoding:'utf8',maxBuffer:8*2**20});
 if(r.status!==0)throw Error('Host process census unavailable');
 return excludeProcess(agentCensus(r.stdout),dispatcherPid).filter(a=>roots.includes(a.cwd));
}

/** Serve census and execution requests from the sandboxed dispatcher over its IPC channel. */
export function attachFactoryHost(child,{profilePath,getAgents=()=>rootAgents(profilePath,child.pid)}){
 attachProcessCensus(child,getAgents);
 let running=null;
 const reply=(nonce,result)=>{if(child.connected)child.send({type:'factory-execute-result',nonce,...result},()=>undefined);};
 child.on('message',m=>{
  if(m?.type!=='factory-execute'||typeof m.nonce!=='string'||m.nonce.length>100)return;
  if(running){reply(m.nonce,{error:'Host already running one Work'});return;}
  let plan;try{plan=executionPlan(profilePath,m);}catch(e){reply(m.nonce,{error:e.message});return;}
  const log=fs.openSync(plan.log,'w',0o600);
  running=spawn(plan.command,plan.args,{cwd:plan.cwd,detached:true,stdio:['ignore',log,log],env:{...process.env,RHIZ_LOCAL_ONLY:'1',RHIZ_AUTONOMOUS_CONTEXT:'1',TMPDIR:'/private/tmp',GIT_OPTIONAL_LOCKS:'0'}});
  const timer=setTimeout(()=>{try{process.kill(-running.pid,'SIGTERM');}catch{}},180000);
  const done=result=>{clearTimeout(timer);fs.closeSync(log);running=null;reply(m.nonce,result);};
  running.once('error',e=>done({error:e.message}));
  running.once('close',code=>done({code}));
 });
 child.once('close',()=>{if(running){try{process.kill(-running.pid,'SIGTERM');}catch{}}});
}
