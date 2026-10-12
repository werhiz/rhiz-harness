#!/usr/bin/env node
/**
 * The integration horizon, as an operator command.
 *
 * This is the only surface a consuming repository touches. Hooks shell out to
 * it and hold no thresholds of their own, so the number has exactly one owner.
 *
 * Exit codes are the contract (ADR 0023):
 *   0  measured; clear or grandfathered
 *   1  measured; tripped, with reasons
 *   2  could not establish the facts safely
 *
 * The third state exists so a sensor failure is never mistaken for a policy
 * verdict. A consuming repository is expected to fail closed on 2 where it
 * blocks work, and to warn on 2 where it must never block.
 *
 * Usage:
 *   node scripts/horizon.mjs check [--repo <path>] [--branch <name>] [--integration-ref <ref>] [--json]
 *   node scripts/horizon.mjs census [--repo <path>] [--integration-ref <ref>] [--json]
 *   node scripts/horizon.mjs baseline freeze [--repo <path>] [--integration-ref <ref>]
 *   node scripts/horizon.mjs converge [--repo <path>] [--branch <name>] [--durability-only] [--dry-run]
 *   node scripts/horizon.mjs converge --review-receipt <exact-head-NOT-READY-comment-url> [--repo <path>] [--branch <name>] [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, copyFileSync, realpathSync, openSync, closeSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readRepositoryWorkLedgers } from "../dist/adapters/local/work-ledgers.js";
import { projectBoard, executionActorIds, acceptanceReadiness } from "../dist/src/board.js";
import { parseWorkContract, parseHarnessEvent } from "../dist/src/schemas.js";
import { DurableEventLedger } from "../dist/adapters/local/durable-ledger.js";
import { TempDirectoryDerivativeFactory } from "../dist/src/disposable.js";
import { digestExecutionRoot } from "../dist/src/workspace-digest.js";
import { pushHarnessCheckpoint, harnessGitRefSegment } from "../dist/adapters/git/checkpoints.js";
import { HARDENED_GIT_FLAGS, hardenedGitEnv } from "../dist/adapters/git/worktrees.js";

import {
  baselineFromSignals,
  currentBranch,
  driftedBranches,
  measureBranchDrift,
} from "../dist/adapters/git/drift.js";
import {
  CALIBRATED_INTEGRATION_HORIZON,
  HORIZON_THRESHOLDS,
  convergenceEffectRefusals,
  horizonReviewMayApply,
  decideHorizon,
  ratchetBaseline,
  ratchetReviewAnchor,
} from "../dist/src/horizon.js";

const EXIT_CLEAR = 0;
const EXIT_TRIPPED = 1;
const EXIT_UNAVAILABLE = 2;

const BASELINE_FILE = ".rhiz-horizon-baseline.json";
const REVIEW_FILE = ".rhiz-horizon-reviews.json";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

const flag = (name) => process.argv.includes(`--${name}`);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

function baselinePath(repo) {
  return join(repo, BASELINE_FILE);
}

function readBaselines(repo) {
  const path = baselinePath(repo);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed.branches ?? {};
  } catch {
    return {};
  }
}

function describe(decision) {
  if (decision.kind === "clear") return "clear";
  if (decision.kind === "grandfathered") return "grandfathered";
  if (decision.kind === "in_review") return `in review (diffLines limit ${decision.limit}, anchored at ${decision.anchorDiffLines})`;
  return decision.reasons.map((reason) => `${reason.signal} ${reason.observed} >= ${reason.limit}`).join("; ");
}

function readReviews(repo) {
  const path = join(repo, REVIEW_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")).reviews ?? {};
  } catch {
    return {};
  }
}

function writeReviews(repo, reviews) {
  const payload = {
    $comment: "Review anchors: a change's size when first observed under open review. Falls only. See ADR 0024.",
    reviews,
  };
  writeFileSync(join(repo, REVIEW_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * The host half of ADR 0024: is this branch a change under open review, and
 * what was its size when review began? The forge is asked, never assumed; any
 * failure to ask means no allowance, so the branch simply stays tripped.
 */
function reviewFor(repo, branch, signals) {
  if (signals.upstreamState !== "pushed") return { review: undefined, note: "not pushed" };
  let pr;
  try {
    pr = JSON.parse(
      execFileSync("gh", ["pr", "view", branch, "--json", "number,state,headRefOid,baseRefOid,url"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      }),
    );
  } catch {
    return { review: undefined, note: "no open review found for this branch (or the forge could not be asked)" };
  }
  if (pr.state !== "OPEN") return { review: undefined, note: `review #${pr.number} is ${pr.state}` };
  const upstream = tryGit(repo, ["rev-parse", `${branch}@{upstream}`]);
  const local = tryGit(repo, ["rev-parse", branch]);
  if (local === undefined || upstream === undefined || local !== upstream || upstream !== pr.headRefOid) {
    return { review: undefined, note: `review #${pr.number} is not at this branch's pushed head` };
  }
  const reviews = readReviews(repo);
  const stored = reviews[branch];
  const observed = { anchorDiffLines: signals.diffLines };
  const review =
    stored !== undefined && stored.change === pr.number
      ? ratchetReviewAnchor({ anchorDiffLines: stored.anchorDiffLines }, observed)
      : observed;
  if (stored?.change !== pr.number || stored.anchorDiffLines !== review.anchorDiffLines) {
    reviews[branch] = {
      change: pr.number,
      anchorDiffLines: review.anchorDiffLines,
      recordedAt: stored?.change === pr.number ? stored.recordedAt : new Date().toISOString(),
      ...(stored?.change === pr.number && stored.correctionReceipts ? { correctionReceipts: stored.correctionReceipts } : {}),
    };
    writeReviews(repo, reviews);
  }
  for (const receipt of [...(stored?.change === pr.number && Array.isArray(stored.correctionReceipts) ? stored.correctionReceipts : [])].reverse()) {
    try {
      if (!/^[a-f0-9]{40}$/.test(receipt.head) || !/^[a-f0-9]{40}$/.test(pr.baseRefOid)) continue;
      git(repo, ["merge-base", "--is-ancestor", receipt.head, local]);
      if (committedDiffLines(repo, pr.baseRefOid, receipt.head) !== receipt.anchorDiffLines) continue;
      const verified = reviewComment(repo, pr, receipt.commentUrl, receipt.head);
      if (verified.commentDigest !== receipt.commentDigest || verified.reviewerLogin !== receipt.reviewerLogin) continue;
      return { review: { anchorDiffLines: Math.max(review.anchorDiffLines, receipt.anchorDiffLines) }, note: `under review as #${pr.number}; correction receipt ${receipt.commentUrl}` };
    } catch { continue; }
  }
  return { review, note: `under review as #${pr.number}` };
}

function committedDiffLines(repo, base, head) {
  let lines = 0;
  const raw = git(repo, ["diff", "--numstat", `${base}...${head}`]);
  for (const row of raw ? raw.split("\n") : []) {
    const [added, removed] = row.split("\t").map(Number);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(removed) || added < 0 || removed < 0) throw new Error("receipt diff cannot be measured safely");
    lines += added + removed;
    if (!Number.isSafeInteger(lines)) throw new Error("receipt diff exceeds safe measurement");
  }
  return lines;
}

/** A forge comment supplies context, never source-effect or acceptance authority. */
function reviewComment(repo, pr, commentUrl, head, allowReadyContext = false) {
  const selected = new URL(commentUrl);
  const target = new URL(pr.url);
  const id = /^#issuecomment-(\d+)$/.exec(selected.hash)?.[1];
  if (!id || selected.origin !== target.origin || selected.pathname !== target.pathname || selected.search) throw new Error("receipt must belong to this exact pull request");
  const parts = target.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || parts[3] !== String(pr.number)) throw new Error("forge did not identify this pull request");
  const [owner, name] = parts;
  const comment = JSON.parse(execFileSync("gh", ["api", "--hostname", target.hostname, `repos/${owner}/${name}/issues/comments/${id}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }));
  const issue = new URL(comment.issue_url);
  const expectedHost = target.hostname === "github.com" ? "api.github.com" : target.hostname;
  const body = comment.body;
  const namedHead = typeof body === "string" ? (allowReadyContext ? /^## (?:NOT READY|READY) at ([a-f0-9]{7,40})\s*$/m : /^## NOT READY at ([a-f0-9]{7,40})\s*$/m).exec(body)?.[1] : undefined;
  // GUARD integration/review-receipt-binds-forge-head
  if (String(comment.id) !== id || comment.html_url !== selected.href || issue.hostname !== expectedHost || !issue.pathname.endsWith(`/repos/${owner}/${name}/issues/${pr.number}`) || !["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association) || typeof comment.user?.login !== "string" || !namedHead || !head.startsWith(namedHead) || !body.includes("<!-- rhiz-review-agent -->") || !body.includes(`Independent review by the \`pr-reviewer\` agent (\`scripts/review-pr.mts\`) of head \`${head}\`.`)) throw new Error("receipt is not an attributable exact-head correction review");
  return { commentUrl: selected.href, commentId: comment.id, commentDigest: createHash("sha256").update(body).digest("hex"), reviewerLogin: comment.user.login };
}

function commandReviewReceipt(repo, integrationRef, branch, commentUrl) {
  const measurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
  if (measurement.kind === "unavailable" || measurement.signals.upstreamState !== "pushed") throw new Error("review receipt requires a durable pushed candidate");
  const pr = JSON.parse(execFileSync("gh", ["pr", "view", branch, "--json", "number,state,headRefOid,baseRefOid,url"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }));
  const head = git(repo, ["rev-parse", branch]);
  const upstream = git(repo, ["rev-parse", `${branch}@{upstream}`]);
  if (pr.state !== "OPEN" || head !== upstream || head !== pr.headRefOid) throw new Error("review receipt requires this exact OPEN pushed head");
  const ordinary = decideHorizon(measurement.signals);
  if (ordinary.kind === "tripped" && !horizonReviewMayApply(measurement.signals, ordinary.reasons)) throw new Error("review receipt cannot forgive history, missing durability, or age at 48 hours");
  const integrationHead = git(repo, ["rev-parse", integrationRef]);
  // GUARD integration/review-receipt-binds-forge-base
  if (!/^[a-f0-9]{40}$/.test(pr.baseRefOid) || integrationHead !== pr.baseRefOid) throw new Error("fetch the current forge integration base before recording a receipt");
  const verified = reviewComment(repo, pr, commentUrl, head);
  const reviews = readReviews(repo);
  const stored = reviews[branch];
  if (!stored || stored.change !== pr.number) throw new Error("observe this open review before recording its correction receipt");
  const receipts = stored.correctionReceipts ?? [];
  const existing = receipts.find((receipt) => receipt.commentId === verified.commentId);
  if (existing) {
    if (existing.head !== head || existing.commentDigest !== verified.commentDigest) throw new Error("a correction receipt changed after recording");
    console.log(`horizon: correction receipt already recorded for ${head}`);
    return EXIT_CLEAR;
  }
  if (flag("dry-run")) {
    console.log(`horizon: would record correction receipt for ${head}; nothing changed`);
    return EXIT_CLEAR;
  }
  receipts.push({ ...verified, head, integrationHead, anchorDiffLines: committedDiffLines(repo, pr.baseRefOid, head), recordedAt: new Date().toISOString() });
  reviews[branch] = { ...stored, correctionReceipts: receipts };
  writeReviews(repo, reviews);
  console.log(`horizon: recorded exact-head correction receipt for ${head}; original anchor preserved`);
  return EXIT_CLEAR;
}

function measure(repo, integrationRef, branch, baselines) {
  const measurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
  if (measurement.kind === "unavailable") return { branch, state: "unavailable", reason: measurement.reason };
  let decision = decideHorizon(measurement.signals, baselines[branch]);
  let review;
  // Ask the forge only when review evidence could change this verdict.
  if (decision.kind === "tripped" && horizonReviewMayApply(measurement.signals, decision.reasons)) {
    review = reviewFor(repo, branch, measurement.signals);
    decision = decideHorizon(measurement.signals, baselines[branch], review.review);
  }
  return {
    branch,
    state: decision.kind,
    decision,
    signals: measurement.signals,
    summary: describe(decision),
    ...(review ? { review: review.note } : {}),
  };
}

function commandCheck(repo, integrationRef) {
  const branch = option("branch", currentBranch(repo));
  if (branch === undefined) {
    const payload = { state: "unavailable", reason: "detached HEAD names no branch to measure" };
    report(payload);
    return EXIT_UNAVAILABLE;
  }

  const result = measure(repo, integrationRef, branch, readBaselines(repo));
  report(result);
  if (result.state === "unavailable") return EXIT_UNAVAILABLE;
  return result.state === "tripped" ? EXIT_TRIPPED : EXIT_CLEAR;
}

function report(payload) {
  if (flag("json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.state === "unavailable") {
    console.error(`horizon: UNAVAILABLE (${payload.reason})`);
    return;
  }
  if (payload.state === "tripped") {
    console.error(`horizon: TRIPPED on ${payload.branch}`);
    for (const reason of payload.decision.reasons) {
      console.error(`  ${reason.signal}: ${reason.observed} (limit ${reason.limit}) — ${reason.detail}`);
    }
    console.error("");
    if (payload.review) console.error(`  review allowance: ${payload.review}`);
    console.error(`  converge with: node scripts/horizon.mjs converge --branch ${payload.branch}`);
    return;
  }
  console.log(`horizon: ${payload.summary ?? payload.state} on ${payload.branch}`);
}

function commandCensus(repo, integrationRef) {
  const baselines = readBaselines(repo);
  const branches = driftedBranches(repo, integrationRef);
  const rows = branches.map((branch) => measure(repo, integrationRef, branch, baselines));

  const tally = { clear: 0, grandfathered: 0, in_review: 0, tripped: 0, unavailable: 0 };
  let durability = 0;
  for (const row of rows) {
    tally[row.state] += 1;
    if (row.state === "tripped" && row.decision.reasons.some((reason) => reason.signal === "upstreamState")) {
      durability += 1;
    }
  }

  if (flag("json")) {
    console.log(JSON.stringify({ integrationRef, policy: CALIBRATED_INTEGRATION_HORIZON.id, tally, durability, rows }, null, 2));
  } else {
    console.log(`horizon census against ${integrationRef} (policy ${CALIBRATED_INTEGRATION_HORIZON.id})`);
    console.log(`  branches measured : ${rows.length}`);
    console.log(`  clear             : ${tally.clear}`);
    console.log(`  grandfathered     : ${tally.grandfathered}`);
    console.log(`  in review         : ${tally.in_review}`);
    console.log(`  tripped           : ${tally.tripped}`);
    console.log(`    of which durability: ${durability}`);
    console.log(`  unavailable       : ${tally.unavailable}`);
  }
  return tally.unavailable > 0 && rows.length === tally.unavailable ? EXIT_UNAVAILABLE : EXIT_CLEAR;
}

function commandBaselineFreeze(repo, integrationRef) {
  const existing = readBaselines(repo);
  const branches = driftedBranches(repo, integrationRef);

  const frozen = {};
  let ratcheted = 0;
  let recorded = 0;
  for (const branch of branches) {
    const measurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
    if (measurement.kind !== "measured") continue;
    const observed = baselineFromSignals(measurement.signals);
    const previous = existing[branch];
    // The ratchet: a re-freeze may lower an inherited allowance and may never
    // raise one. Freezing twice cannot be used to forgive new drift.
    frozen[branch] = previous === undefined ? observed : ratchetBaseline(previous, observed);
    if (previous === undefined) recorded += 1;
    else if (JSON.stringify(frozen[branch]) !== JSON.stringify(previous)) ratcheted += 1;
  }

  const payload = {
    $comment: "Grandfathered volume drift. Ratchets down only; never forgives missing durability. See ADR 0023.",
    policy: CALIBRATED_INTEGRATION_HORIZON.id,
    thresholds: HORIZON_THRESHOLDS,
    integrationRef,
    integrationHead: tryGit(repo, ["rev-parse", integrationRef]) ?? null,
    frozenAt: new Date().toISOString(),
    branches: frozen,
  };
  writeFileSync(baselinePath(repo), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(`horizon baseline frozen at ${baselinePath(repo)}`);
  console.log(`  branches recorded : ${Object.keys(frozen).length} (${recorded} new, ${ratcheted} ratcheted down)`);
  console.log("  durability is NOT grandfathered by this file");
  return EXIT_CLEAR;
}

async function commandConverge(repo, integrationRef) {
  const recovery = option("recover-effect", undefined);
  if (recovery !== undefined) return recoverConvergenceEffect(repo, recovery);
  const artifactRequest = option("artifact-request", undefined);
  if (artifactRequest !== undefined) return commandConvergenceArtifact(repo, integrationRef, artifactRequest);
  const branch = option("branch", currentBranch(repo));
  if (branch === undefined) {
    console.error("horizon: UNAVAILABLE (detached HEAD names no branch to converge)");
    return EXIT_UNAVAILABLE;
  }
  const receipt = option("review-receipt", undefined);
  if (receipt !== undefined) return commandReviewReceipt(repo, integrationRef, branch, receipt);
  const dryRun = flag("dry-run");

  // Durability convergence is a push and nothing else. It is deliberately not
  // gated on review: the remedy for bytes that exist on one machine must be
  // available without a PR, a verification run, or anyone's approval.
  const upstream = tryGit(repo, ["for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`]) ?? "";
  const needsPush = upstream.length === 0
    || tryGit(repo, ["rev-parse", "--verify", "--quiet", upstream]) === undefined
    || Number(tryGit(repo, ["rev-list", "--count", `${upstream}..${branch}`]) ?? "0") > 0;

  if (!needsPush) {
    console.log(`horizon: ${branch} already has a durable remote copy`);
    return EXIT_CLEAR;
  }
  if (dryRun) {
    console.log(`horizon: would push ${branch} to origin (dry run; nothing was sent)`);
    return EXIT_CLEAR;
  }

  console.log(`horizon: pushing ${branch} to origin`);
  try {
    git(repo, ["push", "-u", "origin", branch]);
  } catch (error) {
    console.error(`horizon: push failed — ${error.message.split("\n")[0]}`);
    return EXIT_UNAVAILABLE;
  }

  // Verify the end state rather than trusting the command's exit status.
  const local = tryGit(repo, ["rev-parse", branch]);
  const remote = (tryGit(repo, ["ls-remote", "origin", `refs/heads/${branch}`]) ?? "").split("\t")[0];
  if (local !== remote) {
    console.error(`horizon: push reported success but origin does not have ${local}`);
    return EXIT_UNAVAILABLE;
  }
  console.log(`horizon: ${branch} is durable at ${local}`);
  return EXIT_CLEAR;
}

const CONVERGENCE_SCHEMA = "rhiz/convergence-request/v1";
const ARTIFACT_SCHEMA = "rhiz/convergence-artifact/v1";
const MAX_CONVERGENCE_BYTES = 128 * 1024;
const MAX_CONVERGENCE_PATHS = 64;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => JSON.stringify(value);

function safeSourcePath(value, writable = true) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.includes("\n") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("convergence path is not a literal repository path");
  if (writable && value.split("/").some((part) => [".git", ".codex", ".context", "node_modules"].includes(part) || part.startsWith(".env") || part.startsWith(".rhiz-horizon"))) throw new Error("convergence cannot write protected execution or credential paths");
  return value;
}

function sourceFileIdentity(repo, name) {
  const filename = join(repo, name);
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(filename) !== resolve(realpathSync(repo), name)) throw new Error(`convergence requires an in-root regular source file without link traversal: ${name}`);
    return { digest: sha(readFileSync(filename)), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseConvergenceRequest(filename) {
  const bytes = readFileSync(filename);
  if (bytes.byteLength > MAX_CONVERGENCE_BYTES) throw new Error("convergence request exceeds bounded review size");
  const input = JSON.parse(bytes);
  if (!input || Array.isArray(input) || input.schema !== CONVERGENCE_SCHEMA || !["resolve-integration", "repair-reviewed-target"].includes(input.purpose) || Object.keys(input).some((key) => !["schema", "purpose", "paths", "patch", "reviewCommentUrl"].includes(key))) throw new Error("convergence request has unsupported fields");
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_CONVERGENCE_PATHS || new Set(input.paths).size !== input.paths.length) throw new Error("convergence requires one bounded exact path set");
  input.paths.forEach((name) => safeSourcePath(name));
  input.paths.sort();
  if (typeof input.patch !== "string" || !input.patch.trim() || input.patch.includes("\0") || input.patch.includes("GIT binary patch") || /^(?:deleted file mode|new file mode|rename from|rename to|old mode|new mode) /m.test(input.patch)) throw new Error("convergence requires a nonempty existing-file text patch");
  if (typeof input.reviewCommentUrl !== "string") throw new Error("convergence requires active review context");
  return input;
}

function captureSourceState(repo, branch) {
  const head = git(repo, ["rev-parse", branch]);
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const entries = status.split("\0").filter(Boolean);
  const dirty = new Set();
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    dirty.add(safeSourcePath(row.slice(3), false));
    if (row[0] === "R" || row[1] === "R" || row[0] === "C" || row[1] === "C") dirty.add(safeSourcePath(entries[++i], false));
  }
  const files = [...dirty].sort().map((name) => [name, sourceFileIdentity(repo, name)]);
  const index = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: repo, encoding: "utf8" });
  const unmerged = execFileSync("git", ["ls-files", "--unmerged", "-z"], { cwd: repo, encoding: "utf8" });
  const mergeHead = tryGit(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  const state = { head, currentBranch: currentBranch(repo), mergeHead: mergeHead ?? null, statusDigest: sha(status), indexDigest: sha(index), unmergedDigest: sha(unmerged), files };
  return { ...state, digest: sha(stable(state)), unmergedPaths: [...new Set(unmerged.split("\0").filter(Boolean).map((row) => safeSourcePath(row.slice(row.indexOf("\t") + 1), false)))].sort() };
}

function assertCanonicalMergeStages(repo, sourceHead, integrationHead) {
  const bases = git(repo, ["merge-base", "--all", sourceHead, integrationHead]).split("\n");
  if (bases.length !== 1) throw new Error("convergence requires a single reconstructible merge base");
  const raw = execFileSync("git", ["ls-files", "--unmerged", "-z"], { cwd: repo, encoding: "utf8" });
  const entries = raw.split("\0").filter(Boolean).map((row) => {
    const [metadata, name] = row.split("\t");
    const [mode, blob, stageText] = metadata.split(" ");
    const stage = Number(stageText);
    if (![1, 2, 3].includes(stage)) throw new Error("merge stage is unsupported");
    const ref = stage === 1 ? bases[0] : stage === 2 ? sourceHead : integrationHead;
    const expected = execFileSync("git", ["ls-tree", "-z", ref, "--", name], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
    if (expected.length !== 1 || expected[0].split("\t")[0] !== `${mode} blob ${blob}`) throw new Error("merge stage blob differs from the actual source/main/base");
    return { path: name, mode, blob, stage };
  });
  return entries;
}

function convergenceForge(repo, branch, integrationRef, input) {
  const pr = JSON.parse(execFileSync("gh", ["pr", "view", branch, "--json", "number,url,state,headRefOid,baseRefOid,baseRefName,comments"], { cwd: repo, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }));
  const head = git(repo, ["rev-parse", branch]);
  const upstream = git(repo, ["rev-parse", `${branch}@{upstream}`]);
  const integration = git(repo, ["rev-parse", integrationRef]);
  const target = new URL(pr.url);
  const [owner, name] = target.pathname.split("/").filter(Boolean);
  const acceptedMain = JSON.parse(execFileSync("gh", ["api", "--hostname", target.hostname, `repos/${owner}/${name}/git/ref/heads/main`], { cwd: repo, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }));
  if (pr.state !== "OPEN" || pr.baseRefName !== "main" || pr.headRefOid !== head || head !== upstream || acceptedMain.object?.sha !== integration || acceptedMain.ref !== "refs/heads/main" || acceptedMain.object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(pr.baseRefOid)) throw new Error("convergence requires exact durable OPEN head and fresh accepted repository main");
  // PR comparison base is historical review evidence, not current main authority.
  git(repo, ["rev-parse", "--verify", `${pr.baseRefOid}^{commit}`]);
  const context = reviewComment(repo, pr, input.reviewCommentUrl, head, input.purpose === "resolve-integration");
  const latest = [...(pr.comments ?? [])].reverse().find((comment) => typeof comment.body === "string" && comment.body.includes("<!-- rhiz-review-agent -->"));
  if (!latest || latest.url !== context.commentUrl) throw new Error("convergence review context is not the latest canonical comment");
  const comment = JSON.parse(execFileSync("gh", ["api", "--hostname", new URL(pr.url).hostname, `repos/${new URL(pr.url).pathname.split("/").filter(Boolean).slice(0, 2).join("/")}/issues/comments/${context.commentId}`], { cwd: repo, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }));
  if (sha(comment.body) !== context.commentDigest || comment.html_url !== context.commentUrl || comment.user?.login !== context.reviewerLogin) throw new Error("review context changed during forge readback");
  const created = Date.parse(comment.created_at);
  if (!Number.isFinite(created) || created > Date.now() || Date.now() - created >= 4 * 60 * 60 * 1000) throw new Error("active review context is stale or future dated");
  return { head, integration, reviewBase: pr.baseRefOid, prNumber: pr.number, prUrl: pr.url, comment: { ...context, createdAt: comment.created_at }, findings: comment.body };
}

function patchPaths(repo, patchPath) {
  const rows = execFileSync("git", ["apply", "--numstat", "-z", patchPath], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  return rows.map((row) => {
    const [added, removed, ...name] = row.split("\t");
    if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) throw new Error("convergence patch cannot be measured");
    return safeSourcePath(name.join("\t"));
  }).sort();
}

function validateConvergencePacket(packet, expectedDigest) {
  if (!packet || packet.schema !== ARTIFACT_SCHEMA || sha(stable(packet)) !== expectedDigest) throw new Error("immutable convergence artifact differs from the captured request");
}

async function canonicalConvergenceWork(repo, workId) {
  const common = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
  const result = await readRepositoryWorkLedgers(common);
  if (result.unreadable.length) throw new Error("canonical Work evidence is unreadable");
  const matches = result.ledgers.filter((item) => item.workIds.includes(workId));
  if (matches.length > 1) throw new Error("convergence Work identity appears in multiple Ledgers");
  if (!matches.length) return undefined;
  const events = matches[0].events.filter((event) => event.workId === workId);
  return { events, board: projectBoard(events), directory: matches[0].directory };
}

function fixedConvergenceContract(repo, workId, packet, artifactPath, contextPath) {
  const auditEmail = git(repo, ["config", "user.email"]);
  if (!auditEmail) throw new Error("existing operator audit identity is unavailable");
  const resources = packet.request.paths.map((name) => ({ uri: `repo://source/${name}`, kind: "file" }));
  const artifact = { uri: `repo://source/${artifactPath}`, kind: "file" };
  return parseWorkContract({ id: workId, type: "SHIP", createdBy: { id: `human:${auditEmail}`.slice(0, 200), kind: "human" }, createdAt: new Date().toISOString(),
    objective: `Artifact producer only: Copy the complete JSON manifest supplied in the Context into ${artifactPath}, retaining every field and its order. The manifest is the complete producer input; packetBlob and inputCheckpoint intentionally reference a separate immutable packet, not missing patch data. Use the native file-change tool to create only this artifact; its parent directories are already prepared. Do not run shell commands, inspect the referenced packet/source blobs, perform review, or satisfy the separate reviewer obligations. Packaging makes no authorship, semantic correctness, verification, acceptance, or source-application claim. Do not modify any source file.`,
    scope: [{ uri: "repo://source", kind: "repository" }], writeScope: [artifact, ...resources],
    nonGoals: ["No source writes in this attempt", "No application effects or accepted Outcome", "No new feature scope, clock reset, authority widening, or fabricated proof"],
    authority: { grants: [{ action: "read", resources: [{ uri: "repo://source" }], constraints: [] }, { action: "write", resources: [artifact, ...resources], constraints: [] }], requiresHumanApproval: ["publish", "external-mutate", "spend"] },
    acceptanceCriteria: [{ id: "criterion:exact-convergence-artifact", description: "Artifact exactly retains the captured source snapshot, explicit source scope and proposed patch; no other candidate file changes.", required: true }],
    requiredEvidence: [{ id: "evidence:convergence-check", description: "Actual exact-artifact check with an altered-artifact negative control", acceptedKinds: ["test"], required: true }],
    context: { strategy: "explicit", resources: [{ uri: `repo://source/${contextPath}`, kind: "file" }], tokenBudget: 32768, includeHistory: false }, dependencies: [],
    workerPolicy: { maxAttempts: 1, attemptBudgetMs: 180000, allowParallelAttempts: false, preferredProviders: ["worker:codex-app-server"] },
    verificationPolicy: { required: true, independentActor: true, reviewRequired: true, falsifiabilityExemptions: [] },
  });
}

async function projectConvergenceTree(repo, privateRoot, input, originals, integrationHead) {
  const beforeRoot = join(privateRoot, "source-subset");
  mkdirSync(beforeRoot);
  for (const [name] of originals) {
    const target = join(beforeRoot, name);
    mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    copyFileSync(join(repo, name), target);
  }
  const identity = await digestExecutionRoot(beforeRoot);
  const factory = new TempDirectoryDerivativeFactory();
  const derivative = await factory.createFromRoot({ sourceRoot: beforeRoot, expectedDigest: identity.digest, expectedFileCount: identity.scope.fileCount });
  try {
    execFileSync("git", [...HARDENED_GIT_FLAGS, "apply", join(privateRoot, "proposed.patch")], { cwd: derivative.root, env: hardenedGitEnv() });
    const index = join(privateRoot, "projected.index");
    copyFileSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]), index);
    const env = { ...hardenedGitEnv(), GIT_INDEX_FILE: index };
    const run = (args, options = {}) => execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], { cwd: repo, env, encoding: "utf8", ...options }).trim();
    const afterFiles = [];
    let records = "";
    for (const [name, original] of originals) {
      const bytes = readFileSync(join(derivative.root, name));
      if (/^(<<<<<<< |>>>>>>> )/m.test(bytes.toString("utf8"))) throw new Error("projected source retains unresolved conflict markers");
      const blob = run(["hash-object", "-w", "--stdin"], { input: bytes });
      const mode = original.mode & 0o111 ? "100755" : "100644";
      records += `0 ${"0".repeat(40)}\t${name}\0${mode} ${blob}\t${name}\0`;
      afterFiles.push([name, { digest: sha(bytes), mode: original.mode }]);
    }
    run(["update-index", "-z", "--index-info"], { input: records });
    const tree = run(["write-tree"]);
    const stats = run(["diff", "--numstat", integrationHead, tree]);
    let diffLines = 0;
    for (const row of stats.split("\n").filter(Boolean)) {
      const [a, d] = row.split("\t");
      if (!/^\d+$/.test(a) || !/^\d+$/.test(d)) throw new Error("projected convergence contains unmeasurable binary changes");
      diffLines += Number(a) + Number(d);
    }
    return { tree, diffLines, afterFiles };
  } finally { await factory.destroy(derivative); }
}

function qualifiedConvergenceAnchor(repo, branch, forge) {
  const stored = readReviews(repo)[branch];
  for (const receipt of [...(stored?.correctionReceipts ?? [])].reverse()) {
    try {
      git(repo, ["merge-base", "--is-ancestor", receipt.head, forge.head]);
      const actual = reviewComment(repo, { number: forge.prNumber, url: forge.prUrl }, receipt.commentUrl, receipt.head);
      if (actual.commentDigest !== receipt.commentDigest || actual.reviewerLogin !== receipt.reviewerLogin) continue;
      return committedDiffLines(repo, forge.reviewBase, receipt.head);
    } catch { continue; }
  }
  throw new Error("convergence growth requires an attributable existing correction round; cached numbers confer no authority");
}

// Retain complete evidence through the existing immutable Work checkpoint path.
function retainConvergenceArtifact(repo, workId, label, value, parents) {
  const run = (args, input) => execFileSync("git", [...HARDENED_GIT_FLAGS, ...args], { cwd: repo, env: hardenedGitEnv(), encoding: "utf8", ...(input === undefined ? {} : { input }) }).trim();
  const blob = run(["hash-object", "-w", "--stdin"], stable(value));
  const tree = run(["mktree"], `100644 blob ${blob}\tartifact.json\n`);
  const date = run(["show", "-s", "--format=%cI", parents[0]]);
  const head = execFileSync("git", [...HARDENED_GIT_FLAGS, "commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])], { cwd: repo, env: { ...hardenedGitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: "Harness Convergence", GIT_COMMITTER_NAME: "Harness Convergence", GIT_AUTHOR_EMAIL: "horizon-convergence@rhiz.invalid", GIT_COMMITTER_EMAIL: "horizon-convergence@rhiz.invalid" }, encoding: "utf8", input: `rhiz: ${label} for ${workId}\n` }).trim();
  const ref = `refs/rhiz/work/${harnessGitRefSegment(workId)}/${label}`;
  const existing = tryGit(repo, ["rev-parse", "--verify", "--quiet", ref]);
  if (existing !== undefined && existing !== head) throw new Error("immutable local convergence artifact already names different history");
  git(repo, ["update-ref", ref, head]);
  pushHarnessCheckpoint({ repositoryRoot: repo, ref, head });
  return { ref, head, blob, digest: sha(stable(value)) };
}

async function recordConvergenceArtifact(canonical, workId, label, artifact, recovered = false) {
  const ledger = await DurableEventLedger.open({ directory: canonical.directory, ledgerId: `ledger:${workId}` });
  try {
    const timestamp = new Date().toISOString();
    const uri = `git:${artifact.head}:artifact.json`;
    await ledger.append(parseHarnessEvent({ id: `event:convergence:${globalThis.crypto.randomUUID()}`, type: recovered ? "artifact.observed" : "artifact.changed", schemaVersion: 1, streamId: canonical.events[0].streamId, workId, actor: { id: "service:horizon-convergence", kind: "service" }, occurredAt: timestamp, recordedAt: timestamp, evidence: [{ id: `convergence:${label}`, kind: "receipt", uri, digest: artifact.digest }], payload: { artifact: { uri, kind: "artifact" }, digest: artifact.digest } }));
  } finally { await ledger.close(); }
}

function effectMatches(repo, packet) {
  const after = captureSourceState(repo, packet.source.currentBranch);
  const outside = (files) => files.filter(([name]) => !packet.request.paths.includes(name));
  if (after.head !== packet.source.head || after.currentBranch !== packet.source.currentBranch || after.mergeHead !== packet.source.mergeHead || after.unmergedPaths.length || stable(outside(after.files)) !== stable(outside(packet.source.files))) throw new Error("convergence effect readback has divergent source state");
  if (packet.projected.afterFiles.some(([name, expected]) => stable(sourceFileIdentity(repo, name)) !== stable(expected))) throw new Error("source readback differs from the exact reviewed projected bytes");
  if (packet.request.purpose === "resolve-integration" && git(repo, ["write-tree"]) !== packet.projected.tree) throw new Error("applied resolution differs from the exact reviewed integration tree");
  if (packet.request.purpose === "repair-reviewed-target" && after.indexDigest !== packet.source.indexDigest) throw new Error("terminal effect changed the original index");
  return after;
}

async function recoverConvergenceEffect(repo, workId) {
  const canonical = await canonicalConvergenceWork(repo, workId);
  const intents = canonical?.events.filter((event) => event.actor.id === "service:horizon-convergence" && event.evidence.some((entry) => entry.id === "convergence:intent")) ?? [];
  if (intents.length !== 1 || canonical.events.some((event) => event.evidence.some((entry) => entry.id === "convergence:effect"))) throw new Error("recovery requires exactly one unfinished durable effect intent");
  const entry = intents[0].evidence.find((entry) => entry.id === "convergence:intent");
  const match = /^git:([0-9a-f]{40,64}):artifact.json$/.exec(entry.uri ?? "");
  if (!match) throw new Error("durable effect intent has no immutable artifact identity");
  const intent = JSON.parse(git(repo, ["show", `${match[1]}:artifact.json`]));
  if (sha(stable(intent)) !== entry.digest || intent.workId !== workId || intent.schema !== "rhiz/convergence-intent/v1") throw new Error("durable effect intent differs from its canonical evidence");
  const board = canonical.board;
  const review = canonical.events.find((event) => event.id === intent.reviewEventId);
  const verification = canonical.events.find((event) => event.id === intent.verificationEventId);
  if (!acceptanceReadiness(board).ready || board.violations.length || board.integration?.headProof?.head !== intent.artifactHead || board.integration.headProof.verificationEventId !== verification?.id || review?.payload.status !== "pass" || verification?.payload.status !== "pass" || executionActorIds(board).has(review.actor.id) || executionActorIds(board).has(verification.actor.id) || !review.evidence.some((evidence) => evidence.kind === "diff" && evidence.digest === `git:${intent.packet.source.head}..${intent.artifactHead}`)) throw new Error("recovery intent lacks its exact independent canonical proof");
  const lockPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "horizon-convergence.lock"]);
  if (existsSync(lockPath)) {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (owner.workId !== workId || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("source custody lock is not recoverable");
    try { process.kill(owner.pid, 0); throw new Error("source effect still has a live owner"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const after = effectMatches(repo, intent.packet);
  const receipt = { ...intent.receipt, sourceAfter: after.digest };
  const artifact = retainConvergenceArtifact(repo, workId, "effect", receipt, [match[1]]);
  if (captureSourceState(repo, intent.packet.source.currentBranch).digest !== after.digest) throw new Error("source changed during effect recovery");
  await recordConvergenceArtifact(canonical, workId, "effect", artifact, true);
  if (existsSync(lockPath)) rmSync(lockPath);
  const contextPath = join(repo, `.context/horizon-convergence/${workId.slice(-40)}.json`);
  prepareCustodyParent(repo, ".context/horizon-convergence");
  if (existsSync(contextPath)) rmSync(contextPath);
  console.log(JSON.stringify({ ...receipt, recovered: true, observedAppliedState: true }));
  return EXIT_CLEAR;
}

function prepareCustodyParent(repo, directory) {
  let cursor = realpathSync(repo);
  for (const part of directory.split("/")) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) { const stat = lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("convergence custody ancestor is not an owned directory"); }
    else mkdirSync(cursor, { mode: 0o700 });
  }
  if (realpathSync(cursor) !== resolve(realpathSync(repo), directory)) throw new Error("convergence custody traverses a link");
}

async function commandConvergenceArtifact(repo, integrationRef, filename) {
  if (flag("dry-run")) throw new Error("artifact convergence owns real execution; dry-run is unsupported and changes nothing");
  const input = parseConvergenceRequest(filename);
  const branch = currentBranch(repo);
  if (!branch) throw new Error("convergence requires the owned source branch");
  const measured = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
  if (measured.kind !== "measured" || measured.signals.upstreamState !== "pushed" || measured.signals.commitsAhead >= HORIZON_THRESHOLDS.commitsAhead) throw new Error("convergence cannot forgive private history or missing durability");
  const before = captureSourceState(repo, branch);
  const forge = convergenceForge(repo, branch, integrationRef, input);
  if (input.purpose === "resolve-integration") {
    if (before.mergeHead !== forge.integration || before.unmergedPaths.length === 0 || before.unmergedPaths.some((name) => !input.paths.includes(name))) throw new Error("resolution must include the actual fresh MERGE_HEAD and every conflict path");
  } else if (before.mergeHead !== null || before.unmergedPaths.length || measured.signals.commitsBehind !== 0 || before.files.length) throw new Error("terminal repair requires a clean fully integrated source target");
  const mergeStages = input.purpose === "resolve-integration" ? assertCanonicalMergeStages(repo, forge.head, forge.integration) : [];
  const mergeBase = git(repo, ["merge-base", forge.head, forge.integration]);
  const changedUniverse = new Set([...git(repo, ["diff", "--name-only", mergeBase, forge.head]).split("\n"), ...git(repo, ["diff", "--name-only", mergeBase, forge.integration]).split("\n"), ...before.unmergedPaths]);
  if (input.paths.some((name) => !changedUniverse.has(name))) throw new Error("convergence scope is foreign to the reviewed change and accepted integration");
  const originals = input.paths.map((name) => [name, sourceFileIdentity(repo, name)]);
  if (originals.some(([, value]) => value === null)) throw new Error("convergence is limited to existing regular source files");
  const privateRoot = mkdtempSync(join(tmpdir(), "rhiz-convergence-input-"));
  try {
  const patchPath = join(privateRoot, "proposed.patch");
  writeFileSync(patchPath, input.patch, { mode: 0o600 });
  if (stable(patchPaths(repo, patchPath)) !== stable(input.paths)) throw new Error("patch paths differ from exact reviewed scope");
  git(repo, ["apply", "--check", patchPath]);
  const projected = await projectConvergenceTree(repo, privateRoot, input, originals, forge.integration);
  const anchor = qualifiedConvergenceAnchor(repo, branch, forge);
  if (projected.diffLines >= Math.ceil(anchor * 1.25)) throw new Error("projected convergence exceeds the existing inclusive growth bound");
  const packet = { schema: ARTIFACT_SCHEMA, request: input, source: before, forge, originals, projected, mergeStages };
  const packetDigest = sha(stable(packet));
  const packetBlob = execFileSync("git", [...HARDENED_GIT_FLAGS, "hash-object", "-w", "--stdin"], { cwd: repo, env: hardenedGitEnv(), encoding: "utf8", input: stable(packet) }).trim();
  const manifest = { schema: ARTIFACT_SCHEMA, sourceHead: before.head, integrationHead: forge.integration, sourceDigest: before.digest, packetBlob, packetDigest, scope: input.paths, projectedTree: projected.tree };
  const workId = `work:horizon-convergence-${sha(stable([forge.prUrl, forge.head, forge.comment.commentId, input.purpose])).slice(0, 40)}`;
  if (await canonicalConvergenceWork(repo, workId)) throw new Error("this correction window already owns a Work; cached results cannot skip fresh execution");
  const artifactDate = git(repo, ["show", "-s", "--format=%cI", before.head]);
  const projectedCommit = execFileSync("git", [...HARDENED_GIT_FLAGS, "commit-tree", projected.tree, "-p", before.head, "-p", forge.integration], { cwd: repo, env: { ...hardenedGitEnv(), GIT_AUTHOR_DATE: artifactDate, GIT_COMMITTER_DATE: artifactDate, GIT_AUTHOR_NAME: "Harness Convergence", GIT_COMMITTER_NAME: "Harness Convergence", GIT_AUTHOR_EMAIL: "horizon-convergence@rhiz.invalid", GIT_COMMITTER_EMAIL: "horizon-convergence@rhiz.invalid" }, encoding: "utf8", input: "rhiz: retained projected convergence artifact\n" }).trim();
  const retainedInput = retainConvergenceArtifact(repo, workId, "convergence-input", packet, [projectedCommit]);
  manifest.inputCheckpoint = retainedInput;
  const manifestDigest = sha(stable(manifest));
  const artifactPath = `tools/horizon-convergence-artifacts/${workId.slice(-40)}/artifact.json`;
  const contextPath = `.context/horizon-convergence/${workId.slice(-40)}.json`;
  const contextFilename = join(repo, contextPath);
  const lockPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "horizon-convergence.lock"]);
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, stable({ pid: process.pid, workId }));
  let contextCreated = false;
  try {
    if (existsSync(contextFilename)) throw new Error("convergence input custody path already exists");
    prepareCustodyParent(repo, ".context/horizon-convergence");
    writeFileSync(contextFilename, stable(manifest), { mode: 0o600, flag: "wx" });
    contextCreated = true;
    const contract = fixedConvergenceContract(repo, workId, packet, artifactPath, contextPath);
    contract.objective += ` Independent review only: After the producer has completed its packaging and Verify has passed, the separate independent reviewer must read the WHOLE immutable packet via git cat-file blob ${packetBlob}, inspect the actual original and accepted-main blobs, and judge preservation of both source legs and repair-only scope against its active findings. The reviewer must refuse if the whole patch or its source evidence cannot be inspected. These obligations belong to the reviewer, not the artifact producer. Deterministic identity checks do not prove these semantics.`;
    const check = `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');const a=JSON.parse(fs.readFileSync(${JSON.stringify(artifactPath)},'utf8'));if(crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex')!==${JSON.stringify(manifestDigest)})process.exit(1);const packet=cp.execFileSync('git',['cat-file','blob',${JSON.stringify(packetBlob)}],{encoding:'utf8'});if(crypto.createHash('sha256').update(packet).digest('hex')!==${JSON.stringify(packetDigest)})process.exit(1);const changed=cp.execFileSync('git',['diff','--name-only',${JSON.stringify(before.head)}+'..HEAD'],{encoding:'utf8'}).trim().split(String.fromCharCode(10));if(JSON.stringify(changed)!==JSON.stringify([${JSON.stringify(artifactPath)}]))process.exit(1);`;
    const config = { command: process.execPath, args: ["-e", check], expectedExitCodes: [0], evidenceKind: "test" };
    const plan = { id: `plan:${workId}`, workId, contractRevision: 1, checks: [
      { id: "check:convergence-artifact", providerId: "verifier:local-command", description: "Exact immutable captured artifact and path set", criterionIds: ["criterion:exact-convergence-artifact"], requirementIds: ["evidence:convergence-check"], config },
      { id: "check:convergence-artifact-negative", providerId: "verifier:local-command", description: "Altered artifact must fail", negativeControlFor: "check:convergence-artifact", perturbation: { kind: "overwrite-file", path: artifactPath, content: "{}\n", description: "Captured artifact altered" }, config },
    ] };
    const prepare = { command: process.execPath, args: ["-e", `const fs=require('node:fs'),path=require('node:path');let cursor=process.cwd();for(const part of ${JSON.stringify(artifactPath.slice(0, artifactPath.lastIndexOf("/")).split("/"))}){cursor=path.join(cursor,part);if(fs.existsSync(cursor)){if(!fs.lstatSync(cursor).isDirectory()||fs.lstatSync(cursor).isSymbolicLink())throw Error('artifact parent is not an owned directory')}else fs.mkdirSync(cursor)}`] };
    for (const [name, value] of [["contract", contract], ["verify", plan], ["prepare", prepare]]) writeFileSync(join(privateRoot, `${name}.json`), stable(value), { mode: 0o600 });
    const operator = fileURLToPath(new URL("./rhiz-harness.mjs", import.meta.url));
    const env = { ...process.env };
    delete env.RHIZ_CODEX_COMMAND;
    delete env.RHIZ_CLAUDE_COMMAND;
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV"]) delete env[name];
    const invoke = (args) => {
      try { return JSON.parse(execFileSync(process.execPath, [operator, ...args, "--repo", repo, "--json"], { cwd: repo, env, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })); }
      catch (error) {
        let failure;
        try { const output = JSON.parse(error.stdout); failure = output.receipt?.verification?.checks?.map((check) => `${check.checkId}: ${check.summary}`).join("; ") ?? output.status?.readiness?.reasons?.join("; "); } catch { failure = "controlled invocation produced no readable receipt"; }
        throw new Error(`controlled ${args[0]} failed: ${failure}`);
      }
    };
    const started = invoke(["start", "--contract", join(privateRoot, "contract.json"), "--verify", join(privateRoot, "verify.json"), "--prepare", join(privateRoot, "prepare.json"), "--base", before.head]);
    if (started.exitCode !== 0 || !started.receipt?.candidate?.head) throw new Error("controlled artifact production/verification failed; no effect authorized");
    const produced = await canonicalConvergenceWork(repo, workId);
    const target = produced?.board.integration?.headProof;
    if (!target || target.head !== started.receipt.candidate.head) throw new Error("actual producer receipt differs from canonical integration proof");
    const actual = JSON.parse(git(repo, ["show", `${target.head}:${artifactPath}`]));
    validateConvergencePacket(actual, manifestDigest);
    const reviewStartedAtMs = Date.now();
    const reviewed = invoke(["review", workId, "--reviewer", "claude"]);
    const canonical = await canonicalConvergenceWork(repo, workId);
    const board = canonical?.board;
    const readiness = board && acceptanceReadiness(board);
    const reviewEvent = canonical?.events.find((event) => event.id === readiness?.reviewEventId);
    const verificationEvent = canonical?.events.find((event) => event.id === board?.integration?.headProof?.verificationEventId);
    const exactDiff = `git:${before.head}..${target.head}`;
    const current = captureSourceState(repo, branch);
    const freshForge = convergenceForge(repo, branch, integrationRef, input);
    const freshAnchor = qualifiedConvergenceAnchor(repo, branch, freshForge);
    const freshMeasurement = measureBranchDrift({ repositoryRoot: repo, integrationRef, branch });
    if (freshMeasurement.kind !== "measured" || stable(freshMeasurement.signals) !== stable({ ...measured.signals, divergenceAgeMs: freshMeasurement.signals.divergenceAgeMs })) throw new Error("source drift changed during controlled execution");
    const refusals = convergenceEffectRefusals({ purpose: input.purpose, signals: freshMeasurement.signals,
      sourceStateUnchanged: current.digest === before.digest, freshIntegrationTarget: stable(freshForge) === stable(forge), exactScope: stable(patchPaths(repo, patchPath)) === stable(input.paths), immutableArtifact: sha(stable(actual)) === manifestDigest && sha(git(repo, ["cat-file", "blob", packetBlob])) === packetDigest,
      controlledWorkerCompleted: started.exitCode === 0, controlledVerificationCompleted: verificationEvent?.payload.status === "pass", controlledReviewCompleted: reviewed.review?.verdict.status === "pass" && reviewed.review.candidateHead === target.head,
      independentActors: !!reviewEvent && !!verificationEvent && !executionActorIds(board).has(reviewEvent.actor.id) && !executionActorIds(board).has(verificationEvent.actor.id),
      canonicalProofMatches: !!readiness?.ready && board.violations.length === 0 && board.contractRevision === 1 && board.integration.headProof.head === target.head && stable(board.contract.writeScope) === stable(contract.writeScope),
      rawReviewDiffMatches: !!reviewEvent && reviewEvent.payload.contractRevision === 1 && reviewEvent.evidence.some((evidence) => evidence.kind === "diff" && evidence.digest === exactDiff) && reviewEvent.actor.id === reviewed.review?.reviewer.id,
      withinGrowthBound: freshAnchor === anchor && projected.diffLines < Math.ceil(freshAnchor * 1.25), reviewStartedAtMs, nowMs: Date.now(),
    });
    if (refusals.length) throw new Error(`convergence effect refused: ${refusals.join(", ")}`);
    if (captureSourceState(repo, branch).digest !== before.digest || sha(readFileSync(patchPath)) !== sha(input.patch)) throw new Error("convergence state changed before effect");
    const receiptBase = { schema: "rhiz/convergence-effect/v1", workId, artifactHead: target.head, artifactDigest: packetDigest, sourceBefore: before.digest, paths: input.paths, verificationEventId: verificationEvent.id, reviewEventId: reviewEvent.id, accepted: false };
    const intent = retainConvergenceArtifact(repo, workId, "intent", { schema: "rhiz/convergence-intent/v1", workId, packet, artifactHead: target.head, verificationEventId: verificationEvent.id, reviewEventId: reviewEvent.id, receipt: receiptBase }, [retainedInput.head, target.head]);
    await recordConvergenceArtifact(canonical, workId, "intent", intent);
    if (captureSourceState(repo, branch).digest !== before.digest) throw new Error("source changed before the recorded effect intent");
    git(repo, ["apply", "--check", patchPath]);
    git(repo, ["apply", patchPath]);
    if (input.purpose === "resolve-integration") git(repo, ["add", "--", ...input.paths]);
    const after = effectMatches(repo, packet);
    const receipt = { ...receiptBase, sourceAfter: after.digest };
    const effect = retainConvergenceArtifact(repo, workId, "effect", receipt, [intent.head]);
    if (captureSourceState(repo, branch).digest !== after.digest) throw new Error("source changed during effect receipt retention");
    await recordConvergenceArtifact(canonical, workId, "effect", effect);
    console.log(JSON.stringify(receipt));
    return EXIT_CLEAR;
  } finally {
    if (contextCreated) rmSync(contextFilename);
    closeSync(lock);
    rmSync(lockPath);
  }
  } finally { rmSync(privateRoot, { recursive: true, force: true }); }
}

async function main() {
  const command = process.argv[2];
  const repo = option("repo", process.cwd());
  const integrationRef = option("integration-ref", "origin/main");

  switch (command) {
    case "check":
      return commandCheck(repo, integrationRef);
    case "census":
      return commandCensus(repo, integrationRef);
    case "baseline":
      if (process.argv[3] !== "freeze") throw new Error("usage: baseline freeze");
      return commandBaselineFreeze(repo, integrationRef);
    case "converge":
      return commandConverge(repo, integrationRef);
    default:
      console.error("usage: horizon.mjs <check|census|baseline freeze|converge> [options]");
      return EXIT_UNAVAILABLE;
  }
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`horizon: UNAVAILABLE (${error.message})`);
  process.exit(EXIT_UNAVAILABLE);
}
