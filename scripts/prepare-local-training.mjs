// Derived, private experiment artifacts. This does not accept Work, authorize
// training, promote a model, or create another canonical Memory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectBoard } from "../dist/src/board.js";
import { readRepositoryWorkLedgers } from "../dist/adapters/local/work-ledgers.js";

export function approvedTrainingExample(example, events) {
  if (!example || example.trainingPermitted !== true || example.customerDataRemoved !== true ||
      example.secretsReviewed !== true || example.approvedBy?.kind !== "human" || !example.approvedBy?.id) {
    throw new Error("Explicit operator-reviewed content and data-rights approval required");
  }
  // These fields are audit assertions from an already-authorized private operator
  // boundary, never authentication or a grant inferred from a local JSON file.
  const board = projectBoard(events);
  if (board.state !== "accepted" || board.violations.length || board.workId !== example.workId ||
      !board.contract?.verificationPolicy.independentActor) throw new Error("Only clean accepted independently verified Work is eligible");
  const proof = board.integration?.headProof;
  if (!proof || proof.head !== example.artifactSha || proof.verificationEventId !== example.verificationEventId) {
    throw new Error("Approval is not bound to the canonical verified artifact");
  }
  if (!board.verifications.some(v => v.eventId === proof.verificationEventId && v.status === "pass" && v.contractRevision === board.contractRevision)) {
    throw new Error("Current independent verification proof missing");
  }
  if (typeof example.prompt !== "string" || typeof example.completion !== "string" ||
      !example.prompt || !example.completion || example.prompt.length + example.completion.length > 12000) throw new Error("Invalid or oversized example");
  const text = JSON.stringify({ prompt: example.prompt, completion: example.completion });
  if (createHash("sha256").update(text).digest("hex") !== example.contentSha256) throw new Error("Approved content digest changed");
  // Mechanical screening supplements required review; it cannot prove absence
  // of private customer material. Reject rather than silently alter approved bytes.
  if (/-----BEGIN .*PRIVATE KEY-----|(?:sk|ghp|gho|github_pat)[-_][A-Za-z0-9_]{12,}|(?:api[_-]?key|password|access[_-]?token)\s*[=:]\s*["']?\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) {
    throw new Error("Potential secret or personal information; re-curate and re-approve");
  }
  return { messages: [{ role: "user", content: example.prompt }, { role: "assistant", content: example.completion }],
    provenance: { workId: example.workId, artifactSha: example.artifactSha, verificationEventId: example.verificationEventId,
      acceptanceEventId: events.findLast(e => e.type === "work.accepted")?.id, contentSha256: example.contentSha256, approvedBy: example.approvedBy } };
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--repo", "--approvals", "--output"].includes(argv[i]) || !argv[i + 1]) throw new Error("Use --repo <repo> --approvals <operator-reviewed.json> --output <new-private-directory>");
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.repo || !args.approvals || !args.output) throw new Error("repo, approvals and output are required");
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: resolve(args.repo), encoding: "utf8" }).trim();
  const source = await readRepositoryWorkLedgers(common);
  if (source.unreadable.length) throw new Error("Unreadable source Ledger; no partial training corpus");
  const approvals = JSON.parse(await readFile(resolve(args.approvals), "utf8"));
  if (approvals.schema !== "rhiz/local-training-approvals/v1" || !Array.isArray(approvals.examples)) throw new Error("Invalid approval manifest");
  const accepted = []; const rejected = [];
  const seen = new Set();
  for (const example of approvals.examples) {
    try {
      if (seen.has(example.workId)) throw new Error("One example per Work; no split leakage or duplicated outcomes");
      seen.add(example.workId);
      const events = source.ledgers.flatMap(l => l.events.filter(e => e.workId === example.workId));
      accepted.push(approvedTrainingExample(example, events));
    } catch (error) { rejected.push({ workId: example?.workId ?? null, reason: error.message }); }
  }
  accepted.sort((a, b) => createHash("sha256").update(a.provenance.workId).digest("hex").localeCompare(createHash("sha256").update(b.provenance.workId).digest("hex")));
  const out = resolve(args.output);
  await mkdir(out, { mode: 0o700 }); // exclusive output: immutable experiment version
  const ready = rejected.length === 0 && accepted.length >= 40;
  const manifest = { schema: "rhiz/local-training-corpus/v1", status: ready ? "PREPARED_NOT_TRAINED" : "BLOCKED", generatedAt: new Date().toISOString(),
    approvedExamples: accepted.length, minimumExamples: 40, rejected, trainingStarted: false, modelPromoted: false,
    reason: ready ? "Compatibility, idle capacity, held-out comparison and promotion approval remain required" : "Insufficient approved accepted examples or rejected material; no dataset emitted" };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
  if (ready) {
    const heldout = Math.max(8, Math.floor(accepted.length * 0.2));
    const groups = { "test.jsonl": accepted.slice(0, heldout), "valid.jsonl": accepted.slice(heldout, heldout + 4), "train.jsonl": accepted.slice(heldout + 4) };
    for (const [name, rows] of Object.entries(groups)) await writeFile(join(out, name), rows.map(r => JSON.stringify({ messages: r.messages })).join("\n") + "\n", { mode: 0o600, flag: "wx" });
    await writeFile(join(out, "provenance.json"), JSON.stringify(accepted.map(r => r.provenance), null, 2), { mode: 0o600, flag: "wx" });
  }
  console.log(JSON.stringify(manifest, null, 2));
  if (!ready) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
