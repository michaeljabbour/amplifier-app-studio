import { createSign } from "node:crypto";

export const encodeBase64Url = (value) => Buffer.from(value).toString("base64url");

export function createAppStoreConnectToken({ issuerId, keyId, privateKey, now = Date.now() }) {
  if (!issuerId || !keyId || !privateKey) {
    throw new Error("App Store Connect issuer ID, key ID, and private key are required");
  }

  const issuedAt = Math.floor(now / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify({
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 19 * 60,
    aud: "appstoreconnect-v1",
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${encodeBase64Url(signature)}`;
}

export async function requestJson(url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${options.method || "GET"} ${url} failed (${response.status}): ${detail}`);
  }
  return body;
}

export async function waitForValue(load, {
  timeoutMs,
  intervalMs,
  description,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() <= deadline) {
    lastValue = await load();
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}${lastValue ? `: ${lastValue}` : ""}`);
}

export function googlePlayTrackPayload({ versionCode, status, releaseName, releaseNotes = [] }) {
  if (!/^\d+$/.test(String(versionCode))) throw new Error("Google Play version code must be numeric");
  if (!new Set(["draft", "inProgress", "halted", "completed"]).has(status)) {
    throw new Error(`Unsupported Google Play release status: ${status}`);
  }
  return {
    releases: [{
      name: releaseName,
      status,
      versionCodes: [String(versionCode)],
      ...(releaseNotes.length ? { releaseNotes } : {}),
    }],
  };
}
