// Fresh Runtime observations; scoped Work remains the only ownership record.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const digest=s=>createHash('sha256').update(s).digest('hex');
export const processSource=p=>`local-process:${p.uid}:${p.pid}:${p.birth}`;
export function parseProcessRows(text,uid){
 const rows=new Map();
 for(const line of text.split('\n')){
  const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
  if(m&&Number(m[3])===uid)rows.set(m[1],{pid:m[1],ppid:m[2],uid,birth:digest(m[4]),command:path.basename(m[5])});
 }
 if(!rows.size)throw Error('Process birth census unavailable');
 return rows;
}
export function collectProcessSnapshot(agents){
 const r=spawnSync('/bin/ps',['-axo','pid=,ppid=,uid=,lstart=,comm='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C',LANG:'C'},timeout:1000,maxBuffer:8*2**20});
 if(r.status!==0||r.error)throw Error('Host process birth census unavailable');
 const uid=process.getuid(),rows=parseProcessRows(r.stdout,uid);
 for(const a of agents){const p=rows.get(a.pid);if(!p||p.command!==a.command)throw Error(`Process census changed for PID ${a.pid}: ${a.command} versus ${p?.command??'exited'}`);Object.assign(p,{cwd:a.cwd});}
 const relevant=new Map();
 for(const a of agents){let p=rows.get(a.pid);while(p&&!relevant.has(p.pid)){relevant.set(p.pid,p);p=rows.get(p.ppid);}}
 return {schema:'rhiz/process-census/v1',at:new Date().toISOString(),uid,processes:[...relevant.values()]};
}
export function validateProcessSnapshot(s,agents,requestedAt,now=Date.now()){
 if(s?.schema!=='rhiz/process-census/v1'||s.uid!==process.getuid()||!Array.isArray(s.processes)||!Number.isFinite(Date.parse(s.at))||Date.parse(s.at)<requestedAt||Date.parse(s.at)>now+1000||now-Date.parse(s.at)>10000)throw Error('Fresh host process census required');
 const ids=new Set();for(const p of s.processes){if(!/^\d+$/.test(p.pid)||!/^\d+$/.test(p.ppid)||p.uid!==s.uid||!/^[a-f0-9]{64}$/.test(p.birth)||typeof p.command!=='string'||ids.has(p.pid))throw Error('Invalid host process identity');ids.add(p.pid);}
 for(const a of agents)if(!s.processes.some(p=>p.pid===a.pid&&p.command===a.command&&p.cwd===a.cwd))throw Error(`Process ${a.pid} changed since host census`);
 return s.processes;
}
export async function freshProcessSnapshot(agents){
 const requestedAt=Date.now();
 // The existing launchd wrapper supplies a fresh read-only host observation
 // over Node IPC; the sandbox never gains privileged ps execution.
 if(typeof process.send!=='function')return validateProcessSnapshot(collectProcessSnapshot(agents),agents,requestedAt);
 const nonce=randomUUID();
 const snapshot=await new Promise((resolve,reject)=>{
  const done=(error,value)=>{clearTimeout(timer);process.off('message',onMessage);error?reject(error):resolve(value);};
  const onMessage=m=>{if(m?.type==='factory-process-census-result'&&m.nonce===nonce)done(m.error?Error(m.error):null,m.snapshot);};
  const timer=setTimeout(()=>done(Error('Host process census timed out')),15000);
  process.on('message',onMessage);process.send({type:'factory-process-census',nonce},error=>{if(error)done(error);});
 });
 return validateProcessSnapshot(snapshot,agents,requestedAt);
}
export function attachProcessCensus(child,getAgents){
 child.on('message',m=>{
  if(m?.type!=='factory-process-census'||typeof m.nonce!=='string'||m.nonce.length>100)return;
  let result;try{result={snapshot:collectProcessSnapshot(getAgents())};}catch(e){result={error:e.message};}
  if(child.connected)child.send({type:'factory-process-census-result',nonce:m.nonce,...result},error=>{if(error&&child.connected)console.error('Process observation delivery failed:',error.message);});
 });
}
export function sessionOwnership(agents,boards,roots,snapshot){
 const rows=new Map(snapshot.map(p=>[p.pid,p]));
 return agents.filter(a=>roots.includes(a.cwd)).map(a=>{
  let p=rows.get(a.pid);const seen=new Set(),sources=[];
  while(p&&!seen.has(p.pid)){seen.add(p.pid);sources.push(processSource(p));p=rows.get(p.ppid);}
  const works=boards.filter(b=>!['accepted','rejected','cancelled'].includes(b.state)&&sources.includes(b.sessionBindingSource)&&b.integration?.latestExecutionObservation?.source===b.sessionBindingSource);
  return {pid:a.pid,command:a.command,cwd:a.cwd,status:works.length?'scoped':'ambiguous',workIds:works.map(b=>b.workId),
   resolution:works.length?null:`Owner of PID ${a.pid}: bind this exact live process to its existing scoped Work with factory-session.mjs, or resume it in its owned worktree. Do not expire a live owner from heartbeat age.`};
 });
}
