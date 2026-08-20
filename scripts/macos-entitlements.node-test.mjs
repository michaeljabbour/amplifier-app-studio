import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(repositoryRoot, "src-tauri");
const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));

// Regression: the bundle config had no macOS section at all, so notarized builds were signed
// under the Hardened Runtime with zero entitlements and the microphone was denied. Voice input
// worked in every unsigned local build, so nothing caught it before upload.
test("signed macOS builds declare the microphone entitlement voice input needs", () => {
  const entitlements = conf.bundle?.macOS?.entitlements;
  assert.ok(entitlements, "tauri.conf.json bundle.macOS.entitlements must be set");

  const entitlementsPath = join(tauriDir, entitlements);
  assert.ok(existsSync(entitlementsPath), `${entitlements} is referenced but missing`);

  const plist = readFileSync(entitlementsPath, "utf8");
  assert.match(plist, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
});

// The entitlement alone is not enough: macOS also refuses the prompt without a purpose string.
test("macOS Info.plist explains why Studio wants the microphone", () => {
  const infoPlist = readFileSync(join(tauriDir, "Info.plist"), "utf8");
  assert.match(infoPlist, /<key>NSMicrophoneUsageDescription<\/key>/);
  const purpose = infoPlist.match(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]+)<\/string>/);
  assert.ok(purpose && purpose[1].trim().length > 20, "purpose string must be a real explanation");
});
