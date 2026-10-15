import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readRepositoryWorkLedgers } from "../adapters/local/work-ledgers.js";

const HOUR = 60 * 60 * 1000;
const hostScript = resolve("scripts/horizon.mjs");

// Fresh repositories and a local bare remote exercise real measurement and
// durability. Only the external forge transport is controlled by this fixture.
test("host requires an open exact-pushed-head review for bounded-age corrections", async () => {
  const root = await mkdtemp(join(tmpdir(), "horizon-review-host-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  await Promise.all([mkdir(repo), mkdir(bin)]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Horizon", GIT_AUTHOR_EMAIL: "horizon@example.invalid", GIT_COMMITTER_NAME: "Horizon", GIT_COMMITTER_EMAIL: "horizon@example.invalid" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    execFileSync("git", ["init", "--bare", "-q", remote]);
    git(["init", "-q", "--initial-branch=main"]);
    await writeFile(join(repo, "base.txt"), "base\n");
    await writeFile(join(repo, "historical-only.txt"), "old\n".repeat(1000));
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    const olderBase = git(["rev-parse", "HEAD"]);
    await rm(join(repo, "historical-only.txt"));
    git(["add", "."]);
    git(["commit", "-qm", "current integration base"]);
    const baseHead = git(["rev-parse", "HEAD"]);
    git(["remote", "add", "origin", remote]);
    git(["push", "-qu", "origin", "main"]);
    git(["checkout", "-qb", "feature"]);
    await writeFile(join(repo, "feature.txt"), "line\n".repeat(500));
    git(["add", "."]);
    const when = new Date(Date.now() - 25.6 * HOUR).toISOString();
    execFileSync("git", ["commit", "-q", "-m", "reviewed change"], { cwd: repo, env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
    git(["push", "-qu", "origin", "feature"]);
    const head = git(["rev-parse", "HEAD"]);
    const calls = join(root, "forge-calls.txt");
    await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.FORGE_CALLS,'called\\n');if(process.env.FORGE_MODE==='failure')process.exit(1);console.log(JSON.stringify({number:4375,state:process.env.FORGE_MODE==='closed'?'CLOSED':'OPEN',headRefOid:process.env.FORGE_MODE==='wrong-head'?'0'.repeat(40):process.env.FORGE_HEAD}));\n`, { mode: 0o755 });
    const check = (mode: string) => {
      const childEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), FORGE_MODE: mode, FORGE_HEAD: head, FORGE_CALLS: calls };
      delete (childEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: childEnv, encoding: "utf8" });
      assert.equal(result.error, undefined);
      return { status: result.status, payload: JSON.parse(result.stdout) };
    };
    const accepted = check("open");
    assert.equal(accepted.status, 0);
    assert.equal(accepted.payload.state, "in_review");
    assert.ok(accepted.payload.signals.divergenceAgeMs > 25 * HOUR);
    for (const mode of ["closed", "wrong-head", "failure"]) {
      const refused = check(mode);
      assert.equal(refused.status, 1, mode);
      assert.equal(refused.payload.state, "tripped", mode);
    }
    // A local head behind its upstream is durable, but is not the reviewed head.
    git(["checkout", "-qb", "remote-ahead"]);
    await writeFile(join(repo, "remote-only.txt"), "new reviewed head\n");
    git(["add", "remote-only.txt"]);
    git(["commit", "-qm", "remote ahead"]);
    const otherHead = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/remotes/origin/feature", otherHead]);
    git(["checkout", "-q", "feature"]);
    const mismatchEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), FORGE_MODE: "open", FORGE_HEAD: otherHead, FORGE_CALLS: calls };
    delete (mismatchEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
    const mismatch = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: mismatchEnv, encoding: "utf8" });
    assert.equal(mismatch.status, 1, "forge and upstream agreement cannot substitute for exact local head");
    assert.equal(JSON.parse(mismatch.stdout).state, "tripped");
    git(["update-ref", "refs/remotes/origin/feature", head]);
    const reviewPath = join(repo, ".rhiz-horizon-reviews.json");
    await writeFile(reviewPath, JSON.stringify({ reviews: { feature: { change: 4375, anchorDiffLines: 400, recordedAt: when } } }));
    assert.equal(check("open").status, 1, "inclusive 125% bound still refuses");
    // A real review of this newer exact head is a distinct convergence round.
    const commentUrl = "https://github.com/example/project/pull/4375#issuecomment-123";
    const comment = { id: 123, html_url: commentUrl, issue_url: "https://api.github.com/repos/example/project/issues/4375", author_association: "MEMBER", user: { login: "independent-checker" }, body: `## NOT READY at ${head}\n\n<!-- rhiz-review-agent -->\nIndependent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${head}\`.\n\nRequired authority repair.` };
    await writeFile(join(bin, "gh"), `#!${process.execPath}\nif(process.env.FORGE_MODE==='failure')process.exit(1);if(process.argv[2]==='api'){const c=JSON.parse(process.env.FORGE_COMMENT);if(process.env.FORGE_MODE==='bad-body')c.body='no reviewed head';if(process.env.FORGE_MODE==='ready-only')c.body=c.body.replace('## NOT READY at','## READY at');if(process.env.FORGE_MODE==='untrusted')c.author_association='NONE';console.log(JSON.stringify(c));}else{console.log(JSON.stringify({number:4375,state:process.env.FORGE_MODE==='closed'?'CLOSED':'OPEN',headRefOid:process.env.FORGE_HEAD,baseRefOid:'${baseHead}',url:'https://github.com/example/project/pull/4375'}));}\n`, { mode: 0o755 });
    const receiptEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), FORGE_HEAD: head, FORGE_COMMENT: JSON.stringify(comment) };
    delete (receiptEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
    const record = (mode: string, url = commentUrl, integration = "origin/main") => spawnSync(process.execPath, [hostScript, "converge", "--repo", repo, "--integration-ref", integration, "--review-receipt", url], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: mode }, encoding: "utf8" });
    const original = await readFile(reviewPath, "utf8");
    for (const mode of ["bad-body", "ready-only", "untrusted", "closed", "failure"]) {
      assert.notEqual(record(mode).status, 0, mode);
      assert.equal(await readFile(reviewPath, "utf8"), original, "invalid receipt cannot alter an anchor");
    }
    assert.notEqual(record("open", "https://github.com/other/project/pull/4375#issuecomment-123").status, 0);
    assert.equal(await readFile(reviewPath, "utf8"), original);
    const dry = spawnSync(process.execPath, [hostScript, "converge", "--repo", repo, "--review-receipt", commentUrl, "--dry-run"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(await readFile(reviewPath, "utf8"), original, "dry run preserves all anchors");
    assert.notEqual(record("open", commentUrl, olderBase).status, 0, "recording cannot choose an older base than the forge");
    assert.equal(await readFile(reviewPath, "utf8"), original);
    const recorded = record("open");
    assert.equal(recorded.status, 0, recorded.stderr);
    const rounds = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.equal(rounds.reviews.feature.anchorDiffLines, 400, "first anchor remains unchanged");
    assert.equal(rounds.reviews.feature.correctionReceipts.length, 1);
    assert.deepEqual(Object.keys(rounds.reviews.feature.correctionReceipts[0]).sort(), [
      "anchorDiffLines", "commentDigest", "commentId", "commentUrl",
      "head", "integrationHead", "recordedAt", "reviewerLogin",
    ], "ordinary NOT READY correction receipts retain their established schema");
    assert.equal(rounds.reviews.feature.correctionReceipts[0].head, head);
    assert.equal(rounds.reviews.feature.correctionReceipts[0].anchorDiffLines, 500);
    assert.equal(record("open").status, 0, "identical receipt replay is idempotent");
    assert.equal(JSON.parse(await readFile(reviewPath, "utf8")).reviews.feature.correctionReceipts.length, 1);
    const roundCheck = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(roundCheck.status, 0, roundCheck.stderr);
    assert.equal(JSON.parse(roundCheck.stdout).decision.anchorDiffLines, 500);
    const pinnedRound = await readFile(reviewPath, "utf8");
    rounds.reviews.feature.correctionReceipts[0].anchorDiffLines = 50_000;
    await writeFile(reviewPath, JSON.stringify(rounds));
    const forgedAnchor = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(forgedAnchor.status, 1, "cached size cannot exceed the measured reviewed commit");
    await writeFile(reviewPath, pinnedRound);
    rounds.reviews.feature.correctionReceipts[0].integrationHead = olderBase;
    rounds.reviews.feature.correctionReceipts[0].anchorDiffLines = 1500;
    await writeFile(reviewPath, JSON.stringify(rounds));
    const forgedBase = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "open" }, encoding: "utf8" });
    assert.equal(forgedBase.status, 1, "changing both cached base and size cannot increase the correction round");
    await writeFile(reviewPath, pinnedRound);
    const invalidated = spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: { ...receiptEnv, FORGE_MODE: "bad-body" }, encoding: "utf8" });
    assert.equal(invalidated.status, 1, "a receipt edited on the forge stops granting correction authority");
    await writeFile(join(repo, "unpushed.txt"), "not durable\n");
    git(["add", "unpushed.txt"]);
    git(["commit", "-qm", "not pushed"]);
    const callsBefore = await readFile(calls, "utf8");
    const unpushed = check("open");
    assert.equal(unpushed.status, 1);
    assert.ok(unpushed.payload.decision.reasons.some((reason: { signal: string }) => reason.signal === "upstreamState"));
    assert.equal(await readFile(calls, "utf8"), callsBefore, "durability refuses before consulting forge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The provider wire in these fixtures is scripted, not a real-model proof.
// Real 0.154 write/Verify/Review custody is recorded separately by the operator.
const CONVERGENCE_CODEX_FIXTURE = String.raw`
import { readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
let cwd,target,content;const threadId='thread:fixture',turnId='turn:fixture';
readline.createInterface({input:process.stdin}).on('line',line=>{
 if(!line.trim())return;const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='initialized')return;
 else if(m.method==='thread/start'){cwd=m.params.cwd;send({id:m.id,result:{thread:{id:threadId},model:'fixture',modelProvider:'fixture',serviceTier:null,cwd,instructionSources:[],approvalPolicy:'untrusted',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false},reasoningEffort:null}});}
 else if(m.method==='turn/start'){
  const text=m.params.input[0].text;
  // Agent-boundary fixture mirrors the observed native refusal when a shared
  // objective makes this producer responsible for the reviewer's packet work.
  if(!text.includes('Artifact producer only:')||!text.includes('Independent review only:')){process.stderr.write('producer/reviewer responsibilities are not separated\n');process.exit(2)}
  const name=/into (tools\/horizon-convergence-artifacts\/[^ ]+\/artifact.json)/.exec(text)[1];target=join(cwd,name);
  const folder=join(process.env.CONVERGENCE_SOURCE,'.context/horizon-convergence');content=readFileSync(join(folder,readdirSync(folder)[0]),'utf8');
  if(process.env.CONVERGENCE_MODE==='bad-artifact')content='{}';
  appendFileSync(process.env.CONVERGENCE_CALLS,'worker\n');send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});
  send({method:'item/started',params:{threadId,turnId,item:{type:'fileChange',id:'file:artifact',changes:[{path:target,kind:{type:'add'},diff:content}]}}});
  send({id:'approval:artifact',method:'item/fileChange/requestApproval',params:{threadId,turnId,itemId:'file:artifact',startedAtMs:1}});
 }else if(m.id==='approval:artifact'&&m.result){
  if(m.result.decision==='accept')writeFileSync(target,content);
  send({method:'item/completed',params:{threadId,turnId,item:{type:'fileChange',id:'file:artifact',changes:[{path:target,kind:{type:'add'},diff:content}],status:'completed'}}});
  send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'message:done',text:'Fixture artifact packaged'}}});
  send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}});
 }else if(m.id!==undefined&&m.method)send({id:m.id,result:{}});
});
`;

async function convergenceFixture(featureCommits = 9, hookShape: "none" | "source-only" | "main-only" | "source-non-executable" | "source-symlink" | "claude-readme" | "hooks-readme" | "claude-file-parent" | "claude-symlink-parent" = "none") {
  const root = await mkdtemp(join(tmpdir(), "horizon-convergence-host-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const remote = join(root, "remote.git");
  await Promise.all([mkdir(repo), mkdir(bin)]);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Horizon", GIT_AUTHOR_EMAIL: "horizon@example.invalid", GIT_COMMITTER_NAME: "Horizon", GIT_COMMITTER_EMAIL: "horizon@example.invalid" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Horizon"]);
  git(["config", "user.email", "horizon@example.invalid"]);
  await writeFile(join(repo, ".gitignore"), ".context/\n");
  if (hookShape === "claude-readme") {
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(join(repo, ".claude", "README.md"), "ordinary project instructions\n");
  } else if (hookShape === "hooks-readme") {
    await mkdir(join(repo, ".claude", "hooks"), { recursive: true });
    await writeFile(join(repo, ".claude", "hooks", "README.md"), "ordinary hook documentation\n");
  } else if (hookShape === "claude-file-parent") {
    await writeFile(join(repo, ".claude"), "not a directory\n");
  } else if (hookShape === "claude-symlink-parent") {
    await mkdir(join(repo, "hook-parent-target"), { recursive: true });
    await writeFile(join(repo, "hook-parent-target", "README.md"), "symlink target\n");
    await symlink("hook-parent-target", join(repo, ".claude"));
  }
  await writeFile(join(repo, "source.txt"), "base\n");
  await writeFile(join(repo, "foreign.txt"), "foreign\n");
  git(["add", "."]); git(["commit", "-qm", "base"]);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const forgeOrigin = "https://github.com/example/project.git";
  git(["remote", "add", "origin", forgeOrigin]); git(["config", `url.file://${remote}.insteadOf`, forgeOrigin]);
  git(["push", "-qu", "origin", "main"]); git(["fetch", "-q", "origin"]);
  git(["checkout", "-qb", "feature"]);
  if (hookShape === "source-only" || hookShape === "source-non-executable") {
    await mkdir(join(repo, ".claude", "hooks"), { recursive: true });
    await writeFile(join(repo, ".claude", "hooks", "horizon-check.sh"), "#!/bin/sh\nexit 0\n", { mode: hookShape === "source-only" ? 0o755 : 0o644 });
    git(["add", ".claude/hooks/horizon-check.sh"]); git(["commit", "-qm", "source hook shape"]);
  } else if (hookShape === "source-symlink") {
    await mkdir(join(repo, ".claude", "hooks"), { recursive: true });
    await writeFile(join(repo, "hook-target.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await symlink("../../../hook-target.sh", join(repo, ".claude", "hooks", "horizon-check.sh"));
    git(["add", "hook-target.sh", ".claude/hooks/horizon-check.sh"]); git(["commit", "-qm", "source hook symlink"]);
  }
  const when = new Date(Date.now() - 50 * HOUR).toISOString();
  for (let i = 0; i < featureCommits; i++) {
    await writeFile(join(repo, i === 0 ? "source.txt" : `feature-${i}.txt`), i === 0 ? "ours\n" : "feature\n".repeat(65));
    git(["add", "."]);
    execFileSync("git", ["commit", "-qm", `feature ${i}`], { cwd: repo, env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  }
  const head = git(["rev-parse", "HEAD"]);
  git(["push", "-qu", "origin", "feature"]);
  git(["checkout", "-q", "main"]);
  if (hookShape === "main-only") {
    await mkdir(join(repo, ".claude", "hooks"), { recursive: true });
    await writeFile(join(repo, ".claude", "hooks", "horizon-check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    git(["add", ".claude/hooks/horizon-check.sh"]);
  }
  await writeFile(join(repo, "source.txt"), "theirs\n");
  await writeFile(join(repo, "helper.txt"), "main helper\n");
  git(["add", "."]); git(["commit", "-qm", "main change"]);
  for (let i = 0; i < 50; i++) { await writeFile(join(repo, "main.txt"), `main ${i}\n`); git(["add", "."]); git(["commit", "-qm", `main ${i}`]); }
  git(["push", "-qu", "origin", "main"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "feature"]);
  assert.throws(() => git(["merge", "--no-commit", "origin/main"]));
  const original = await readFile(join(repo, "source.txt"), "utf8");
  const lines = original.trimEnd().split("\n");
  const patch = `--- a/source.txt\n+++ b/source.txt\n@@ -1,${lines.length} +1 @@\n${lines.map(line => "-" + line).join("\n")}\n+resolved\n`;
  const commentUrl = "https://github.com/example/project/pull/42#issuecomment-101";
  const comment = { id: 101, html_url: commentUrl, issue_url: "https://api.github.com/repos/example/project/issues/42", author_association: "MEMBER", user: { login: "checker" }, created_at: new Date().toISOString(), body: `## NOT READY at ${head}\n\n<!-- rhiz-review-agent -->\nIndependent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${head}\`.\n\nResolve source.txt preserving both legs.` };
  const { createHash } = await import("node:crypto");
  const anchor = git(["diff", "--numstat", `${base}...${head}`]).split("\n").reduce((sum, row) => { const [a,d] = row.split("\t"); return sum + Number(a) + Number(d); }, 0);
  await writeFile(join(repo, ".rhiz-horizon-reviews.json"), JSON.stringify({ reviews: { feature: { change: 42, anchorDiffLines: 400, correctionReceipts: [{ head, commentUrl, commentDigest: createHash("sha256").update(comment.body).digest("hex"), reviewerLogin: "checker", anchorDiffLines: 999999 }] } } }));
  const calls = join(root, "calls.txt");
  await writeFile(calls, "");
  const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await writeFile(join(bin, "git"), `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(process.env.CONVERGENCE_MODE==='crash-before-apply'&&args[0]==='apply'&&args.length===2){process.kill(process.ppid,'SIGKILL');process.exit(0)}const r=cp.spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});if(r.status===0&&process.env.CONVERGENCE_MODE==='crash-after-add'&&JSON.stringify(args)===JSON.stringify(['add','--','source.txt']))process.kill(process.ppid,'SIGKILL');if(r.status===0&&process.env.CONVERGENCE_MODE==='crash-after-effect-push'&&args.includes('push')&&args.some(a=>a.endsWith('/effect')))process.kill(process.ppid,'SIGKILL');process.exit(r.status??1);\n`, { mode: 0o755 });
  const historicalBase = git(["merge-base", head, base]);
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');const m=process.env.CONVERGENCE_MODE;const old=${JSON.stringify(comment)};const c=structuredClone(old);if(m==='ready-review'){c.id=102;c.html_url=c.html_url.replace('101','102');c.body=c.body.replace('## NOT READY at','## READY at')}if(m==='stale-review')c.created_at='2000-01-01T00:00:00Z';if(m==='forge-failure')process.exit(1);const endpoint=process.argv.at(-1);const main={ref:'refs/heads/main',object:{type:'commit',sha:m==='wrong-main-ref'?'0'.repeat(40):'${base}'}};let apiComment=c;if(m==='altered-review'&&endpoint.endsWith('/101')){const countPath=${JSON.stringify(join(root, "altered-comment-count"))};let count=0;try{count=Number(fs.readFileSync(countPath,'utf8'))}catch{}fs.writeFileSync(countPath,String(count+1));if(count>=1)apiComment={...c,body:c.body+' altered'}}console.log(JSON.stringify(process.argv[2]==='api'?(endpoint.endsWith('/git/ref/heads/main')?main:m==='ready-review'&&endpoint.endsWith('/101')?old:apiComment):{number:42,url:'https://github.com/example/project/pull/42',state:'OPEN',headRefOid:'${head}',baseRefOid:m==='wrong-base'?'0'.repeat(40):m==='historical-base'?'${historicalBase}':'${base}',baseRefName:'main',comments:[{url:old.html_url,body:old.body},{url:c.html_url,body:c.body}]}));\n`, { mode: 0o755 });
  await writeFile(join(root, "codex-fixture.mjs"), CONVERGENCE_CODEX_FIXTURE);
  await writeFile(join(bin, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${join(root, "codex-fixture.mjs")}'\n`, { mode: 0o755 });
  await writeFile(join(bin, "claude"), `#!${process.execPath}\nconst fs=require('node:fs');let prompt='';process.stdin.on('data',bytes=>prompt+=bytes);process.stdin.on('end',()=>{fs.appendFileSync(process.env.CONVERGENCE_CALLS,'review\\n');if(process.env.CONVERGENCE_MODE==='concurrent-state')fs.writeFileSync(process.env.CONVERGENCE_SOURCE+'/new-untracked.txt','concurrent');const supplied=['packet','original:source.txt','accepted-main:source.txt','projected:source.txt'].every(label=>prompt.includes(JSON.stringify(label)));const status=process.env.CONVERGENCE_MODE==='review-refuses'||(process.env.CONVERGENCE_MODE==='requires-material'&&!supplied)?'fail':'pass';console.log(JSON.stringify({is_error:false,result:JSON.stringify({status,summary:'Scripted structural reviewer fixture',findings:[]})}));});\n`, { mode: 0o755 });
  const inputFile = join(root, "request.json");
  const request = { schema: "rhiz/convergence-request/v1", purpose: "resolve-integration", paths: ["source.txt"], patch, reviewCommentUrl: commentUrl };
  await writeFile(inputFile, JSON.stringify(request));
  const run = (mode = "normal") => {
    const childEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), CONVERGENCE_MODE: mode, CONVERGENCE_SOURCE: repo, CONVERGENCE_CALLS: calls };
    delete (childEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [hostScript, "converge", "--repo", repo, "--artifact-request", inputFile], { cwd: repo, env: childEnv, encoding: "utf8", timeout: 180000 });
  };
  const check = (mode = "normal") => {
    const childEnv = { ...env, PATH: bin + ":" + (process.env.PATH ?? ""), CONVERGENCE_MODE: mode };
    delete (childEnv as Record<string, string | undefined>).NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [hostScript, "check", "--repo", repo, "--integration-ref", "origin/main", "--json"], { cwd: repo, env: childEnv, encoding: "utf8" });
  };
  const recover = (workId: string, changedIdentity = false) => spawnSync(process.execPath, [hostScript, "converge", "--repo", repo, "--recover-effect", workId], { cwd: repo, env: { ...env, ...(changedIdentity ? { GIT_AUTHOR_NAME: "Changed author", GIT_AUTHOR_EMAIL: "changed-author@example.invalid", GIT_COMMITTER_NAME: "Changed committer", GIT_COMMITTER_EMAIL: "changed-committer@example.invalid" } : {}) }, encoding: "utf8" });
  return { root, repo, git, head, base, original, inputFile, request, run, check, recover, calls, anchor, remote };
}

test("fixed convergence executes new Work/Verify/Review before one bounded real merge effect", async () => {
  const f = await convergenceFixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    assert.equal(f.git(["ls-files", "--unmerged"]), "");
    assert.equal(f.git(["rev-parse", "MERGE_HEAD"]), f.base);
    assert.equal(f.git(["rev-parse", "HEAD"]), f.head, "effect does not commit or wash history");
    assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n");
    const replay = f.run();
    assert.notEqual(replay.status, 0, "replay cannot create another window or skip invocation");
    f.git(["commit", "-qm", "complete genuine reconciliation"]);
    f.git(["push", "-qu", "origin", "feature"]);
    const ordinary = spawnSync(process.execPath, [hostScript, "check", "--repo", f.repo, "--integration-ref", "origin/main", "--json"], { cwd: f.repo, encoding: "utf8" });
    const measured = JSON.parse(ordinary.stdout);
    assert.equal(measured.signals.commitsAhead, 10);
    assert.equal(measured.signals.commitsBehind, 0);
    assert.equal(measured.state, "tripped", "complete convergence does not forgive subsequent general writes");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("convergence derives hook-free policy from both Git trees and refuses one-sided or malformed hooks", async () => {
  for (const shape of ["source-only", "main-only", "source-non-executable", "source-symlink", "claude-file-parent", "claude-symlink-parent"] as const) {
    const f = await convergenceFixture(8, shape);
    try {
      const result = f.run();
      assert.notEqual(result.status, 0, shape);
      assert.match(result.stderr + result.stdout, /governed overlay requires matching valid hooks|must be a regular executable file|hook must be absent or one tracked regular executable|non-directory ancestor|traverses a symbolic link/);
      assert.equal(await readFile(f.calls, "utf8"), "", `${shape} refuses before worker/reviewer`);
      assert.ok(f.git(["ls-files", "--unmerged"]), `${shape} preserves original conflict state`);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("hook-free convergence accepts ordinary .claude and .claude/hooks directories", async () => {
  for (const shape of ["claude-readme", "hooks-readme"] as const) {
    const f = await convergenceFixture(9, shape);
    try {
      const result = f.run();
      assert.equal(result.status, 0, `${shape}: ${result.stderr}${result.stdout}`);
      assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
      assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

// Falsifies: integration/review-context-anchor-is-effect-only
test("a fresh exact-head READY anchors only resolve-integration when no correction receipt exists", async () => {
  const f = await convergenceFixture();
  try {
    const reviewPath = join(f.repo, ".rhiz-horizon-reviews.json");
    const reviews = JSON.parse(await readFile(reviewPath, "utf8"));
    delete reviews.reviews.feature.correctionReceipts;
    await writeFile(reviewPath, JSON.stringify(reviews));
    const reviewCommentUrl = f.request.reviewCommentUrl.replace("101", "102");
    await writeFile(f.inputFile, JSON.stringify({ ...f.request, reviewCommentUrl }));

    const ordinary = f.check("ready-review");
    assert.equal(JSON.parse(ordinary.stdout).state, "tripped", "READY does not grant ordinary write permission");
    assert.equal(await readFile(f.calls, "utf8"), "");

    const result = f.run("ready-review");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n", "the READY anchor does not skip fresh Work, Verify, or independent Review");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    assert.equal(f.git(["rev-parse", "HEAD"]), f.head);

    const reading = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    assert.equal(reading.unreadable.length, 0);
    const events = reading.ledgers.flatMap((ledger) => ledger.events);
    const effect = events.find((event) => event.evidence.some((entry) => entry.id === "convergence:effect"));
    assert.ok(effect);
    const effectUri = effect.evidence.find((entry) => entry.id === "convergence:effect")!.uri!;
    const effectHead = /^git:([^:]+):artifact.json$/.exec(effectUri)![1];
    const receipt = JSON.parse(f.git(["show", `${effectHead}:artifact.json`]));
    const workCreated = events.find((event) => event.workId === receipt.workId && event.type === "work.created");
    const verification = events.find((event) => event.id === receipt.verificationEventId);
    const review = events.find((event) => event.id === receipt.reviewEventId);
    assert.ok(workCreated, "the exact effect is linked to its new durable Work");
    assert.equal(verification?.type, "verification.result");
    assert.equal(verification?.payload.status, "pass");
    assert.equal(review?.type, "review.result");
    assert.equal(review?.payload.status, "pass");
    assert.notEqual(review?.actor.id, verification?.actor.id, "independent Review remains required");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("an unrecorded NOT READY review does not authorize ordinary writes", async () => {
  const f = await convergenceFixture();
  try {
    const reviewPath = join(f.repo, ".rhiz-horizon-reviews.json");
    const reviews = JSON.parse(await readFile(reviewPath, "utf8"));
    delete reviews.reviews.feature.correctionReceipts;
    await writeFile(reviewPath, JSON.stringify(reviews));
    const result = f.check();
    assert.equal(JSON.parse(result.stdout).state, "tripped");
    assert.equal(await readFile(f.calls, "utf8"), "", "ordinary check does not invoke Work or provider");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
    assert.ok(f.git(["ls-files", "--unmerged"]));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a fresh exact-head NOT READY anchors only resolve-integration without creating a correction receipt", async () => {
  const f = await convergenceFixture();
  try {
    const reviewPath = join(f.repo, ".rhiz-horizon-reviews.json");
    const reviews = JSON.parse(await readFile(reviewPath, "utf8"));
    delete reviews.reviews.feature.correctionReceipts;
    await writeFile(reviewPath, JSON.stringify(reviews));

    const ordinary = f.check();
    assert.equal(JSON.parse(ordinary.stdout).state, "tripped", "NOT READY review context does not grant ordinary write permission");
    assert.equal(await readFile(f.calls, "utf8"), "");

    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n", "NOT READY context does not skip fresh Work, Verify, or independent Review");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    assert.equal(f.git(["rev-parse", "HEAD"]), f.head);

    const recorded = JSON.parse(await readFile(reviewPath, "utf8"));
    assert.equal(recorded.reviews.feature.correctionReceipts, undefined, "effect-only review context is not persisted as a correction receipt");
    const reading = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    assert.equal(reading.unreadable.length, 0);
    const events = reading.ledgers.flatMap((ledger) => ledger.events);
    const effects = events.filter((event) => event.evidence.some((entry) => entry.id === "convergence:effect"));
    assert.equal(effects.length, 1, "exactly one bounded convergence effect was recorded");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("an unrecorded NOT READY cannot authorize terminal repair", async () => {
  const f = await convergenceFixture(8);
  try {
    const prepared = f.run();
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    await writeFile(f.calls, "");
    const reviewPath = join(f.repo, ".rhiz-horizon-reviews.json");
    await rm(reviewPath, { force: true });
    f.git(["commit", "-qm", "complete reviewed integration"]);
    f.git(["push", "-qu", "origin", "feature"]);
    const terminalHead = f.git(["rev-parse", "HEAD"]);
    const terminalCommentUrl = "https://github.com/example/project/pull/42#issuecomment-202";
    const terminalOriginal = await readFile(join(f.repo, "source.txt"), "utf8");
    assert.equal(terminalOriginal, "resolved\n");
    assert.equal(f.git(["status", "--porcelain"]), "");
    assert.equal(f.git(["rev-list", "--count", "origin/main..HEAD"]), "9");
    const terminalComment = { id: 202, html_url: terminalCommentUrl, issue_url: "https://api.github.com/repos/example/project/issues/42", author_association: "MEMBER", user: { login: "checker" }, created_at: new Date().toISOString(), body: `## NOT READY at ${terminalHead}\n\n<!-- rhiz-review-agent -->\nIndependent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${terminalHead}\`.\n\nResolve the finding on this exact head.` };
    const historicalBase = f.git(["merge-base", terminalHead, f.base]);
    await writeFile(join(f.root, "bin", "gh"), `#!${process.execPath}\nconst endpoint=process.argv.at(-1);const c=${JSON.stringify(terminalComment)};const main={ref:'refs/heads/main',object:{type:'commit',sha:'${f.base}'}};console.log(JSON.stringify(process.argv[2]==='api'?(endpoint.endsWith('/git/ref/heads/main')?main:c):{number:42,url:'https://github.com/example/project/pull/42',state:'OPEN',headRefOid:'${terminalHead}',baseRefOid:'${historicalBase}',baseRefName:'main',comments:[{url:c.html_url,body:c.body}]}));\n`, { mode: 0o755 });
    const patch = "--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-resolved\n+terminal resolved\n";
    await writeFile(f.inputFile, JSON.stringify({ ...f.request, purpose: "repair-reviewed-target", patch, reviewCommentUrl: terminalCommentUrl }));

    await assert.rejects(readFile(reviewPath, "utf8"), { code: "ENOENT" });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /attributable existing correction round/);
    assert.equal(await readFile(f.calls, "utf8"), "", "terminal repair refuses before Work or provider invocation");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), terminalOriginal);
    await assert.rejects(readFile(reviewPath, "utf8"), { code: "ENOENT" }, "refusal does not create a review receipt");
    assert.equal(f.git(["ls-files", "--unmerged"]), "");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("fresh READY at the inclusive 125 percent boundary is refused before execution", async () => {
  const f = await convergenceFixture();
  try {
    const reviewPath = join(f.repo, ".rhiz-horizon-reviews.json");
    const reviews = JSON.parse(await readFile(reviewPath, "utf8"));
    delete reviews.reviews.feature.correctionReceipts;
    await writeFile(reviewPath, JSON.stringify(reviews));

    // The feature adds 8 * 65 lines. Resolving the one-line accepted-main
    // conflict adds two diff lines, so this patch reaches ceil(anchor * 1.25).
    const boundary = Math.ceil(f.anchor * 1.25);
    const resolvedLineCount = boundary - 521;
    assert.ok(resolvedLineCount > 1);
    const originalLines = f.original.trimEnd().split("\n");
    const resolvedLines = ["resolved", ...Array.from({ length: resolvedLineCount - 1 }, (_, index) => `extra ${index}`)];
    const patch = `--- a/source.txt\n+++ b/source.txt\n@@ -1,${originalLines.length} +1,${resolvedLines.length} @@\n${originalLines.map((line) => `-${line}`).join("\n")}\n${resolvedLines.map((line) => `+${line}`).join("\n")}\n`;
    const reviewCommentUrl = f.request.reviewCommentUrl.replace("101", "102");
    await writeFile(f.inputFile, JSON.stringify({ ...f.request, patch, reviewCommentUrl }));

    const result = f.run("ready-review");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exceeds the existing inclusive growth bound/);
    assert.equal(await readFile(f.calls, "utf8"), "", "the boundary refuses before Work or provider invocation");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
    assert.ok(f.git(["ls-files", "--unmerged"]));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("convergence refuses stale, altered, unavailable and foreign forge evidence before model invocation", async () => {
  for (const mode of ["stale-review", "altered-review", "forge-failure", "wrong-base"]) {
    const f = await convergenceFixture();
    try {
      const result = f.run(mode);
      assert.notEqual(result.status, 0, mode);
      assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
      assert.equal(await readFile(f.calls, "utf8"), "", "failed mechanical predicates spend no model calls");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("actual failed verification, failed review and concurrent extra state cannot authorize source writes", async () => {
  for (const mode of ["bad-artifact", "review-refuses", "concurrent-state"]) {
    const f = await convergenceFixture();
    try {
      const result = f.run(mode);
      assert.notEqual(result.status, 0, mode);
      assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
      const calls = await readFile(f.calls, "utf8");
      assert.equal(calls, mode === "bad-artifact" ? "worker\n" : "worker\nreview\n", "the intended boundary, not an earlier failure, must refuse");
      assert.match(result.stderr, mode === "bad-artifact" ? /controlled start failed/ : mode === "review-refuses" ? /controlled review failed/ : /convergence effect refused/);
      assert.ok(f.git(["ls-files", "--unmerged"]).length > 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("convergence rejects foreign scope, changed merge state and author-supplied evidence fields without execution", async () => {
  for (const scenario of ["foreign-scope", "wrong-merge", "caller-proof", "changed-stage"]) {
    const f = await convergenceFixture();
    try {
      if (scenario === "foreign-scope") await writeFile(f.inputFile, JSON.stringify({ ...f.request, paths: ["foreign.txt"] }));
      if (scenario === "caller-proof") await writeFile(f.inputFile, JSON.stringify({ ...f.request, verified: true, reviewer: "author" }));
      if (scenario === "wrong-merge") await writeFile(join(f.repo, ".git", "MERGE_HEAD"), f.head + "\n");
      if (scenario === "changed-stage") {
        // Preserve working conflict bytes but alter the actual stage2 identity.
        const blobFile = join(f.root, "wrong-stage.txt");
        await writeFile(blobFile, "wrong stage\n");
        const blob = f.git(["hash-object", "-w", blobFile]);
        execFileSync("git", ["update-index", "--index-info"], { cwd: f.repo, input: `100644 ${blob} 2\tsource.txt\n`, encoding: "utf8" });
      }
      const result = f.run();
      assert.notEqual(result.status, 0, scenario);
      assert.equal(await readFile(f.calls, "utf8"), "", scenario);
      assert.equal(f.git(["rev-parse", "HEAD"]), f.head);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});


test("nested custody links refuse before native invocation and cannot write outside source", async () => {
  const f = await convergenceFixture();
  try {
    const outside = join(f.root, "outside");
    await mkdir(outside); await mkdir(join(f.repo, ".context"));
    await symlink(outside, join(f.repo, ".context/horizon-convergence"));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /custody ancestor/);
    assert.equal(await readFile(f.calls, "utf8"), "");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("remote artifacts retain complete packet and projected objects; interrupted effects recover without reapplying", async () => {
  const f = await convergenceFixture();
  try {
    const interrupted = f.run("crash-after-add");
    assert.equal(interrupted.signal, "SIGKILL");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    const records = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    assert.equal(records.unreadable.length, 0);
    const events = records.ledgers.flatMap(item => item.events);
    const intentEvent = events.find(event => event.evidence.some(entry => entry.id === "convergence:intent"));
    assert.ok(intentEvent);
    assert.ok(!events.some(event => event.evidence.some(entry => entry.id === "convergence:effect")));
    const intentEvidence = intentEvent.evidence.find(entry => entry.id === "convergence:intent")!;
    const intentHead = /^git:([^:]+):artifact.json$/.exec(intentEvidence.uri!)![1];
    const fresh = join(f.root, "fresh");
    execFileSync("git", ["clone", "-q", "--no-local", f.remote, fresh]);
    const freshGit = (args: string[]) => execFileSync("git", args, { cwd: fresh, encoding: "utf8" }).trim();
    const refs = f.git(["ls-remote", "origin", "refs/rhiz/work/*/intent"]).split("\n").map(row => row.split("\t")[1]);
    assert.equal(refs.length, 1);
    freshGit(["fetch", "-q", "origin", refs[0]!]);
    const intent = JSON.parse(freshGit(["show", `${intentHead}:artifact.json`]));
    assert.equal(intent.packet.request.patch, f.request.patch);
    const reviewMaterial = JSON.parse(freshGit(["show", `${intent.reviewMaterial.head}:artifact.json`]));
    for (const entry of reviewMaterial.blobs.filter((item: { blob?: string }) => item.blob)) assert.ok(freshGit(["cat-file", "blob", entry.blob]));
    assert.equal(freshGit(["rev-parse", `${intent.packet.projected.tree}^{tree}`]), intent.packet.projected.tree);
    assert.equal(freshGit(["show", `${intent.packet.projected.tree}:source.txt`]), "resolved");
    const calls = await readFile(f.calls, "utf8");
    await writeFile(join(f.repo, "extra-untracked.txt"), "divergent");
    assert.notEqual(f.recover(intent.workId).status, 0, "foreign source state cannot be reconstructed as the reviewed effect");
    await rm(join(f.repo, "extra-untracked.txt"));
    const recovered = f.recover(intent.workId);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).recovered, true);
    assert.equal(await readFile(f.calls, "utf8"), calls, "readback recovery does not invoke a worker or reapply source");
    const afterEvents = (await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events);
    const effect = afterEvents.find(event => event.evidence.some(entry => entry.id === "convergence:effect"))!;
    assert.ok(effect);
    const effectUri = effect.evidence.find(entry => entry.id === "convergence:effect")!.uri!;
    const effectHead = /^git:([^:]+):artifact.json$/.exec(effectUri)![1];
    const receipt = JSON.parse(f.git(["show", `${effectHead}:artifact.json`]));
    assert.equal(receipt.sourceAfter, JSON.parse(recovered.stdout).sourceAfter);
    assert.notEqual(f.recover(intent.workId).status, 0, "completed recovery cannot produce another effect receipt");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("recovery refuses a recorded intent whose source effect never ran", async () => {
  const f = await convergenceFixture();
  try {
    const interrupted = f.run("crash-before-apply");
    assert.equal(interrupted.signal, "SIGKILL");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
    const events = (await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events);
    const intent = events.find(event => event.evidence.some(entry => entry.id === "convergence:intent"))!;
    assert.ok(intent);
    assert.notEqual(f.recover(intent.workId!).status, 0);
    assert.ok(!(await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events).some(event => event.evidence.some(entry => entry.id === "convergence:effect")));
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("late interruption reuses the exact durable receipt despite operator identity changes", async () => {
  const f = await convergenceFixture();
  try {
    assert.equal(f.run("crash-after-effect-push").signal, "SIGKILL");
    const events = (await readRepositoryWorkLedgers(join(f.repo, ".git"))).ledgers.flatMap(item => item.events);
    const intent = events.find(event => event.evidence.some(entry => entry.id === "convergence:intent"))!;
    assert.ok(intent);
    assert.ok(!events.some(event => event.evidence.some(entry => entry.id === "convergence:effect")));
    const remoteBefore = f.git(["ls-remote", "origin", "refs/rhiz/work/*/effect"]);
    assert.ok(remoteBefore);
    f.git(["config", "user.name", "Changed operator"]); f.git(["config", "user.email", "changed@example.invalid"]);
    const recovered = f.recover(intent.workId!, true);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(f.git(["ls-remote", "origin", "refs/rhiz/work/*/effect"]), remoteBefore);
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("READY integration context still requires actual execution and cannot become a terminal correction receipt", async () => {
  const f = await convergenceFixture();
  try {
    const reviewCommentUrl = f.request.reviewCommentUrl.replace("101", "102");
    await writeFile(f.inputFile, JSON.stringify({ ...f.request, reviewCommentUrl, purpose: "repair-reviewed-target" }));
    const terminal = f.run("ready-review");
    assert.notEqual(terminal.status, 0);
    assert.match(terminal.stderr, /exact-head correction review/);
    assert.equal(await readFile(f.calls, "utf8"), "");
    await writeFile(f.inputFile, JSON.stringify({ ...f.request, reviewCommentUrl }));
    const resolution = f.run("ready-review");
    assert.equal(resolution.status, 0, resolution.stderr);
    assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n", "READY context does not skip live Work/Verify/Review");
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
    assert.equal(f.git(["rev-parse", "HEAD"]), f.head);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("convergence binds actual repository main even when PR comparison base is historical", async () => {
  for (const mode of ["historical-base", "wrong-main-ref"]) {
    const f = await convergenceFixture();
    try {
      const result = f.run(mode);
      if (mode === "wrong-main-ref") {
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(f.calls, "utf8"), "");
        assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), f.original);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(f.calls, "utf8"), "worker\nreview\n");
        assert.equal(f.git(["rev-parse", "MERGE_HEAD"]), f.base);
        assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});


test("convergence delivers whole independent review material and requires its raw identity before effects", async () => {
  const f = await convergenceFixture();
  try {
    const result = f.run("requires-material");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { readRepositoryWorkLedgers } = await import("../adapters/local/work-ledgers.js");
    const reading = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    const events = reading.ledgers.flatMap((ledger) => ledger.events);
    const review = events.find((event) => event.type === "review.result");
    assert.ok(review?.evidence.some((entry) => entry.id.startsWith("review-material:") && entry.uri?.startsWith("git:") && entry.digest?.length === 64));
    assert.equal(await readFile(join(f.repo, "source.txt"), "utf8"), "resolved\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("convergence material preserves actual typed absence for an accepted-main-only helper", async () => {
  const f = await convergenceFixture();
  try {
    const request = { ...f.request, paths: ["source.txt", "helper.txt"], patch: f.request.patch + "--- a/helper.txt\n+++ b/helper.txt\n@@ -1 +1 @@\n-main helper\n+main helper adapted\n" };
    await writeFile(f.inputFile, JSON.stringify(request));
    const result = f.run("requires-material");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const { readRepositoryWorkLedgers } = await import("../adapters/local/work-ledgers.js");
    const reading = await readRepositoryWorkLedgers(join(f.repo, ".git"));
    const event = reading.ledgers.flatMap((ledger) => ledger.events).find((item) => item.evidence.some((entry) => entry.id === "convergence:review-material"));
    assert.ok(event);
    const uri = event.evidence[0]?.uri;
    assert.ok(uri);
    const material = JSON.parse(f.git(["show", uri.slice(4)]));
    assert.ok(material.blobs.some((entry: { label: string; tree: string; absent?: boolean }) => entry.label === "original:helper.txt" && entry.tree === f.head && entry.absent === true));
    assert.equal(await readFile(join(f.repo, "helper.txt"), "utf8"), "main helper adapted\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
