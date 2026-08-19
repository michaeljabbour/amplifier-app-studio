#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createAppStoreConnectToken,
  requestJson,
  waitForValue,
} from "./store-publishing-lib.mjs";

const API_ROOT = "https://api.appstoreconnect.apple.com/v1";

const firstId = (document, description) => {
  const id = document?.data?.[0]?.id;
  if (!id) throw new Error(`${description} was not found`);
  return id;
};

export async function assignBuildToTestFlight({
  bundleId,
  buildNumber,
  groupNames,
  issuerId,
  keyId,
  privateKey,
  fetchImpl = fetch,
  wait = waitForValue,
}) {
  // App Store Connect JWTs expire after 20 minutes. Build processing can take
  // longer, so create a fresh token for every request instead of retaining one
  // across the polling window.
  const headers = () => ({
    Authorization: `Bearer ${createAppStoreConnectToken({ issuerId, keyId, privateKey })}`,
    "Content-Type": "application/json",
  });
  const get = (path) => requestJson(`${API_ROOT}${path}`, { headers: headers() }, fetchImpl);

  const appQuery = new URLSearchParams({ "filter[bundleId]": bundleId, limit: "1" });
  const appId = firstId(await get(`/apps?${appQuery}`), `App ${bundleId}`);

  const buildId = await wait(async () => {
    const buildQuery = new URLSearchParams({
      "filter[app]": appId,
      "filter[version]": String(buildNumber),
      sort: "-uploadedDate",
      limit: "1",
    });
    return (await get(`/builds?${buildQuery}`))?.data?.[0]?.id;
  }, {
    timeoutMs: 30 * 60 * 1000,
    intervalMs: 30 * 1000,
    description: `App Store processing for build ${buildNumber}`,
  });

  const groups = [];
  for (const groupName of groupNames) {
    const groupQuery = new URLSearchParams({
      "filter[app]": appId,
      "filter[name]": groupName,
      limit: "1",
    });
    const groupId = firstId(await get(`/betaGroups?${groupQuery}`), `TestFlight group ${groupName}`);
    await requestJson(`${API_ROOT}/betaGroups/${groupId}/relationships/builds`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ data: [{ type: "builds", id: buildId }] }),
    }, fetchImpl);
    groups.push({ id: groupId, name: groupName });
  }

  return { appId, buildId, groups };
}

async function main() {
  const [privateKeyPath] = process.argv.slice(2);
  if (!privateKeyPath) {
    throw new Error("Usage: app-store-connect-testflight.mjs PRIVATE_KEY_PATH");
  }
  const configuration = {
    bundleId: process.env.IOS_BUNDLE_ID || "com.amplifier.studio",
    buildNumber: process.env.IOS_BUILD_NUMBER,
    groupNames: (process.env.IOS_TESTFLIGHT_GROUPS || process.env.IOS_TESTFLIGHT_GROUP || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID,
    keyId: process.env.APP_STORE_CONNECT_API_KEY_ID,
    privateKey: await readFile(privateKeyPath, "utf8"),
  };
  for (const [name, value] of Object.entries(configuration)) {
    if (!value || (Array.isArray(value) && !value.length)) throw new Error(`${name} is required`);
  }

  const result = await assignBuildToTestFlight(configuration);
  console.log(`Assigned build ${configuration.buildNumber} to ${result.groups.map((group) => group.name).join(", ")} (${result.buildId}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
