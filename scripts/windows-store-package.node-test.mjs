import assert from "node:assert/strict";
import test from "node:test";
import { renderWindowsStoreManifest, windowsStorePackageVersion } from "./prepare-windows-store-package.mjs";

test("Windows Store version includes the monotonic mobile build number", () => {
  assert.equal(windowsStorePackageVersion("0.1.39", "26"), "0.1.39.26");
  assert.throws(() => windowsStorePackageVersion("0.1", "26"), /MAJOR.MINOR.PATCH/);
  assert.throws(() => windowsStorePackageVersion("0.1.39", "0"), /1-65535/);
});

test("Windows Store manifest uses exact escaped Partner Center identity", () => {
  const manifest = renderWindowsStoreManifest({
    identityName: "AmplifierStudio.Product",
    publisherId: "CN=Amplifier & Studio",
    publisherDisplayName: "Amplifier <Studio>",
    packageVersion: "0.1.39.26",
  });
  assert.match(manifest, /Name="AmplifierStudio\.Product"/);
  assert.match(manifest, /Publisher="CN=Amplifier &amp; Studio"/);
  assert.match(manifest, /PublisherDisplayName>Amplifier &lt;Studio&gt;/);
  assert.match(manifest, /Version="0\.1\.39\.26"/);
  assert.doesNotMatch(manifest, /__[A-Z0-9_]+__/);
});
