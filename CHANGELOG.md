# Changelog

All notable Amplifier Studio changes are recorded here. Releases use tags of
the form `studio-vX.Y.Z`; the GitHub release workflow is the sole supported
path for signed public artifacts.

## 0.1.49 — 2026-08-20

- Fixed an update deadlock found while driving the live app: a session whose
  restore stalled sits in `degraded` waiting for the user, and that counted as
  work-in-flight, so the Update button went permanently disabled while its
  tooltip asked the user to finish active turns that did not exist.
- Made full-history replay linear instead of quadratic. The replayed-message id
  set was rebuilt on every message; measured, 10,000 messages cost 6,958 ms of
  blocked main thread against 0.86 ms with a Set, and the same replay through
  the reducer now runs in 54 ms.
- Throttled markdown re-rendering of the streaming answer. Measured, a 30 KB
  answer arriving in ~30-char deltas cost 2,242 ms of parse-and-sanitize across
  1,000 renders against 4.4 ms for one render of the finished text.
- Stopped the first live record after a replay from fabricating a "Protocol
  sequence gap" warning, while keeping genuine gap detection.
- Capped pretty-printed tool payloads at 32 KB in the transcript; agent tool
  results are unbounded and were retained in full in state and in the DOM.
- Stripped `class` and `role` from agent-authored HTML, which could otherwise
  reuse Studio's own chrome classes to render convincing fake UI.
- macOS Keychain writes now go through the Security framework instead of
  `security add-generic-password -w`, which published the bearer token in argv.
- Runtime stderr logs are created 0600 rather than at the process umask.
- Reattaching to a stored session with no live runtime now says so, instead of
  reporting that it is already open somewhere else.
- The stored-session index cache no longer pairs a post-scan signature with a
  pre-scan summary (which cached stale summaries permanently) and is rebuilt
  from the current scan rather than grown forever.

## 0.1.48 — 2026-08-20

- Fixed the release gate that verifies the macOS microphone entitlement. The
  check used an unescaped `plutil` key path, and `plutil` splits key paths on
  `.`, so it read `com.apple.security.device.audio-input` as a nested path and
  never found it. Caught by building and signing 0.1.47 locally: the gate
  failed against a build that carried the entitlement correctly, i.e. it would
  have blocked a good release. Now also asserts the Hardened Runtime, without
  which the entitlement means nothing.

## 0.1.47 — 2026-08-20

Second hardening pass: the remaining security and durability items that were
scoped out of 0.1.46.

- The browser host now serves a Content-Security-Policy. It previously sent
  none, so the "network off" promise on `amplifier-html` artifacts held only in
  the desktop app -- in a browser the sandboxed frame could navigate itself to
  an external URL and beacon out, which an artifact's own inner policy cannot
  prevent. Also adds `nosniff`, `no-referrer`, and `frame-ancestors 'none'`.
  The router is now built by a testable function so the headers are asserted on
  a real response rather than on a constant.
- The Amplifier Host bearer token is created 0600 under a 0700 directory
  instead of being written at the process umask and narrowed afterwards, which
  left it world-readable for the window between the two calls.
- Attachments are bounded before they are read: the size check ran after
  `std::fs::read`, so one oversized file was pulled fully into memory first.
- `.docx` text extraction now inflates through a hard cap. Compressed size says
  nothing about inflated size, so a few KB of crafted zip could expand into
  gigabytes and abort the process from a single attached file.
- A transcript whose final line was cut short mid-append is recovered instead
  of being condemned in full. The tolerance is narrow on purpose: the line must
  be last, the file must not end in a newline, and at least one good record
  must precede it. A complete-but-malformed line, or a file that is nothing but
  garbage, is still reported as corrupt.

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
