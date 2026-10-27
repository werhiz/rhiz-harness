#!/usr/bin/env node
// bb supervises the terminal/process; Rhiz governs Work and its evidence.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { open, readFile, lstat, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED = new Set(['--repo', '--contract', '--verify', '--base', '--prepare', '--local-config', '--correlation-id', '--bb-thread-id', '--bb-terminal-id', '--work-id', '--dry-run', '--help']);
const INPUT_KEYS = ['contract', 'verify', 'prepare', 'local-config'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;

function usage() {
  return [
    'Usage: node scripts/bb-supervise.mjs start --repo <repo> --contract <work.json> --verify <plan.json> --base <40-char SHA> [options]',
    '       node scripts/bb-supervise.mjs status --repo <repo> [--work-id <id>] [options]',
    'Options: --prepare <json>, --local-config <json>, --correlation-id <id>,',
    '         --bb-thread-id <opaque id>, --bb-terminal-id <opaque id>, --dry-run',
    'Only start/status are available. No retries, approvals, acceptance, or bb worker authority.',
  ].join('\n');
}

function parse(argv) {
  const [action, ...rest] = argv;
  if (action === '--help' || action === '-h') return { help: true };
  if (!['start', 'status'].includes(action)) throw Error('Expected start or status');
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!ALLOWED.has(key)) throw Error(`Unsupported option ${key}`);
    const k = key.slice(2);
    if (opts[k] !== undefined) throw Error(`Duplicate option ${key}`);
    if (['dry-run', 'help'].includes(k)) { opts[k] = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`);
    opts[k] = value;
  }
  if (opts.help) return { help: true };
  if (!opts.repo) throw Error('--repo is required');
  if (action === 'start') {
    for (const required of ['contract', 'verify', 'base']) {
      if (!opts[required]) throw Error(`--${required} is required for start`);
    }
    if (!SHA.test(opts.base)) throw Error('--base must be a pinned 40-character lowercase commit SHA');
    if (opts['work-id']) throw Error('--work-id is only valid for status');
  } else {
    for (const k of ['contract', 'verify', 'prepare', 'local-config', 'base', 'correlation-id']) {
      if (opts[k] !== undefined) throw Error(`--${k} is only valid for start`);
    }
  }
  for (const k of ['correlation-id', 'bb-thread-id', 'bb-terminal-id', 'work-id']) {
    if (opts[k] !== undefined && !ID.test(opts[k])) throw Error(`Invalid ${k}: identifier must be <=128 safe characters`);
  }
  return { action, opts };
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function regularJson(path) {
  // Open once without following symlinks. Validate and snapshot exactly the bytes
  // read from that descriptor, even if the original pathname is later replaced.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 || stat.nlink !== 1) {
      throw Error(`${basename(path)} must be a single-linked regular input file of at most 1 MiB`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > 1024 * 1024) throw Error(`${basename(path)} exceeds the 1 MiB input bound`);
    JSON.parse(bytes.toString('utf8'));
    return bytes;
  } finally { await handle.close(); }
}

async function privateSnapshotDirectory(commonDir) {
  const ownerRoot = join(commonDir, 'rhiz-harness', 'bb-launch-inputs');
  await mkdir(ownerRoot, { recursive: true, mode: 0o700 });
  const stat = await lstat(ownerRoot);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw Error('bb launch input root must be a private owner-controlled directory');
  }
  return mkdtemp(join(ownerRoot, 'launch-'));
}
async function plan(action, opts) {
  const root = git(resolve(opts.repo), ['rev-parse', '--show-toplevel']);
  const commonDir = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  const argv = ['run', 'operator', '--', action, '--repo', root, '--json'];
  let workId = opts['work-id'] ?? null;
  let inputDigest = null;
  if (action === 'start') {
    if (git(root, ['rev-parse', '--verify', `${opts.base}^{commit}`]) !== opts.base) {
      throw Error('Pinned base does not resolve to supplied commit');
    }
    const files = {};
    for (const key of INPUT_KEYS) {
      if (opts[key] !== undefined) {
        const file = resolve(opts[key]);
        const bytes = await regularJson(file);
        files[key] = { path: file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
    }
    // Derive the identity from the same descriptor-backed bytes we will hand off.
    const contract = JSON.parse(files.contract.bytes.toString('utf8'));
    if (typeof contract?.id !== 'string' || !contract.id.startsWith('work:')) {
      throw Error('Contract requires a Work id; full schema is validated by operator');
    }
    workId = contract.id;
    inputDigest = Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.sha256]));
    let snapshotDir = null;
    try {
      // Dry-run is side-effect free. A real launch delegates *only* private
      // read-only snapshots, never the original mutable user input paths.
      if (!opts['dry-run']) {
        snapshotDir = await privateSnapshotDirectory(commonDir);
        for (const key of INPUT_KEYS) {
          if (files[key]) {
            const pathname = join(snapshotDir, `${key}.json`);
            await writeFile(pathname, files[key].bytes, { mode: 0o400, flag: 'wx' });
            const actual = createHash('sha256').update(await readFile(pathname)).digest('hex');
            if (actual !== files[key].sha256) throw Error('bb snapshot digest mismatch before launch');
            files[key].delegatedPath = pathname;
          }
        }
      }
      for (const key of INPUT_KEYS) {
        if (files[key]) argv.push(`--${key}`, files[key].delegatedPath ?? files[key].path);
      }
    } catch (error) {
      if (snapshotDir !== null) await rm(snapshotDir, { recursive: true, force: true });
      throw error;
    }
    argv.push('--base', opts.base);
    if (opts['correlation-id']) argv.push('--correlation-id', opts['correlation-id']);
  } else if (workId) {
    argv.splice(4, 0, workId);
  }
  return { command: 'npm', args: argv, cwd: HARNESS_ROOT, repositoryRoot: root, commonDir, workId, inputDigest };
}

async function recordObservation(p, opts, startedAt, startMs, result) {
  const dir = join(p.commonDir, 'rhiz-harness', 'bb-observations');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  const temp = `${path}.tmp`;
  const record = {
    schema: 'rhiz/bb-process-observation/v1',
    source: 'bb-terminal-supervision',
    authority: 'diagnostic-only',
    workId: p.workId,
    repositoryRoot: p.repositoryRoot,
    correlationId: opts['correlation-id'] ?? null,
    bbThreadId: opts['bb-thread-id'] ?? null,
    bbTerminalId: opts['bb-terminal-id'] ?? null,
    inputDigests: p.inputDigest,
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startMs,
    processExitCode: result.code,
    signal: result.signal,
  };
  try {
    await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
  return path;
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  if (parsed.help) { console.log(usage()); return; }
  const { action, opts } = parsed;
  const p = await plan(action, opts);
  if (opts['dry-run']) {
    console.log(JSON.stringify({ schema: 'rhiz/bb-launch-plan/v1', action, command: p.command,
      args: p.args, cwd: p.cwd, workId: p.workId, inputDigests: p.inputDigest, executes: false }, null, 2));
    return;
  }
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const child = spawn(p.command, p.args, {
    cwd: p.cwd, stdio: 'inherit', shell: false, detached: process.platform !== 'win32',
  });
  const forward = (signal) => {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
      else if (child.pid) child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
  };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const result = await new Promise((done) => {
    child.once('error', (error) => { console.error(`Unable to start operator: ${error.message}`); done({ code: null, signal: 'spawn-error' }); });
    child.once('close', (code, signal) => done({ code, signal }));
  });
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  try {
    const location = await recordObservation(p, opts, startedAt, startMs, result);
    console.error(`bb diagnostic observation: ${location} (not a verification or acceptance receipt)`);
  } catch (error) {
    console.error(`Unable to preserve bb diagnostic observation: ${error.message}`);
    process.exitCode = 1;
  }
  if (result.code !== 0) process.exitCode = process.exitCode || (result.code ?? 1);
}
main().catch((error) => { console.error(`bb supervision refused: ${error.message}`); process.exitCode = 1; });
