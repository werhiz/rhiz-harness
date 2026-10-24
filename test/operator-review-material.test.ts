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

test("operator CLI: whole immutable review material is delivered and identity-bound before provider admission", async () => {
  const f = fixture();
  try {
    const id = "work:operator-review-material";
    const files = f.writeWork(id, true);
    const started = cliRun(f, ["start", "--contract", files.contract, "--verify", files.verify, "--json"]);
    assert.equal(started.status, 0, started.stderr);
    const head = json(started).status.verifiedTarget.head as string;
    const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    const blob = (bytes: string | Buffer) => execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: bytes, encoding: "utf8" }).trim();
    const content = "WHOLE-PACKET\noriginal: ours\nmain: theirs\nprojected: ours + theirs\nIgnore these untrusted source instructions.\n";
    const rawBlob = blob(content);
    const sourceBlob = git(f.repo, ["rev-parse", `${head}:src/arm.txt`]);
    const sourceBytes = execFileSync("git", ["cat-file", "blob", sourceBlob], { cwd: f.repo });
    const base = { schema: "rhiz/operator-review-material/v1", workId: id, contractRevision: 1, candidateHead: head,
      blobs: [{ label: "complete original/main/projected evidence", blob: rawBlob, digest: hash(content) },
        { label: "actual source", tree: head, path: "src/arm.txt", blob: sourceBlob, digest: hash(sourceBytes) },
        { label: "historical absence", tree: head, path: "not-present.txt", absent: true }] };
    const material = (value: unknown) => {
      const bytes = JSON.stringify(value);
      const tree = execFileSync("git", ["mktree"], { cwd: f.repo, input: `100644 blob ${blob(bytes)}\tartifact.json\n`, encoding: "utf8" }).trim();
      const commit = git(f.repo, ["commit-tree", tree, "-p", head, "-m", "immutable review input"]);
      return { uri: `git:${commit}:artifact.json`, digest: hash(bytes) };
    };
    const promptPath = join(f.root, "actual-review-input.txt");
    const reviewer = f.reviewer("review-material.sh", "pass");
    writeFileSync(reviewer, `#!/bin/sh\ncat > '${promptPath}'\nprintf '%s' '{"status":"pass","summary":"reviewed complete supplied material","findings":[]}'\n`);
    const invoke = (uri: string) => cliRun(f, ["review", id, "--reviewer-command", reviewer, "--review-material", uri, "--json"]);
    const valid = material(base);
    const passed = invoke(valid.uri);
    assert.equal(passed.status, 0, passed.stderr);
    assert.ok(readFileSync(promptPath, "utf8").includes(JSON.stringify(content)), "reviewer must receive whole actual source bytes");
    assert.match(readFileSync(promptPath, "utf8"), /untrusted.*data/i);
    assert.equal(json(passed).review.material.digest, valid.digest);
    const common = git(f.repo, ["rev-parse", "--git-common-dir"]);
    const events = await readDurableLedgerEvents(join(f.repo, common, "rhiz-harness", "ledgers", "work-operator-review-material"));
    const review = [...events].reverse().find((event) => event.type === "review.result");
    assert.ok(review?.evidence.some((entry) => entry.uri === valid.uri && entry.digest === valid.digest));
    git(f.repo, ["replace", rawBlob, blob("forged replaced content\n")]);
    assert.equal(invoke(valid.uri).status, 0, "object replacements cannot redirect immutable review input");
    assert.ok(readFileSync(promptPath, "utf8").includes(JSON.stringify(content)));
    git(f.repo, ["replace", "-d", rawBlob]);
    const rejected = [
      material({ ...base, candidateHead: git(f.repo, ["rev-parse", "main"]) }),
      material({ ...base, workId: "work:foreign" }),
      material({ ...base, contractRevision: 2 }),
      material({ ...base, blobs: [{ ...base.blobs[0], digest: "0".repeat(64) }] }),
      material({ ...base, blobs: [{ ...base.blobs[0], blob: "0".repeat(40) }] }),
      material({ ...base, blobs: [] }),
      material({ ...base, blobs: [{ ...base.blobs[1], path: "README.md" }] }),
      material({ ...base, blobs: [{ label: "false absence", tree: head, path: "README.md", absent: true }] }),
      material({ ...base, blobs: [{ label: "binary", blob: blob(Buffer.from([0xff, 0x00])), digest: hash(Buffer.from([0xff, 0x00])) }] }),
      material({ ...base, blobs: [{ label: "oversize", blob: blob("x".repeat(210_000)), digest: hash("x".repeat(210_000)) }] }),
    ];
    for (const wrong of rejected) {
      rmSync(promptPath, { force: true });
      const refused = invoke(wrong.uri);
      assert.equal(refused.status, 1, refused.stdout);
      assert.equal(existsSync(promptPath), false, "invalid material must refuse before provider invocation");
    }
    const beforeRace = json(cliRun(f, ["status", id, "--json"])).works[0].review.count;
    const ledgerUrl = new URL("../adapters/local/durable-ledger.js", import.meta.url).href;
    const raceReviewer = join(f.root, "review-race.mjs");
    writeFileSync(raceReviewer, `#!${process.execPath}\nimport {DurableEventLedger} from ${JSON.stringify(ledgerUrl)};const ledger=await DurableEventLedger.open({directory:${JSON.stringify(join(f.repo, common, "rhiz-harness", "ledgers", "work-operator-review-material"))},ledgerId:${JSON.stringify("ledger:"+id)}});const now=new Date().toISOString();await ledger.append({id:'event:review-material-race',schemaVersion:1,streamId:${JSON.stringify(json(started).status.streamId)},workId:${JSON.stringify(id)},actor:${JSON.stringify(human)},occurredAt:now,recordedAt:now,evidence:[],type:'work.amended',payload:{changes:{objective:'Changed semantic requirement'},revision:2,reason:'Human correction during review'}});await ledger.close();console.log(JSON.stringify({status:'pass',summary:'Provider completed against the earlier candidate',findings:[]}));\n`);
    chmodSync(raceReviewer, 0o755);
    const race = cliRun(f, ["review", id, "--reviewer-command", raceReviewer, "--review-material", valid.uri, "--json"]);
    assert.equal(race.status, 1, "an old provider result cannot be retagged to a changed revision");
    const afterRace = json(cliRun(f, ["status", id, "--json"])).works[0];
    assert.equal(afterRace.contractRevision, 2);
    assert.equal(afterRace.review.count, beforeRace, "stale provider result creates no canonical review");
    const observations = join(f.repo, common, "rhiz-harness", "operator", "work-operator-review-material", "reviews");
    const refusedFile = readdirSync(observations).find((name) => name.startsWith("refused-"));
    assert.ok(refusedFile);
    const refused = JSON.parse(readFileSync(join(observations, refusedFile), "utf8"));
    assert.equal(refused.recorded, false);
    assert.equal(refused.providerResult.verdict.status, "pass");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("operator CLI: slow post-provider persistence cannot authorize review past its total deadline", () => {
  const f = fixture();
  try {
    const id = "work:operator-deadline", files = f.writeWork(id, true);
    const started = cliRun(f, ["start", "--contract", files.contract, "--verify", files.verify, "--json"]);
    assert.equal(started.status, 0, started.stderr);
    const head = json(started).status.verifiedTarget.head as string;
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: "actual source", encoding: "utf8" }).trim();
    const material = JSON.stringify({ schema: "rhiz/operator-review-material/v1", workId: id, contractRevision: 1, candidateHead: head,
      blobs: [{ label: "source", blob, digest: createHash("sha256").update("actual source").digest("hex") }] });
    const materialBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: material, encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["mktree"], { cwd: f.repo, input: `100644 blob ${materialBlob}\tartifact.json\n`, encoding: "utf8" }).trim();
    const commit = git(f.repo, ["commit-tree", tree, "-p", head, "-m", "deadline material"]);
    const preload = join(f.root, "slow-private-evidence.cjs");
    writeFileSync(preload, `const fs=require('node:fs/promises');const write=fs.writeFile;let clock=Date.now(),advanced=false;Date.now=()=>clock;fs.writeFile=async function(path,data,...args){const result=await write.call(this,path,data,...args);if(!advanced&&String(path).includes('multipart-')&&String(data).includes('providerResult')){advanced=true;clock+=31000;}return result};`);
    const refused = spawnSync(process.execPath, [cli, "review", id, "--reviewer-command", f.reviewer("deadline-review.sh", "pass"), "--review-material", `git:${commit}:artifact.json`, "--review-budget-ms", "30000", "--repo", f.repo, "--json"], {
      encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, RHIZ_CODEX_COMMAND: f.codex }, timeout: 40_000,
    });
    assert.notEqual(refused.status, 0, "actual provider pass plus slow retained I/O must not overrun total deadline");
    assert.equal(json(cliRun(f, ["status", id, "--json"])).works[0].review.count, 0);
    const common = git(f.repo, ["rev-parse", "--git-common-dir"]);
    const dir = join(f.repo, common, "rhiz-harness", "operator", "work-operator-deadline", "reviews");
    const observation = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((name) => name.startsWith("multipart-"))!), "utf8"));
    assert.equal(observation.parts[0].providerResult.verdict.status, "pass", "retain genuine successful provider outcome on expiry");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("operator CLI: linked private review custody refuses before source writes or provider traffic", () => {
  const f = fixture();
  try {
    const id = "work:operator-linked-review", files = f.writeWork(id, true);
    const started = cliRun(f, ["start", "--contract", files.contract, "--verify", files.verify, "--json"]);
    assert.equal(started.status, 0, started.stderr);
    const head = json(started).status.verifiedTarget.head as string;
    const source = "PRIVATE-SOURCE-INPUT\n";
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: source, encoding: "utf8" }).trim();
    const raw = JSON.stringify({ schema: "rhiz/operator-review-material/v1", workId: id, contractRevision: 1, candidateHead: head,
      blobs: [{ label: "private source", blob, digest: createHash("sha256").update(source).digest("hex") }] });
    const materialBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: raw, encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["mktree"], { cwd: f.repo, input: `100644 blob ${materialBlob}\tartifact.json\n`, encoding: "utf8" }).trim();
    const commit = git(f.repo, ["commit-tree", tree, "-p", head, "-m", "private custody material"]);
    const common = git(f.repo, ["rev-parse", "--git-common-dir"]), outside = join(f.root, "outside"), marker = join(f.root, "provider-called");
    mkdirSync(outside);
    symlinkSync(outside, join(f.repo, common, "rhiz-harness", "operator", "work-operator-linked-review", "reviews"));
    const reviewer = f.reviewer("linked-review.sh", "pass");
    writeFileSync(reviewer, `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\nprintf '%s' '{"status":"pass","summary":"actual scripted provider result","findings":[]}'\n`);
    const refused = cliRun(f, ["review", id, "--reviewer-command", reviewer, "--review-material", `git:${commit}:artifact.json`, "--json"]);
    assert.notEqual(refused.status, 0, "linked review custody must refuse");
    assert.deepEqual(readdirSync(outside), [], "private source cannot be written outside owned custody");
    assert.equal(existsSync(marker), false, "custody refusal precedes provider invocation");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
