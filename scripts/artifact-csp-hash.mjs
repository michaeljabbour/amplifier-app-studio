#!/usr/bin/env node
// Keeps Studio's CSP in sync with the artifact frame's inline resize script.
//
// A `srcdoc` frame inherits the parent policy container rather than replacing it, so the
// artifact's inline script must be allowed by Studio's OWN `script-src`. We allow exactly
// those bytes by hash. If the script and the hash ever drift, packaged builds silently stop
// running artifact scripts while `npm run dev` (no CSP) keeps working -- so this is enforced
// by a test rather than left to a checklist.
//
//   node scripts/artifact-csp-hash.mjs           # print the expected hash
//   node scripts/artifact-csp-hash.mjs --write   # rewrite tauri.conf.json's csp with it

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ARTIFACT_SOURCE = join(root, "src/components/VisualArtifact.tsx");
export const TAURI_CONF = join(root, "src-tauri/tauri.conf.json");

export function readArtifactResizeScript(source = readFileSync(ARTIFACT_SOURCE, "utf8")) {
  const marker = "export const ARTIFACT_RESIZE_SCRIPT = `";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("ARTIFACT_RESIZE_SCRIPT literal not found in VisualArtifact.tsx");
  const from = start + marker.length;
  const end = source.indexOf("`;", from);
  if (end < 0) throw new Error("ARTIFACT_RESIZE_SCRIPT literal is unterminated");
  const script = source.slice(from, end);
  if (script.includes("${")) {
    throw new Error("ARTIFACT_RESIZE_SCRIPT must not interpolate: its bytes have to be stable to be hashed");
  }
  // Match artifactResizeScript(): a CRLF checkout must not change the hash.
  return script.replace(/\r\n/g, "\n");
}

export function artifactScriptHash(script = readArtifactResizeScript()) {
  return `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;
}

export function cspWithArtifactHash(csp, hash) {
  const directives = csp.split(";").map((directive) => directive.trim()).filter(Boolean);
  const index = directives.findIndex((directive) => directive.startsWith("script-src "));
  if (index < 0) throw new Error("tauri.conf.json csp has no script-src directive");
  const sources = directives[index].split(/\s+/).filter((source) => !source.startsWith("'sha256-"));
  sources.push(`'${hash}'`);
  directives[index] = sources.join(" ");
  return `${directives.join("; ")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hash = artifactScriptHash();
  if (process.argv.includes("--write")) {
    const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
    conf.app.security.csp = cspWithArtifactHash(conf.app.security.csp, hash);
    writeFileSync(TAURI_CONF, `${JSON.stringify(conf, null, 2)}\n`);
    console.log(`tauri.conf.json script-src now allows ${hash}`);
  } else {
    console.log(hash);
  }
}
