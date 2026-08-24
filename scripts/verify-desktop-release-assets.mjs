#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyDesktopInstallerAssets } from "./desktop-release-assets.mjs";

export function verifyDesktopReleaseDirectory(assetDirectory) {
  const assets = readdirSync(assetDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  return verifyDesktopInstallerAssets(assets);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [assetDirectory] = process.argv.slice(2);
  if (!assetDirectory) {
    throw new Error("Usage: node scripts/verify-desktop-release-assets.mjs ASSET_DIRECTORY");
  }
  const verified = verifyDesktopReleaseDirectory(assetDirectory);
  for (const [label, asset] of Object.entries(verified)) {
    console.log(`${label}: ${asset}`);
  }
}
