import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnv } from "vite";
import { assertReleaseHasNoEmbeddedBridgeToken, assertSafeBridgeBuild } from "./build-security.mjs";

test("every Vite build mode rejects an accidentally embedded bridge credential", () => {
  assert.throws(
    () => assertSafeBridgeBuild("build", { VITE_STUDIO_BRIDGE_TOKEN: "secret" }),
    /compiled into the client bundle/,
  );
  assert.doesNotThrow(() => assertSafeBridgeBuild("serve", { VITE_STUDIO_BRIDGE_TOKEN: "secret" }));
});

test("disposable QA builds require an explicit plaintext credential override", () => {
  assert.doesNotThrow(() => assertSafeBridgeBuild("build", {
    VITE_STUDIO_BRIDGE_TOKEN: "secret",
    STUDIO_ALLOW_EMBEDDED_BRIDGE_TOKEN: "1",
  }));
  assert.throws(
    () => assertReleaseHasNoEmbeddedBridgeToken({ VITE_STUDIO_BRIDGE_TOKEN: "secret" }),
    /forbidden in release jobs/,
  );
});

test("credentials loaded from a custom Vite mode remain blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "studio-build-security-"));
  try {
    writeFileSync(join(root, ".env.qa"), "VITE_STUDIO_BRIDGE_TOKEN=loaded-from-file\n", "utf8");
    const environment = loadEnv("qa", root, "");
    assert.throws(
      () => assertSafeBridgeBuild("build", environment),
      /compiled into the client bundle/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
