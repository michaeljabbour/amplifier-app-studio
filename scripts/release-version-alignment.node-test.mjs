import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const cargoManifest = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoLock = readFileSync(new URL("../src-tauri/Cargo.lock", import.meta.url), "utf8");
const tauriVersion = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).version;

const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lockedRustPackageVersion = cargoLock.match(
  /\[\[package\]\]\r?\nname = "amplifier-studio"\r?\nversion = "([^"]+)"/,
)?.[1];

test("release metadata agrees with the locked Rust package used to build Studio", () => {
  assert.match(packageVersion, /^\d+\.\d+\.\d+$/);
  assert.deepEqual({
    packageJson: packageVersion,
    cargoManifest: cargoVersion,
    cargoLock: lockedRustPackageVersion,
    tauriConfig: tauriVersion,
  }, {
    packageJson: packageVersion,
    cargoManifest: packageVersion,
    cargoLock: packageVersion,
    tauriConfig: packageVersion,
  });
});
