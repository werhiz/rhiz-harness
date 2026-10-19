// Factory's bounded local dispatch adapter. Board/Ledger remain the only Work state.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRepositoryWorkEvents } from '../dist/adapters/local/work-ledgers.js';
import { observeFactory } from '../dist/src/observer.js';
import { projectBoard } from '../dist/src/board.js';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { candidatePathScopesFromResources } from "../dist/adapters/git/index.js";
import { summarizeOperatorWork } from '../dist/src/operator.js';
import { recommendEngineeringDecision } from '../dist/src/router.js';
import {freshProcessSnapshot,sessionOwnership,bindingSource,excludeProcess} from './factory-sessions.mjs';
const Profile=z.object({repo:z.string(),coordinationRepo:z.string(),githubRepo:z.string().regex(/^[\w-]+\/[\w-]+$/),runtime:z.string(),localConfig:z.string(),
 allowedFiles:z.array(z.string().regex(/^docs\/reference\/[A-Za-z0-9_/-]+\.md$/)).min(1).max(10),runtimeHead:z.string().regex(/^[a-f0-9]{40}$/),runtimeDigest:z.string().regex(/^[a-f0-9]{64}$/),
 scannerDigest:z.string().regex(/^[a-f0-9]{64}$/),maxTasks:z.number().int().min(1).max(3),
 autonomousPaidBudgetUsd:z.literal(0),cloudFallback:z.literal(false),enabled:z.boolean(),minFreePercent:z.number().min(20).max(90)}).strict();
export const workerLockArgs=(file,command,args=[])=>['-e','use Fcntl qw(:flock); $^F=255; open(my $lock, ">>", shift @ARGV) or die $!; flock($lock, LOCK_EX|LOCK_NB) or die "worker active"; exec @ARGV or die $!;',file,command,...args];
const hash=x=>createHash('sha256').update(x).digest('hex');
const run=(cmd,args,cwd)=>{const p=spawnSync(cmd,args,{cwd,encoding:'utf8',timeout:45000,maxBuffer:8*2**20,
 env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GH_PROMPT_DISABLED:'1',RHIZ_LOCAL_ONLY:'1',TMPDIR:'/private/tmp'}});
 if(p.error||p.status!==0)throw Error(`${cmd}: ${p.error?.message??p.stderr}`);return p.stdout;};
const git=(repo,...args)=>run('/usr/bin/git',args,repo).trim();
const json=(cmd,args,cwd)=>JSON.parse(run(cmd,args,cwd));
export function sufficientMemory(text,minimum){const free=Number(text.match(/free percentage:\s*(\d+)%/i)?.[1]);return Number.isFinite(free)&&free>=minimum;}
export function scopeClaimsFile(scopes,file){return scopes.some(s=>s.kind==='repository'||(s.kind==='file'?file===s.path:file===s.path||file.startsWith(s.path+'/')));}
export function agentCensus(text){const records=[];let current=null;for(const line of text.split('\n')){if(line.startsWith('p')){current={pid:line.slice(1)};records.push(current);}else if(current&&line.startsWith('c'))current.command=line.slice(1);else if(current&&line.startsWith('n'))current.cwd=line.slice(1);}if(!records.length)throw Error('Process census unavailable');return records.filter(r=>/^(?:codex|claude|opencode|mcode|node|node_repl)$/.test(r.command??'')).map(r=>{if(!r.cwd||!/^\d+$/.test(r.pid))throw Error('Active agent scope unavailable');return r;});}
export function runtimeDigest(root){const entries=[];const visit=dir=>{for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())visit(f);else if(e.isFile())entries.push([f,hash(fs.readFileSync(path.join(root,f)))]);else throw Error('Runtime symlink refused');}};visit('dist');visit('scripts');return hash(JSON.stringify(entries.sort((a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])))));}
export function ownershipScopes(board,w,liveSession=false){
 // Only a currently proven live session keeps the whole scope; a dead owner's last
 // 'running' observation falls back to checkpoint narrowing.
 if(liveSession)return candidatePathScopesFromResources(board.contract.writeScope);
 if(!board.integration)return candidatePathScopesFromResources(board.contract.writeScope);
 const scopes=[];
   const h=board.integration.headProof;
   const checkpoint=h?board.integration.checkpoints[h.checkpointId]:null;
   const noActive=!board.activeVerification&&!board.activeReview&&w.attempts.active===0&&Object.values(board.integration.taskStates).every(t=>t.resourceLeases.length===0)&&Object.keys(board.integration.reconciliations).length===0;
   const cleaned=Object.keys(board.attempts).length>0&&Object.keys(board.attempts).every(id=>['integrated','rescue-preserved'].includes(board.integration.cleanups[id]?.disposition));
   if(noActive&&cleaned&&checkpoint?.effectiveProofState==='passed'&&checkpoint.checkpoint.head===h.head&&checkpoint.checkpoint.changedResources.every(r=>r.kind==='path'))scopes.push(...checkpoint.checkpoint.changedResources.map(r=>({path:r.resource,kind:'file'})));
   else scopes.push(...candidatePathScopesFromResources(board.contract.writeScope));
 return scopes;
}
function assertRuntime(p){if(git(p.runtime,'rev-parse','HEAD')!==p.runtimeHead||git(p.runtime,'status','--porcelain','--untracked-files=no')||runtimeDigest(p.runtime)!==p.runtimeDigest)throw Error('Pinned source or built runtime changed');}
export async function dispatchLocalFactory(profilePath){
 const p=Profile.parse(JSON.parse(fs.readFileSync(profilePath)));
 for(const root of [p.repo,p.coordinationRepo,p.runtime])if(fs.realpathSync(root)!==root)throw Error('Physical roots required');
 const common=git(p.repo,'rev-parse','--path-format=absolute','--git-common-dir');
 const root=path.join(common,'rhiz-harness');fs.mkdirSync(root,{recursive:true,mode:0o700});
 const lock=path.join(root,'factory-dispatch.lock');
 if(fs.existsSync(lock)&&fs.statSync(lock).isDirectory())throw Error('Prior dispatcher still owns directory lock');
 run('/usr/bin/shlock',['-f',lock,'-p',String(process.pid)],p.repo);
 const report={schema:'rhiz/factory-dispatch/v1',at:new Date().toISOString(),selected:[],parked:[],paidInferenceUsd:0,accepted:0,merged:0};
 let child=null,stopping=false,killTimer=null;
 const stop=()=>{stopping=true;if(child){if(killTimer)return;const pid=child.pid;try{process.kill(-pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')console.error(e.message);}killTimer=setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')console.error(e.message);}},5000);killTimer.unref();}};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{
  if(!p.enabled){report.parked.push('Execution disabled');return report;}
  const workerLock=path.join(root,'factory-worker.lock');
  run('/usr/bin/perl',workerLockArgs(workerLock,'/usr/bin/true'),p.repo);
  assertRuntime(p);const sourceHead=git(p.repo,'rev-parse','HEAD');
  const memory=run('/usr/bin/memory_pressure',['-Q'],p.repo);report.memoryPressure=memory.trim();
  if(!sufficientMemory(memory,p.minFreePercent)){report.parked.push('Memory pressure or telemetry unavailable');return report;}
  const scanner=path.join(p.repo,'scripts/check_docs_links.mts');
  if(hash(fs.readFileSync(scanner))!==p.scannerDigest)throw Error('Approved discovery scanner changed');
  const local=JSON.parse(fs.readFileSync(p.localConfig));
  if(local.backend!=='llama-cli'||local.autonomousPaidBudgetUsd!==0||local.cloudFallback!==false)throw Error('Only pinned offline CLI execution is eligible');
  const { localEditablePath }=await import(pathToFileURL(path.join(p.runtime,'dist/adapters/local/model-worker.js')));
  const allowed=p.allowedFiles.filter(file=>{if(localEditablePath(file))return true;report.parked.push(file+': reserved worker path');return false;});
  if(!allowed.length)return report;
  const runtimeCli=path.join(p.runtime,'scripts/rhiz-harness.mjs');
  const files=git(p.repo,'ls-files').split('\n');
  const pathsByName=new Map();for(const file of files){const name=path.basename(file);pathsByName.set(name,[...(pathsByName.get(name)??[]),file]);}
  const scan=spawnSync(process.execPath,['--experimental-strip-types',scanner,...allowed],{cwd:p.repo,encoding:'utf8',timeout:30000,maxBuffer:2**20});
  if(scan.error||![0,1].includes(scan.status))throw Error('Discovery scanner failed');
  const proposals=[];
  for(const line of (scan.stderr??'').split('\n')){
   const m=line.match(/^(.+\.md):(\d+): ([A-Za-z0-9_.:\/-]+) \((?:target does not exist|file:\/\/ links are not portable)\)$/);if(!m||!allowed.includes(m[1]))continue;
   const [file,target]=[m[1],m[3]];let choices=pathsByName.get(path.basename(target))??[];
   if(choices.length>1){const suffix=target.replace(/^(?:\.\.?\/)+/,'');choices=choices.filter(f=>f.endsWith(suffix));}
   if(choices.length!==1){report.parked.push(`${file}: ambiguous or missing target ${target}`);continue;}
   const replacement=path.relative(path.dirname(file),choices[0]);
   const before=fs.readFileSync(path.join(p.repo,file),'utf8'), oldText=before.split('\n')[Number(m[2])-1],newText=oldText.replace(`](${target})`,`](${replacement})`);
   if(oldText.length>2000)continue;
   if(before.split(oldText).length!==2)continue;
   proposals.push({file,target,destination:choices[0],oldText,newText,before,after:before.replace(oldText,newText),value:10,verificationCost:1,risk:1});
  }
  // Snapshot every source of ownership before selection; unavailable means no dispatch.
  const census=async()=>{
  const prs=json('gh',['pr','list','--repo',p.githubRepo,'--state','open','--limit','1000','--json','number,title,headRefName,files'],p.repo);
  const issues=json('gh',['issue','list','--repo',p.githubRepo,'--state','open','--limit','1000','--json','number,title,body,assignees'],p.repo);
  if(prs.length===1000||issues.length===1000)throw Error('Coordination census truncated; park selection');
  for(const pr of prs)if(pr.files?.length>=100){const count=json('gh',['pr','view',String(pr.number),'--repo',p.githubRepo,'--json','changedFiles'],p.repo).changedFiles;const names=run('gh',['api','--paginate',`repos/${p.githubRepo}/pulls/${pr.number}/files?per_page=100`,'--jq','.[].filename'],p.repo).trim().split('\n');if(names.length!==count||count>=3000)throw Error('PR file census incomplete');pr.files=names.map(path=>({path}));}
  const ownership=new Set(prs.flatMap(pr=>(pr.files??[]).map(f=>f.path)));
  for(const line of git(p.coordinationRepo,'worktree','list','--porcelain').split('\n'))if(line.startsWith('worktree ')){
   const tree=line.slice(9);for(const file of git(tree,'diff','--name-only','HEAD').split('\n'))if(file)ownership.add(file);
   const branch=git(tree,'rev-parse','HEAD');for(const file of git(p.coordinationRepo,'diff','--name-only','main...'+branch).split('\n'))if(file)ownership.add(file);
  }
  const state=json(process.execPath,[runtimeCli,'status','--repo',p.repo,'--json'],p.repo);
  if(state.unreadable.length)throw Error('Unreadable Work census');
  const primaryCommon=git(p.coordinationRepo,'rev-parse','--path-format=absolute','--git-common-dir');
  const primary=await readRepositoryWorkEvents(primaryCommon);if(primary.unreadable.length)throw Error('Primary Work census unavailable');
  const all=await readRepositoryWorkEvents(common);if(all.unreadable.length)throw Error('Work ownership evidence incomplete');
  const grouped=new Map(),identities=new Map();
  for(const e of [...all.events,...primary.events]){if(identities.has(e.id)){if(identities.get(e.id)!==JSON.stringify(e))throw Error('Conflicting canonical Work history');continue;}identities.set(e.id,JSON.stringify(e));grouped.set(e.workId,[...(grouped.get(e.workId)??[]),e]);}
  const attempted=new Set(grouped.keys()),activeScopes=[],boards=[];
  for(const events of grouped.values()){
   const board=projectBoard(events),w=summarizeOperatorWork(events);if(board.violations.length||!board.contract)throw Error('Invalid canonical Work ownership');
   boards.push({...board,sessionBindingSource:bindingSource(board,events)});
   if(['accepted','rejected','cancelled'].includes(board.state))continue;
   activeScopes.push(...ownershipScopes(board,w));
  }
  const processes=excludeProcess(agentCensus(run('/usr/sbin/lsof',['-a','-u',String(process.getuid()),'-d','cwd','-Fpcn','+c','0'],p.repo)));
  const roots=[p.repo,p.coordinationRepo];
  const snapshot=await freshProcessSnapshot(processes.filter(a=>roots.includes(a.cwd)));
  const current=excludeProcess(agentCensus(run('/usr/sbin/lsof',['-a','-u',String(process.getuid()),'-d','cwd','-Fpcn','+c','0'],p.repo))).filter(a=>roots.includes(a.cwd));
  for(const a of current)if(!snapshot.some(s=>s.pid===a.pid&&s.command===a.command&&s.cwd===a.cwd))throw Error(`New or changed primary session ${a.pid}; refresh census before dispatch`);
  const sessions=sessionOwnership(current,boards,roots,snapshot);
  for(const id of new Set(sessions.flatMap(s=>s.workIds))){const b=boards.find(b=>b.workId===id);activeScopes.push(...ownershipScopes(b,{},true));}
  report.sessions=sessions;
  report.agentsChecked=processes.length;
  return {ownership,issues,attempted,activeScopes,ambiguous:sessions.filter(s=>s.status==='ambiguous')};};
  proposals.sort((a,b)=>(b.value-b.risk-b.verificationCost)-(a.value-a.risk-a.verificationCost)||Buffer.compare(Buffer.from(a.file),Buffer.from(b.file)));
  const chosenFiles=new Set();
  for(const task of proposals){
   if(stopping||report.selected.length>=p.maxTasks)break;
   assertRuntime(p);if(git(p.repo,'rev-parse','HEAD')!==sourceHead||fs.readFileSync(path.join(p.repo,task.file),'utf8')!==task.before)throw Error('Discovery baseline changed');
   const {ownership,issues,attempted,activeScopes,ambiguous}=await census();
   if(ambiguous.length){report.parked.push(...ambiguous.map(s=>s.resolution));break;}
   const workId='work:studio-link-'+hash(JSON.stringify([git(p.repo,'rev-parse','HEAD'),task.file,task.oldText,task.newText])).slice(0,24);
   const claimed=ownership.has(task.file)||issues.some(i=>i.assignees.length&&[task.file,path.dirname(task.file)].some(scope=>`${i.title}\n${i.body}`.includes(scope)))||scopeClaimsFile(activeScopes,task.file);
   const action=recommendEngineeringDecision({kind:'priority',facts:{authorized:p.allowedFiles.includes(task.file),duplicate:claimed,
    verificationAvailable:true,priorityValue:task.value,risk:task.risk,verificationCost:task.verificationCost}});
   if(action!=='execute'||attempted.has(workId)||chosenFiles.has(task.file)){report.parked.push(`${workId}: ${attempted.has(workId)?'already attempted':action}`);continue;}
   chosenFiles.add(task.file);
   const inputDir=path.join(root,'dispatch-inputs',workId);fs.mkdirSync(inputDir,{recursive:true,mode:0o700});
   const resource={uri:'repo://studio/'+task.file,kind:'file'};
   const work={id:workId,objective:`In ${task.file}, replace exactly ${JSON.stringify(task.oldText)} with ${JSON.stringify(task.newText)}. Repair only this proven broken link.`,type:'SHIP',
    scope:[{uri:'repo://studio',kind:'repository'}],writeScope:[resource],nonGoals:['No other changes, network, publication, acceptance or learning promotion.'],
    authority:{grants:[{action:'read',resources:[{uri:'repo://studio',kind:'repository'}],constraints:[]},{action:'write',resources:[resource],constraints:[]}],requiresHumanApproval:['approve','publish','spend','external-mutate']},
    acceptanceCriteria:[{id:'criterion:link',description:'Exact file-only repair to existing unambiguous target',required:true}],
    requiredEvidence:[{id:'evidence:link',description:'Independent content digest and disposable negative control',acceptedKinds:['test'],required:true}],
    context:{strategy:'minimal',resources:[],includeHistory:false},dependencies:[],workerPolicy:{preferredProviders:['worker:local-model'],maxAttempts:1,attemptBudgetMs:120000,allowParallelAttempts:false,explicitProviderAuthorizations:[]},
    verificationPolicy:{required:true,independentActor:true,reviewRequired:true,falsifiabilityExemptions:[]},createdBy:{id:'human:werhiz',kind:'human',displayName:'Standing low-risk local Studio authorization'},createdAt:new Date().toISOString()};
   const check=`const fs=require('node:fs'),crypto=require('node:crypto');if(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(task.file)})).digest('hex')!==${JSON.stringify(hash(task.after))}||!fs.existsSync(${JSON.stringify(task.destination)}))process.exit(1);`;
   const config={command:process.execPath,args:['-e',check],expectedExitCodes:[0],evidenceKind:'test'};
   const verify={id:'plan:'+workId,workId,contractRevision:1,checks:[{id:'check:link',providerId:'verifier:local-command',description:'Exact trusted repair digest',criterionIds:['criterion:link'],requirementIds:['evidence:link'],config},
    {id:'check:negative',providerId:'verifier:local-command',description:'Reject stale link',negativeControlFor:'check:link',perturbation:{kind:'overwrite-file',path:task.file,content:task.before,description:'Restore known broken link in disposable derivative'},config}]};
   for(const [name,value] of Object.entries({work,verify,local:{...local,permittedPaths:[task.file]}}))fs.writeFileSync(path.join(inputDir,name+'.json'),JSON.stringify(value,null,2),{mode:0o600});
   const args=[runtimeCli,'start','--repo',p.repo,'--contract',path.join(inputDir,'work.json'),'--verify',path.join(inputDir,'verify.json'),'--local-config',path.join(inputDir,'local.json'),'--json'];
   const log=fs.openSync(path.join(inputDir,'execution.log'),'w',0o600),start=Date.now();
   const code=await new Promise((resolve,reject)=>{child=spawn('/usr/bin/perl',workerLockArgs(workerLock,process.execPath,args),{cwd:p.repo,detached:true,stdio:['ignore',log,log],
    env:{...process.env,RHIZ_LOCAL_ONLY:'1',TMPDIR:'/private/tmp',GIT_OPTIONAL_LOCKS:'0'}});const timer=setTimeout(stop,180000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);resolve(code);});});
   fs.closeSync(log);child=null;if(killTimer)clearTimeout(killTimer);
   let proof=null;
   if(code===0){const snapshot=await readRepositoryWorkEvents(common);if(snapshot.unreadable.length)throw Error('Post-run Ledger unreadable');
    const events=snapshot.events.filter(e=>e.workId===workId),board=projectBoard(events),v=events.findLast(e=>e.type==='verification.result'),h=board.integration.headProof;
    if(board.violations.length||!h||v?.payload.status!=='pass'||!v.payload.falsifiability.provenCriteria.includes('criterion:link')||h.verificationEventId!==v.id||v.actor.id==='worker:local-model')throw Error('Independent exact-candidate proof missing');
    if(hash(run('/usr/bin/git',['show',h.head+':'+task.file],p.repo))!==hash(task.after)||git(p.repo,'diff','--name-only',sourceHead,h.head)!==task.file||!git(p.repo,'ls-remote','origin',h.remoteRef).startsWith(h.head+'\t'))throw Error('Candidate content or remote identity mismatch');
    proof={head:h.head,ref:h.remoteRef,verificationEventId:v.id,negativeControl:'pass',state:board.state,accepted:false};}
   report.selected.push({workId,file:task.file,exitCode:code,elapsedMs:Date.now()-start,proof});if(code!==0){report.parked.push('Stop this cycle after failed execution; require evidence before retry');break;}
  }
  const after=json(process.execPath,[runtimeCli,'status','--repo',p.repo,'--json'],p.repo);
  report.work=after.digest;
  const evidence=await readRepositoryWorkEvents(common);
  if(evidence.unreadable.length)throw Error('Learning evidence incomplete');
  report.factory=observeFactory({events:evidence.events,runs:[]});
  report.learning='Verified candidates await acceptance. Factory observes now; Refiner/Router credit remains governed by canonical acceptance, never synthetic closure.';
  // Factory observations are derived from the same canonical Ledgers. No auto-accept,
  // promotion, or synthetic successful Refiner closure is introduced.
  return report;
 }catch(e){report.error=e.message;throw e;}finally{
  process.off('SIGTERM',stop);process.off('SIGINT',stop);if(killTimer)clearTimeout(killTimer);
  if(fs.readFileSync(lock,'utf8').trim()===String(process.pid))fs.unlinkSync(lock);else throw Error('Dispatch lock ownership changed');
  fs.writeFileSync(path.join(root,'last-dispatch.json'),JSON.stringify(report,null,2));
 }
}
