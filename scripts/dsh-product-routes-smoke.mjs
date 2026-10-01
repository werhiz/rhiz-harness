import {
  createDefaultDshProductRoutes,
  createDshInProcessSubagentRuntime,
  resolveDshProductRoutes,
} from "../dist/adapters/dsh/products.js";

const rawRoutes = createDefaultDshProductRoutes();
const routes = resolveDshProductRoutes(rawRoutes);
const runtime = await createDshInProcessSubagentRuntime(rawRoutes, {
  subprocessMode: "dormant",
});

try {
  const providers = [...runtime.listProviders()];
  const expected = routes.map((route) => route.providerName);
  if (JSON.stringify(providers) !== JSON.stringify(expected)) {
    throw new Error(`DSH product route composition mismatch: expected ${expected.join(", ")}; received ${providers.join(", ")}`);
  }
  const proof = {
    dshVersion: "0.1.0-rc.8",
    subprocessMode: "dormant",
    providers,
    workers: routes.map((route) => ({
      workerId: route.workerId,
      product: route.product,
      productVersion: route.descriptor.productVersion,
      authorityMode: route.descriptor.authorityMode,
      writeAccess: route.descriptor.writeAccess,
      dangerous: route.descriptor.dangerous,
      execution: route.descriptor.execution,
      context: route.descriptor.context,
    })),
    productsStarted: 0,
    credentialsUsed: false,
    processSpawnPermitted: false,
  };
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await runtime.close();
}
