#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { googlePlayTrackPayload, requestJson } from "./store-publishing-lib.mjs";

const API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_ROOT = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";

export async function uploadGooglePlayRelease({
  accessToken,
  aabPath,
  packageName,
  track,
  status,
  releaseName,
  fetchImpl = fetch,
}) {
  if (!accessToken) throw new Error("Google Play access token is required");
  const authorization = { Authorization: `Bearer ${accessToken}` };
  const edit = await requestJson(`${API_ROOT}/applications/${packageName}/edits`, {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: "{}",
  }, fetchImpl);
  const editId = edit?.id;
  if (!editId) throw new Error("Google Play did not return an edit ID");

  const bundle = await requestJson(
    `${UPLOAD_ROOT}/applications/${packageName}/edits/${editId}/bundles?uploadType=media`,
    {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/octet-stream" },
      body: await readFile(aabPath),
    },
    fetchImpl,
  );
  const versionCode = bundle?.versionCode;
  if (!versionCode) throw new Error("Google Play did not return the uploaded version code");

  await requestJson(`${API_ROOT}/applications/${packageName}/edits/${editId}/tracks/${track}`, {
    method: "PUT",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify(googlePlayTrackPayload({ versionCode, status, releaseName })),
  }, fetchImpl);
  await requestJson(`${API_ROOT}/applications/${packageName}/edits/${editId}:commit`, {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: "{}",
  }, fetchImpl);

  return { editId, versionCode, track, status };
}

async function main() {
  const [aabPath] = process.argv.slice(2);
  if (!aabPath) throw new Error("Usage: google-play-release.mjs APP_BUNDLE_PATH");
  const configuration = {
    accessToken: process.env.GOOGLE_PLAY_ACCESS_TOKEN,
    aabPath,
    packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.amplifier.studio",
    track: process.env.GOOGLE_PLAY_TRACK || "internal",
    status: process.env.GOOGLE_PLAY_RELEASE_STATUS || "completed",
    releaseName: process.env.GOOGLE_PLAY_RELEASE_NAME || `Amplifier Studio ${process.env.GITHUB_REF_NAME || "release"}`,
  };
  const result = await uploadGooglePlayRelease(configuration);
  console.log(`Published version code ${result.versionCode} to Google Play ${result.track} (${result.status}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
