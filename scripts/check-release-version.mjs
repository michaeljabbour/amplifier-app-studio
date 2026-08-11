import { readFileSync } from "node:fs";

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

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `studio-v${packageVersion}`) {
  throw new Error(`Release tag ${tag} does not match studio-v${packageVersion}`);
}

console.log(`Amplifier Studio release version ${packageVersion} is consistent.`);
