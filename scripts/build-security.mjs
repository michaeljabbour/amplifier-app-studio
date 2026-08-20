const EMBEDDED_BRIDGE_TOKEN = "VITE_STUDIO_BRIDGE_TOKEN";
const QA_OVERRIDE = "STUDIO_ALLOW_EMBEDDED_BRIDGE_TOKEN";

export function assertSafeBridgeBuild(command, environment = process.env) {
  if (command !== "build" || !environment[EMBEDDED_BRIDGE_TOKEN]) return;
  if (environment[QA_OVERRIDE] === "1") return;
  throw new Error(
    `${EMBEDDED_BRIDGE_TOKEN} would be compiled into the client bundle. `
      + `Published builds must pair with a host at runtime. For a disposable QA build only, `
      + `set ${QA_OVERRIDE}=1 explicitly.`,
  );
}

export function assertReleaseHasNoEmbeddedBridgeToken(environment = process.env) {
  if (!environment[EMBEDDED_BRIDGE_TOKEN]) return;
  throw new Error(`${EMBEDDED_BRIDGE_TOKEN} is forbidden in release jobs because it is a plaintext client credential.`);
}
