#!/usr/bin/env node
// The operator loop over repository Work: start, status, resume, review, accept.
//
// Every fact printed here is read from the Work's durable Ledger. The only
// state this script keeps of its own is the operator inputs it needs to run
// the same Work again (contract, verification plan, preparation, pinned base)
// and the last run receipt, under <git-common-dir>/rhiz-harness/operator/.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { harnessGitRefSegment } from "../dist/adapters/git/index.js";
import { DurableEventLedger } from "../dist/adapters/local/durable-ledger.js";
import { readRepositoryWorkLedgers } from "../dist/adapters/local/work-ledgers.js";
import {
  acceptOperatorWork,
  recordOperatorReview,
  summarizeOperatorWork,
  summarizeOperatorWorks,
} from "../dist/src/operator.js";
import { RefinerBridge } from "../dist/src/refiner-bridge.js";
import { streamIdForWork } from "../dist/src/refiner.js";
import { parseWorkContract } from "../dist/src/schemas.js";

const RUNNER = fileURLToPath(new URL("./run-repository-work.mjs", import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_REVIEW_DIFF_BYTES = 200_000;

function usage() {
  return [
    "Usage: rhiz-harness <command> [work] [options]",
    "",
    "  start  --contract <work.json> --verify <plan.json> [--prepare <prepare.json>] [--base <rev>]",
    "         run SHIP Work in an isolated worktree until it is verified or its budget is spent",
    "  status [work]                 what every Work is doing and what it needs next",
    "  resume [work]                 continue non-terminal Work in its existing Ledger",
    "  review [work] [--reviewer claude|command] [--reviewer-command <path>] [--model <id>]",
    "         independent review of the verified candidate diff, recorded on the Board",
    "  accept [work] --reason <why>  the Board decision; hands the outcome to Router and Refiner",
    "",
    "Common options: --repo <path> (default: current directory), --json",
    "[work] is a Work id or a unique prefix. With no [work], resume, review, and accept",
    "act on the most recently active Work that needs that action.",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const values = {};
  for (let i = 0; i < rest.length; i += 1) {
    const value = rest[i];
    if (value === "--json") { values.json = true; continue; }
    if (value === "--help" || value === "-h") { values.help = true; continue; }
    if (value.startsWith("--")) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`missing value for ${value}`);
      values[value.slice(2)] = next;
      i += 1;
      continue;
    }
    positional.push(value);
  }
  if (positional.length > 1) throw new Error(`unexpected argument ${positional[1]}`);
  return { command, work: positional[0], values };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER }).trim();
}

function repository(values) {
  const root = git(resolve(values.repo ?? "."), ["rev-parse", "--show-toplevel"]);
  const commonDir = resolve(root, git(root, ["rev-parse", "--git-common-dir"]));
  return { root, commonDir, operatorRoot: join(commonDir, "rhiz-harness", "operator") };
}

function operatorDir(repo, workId) {
  return join(repo.operatorRoot, harnessGitRefSegment(workId));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Actual spend a reviewer reported, from the review receipts this CLI wrote.
// Router cost on the Board is an estimate; this is a measurement.
async function reviewerSpend(repo, workId) {
  const directory = join(operatorDir(repo, workId), "reviews");
  let names = [];
  try { names = await readdir(directory); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  let total = 0;
  const unreadable = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    try {
      const record = await readJson(join(directory, name));
      if (typeof record.costUsd === "number") total += record.costUsd;
    } catch (error) {
      // One bad receipt must not hide every Work; it is reported, not counted.
      unreadable.push({ path: join(directory, name), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { total, unreadable };
}

async function loadWorks(repo) {
  const { ledgers, unreadable } = await readRepositoryWorkLedgers(repo.commonDir);
  const works = [];
  const unreadableReceipts = [];
  for (const ledger of ledgers) {
    for (const workId of ledger.workIds) {
      const events = ledger.events.filter((event) => event.workId === workId && event.streamId === streamIdForWork(workId));
      if (events.length === 0) continue;
      const status = summarizeOperatorWork(events);
      const spend = await reviewerSpend(repo, workId);
      const reviewerCostUsd = spend.total;
      unreadableReceipts.push(...spend.unreadable);
      const lastEventAt = events.reduce((latest, event) => (event.occurredAt > latest ? event.occurredAt : latest), "");
      works.push({ status, reviewerCostUsd, ledgerDirectory: ledger.directory, lastEventAt });
    }
  }
  works.sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
  return { works, unreadable, unreadableReceipts };
}

function pickWork(works, query, wanted) {
  if (query !== undefined) {
    const exact = works.filter((item) => item.status.workId === query);
    const matches = exact.length > 0 ? exact : works.filter((item) => item.status.workId.startsWith(query));
    if (matches.length === 0) throw new Error(`no Work matches ${query}`);
    if (matches.length > 1) throw new Error(`${query} matches ${matches.length} Work items: ${matches.map((item) => item.status.workId).join(", ")}`);
    return matches[0];
  }
  const candidate = works.find((item) => item.status.nextAction === wanted);
  if (!candidate) throw new Error(`no Work currently needs ${wanted}`);
  return candidate;
}

function human(repo) {
  const read = (key) => {
    try { return git(repo.root, ["config", key]); } catch { return ""; }
  };
  const email = read("user.email");
  if (!email) throw new Error("git config user.email is not set; acceptance must name the person deciding");
  const name = read("user.name");
  return { id: `human:${email}`.slice(0, 200), kind: "human", ...(name ? { displayName: name.slice(0, 200) } : {}) };
}

function requireCommit(repo, head) {
  try {
    git(repo.root, ["cat-file", "-e", `${head}^{commit}`]);
  } catch {
    throw new Error(`verified head ${head} is not in this repository; fetch it before deciding on it`);
  }
}

function money(value) {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function printStatus(status, reviewerCostUsd = 0) {
  const lines = [
    `${status.workId}  ${status.state}  next: ${status.nextAction}  (${status.nextActionReason})`,
    `  attempts ${status.attempts.total}${status.attempts.budget === null ? "" : `/${status.attempts.budget}`}` +
      `  failed ${status.attempts.failed}  verification ${status.verification.latest ?? "none"}` +
      `  review ${status.review.latest ?? (status.review.required ? "required" : "none")}`,
    `  outcome ${status.metrics.outcome}  recovered ${status.metrics.recovered ? "yes" : "no"}` +
      `  decisions ${status.metrics.humanDecisions}  interventions ${status.metrics.humanInterventions}` +
      `  est. cost ${money(status.metrics.estimatedCostUsd)}  reviewer spend ${money(reviewerCostUsd)}` +
      `  elapsed ${Math.round(status.metrics.elapsedMs / 1000)}s`,
  ];
  if (status.violations > 0) lines.push(`  Board violations ${status.violations}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function runRunner(args, receiptPath, logPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args, "--output", receiptPath], {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    const log = createWriteStream(logPath, { flags: "a" });
    child.stderr.on("data", (chunk) => {
      log.write(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      log.end();
      resolvePromise({ code, signal });
    });
  });
}

async function runAndReport(repo, workId, runnerArgs, values) {
  const dir = operatorDir(repo, workId);
  const receiptPath = join(dir, "receipt.json");
  const { code, signal } = await runRunner(runnerArgs, receiptPath, join(dir, "runner.log"));
  const receipt = await readJsonIfPresent(receiptPath);
  const { works } = await loadWorks(repo);
  const work = works.find((item) => item.status.workId === workId);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ exitCode: code, signal, receipt, status: work?.status ?? null }, null, 2)}\n`);
  } else {
    if (work) printStatus(work.status);
    if (receipt?.candidate?.head) process.stdout.write(`  candidate ${receipt.candidate.head}  ${receipt.candidate.verifiedRef ?? ""}\n`);
    if (code !== 0) process.stdout.write(`  runner exited ${code ?? signal}; see ${join(dir, "runner.log")}\n`);
  }
  return code === 0 ? 0 : 1;
}

async function start(repo, values) {
  for (const required of ["contract", "verify"]) {
    if (!values[required]) throw new Error(`start needs --${required}`);
  }
  const contract = parseWorkContract(await readJson(resolve(values.contract)));
  const dir = operatorDir(repo, contract.id);
  if (await readJsonIfPresent(join(dir, "inputs.json"))) {
    throw new Error(`Work ${contract.id} was already started; use resume, or give new Work a new id`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const base = git(repo.root, ["rev-parse", `${values.base ?? "HEAD"}^{commit}`]);
  await copyFile(resolve(values.contract), join(dir, "contract.json"));
  await copyFile(resolve(values.verify), join(dir, "verify.json"));
  if (values.prepare) await copyFile(resolve(values.prepare), join(dir, "prepare.json"));
  await writeFile(join(dir, "inputs.json"), `${JSON.stringify({
    schema: "rhiz/operator-inputs/v1",
    workId: contract.id,
    base,
    prepare: Boolean(values.prepare),
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  return runAndReport(repo, contract.id, runnerArgsFor(repo, dir, base, Boolean(values.prepare)), values);
}

function runnerArgsFor(repo, dir, base, prepare) {
  return [
    "--repo", repo.root,
    "--contract", join(dir, "contract.json"),
    "--verify", join(dir, "verify.json"),
    "--base", base,
    ...(prepare ? ["--prepare", join(dir, "prepare.json")] : []),
  ];
}

async function resume(repo, query, values) {
  const { works } = await loadWorks(repo);
  const work = pickWork(works, query, "resume");
  if (work.status.nextAction !== "resume") {
    throw new Error(`Work ${work.status.workId} does not need resume: ${work.status.nextActionReason}`);
  }
  const dir = operatorDir(repo, work.status.workId);
  const inputs = await readJsonIfPresent(join(dir, "inputs.json"));
  if (!inputs) throw new Error(`Work ${work.status.workId} was not started by rhiz-harness; its inputs are unknown`);
  return runAndReport(repo, work.status.workId, [...runnerArgsFor(repo, dir, inputs.base, inputs.prepare), "--resume", "true"], values);
}

async function status(repo, query, values) {
  const { works, unreadable, unreadableReceipts } = await loadWorks(repo);
  const selected = query === undefined ? works : [pickWork(works, query)];
  const digest = {
    ...summarizeOperatorWorks(selected.map((item) => item.status)),
    reviewerCostUsd: selected.reduce((total, item) => total + item.reviewerCostUsd, 0),
  };
  if (values.json) {
    process.stdout.write(`${JSON.stringify({
      schema: "rhiz/operator-status/v1",
      digest,
      works: selected.map((item) => ({ ...item.status, reviewerCostUsd: item.reviewerCostUsd })),
      unreadable,
      unreadableReviewReceipts: unreadableReceipts,
    }, null, 2)}\n`);
    return unreadable.length + unreadableReceipts.length > 0 ? 2 : 0;
  }
  if (selected.length === 0) process.stdout.write("no Work in this repository yet\n");
  for (const item of selected) printStatus(item.status, item.reviewerCostUsd);
  const perOutcome = digest.interventionsPerAcceptedOutcome;
  process.stdout.write(
    `\n${digest.works} Work  ${digest.accepted} accepted  ${digest.rejected} rejected  ${digest.open} open` +
    `  ${digest.readyToAccept} ready to accept  ${digest.recovered} recovered` +
    `  interventions/accepted ${perOutcome === null ? "n/a" : perOutcome.toFixed(2)}` +
    `  decisions/accepted ${digest.decisionsPerAcceptedOutcome === null ? "n/a" : digest.decisionsPerAcceptedOutcome.toFixed(2)}` +
    `  reviewer spend ${money(digest.reviewerCostUsd)}\n`,
  );
  for (const item of unreadable) process.stdout.write(`UNREADABLE Ledger ${item.directory}: ${item.error}\n`);
  for (const item of unreadableReceipts) process.stdout.write(`UNREADABLE review receipt ${item.path}: ${item.error}\n`);
  return unreadable.length + unreadableReceipts.length > 0 ? 2 : 0;
}

// The Ledger the Work was discovered in is the one written to. A receipt is
// an operator file and never chooses where a Board decision lands.
async function withLedger(work, action) {
  const ledger = await DurableEventLedger.open({
    directory: work.ledgerDirectory,
    ledgerId: `ledger:${work.status.workId}`.slice(0, 200),
  });
  try {
    return await action(ledger);
  } finally {
    await ledger.close();
  }
}

function reviewPrompt(contract, diff, truncated) {
  return [
    "You are an independent code reviewer. You did not write this change.",
    "Judge only whether the diff accomplishes the objective within its write scope, meets every",
    "required acceptance criterion, and introduces no defect. Report only defects you can point to.",
    "",
    `Objective: ${contract.objective}`,
    `Acceptance criteria:\n${contract.acceptanceCriteria.map((item) => `- ${item.id}${item.required ? " (required)" : ""}: ${item.description}`).join("\n")}`,
    `Non-goals:\n${contract.nonGoals.map((item) => `- ${item}`).join("\n") || "- none"}`,
    "",
    `Diff${truncated ? " (truncated)" : ""}:`,
    "```diff",
    diff,
    "```",
    "",
    'Answer with only one JSON object: {"status":"pass"|"fail","summary":"<one paragraph>",',
    '"findings":[{"severity":"info"|"low"|"medium"|"high"|"critical","summary":"<file:line and defect>"}]}',
  ].join("\n");
}

function extractVerdict(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("reviewer returned no JSON verdict");
  const verdict = JSON.parse(text.slice(start, end + 1));
  if (verdict.status !== "pass" && verdict.status !== "fail") throw new Error("reviewer verdict has no pass/fail status");
  if (typeof verdict.summary !== "string" || verdict.summary.trim().length === 0) throw new Error("reviewer verdict has no summary");
  const severities = new Set(["info", "low", "medium", "high", "critical"]);
  const findings = Array.isArray(verdict.findings)
    ? verdict.findings.filter((item) => severities.has(item?.severity) && typeof item?.summary === "string" && item.summary.trim())
    : [];
  return { status: verdict.status, summary: verdict.summary.trim(), findings };
}

function runReviewer(values, prompt, cwd) {
  if (values.reviewer === "command" || values["reviewer-command"]) {
    const command = values["reviewer-command"];
    if (!command) throw new Error("--reviewer command needs --reviewer-command <path>");
    const output = execFileSync(resolve(command), [], { cwd, input: prompt, encoding: "utf8", maxBuffer: MAX_BUFFER });
    return { verdict: extractVerdict(output), reviewer: { id: `reviewer:command:${resolve(command)}`.slice(0, 200), kind: "verifier" }, costUsd: null, model: null };
  }
  if ((values.reviewer ?? "claude") !== "claude") throw new Error(`unknown reviewer ${values.reviewer}`);
  const args = ["-p", "--output-format", "json", "--permission-mode", "plan", ...(values.model ? ["--model", values.model] : [])];
  const raw = execFileSync(process.env.RHIZ_CLAUDE_COMMAND || "claude", args, { cwd, input: prompt, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: 15 * 60 * 1000 });
  const envelope = JSON.parse(raw);
  if (envelope.is_error) throw new Error(`reviewer failed: ${String(envelope.result ?? "unknown error").slice(0, 500)}`);
  return {
    verdict: extractVerdict(String(envelope.result ?? "")),
    reviewer: { id: "reviewer:claude-code", kind: "verifier", displayName: "Claude Code reviewer" },
    costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
    model: values.model ?? null,
  };
}

async function review(repo, query, values) {
  const { works } = await loadWorks(repo);
  const work = pickWork(works, query, "review");
  const workId = work.status.workId;
  const dir = operatorDir(repo, workId);
  const target = work.status.verifiedTarget;
  if (!target) throw new Error(`Work ${workId} has no verified integration head on its Board to review`);
  requireCommit(repo, target.head);
  const contract = parseWorkContract(await readJson(join(dir, "contract.json")));
  const fullDiff = git(repo.root, ["diff", "--no-ext-diff", `${target.base}..${target.head}`]);
  const truncated = Buffer.byteLength(fullDiff) > MAX_REVIEW_DIFF_BYTES;
  const diff = truncated ? fullDiff.slice(0, MAX_REVIEW_DIFF_BYTES) : fullDiff;
  const startedAt = Date.now();
  const result = runReviewer(values, reviewPrompt(contract, diff, truncated), repo.root);
  const status = await withLedger(work, (ledger) => recordOperatorReview({
    ledger,
    streamId: work.status.streamId,
    reviewer: result.reviewer,
    status: result.verdict.status,
    summary: result.verdict.summary,
    findings: result.verdict.findings,
    evidence: [{ id: `diff:${target.head}`.slice(0, 200), kind: "diff", digest: `git:${target.base}..${target.head}` }],
  }));
  const record = {
    schema: "rhiz/operator-review/v1",
    workId,
    candidateHead: target.head,
    reviewer: result.reviewer,
    model: result.model,
    costUsd: result.costUsd,
    durationMs: Date.now() - startedAt,
    diffTruncated: truncated,
    verdict: result.verdict,
  };
  await mkdir(join(dir, "reviews"), { recursive: true });
  await writeFile(join(dir, "reviews", `${new Date().toISOString().replaceAll(":", "-")}.json`), `${JSON.stringify(record, null, 2)}\n`);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ review: record, status }, null, 2)}\n`);
  } else {
    process.stdout.write(`review ${result.verdict.status}  ${result.verdict.summary}\n`);
    for (const finding of result.verdict.findings) process.stdout.write(`  ${finding.severity}  ${finding.summary}\n`);
    if (result.costUsd !== null) process.stdout.write(`  reviewer cost ${money(result.costUsd)}\n`);
    printStatus(status);
  }
  return result.verdict.status === "pass" ? 0 : 1;
}

async function accept(repo, query, values) {
  if (!values.reason) throw new Error("accept needs --reason <why this outcome is accepted>");
  const actor = human(repo);
  const { works } = await loadWorks(repo);
  const work = pickWork(works, query, "accept");
  const workId = work.status.workId;
  const target = work.status.verifiedTarget;
  const result = await withLedger(work, (ledger) => acceptOperatorWork({
    ledger,
    streamId: work.status.streamId,
    actor,
    reason: values.reason,
    refiner: new RefinerBridge({ ledger }),
    evidence: target
      ? [{ id: `commit:${target.head}`.slice(0, 200), kind: "artifact-identity", digest: `git:${target.head}` }]
      : [],
    // The Board's integration head proof names what was verified. Acceptance
    // re-checks that exact commit still exists before anything is written.
    confirmTarget: async (board) => {
      const proof = board.integration?.headProof;
      if (!proof) throw new Error(`Work ${workId} has no verified integration head; nothing to accept`);
      requireCommit(repo, proof.head);
    },
  }));
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`accepted  ${workId}  by ${actor.id}\n`);
  printStatus(result.status);
  const analysis = result.learning.analysis;
  if (analysis) process.stdout.write(`  learned  ${analysis.classifications.join(", ") || "nothing new"}\n`);
  for (const proposal of result.learning.proposals) process.stdout.write(`  proposal ${proposal.kind}: ${proposal.title}\n`);
  for (const evidence of result.learning.routerEvidence) {
    process.stdout.write(`  router   ${evidence.workerId} credited ${evidence.successCount}/${evidence.attemptCount}\n`);
  }
  return 0;
}

async function main() {
  const { command, work, values } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || values.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const repo = repository(values);
  switch (command) {
    case "start": return start(repo, values);
    case "status": return status(repo, work, values);
    case "resume": return resume(repo, work, values);
    case "review": return review(repo, work, values);
    case "accept": return accept(repo, work, values);
    default: throw new Error(`unknown command ${command}\n\n${usage()}`);
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`rhiz-harness: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

