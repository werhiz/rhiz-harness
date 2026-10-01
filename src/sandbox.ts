import { z } from "zod";

import type { ResourceRef } from "./schemas.js";
import type { WorkerStartRequest } from "./host.js";

/**
 * Portable OS containment contract.
 *
 * Everything else in this Kernel bounds authority by describing it: a contract
 * states a writeScope, a descriptor states a writeAccess, a policy oracle
 * states a verdict. None of that stops a process. A worker or a verifier runs
 * with the operator's uid and can write anywhere that uid can write, so the
 * bound is a description of intent rather than a boundary. See issue #11.
 *
 * This module owns the description of a boundary and deliberately owns nothing
 * about how one is imposed, because that is per-platform and replaceable, and
 * the Kernel must not learn the shape of one operating system's sandbox.
 *
 * Fail-closed by construction: a caller asks for containment and either gets it
 * or gets an error. There is no best-effort return value, because a boundary
 * that silently degrades to no boundary is the defect this exists to remove.
 */

const absolutePath = z.string().trim().min(1).max(4096).refine(
  (value) => value.startsWith("/"),
  "sandbox paths must be absolute",
);

export const SandboxPolicySchema = z.object({
  /**
   * The only paths the contained process may write. Empty means it may write
   * nowhere, which is a legitimate policy for a read-only check.
   */
  writableRoots: z.array(absolutePath).default([]),
  /**
   * Reads are permitted because a toolchain reads from everywhere: interpreters,
   * system libraries, certificate stores. Narrowing reads is a later refinement
   * and is NOT what this contract currently promises.
   */
  allowRead: z.literal(true).default(true),
  /** Outbound network. Denied by default: a verifier that phones home is not deterministic. */
  allowNetwork: z.boolean().default(false),
  /** Sub-process execution. A test runner forks, so this is normally true. */
  allowProcessExec: z.boolean().default(true),
}).strict();
export type SandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export interface SandboxCommand {
  command: string;
  args: string[];
  /** Removes any temporary artifact the wrapping required. Safe to call twice. */
  dispose(): Promise<void>;
}

export interface SandboxLauncher {
  readonly id: string;
  /** True only when this launcher can actually impose the boundary on this machine. */
  available(): Promise<boolean>;
  /** Rewrites an argv so the operating system enforces the policy. Throws if it cannot. */
  wrap(policy: SandboxPolicy, command: string, args: readonly string[]): Promise<SandboxCommand>;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export function parseSandboxPolicy(input: unknown): SandboxPolicy {
  return SandboxPolicySchema.parse(input);
}

/**
 * Fail closed. Callers that require containment use this rather than checking
 * available() themselves, so "the sandbox was missing" can never take the same
 * code path as "the sandbox allowed it".
 */
export function assertLauncherConfigured(
  launcher: SandboxLauncher | null,
): asserts launcher is SandboxLauncher {
  if (launcher === null) throw new SandboxUnavailableError("containment was required and no sandbox launcher is configured");
}

export async function requireSandbox(
  launcher: SandboxLauncher | null,
  policy: SandboxPolicy,
  command: string,
  args: readonly string[],
): Promise<SandboxCommand> {
  assertLauncherConfigured(launcher);
  if (!(await launcher.available())) {
    throw new SandboxUnavailableError(`containment was required and ${launcher.id} is unavailable on this host`);
  }
  return launcher.wrap(parseSandboxPolicy(policy), command, args);
}

/** Path segments, or null when the path tries to walk upward out of its root. */
function normalizeSegments(value: string): string[] | null {
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments;
}

/**
 * Map one Work resource onto an absolute writable root under (or equal to) the
 * execution root. This is shared by OS containment and contract-bound authority
 * so semantic grants and the physical write boundary cannot interpret the same
 * ResourceRef differently.
 *
 * Anything that cannot be mapped is an error rather than a guess. Both ways of
 * guessing are fatal here: an allow rule that silently matches nothing produces
 * a boundary that appears to contain and actually breaks the work, and an allow
 * rule that admits more than the contract said produces a boundary that is not
 * one. A `never`-returning declaration is used rather than a thrown expression
 * so the compiler enforces that every refusing branch really does stop.
 */
function refuseScope(uri: string, executionRoot: string, why: string): never {
  throw new SandboxPolicyError(
    `writeScope resource ${uri} cannot become an OS writable root for execution root ${executionRoot}: ${why}`,
  );
}

export function workResourceWritableRoot(resource: ResourceRef, executionRoot: string): string {
  const uri = resource.uri;
  const under = (segments: readonly string[]): string =>
    segments.length === 0 ? executionRoot : `${executionRoot}/${segments.join("/")}`;

  // A repository-wide scope is the execution root itself, whatever it is named.
  if (resource.kind === "repository") return executionRoot;

  if (uri.startsWith("repo://")) {
    // repo://<name>[/<path>] — the authority names the repository, not a host
    // path, so only the path portion maps into the execution root.
    const rest = uri.slice("repo://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return executionRoot;
    const segments = normalizeSegments(rest.slice(slash + 1));
    if (segments === null) refuseScope(uri, executionRoot, "path traversal is not a writable root");
    return under(segments);
  }

  for (const prefix of ["file://", "dir://", "path://"]) {
    if (!uri.startsWith(prefix)) continue;
    const rest = uri.slice(prefix.length);
    if (rest.startsWith("/")) {
      const segments = normalizeSegments(rest);
      if (segments === null) refuseScope(uri, executionRoot, "path traversal is not a writable root");
      // Rebuilt from segments so the comparison cannot be defeated by "//" or
      // "/./"; the leading slash is restored because an absolute scope must
      // stay absolute. A relative writable root would be resolved against the
      // launcher's cwd, which is not a boundary anybody chose.
      const absolute = `/${segments.join("/")}`;
      if (absolute !== executionRoot && !absolute.startsWith(`${executionRoot}/`)) {
        refuseScope(uri, executionRoot, "absolute path is outside the execution root");
      }
      return absolute;
    }
    const segments = normalizeSegments(rest);
    if (segments === null) refuseScope(uri, executionRoot, "path traversal is not a writable root");
    return under(segments);
  }

  refuseScope(uri, executionRoot, "unrecognised resource uri; no allow rule can be derived");
}

/**
 * Derive only the Work-owned writable roots from a WorkerStartRequest.
 *
 * Adapters that impose their own sandbox use this rather than reimplementing
 * URI-to-filesystem semantics. Scratch/tool state is deliberately absent: this
 * function answers what the WorkContract grants, not what one runtime needs.
 */
export function workerContractWritableRoots(request: WorkerStartRequest): string[] {
  const executionRoot = request.workspace.executionRoot;
  const roots = new Set<string>();
  for (const resource of request.work.writeScope) {
    roots.add(workResourceWritableRoot(resource, executionRoot));
  }
  return [...roots];
}

/**
 * The OS boundary for one worker attempt, derived from its own contract:
 * the writable roots are the Work writeScope mapped under the workspace
 * execution root, plus the scratch home the worker was handed. Reads stay
 * unrestricted and the network stays closed (ADR 0017 posture).
 *
 * An empty writeScope yields a boundary that may write nowhere but the
 * scratch home, which is the honest reading of a contract that grants no
 * writes.
 */
export function workerSandboxPolicy(request: WorkerStartRequest, homeDirectory: string): SandboxPolicy {
  // Contract-derived roots first, in writeScope order, then the scratch home.
  // The order is part of the boundary's evidence: authority.granted names these
  // roots verbatim, so a reader sees what the contract asked for before what
  // the harness added to make tools work.
  const writable = new Set<string>(workerContractWritableRoots(request));
  writable.add(homeDirectory);
  return {
    writableRoots: [...writable],
    allowRead: true,
    allowNetwork: false,
    allowProcessExec: true,
  };
}
