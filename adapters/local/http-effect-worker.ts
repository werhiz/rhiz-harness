import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, realpath, lstat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseWorkerStartRequest, parseWorkerObservation, requireBoundExecutionRoot, type WorkerObservation, type WorkerStartOptions, type WorkerStartRequest, type WorkerProvider, type WorkerHandle, type WorkerResult, type WorkerDescriptor, type HarnessHost, type WorkerRegistry } from "../../src/host.js";
import { requireSandbox, workerSandboxPolicy, workerContractWritableRoots, type SandboxLauncher } from "../../src/sandbox.js";

// Fixed IPC protocol. The child reserves an exclusive descriptor BEFORE requesting HTTP.
const CHILD = `const fs=require('node:fs');let fd;process.send({kind:'reserve'});process.on('message',m=>{try{if(m.kind==='reserve'){fd=fs.openSync(m.path,'wx',0o600);const s=fs.fstatSync(fd);process.send({kind:'invoke',ino:s.ino,dev:s.dev});}else if(m.kind==='write'&&fd!==undefined){fs.writeFileSync(fd,m.content);fs.closeSync(fd);fd=undefined;process.send({kind:'saved'},()=>process.exit(0));}else process.exit(1);}catch{process.exit(1);}});`;
export interface ContainedHttpEffectWorkerOptions {
  id?: string;
  sandbox: SandboxLauncher | null;
  toolName: string;
  body?: unknown;
  /** New file inside an existing Work-scoped directory. No commit or push. */
  artifactPath: string;
  timeoutMs?: number;
}
export class ContainedHttpEffectWorkerProvider implements WorkerProvider {
  readonly id: string;
  readonly #options: ContainedHttpEffectWorkerOptions;
  readonly #body: unknown;
  readonly #shutdown = new Map<ChildProcess,()=>void>();
  readonly #pending = new Set<Promise<WorkerResult>>();
  constructor(options: ContainedHttpEffectWorkerOptions) {
    this.id=options.id ?? "worker:contained-http-effect";
    if (!options.artifactPath.split("/").every(part=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) throw new Error("Artifact must be a bounded relative workspace path");
    if (!Number.isSafeInteger(options.timeoutMs ?? 240000) || (options.timeoutMs ?? 240000)<1) throw new Error("Invalid worker timeout");
    this.#options=Object.freeze({...options});
    this.#body=options.body === undefined ? undefined : JSON.parse(JSON.stringify(options.body));
  }
  async containmentAvailable(){return this.#options.sandbox !== null && await this.#options.sandbox.available();}
  async describe():Promise<WorkerDescriptor>{return {id:this.id,displayName:"Contained HTTP effect",description:"Fixed sandboxed child requests one host-brokered effect and writes its receipt",adapter:"local-http-effect",product:"rhiz-harness",execution:"one-shot",context:"standalone",authorityMode:"guarded-host-broker",writeAccess:"workspace",dangerous:false,bindsWorkspace:true,credentialEnv:[]};}
  async capabilities(){return {streamingObservations:true,cancel:true,resume:false,guardedToolMediation:true};}
  async start(raw:WorkerStartRequest,options?:WorkerStartOptions):Promise<WorkerHandle>{
    const request=parseWorkerStartRequest(raw);
    const root=requireBoundExecutionRoot(this.id,request);
    const artifact=path.join(root,this.#options.artifactPath);
    if(!options?.httpEffects || !options.guardedToolMediation)throw new Error("Canonical HTTP broker and Guard are required");
    const roots=workerContractWritableRoots(request);
    if(!roots.some(allowed=>artifact===allowed||artifact.startsWith(allowed+path.sep)))throw new Error("Receipt artifact is outside Work write scope");
    // No symlink may turn a lexical grant into authority outside the bound checkout.
    if(await realpath(root)!==root)throw new Error("Workspace root must be its resolved physical path");
    for(const allowed of roots){const resolved=await realpath(allowed);if(resolved!==allowed || (resolved!==root&&!resolved.startsWith(root+path.sep)))throw new Error("Symlink or outside writable scope refused");}
    if(await realpath(path.dirname(artifact))!==path.dirname(artifact))throw new Error("Symlink artifact parent refused");
    const home=await mkdtemp(path.join(tmpdir(),"rhiz-http-worker-"));
    let wrapped;
    try{wrapped=await requireSandbox(this.#options.sandbox,workerSandboxPolicy(request,home),process.execPath,["-e",CHILD]);}
    catch(error){await rm(home,{recursive:true,force:true});throw error;}
    const observations=new Readable({objectMode:true,read(){}});
    const observe=(value:Omit<WorkerObservation,"occurredAt">)=>observations.push(parseWorkerObservation({...value,occurredAt:new Date().toISOString()}));
    observe({kind:"diagnostic",detail:"OS containment prepared for fixed HTTP worker",authority:{decision:"granted",boundary:this.#options.sandbox!.id,reason:"Workspace writes confined by Work scope; direct network denied"}});
    let active=true,reserving=false,invoked=false,saved=false;
    let reservation:{ino:number;dev:number}|undefined;
    let effect: Awaited<ReturnType<NonNullable<WorkerStartOptions["httpEffects"]>["invoke"]>> | undefined;
    let digest:string|undefined;
    const invocation=new AbortController();
    const child=spawn(wrapped.command,wrapped.args,{cwd:root,env:{PATH:process.env.PATH ?? "",LANG:"C.UTF-8",HOME:home},stdio:["ignore","ignore","ignore","ipc"]});
    const stop=()=>{active=false;invocation.abort();child.kill("SIGKILL");};
    this.#shutdown.set(child,stop);
    const result=new Promise<WorkerResult>((resolve)=>{
      const finish=async(code:number|null)=>{
        active=false;invocation.abort();clearTimeout(timer);this.#shutdown.delete(child);
        let cleaned=true;
        try{
          // Losing the IPC acknowledgment must not erase a written response.
          // Nonempty artifacts remain private, unconfirmed evidence on failure.
          if(!saved&&reservation){const file=await lstat(artifact).catch(()=>null);if(file?.isFile()&&file.size===0&&file.ino===reservation.ino&&file.dev===reservation.dev)await unlink(artifact);}
          await wrapped.dispose();await rm(home,{recursive:true,force:true});
        }catch{cleaned=false;}
        observations.push(null);
        const succeeded=cleaned&&code===0&&saved&&effect?.outcome==="responded"&&effect.httpStatus!==undefined&&effect.httpStatus>=200&&effect.httpStatus<300;
        resolve({status:succeeded?"finished":"failed",summary:succeeded?"HTTP response retained for independent verification":"HTTP effect incomplete or refused; retained evidence does not establish success",artifacts:saved?[{uri:`file://${artifact}`,kind:"file"}]:[],evidence:saved?[{id:`http-effect:${effect?.invocationId}`,kind:"receipt",uri:`file://${artifact}`,...(digest?{digest}:{})}]:[]});
      };
      const timer=setTimeout(stop,this.#options.timeoutMs ?? 240000);
      child.once("spawn",()=>observe({kind:"activity",detail:"Contained fixed worker process started"}));
      child.once("error",stop);
      child.once("close",code=>{void finish(code);});
      child.on("message",message=>{void (async()=>{
        if(!active||!message||typeof message!=="object")return;
        const incoming=message as {kind?:string;ino?:number;dev?:number};
        if(incoming.kind==="saved"&&invoked&&effect){saved=true;observe({kind:"artifact",detail:"HTTP response artifact written through held exclusive descriptor",evidence:[{id:`http-effect:${effect.invocationId}`,kind:"receipt",uri:`file://${artifact}`,...(digest?{digest}:{})}]});return;}
        if(incoming.kind==="reserve"&&!reserving){
          reserving=true;
          const permission=await options.guardedToolMediation!.evaluate({requestId:randomUUID(),tool:{name:"http-effect.receipt.reserve",category:"write",args:{path:artifact,operation:"exclusive-create",mode:384}}});
          if(!active)return;if(permission.verdict.decision!=="allow"){stop();return;}
          child.send({kind:"reserve",path:artifact},error=>{if(error)stop();});return;
        }
        if(incoming.kind!=="invoke"||!reserving||invoked){stop();return;}
        const reserved=await lstat(artifact);
        if(!active)return;
        if(!reserved.isFile()||reserved.nlink!==1||reserved.ino!==incoming.ino||reserved.dev!==incoming.dev){stop();return;}
        reservation={ino:reserved.ino,dev:reserved.dev};
        invoked=true;observe({kind:"activity",detail:"Exclusive receipt artifact reserved; invoking named host effect"});
        effect=await options.httpEffects!.invoke(this.#options.toolName,this.#body,{signal:invocation.signal});
        if(!active)return;
        observe({kind:"activity",detail:`Host effect returned ${effect.outcome}${effect.httpStatus===undefined?"":` (HTTP ${effect.httpStatus})`}`});
        const content=JSON.stringify(effect)+"\n";digest=createHash("sha256").update(content).digest("hex");
        const evaluation=await options.guardedToolMediation!.evaluate({requestId:randomUUID(),tool:{name:"http-effect.receipt.write",category:"write",args:{path:artifact,contentDigest:digest,contentBytes:Buffer.byteLength(content)}}});
        if(!active)return;if(evaluation.verdict.decision!=="allow"){stop();return;}
        child.send({kind:"write",content},error=>{if(error)stop();});
      })().catch(stop);});
    });
    this.#pending.add(result);void result.then(()=>this.#pending.delete(result));
    return {workerId:this.id,attemptId:request.attemptId,observe:async function*(){for await(const item of observations)yield item as WorkerObservation;},result:()=>result,cancel:async()=>{stop();}};
  }
  async close(){for(const stop of this.#shutdown.values())stop();await Promise.allSettled([...this.#pending]);}
}
export class ContainedHttpEffectHost implements HarnessHost {
  readonly id="host:contained-http-effect";
  constructor(readonly worker:ContainedHttpEffectWorkerProvider){}
  async capabilities(){return {workers:true as const,processes:false,sessions:false,filesystem:false,sandbox:await this.worker.containmentAvailable(),tools:false};}
  workers():WorkerRegistry{return {list:()=>[this.worker],get:id=>id===this.worker.id?this.worker:undefined};}
  processes(){return null;} sessions(){return null;} filesystem(){return null;} tools(){return null;}
  sandbox(){return {id:"sandbox:contained-http-effect"};}
  async close(){await this.worker.close();}
}
