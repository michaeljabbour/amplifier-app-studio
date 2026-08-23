#!/usr/bin/env node
// Advances the Studio release version and mobile build number across every file that
// check-release-version.mjs compares.
//
// The repo gates every pull request on BOTH numbers strictly advancing past origin/main, and the
// numbers live in six files. Doing that by hand reliably misses one -- most often
// gen/apple/project.yml -- which reds all three CI runners on a diff that has nothing to do with
// versioning.
//
//   node scripts/bump-version.mjs            # patch bump, build + 1
//   node scripts/bump-version.mjs 0.2.0      # explicit version, build + 1
//   node scripts/bump-version.mjs --check    # report the current values and exit

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currentRelease, releaseFilePath, releaseVersionParts } from "./release-metadata.mjs";

const PACKAGE = releaseFilePath("packageJson");
const CARGO = releaseFilePath("cargoManifest");
const CARGO_LOCK = releaseFilePath("cargoLock");
const TAURI = releaseFilePath("tauriConfig");
const IOS_PLIST = releaseFilePath("iosInfoPlist");
const IOS_PROJECT = releaseFilePath("iosProject");

const read = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(read(path));

export function nextPatch(version) {
  const [major, minor, patch] = releaseVersionParts(version, "Version");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

export const current = currentRelease;

function replaceOnce(path, from, to) {
  const text = read(path);
  if (!text.includes(from)) throw new Error(`${path} does not contain ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

function bump(version, build) {
  const previous = current();

  const pkg = readJson(PACKAGE);
  pkg.version = version;
  writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`);

  replaceOnce(CARGO, `version = "${previous.version}"`, `version = "${version}"`);
  // The lockfile's amplifier-studio entry is asserted by the release checks; cargo would fix it
  // on the next build, but CI runs release:check before anything invokes cargo.
  replaceOnce(
    CARGO_LOCK,
    `name = "amplifier-studio"\nversion = "${previous.version}"`,
    `name = "amplifier-studio"\nversion = "${version}"`,
  );

  const tauri = readJson(TAURI);
  tauri.version = version;
  tauri.bundle.iOS.bundleVersion = build;
  writeFileSync(TAURI, `${JSON.stringify(tauri, null, 2)}\n`);

  replaceOnce(IOS_PLIST, `<string>${previous.version}</string>`, `<string>${version}</string>`);
  replaceOnce(
    IOS_PLIST,
    `<key>CFBundleVersion</key>\n\t<string>${previous.build}</string>`,
    `<key>CFBundleVersion</key>\n\t<string>${build}</string>`,
  );
  replaceOnce(IOS_PROJECT, `CFBundleShortVersionString: ${previous.version}`, `CFBundleShortVersionString: ${version}`);
  replaceOnce(IOS_PROJECT, `CFBundleVersion: "${previous.build}"`, `CFBundleVersion: "${build}"`);

  return { from: previous, to: { version, build } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const { version, build } = current();
    console.log(`Amplifier Studio ${version}, mobile build ${build}`);
  } else {
    const previous = current();
    const version = args.find((arg) => !arg.startsWith("--")) || nextPatch(previous.version);
    const build = String(Number(previous.build) + 1);
    const result = bump(version, build);
    console.log(`Bumped ${result.from.version}/${result.from.build} -> ${result.to.version}/${result.to.build}`);
  }
}
