import { execFileSync } from "node:child_process";
import { loadEnv } from "vite";
import { assertReleaseHasNoEmbeddedBridgeToken } from "./build-security.mjs";
import {
  assertMobileBuildNumber,
  compareReleaseVersions,
  readReleaseMetadata,
  repositoryRoot,
} from "./release-metadata.mjs";

const releaseEnvironment = {
  ...loadEnv("production", repositoryRoot, ""),
  ...process.env,
};
assertReleaseHasNoEmbeddedBridgeToken(releaseEnvironment);

const {
  version: packageVersion,
  build: expectedBuildNumber,
  versions,
  buildNumbers,
} = readReleaseMetadata();

for (const [file, version] of versions) {
  if (version !== packageVersion) {
    throw new Error(`${file} has version ${version || "missing"}; expected ${packageVersion}`);
  }
}

assertMobileBuildNumber(expectedBuildNumber);
for (const [file, buildNumber] of buildNumbers) {
  if (String(buildNumber || "") !== expectedBuildNumber) {
    throw new Error(`${file} has build number ${buildNumber || "missing"}; expected ${expectedBuildNumber}`);
  }
}

/**
 * Whether this branch is expected to carry a release bump.
 *
 * The advance check exists so a human change cannot ship without moving the version. A dependency
 * update is not a release and the bot cannot bump anything, so requiring it made every Dependabot
 * pull request permanently unmergeable -- twelve of them piled up failing this line, including
 * trivial GitHub Action bumps, which is how it was noticed. The CONSISTENCY checks above still run
 * on these branches: a dependency PR must still leave all six version-bearing files in agreement.
 */
function expectsReleaseBump() {
  const head = process.env.RELEASE_HEAD_REF || process.env.GITHUB_HEAD_REF || "";
  const actor = process.env.GITHUB_ACTOR || "";
  return !(head.startsWith("dependabot/") || actor === "dependabot[bot]");
}

const baseRef = (process.env.RELEASE_BASE_REF
  || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined));
if (baseRef && !expectsReleaseBump()) {
  console.log("Dependency update branch: skipping the version-advance check, consistency still enforced.");
} else if (baseRef) {
  const basePackage = JSON.parse(execFileSync("git", ["show", `${baseRef}:package.json`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }));
  if (compareReleaseVersions(packageVersion, basePackage.version) <= 0) {
    throw new Error(
      `Studio app version must advance from ${basePackage.version}; current version is ${packageVersion}`,
    );
  }
  const baseTauriConfig = JSON.parse(execFileSync("git", ["show", `${baseRef}:src-tauri/tauri.conf.json`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }));
  const baseBuildNumber = Number(baseTauriConfig.bundle?.iOS?.bundleVersion);
  if (Number(expectedBuildNumber) <= baseBuildNumber) {
    throw new Error(
      `Mobile build number must advance from ${baseBuildNumber}; current build number is ${expectedBuildNumber}`,
    );
  }
  console.log(`Amplifier Studio release version advances ${basePackage.version} -> ${packageVersion}.`);
}

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `studio-v${packageVersion}`) {
  throw new Error(`Release tag ${tag} does not match studio-v${packageVersion}`);
}

console.log(`Amplifier Studio release version ${packageVersion} and mobile build ${expectedBuildNumber} are consistent.`);
