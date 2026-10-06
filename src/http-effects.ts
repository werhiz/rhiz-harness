import { createHash, randomUUID } from "node:crypto";
import type { GuardedToolMediation } from "./guard.js";
import { WorkContractSchema, type WorkContract } from "./schemas.js";

export interface HttpEffectBinding {
  readonly toolName: string;
  readonly method: "GET" | "POST";
  /** Exact public/nonsecret HTTPS URL. Credentials belong only in the callback, never the URL. */
  readonly url: string;
  readonly credential: () => string | Promise<string>;
  /** Immutable public/nonsecret request metadata, never an authority or credential header. */
  readonly headers?: Readonly<Record<string, string>>;
}
export interface HttpEffectPolicyBinding {
  readonly toolName: string;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly action: "read" | "external-mutate";
  readonly resourceUri: string;
}
const forbiddenHeaders = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "content-type", "content-encoding", "transfer-encoding", "connection", "keep-alive", "te", "trailer", "upgrade", "proxy-connection"]);
function bindingHeaders(binding: HttpEffectBinding): Readonly<Record<string,string>> {
  const result: Record<string,string> = {};
  for (const [name,value] of Object.entries(binding.headers ?? {})) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || forbiddenHeaders.has(key) ||
        /token|secret|password|credential|api[-_]?key/.test(key) || key.startsWith("sec-") || key in result ||
        typeof value !== "string" || value.length > 1024 || /[\r\n]/.test(value)) throw new Error("Forbidden HTTP binding header");
    result[key] = value;
  }
  return Object.freeze(Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b))));
}
/** ResourceRef convention: method is part of authority, not an interchangeable URL. */
export function httpEffectResourceUri(method: "GET" | "POST", url: string): string {
  return `http-effect:${method}:${url}`;
}
export function getHttpEffectPolicyBindings(bindings: readonly HttpEffectBinding[]): readonly HttpEffectPolicyBinding[] {
  const names = new Set<string>();
  return Object.freeze(bindings.map(binding => {
    const url = new URL(binding.url);
    bindingHeaders(binding);
    if (!/^[A-Za-z][A-Za-z0-9._:-]{0,199}$/.test(binding.toolName) || names.has(binding.toolName) ||
        !["GET", "POST"].includes(binding.method) || typeof binding.credential !== "function" ||
        url.protocol !== "https:" || url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some(key => /token|secret|password|credential|authorization|api[_-]?key/i.test(key)) || url.href !== binding.url) {
      throw new Error("Invalid or duplicate immutable HTTP effect binding");
    }
    names.add(binding.toolName);
    return Object.freeze({toolName:binding.toolName, method:binding.method, url:binding.url,
      action:binding.method === "GET" ? "read" as const : "external-mutate" as const,
      resourceUri:httpEffectResourceUri(binding.method,binding.url)});
  }));
}
export type HttpEffectResult = {
  readonly invocationId: string;
  readonly toolName: string;
  readonly outcome: "not-sent" | "responded" | "unknown";
  readonly reason: string;
  readonly httpStatus?: number;
  /** Private evidence for the host's private artifact sink, never automatically ledgered. */
  readonly body?: string;
};
export interface HttpEffectsPort { invoke(toolName: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<HttpEffectResult>; }
export interface HttpEffectBrokerOptions {
  readonly bindings: readonly HttpEffectBinding[];
  readonly work: WorkContract;
  readonly guard: GuardedToolMediation;
  readonly signal: AbortSignal;
  /** Rechecks the owning Attempt lease immediately before the irreversible seam. */
  readonly isActive: () => boolean;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
}

/** Host-owned mediation. Workers receive only invoke(), never this broker or its credentials. */
export class HttpEffectBroker implements HttpEffectsPort {
  readonly #bindings: Map<string, HttpEffectBinding>;
  readonly #policies: readonly HttpEffectPolicyBinding[];
  readonly #options: HttpEffectBrokerOptions;
  readonly #work: WorkContract;
  constructor(options: HttpEffectBrokerOptions) {
    this.#policies = getHttpEffectPolicyBindings(options.bindings);
    this.#bindings = new Map(options.bindings.map(binding => [binding.toolName,Object.freeze({...binding,headers:bindingHeaders(binding)})]));
    this.#work = WorkContractSchema.parse(options.work);
    this.#options = Object.freeze({...options});
    for (const value of [options.timeoutMs ?? 180_000, options.maxResponseBytes ?? 8_000_000, options.maxRequestBytes ?? 1_000_000]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) throw new Error("Invalid HTTP effect bound");
    }
  }
  policyBindings(): readonly HttpEffectPolicyBinding[] { return this.#policies; }
  port(): HttpEffectsPort { return Object.freeze({invoke:this.invoke.bind(this)}); }
  async invoke(toolName: string, body?: unknown, invocation?: { signal?: AbortSignal }): Promise<HttpEffectResult> {
    const invocationId = randomUUID();
    const result = (outcome: HttpEffectResult["outcome"], reason: string, extra: Partial<HttpEffectResult> = {}): HttpEffectResult =>
      ({invocationId,toolName,outcome,reason,...extra});
    const policy = this.#policies.find(item => item.toolName === toolName);
    const binding = this.#bindings.get(toolName);
    if (!policy || !binding) return result("not-sent","unknown-tool");
    const active = () => { try { return !this.#options.signal.aborted && !invocation?.signal?.aborted && this.#options.isActive(); } catch { return false; } };
    if (!active()) return result("not-sent","attempt-inactive");
    if (this.#work.authority.requiresHumanApproval.includes(policy.action)) return result("not-sent","human-approval-required");
    if (!this.#work.authority.grants.some(grant => grant.action === policy.action && grant.constraints.length === 0 &&
        grant.resources.some(resource => resource.uri === policy.resourceUri))) return result("not-sent","exact-resource-grant-required");
    let serialized: string | undefined;
    try {
      if (binding.method === "GET" && body !== undefined) return result("not-sent","get-body-forbidden");
      serialized = body === undefined ? undefined : JSON.stringify(body);
      if (body !== undefined && serialized === undefined) return result("not-sent","invalid-json-body");
    } catch { return result("not-sent","invalid-json-body"); }
    const bytes = Buffer.byteLength(serialized ?? "");
    if (bytes > (this.#options.maxRequestBytes ?? 1_000_000)) return result("not-sent","request-too-large");
    const signal = AbortSignal.any([this.#options.signal,...(invocation?.signal ? [invocation.signal] : []),AbortSignal.timeout(this.#options.timeoutMs ?? 180_000)]);
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_,reject) => { onAbort = () => reject(new Error("HTTP effect aborted")); signal.addEventListener("abort",onAbort,{once:true}); });
      try { return await Promise.race([operation,aborted]); }
      finally { signal.removeEventListener("abort",onAbort); }
    };
    let credential: string;
    try {
      const evaluation = await bounded(this.#options.guard.evaluate({requestId:invocationId,tool:{name:policy.toolName,
        category:policy.action === "read" ? "network" : "external-mutate",
        args:{method:policy.method,url:policy.url,resourceUri:policy.resourceUri,bodyDigest:createHash("sha256").update(serialized ?? "").digest("hex"),bodyBytes:bytes,headerDigest:createHash("sha256").update(JSON.stringify(binding.headers)).digest("hex")}}}));
      if (evaluation.verdict.decision !== "allow") return result("not-sent","guard-refused");
      if (!active() || signal.aborted) return result("not-sent","attempt-inactive");
      credential = await bounded(Promise.resolve().then(binding.credential));
      if (!active() || signal.aborted) return result("not-sent","attempt-inactive");
      if (typeof credential !== "string" || !credential.trim() || /[\r\n]/.test(credential)) return result("not-sent","credential-unavailable");
      if (Object.values(binding.headers ?? {}).some(value => value.includes(credential))) return result("not-sent","credential-in-binding-header");
    } catch { return result("not-sent","authorization-or-credential-unavailable"); }
    let httpStatus: number | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // No await between the final lease check above and dispatch. No redirects or retries.
      const response = await bounded((this.#options.fetch ?? fetch)(binding.url,{method:binding.method,redirect:"error",signal,
        headers:{...binding.headers,Authorization:`Bearer ${credential}`,"Content-Type":"application/json"},...(serialized === undefined ? {} : {body:serialized})}));
      httpStatus=response.status;
      reader=response.body?.getReader();
      const chunks: Uint8Array[]=[]; let size=0;
      if (reader) for (;;) {
        const chunk=await bounded(reader.read());
        if (chunk.done) break;
        size+=chunk.value.byteLength;
        if (size > (this.#options.maxResponseBytes ?? 8_000_000)) throw new Error("Response bound");
        chunks.push(chunk.value);
      }
      const text=Buffer.concat(chunks).toString("utf8");
      if (text.includes(credential)) return result("unknown","credential-echo-refused",{httpStatus});
      return result("responded",response.ok ? "http-success" : "http-error",{httpStatus,body:text});
    } catch { return result("unknown","response-unavailable-do-not-retry",{...(httpStatus === undefined ? {} : {httpStatus})}); }
    finally { if (reader) { void reader.cancel().catch(()=>{}); reader.releaseLock(); } }
  }
}
