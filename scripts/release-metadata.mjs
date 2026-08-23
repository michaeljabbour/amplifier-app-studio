// One definition of a Studio release version, its mobile build number, and every file that
// carries those values. Release gates, bumpers, packagers, and tests must all read this module so
// their coverage cannot silently drift apart.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Repo-relative paths of every file that carries the release version. Order is report order. */
export const releaseFiles = Object.freeze({
  packageJson: "package.json",
  cargoManifest: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
  tauriConfig: "src-tauri/tauri.conf.json",
  iosInfoPlist: "src-tauri/gen/apple/amplifier-studio_iOS/Info.plist",
  iosProject: "src-tauri/gen/apple/project.yml",
});

export function releaseFilePath(key, root = repositoryRoot) {
  const relativePath = releaseFiles[key];
  if (!relativePath) throw new Error(`Unknown release file ${key}`);
  return join(root, relativePath);
}

/** A release version is MAJOR.MINOR.PATCH and nothing else. */
export const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function releaseVersionParts(value, label = "Release version") {
  const match = RELEASE_VERSION_PATTERN.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} must be MAJOR.MINOR.PATCH; found ${value || "missing"}`);
  return match.slice(1);
}

export function releaseVersionTuple(value, label = "Release version") {
  return releaseVersionParts(value, label).map(Number);
}

export function compareReleaseVersions(left, right) {
  const a = releaseVersionTuple(left);
  const b = releaseVersionTuple(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function assertMobileBuildNumber(value, { label = "Mobile build number", max } = {}) {
  const build = String(value ?? "");
  const range = max ? `1-${max}` : "a positive integer";
  if (!/^\d+$/.test(build) || Number(build) < 1 || (max && Number(build) > max)) {
    throw new Error(`${label} must be ${range}; found ${build || "missing"}`);
  }
  return build;
}

/** Read every version-bearing file once and report what each one claims. */
export function readReleaseMetadata(root = repositoryRoot) {
  const read = (key) => readFileSync(releaseFilePath(key, root), "utf8");
  const packageJson = JSON.parse(read("packageJson"));
  const cargoManifest = read("cargoManifest");
  const cargoLock = read("cargoLock");
  const tauriConfig = JSON.parse(read("tauriConfig"));
  const iosInfoPlist = read("iosInfoPlist");
  const iosProject = read("iosProject");

  const versions = new Map([
    [releaseFiles.packageJson, packageJson.version],
    [releaseFiles.cargoManifest, cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1]],
    [
      releaseFiles.cargoLock,
      cargoLock.match(/\[\[package\]\]\r?\nname = "amplifier-studio"\r?\nversion = "([^"]+)"/)?.[1],
    ],
    [releaseFiles.tauriConfig, tauriConfig.version],
    [
      releaseFiles.iosInfoPlist,
      iosInfoPlist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
    ],
    [releaseFiles.iosProject, iosProject.match(/^\s*CFBundleShortVersionString:\s*([^\s]+)\s*$/m)?.[1]],
  ]);

  const buildNumbers = new Map([
    [`${releaseFiles.tauriConfig} bundle.iOS.bundleVersion`, tauriConfig.bundle?.iOS?.bundleVersion],
    [
      `${releaseFiles.iosInfoPlist} CFBundleVersion`,
      iosInfoPlist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1],
    ],
    [
      `${releaseFiles.iosProject} CFBundleVersion`,
      iosProject.match(/^\s*CFBundleVersion:\s*"?([^"\s]+)"?\s*$/m)?.[1],
    ],
  ]);

  return {
    tauriConfig,
    version: packageJson.version,
    build: String(tauriConfig.bundle?.iOS?.bundleVersion ?? ""),
    versions,
    buildNumbers,
  };
}

/** Read only the two owner files needed by release callers that do not perform alignment checks. */
export function currentRelease(root = repositoryRoot) {
  const packageJson = JSON.parse(readFileSync(releaseFilePath("packageJson", root), "utf8"));
  const tauriConfig = JSON.parse(readFileSync(releaseFilePath("tauriConfig", root), "utf8"));
  return { version: packageJson.version, build: String(tauriConfig.bundle?.iOS?.bundleVersion ?? "") };
}

/** tauri.conf.json is the source of truth for every store identifier. */
export function appIdentifier(root = repositoryRoot) {
  const tauriConfig = JSON.parse(readFileSync(releaseFilePath("tauriConfig", root), "utf8"));
  const identifier = String(tauriConfig.identifier || "").trim();
  if (!identifier) throw new Error("src-tauri/tauri.conf.json identifier is required");
  return identifier;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command] = process.argv.slice(2);
  const printers = {
    identifier: () => appIdentifier(),
    version: () => currentRelease().version,
    build: () => currentRelease().build,
  };
  const printer = printers[command];
  if (!printer) throw new Error(`Usage: node scripts/release-metadata.mjs <${Object.keys(printers).join("|")}>`);
  console.log(printer());
}
