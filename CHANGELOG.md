# Changelog

All notable Amplifier Studio changes are recorded here. Releases use tags of
the form `studio-vX.Y.Z`; the GitHub release workflow is the sole supported
path for signed public artifacts.

## 0.1.67 — 2026-08-23

Release hardening and mobile legibility.

- Consolidated the six version-bearing files, version comparison, application
  identifier, and mobile build number behind one release-metadata module. The
  release gate now verifies `Cargo.lock` as well as the five files it checked
  before, and the Windows, App Store Connect, and Google Play publishers consume
  the same metadata instead of carrying separate constants.
- Replaced three copies of the cross-platform verification job with one local
  composite action. CI and release publishing now run the same Node, npm, Rust,
  build, frontend-test, and Rust-test recipe on macOS, Linux, and Windows.
- Restored the intended mobile type scale. Twenty-three selector identifiers had
  been split across source lines, making those selectors invalid CSS and leaving
  important labels at 6–10 px. A regression test now rejects hard-wrapped selector
  identifiers before they reach a build.
- Removed 23 unused selector classes by parsing CSS and deleting exact AST ranges,
  including one orphaned selector found during verification.
- Added an opt-in packaged-window smoke surface for DOT, SVG, sandboxed HTML, and
  voice controls. It is dynamically imported only in the explicit peer-QA build,
  so the harness is absent from production bundles.
- Shared the Amplifier Host default bind address with its CLI and service setup so
  those paths cannot drift.
- Updated `zip` 4.6.1 → 8.6.0, `lucide-solid` 1.31.0 → 1.32.0, `marked`
  18.0.9 → 18.0.10, and `solid-js` 1.9.14 → 1.9.15. The four-major `zip`
  change passed the dedicated `.docx` inflation-cap test in addition to the full
  suite; the Markdown patch passed the renderer and sanitizer suites.

283 frontend tests, 21 release checks, and 110 Rust tests.

## 0.1.66 — 2026-08-21

Diagrams render again. The DOT viewer and the execution graph both discarded
most real graphs and reported "its SVG output was rejected by the sanitizer".

The sanitiser ran DOMPurify and then re-parsed its output as `image/svg+xml`.
DOMPurify parses as HTML and serialises with the HTML serialiser, which writes
U+00A0 as the named entity `&nbsp;`. XML predefines exactly five named entities,
so the re-parse failed with "undefined entity" and the whole diagram was thrown
away. Graphviz emits `&#160;` for every leading or trailing space in a label, so
ordinary padding such as `label="  this session  "` was enough to lose the
graph -- which is why it kept coming back. Three of the four diagrams in local
session history failed this way; all four render now.

Both viewers now keep DOMPurify's DOM instead of re-parsing a serialised string.
The sanitiser configuration is untouched, so the same tags and attributes are
stripped -- verified against script, anchor, image, use, foreignObject, style,
inline event handlers, `href`, and `javascript:` payloads.

## 0.1.65 — 2026-08-21

Four Rust major upgrades, each on a path hardened earlier in this cycle, so each
was verified individually rather than on the aggregate suite.

- `zip` 2.4.2 → 4.6.1 — two majors, and the crate behind `.docx` extraction. The
  zip-bomb cap added in 0.1.46 still refuses an archive that inflates past
  64 MB.
- `sha2` 0.10.9 → 0.11.0 — installer digest verification. Re-fetched the pinned
  `install.sh` and confirmed it still hashes to the constant in
  `runtime_setup.rs`; the known-vector test also passes.
- `tower-http` 0.6.11 → 0.7.0 — the web server's CORS layer and static serving.
  The unknown-API-path 404-inside-CORS behaviour and the browser security
  headers both still hold.
- `base64` 0.22.1 → 0.23.1 — token and attachment encoding.

Two release-path fixes rode along:

- The publish workflow verified that the public updater feed carried a url and a
  signature per platform, but never that the url resolved. It now downloads one
  byte of each advertised artifact, so a dead link fails the release instead of
  the user. An empty artifact list is an explicit failure rather than a silent
  pass.
- A release-gate test used `HEAD` as its base ref, so bumping the version and
  then running the suite -- the order anyone actually uses -- produced a phantom
  failure that vanished after committing. It now derives the base from the
  working tree.

110 Rust tests, 279 frontend tests, 19 release checks.

## 0.1.64 — 2026-08-21

Toolchain: TypeScript 7, Vite 8, Vitest 4, jsdom 30, @types/node 26.

Three independent problems had to be separated before any of this could land.

- **npm could not install it at all.** `npm error Cannot read properties of null
  (reading 'edgesOut')`, thrown from arborist's `#loadPeerSet` while resolving
  vitest 4's peer graph. Bisected in a scratch project: `vitest@4` alone crashes
  npm 10.9.4, which is what Node 22 bundles, and installs cleanly on npm 11.
  Vite 8, TypeScript 7 and vite-plugin-solid are each fine alone. Every workflow
  that installs now upgrades npm first; without it CI fails before a test runs.
- **`Cannot find name 'node:fs'` under TypeScript 7.** Not a compiler bug:
  `tsconfig.json` declared `"types": ["vite/client"]`, which excludes
  `@types/node`. TypeScript 5 was lenient; 7 enforces what the config always
  said. Now `["vite/client", "node"]`.
- **Ten suites failed with "invalid JS syntax ... do not set jsx to preserve".**
  `vite.config.ts` loads `vite-plugin-solid`; `vitest.config.ts` loaded no
  plugins at all, so JSX reached Vitest untransformed. Vitest 3 tolerated it,
  Vitest 4 does not. The two configs now describe the same pipeline. With the
  plugin present solid-js resolves to its browser build and touches `window` at
  import time, so six suites that import a component join the eleven already
  opting into jsdom. The plugin is configured `hot: false` for tests: Vitest runs
  it with `command === "serve"`, so it injected solid-refresh aliased to the
  virtual path `/@solid-refresh`, which Windows resolves to
  `file:///@solid-refresh` and Node rejects. That failed ten suites on
  windows-latest while macOS and Linux passed.

## 0.1.63 — 2026-08-21

Small cleanups from the dead-code sweep. Zero behaviour change.

- Removed the Vite dev proxy on `/api`. The client builds absolute URLs under
  `/v1/api`, which that prefix never matches, so the rule has never proxied a
  request.
- Removed a `display: none` rule for `.settings-scroll-controls`, a class that
  exists nowhere, and the `--panel-3` custom property, which no rule reads in
  either theme.
- Narrowed two exports to module scope.

Deliberately deferred: the sweep also proposed consolidating the release gate,
the version bumper and the CI verification recipe into shared modules. Those are
correct, but refactoring release tooling immediately before a release is the
wrong order — they land after the next publish, not before it.

## 0.1.62 — 2026-08-21

- The Dependabot configuration added in 0.1.52 could never merge anything. Every
  pull request must advance the app version past `origin/main`, and Dependabot
  cannot bump a version — so all twelve of its pull requests failed with
  `Studio app version must advance from 0.1.52`, including bumps of GitHub
  Actions that touch no application code at all. Dependency branches are now
  exempt from the version-advance check. The consistency half still runs, so a
  dependency update may not leave the six version-bearing files disagreeing, and
  a human branch that forgets to bump is still rejected.

## 0.1.61 — 2026-08-21

From a sweep for duplicated logic — specifically for copies that are supposed
to agree and no longer do.

- The Amplifier Host no longer blocks its only worker to answer
  `/v1/api/runtime`. `runtime_setup::status()` shells out twice (`--version` and
  `provider status`), and the host runs on a `current_thread` tokio runtime, so
  calling it inline stopped **every live session WebSocket on that host** until
  both children exited — around a second cold, unbounded on a stalled mount or a
  first-run resolve. The Tauri command wrapper had always used `spawn_blocking`;
  the HTTP handler was the copy that did not. `transcription_status` had the same
  omission and is fixed alongside it.
- The bearer-token directory is created `0700`. `write_config` ran first with
  `create_dir_all`, and `DirBuilder::mode(0o700)` is a no-op on a directory that
  already exists, so `~/.amplifier/host` stayed at the process umask — measured
  0755. The token file itself was always 0600, so the secret was never readable;
  what leaked was the listing, meaning the token's filename and its mtime, which
  is when it was last rotated. The README already claimed 0700; now that is true.
- One definition of "canonical project directory", replacing six. They disagreed
  on two axes that matter: `store.rs` trimmed its input and `session.rs` did not,
  so `"/tmp/project "` resolved through one path and failed through the other;
  and `catalog.rs` omitted the `is_dir` check entirely, so a FILE canonicalized
  successfully and was handed to `Command::current_dir`, which failed later as
  "Not a directory (os error 20)" instead of naming the problem at the boundary.
  `local_tmux.rs` keeps its stricter absolute-path requirement layered on top.

## 0.1.60 — 2026-08-21

Corrections found by sweeping for statements the code no longer supports.

- The visualization protocol doc still described `amplifier-html` as
  "interactive HTML, CSS, SVG, and local JavaScript" and told authors to reach
  for HTML "when interaction or animation materially improves understanding" —
  two lines above the paragraph added in 0.1.54 saying author JavaScript does
  not execute. It also claimed the artifact CSP is "stricter than Studio
  itself", which is only true of the directives that matter: its
  `script-src 'unsafe-inline'` is looser, and that is exactly why the frame
  inheriting Studio's policy is what blocks author scripts.
- The README still said speech-to-text uses the runtime host's key. Since 0.1.56
  desktop resolves the local key first.
- `RELEASE-READINESS.md` still answered "not through Studio yet" for session
  export. Export and import have been live end to end — over IPC and over the
  HTTP bridge — for some time; deletion, retention and legal hold genuinely are
  not offered, and the answer now distinguishes them.
- Dropped `asset:` and `http://asset.localhost` from both CSPs' `img-src`. The
  asset protocol is disabled and nothing calls `convertFileSrc`, so those tokens
  widened the policy for a capability the app does not use.
- Removed a comment describing the artifact CSP hash machinery deleted in
  0.1.54.

Known and deliberately not changed: Studio still advertises an `auto-height`
presentation capability to the runtime, which it no longer implements. That
string is part of amplifier-runtime's submit-op contract, so retiring it is a
cross-repo change — runtime first, then the pin, then Studio.

## 0.1.59 — 2026-08-21

- Advanced the pinned amplifier-runtime revision from `b9568a2` to `6d46915`,
  picking up `#11` (distinguish an unreadable session store from an empty one)
  and `#12` (scope capability claims to the active session). Both installer
  digests were regenerated; they are unchanged, because the two commits touch no
  file under `scripts/` — confirmed against the compare API rather than assumed.
- Studio now verifies the runtime **commit**, not just its version. The pin is a
  commit for security reasons, but `current` was decided by
  `REQUIRED_RUNTIME_VERSION = "0.1.8"` — and the runtime's version only advances
  on release commits, so `b9568a2`, `7447612` and `6d46915` all honestly report
  `0.1.8`. The check therefore passed in exactly the case it existed to catch: a
  guard that validates a coarser identity than the thing it guards cannot see
  the difference that matters. The installed revision is read from the PEP 610
  `direct_url.json` the package manager writes; an install with no recorded
  revision still falls back to the version rather than being failed.
  Verified against the real installation before the bump: `current=false`,
  `version=0.1.8`, `commit=b9568a25…` — drift the old check reported as ready.
- The mismatch message names both revisions instead of saying "0.1.8 update
  required", which is baffling when the installed runtime reports exactly 0.1.8.

## 0.1.58 — 2026-08-20

Found by comparing against kepler, an earlier app of the same author that had
these views wired up.

- Written files are attributed from the tool call, not only its reply. Studio
  read output paths from the tool RESULT, but a Claude-Code-shaped `Write`
  replies `{content: "File created successfully at: ..."}` and states the path
  only in its INPUT — so the file never reached the Outputs tab or the "N
  outputs" counter. An `Edit` that happened to echo `file_path` was captured,
  which made the whole inventory depend on the runtime's reply shape.
- A tool row keeps the file it touched after it settles. The summary was
  overwritten with `<tool> <status>` on completion, so "write_file ·
  src/main.rs" became "write_file completed" — losing the one useful fact on the
  row exactly when the row became final.
- Both now recognise the path keys real tools use (`file_path`, `filePath`,
  `path`, `filename`, `target_file`, `TargetFile`) rather than `path` alone, and
  ignore placeholders like `/dev/null`.

## 0.1.57 — 2026-08-20

- Remote host credentials work on Linux. `resolve_token`/`store_token` had macOS
  and Windows arms only, so a `keychain:` reference — the only kind the UI mints
  — failed outright, leaving the entire save-a-remote-host flow dead on a
  platform CI builds and tests on. Linux now uses a `0600` file under
  `$AMPLIFIER_HOME/credentials`. Deliberately not Secret Service: Studio's Linux
  role is usually a headless compute host with no D-Bus session for
  gnome-keyring or KWallet to answer on, so that dependency would fail precisely
  where Linux is actually used, and drag in a large tree to do it.
- Host ids can no longer be path components. The charset check admitted `.` and
  `..` — non-empty, short, all permitted characters — which on Linux would aim a
  credential write at a directory. Rejecting leading dots removes the hazard
  rather than sanitising the path at each use.
- Deduplicated the `AMPLIFIER_HOME | ~/.amplifier` chain, which was copied
  verbatim in four modules, and the umask-safe secret writer, which lived only
  in the amplifier-host binary even though the host registry needed the same
  guarantee. Both now have one definition in `amplifier_home.rs`.

## 0.1.56 — 2026-08-20

- Voice input asks this computer about the microphone before asking a remote
  compute host. `getTranscriptionStatus()` queried whichever bridge was
  persisted in localStorage and never the local process, so a desktop with a
  Spark configured asked the Spark whether speech-to-text was available. That
  host has no `OPENAI_API_KEY`, answered "unavailable", and the mic button went
  permanently disabled on a Mac holding a perfectly good key in
  `~/.amplifier/keys.env`. Capture happens in this machine's WebView, so this
  machine's credential is consulted first; the audio then goes to whichever side
  reported the credential. Mobile and browser clients still use the bridge.
- The mic button is no longer a dead toggle. It stays clickable and explains the
  problem when clicked: a disabled control with a tooltip is unreachable by
  touch and by screen readers, and the reason is exactly what the user needs. A
  denied microphone now names the remedy — System Settings → Privacy & Security
  → Microphone — instead of "Microphone recording could not start".
- The unavailable message names the file it looked in, rather than saying "add
  it to the runtime host", which is ambiguous the moment a desktop has a remote
  host configured.

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
