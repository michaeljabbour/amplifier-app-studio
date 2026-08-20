# Changelog

All notable Amplifier Studio changes are recorded here. Releases use tags of
the form `studio-vX.Y.Z`; the GitHub release workflow is the sole supported
path for signed public artifacts.

## 0.1.46 — 2026-08-20

Production-hardening pass over 0.1.45. Every item below only reproduced in a
packaged, signed, or remote build, which is why the green desktop test suite
never saw them.

- Restored interactive `amplifier-html` artifacts in packaged builds. A
  `srcdoc` frame inherits Studio's policy container rather than replacing it,
  so the frame's inline resize script was blocked by the app CSP and every
  artifact stayed clipped at 420 px with scrolling disabled. The script is now
  byte-stable and hash-allowlisted, with the hash asserted against
  `tauri.conf.json` in tests and a scrollable fallback if it is ever blocked
  again.
- Pinned the runtime bootstrap installer to an immutable commit and verified
  its SHA-256 before execution. Only the `--ref` argument had been pinned; the
  script itself was fetched from a mutable branch and piped straight into
  `bash` / `[scriptblock]::Create`.
- Scoped the tool-contract block to RunPod gateway routes. The model patterns
  were provider-independent, so the same weights served from any other provider
  produced a session that could never send a message.
- Removed the operator's internal compute-budget figure from shipped cost copy.
- Gave the remote bridge a terminal state when the host reports the runtime is
  gone, a watchdog for a reattach whose history replay never completes, and a
  dedupe reset so "Retry restore" rebuilds the transcript instead of returning
  a blank one.
- Declared the macOS microphone entitlement so voice input works under the
  Hardened Runtime, asserted on the signed binary in CI.
- Pinned the Windows Store package revision field to 0; `0.1.45.33` was
  rejected by Partner Center at upload.
- Stopped the terminal OSC filter from deleting output between two OSC-8
  hyperlinks, which cargo, gh, uv and pytest all emit by default.

## 0.1.41 — 2026-08-19

- Restored pre-ledger sessions from their durable user/assistant transcript,
  with reconnect deduplication and an explicit stale-runtime diagnostic instead
  of a falsely successful blank screen.
- Preserved compute-host identity, credentials, launch overrides, and replay
  expectations across in-app updates, including recovery of restore plans
  written by older Studio builds.
- Kept failed tabs retryable, distinguished active runtimes from stopped
  diagnostics, and removed zero-message runtime attempts from resumable history.
- Cleared the current npm and RustSec vulnerability findings, including the
  XML parser and HTTP/2 dependency updates, while retaining entity-safe DOCX
  text extraction coverage.

## 0.1.38 — 2026-08-18

- Federated stored-session history across local and configured compute hosts,
  with origin-aware resume and explicit duplication when recovery is required.
- Repaired inline DOT rendering and exposed actionable graph errors.
- Added signed desktop, TestFlight, and Google Play internal publishing lanes
  with store API verification, mobile build-number gates, and release tests.

## 0.1.13 — 2026-08-11

- Fixed automatic session restoration after a Finder launch or in-app update
  by giving the Amplifier runtime and its subprocesses a stable, cross-platform
  executable search path.

## 0.1.12 — 2026-08-11

- Replaced the UI-only Autopilot prompt with Amplifier's native goal loop,
  including acknowledged on/off state and durable goal progress.
- Added bounded, recoverable session restore and truthful detached-agent state.
- Added authenticated, origin-restricted, project-scoped web bridging with
  reconnect and cursor replay.
- Added provider readiness/setup, JSON capability discovery, and Windows
  runtime installation support.
- Added App Use, Browser Use, Imagen, Attractor, terminal, bundle, output, and
  provider surfaces without hiding the coordinator chat.
- Added native desktop image drops with validated PNG, JPEG, GIF, and WebP
  attachments, while retaining browser file drops for the web client.
- Corrected completed-agent inspection so recorded responses and reasoning are
  never presented as live activity.
- Added all-agent cost reconstruction with provider-reported, RunPod-estimated,
  partial, and unavailable states instead of presenting missing prices as $0.
- Hardened desktop release gating, Windows Authenticode configuration, unified
  updater metadata, and macOS notarization prerequisites.

## 0.1.11

- Last preview release before the authenticated bridge and native-goal work.
