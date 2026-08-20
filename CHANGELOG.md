# Changelog

All notable Amplifier Studio changes are recorded here. Releases use tags of
the form `studio-vX.Y.Z`; the GitHub release workflow is the sole supported
path for signed public artifacts.

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
