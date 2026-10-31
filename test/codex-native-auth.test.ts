import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";
import test from "node:test";
import { GitCandidateIdentityProbe } from "../adapters/git/candidate-identity.js";
import { requireProven, runDisposableProof, TempDirectoryDerivativeFactory } from "../src/disposable.js";
import { nativeReviewCandidate, nativeReviewExecutable } from "./fixtures/native-review.js";

function dummyAuth(expired: boolean, refresh: string) {
  const jwt = (expire: boolean) => "e30." + Buffer.from(JSON.stringify({
    email: "fixture@example.invalid", exp: Math.floor(Date.now() / 1000) + (expire ? -3600 : 3600),
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_user_id: "fixture-user", chatgpt_plan_type: "pro" },
  })).toString("base64url") + ".dummy";
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {
    id_token: jwt(false), access_token: jwt(expired), refresh_token: refresh, account_id: "fixture-account",
  }, last_refresh: new Date().toISOString() };
}

async function nativeClient(executable: string, root: string, home: string, endpoint: string) {
  const child = spawn(executable, ["app-server", "--stdio", "-c", 'cli_auth_credentials_store="file"',
    "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "features.hooks=false"], {
    cwd: root, env: { HOME: root, CODEX_HOME: home, PATH: "/usr/bin:/bin", CODEX_REFRESH_TOKEN_URL_OVERRIDE: endpoint },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close"); void closed.catch(() => {});
  const pending = new Map<number, { resolve: (value: { authMethod?: string }) => void; reject: (error: Error) => void }>();
  const fail = () => { for (const item of pending.values()) item.reject(new Error("dummy native RPC interrupted")); pending.clear(); };
  const timeout = setTimeout(() => { fail(); child.kill("SIGKILL"); }, 15_000);
  const lines = readline.createInterface({ input: child.stdout });
  let next = 0, bytes = 0;
  child.stderr.resume(); child.stdin.on("error", fail); child.on("error", fail); child.on("close", fail);
  lines.on("line", (line) => {
    bytes += Buffer.byteLength(line);
    if (bytes > 1024 * 1024) { fail(); child.kill("SIGKILL"); return; }
    try {
      const response = JSON.parse(line);
      if (response.id === undefined) return;
      const item = pending.get(response.id); if (!item) { fail(); return; }
      pending.delete(response.id);
      response.error ? item.reject(new Error("dummy native RPC refused")) : item.resolve(response.result);
    } catch { fail(); child.kill("SIGKILL"); }
  });
  const rpc = (method: string, params: unknown) => new Promise<{ authMethod?: string }>((yes, no) => {
    pending.set(++next, { resolve: yes, reject: no });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
  });
  const close = async () => { clearTimeout(timeout); lines.close(); child.kill("SIGKILL"); await closed.catch(() => {}); };
  try {
    await rpc("initialize", { clientInfo: { name: "dummy-auth-proof", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    return { rpc, close };
  } catch (error) { await close(); throw error; }
}

test("installed native auth alias preserves dummy refresh, replacement and concurrent file custody",
  { skip: process.platform !== "darwin", timeout: 60_000 }, async (t) => {
  const root = await nativeReviewCandidate({ "fixture.txt": "dummy credentials only" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const receipt = await runDisposableProof({
    candidateRoot: root, probe: new GitCandidateIdentityProbe(), factory: new TempDirectoryDerivativeFactory(),
    proof: async (derivative) => {
      const executable = await nativeReviewExecutable(derivative.root);
      const original = derivative.resolve("original"), aliases = [derivative.resolve("alias-a"), derivative.resolve("alias-b")];
      for (const directory of [original, ...aliases]) await mkdir(directory, { mode: 0o700 });
      const file = join(original, "auth.json");
      for (const alias of aliases) await symlink(file, join(alias, "auth.json"));
      let reject = false, generation = 0, invalidRequest = false;
      let calls: string[] = [];
      const used = new Set<string>(), issued = new Map<string, ReturnType<typeof dummyAuth>["tokens"]>();
      const server = createServer(async (request, response) => {
        let body = "";
        try {
          if (request.method !== "POST" || request.url !== "/token") throw new Error("unexpected endpoint");
          for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error("oversize request"); }
          const token = JSON.parse(body).refresh_token as string;
          calls.push(token);
          if (typeof token !== "string" || !token.startsWith("dummy-")) { invalidRequest = true; throw new Error("unexpected credential"); }
          response.setHeader("Content-Type", "application/json");
          if (reject || used.has(token)) { response.writeHead(400); response.end(JSON.stringify({ error: { code: "refresh_token_reused" } })); return; }
          used.add(token);
          const next = "dummy-issued-" + ++generation;
          const auth = dummyAuth(false, next);
          issued.set(next, auth.tokens);
          setTimeout(() => response.end(JSON.stringify({ ...auth.tokens })), 25);
        } catch { invalidRequest = true; response.writeHead(400); response.end("{}"); }
      });
      await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
      const address = server.address(); assert(address && typeof address !== "string");
      const endpoint = `http://127.0.0.1:${address.port}/token`;
      try {
        for (const mode of ["unexpired", "refresh", "reject", "replacement", "concurrent-canonical", "concurrent-aliases"]) {
          reject = mode === "reject"; calls = []; used.clear(); issued.clear();
          const seed = "dummy-seed-" + mode, bytes = JSON.stringify(dummyAuth(mode !== "unexpired", seed));
          await writeFile(mode === "replacement" ? file + ".new" : file, bytes, { mode: 0o600 });
          if (mode === "replacement") await rename(file + ".new", file);
          await chmod(file, 0o600);
          const inode = (await lstat(file)).ino;
          const homes = mode === "unexpired" ? [original, aliases[0]!] : mode === "concurrent-canonical" ? [original, original]
            : mode === "concurrent-aliases" ? aliases : [aliases[0]!];
          const clients: Awaited<ReturnType<typeof nativeClient>>[] = [];
          try {
            const starts = await Promise.allSettled(homes.map(async (home) => clients.push(await nativeClient(executable, derivative.root, home, endpoint))));
            assert(starts.every((result) => result.status === "fulfilled"), "all dummy native clients must initialize");
            const results = await Promise.all(clients.map((client) => client.rpc("getAuthStatus", { includeToken: false, refreshToken: mode !== "unexpired" })));
            if (mode === "unexpired") { assert.equal(calls.length, 0); assert(results.every((value) => value.authMethod === "chatgpt")); }
            else {
              assert(calls.length > 0 && calls.length <= 12); assert.equal(calls[0], seed);
              if (reject) assert.equal(await readFile(file, "utf8"), bytes, "HTTP rejection cannot corrupt the canonical dummy file");
              else {
                const saved = JSON.parse(await readFile(file, "utf8")).tokens.refresh_token;
                assert(issued.has(saved) && !used.has(saved), "saved refresh token must be issued and still usable");
                assert.deepEqual(JSON.parse(await readFile(file, "utf8")).tokens, issued.get(saved));
              }
            }
            assert.equal((await lstat(file)).ino, inode);
            for (const alias of aliases) { assert((await lstat(join(alias, "auth.json"))).isSymbolicLink()); assert.equal(await realpath(join(alias, "auth.json")), await realpath(file)); }
          } finally { await Promise.all(clients.map((client) => client.close())); }
        }
        assert.equal(invalidRequest, false);
        return true;
      } finally { server.closeAllConnections(); await new Promise<void>((yes) => server.close(() => yes())); }
    },
  });
  assert.equal(requireProven(receipt), true);
});
