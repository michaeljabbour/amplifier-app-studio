import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { current, nextPatch } from "./bump-version.mjs";

test("patch bumps advance only the patch component", () => {
  assert.equal(nextPatch("0.1.52"), "0.1.53");
  assert.equal(nextPatch("0.1.9"), "0.1.10");
  assert.equal(nextPatch("1.0.0"), "1.0.1");
  assert.throws(() => nextPatch("0.1"), /MAJOR.MINOR.PATCH/);
  assert.throws(() => nextPatch("0.1.2-rc1"), /MAJOR.MINOR.PATCH/);
});

// The point of the script: the release gate compares seven files, and a hand-edit that misses one
// reds all three CI runners. This proves the two the script reports are the two the gate reads.
test("current() reports the version and mobile build the release gate compares", () => {
  const { version, build } = current();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(build, /^\d+$/);
});


test("help and invalid options never advance release metadata", () => {
  const before = current();
  const help = execFileSync(process.execPath, ["scripts/bump-version.mjs", "--help"], { encoding: "utf8" });
  assert.match(help, /Usage:/);
  assert.throws(() => execFileSync(process.execPath, ["scripts/bump-version.mjs", "--invalid"], { stdio: "pipe" }));
  assert.deepEqual(current(), before);
});
