import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Spawn fresh processes: ICU selects its default locale at process startup.
// An in-process environment change would miss the original routing defect.
test("worker catalog, router registry, and tied routing agree across ICU locales", () => {
  const routerUrl = new URL("../src/router.js", import.meta.url).href;
  const workersUrl = new URL("../src/workers.js", import.meta.url).href;
  const helpersUrl = new URL("./helpers.js", import.meta.url).href;
  const script = `
    import { InMemoryRouterWorkerRegistry, routeWorker } from ${JSON.stringify(routerUrl)};
    import { WorkerCatalog } from ${JSON.stringify(workersUrl)};
    import { work } from ${JSON.stringify(helpersUrl)};

    const ids = ["worker:åa", "worker:ab"];
    const registry = new InMemoryRouterWorkerRegistry(ids.map((workerId) => ({
      workerId, role: "general", displayName: workerId, model: "same",
      supportedWorkTypes: ["SHIP"], languages: [], maxContextTokens: 32000,
      costPer1kTokensUsd: 0.002, avgLatencyMs: 1000,
      capabilityTags: [], weight: 1,
    })));
    const decision = await routeWorker(
      registry, null, { contract: work(), policy: { kind: "cheapest-capable" } },
      () => new Date("2026-08-20T04:00:00.000Z"),
    );
    const catalog = new WorkerCatalog(...ids.map((id) => ({ id })));
    console.log(JSON.stringify({
      locale: new Intl.DateTimeFormat().resolvedOptions().locale,
      collator: ids[0].localeCompare(ids[1]),
      registry: registry.list().map((entry) => entry.workerId),
      considered: decision.considered.map((entry) => entry.workerId),
      selected: decision.selected?.workerId,
      hash: decision.evidenceHash,
      catalog: catalog.list().map((entry) => entry.id),
    }));
  `;
  const results = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale, LANGUAGE: locale },
      timeout: 20_000,
    });
    assert.equal(child.status, 0, `${locale}: ${child.error?.message ?? child.stderr}`);
    return JSON.parse(child.stdout.trim()) as {
      locale: string; collator: number; registry: string[];
      considered: string[]; selected: string; hash: string; catalog: string[];
    };
  });
  assert.notEqual(results[0]!.locale, results[1]!.locale, "ICU locale must actually differ");
  assert.notEqual(Math.sign(results[0]!.collator), Math.sign(results[1]!.collator),
    "test IDs must expose the locale-sensitive ordering defect");
  for (const result of results) {
    assert.deepEqual(result.registry, ["worker:ab", "worker:åa"]);
    assert.deepEqual(result.considered, ["worker:ab", "worker:åa"]);
    assert.equal(result.selected, "worker:ab");
    assert.deepEqual(result.catalog, ["worker:ab", "worker:åa"]);
  }
  assert.equal(results[0]!.hash, results[1]!.hash, "evidence identity must be locale-independent");
});
