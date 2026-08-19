import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(repositoryRoot, "src-tauri", "windows-store", "Package.appxmanifest.template.xml");
const requiredAssets = ["Square150x150Logo.png", "Square44x44Logo.png", "StoreLogo.png"];

export function windowsStorePackageVersion(marketingVersion, buildNumber) {
  if (!/^\d+\.\d+\.\d+$/.test(marketingVersion)) {
    throw new Error(`Windows Store marketing version must be MAJOR.MINOR.PATCH; found ${marketingVersion}`);
  }
  if (!/^\d+$/.test(String(buildNumber)) || Number(buildNumber) < 1 || Number(buildNumber) > 65_535) {
    throw new Error(`Windows Store build number must be 1-65535; found ${buildNumber}`);
  }
  const segments = marketingVersion.split(".").map(Number);
  if (segments.some((segment) => segment > 65_535)) {
    throw new Error(`Windows Store version segments must not exceed 65535; found ${marketingVersion}`);
  }
  return `${marketingVersion}.${buildNumber}`;
}

export function renderWindowsStoreManifest({ identityName, publisherId, publisherDisplayName, packageVersion }) {
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName || "")) {
    throw new Error("WINDOWS_STORE_IDENTITY_NAME must be the exact 3-50 character Package/Identity/Name from Partner Center");
  }
  if (!/^CN=.+/.test(publisherId || "")) {
    throw new Error("WINDOWS_STORE_PUBLISHER_ID must be the exact CN=... Publisher value from Partner Center");
  }
  if (!(publisherDisplayName || "").trim()) {
    throw new Error("WINDOWS_STORE_PUBLISHER_DISPLAY_NAME is required");
  }
  const escapeXml = (value) => value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const replacements = new Map([
    ["__IDENTITY_NAME__", identityName],
    ["__PUBLISHER_ID__", publisherId],
    ["__PUBLISHER_DISPLAY_NAME__", publisherDisplayName],
    ["__PACKAGE_VERSION__", packageVersion],
  ]);
  let manifest = readFileSync(templatePath, "utf8");
  for (const [token, value] of replacements) manifest = manifest.replaceAll(token, escapeXml(value));
  if (/__[A-Z0-9_]+__/.test(manifest)) throw new Error("Windows Store manifest contains an unresolved token");
  return manifest;
}

export function prepareWindowsStorePackage({ executablePath, stagePath, env = process.env }) {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const tauri = JSON.parse(readFileSync(join(repositoryRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const packageVersion = windowsStorePackageVersion(packageJson.version, tauri.bundle.iOS.bundleVersion);
  const stage = resolve(stagePath);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "Assets"), { recursive: true });
  copyFileSync(resolve(executablePath), join(stage, "amplifier-studio.exe"));
  for (const asset of requiredAssets) {
    copyFileSync(join(repositoryRoot, "src-tauri", "icons", asset), join(stage, "Assets", asset));
  }
  writeFileSync(join(stage, "Package.appxmanifest"), renderWindowsStoreManifest({
    identityName: env.WINDOWS_STORE_IDENTITY_NAME,
    publisherId: env.WINDOWS_STORE_PUBLISHER_ID,
    publisherDisplayName: env.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME,
    packageVersion,
  }));
  return { packageVersion, stage, executable: basename(executablePath) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , executablePath, stagePath] = process.argv;
  if (!executablePath || !stagePath) {
    throw new Error("Usage: node scripts/prepare-windows-store-package.mjs <amplifier-studio.exe> <stage-directory>");
  }
  const prepared = prepareWindowsStorePackage({ executablePath, stagePath });
  console.log(JSON.stringify(prepared));
}
