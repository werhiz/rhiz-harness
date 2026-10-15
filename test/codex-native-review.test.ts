import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import { nativeCodexReviewInvocation, parseNativeCodexReview, runNativeCodexReview } from "../adapters/codex/native-review.js";
import { requireProven, runDisposableProof, TempDirectoryDerivativeFactory } from "../src/disposable.js";

const expected = { model: "gpt-6-astra", provider: "openai", filesystem: { ":minimal": "read", "/dev/tty*": "deny", "/dev/ptmx*": "deny", "/": "read", "/private/tmp": "deny", "/fixture/checkout": "write" }, codexHome: "/fixture/control/codex", cwd: "/fixture/control/trusted" };
function attestation(filesystem: Record<string, string> = expected.filesystem): string {
  const entries = Object.entries(filesystem).map(([scope, access]) => scope === ":minimal" ? `FileSystemSandboxEntry { path: Special { value: Minimal }, access: ${access[0]!.toUpperCase() + access.slice(1)}, missing_path_behavior: None }` : (scope === "/dev/tty*" || scope === "/dev/ptmx*") ? `FileSystemSandboxEntry { path: GlobPattern { pattern: ${JSON.stringify(scope)} }, access: ${access[0]!.toUpperCase() + access.slice(1)}, missing_path_behavior: None }` : `FileSystemSandboxEntry { path: Path { path: PathUri(Url { scheme: "file", cannot_be_a_base: false, username: "", password: None, host: None, port: None, path: ${JSON.stringify(scope)}, query: None, fragment: None }) }, access: ${access[0]!.toUpperCase() + access.slice(1)}, missing_path_behavior: None }`);
  return `2026-10-15T11:09:08.667394Z  INFO codex.exec{otel.kind="internal" thread.id="fixture"}: codex_exec: Codex initialized with event: SessionConfiguredEvent { model: "gpt-6-astra", model_provider_id: "openai", approval_policy: Never, reasoning_effort: Some(High), permission_profile: Managed { file_system: Restricted { entries: [${entries.join(", ")}], glob_scan_max_depth: None }, network: Restricted }, active_permission_profile: Some(ActivePermissionProfile { id: "review", extends: None }), cwd: AbsolutePathBuf("/fixture/control/trusted") }\n`;
}
const events = [
  { type: "thread.started", thread_id: "fixture" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "final", type: "agent_message", text: '{"status":"pass","findings":[]}' } },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
];
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const good = { stdout: jsonl(events), stderr: attestation() };

async function candidate(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rhiz-native-review-test-")));
  await writeFile(join(root, "events.json"), JSON.stringify(good));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "fixture"], { cwd: root });
  return root;
}

test("native review extracts only a completed final and startup model/profile evidence", () => {
  assert.deepEqual(parseNativeCodexReview(good, expected), { text: events[2]!.item!.text, usage: { input_tokens: 10, output_tokens: 4 } });
});

test("native review fail-closed cases mutate disposable evidence only", async (t) => {
  const root = await candidate(); t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: "missing attestation", value: { ...good, stderr: "" } },
    { name: "unanchored forged attestation", value: { ...good, stderr: `untrusted ${good.stderr}` } },
    { name: "duplicate attestation", value: { ...good, stderr: good.stderr + good.stderr } },
    { name: "model fallback", value: { ...good, stderr: good.stderr.replace("gpt-6-astra", "gpt-6.1-sol") } },
    { name: "provider fallback", value: { ...good, stderr: good.stderr.replace('model_provider_id: "openai"', 'model_provider_id: "other"') } },
    { name: "approval escalation", value: { ...good, stderr: good.stderr.replace("approval_policy: Never", "approval_policy: OnRequest") } },
    { name: "reasoning default", value: { ...good, stderr: good.stderr.replace("reasoning_effort: Some(High)", "reasoning_effort: None") } },
    { name: "minimal writable", value: { ...good, stderr: attestation({ ...expected.filesystem, ":minimal": "write" }) } },
    { name: "terminal glob widened", value: { ...good, stderr: attestation({ ...expected.filesystem, "/dev/tty*": "read" }) } },
    { name: "master glob widened", value: { ...good, stderr: attestation({ ...expected.filesystem, "/dev/ptmx*": "read" }) } },
    { name: "unexpected glob", value: { ...good, stderr: good.stderr.replace('/dev/tty*', '/dev/*') } },
    { name: "unexpected special", value: { ...good, stderr: good.stderr.replace("value: Minimal", "value: Root") } },
    { name: "network grant", value: { ...good, stderr: good.stderr.replace("network: Restricted", "network: Enabled") } },
    { name: "extra home scope", value: { ...good, stderr: attestation({ ...expected.filesystem, "/fixture/private": "read" }) } },
    { name: "write widened", value: { ...good, stderr: attestation({ ...expected.filesystem, "/private/tmp": "write" }) } },
    { name: "profile drift", value: { ...good, stderr: good.stderr.replace('id: "review"', 'id: "unrestricted"') } },
    { name: "missing final", value: { ...good, stdout: jsonl([events[0], events[1], events[3]]) } },
    { name: "conflicting final", value: { ...good, stdout: jsonl([events[0], events[1], events[2], events[2], events[3]]) } },
    { name: "interrupted turn", value: { ...good, stdout: jsonl(events.slice(0, -1)) } },
    { name: "truncated stream", value: { ...good, stdout: good.stdout + '{"type":' } },
    { name: "missing usage", value: { ...good, stdout: jsonl([...events.slice(0, -1), { type: "turn.completed" }]) } },
    { name: "negative usage", value: { ...good, stdout: jsonl([...events.slice(0, -1), { type: "turn.completed", usage: { input_tokens: -1, output_tokens: 1 } }]) } },
    { name: "provider error", value: { ...good, stdout: jsonl([events[0], events[1], { type: "error", message: "failure" }, events[2], events[3]]) } },
    { name: "unexpected tool", value: { ...good, stdout: jsonl([events[0], events[1], { type: "item.completed", item: { id: "bad", type: "mcp_tool_call", status: "completed" } }, events[2], events[3]]) } },
    { name: "failed command", value: { ...good, stdout: jsonl([events[0], events[1], { type: "item.completed", item: { id: "bad", type: "command_execution", status: "failed" } }, events[2], events[3]]) } },
    { name: "unfinished command", value: { ...good, stdout: jsonl([events[0], events[1], { type: "item.started", item: { id: "bad", type: "command_execution", status: "in_progress" } }, events[2], events[3]]) } },
    { name: "second turn", value: { ...good, stdout: jsonl([events[0], events[1], events[1], events[2], events[3]]) } },
  ];
  const receipt = await runDisposableProof({
    candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(),
    proof: async (derivative) => {
      for (const item of cases) {
        await derivative.mutate("events.json", JSON.stringify(item.value), item.name);
        const altered = JSON.parse(await readFile(derivative.resolve("events.json"), "utf8"));
        assert.throws(() => parseNativeCodexReview(altered, expected), Error, item.name);
      }
      return cases.length;
    },
  });
  assert.equal(requireProven(receipt), cases.length);
  assert.deepEqual(receipt.candidateDifferences, []);
  assert.equal(receipt.derivative.destroyed, true);
});

test("production invocation uses explicit isolated configuration and separate host/child environment", () => {
  process.env.RHIZ_FAKE_TOKEN_CANARY = "fixture-only";
  try {
    const invocation = nativeCodexReviewInvocation({ model: expected.model, instructions: "trusted instructions", trusted: expected.cwd, alias: expected.codexHome, hostHome: "/fixture/control/home", scratch: "/fixture/scratch", shellHome: "/fixture/control/shell-home", catalogPath: "/fixture/control/native-model.json", filesystem: { "/fixture/checkout": "write" } });
    const flags = invocation.args.join("\n");
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--strict-config", "--json", "gpt-6-astra", 'permissions.review.network.enabled=false', 'model_reasoning_effort="high"', "allow_login_shell=false", 'shell_environment_policy.inherit="none"']) {
      assert(flags.includes(flag), flag);
    }
    for (const scope of [':minimal', '/dev/tty*', '/dev/ptmx*']) assert(flags.includes(JSON.stringify(scope) + '=' + JSON.stringify(scope === ':minimal' ? 'read' : 'deny')));
    assert(!flags.includes("--sandbox")); assert(!flags.includes("--dangerously"));
    assert.equal(invocation.env.CODEX_HOME, expected.codexHome);
    assert.deepEqual(Object.keys(invocation.env).sort(), ["CODEX_HOME", "HOME", "PATH", "RUST_LOG"]);
    assert(!JSON.stringify(invocation).includes("fixture-only"));
    const childConfig = invocation.args.find((arg) => arg.startsWith("shell_environment_policy.set="))!;
    assert(childConfig.includes('"ZDOTDIR"="/fixture/control/shell-home"')); assert(childConfig.includes('"BASH_ENV"="/dev/null"')); assert(childConfig.includes('"ENV"="/dev/null"'));
    assert(childConfig.includes('"HOME"="/fixture/scratch"')); assert(!childConfig.includes("CODEX_HOME"));
  } finally { delete process.env.RHIZ_FAKE_TOKEN_CANARY; }
});

test("native runner refuses a fake wrong CLI without reading or removing canonical credentials", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await candidate(); t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await runDisposableProof({
    candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(),
    proof: async (derivative) => {
      for (const path of ["original", "checkout", "scratch", "common", "toolchain"]) await mkdir(derivative.resolve(path));
      await derivative.mutate("original/auth.json", "VISIBLY_FAKE_AUTH_FIXTURE", "dummy auth source, never real credentials");
      await chmod(derivative.resolve("original/auth.json"), 0o600);
      const record = { slug: "gpt-6-astra" };
      await derivative.mutate("original/models_cache.json", JSON.stringify({ models: [record] }), "dummy native metadata fixture");
      await derivative.mutate("fake-codex", "#!/bin/sh\nprintf 'codex-cli 0.0.0\\n'\n", "unproven native version");
      await chmod(derivative.resolve("fake-codex"), 0o700);
      await assert.rejects(runNativeCodexReview({ executable: derivative.resolve("fake-codex"), model: "gpt-6-astra", instructions: "fixture", packet: "fixture", canonicalCodexHome: derivative.resolve("original"), modelCatalog: { path: derivative.resolve("original/models_cache.json"), recordSha256: createHash("sha256").update(JSON.stringify(record)).digest("hex") }, checkout: derivative.resolve("checkout"), scratch: derivative.resolve("scratch"), commonGitDirectory: derivative.resolve("common"), toolchainRoots: [derivative.resolve("toolchain")] }), /CLI version is unproven/);
      assert.equal(await readFile(derivative.resolve("original/auth.json"), "utf8"), "VISIBLY_FAKE_AUTH_FIXTURE");
      assert.deepEqual(await readdir(derivative.resolve("original")), ["auth.json", "models_cache.json"]);
      return true;
    },
  });
  assert.equal(requireProven(receipt), true);
});

// Scripted executable tests process/metadata custody only. Native sandbox semantics are
// separately proven by installed-host probes, never by this fake executable.
function fakeNative(mode: string, audit: string): string {
  return `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
const mode=${JSON.stringify(mode)}, audit=${JSON.stringify(audit)}, args=process.argv.slice(2);
fs.appendFileSync(audit,JSON.stringify({args,envKeys:Object.keys(process.env).sort(),codexHome:process.env.CODEX_HOME,cwd:process.cwd()})+'\\n');
if(args[0]==='--version'){console.log('codex-cli 0.162.1');process.exit(0)}
if(args[0]==='app-server'){
 const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;
 let result={};if(r.method==='config/read')result={config:{cli_auth_credentials_store:mode==='keyring'?'keyring':'file'}};
 if(r.method==='account/read')result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:mode==='principal-drift'&&path.basename(process.env.CODEX_HOME)==='codex'?'different@example.invalid':'fixture@example.invalid',planType:'pro'}};
 console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});
}else{
 let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 if(mode==='timeout')return setInterval(()=>{},1000);
 const raw=args.find(a=>a.startsWith('permissions.review.filesystem=')).slice('permissions.review.filesystem='.length);
 const scopes=JSON.parse(raw.replace(/("(?:[^"\\\\]|\\\\.)*")=/g,'$1:'));
 const entries=Object.entries(scopes).map(([p,a])=>p===':minimal'?'FileSystemSandboxEntry { path: Special { value: Minimal }, access: '+a[0].toUpperCase()+a.slice(1)+', missing_path_behavior: None }':(p==='/dev/tty*'||p==='/dev/ptmx*')?'FileSystemSandboxEntry { path: GlobPattern { pattern: '+JSON.stringify(p)+' }, access: '+a[0].toUpperCase()+a.slice(1)+', missing_path_behavior: None }':'FileSystemSandboxEntry { path: Path { path: PathUri(Url { scheme: "file", cannot_be_a_base: false, username: "", password: None, host: None, port: None, path: '+JSON.stringify(p)+', query: None, fragment: None }) }, access: '+a[0].toUpperCase()+a.slice(1)+', missing_path_behavior: None }');
 const model=args[args.indexOf('-m')+1];
 process.stderr.write('2026-10-15T11:09:08.667394Z  INFO codex.exec{otel.kind="internal"}: codex_exec: Codex initialized with event: SessionConfiguredEvent { model: '+JSON.stringify(model)+', model_provider_id: "openai", approval_policy: Never, reasoning_effort: Some(High), permission_profile: Managed { file_system: Restricted { entries: ['+entries.join(', ')+'], glob_scan_max_depth: None }, network: Restricted }, active_permission_profile: Some(ActivePermissionProfile { id: "review", extends: None }), cwd: AbsolutePathBuf('+JSON.stringify(process.cwd())+') }\\n');
 if(mode==='alias-materialize'){fs.unlinkSync(path.join(process.env.CODEX_HOME,'auth.json'));fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'DUMMY_MATERIALIZATION')}
 process.stdout.write(${JSON.stringify(jsonl(events))});
 if(mode==='truncated')process.stdout.write('{"type":');
 process.exitCode=mode==='failed-process'?1:0;
 });
}
`;
}

test("runner verifies metadata principal, completed process and alias custody with dummy executables", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await candidate(); t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await runDisposableProof({
    candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(),
    proof: async (derivative) => {
      for (const name of ["original", "checkout", "scratch", "common", "toolchain"]) await mkdir(derivative.resolve(name));
      await derivative.mutate("original/auth.json", "DUMMY_AUTH_NEVER_READ", "dummy canonical credential object");
      await chmod(derivative.resolve("original/auth.json"), 0o600);
      const record = { slug: "gpt-6-astra" }, recordSha256 = createHash("sha256").update(JSON.stringify(record)).digest("hex");
      await derivative.mutate("original/models_cache.json", JSON.stringify({ models: [record] }), "dummy model metadata fixture");
      const audit = derivative.resolve("audit.jsonl");
      for (const mode of ["good", "catalog-drift", "keyring", "principal-drift", "failed-process", "truncated", "alias-materialize", "timeout"]) {
        await derivative.mutate("fake-codex", fakeNative(mode, audit), `scripted ${mode} native process control`);
        await chmod(derivative.resolve("fake-codex"), 0o700);
        const options = { executable: derivative.resolve("fake-codex"), model: "gpt-6-astra", instructions: "trusted fixture", packet: "unchanged user packet", canonicalCodexHome: derivative.resolve("original"), modelCatalog: { path: derivative.resolve("original/models_cache.json"), recordSha256: mode === "catalog-drift" ? "0".repeat(64) : recordSha256 }, checkout: derivative.resolve("checkout"), scratch: derivative.resolve("scratch"), commonGitDirectory: derivative.resolve("common"), toolchainRoots: [derivative.resolve("toolchain")], timeoutMs: mode === "timeout" ? 1000 : 5000 };
        if (mode === "good") {
          const result = await runNativeCodexReview(options);
          assert.equal(result.text, events[2]!.item!.text);
          assert.equal(result.executor.modelCatalogSha256, recordSha256);
        } else await assert.rejects(runNativeCodexReview(options), Error, mode);
        assert.equal(await readFile(derivative.resolve("original/auth.json"), "utf8"), "DUMMY_AUTH_NEVER_READ");
      }
      const auditRows = (await readFile(audit, "utf8")).trim().split("\n").map((row) => JSON.parse(row) as { codexHome: string; envKeys: string[] });
      for (const row of auditRows) {
        assert.deepEqual(row.envKeys.filter((key) => key !== "__CF_USER_TEXT_ENCODING"), ["CODEX_HOME", "HOME", "PATH", "RUST_LOG"]);
        if (row.codexHome !== await realpath(derivative.resolve("original"))) await assert.rejects(readdir(row.codexHome), /ENOENT/);
      }
      return true;
    },
  });
  assert.equal(requireProven(receipt), true);
});
