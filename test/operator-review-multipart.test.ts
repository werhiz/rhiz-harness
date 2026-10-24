import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { human } from "./helpers.js";
import { readDurableLedgerEvents } from "../adapters/local/durable-ledger.js";

import { cli, git, contractFor, planFor, fixture, cliRun, json } from "./operator-cli-fixture.js";

test("operator CLI: production-sized multipart review covers exact UTF-8 bytes and requires a fresh integration verdict", async () => {
  const f = fixture();
  try {
    const id = "work:operator-multipart";
    const files = f.writeWork(id, true);
    const started = cliRun(f, ["start", "--contract", files.contract, "--verify", files.verify, "--json"]);
    assert.equal(started.status, 0, started.stderr);
    const head = json(started).status.verifiedTarget.head as string;
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const blob = (value: string) => {
      const inputFile = join(f.root, "blob-input");
      writeFileSync(inputFile, value, { mode: 0o600 });
      try { return execFileSync("git", ["hash-object", "-w", "--no-filters", inputFile], { cwd: f.repo, encoding: "utf8", timeout: 30_000 }).trim(); }
      finally { rmSync(inputFile, { force: true }); }
    };
    const bodies = Array.from({ length: 88 }, (_, n) => `Source leg ${n}\n` + "Original reviewed coordination: café 🌿\n".repeat(440));
    const integration = JSON.stringify({ paths: Array.from({ length: 22 }, (_, n) => `source-${n}.ts`), patch: "COMPLETE-PROPOSED-PATCH\n" });
    const packetBody = bodies.slice(0, 20).join("\n");
    const contextBody = JSON.stringify({ paths: Array.from({ length: 22 }, (_, n) => `source-${n}.ts`), criteria: "Preserve original/main semantics; uncertainty refuses", findings: "Complete active review findings" });
    const base = { schema: "rhiz/operator-review-material/v1", workId: id, contractRevision: 1, candidateHead: head,
      integrationLabel: "integration", partContextLabel: "part-context", blobs: [{ label: "integration", blob: blob(integration), digest: hash(integration) },
        { label: "packet", blob: blob(packetBody), digest: hash(packetBody) },
        { label: "part-context", blob: blob(contextBody), digest: hash(contextBody) },
        ...bodies.map((body, n) => ({ label: `source-${n}`, blob: blob(body), digest: hash(body) }))] };
    const material = (value: unknown) => {
      const raw = JSON.stringify(value);
      const tree = execFileSync("git", ["mktree"], { cwd: f.repo, input: `100644 blob ${blob(raw)}\tartifact.json\n`, encoding: "utf8" }).trim();
      return `git:${git(f.repo, ["commit-tree", tree, "-p", head, "-m", "complete review evidence"])}:artifact.json`;
    };
    const uri = material(base);
    const log = join(f.root, "multipart-inputs.jsonl"), mode = join(f.root, "review-mode.txt");
    const reviewer = join(f.root, "multipart-reviewer.mjs");
    writeFileSync(reviewer, `#!${process.execPath}\nimport fs from 'node:fs';process.stdin.setEncoding('utf8');let input='';for await(const b of process.stdin)input+=b;fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(input)+'\\n');const mode=fs.existsSync(${JSON.stringify(mode)})?fs.readFileSync(${JSON.stringify(mode)},'utf8'):'';const final=input.includes('FINAL CROSS-FILE INTEGRATION REVIEW');if(mode==='provider-error')process.exit(3);if(mode==='malformed'){process.stdout.write('malformed actual response');process.exit(0)}console.log(JSON.stringify({status:(mode==='part-fail'&&!final)||(mode==='integration-fail'&&final)?'fail':'pass',summary:final?'Cross-file semantic integration judgment':'Actual complete supplied part semantic judgment',findings:[]}));\n`);
    chmodSync(reviewer, 0o755);
    const invoke = (input = uri) => spawnSync(process.execPath, [cli, "review", id, "--reviewer-command", reviewer, "--review-material", input, "--json", "--repo", f.repo], {
      encoding: "utf8", env: { ...process.env, RHIZ_CODEX_COMMAND: f.codex, RHIZ_REVIEW_MAX_DIFF_BYTES: "4000000" }, timeout: 180_000,
    });
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const record = json(result).review;
    assert.ok(record.parts.length > 1, "production-sized evidence needs multiple actual provider calls");
    const prompts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
    assert.equal(prompts.length, record.parts.length + 1);
    assert.ok(prompts.every((prompt) => Buffer.byteLength(prompt) <= 200_000));
    const nearLimitProposal = JSON.stringify({ paths: ["real-reviewed-change.ts"], patch: "X".repeat(196_000) });
    const nearLimit = material({ ...base, blobs: base.blobs.map((entry) => entry.label === "integration"
      ? { label: "integration", blob: blob(nearLimitProposal), digest: hash(nearLimitProposal) }
      : entry) });
    const trafficBefore = readFileSync(log, "utf8");
    const rejectedBeforeSpend = invoke(nearLimit);
    assert.notEqual(rejectedBeforeSpend.status, 0, "a near-limit complete proposal must fail at admission");
    assert.match(rejectedBeforeSpend.stderr, /whole multipart provider input exceeds review size limit before any provider calls/);
    assert.equal(readFileSync(log, "utf8"), trafficBefore, "unreviewable final input must spend zero partial provider calls");

    const reconstructed: Record<string, Buffer[]> = {};
    for (const prompt of prompts.slice(0, -1)) {
      const ranges = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      for (const range of ranges) {
        (reconstructed[range.label] ??= []).push(Buffer.from(range.content));
      }
    }
    for (let n = 0; n < bodies.length; n++) assert.equal(Buffer.concat(reconstructed[`source-${n}`] ?? []).toString(), bodies[n]);
    assert.equal(Buffer.concat(reconstructed.packet ?? []).toString(), packetBody, "the >200 KB immutable packet is fully covered");
    assert.ok(prompts.slice(0, -1).every(prompt => prompt.includes("Complete active review findings")));
    assert.ok(prompts.at(-1)?.includes("COMPLETE-PROPOSED-PATCH"));
    assert.ok(prompts.at(-1)?.includes("Actual complete supplied part semantic judgment"));
    assert.equal(record.coverage.materialDigest, hash(JSON.stringify(base)));
    const observationBytes = readFileSync(fileURLToPath(record.observation.uri));
    assert.equal(hash(observationBytes), record.observation.digest);
    const observed = JSON.parse(observationBytes.toString());
    assert.equal(observed.materialDigest, record.material.digest);
    assert.deepEqual(observed.parts.map((part: { prompt: string }) => part.prompt), prompts.slice(0, -1));
    assert.equal(observed.integration.prompt, prompts.at(-1));
    assert.ok(observed.parts.every((part: { result: unknown }) => !JSON.stringify(part.result).includes("providerOutput")), "transport envelopes stay private");
    assert.deepEqual(record.coverage.partResultDigests, observed.parts.map((part: { result: unknown }) => hash(JSON.stringify(part.result))));

    const common = git(f.repo, ["rev-parse", "--git-common-dir"]);
    const events = await readDurableLedgerEvents(join(f.repo, common, "rhiz-harness", "ledgers", "work-operator-multipart"));
    const latest = [...events].reverse().find((event) => event.type === "review.result");
    assert.ok(latest?.evidence.some((entry) => entry.id.startsWith("review-material-parts:") && entry.digest === record.coverage.digest));
    const count = () => json(cliRun(f, ["status", id, "--json"])).works[0].review.count;
    const initial = count();
    for (const failure of ["integration-fail", "part-fail", "provider-error", "malformed"]) {
      writeFileSync(mode, failure);
      const refused = invoke();
      assert.notEqual(refused.status, 0, `must reject ${failure}`);
      assert.equal(count(), initial, "partial or integration failure cannot append a canonical passing result");
    }
    rmSync(mode);
    const timeRefusal = cliRun(f, ["review", id, "--reviewer-command", reviewer, "--review-material", uri, "--review-budget-ms", "1", "--json"]);
    assert.notEqual(timeRefusal.status, 0, "bounded cancellation cannot record review pass");
    assert.equal(count(), initial);
    for (const wrong of [
      { ...base, partContextLabel: "missing" },
      { ...base, blobs: [...base.blobs, { label: "oversize", blob: blob("x".repeat(9 * 1024 * 1024)), digest: hash("x".repeat(9 * 1024 * 1024)) }] },
      { ...base, integrationLabel: "missing" },
      { ...base, integrationLabel: undefined },
      { ...base, parts: [{ callerSuppliedCoverage: true }] },
      { ...base, blobs: [...base.blobs, base.blobs[1]] },
      { ...base, blobs: base.blobs.map((entry, n) => n === 1 ? { ...entry, digest: "0".repeat(64) } : entry) },
    ]) {
      const before = readFileSync(log, "utf8");
      assert.notEqual(invoke(material(wrong)).status, 0);
      assert.equal(readFileSync(log, "utf8"), before, "invalid coverage/input refuses before model traffic");
    }
    const oversizedA = "a".repeat(5 * 1024 * 1024), oversizedB = "b".repeat(5 * 1024 * 1024), secondBlob = blob(oversizedB);
    const cumulative = material({ ...base, blobs: [base.blobs[0], base.blobs[2], { label: "first-large", blob: blob(oversizedA), digest: hash(oversizedA) }, { label: "second-large", blob: secondBlob, digest: hash(oversizedB) }] });
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim(), bin = join(f.root, "git-bin"), readMarker = join(f.root, "unadmitted-blob-read");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('blob')&&args.at(-1)===${JSON.stringify(secondBlob)})fs.writeFileSync(${JSON.stringify(readMarker)},'read');const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);\n`);chmodSync(join(bin, "git"), 0o755);
    const cumulativeResult = spawnSync(process.execPath, [cli, "review", id, "--reviewer-command", reviewer, "--review-material", cumulative, "--repo", f.repo, "--json"], { encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH }, timeout: 180_000 });
    assert.notEqual(cumulativeResult.status, 0);
    assert.equal(existsSync(readMarker), false, "cumulative admission must refuse before reading the excess blob into memory");
    const escapedAlias = "\\\"\n".repeat(350_000), aliasBlob = blob(escapedAlias), tailBlob = blob("unadmitted logical tail");
    const aliases = material({ ...base, blobs: [base.blobs[0], base.blobs[2], ...Array.from({ length: 5 }, (_, n) => ({ label: `alias-${n}\ud800`, blob: aliasBlob, digest: hash(escapedAlias) })), { label: "tail", blob: tailBlob, digest: hash("unadmitted logical tail") }] });
    writeFileSync(join(bin, "git"), readFileSync(join(bin, "git"), "utf8").replace(JSON.stringify(secondBlob), JSON.stringify(tailBlob)));
    const beforeAliases = readFileSync(log, "utf8");
    const aliasesResult = spawnSync(process.execPath, [cli, "review", id, "--reviewer-command", reviewer, "--review-material", aliases, "--repo", f.repo, "--json"], { encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH }, timeout: 180_000 });
    assert.notEqual(aliasesResult.status, 0);
    assert.equal(existsSync(readMarker), false, "logical repeated/escaped bodies must refuse before admitting the tail, not after giant serialization");
    assert.equal(readFileSync(log, "utf8"), beforeAliases, "logical overflow invokes no provider");
    const beforeFresh = readFileSync(log, "utf8").trim().split("\n").length;
    assert.equal(invoke().status, 0, "no saved part cache substitutes for actual fresh provider execution");
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length - beforeFresh, prompts.length);
    const observations = readdirSync(join(f.repo, common, "rhiz-harness", "operator", "work-operator-multipart", "reviews"));
    assert.ok(observations.filter((name) => name.startsWith("multipart-")).length >= 5, "failures retain partial provider evidence");
    assert.ok(observations.filter((name) => name.startsWith("multipart-")).some((name) => JSON.parse(readFileSync(join(f.repo, common, "rhiz-harness", "operator", "work-operator-multipart", "reviews", name), "utf8")).providerFailure?.output === "malformed actual response"), "retain actual malformed provider output privately");

  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
