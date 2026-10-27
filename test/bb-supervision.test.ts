import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launcher = fileURLToPath(new URL('../../scripts/bb-supervise.mjs', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rhiz-bb-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '--allow-empty', '-qm', 'fixture']);
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const contract = join(root, 'contract.json');
  const verify = join(root, 'verify.json');
  writeFileSync(contract, JSON.stringify({ id: 'work:bb-fixture' }));
  writeFileSync(verify, '{}');
  return { root, repo, base, contract, verify };
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8' });
}
test('launcher refuses unauthorized verbs, flags and implicit base', () => {
  const f = fixture();
  try {
    for (const args of [
      ['accept', '--repo', f.repo],
      ['resume', '--repo', f.repo],
      ['start', '--repo', f.repo, '--contract', f.contract, '--verify', f.verify],
      ['status', '--repo', f.repo, '--permit', 'full'],
      ['status', '--repo', f.repo, '--work-id', '../escape'],
      ['status', '--repo', f.repo, '--repo', f.repo],
    ]) {
      const result = run(...args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /bb supervision refused:/);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('dry run produces a pinned shell-free plan without Ledger mutation', () => {
  const f = fixture();
  try {
    const result = run('start', '--repo', f.repo, '--contract', f.contract,
      '--verify', f.verify, '--base', f.base, '--correlation-id', 'bb:fixture', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schema, 'rhiz/bb-launch-plan/v1');
    assert.equal(plan.executes, false);
    assert.equal(plan.workId, 'work:bb-fixture');
    assert.equal(plan.command, 'npm');
    assert.deepEqual(plan.args.slice(0, 4), ['run', 'operator', '--', 'start']);
    assert.deepEqual(plan.args.slice(-4), ['--base', f.base, '--correlation-id', 'bb:fixture']);
    assert.match(plan.inputDigests.contract, /^[a-f0-9]{64}$/);
    assert.equal(execFileSync('git', ['-C', f.repo, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('status routes to Board operator without an acceptance path', () => {
  const f = fixture();
  try {
    const result = run('status', '--repo', f.repo, '--work-id', 'work:bb-fixture', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(plan.args.slice(0, 5), ['run', 'operator', '--', 'status', 'work:bb-fixture']);
    assert.equal(plan.args.includes('accept'), false);
    assert.equal(plan.args.includes('resume'), false);
    assert.notEqual(run('status', '--repo', f.repo, '--contract', f.contract, '--dry-run').status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('symlinked inputs and changed base are refused before spawn', () => {
  const f = fixture();
  try {
    const linked = join(f.root, 'linked.json');
    symlinkSync(f.contract, linked);
    for (const [contract, base] of ([[linked, f.base], [f.contract, 'a'.repeat(40)]] as [string, string][])) {
      const result = run('start', '--repo', f.repo, '--contract', contract,
        '--verify', f.verify, '--base', base, '--dry-run');
      assert.notEqual(result.status, 0);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
