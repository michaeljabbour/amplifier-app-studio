#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Signed macOS bundles can only be built on macOS."
  exit 1
fi

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  STUDIO_SIGNING_IDENTITY="$({
    security find-identity -v -p codesigning 2>/dev/null |
      sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' |
      head -n 1
  } || true)"

  if [[ -z "$STUDIO_SIGNING_IDENTITY" ]]; then
    print -u2 "No Developer ID Application certificate was found in the login keychain."
    print -u2 "Install one or set APPLE_SIGNING_IDENTITY explicitly."
    exit 1
  fi

  export APPLE_SIGNING_IDENTITY="$STUDIO_SIGNING_IDENTITY"
fi

print "Building Amplifier Studio with signing identity: $APPLE_SIGNING_IDENTITY"
exec npm run tauri -- build "$@"
