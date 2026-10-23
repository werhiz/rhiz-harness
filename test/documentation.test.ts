import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { parseWorkContract } from "../src/index.js";

const read = (file: string): string => readFileSync(resolve(file), "utf8");
const entryPoints = ["README.md", "docs/README.md", "docs/GETTING_STARTED.md", "docs/COMPATIBILITY.md", "docs/OPEN_SOURCE_RELEASE_CHECKLIST.md", "docs/EXAMPLES.md", "docs/PROVENANCE.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "docs/API_REFERENCE.md", "docs/TROUBLESHOOTING.md", "docs/REPOSITORY_WORK_RUNNER.md", "docs/SECURITY_MODEL.md"];

test("getting-started command executes the actual documented Work contract without a worker", () => {
  const guide = read("docs/GETTING_STARTED.md");
  const command = guide.match(/node --input-type=module <<'JS'\n([\s\S]*?)\nJS/);
  assert(command, "Missing executable first contract example");
  const output = execFileSync(process.execPath, ["--input-type=module"], { input: command[1], encoding: "utf8" });
  assert.equal(output.trim(), "work:example-message: SHIP");
  const examples = [...read("docs/EXAMPLES.md").matchAll(/```json\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]!));
  const workExamples = examples.filter(value => value.type === "SHIP" || value.type === "SCOUT");
  assert.equal(workExamples.length, 2);
  for (const example of workExamples) {
    assert.equal(parseWorkContract(example).id, example.id);
    assert.throws(() => parseWorkContract({ ...example, type: "INVALID_WORK_TYPE" }));
  }
});

test("current setup docs follow package and CI pins, scripts and relative destinations", () => {
  const pkg = JSON.parse(read("package.json"));
  const nodePin = read(".node-version").trim();
  const npmPin = pkg.packageManager.split("@")[1];
  for (const file of ["README.md", "docs/GETTING_STARTED.md", "docs/COMPATIBILITY.md"]) {
    assert(read(file).includes(nodePin), `${file} lost the CI Node pin`);
    assert(read(file).includes(npmPin), `${file} lost the npm pin`);
  }
  for (const file of entryPoints) {
    const content = read(file);
    assert.doesNotMatch(content, /current(?:ly)?(?: in)? private(?:[- ]pre-alpha)?[- ]dogfood|during private dogfood|during pre-alpha|eventual open-source release|before the public open-source release/i);
    for (const match of content.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
      assert(pkg.scripts[match[1]!], `${file} names missing script ${match[1]}`);
    }
    const prose = content.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
    for (const match of prose.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      const destination = match[1]!.split("#")[0]!;
      if (!destination || /^[a-z]+:/i.test(destination)) continue;
      assert(existsSync(resolve(dirname(file), destination)), `${file} has broken link ${destination}`);
    }
  }
});

test("public source status is not confused with the npm publication guard", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.private, true, "Reconcile source-only alpha docs in the package publication change");
  assert.equal(pkg.license, "Apache-2.0");
  for (const file of ["README.md", "docs/README.md", "docs/GETTING_STARTED.md", "docs/COMPATIBILITY.md", "CONTRIBUTING.md", "docs/API_REFERENCE.md", "docs/TROUBLESHOOTING.md"]) {
    const content = read(file).replaceAll("**", "");
    assert.match(content, /public[- ]alpha/i, `${file} must reflect the source release`);
    assert.match(content, /unpublished|not published/i, `${file} must state distribution limits`);
    assert.doesNotMatch(content, /active private dogfood and pre-alpha|public open-source release boundary has not been crossed|being prepared for open-source release/);
  }
});
