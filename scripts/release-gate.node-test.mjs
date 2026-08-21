import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function runGate(env) {
  try {
    return {
      ok: true,
      out: execFileSync("node", ["scripts/check-release-version.mjs"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...env },
      }),
    };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

// Regression: Dependabot cannot bump the app version, so requiring the version to advance made
// every dependency pull request permanently unmergeable. Twelve piled up failing this check,
// including trivial GitHub Action bumps, which is how it surfaced.
test("a dependency branch is exempt from the version-advance requirement", () => {
  const result = runGate({
    RELEASE_BASE_REF: "origin/main",
    RELEASE_HEAD_REF: "dependabot/npm_and_yarn/marked-18.0.9",
    GITHUB_ACTOR: "dependabot[bot]",
  });
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /skipping the version-advance check/);
  // The consistency half must still run: a dependency PR may not leave the files disagreeing.
  assert.match(result.out, /are consistent/);
});

test("the bot actor alone is enough, whatever the branch is called", () => {
  const result = runGate({
    RELEASE_BASE_REF: "origin/main",
    RELEASE_HEAD_REF: "some/other/branch",
    GITHUB_ACTOR: "dependabot[bot]",
  });
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /skipping the version-advance check/);
});

/**
 * A ref whose package.json matches the working tree, so "same version" means the same version.
 *
 * This test used HEAD, which is only equivalent while the tree is clean. Bumping the version and
 * then running the suite -- the natural order -- left the tree one version ahead of HEAD, so the
 * gate correctly reported an advance and this negative assertion flipped to a phantom failure.
 * `git stash create` writes a throwaway commit of the tracked working tree without touching the
 * index, checkout, or stash list, and prints nothing when there is nothing to stash.
 */
function refMatchingWorkingTree() {
  const stashed = execFileSync("git", ["stash", "create"], { cwd: root, encoding: "utf8" }).trim();
  return stashed || "HEAD";
}

// The exemption must not become a way for a human change to skip the bump.
test("a human branch at the same version as main is still rejected", () => {
  const result = runGate({
    RELEASE_BASE_REF: refMatchingWorkingTree(),
    RELEASE_HEAD_REF: "fix/something",
    GITHUB_ACTOR: "michaeljabbour",
  });
  assert.equal(result.ok, false, "comparing against itself must fail the advance check");
  assert.match(result.out, /must advance from/);
});
