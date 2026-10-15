import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { invokeNativeReviewProcess } from "../adapters/codex/native-review.js";
import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import { requireProven, runDisposableProof, TempDirectoryDerivativeFactory } from "../src/disposable.js";
import { nativeReviewCandidate } from "./fixtures/native-review.js";

const execute = promisify(execFile);
const transport = new URL("../adapters/codex/native-review.js", import.meta.url).href;

// The cleanup channel belongs to this fixture, never a PID supplied by a model.
// All children also expire after two seconds, including when a falsifier fails.
async function channel() {
  let socket: Socket | undefined;
  let connected!: () => void, disconnected!: () => void;
  let readyTimer: NodeJS.Timeout;
  const ready = new Promise<void>((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error("fixture child did not connect")), 1000);
    connected = () => { clearTimeout(readyTimer); resolve(); };
  });
  const gone = new Promise<void>((resolve) => { disconnected = resolve; });
  const server = createServer((connection) => {
    assert.equal(socket, undefined); socket = connection;
    connection.once("data", connected);
    connection.once("close", disconnected);
    connection.on("error", () => {});
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) { clearTimeout(readyTimer!); throw error; }
  const address = server.address(); assert(address && typeof address === "object");
  return {
    ready, gone, port: address.port,
    alive: () => socket !== undefined && !socket.destroyed,
    async close() {
      clearTimeout(readyTimer);
      socket?.end("STOP");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function leader(port: number, mode: string): string {
  const descendant = `
    const net = require('node:net');
    process.on('SIGTERM', () => {});
    const socket = net.connect(${port}, '127.0.0.1', () => socket.write(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})));
    socket.on('data', () => process.exit(0));
    socket.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  `;
  return `
    import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    writeFileSync(new URL('./leader-identity.json', import.meta.url), JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),executable:process.execPath,source:import.meta.url}));
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      detached: ${mode !== "same-group"}, stdio: ${mode === "escaped-ignored" ? "'ignore'" : "['ignore', process.stdout, process.stderr]"}
    });
    writeFileSync(new URL('./descendant-identity.json', import.meta.url), JSON.stringify({pid:child.pid,startedAt:new Date().toISOString(),executable:process.execPath}));
    child.unref();
    ${mode.startsWith("exit-") || mode === "escaped-ignored" ? "" : "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 2000);"}
  `;
}

test("native transport bounds settlement separately from escaped descendant custody", async (t) => {
  const root = await nativeReviewCandidate({ "fixture.txt": "finite transport proof" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await runDisposableProof({
    candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(),
    proof: async (derivative) => {
      for (const mode of ["same-group", "escaped-inherited", "exit-inherited", "escaped-ignored"]) {
        const control = await channel();
        try {
          await derivative.mutate("leader.mjs", leader(control.port, mode), "plant finite child with fixture-owned cleanup channel");
          const start = performance.now();
          const result = invokeNativeReviewProcess(process.execPath, [derivative.resolve("leader.mjs")], derivative.root, {}, "", mode === "exit-inherited" ? 3000 : 200);
          const observed = result.then(() => "resolved", (error: Error) => error.message);
          await control.ready;
          const outcome = await observed;
          assert(performance.now() - start < 1400, `${mode}: settlement waited for the child's voluntary exit`);
          if (mode === "escaped-ignored") {
            assert.equal(outcome, "resolved");
            assert(control.alive(), "known descendant-custody gap must remain visible");
          } else {
            assert.match(outcome, mode === "exit-inherited" ? /transport did not drain/ : /timed out/);
            if (mode === "same-group") {
              await control.gone;
              assert(performance.now() - start < 1400, "same-group child reached voluntary expiry instead of escalation");
            } else assert(control.alive(), "pipe release is not escaped-child termination");
          }
        } finally { await control.close(); }
      }
      return true;
    },
  });
  requireProven(receipt);
});

test("native transport releases parent handles after an incomplete final drain", async (t) => {
  const root = await nativeReviewCandidate({ "fixture.txt": "handle release proof" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await runDisposableProof({
    candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(),
    proof: async (derivative) => {
      const control = await channel();
      try {
        await derivative.mutate("leader.mjs", leader(control.port, "exit-inherited"), "plant inherited pipes in a finite escaped child");
        await derivative.mutate("host.mjs", `
          import {invokeNativeReviewProcess} from ${JSON.stringify(transport)};
          await invokeNativeReviewProcess(process.execPath, [${JSON.stringify(derivative.resolve("leader.mjs"))}], ${JSON.stringify(derivative.root)}, {}, '', 3000)
            .then(() => console.log('resolved'), () => console.log('refused'));
        `, "observe host event-loop release independently from promise settlement");
        const start = performance.now();
        const host = execute(process.execPath, [derivative.resolve("host.mjs")], { env: {} });
        await control.ready;
        assert.equal((await host).stdout.trim(), "refused");
        assert(performance.now() - start < 1400, "parent handles outlived bounded settlement");
        assert(control.alive(), "test watchdog did not terminate the escaped child");
      } finally { await control.close(); }
      return true;
    },
  });
  requireProven(receipt);
});

test("native transport retains complete output and first failure across terminal races", async (t) => {
  const root = await nativeReviewCandidate({ "fixture.txt": "transport terminal controls" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await runDisposableProof({
    candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(),
    proof: async (derivative) => {
      const run = (source: string, input = "", timeout = 2000) => invokeNativeReviewProcess(process.execPath, ["-e", source], derivative.root, {}, input, timeout);
      assert.deepEqual(await run("process.stdout.write('complete');process.stderr.write('diagnostic')"), { stdout: "complete", stderr: "diagnostic" });
      await assert.rejects(run("process.exit(7)"), /did not complete successfully/);
      await assert.rejects(invokeNativeReviewProcess(derivative.resolve("missing"), [], derivative.root, {}, "", 2000), /process unavailable/);
      await assert.rejects(run("process.stdin.destroy();setTimeout(()=>{},1000)", "x".repeat(4 * 1024 * 1024)), /input failed/);
      for (const stream of ["stdout", "stderr"]) {
        await assert.rejects(run(`process.${stream}.on('error',()=>{});process.${stream}.write('x'.repeat(20*1024*1024));setTimeout(()=>{},1000)`), /exceeded bound/);
      }
      let settlements = 0;
      await run("setTimeout(()=>process.exit(0),10)", "", 10).then(() => settlements++, () => settlements++);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(settlements, 1);
      return true;
    },
  });
  requireProven(receipt);
});
