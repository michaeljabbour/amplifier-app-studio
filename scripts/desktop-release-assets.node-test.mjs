import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveDesktopUpdaterAssets,
  verifyDesktopInstallerAssets,
} from "./desktop-release-assets.mjs";
import { verifyDesktopReleaseDirectory } from "./verify-desktop-release-assets.mjs";

const completeAssets = [
  "Amplifier.Studio_0.1.72_aarch64.dmg",
  "Amplifier.Studio_0.1.72_aarch64.app.tar.gz",
  "Amplifier.Studio_0.1.72_aarch64.app.tar.gz.sig",
  "Amplifier.Studio_0.1.72_x64.dmg",
  "Amplifier.Studio_0.1.72_x64.app.tar.gz",
  "Amplifier.Studio_0.1.72_x64.app.tar.gz.sig",
  "Amplifier.Studio_0.1.72_x64_en-US.msi",
  "Amplifier.Studio_0.1.72_x64-setup.exe",
  "Amplifier.Studio_0.1.72_x64-setup.exe.sig",
  "Amplifier.Studio_0.1.72_amd64.AppImage",
  "Amplifier.Studio_0.1.72_amd64.AppImage.sig",
];

test("desktop release inventory requires every supported installer", () => {
  const verified = verifyDesktopInstallerAssets(completeAssets);
  assert.equal(Object.keys(verified).length, 5);
  assert.match(verified["Windows x64 MSI"], /\.msi$/);
  assert.match(verified["macOS Intel x64 DMG"], /_x64\.dmg$/);
});

test("updater inventory covers macOS arm and x64, Windows x64, and Linux x64", () => {
  const resolved = resolveDesktopUpdaterAssets(completeAssets);
  assert.deepEqual(Object.keys(resolved), [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "linux-x86_64",
  ]);
  assert.equal(resolved["windows-x86_64"].asset.endsWith("-setup.exe"), true);
});

test("a release missing the Windows MSI is rejected", () => {
  assert.throws(
    () => verifyDesktopInstallerAssets(completeAssets.filter((asset) => !asset.endsWith(".msi"))),
    /Windows x64 MSI requires exactly one asset; found none/,
  );
});

test("a release missing an updater signature is rejected", () => {
  assert.throws(
    () => resolveDesktopUpdaterAssets(completeAssets.filter((asset) => !asset.endsWith("AppImage.sig"))),
    /AppImage\.sig is missing/,
  );
});

test("the directory verifier ignores subdirectories and accepts the complete release", () => {
  const directory = mkdtempSync(join(tmpdir(), "studio-desktop-release-"));
  for (const asset of completeAssets) writeFileSync(join(directory, asset), "fixture");
  assert.equal(Object.keys(verifyDesktopReleaseDirectory(directory)).length, 5);
});
