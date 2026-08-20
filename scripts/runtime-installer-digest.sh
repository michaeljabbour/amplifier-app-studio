#!/usr/bin/env bash
# Prints the SHA-256 digests that src-tauri/src/runtime_setup.rs must pin for the current
# RUNTIME_INSTALL_REF. Run this whenever that ref moves, and paste the results into
# INSTALL_SCRIPT_SHA256 / WINDOWS_INSTALL_SCRIPT_SHA256.
set -euo pipefail

ref="${1:-$(grep -oE 'RUNTIME_INSTALL_REF: &str = "[0-9a-f]{40}"' src-tauri/src/runtime_setup.rs | grep -oE '[0-9a-f]{40}')}"
if [ -z "$ref" ]; then
  echo "Could not determine RUNTIME_INSTALL_REF; pass it as the first argument." >&2
  exit 1
fi

echo "amplifier-runtime ref: $ref"
for script in install.sh install.ps1; do
  url="https://raw.githubusercontent.com/michaeljabbour/amplifier-runtime/${ref}/scripts/${script}"
  digest="$(curl --proto '=https' --tlsv1.2 -fsSL "$url" | shasum -a 256 | cut -d' ' -f1)"
  printf '%-12s %s\n' "$script" "$digest"
done
