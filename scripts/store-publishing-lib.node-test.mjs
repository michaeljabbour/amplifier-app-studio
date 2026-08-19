import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

// Keep these tests on Node's native runner so release scripts stay dependency-free.
import {
  createAppStoreConnectToken,
  googlePlayTrackPayload,
  requestJson,
  waitForValue,
} from "./store-publishing-lib.mjs";

test("App Store Connect token has an ES256 header, bounded lifetime, and raw signature", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const token = createAppStoreConnectToken({
    issuerId: "issuer",
    keyId: "key",
    privateKey,
    now: 1_700_000_000_000,
  });
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "ES256", kid: "key", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.exp - claims.iat, 19 * 60);
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(Buffer.from(signature, "base64url").length, 64);
});

test("Google Play payload pins one numeric version code to the requested status", () => {
  assert.deepEqual(googlePlayTrackPayload({
    versionCode: 25,
    status: "completed",
    releaseName: "Amplifier Studio 0.1.38",
  }), {
    releases: [{
      name: "Amplifier Studio 0.1.38",
      status: "completed",
      versionCodes: ["25"],
    }],
  });
  assert.throws(() => googlePlayTrackPayload({ versionCode: "bad", status: "completed" }), /numeric/);
  assert.throws(() => googlePlayTrackPayload({ versionCode: 25, status: "unknown" }), /Unsupported/);
});

test("requestJson exposes HTTP status and response details", async () => {
  await assert.rejects(
    requestJson("https://example.test", {}, async () => new Response(
      JSON.stringify({ error: "denied" }),
      { status: 403, headers: { "content-type": "application/json" } },
    )),
    /403.*denied/,
  );
});

test("waitForValue stops after the first truthy value", async () => {
  const values = [undefined, undefined, "ready"];
  const result = await waitForValue(async () => values.shift(), {
    timeoutMs: 1000,
    intervalMs: 1,
    description: "test value",
    sleep: async () => {},
  });
  assert.equal(result, "ready");
});
