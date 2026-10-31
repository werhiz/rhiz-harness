import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_EXECUTION_ROOT_LIMITS, type FileSizeAllowance } from "../../src/workspace-digest.js";

// The test-only native reviewer runs on Darwin. Its two exact optional npm
// artifacts exceed the ordinary 256 MiB file bound. This is a size allowance,
// never an exclusion: the complete executable still enters the streamed hash,
// file count and unchanged aggregate byte budget. All other files retain the
// default bound, and an explicit caller maxFileBytes always takes precedence.
const NATIVE_ARTIFACTS = [
  { arch: "arm64", triple: "aarch64-apple-darwin", integrity: "sha512-YVXpg57itBuQxjofay3KDF5UbnZF4Y1ZmNFzUCz0ZQiQN+DndxOjN5V87rnXvPaC4qCPO2El74DzewoBP8JyPQ==" },
  { arch: "x64", triple: "x86_64-apple-darwin", integrity: "sha512-0/WHRhbUnM1wAjfyCO54Q8s4vQRxLVBbqW6XuQf7rZTEMTYPKRIQU9aPeRgjG653ZCSjtBrslWQ+G9urY9CksQ==" },
] as const;

// Eager artifact recognition must preserve the portable walk's no-link rule.
// Checking the leaf alone would follow a linked node_modules/package parent
// before the ordinary walker had a chance to refuse following it.
async function localRegularFile(root: string, path: string) {
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const info = await lstat(join(root, ...parts.slice(0, index + 1)));
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return undefined;
    if (index === parts.length - 1) return info;
  }
  return undefined;
}

async function nativeArtifactAllowance(root: string, path: string): Promise<FileSizeAllowance | undefined> {
  const artifact = NATIVE_ARTIFACTS.find(({ arch, triple }) => path === `node_modules/@openai/codex-darwin-${arch}/vendor/${triple}/bin/codex`);
  if (!artifact) return undefined;
  const alias = `@openai/codex-darwin-${artifact.arch}`, version = `0.162.1-darwin-${artifact.arch}`;
  const fixture = "test/fixtures/native-tools", owner = "@werhiz/native-review-test-tools";
  const paths = ["package.json", "package-lock.json", `${fixture}/package.json`, `node_modules/${alias}/package.json`];
  const bytes: Buffer[] = [];
  try {
    for (const item of paths) {
      const absolute = join(root, item), info = await localRegularFile(root, item), bound = item === "package-lock.json" ? 8 * 1024 * 1024 : 64 * 1024;
      if (!info || info.size > bound) return undefined;
      const chunks: Buffer[] = [], stream = createReadStream(absolute);
      let size = 0;
      try {
        for await (const chunk of stream) {
          size += (chunk as Buffer).byteLength;
          if (size > bound) return undefined;
          chunks.push(chunk as Buffer);
        }
      } finally { stream.destroy(); }
      bytes.push(Buffer.concat(chunks, size));
    }
    const declaration = JSON.parse(bytes[0]!.toString("utf8")), lock = JSON.parse(bytes[1]!.toString("utf8"));
    const fixtureManifest = JSON.parse(bytes[2]!.toString("utf8")), metadata = JSON.parse(bytes[3]!.toString("utf8"));
    const pin = `npm:@openai/codex@${version}`, locked = lock.packages?.[`node_modules/${alias}`];
    if (declaration.devDependencies?.[owner] !== `file:${fixture}` || lock.packages?.[""]?.devDependencies?.[owner] !== `file:${fixture}`
      || fixtureManifest.name !== owner || fixtureManifest.version !== "0.0.0" || fixtureManifest.optionalDependencies?.[alias] !== pin
      || lock.packages?.[fixture]?.dev !== true || lock.packages[fixture].optionalDependencies?.[alias] !== pin
      || locked?.name !== "@openai/codex" || locked.version !== version || locked.integrity !== artifact.integrity || locked.optional !== true || locked.dev !== true
      || metadata.name !== "@openai/codex" || metadata.version !== version
      || JSON.stringify(metadata.os) !== '["darwin"]' || JSON.stringify(metadata.cpu) !== JSON.stringify([artifact.arch])) return undefined;
    const hash = createHash("sha256");
    for (const [index, value] of bytes.entries()) { hash.update(paths[index]!); hash.update("\0"); hash.update(value); hash.update("\0"); }
    return { policy: "codex-0.162.1-darwin-native", path, maxFileBytes: 512 * 1024 * 1024, evidenceDigest: `sha256:${hash.digest("hex")}` };
  } catch (error) {
    if (error instanceof SyntaxError || (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) return undefined;
    throw error;
  }
}


/** Resolve only installed oversized native test artifacts; portable identity owns bounds/hashing. */
export async function resolveNativeArtifactAllowances(root: string): Promise<FileSizeAllowance[]> {
  root = await realpath(root);
  const result: FileSizeAllowance[] = [];
  for (const artifact of NATIVE_ARTIFACTS) {
    const path = `node_modules/@openai/codex-darwin-${artifact.arch}/vendor/${artifact.triple}/bin/codex`;
    try {
      const info = await localRegularFile(root, path);
      if (!info || info.size <= DEFAULT_EXECUTION_ROOT_LIMITS.maxFileBytes) continue;
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const allowance = await nativeArtifactAllowance(root, path);
    if (allowance) result.push(allowance);
  }
  return result;
}
