import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  RELEASE_VERSION_PATTERN,
  readReleaseMetadata,
  releaseFilePath,
  releaseFiles,
} from "./release-metadata.mjs";

test("release metadata agrees across every version-bearing file", () => {
  const { version, versions, build, buildNumbers } = readReleaseMetadata();
  assert.match(version, RELEASE_VERSION_PATTERN);
  assert.match(build, /^\d+$/);
  for (const [file, observed] of versions) {
    assert.equal(observed, version, `${file} must carry ${version}`);
  }
  for (const [file, observed] of buildNumbers) {
    assert.equal(String(observed), build, `${file} must carry build ${build}`);
  }
});

test("the shared release file table is complete and every path is tracked in the tree", () => {
  assert.deepEqual(Object.values(releaseFiles), [
    "package.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "src-tauri/gen/apple/amplifier-studio_iOS/Info.plist",
    "src-tauri/gen/apple/project.yml",
  ]);
  for (const key of Object.keys(releaseFiles)) {
    assert.ok(existsSync(releaseFilePath(key)), `${releaseFiles[key]} must exist`);
  }
});

test("release parsing is shared without changing patch-bump formatting", async () => {
  const { nextPatch } = await import("./bump-version.mjs");
  assert.equal(nextPatch("01.02.03"), "01.02.4");
});
