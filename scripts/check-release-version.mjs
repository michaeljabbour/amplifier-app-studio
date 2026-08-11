import { readFileSync } from "node:fs";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const tauriVersion = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).version;
const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = new Map([
  ["package.json", packageVersion],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/tauri.conf.json", tauriVersion],
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
