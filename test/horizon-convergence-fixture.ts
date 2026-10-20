import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRepositoryWorkLedgers } from "../adapters/local/work-ledgers.js";

export const HOUR = 60 * 60 * 1000;
export const hostScript = resolve("scripts/horizon.mjs");

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

export async function convergenceFixture() {
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
  await writeFile(join(repo, "source.txt"), "base\n");
  await writeFile(join(repo, "foreign.txt"), "foreign\n");
  git(["add", "."]); git(["commit", "-qm", "base"]);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git(["remote", "add", "origin", remote]); git(["push", "-qu", "origin", "main"]);
  git(["checkout", "-qb", "feature"]);
  const when = new Date(Date.now() - 50 * HOUR).toISOString();
  for (let i = 0; i < 9; i++) {
    await writeFile(join(repo, i === 0 ? "source.txt" : `feature-${i}.txt`), i === 0 ? "ours\n" : "feature\n".repeat(65));
    git(["add", "."]);
    execFileSync("git", ["commit", "-qm", `feature ${i}`], { cwd: repo, env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  }
  const head = git(["rev-parse", "HEAD"]);
  git(["push", "-qu", "origin", "feature"]);
  git(["checkout", "-q", "main"]);
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
  await writeFile(join(bin, "git"), `#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(process.env.CONVERGENCE_MODE==='crash-before-apply'&&args[0]==='apply'&&args.length===2){process.kill(process.ppid,'SIGKILL');process.exit(0)}const fs=require('node:fs');if(process.env.CONVERGENCE_MODE?.startsWith('retainer-')&&args.includes('hash-object')&&fs.readFileSync(process.env.CONVERGENCE_CALLS,'utf8').includes('review\\n')){if(args.includes('--stdin')){console.error('scripted old stdin retention refusal');process.exit(7)}const file=args.at(-1),bytes=fs.readFileSync(file),stat=fs.lstatSync(file);fs.appendFileSync(process.env.CONVERGENCE_CALLS+'.retention',JSON.stringify({file,bytes:bytes.length,digest:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),regular:stat.isFile(),mode:stat.mode&511,started:Date.now()})+'\\n');if(process.env.CONVERGENCE_MODE==='retainer-timeout'){setTimeout(()=>process.exit(8),40000);return}}const r=cp.spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});if(r.status===0&&process.env.CONVERGENCE_MODE==='crash-after-add'&&JSON.stringify(args)===JSON.stringify(['add','--','source.txt']))process.kill(process.ppid,'SIGKILL');if(r.status===0&&process.env.CONVERGENCE_MODE==='crash-after-effect-push'&&args.includes('push')&&args.some(a=>a.endsWith('/effect')))process.kill(process.ppid,'SIGKILL');process.exit(r.status??1);\n`, { mode: 0o755 });
  const historicalBase = git(["merge-base", head, base]);
  await writeFile(join(bin, "gh"), `#!${process.execPath}\nconst m=process.env.CONVERGENCE_MODE;const old=${JSON.stringify(comment)};const c=structuredClone(old);if(m==='ready-review'){c.id=102;c.html_url=c.html_url.replace('101','102');c.body=c.body.replace('## NOT READY at','## READY at')}if(m==='stale-review')c.created_at='2000-01-01T00:00:00Z';if(m==='altered-review')c.body+=' altered';if(m==='forge-failure')process.exit(1);const endpoint=process.argv.at(-1);const main={ref:'refs/heads/main',object:{type:'commit',sha:m==='wrong-main-ref'?'0'.repeat(40):'${base}'}};console.log(JSON.stringify(process.argv[2]==='api'?(endpoint.endsWith('/git/ref/heads/main')?main:m==='ready-review'&&endpoint.endsWith('/101')?old:c):{number:42,url:'https://github.com/example/project/pull/42',state:'OPEN',headRefOid:'${head}',baseRefOid:m==='wrong-base'?'0'.repeat(40):m==='historical-base'?'${historicalBase}':'${base}',baseRefName:'main',comments:[{url:old.html_url,body:old.body},{url:c.html_url,body:c.body}]}));\n`, { mode: 0o755 });
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
  const recover = (workId: string, changedIdentity = false) => spawnSync(process.execPath, [hostScript, "converge", "--repo", repo, "--recover-effect", workId], { cwd: repo, env: { ...env, ...(changedIdentity ? { GIT_AUTHOR_NAME: "Changed author", GIT_AUTHOR_EMAIL: "changed-author@example.invalid", GIT_COMMITTER_NAME: "Changed committer", GIT_COMMITTER_EMAIL: "changed-committer@example.invalid" } : {}) }, encoding: "utf8" });
  return { root, repo, git, head, base, original, inputFile, request, run, recover, calls, anchor, remote };
}
