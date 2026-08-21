# Changelog

All notable Amplifier Studio changes are recorded here. Releases use tags of
the form `studio-vX.Y.Z`; the GitHub release workflow is the sole supported
path for signed public artifacts.

## 0.1.55 — 2026-08-20

- Amplifier Host answers an unimplemented API path with JSON 404 from inside its
  CORS layer, instead of falling through to the SPA. axum only nests an inner
  router's fallback when it has one, so an unknown `/v1/api/*` path reached the
  root `fallback_service(assets)` and returned `index.html` — HTTP 200,
  `text/html`, and no `access-control-allow-origin`, because that fallback sits
  outside the CORS layer. To curl it looked like a healthy 200; to the WebView it
  was a CORS failure, and `fetch` rejected with an opaque TypeError
  indistinguishable from a dead tunnel.
  That is the root cause of the reported "could not reach Amplifier Host at
  http://127.0.0.1:4318" on a Spark session: the host was answering normally, but
  predates `stored-session-export`, which the stored-session Duplicate action
  calls. The 404 now says which endpoint is missing and that the host is older
  than the client.
- Host request failures name the request. "No response from
  http://127.0.0.1:4318 on GET /v1/api/stored-session-export" identifies an
  old-host mismatch immediately; the origin alone never could.
- `/config` advertises a `sessionTransfer` capability so a client can detect a
  host too old for stored-session transfer before attempting it.

## 0.1.54 — 2026-08-20

- Artifact previews are sized by CSS instead of a script handshake. Studio used
  to inject its own script into every `amplifier-html` frame and listen for a
  postMessage height report; because a `srcdoc` frame inherits the embedder's
  policy container, that script had to be hash-allowlisted in two separate CSPs,
  which required a generator script, a hash-sync test and a cross-policy Rust
  test to keep them aligned. The frame is now a fixed 420 px panel that scrolls
  internally and expands to `min(80vh, 1000px)`. Deleted: the injected script,
  `scripts/artifact-csp-hash.mjs`, the `'sha256-...'` entry in both policies, and
  both pinning tests.
- **Correction to the 0.1.46 entry.** That release claimed to have "restored
  interactive `amplifier-html` artifacts in packaged builds". It did not, and the
  claim should not have been made. Allowlisting the hash restored *Studio's own
  sizing script* and nothing else: under the inherited policy the artifact's own
  inline scripts stay blocked. Verified in WKWebView and Chrome — with the hash
  present, only the hashed script ran. Author JavaScript has never executed in a
  packaged or browser-host build, only under `npm run dev`, which sends no CSP.
  The docs, the README and the in-app badge (now "RENDERED HTML · no scripts")
  have been corrected to stop promising behaviour the build does not deliver.

## 0.1.53 — 2026-08-20

- The dependency audit gates added in 0.1.52 never ran. Their condition was
  `startsWith(matrix.platform, 'ubuntu')`, copied from `publish.yml`, but
  `ci.yml`'s matrix key is `os` — so the expression was always false and all
  three steps were silently skipped while CI stayed green. Exactly the failure
  mode the gates were added to prevent, in the gates themselves. Baseline with
  the gates actually running: `npm audit --audit-level=high` reports zero, and
  `cargo audit` exits clean with 18 unmaintained/unsound warnings, almost all
  GTK3 bindings reached through Tauri's Linux backend and not ours to fix. The
  gate fails on vulnerabilities, not on those warnings.
- Added `scripts/bump-version.mjs`. Every pull request must advance both the
  app version and the mobile build number, and those numbers live in six files
  that `check-release-version.mjs` compares. A hand-edit that misses one — most
  often `gen/apple/project.yml` — reds all three runners on a diff that has
  nothing to do with versioning.

## 0.1.52 — 2026-08-20

- A compute host whose forward moves to a new port is now re-pointed instead of
  duplicated. Host ids are derived from the URL, and these URLs are loopback
  ports handed out by SSH or Tailscale — inherently ephemeral. When a forward
  came back on a different port the URL stopped matching, a new host record and
  keychain entry were minted, and every stored session pinned to the old id was
  stranded with nothing in the UI able to re-point it. A user-assigned host name
  is now treated as the stable identity; auto-generated names are excluded so
  two unrelated computes are never merged.
- Every modal now traps Tab focus. `aria-modal="true"` promises assistive
  technology that the rest of the page is inert, and four of Studio's five
  dialogs broke that promise — keyboard and screen-reader users tabbed straight
  out into the frozen background. The one existing implementation also relied on
  `querySelectorAll` returning document order for a comma-separated selector,
  which is not guaranteed; the shared version sorts explicitly.
- The streaming answer is announced to screen readers. It is the product's
  primary output and was the only region without a live region — the boot,
  working and fatal cards all had one.
- The terminal workbench now says tmux does not run on Windows instead of
  telling Windows users to check their PATH for it.
- Added Dependabot (npm, cargo, actions) and `npm audit` / `cargo audit` gates
  in CI. Pinning makes builds reproducible, not unvulnerable, and nothing was
  checking whether a pinned version had a known advisory. Both are clean today.

## 0.1.51 — 2026-08-20

- Host request failures no longer assert a cause the client cannot know. Every
  rejected `fetch` reported "Could not reach Amplifier Host at X. Check the
  SSH/Tailscale connection...", which sent a real investigation down the wrong
  path: the Spark host in question was listening, CORS-correct for
  `tauri://localhost`, and answering `curl` the whole time. A rejected fetch
  only proves no response arrived; a dead tunnel, a CORS rejection and a
  blocked scheme are indistinguishable from the client. The message now says
  that, names the origin, carries the underlying error (name and message) via
  `cause`, and lists the candidates instead of picking one.
- The stored-session dialog no longer shows two contradictory explanations at
  once. A caller-supplied reason describes an earlier attempt; once a fresh
  attempt fails differently it is superseded, so the dialog stopped claiming a
  session was "already open on its owning compute" while simultaneously
  reporting no response from that compute — and stopped leaving Resume disabled
  for the older of the two. Intrinsic blockers (corrupt, empty, recovered) are
  properties of the data and still apply.

## 0.1.50 — 2026-08-20

- Studio now has logging. There was none: sixteen `println!` calls, no
  `tracing`, no panic hook, so every failure the hardening audit found was
  invisible in production. An operator running `amplifier-host` under systemd
  got a startup banner and then silence. Adds a `RUST_LOG`-controlled
  subscriber (the iOS scheme already set `RUST_LOG=info`, which previously did
  nothing), a panic hook that records location and payload before the process
  dies, and instrumentation on the paths that used to fail silently: session
  spawn/exit/detach, a runtime stdout read error that ends the reader while the
  child keeps running, unauthenticated request rejections, and transcript
  damage versus torn-tail recovery. Logs go to stderr so they cannot
  desynchronize the JSONL protocol on stdout.
- Audited all 35 `#[tauri::command]` entry points and documented them in
  `docs/IPC-COMMAND-SURFACE.md`. Tauri v2 capabilities do not gate app-defined
  commands, so the minimal capability allowlist gave false assurance about this
  surface. Three commands are broader than they need to be —
  `load_attachment_paths` (arbitrary read), `write_diagnostics` (arbitrary
  write) and `resolve_runtime_host_token` (hands a bearer token to JS) — and
  are now logged. Logging is not a control: the real fix is to move the native
  dialog into Rust so the backend owns the path, which changes the picker flow
  and needs interactive testing per platform, so it is not bundled here.

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
