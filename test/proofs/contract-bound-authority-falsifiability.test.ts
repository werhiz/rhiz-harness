import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface GuardEntry {
  id: string;
  why: string;
  file: string;
  remove: string;
  testFile: string;
}

const authorityTest = "dist/test/contract-bound-authority.test.js";
const gates: GuardEntry[] = [
  {
    id: "crew-authority/registered-provider-must-be-exact",
    why: "A resolver wrapper with the same provider id must not inherit the host registration that supplies sandbox authority.",
    file: "src/contract-bound-authority.ts",
    remove: "    && registeredProviderIsExact\n",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/selection-provider-must-be-exact",
    why: "Selection evidence from a different same-id provider must not vouch for the provider Crew actually starts.",
    file: "src/contract-bound-authority.ts",
    remove: "    && selectedProviderIsExact\n",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/workspace-binding",
    why: "Category write authority may activate only for a provider that freshly guarantees exact WorkspaceBinding execution.",
    file: "src/contract-bound-authority.ts",
    remove: "      workspaceBinding = descriptor.bindsWorkspace === true;\n",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/workspace-write-access",
    why: "A provider that does not constrain writes to the workspace must never receive contract-bound write-category authority.",
    file: "src/contract-bound-authority.ts",
    remove: "      providerWorkspaceWrite = descriptor.writeAccess === \"workspace\";\n",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/guard-mediation",
    why: "Category authority is meaningful only when the provider awaits Guard before native effects.",
    file: "src/contract-bound-authority.ts",
    remove: "      guardMediation = capabilities.guardedToolMediation === true;\n",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/nonempty-write-scope",
    why: "A semantic write grant with no physical Work writeScope must not create write authority from nothing.",
    file: "src/contract-bound-authority.ts",
    remove: "  if (work.writeScope.length === 0) return false;\n",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/write-grant-covers-write-scope",
    why: "A narrow write grant must never activate a broader physical Work writeScope.",
    file: "src/contract-bound-authority.ts",
    remove: "      && physicalScope.every((candidate) => grantedRoots.some((root) => within(root, candidate)));\n",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/host-claims-sandbox",
    why: "The selected provider must come from a host that freshly declares OS sandbox capability.",
    file: "src/contract-bound-authority.ts",
    remove: "hostCapabilities.sandbox === true && ",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/host-exposes-sandbox-provider",
    why: "A sandbox capability bit with no sandbox provider surface is a false authority claim, not containment.",
    file: "src/contract-bound-authority.ts",
    remove: " && entry.host.sandbox() !== null",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/activation-requires-workspace-binding",
    why: "The final activation conjunction must retain the workspace-binding gate.",
    file: "src/contract-bound-authority.ts",
    remove: "workspaceBinding\n      && ",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/activation-requires-write-authority",
    why: "The final activation conjunction must retain the workspace write-authority gate.",
    file: "src/contract-bound-authority.ts",
    remove: "workspaceWriteAuthority\n      && ",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/activation-requires-sandbox-host",
    why: "The final activation conjunction must retain the real sandbox-host gate.",
    file: "src/contract-bound-authority.ts",
    remove: "sandboxCapableHost\n      && ",
    testFile: authorityTest,
  },
  {
    id: "crew-authority/activation-requires-guard-mediation",
    why: "The final activation conjunction must retain synchronous Guard mediation.",
    file: "src/contract-bound-authority.ts",
    remove: "      && guardMediation",
    testFile: authorityTest,
  },
  {
    id: "crew/activates-contract-bound-category-authority-from-proof",
    why: "Crew must feed the completed physical admission proof into Guard; otherwise #88 remains permanently dormant or a future caller may invent a bypass.",
    file: "src/crew.ts",
    remove: "    contractBoundCategoryAuthority: categoryAuthorityProof?.active ?? false,\n",
    testFile: "dist/test/crew-contract-bound-authority.test.js",
  },
];

test("every contract-bound category-authority admission gate is load-bearing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rhiz-contract-bound-guards-"));
  try {
    const production = JSON.parse(
      await readFile(join(process.cwd(), "scripts/guard-manifest.json"), "utf8"),
    ) as { guards: GuardEntry[] };
    const required = production.guards.find((entry) => entry.id === "worker/guarded-tool-mediation");
    assert.ok(required, "production manifest lost its mandatory guarded-tool-mediation proof");

    const manifestPath = join(directory, "guard-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({ guards: [required, ...gates] }, null, 2)}\n`,
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/check-guard-falsifiability.mjs"),
        "--manifest",
        manifestPath,
        "--concurrency",
        "4",
      ],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    for (const guard of gates) {
      assert.match(output, new RegExp(`${guard.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+proven`));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
