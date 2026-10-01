import path from "node:path";

import type { WorkerProvider } from "./host.js";
import { HostCapabilitiesSchema, WorkerCapabilitiesSchema } from "./host.js";
import { workResourceWritableRoot } from "./sandbox.js";
import type { WorkContract } from "./schemas.js";
import { WorkContractSchema } from "./schemas.js";
import { describeWorkerProvider, type WorkerSelection, WorkerCatalog } from "./workers.js";

export interface ContractBoundCategoryAuthorityProof {
  readonly canonicalProvider: boolean;
  readonly workspaceBinding: boolean;
  readonly workspaceWriteAuthority: boolean;
  readonly sandboxCapableHost: boolean;
  readonly guardMediation: boolean;
  readonly active: boolean;
}

const LOGICAL_EXECUTION_ROOT = "/__rhiz_contract_bound_workspace__";

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Prove that every physical Work writeScope root is semantically covered by a
 * write grant. The same ResourceRef-to-root mapping used by the sandbox is used
 * here against a stable logical workspace root, so repo:// and workspace-
 * relative file/dir/path resources cannot disagree between semantic authority
 * and containment. Absolute host paths deliberately fail this logical proof;
 * they remain fail-closed until a binding-aware authority proof is introduced.
 */
function workWriteScopeIsGranted(work: WorkContract): boolean {
  if (work.writeScope.length === 0) return false;
  try {
    const physicalScope = work.writeScope.map((resource) =>
      workResourceWritableRoot(resource, LOGICAL_EXECUTION_ROOT));
    const grantedRoots = work.authority.grants
      .filter((grant) => grant.action === "write")
      .flatMap((grant) => grant.resources.map((resource) =>
        workResourceWritableRoot(resource, LOGICAL_EXECUTION_ROOT)));
    return grantedRoots.length > 0
      && physicalScope.every((candidate) => grantedRoots.some((root) => within(root, candidate)));
  } catch {
    return false;
  }
}

/**
 * Re-proves every physical boundary immediately before Crew turns semantic Work
 * write authority into an active Guard category rule. Crew calls this only
 * after it has parsed the exact WorkspaceBinding for the acquired isolated-write
 * workspace. Selection data is treated as advisory here: a custom resolver may
 * wrap or forge it, so the execution provider must still be the exact provider
 * registered by the sandbox-capable host.
 */
export async function proveContractBoundCategoryAuthority(options: {
  registry: WorkerCatalog;
  selection: WorkerSelection;
  provider: WorkerProvider;
  work: WorkContract;
}): Promise<ContractBoundCategoryAuthorityProof> {
  const work = WorkContractSchema.parse(options.work);
  const entry = options.registry.getEntry(options.provider.id);
  const registeredExecutionProvider = entry !== undefined;
  const registeredProviderIsExact = entry?.provider === options.provider;
  const selectedProviderIsExact = options.selection.provider === options.provider;
  const selectedProviderIdMatches = options.selection.provider.id === options.provider.id;
  const canonicalProvider = registeredExecutionProvider
    && registeredProviderIsExact
    && selectedProviderIsExact
    && selectedProviderIdMatches;

  let workspaceBinding = false;
  let providerWorkspaceWrite = false;
  let guardMediation = false;
  if (canonicalProvider) {
    try {
      const [descriptor, capabilities] = await Promise.all([
        describeWorkerProvider(options.provider),
        Promise.resolve(options.provider.capabilities()).then((value) => WorkerCapabilitiesSchema.parse(value)),
      ]);
      workspaceBinding = descriptor.bindsWorkspace === true;
      providerWorkspaceWrite = descriptor.writeAccess === "workspace";
      guardMediation = capabilities.guardedToolMediation === true;
    } catch {
      // A boundary that cannot be freshly described is not proven.
    }
  }

  const workspaceWriteAuthority = providerWorkspaceWrite && workWriteScopeIsGranted(work);

  let sandboxCapableHost = false;
  if (canonicalProvider && entry?.host !== null && entry?.host !== undefined) {
    try {
      const hostCapabilities = HostCapabilitiesSchema.parse(await entry.host.capabilities());
      // A capability bit without the provider surface it claims is not a
      // physical boundary. Requiring both prevents a test/custom Host from
      // activating category authority by asserting sandbox:true while exposing
      // no sandbox at all.
      sandboxCapableHost = hostCapabilities.sandbox === true && entry.host.sandbox() !== null;
    } catch {
      // Host capability discovery is part of the proof and therefore fails closed.
    }
  }

  return {
    canonicalProvider,
    workspaceBinding,
    workspaceWriteAuthority,
    sandboxCapableHost,
    guardMediation,
    active: canonicalProvider
      && workspaceBinding
      && workspaceWriteAuthority
      && sandboxCapableHost
      && guardMediation,
  };
}
