#!/usr/bin/env node
// Operator-only process/Work association. No lease takeover or acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {agentCensus} from './factory-dispatch.mjs';
import {collectProcessSnapshot,processSource,AUTHORIZATION_ROOT,authorizationPath,authorizationRecord,authorizedBinding,authorizeWithSudo} from './factory-sessions.mjs';
import {DurableEventLedger} from '../dist/adapters/local/durable-ledger.js';
import {readRepositoryWorkLedgers} from '../dist/adapters/local/work-ledgers.js';
import {WorkContractSchema,parseHarnessEvent} from '../dist/src/schemas.js';
import {projectBoard} from '../dist/src/board.js';
import {IntegrationController} from '../dist/src/integration.js';
import {streamIdForWork} from '../dist/src/refiner.js';
import {harnessGitRefSegment} from '../dist/adapters/git/index.js';
export async function bindSession({repo,contractFile,pid,authorization={root:AUTHORIZATION_ROOT,trustedUid:0,authorize:authorizeWithSudo}}){
 if(process.env.RHIZ_AUTONOMOUS_CONTEXT==='1')throw Error('Session binding requires the trusted operator; worker cannot change coordination scope');
 const git=(...args)=>{const r=spawnSync('/usr/bin/git',args,{cwd:repo,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();};
 const contract=WorkContractSchema.parse(JSON.parse(fs.readFileSync(contractFile,'utf8')));
 if(contract.createdBy.kind!=='human')throw Error('Explicit operator-supplied Work contract required');
 const raw=spawnSync('/usr/sbin/lsof',['-a','-u',String(process.getuid()),'-d','cwd','-Fpcn','+c','0'],{encoding:'utf8',maxBuffer:8*2**20});
 if(raw.status!==0)throw Error('Live process census unavailable');
 const candidate=agentCensus(raw.stdout).find(p=>p.pid===String(pid));
 if(!candidate)throw Error('Named live engineering process not found');
 const owner=collectProcessSnapshot([candidate]).processes.find(p=>p.pid===String(pid));
 if(!owner)throw Error('Named live engineering process not found');
 const source=processSource(owner);
 // The env check above is defence in depth; the operator's sudo-created root-owned
 // record is the authority Dispatch verifies. Nothing is recorded without it.
 authorization.authorize(authorizationPath(authorization.root,contract.id,source),authorizationRecord(contract.id,contract,source));
 if(!authorizedBinding(contract.id,contract,source,authorization))throw Error('Root-owned operator authorization missing or altered; session not bound');
 const common=git('rev-parse','--path-format=absolute','--git-common-dir');
 const snapshots=await readRepositoryWorkLedgers(common);if(snapshots.unreadable.length)throw Error('Unreadable canonical Work');
 const existing=snapshots.ledgers.filter(l=>l.workIds.includes(contract.id));
 if(existing.length>1)throw Error('Conflicting canonical Work ownership');
 const directory=existing[0]?.directory??path.join(common,'rhiz-harness','ledgers',harnessGitRefSegment(contract.id));
 const ledger=await DurableEventLedger.open({directory,ledgerId:`ledger:${contract.id}`.slice(0,200)});
 const actor={id:'service:studio-operator-session',kind:'service'};
 try{
  let events=await ledger.replay(streamIdForWork(contract.id));
  if(!events.length){
   const now=new Date().toISOString();
   const event=parseHarnessEvent({id:crypto.randomUUID(),schemaVersion:1,type:'work.created',streamId:streamIdForWork(contract.id),workId:contract.id,actor:contract.createdBy,occurredAt:now,recordedAt:now,payload:{contract,revision:1}});
   const board=projectBoard([event]);if(board.violations.length)throw Error('Invalid Work declaration');await ledger.append(event);events=[event];
  }
  let board=projectBoard(events);
  if(board.violations.length||JSON.stringify(board.contract)!==JSON.stringify(contract)||['accepted','rejected','cancelled'].includes(board.state))throw Error('Only matching live canonical Work may bind a session');
  const options={ledger,workId:contract.id,actor};
  const integration=board.integration?await IntegrationController.open(options):await IntegrationController.initialize({...options,configuration:{ref:`refs/rhiz/work/${contract.id.replace(/[^A-Za-z0-9._-]/g,'-')}/integration`,head:git('rev-parse','HEAD'),horizonPolicyId:'policy:integration-horizon:provisional',provisionalHorizon:true}});
  board=await integration.observeExecution({state:'running',source,observedAt:new Date().toISOString()});
  return {workId:contract.id,owner,scope:board.contract.writeScope,source:board.integration.latestExecutionObservation.source,accepted:false};
 }finally{await ledger.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const args=process.argv.slice(2);if(args.length!==6||args[0]!=='--repo'||args[2]!=='--contract'||args[4]!=='--pid'||!/^\d+$/.test(args[5]))throw Error('Usage: factory-session.mjs --repo <repo> --contract <explicit Work.json> --pid <live owner>');console.log(JSON.stringify(await bindSession({repo:args[1],contractFile:args[3],pid:args[5]}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
