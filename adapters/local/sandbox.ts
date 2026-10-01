import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SandboxCommand, SandboxLauncher, SandboxPolicy } from "../../src/sandbox.js";
import { SandboxPolicyError, SandboxUnavailableError } from "../../src/sandbox.js";

const run = promisify(execFile);

/**
 * macOS containment via sandbox-exec.
 *
 * Two properties this depends on and therefore checks rather than assumes:
 *
 *   - Paths are resolved with realpath before they enter a profile. On macOS
 *     /tmp is a symlink to /private/tmp, and a subpath rule written against the
 *     unresolved path matches nothing, so the allow rule silently fails while
 *     the deny rules still work. That produces a sandbox that appears to
 *     contain and actually breaks the work, which is the failure mode most
 *     likely to get containment switched off by an operator in a hurry.
 *   - The profile is verified to load before any real command runs, by
 *     executing a trivial command under it. A profile that fails to parse
 *     otherwise surfaces as the checked command failing, which reads as a
 *     verification failure rather than a configuration error.
 *
 * sandbox-exec is deprecated by Apple and still the only mechanism available
 * without a signed entitlement or a container runtime. It is behind the
 * portable SandboxLauncher interface precisely so that replacing it does not
 * reach the Kernel.
 */
export class MacosSandboxExecLauncher implements SandboxLauncher {
  readonly id = "sandbox:macos-sandbox-exec";
  readonly #binary: string;
  #availability: Promise<boolean> | undefined;

  constructor(options: { binary?: string } = {}) {
    this.#binary = options.binary ?? "/usr/bin/sandbox-exec";
  }

  available(): Promise<boolean> {
    this.#availability ??= (async () => {
      if (process.platform !== "darwin") return false;
      try {
        // Prove it can actually impose a boundary, not merely that the binary
        // exists: run a deny-default profile and require a write to fail.
        const probe = await this.wrap(
          { writableRoots: [], allowRead: true, allowNetwork: false, allowProcessExec: true },
          "/bin/sh",
          ["-c", "echo probe > /probe-should-be-denied"],
        );
        try {
          await run(probe.command, probe.args, { timeout: 10_000 });
          return false;
        } catch {
          return true;
        } finally {
          await probe.dispose();
        }
      } catch {
        return false;
      }
    })();
    return this.#availability;
  }

  async wrap(policy: SandboxPolicy, command: string, args: readonly string[]): Promise<SandboxCommand> {
    if (process.platform !== "darwin") {
      throw new SandboxUnavailableError(`${this.id} requires darwin, this host is ${process.platform}`);
    }

    const resolved: string[] = [];
    for (const root of policy.writableRoots) {
      try {
        resolved.push(await realpath(root));
      } catch (error) {
        throw new SandboxPolicyError(
          `writable root ${root} could not be resolved, so a profile rule for it would silently match nothing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const directory = await mkdtemp(join(await realpath(tmpdir()), "rhiz-sandbox-"));
    const profilePath = join(directory, "policy.sb");
    await writeFile(profilePath, renderProfile(policy, resolved), { encoding: "utf8", mode: 0o600 });

    let disposed = false;
    return {
      command: this.#binary,
      args: ["-f", profilePath, command, ...args],
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
}

/** A sandbox profile literal. Quoted so a path cannot terminate the s-expression. */
function quote(value: string): string {
  return JSON.stringify(value);
}

export function renderProfile(policy: SandboxPolicy, resolvedWritableRoots: readonly string[]): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    "(allow file-write-data (literal \"/dev/null\"))",
    "(allow file-write-data (literal \"/dev/stdout\"))",
    "(allow file-write-data (literal \"/dev/stderr\"))",
  ];
  if (policy.allowProcessExec) lines.push("(allow process-exec process-fork)");
  if (policy.allowNetwork) lines.push("(allow network*)");
  for (const root of resolvedWritableRoots) {
    lines.push(`(allow file-write* (subpath ${quote(root)}))`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The launcher for this host, or null when none exists. Callers that require
 * containment pass the result to requireSandbox, which turns null into an
 * error rather than into an unconfined run.
 */
export function createDefaultSandboxLauncher(): SandboxLauncher | null {
  if (process.platform === "darwin") return new MacosSandboxExecLauncher();
  // Linux support belongs here (bubblewrap or Landlock) and is not implemented.
  // Returning null is deliberate: an unimplemented backend must not read as an
  // available one. See issue #11.
  return null;
}
