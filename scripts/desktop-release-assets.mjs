export const desktopInstallerSpecs = {
  "macOS Apple Silicon DMG": /_(?:aarch64|arm64)\.dmg$/i,
  "macOS Intel x64 DMG": /_(?:x64|x86_64)\.dmg$/i,
  "Windows x64 MSI": /_(?:x64|x86_64)(?:_[A-Za-z-]+)?\.msi$/i,
  "Windows x64 NSIS executable": /_(?:x64|x86_64)-setup\.exe$/i,
  "Linux x64 AppImage": /_(?:amd64|x86_64)\.AppImage$/i,
};

export const desktopUpdaterSpecs = {
  "darwin-aarch64": /_(?:aarch64|arm64)\.app\.tar\.gz$/i,
  "darwin-x86_64": /_(?:x64|x86_64)\.app\.tar\.gz$/i,
  "windows-x86_64": /_(?:x64|x86_64)-setup\.exe$/i,
  "linux-x86_64": /_(?:amd64|x86_64)\.AppImage$/i,
};

export function exactlyOneAsset(assets, pattern, label) {
  const matches = assets.filter((asset) => pattern.test(asset));
  if (matches.length !== 1) {
    throw new Error(`${label} requires exactly one asset; found ${matches.join(", ") || "none"}`);
  }
  return matches[0];
}

export function verifyDesktopInstallerAssets(assets) {
  return Object.fromEntries(
    Object.entries(desktopInstallerSpecs).map(([label, pattern]) => [
      label,
      exactlyOneAsset(assets, pattern, label),
    ]),
  );
}

export function resolveDesktopUpdaterAssets(assets) {
  return Object.fromEntries(
    Object.entries(desktopUpdaterSpecs).map(([platform, pattern]) => {
      const asset = exactlyOneAsset(assets, pattern, platform);
      const signature = `${asset}.sig`;
      if (!assets.includes(signature)) {
        throw new Error(`${signature} is missing`);
      }
      return [platform, { asset, signature }];
    }),
  );
}
