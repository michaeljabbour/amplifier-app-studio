import assert from "node:assert/strict";
import test from "node:test";
import { renderWindowsStoreManifest, windowsStorePackageVersion } from "./prepare-windows-store-package.mjs";

test("Windows Store version includes the monotonic mobile build number", () => {
  assert.equal(windowsStorePackageVersion("0.1.41", "29"), "0.1.29.0");
  assert.equal(windowsStorePackageVersion("0.1.45", "33"), "0.1.33.0");
  assert.throws(() => windowsStorePackageVersion("0.1", "27"), /MAJOR.MINOR.PATCH/);
  assert.throws(() => windowsStorePackageVersion("0.1.41", "0"), /1-65535/);
});

// Regression: the revision field is reserved for the Store and a non-zero value is rejected at
// upload time, which fails the release after everything else has already been built and signed.
test("Windows Store version always pins the Store-reserved revision field to zero", () => {
  for (const [marketing, build] of [["0.1.45", "33"], ["1.0.0", "1"], ["2.13.7", "65535"]]) {
    const version = windowsStorePackageVersion(marketing, build);
    assert.match(version, /^\d+\.\d+\.\d+\.0$/, `${version} must end in a zero revision`);
    assert.equal(version.split(".").at(-1), "0");
    assert.ok(version.split(".").every((segment) => Number(segment) <= 65_535));
  }
});

// The Store orders submissions by package version, so a newer build must always sort higher.
test("Windows Store versions increase monotonically with the build number", () => {
  const older = windowsStorePackageVersion("0.1.45", "33").split(".").map(Number);
  const newer = windowsStorePackageVersion("0.1.46", "34").split(".").map(Number);
  assert.ok(newer.some((segment, index) => segment > older[index]) && newer[2] > older[2]);
});

test("Windows Store manifest uses exact escaped Partner Center identity", () => {
  const manifest = renderWindowsStoreManifest({
    identityName: "AmplifierStudio.Product",
    publisherId: "CN=Amplifier & Studio",
    publisherDisplayName: "Amplifier <Studio>",
    packageVersion: "0.1.29.0",
  });
  assert.match(manifest, /Name="AmplifierStudio\.Product"/);
  assert.match(manifest, /Publisher="CN=Amplifier &amp; Studio"/);
  assert.match(manifest, /PublisherDisplayName>Amplifier &lt;Studio&gt;/);
  assert.match(manifest, /Version="0\.1\.29\.0"/);
  assert.doesNotMatch(manifest, /__[A-Z0-9_]+__/);
});
