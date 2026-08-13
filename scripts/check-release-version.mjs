import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const tauriVersion = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).version;
const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const iosInfo = readFileSync(new URL("../src-tauri/gen/apple/amplifier-studio_iOS/Info.plist", import.meta.url), "utf8");
const iosMarketingVersion = iosInfo.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
const iosProject = readFileSync(new URL("../src-tauri/gen/apple/project.yml", import.meta.url), "utf8");
const iosProjectVersion = iosProject.match(/^\s*CFBundleShortVersionString:\s*([^\s]+)\s*$/m)?.[1];
const versions = new Map([
  ["package.json", packageVersion],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/tauri.conf.json", tauriVersion],
  ["src-tauri/gen/apple/amplifier-studio_iOS/Info.plist", iosMarketingVersion],
  ["src-tauri/gen/apple/project.yml", iosProjectVersion],
]);

for (const [file, version] of versions) {
  if (version !== packageVersion) {
    throw new Error(`${file} has version ${version || "missing"}; expected ${packageVersion}`);
  }
}

const semver = /^(\d+)\.(\d+)\.(\d+)$/;
const versionTuple = (value) => {
  const match = semver.exec(value);
  if (!match) {
    throw new Error(`Release version must be MAJOR.MINOR.PATCH; found ${value}`);
  }
  return match.slice(1).map(Number);
};
const compareVersions = (left, right) => {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
};

const baseRef = process.env.RELEASE_BASE_REF
  || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);
if (baseRef) {
  const basePackage = JSON.parse(execFileSync("git", ["show", `${baseRef}:package.json`], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }));
  if (compareVersions(packageVersion, basePackage.version) <= 0) {
    throw new Error(
      `Studio app version must advance from ${basePackage.version}; current version is ${packageVersion}`,
    );
  }
  console.log(`Amplifier Studio release version advances ${basePackage.version} -> ${packageVersion}.`);
}

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `studio-v${packageVersion}`) {
  throw new Error(`Release tag ${tag} does not match studio-v${packageVersion}`);
}

console.log(`Amplifier Studio release version ${packageVersion} is consistent.`);
