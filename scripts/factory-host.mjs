// Host side of Factory dispatch. macOS refuses a nested sandbox_apply, so the
// worker's own containment cannot start inside the dispatch sandbox. The
// sandboxed dispatcher selects Work and writes its inputs; this unsandboxed host
// rebuilds the one permitted `rhiz-harness start` invocation from the pinned
// profile and runs it only when every input equals what Dispatch generates, from
// a host-private snapshot of the validated bytes. The model process and its file
// write stay in the worker's own OS sandbox. The dispatch sandbox profile must not
// grant writes to the Ledger, operator inputs or object store (see
// docs/STUDIO_DECISION_EVIDENCE.md), because `start` copies its inputs there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {attachProcessCensus,excludeProcess} from './factory-sessions.mjs';
import {Profile,runtimeDigest,workerLockArgs,verifyCheck,agentCensus,dispatchInputs} from './factory-dispatch.mjs';

const WORK_ID=/^work:studio-link-[a-f0-9]{24}$/;
const SAFE_PATH=/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export const HOST_ROOT=path.join(os.homedir(),'Library','Application Support','RhizStudio','factory-host');
const JSON_STRING='"(?:[^"\\\\]|\\\\.)*"';
const CHECK=/^const fs=require\('node:fs'\),crypto=require\('node:crypto'\);if\(crypto\.createHash\('sha256'\)\.update\(fs\.readFileSync\(("[^"\\]*")\)\)\.digest\('hex'\)!==("[a-f0-9]{64}")\|\|!fs\.existsSync\(("[^"\\]*")\)\)process\.exit\(1\);$/;
/** One bounded read through a no-follow descriptor; the bytes read are the bytes validated and run. */
function readOnce(file){
 let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(e){throw Error(e.code==='ELOOP'?'Dispatch input must be a bounded regular file, not a symlink':'Dispatch input unavailable: '+e.code);}
 try{const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>2**20)throw Error('Dispatch input must be a bounded regular file');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
/** A host-owned 0700 directory the dispatch sandbox cannot write. */
function privateDirectory(root){
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const st=fs.lstatSync(root);if(!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o077)!==0)throw Error('Host input root must be a private directory owned by the host');
 return fs.realpathSync(fs.mkdtempSync(path.join(root,'run-')));
}

/**
 * Validate a dispatch request against the exact inputs Dispatch generates, snapshot
 * the validated bytes into a host-private directory, and return the one command the
 * host may run. Nothing the sandbox can still write is handed to `start`.
 */
export function executionPlan(profilePath,request,{node=process.execPath,hostRoot=HOST_ROOT}={}){
 const p=Profile.parse(JSON.parse(fs.readFileSync(profilePath)));
 if(!p.enabled)throw Error('Execution disabled');
 if(request?.type!=='factory-execute'||!WORK_ID.test(request.workId??''))throw Error('Malformed execution request');
 const git=(...args)=>{const r=spawnSync('/usr/bin/git',args,{cwd:p.repo,encoding:'utf8'});if(r.status!==0)throw Error('Host git census failed');return r.stdout.trim();};
 if(git('-C',p.runtime,'rev-parse','HEAD')!==p.runtimeHead||runtimeDigest(p.runtime)!==p.runtimeDigest)throw Error('Pinned runtime changed');
 const root=path.join(git('rev-parse','--path-format=absolute','--git-common-dir'),'rhiz-harness');
 const inputDir=path.join(root,'dispatch-inputs',request.workId);
 const bytes=Object.fromEntries(['work','verify','local'].map(n=>[n,readOnce(path.join(inputDir,n+'.json'))]));
 const parse=n=>{try{return JSON.parse(bytes[n].toString('utf8'));}catch{throw Error('Dispatch input is not JSON');}};
 const work=parse('work'),verify=parse('verify'),local=parse('local'),approved=JSON.parse(fs.readFileSync(p.localConfig,'utf8'));
 if(approved.backend!=='llama-cli'||approved.autonomousPaidBudgetUsd!==0||approved.cloudFallback!==false)throw Error('Only pinned offline CLI execution is eligible');
 const file=local?.permittedPaths?.[0];
 if(!p.allowedFiles.includes(file))throw Error('Local worker config names an unapproved file');
 const objective=String(work?.objective??'').match(new RegExp(`^In ${file.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}, replace exactly (${JSON_STRING}) with (${JSON_STRING})\\. Repair only this proven broken link\\.$`));
 const m=String(verify?.checks?.[0]?.config?.args?.[1]??'').match(CHECK);
 const destination=m&&JSON.parse(m[3]),before=verify?.checks?.[1]?.perturbation?.content;
 if(!objective||!m||JSON.parse(m[1])!==file||!SAFE_PATH.test(destination)||destination.split('/').includes('..')||typeof before!=='string'||!Number.isFinite(Date.parse(work.createdAt)))throw Error('Inputs are not a Dispatch broken-link repair');
 // Rebuild every input with Dispatch's own builder; any other field, check or code is refused.
 const expected=dispatchInputs(request.workId,{file,oldText:JSON.parse(objective[1]),newText:JSON.parse(objective[2]),before,after:'',destination},approved,node);
 expected.work.createdAt=work.createdAt;
 for(const c of expected.verify.checks)c.config.args[1]=verifyCheck(file,JSON.parse(m[2]),destination);
 if(!same(work,expected.work))throw Error('Work contract is not the Dispatch template');
 if(!same(verify,expected.verify))throw Error('Verify plan is not the Dispatch template');
 if(!same(local,expected.local))throw Error('Local worker config differs from the approved offline config');
 const dir=privateDirectory(hostRoot);
 for(const [n,b] of Object.entries(bytes))fs.writeFileSync(path.join(dir,n+'.json'),b,{mode:0o600,flag:'wx'});
 fs.mkdirSync(path.join(dir,'tmp'),{mode:0o700});
 const args=[path.join(p.runtime,'scripts/rhiz-harness.mjs'),'start','--repo',p.repo,'--contract',path.join(dir,'work.json'),'--verify',path.join(dir,'verify.json'),'--local-config',path.join(dir,'local.json'),'--json'];
 return {command:'/usr/bin/perl',args:workerLockArgs(path.join(root,'factory-worker.lock'),node,args),cwd:p.repo,log:path.join(dir,'execution.log'),tmp:path.join(dir,'tmp'),dir};
}

/** Engineering processes the host sees in the profile's target roots, minus the dispatcher. */
export function rootAgents(profilePath,dispatcherPid){
 const p=Profile.parse(JSON.parse(fs.readFileSync(profilePath))),roots=[p.repo,p.coordinationRepo];
 const r=spawnSync('/usr/sbin/lsof',['-a','-u',String(process.getuid()),'-d','cwd','-Fpcn','+c','0'],{encoding:'utf8',maxBuffer:8*2**20});
 if(r.status!==0)throw Error('Host process census unavailable');
 return excludeProcess(agentCensus(r.stdout),dispatcherPid).filter(a=>roots.includes(a.cwd));
}

/** Serve census and execution requests from the sandboxed dispatcher over its IPC channel. */
export function attachFactoryHost(child,{profilePath,hostRoot=HOST_ROOT,getAgents=()=>rootAgents(profilePath,child.pid)}){
 attachProcessCensus(child,getAgents);
 let running=null;
 const reply=(nonce,result)=>{if(child.connected)child.send({type:'factory-execute-result',nonce,...result},()=>undefined);};
 child.on('message',m=>{
  if(m?.type!=='factory-execute'||typeof m.nonce!=='string'||m.nonce.length>100)return;
  if(running){reply(m.nonce,{error:'Host already running one Work'});return;}
  let plan;try{plan=executionPlan(profilePath,m,{hostRoot});}catch(e){reply(m.nonce,{error:e.message});return;}
  const log=fs.openSync(plan.log,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  running=spawn(plan.command,plan.args,{cwd:plan.cwd,detached:true,stdio:['ignore',log,log],env:{...process.env,RHIZ_LOCAL_ONLY:'1',RHIZ_AUTONOMOUS_CONTEXT:'1',TMPDIR:plan.tmp,GIT_OPTIONAL_LOCKS:'0'}});
  const timer=setTimeout(()=>{try{process.kill(-running.pid,'SIGTERM');}catch{}},180000);
  const done=result=>{clearTimeout(timer);fs.closeSync(log);running=null;reply(m.nonce,result);};
  running.once('error',e=>done({error:e.message}));
  running.once('close',code=>done({code}));
 });
 child.once('close',()=>{if(running){try{process.kill(-running.pid,'SIGTERM');}catch{}}});
}
