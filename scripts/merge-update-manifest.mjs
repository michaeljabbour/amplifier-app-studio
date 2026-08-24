import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveDesktopUpdaterAssets } from "./desktop-release-assets.mjs";

const [tag, assetDirectory] = process.argv.slice(2);
if (!tag || !assetDirectory) {
  throw new Error("Usage: node scripts/merge-update-manifest.mjs TAG ASSET_DIRECTORY");
}

const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error("GITHUB_REPOSITORY is required");
if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must use the owner/repository form");
}
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (tag !== `studio-v${version}`) {
  throw new Error(`Tag ${tag} does not match package version ${version}`);
}

const assets = readdirSync(assetDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
const platforms = {};
for (const [platform, resolved] of Object.entries(resolveDesktopUpdaterAssets(assets))) {
  const { asset, signature: signatureAsset } = resolved;
  const signaturePath = join(assetDirectory, signatureAsset);
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) throw new Error(`${basename(signaturePath)} is empty`);
  platforms[platform] = {
    signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  };
}

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES || "Amplifier Studio update",
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(assetDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Merged updater manifest for ${Object.keys(platforms).join(", ")}`);
