# Changelog

All notable Amplifier Studio changes are recorded here. Releases use tags of
the form `studio-vX.Y.Z`; the GitHub release workflow is the sole supported
path for signed public artifacts.

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
- Hardened desktop release gating, Windows Authenticode configuration, unified
  updater metadata, and macOS notarization prerequisites.

## 0.1.11

- Last preview release before the authenticated bridge and native-goal work.
