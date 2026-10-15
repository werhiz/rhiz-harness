import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function nativeReviewCandidate(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rhiz-native-review-test-")));
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root });
  git(["init", "-q", "-b", "main"]); git(["add", "."]);
  git(["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "fixture"]);
  return root;
}
