#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { routeWorker, InMemoryRouterWorkerRegistry } from "../dist/src/router.js";
import { defaultRouterWorkerDescriptor } from "../dist/src/router-bridge.js";
import { recommendEngineeringDecision } from '../dist/src/router.js';
const [datasetPath, outputPath, modelConfigPath, acceleration='cpu']=process.argv.slice(2);
const bytes=fs.readFileSync(datasetPath), dataset=JSON.parse(bytes);
const cases=dataset.evaluation;
if(!Array.isArray(cases)||cases.length<20||new Set(cases.map(x=>x.id)).size!==cases.length)throw Error('Need >=20 distinct frozen evaluation cases');
const inputs=cases.map(({id,kind,facts})=>({id,kind,facts}));
const contractPath=process.env.RHIZ_BENCHMARK_CONTRACT;
const template=contractPath?JSON.parse(fs.readFileSync(contractPath)):null;
const registry=new InMemoryRouterWorkerRegistry([defaultRouterWorkerDescriptor("worker:local-model",{adapter:"local-model",product:"local-inference",supportedWorkTypes:["SHIP"],writeAccess:"workspace"})]);
const baseline=[];for(const x of template?inputs:[]){const f=x.facts,start=performance.now();const routed=await routeWorker(registry,null,{contract:template,options:{excludeProviders:f.localCapable===false?["worker:local-model"]:[]}});const action=f.duplicate||f.authorized===false||f.verificationAvailable===false||(f.paidCostUsd??0)>(f.budgetUsd??0)?"park":routed.selected?"execute":"park";baseline.push({id:x.id,action,ms:performance.now()-start});}
const samples=inputs.map(x=>{const start=performance.now();const action=recommendEngineeringDecision(x);return {id:x.id,action,ms:performance.now()-start};});
const metrics=(rows)=>({count:rows.length,accuracy:rows.filter((x,i)=>x.action===cases[i].expected).length/cases.length,
 p50Ms:rows.map(x=>x.ms).sort((a,b)=>a-b)[Math.floor(rows.length*.5)],
 p95Ms:rows.map(x=>x.ms).sort((a,b)=>a-b)[Math.min(rows.length-1,Math.floor(rows.length*.95))]});
const report={schema:'rhiz/engineering-decision-benchmark/v1',generatedAt:new Date().toISOString(),
 datasetDigest:createHash('sha256').update(bytes).digest('hex'),sourceDigest:createHash('sha256').update(fs.readFileSync(new URL('../src/router.ts',import.meta.url))).digest('hex'),
 inputs,existingRouter:template?{...metrics(baseline),rows:baseline,limitation:"Worker-selection baseline plus deterministic safety veto; it has no semantic triage labels"}:null,deterministic:{...metrics(samples),rows:samples,memory:process.memoryUsage(),calibration:'No probabilistic output; not applicable'},
 limitation:'20 constructed independently labeled cases; descriptive screening, not naturalistic task quality or statistical significance',paidInferenceUsd:0};
if(modelConfigPath){
 const c=JSON.parse(fs.readFileSync(modelConfigPath));
 if(c.autonomousPaidBudgetUsd!==0||c.cloudFallback!==false)throw Error('Zero local budget required');
 for(const [path,expected] of [[c.executable,c.executableDigest],[c.modelPath,c.digest]]){const hash=createHash("sha256");for await(const b of fs.createReadStream(path))hash.update(b);if(hash.digest("hex")!==expected)throw Error("Pinned inference artifact changed");}
 const choices=['execute','park','stop','retry','revise','reuse','infer','skip'];
 const schema=JSON.stringify({type:'array',minItems:cases.length,maxItems:cases.length,items:{type:'object',required:['action','confidence'],additionalProperties:false,
  properties:{action:{type:'string',enum:choices},confidence:{type:'number',minimum:0,maximum:1}}}});
 const prompt='Return one decision per input in order with confidence. Actions: execute, park (needs authority/capability/evidence), stop (budget spent), retry (transient), revise (correctable instructions or unsupported evidence), reuse (verified compatible lesson), infer (judgment worth cost), skip (duplicate or no value). Never override deterministic permissions, ownership or budget.\n'+JSON.stringify(inputs);
 const args=['-l','/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)(deny file-write*)',c.executable,'-m',c.modelPath,'--offline',
  ...(acceleration==='metal'?['-ngl','99']:['--device','none','--no-op-offload','-ngl','0']),
  '--fit','off','-t','4','-tb','4','-c','8192','-n','800','-no-cnv','--temp','0','--seed','42','--no-display-prompt','--simple-io','--json-schema',schema,'-p',`<|im_start|>system\nYou are a task triage adviser. Emit exactly one decision for each supplied input in order; never enumerate the action vocabulary. Use the facts, not list position. Return only a JSON array.<|im_end|>\n<|im_start|>user\nTuning examples: ${JSON.stringify(dataset.tuning.map(({kind,facts,expected})=>({kind,facts,action:expected})))}\n${prompt}<|im_end|>\n<|im_start|>assistant\n`];
 const start=performance.now(), p=spawnSync('/usr/bin/time',args,{encoding:'utf8',timeout:180000,maxBuffer:2**20,env:{PATH:'/usr/bin:/bin',HOME:'/var/empty'}});
 const elapsedMs=performance.now()-start;
 fs.writeFileSync(outputPath+'.stdout',p.stdout??'');fs.writeFileSync(outputPath+'.stderr',p.stderr??'');
 let rows=[];let parseError=null;
 try{rows=JSON.parse((p.stdout??'').replace(/\s*\[end of text\]\s*$/,'').trim());if(rows.length!==cases.length)throw Error('Wrong decision count');}
 catch(e){parseError=e.message;}
 const correct=rows.filter((x,i)=>x.action===cases[i]?.expected).length;
 report.qwen={model:c.model,modelDigest:c.digest,executableDigest:c.executableDigest,acceleration,exitCode:p.status,error:p.error?.message??parseError,elapsedMs,
  maximumRssBytes:Number((p.stderr??'').match(/(\d+)\s+maximum resident set size/)?.[1]??0)||null,
  accuracy:rows.length===cases.length?correct/cases.length:null,throughput:rows.length/(elapsedMs/1000),rows,
  brier:rows.length===cases.length?rows.reduce((s,x,i)=>s+(x.confidence-Number(x.action===cases[i].expected))**2,0)/cases.length:null,
  calibration:'Self-reported confidence; Brier on chosen-label correctness, not calibrated probabilities',
  verifiedDownstreamOutcomes:null};
}
fs.writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({deterministic:report.deterministic.accuracy,qwen:report.qwen?{accuracy:report.qwen.accuracy,elapsedMs:report.qwen.elapsedMs,error:report.qwen.error}:null}));
