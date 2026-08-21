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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(root, "package.json");
const CARGO = join(root, "src-tauri/Cargo.toml");
const CARGO_LOCK = join(root, "src-tauri/Cargo.lock");
const TAURI = join(root, "src-tauri/tauri.conf.json");
const IOS_PLIST = join(root, "src-tauri/gen/apple/amplifier-studio_iOS/Info.plist");
const IOS_PROJECT = join(root, "src-tauri/gen/apple/project.yml");

const read = (path) => readFileSync(path, "utf8");
const readJson = (path) => JSON.parse(read(path));

export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Version must be MAJOR.MINOR.PATCH; found ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function current() {
  const tauri = readJson(TAURI);
  return {
    version: readJson(PACKAGE).version,
    build: String(tauri.bundle?.iOS?.bundleVersion ?? ""),
  };
}

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
