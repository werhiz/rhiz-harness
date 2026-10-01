/**
 * A proof that never finishes, so its parent can kill it at the dangerous
 * boundary: after the mutation exists and before anything has cleaned up.
 *
 * It prints one JSON line the instant the mutation has been written into the
 * derivative. Everything the parent does is triggered by that line, so the kill
 * lands at a known point rather than at a hopeful sleep.
 *
 * argv: <candidateRoot> <reapRoot> <mode>
 *   hang    - mutate, announce, then never resolve. The parent kills it.
 *   cancel  - the same, plus a SIGINT handler that aborts and exits from inside
 *             the handler, so nothing queued after the abort ever runs.
 */
import { GitCandidateIdentityProbe } from "../../adapters/git/candidate-identity.js";
import { runDisposableProof, TempDirectoryDerivativeFactory } from "../../src/disposable.js";

const candidateRoot = process.argv[2];
const reapRoot = process.argv[3];
const mode = process.argv[4] ?? "hang";
if (!candidateRoot || !reapRoot) throw new Error("candidateRoot and reapRoot arguments are required");

const controller = new AbortController();
if (mode === "cancel") {
  process.on("SIGINT", () => {
    controller.abort(new Error("operator cancelled"));
    // Exit synchronously from the handler. No microtask, no `finally`, no
    // cleanup. This is what cancelling a stalled worker actually looks like,
    // and the reason cleanup cannot be where the safety lives.
    process.exit(130);
  });
}

const receipt = await runDisposableProof<string>({
  candidateRoot,
  probe: new GitCandidateIdentityProbe(),
  factory: new TempDirectoryDerivativeFactory({ reapRoot }),
  signal: controller.signal,
  mutate: async (derivative) => {
    await derivative.mutate("src/board.ts", "export const acceptable = true;\n", "RH-14 canary mutation");
    process.stdout.write(`${JSON.stringify({
      phase: "mutated",
      pid: process.pid,
      derivativeRoot: derivative.root,
    })}\n`);
  },
  // A ref'd timer, not a bare unresolved promise: Node detects a top-level
  // await that can never settle and exits 13 on its own, which would end the
  // process before the parent's signal or timeout could land on it. The proof
  // has to genuinely hang for the kill to happen at the boundary.
  proof: () => new Promise<string>(() => { setInterval(() => undefined, 60_000); }),
});

process.stdout.write(`${JSON.stringify({ phase: "finished", outcome: receipt.outcome })}\n`);
