import assert from "node:assert/strict";
import test from "node:test";
import { assertReleaseHasNoEmbeddedBridgeToken, assertSafeBridgeBuild } from "./build-security.mjs";

test("production builds reject an accidentally embedded bridge credential", () => {
  assert.throws(
    () => assertSafeBridgeBuild("production", { VITE_STUDIO_BRIDGE_TOKEN: "secret" }),
    /compiled into the client bundle/,
  );
  assert.doesNotThrow(() => assertSafeBridgeBuild("development", { VITE_STUDIO_BRIDGE_TOKEN: "secret" }));
});

test("disposable QA builds require an explicit plaintext credential override", () => {
  assert.doesNotThrow(() => assertSafeBridgeBuild("production", {
    VITE_STUDIO_BRIDGE_TOKEN: "secret",
    STUDIO_ALLOW_EMBEDDED_BRIDGE_TOKEN: "1",
  }));
  assert.throws(
    () => assertReleaseHasNoEmbeddedBridgeToken({ VITE_STUDIO_BRIDGE_TOKEN: "secret" }),
    /forbidden in release jobs/,
  );
});
