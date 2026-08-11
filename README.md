# Amplifier Studio

Amplifier Studio is a Tauri 2 native application for Windows, macOS, Android,
and iOS, plus a browser client for development and later hosted use. It keeps
multiple Amplifier sessions alive in parallel without embedding or
reimplementing the Python agent runtime.

The project is MIT licensed. The current release truth, including mobile,
security, runtime-installation, and signing gates, is maintained in
[`docs/RELEASE-READINESS.md`](docs/RELEASE-READINESS.md).

The interface is SolidJS inside each platform's native Tauri WebView. All app
and bridge logic is Rust. Every live tab ultimately owns one
`amplifier-tui serve --attachable` process on a machine that has the existing
runtime installed.

## Runtime topology

```text
macOS / Windows Tauri app              iOS / Android Tauri app or browser
          │ local Tauri IPC                         │ WebSocket
          └──────────────┐             ┌────────────┘
                         ▼             ▼
                    Rust SessionManager
                   one child process per tab
                             │ JSONL
                             ▼
                    amplifier-tui serve
                    existing Python runtime
```

Desktop apps run the Rust `SessionManager` in-process and spawn the Python
runtime locally. Mobile operating systems cannot host an arbitrary Python
child executable, so the native iOS and Android shells connect to the same
Rust manager on a desktop/server host. `src/transport.ts` is the only place
that chooses between Tauri IPC and WebSocket; the reducer and interface are
identical on every target.

The bundled Rust web host binds only to `127.0.0.1` in v0.1. A physical mobile
device therefore needs an authenticated TLS tunnel or reverse proxy in front
of that loopback service. Configure its HTTPS URL using the gear button in the
app, or provide `VITE_STUDIO_BRIDGE_URL` at build time. Do not expose the
bridge directly to a network; approvals and filesystem-capable agent requests
cross this boundary.

## Implemented product surface

- Parallel sessions in independent native tabs
- Responsive phone, tablet, and desktop layouts with safe-area handling
- Boot progress, elapsed phase labels, streamed response tails, and durable
  thinking/transcript blocks (including honest provider-withheld placeholders)
- Tool calls correlated only by `tool_call_id`
- Approval and deferred-decision bars
- Amplifier-owned default `auto` posture; mode flags are sent only when the
  user explicitly chooses an override
- Mid-turn steering with the runtime's 32-item queue bound
- Per-tab interrupt and graceful child shutdown
- Context, cost, model, mode, effort, and one lane per subagent, including
  concurrent child tools correlated by `tool_call_id`
- A persistent Coordinator chat in the center with clickable agent workspaces,
  run/build/output/context inspectors, and live per-agent timelines
- Installed bundle and provider discovery through the Rust bridge; selecting a
  different composition opens an isolated sibling runtime without stopping the
  current machine
- Active-session Autopilot: it continues an idle coordinator or steers the
  coordinator's current turn, and never creates a replacement session
- An outcome-first Machine Library for Coordinator, Browser Use, built-in
  Terminal Use, Imagen, and Attractor, grounded in Amplifier's canonical
  `MODULES.md` catalog; app control remains a capability of the active runtime
- Typed output capture for concrete file, image, diagram, and dataset paths
  returned by tools
- Recoverable setup conditions (such as a missing stored bundle) live in the
  machine inspector instead of masquerading as chat messages
- Read-only all-project session drawer with project-path recovery for TUI/CLI
  sessions and safe resume/reattach
- Friendly errors for resume exit codes 2, 3, and 4
- Runtime-selectable HTTPS bridge setting for native mobile clients
- Generated Windows `.ico`, macOS `.icns`, Android, and iOS icon sets
- Signed desktop update discovery and install/restart through GitHub Releases

## Desktop development

Requirements are Node 22+, Rust 1.77+, and an `amplifier-tui` installation
that includes `serve`. The bridge resolves `~/.local/bin/amplifier-tui` first,
then `amplifier-tui` on `PATH`.

```bash
npm install
npm run tauri dev
```

Build the native package for the current desktop platform:

```bash
npm run tauri -- build
```

The macOS overlay titlebar is platform-specific. Windows uses normal native
window chrome. Platform configuration lives in `src-tauri/tauri.*.conf.json`.

## Web demonstration

Build the SolidJS client and serve it from the Rust bridge:

```bash
export AMPLIFIER_STUDIO_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export AMPLIFIER_STUDIO_ALLOWED_PROJECT_ROOTS="$PWD"
npm run web:serve
```

Then open <http://127.0.0.1:4317>, open Bridge settings, and enter the token.
The browser uses an authenticated WebSocket path and can start real Amplifier
sessions; it is not a static mock. Project execution is default-deny and every
allowed root is canonicalized before use. For split development, allow Vite's
exact origin and run the bridge and client separately:

```bash
export AMPLIFIER_STUDIO_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export AMPLIFIER_STUDIO_ALLOWED_PROJECT_ROOTS="$PWD"
export AMPLIFIER_STUDIO_ALLOWED_ORIGINS="http://127.0.0.1:1420"
npm run web:bridge
npm run dev
```

The token may instead come from `--token-file PATH`. A remote client must use
an authenticated TLS tunnel or reverse proxy; the included host remains
loopback-only.

For development against a specific runtime checkout, set
`AMPLIFIER_STUDIO_RUNTIME_BIN` to that checkout's `amplifier-tui` executable.
Packaged builds otherwise prefer `~/.local/bin/amplifier-tui` and then `PATH`.

## Android

Initialize once and build an APK/AAB through Tauri:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export PATH="$HOME/.cargo/bin:$PATH" # use rustup's Android stdlib targets
npm run android:init -- --ci
npm run android:build -- --debug --target aarch64 --apk
```

The generated Android Studio project is under `src-tauri/gen/android`. Use
`npm run android:dev` for an attached device or emulator. Set the bridge URL
from the app's gear button before starting a session.

## iOS

On macOS with Xcode, CocoaPods, and an installed iOS Simulator runtime:

```bash
npm run ios:init -- --ci
npm run ios:dev
# or
npm run ios:build -- --target aarch64 --ci
```

The generated Xcode project is under `src-tauri/gen/apple`. App Store/device
builds still require the normal Apple signing team and provisioning setup.

## Validation

```bash
npm run build
npm test
cd src-tauri
cargo fmt --check
cargo test --all-targets
cargo check --all-targets
```

The browser-to-runtime pipe can be checked without consuming a model turn:
connect to `/api/session/<gui-id>`, send a `start` message, wait for
`session.started`, send `context.get`, then send `stop`.

## Publishing desktop updates

The release workflow in `.github/workflows/publish.yml` builds macOS (Apple
Silicon and Intel), Windows, and Linux packages. It also creates Tauri's signed
updater artifacts and `latest.json`. Published desktop builds check that file
after launch and show an **Update _version_** control in the top bar when a
newer release exists. Updates never interrupt an active turn; the control
enables after running turns finish or are interrupted.

The updater public key is committed in `src-tauri/tauri.conf.json`. Its
passwordless private counterpart was generated locally at
`~/.tauri/amplifier-studio.key`; keep it private and back it up. Before the
first release, create a GitHub Actions secret named
`TAURI_SIGNING_PRIVATE_KEY` containing that file's contents. The optional
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret may remain empty for this key.

macOS releases must also be signed with a stable Developer ID identity. An
ad-hoc development signature is tied to a single build's code hash, so macOS
can treat every rebuilt app as a new application and repeat Files & Folders
consent prompts. On a Mac with a Developer ID Application certificate in the
login keychain, build a signed package with:

```bash
npm run macos:build:signed
```

The script discovers the certificate without committing a developer-specific
identity to this open-source repository. `APPLE_SIGNING_IDENTITY` can override
the selection. GitHub publishing requires `APPLE_CERTIFICATE` (base64 `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`,
`APPLE_PASSWORD`, and `APPLE_TEAM_ID` secrets in addition to the Tauri updater
key. The workflow imports the certificate, signs both macOS architectures, and
lets Tauri notarize them before publishing.

Windows releases require `WINDOWS_CERTIFICATE` (base64 `.pfx`),
`WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_CERTIFICATE_THUMBPRINT` (the
certificate's 40-character SHA-1 thumbprint), and `WINDOWS_TIMESTAMP_URL`.
Store all desktop signing secrets in the protected `release` environment so
its deployment rules act as the human release gate.

To publish, update the version in `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`, and the generated iOS `Info.plist`/`project.yml`,
then push a matching tag such as `studio-v0.2.0`. `npm run release:check`
rejects a desktop/mobile marketing-version mismatch.
The tag-triggered workflow holds a draft GitHub Release while all four desktop
builds finish, generates one complete cross-platform `latest.json`, and then
publishes the release as the repository's latest release automatically.
`releases/latest/download/latest.json` becomes the update feed only after that
final job succeeds. Production desktop builds check the canonical Amplifier
Studio feed by default; set `VITE_STUDIO_UPDATER_ENABLED=false` for a local or
forked production build that must not check upstream. Development builds leave
updates disabled unless the flag is explicitly set to `true`.

Android and iOS updates should continue through Google Play and the App Store;
desktop-style binary replacement is intentionally limited to Windows, macOS,
and Linux.

## Protocol boundary

Rust deliberately does not interpret runtime records. A child stdout line that
parses as a JSON object passes through verbatim on the `record` channel;
stderr and non-JSON stdout become `log` events. The desktop event bus and web
socket both receive the same transport-neutral `SessionEvent`.

The renderer preserves the donor's two-channel rule: live stream events update
only the mutable tail, durable content/tool events create transcript blocks,
and one channel is never reconstructed from the other. Sequenced live records
are checked for gaps. Replayed ledger cursors are exempt.

For resume, the bridge uses `--attach <session-id>`. On Unix this joins a live
owner when present and otherwise resumes storage. The donor gracefully skips
live Unix-socket advertisement on Windows, where stored resume remains
available.

## Coordinator engine direction

The center conversation is intentionally permanent: selecting an agent,
output, bundle, provider, or context view opens it beside the Coordinator chat
instead of navigating away from the conversation that owns the work.

The current streaming implementation uses `amplifier-tui serve` because it
already exposes live deltas, approvals, steering, subagent events, and durable
replay. The longer-term resource boundary is compatible with
[`amplifier-agent`](https://github.com/microsoft/amplifier-agent): Studio owns
logical session continuity and the control plane, while the engine executes a
fresh process per turn. Adopting that adapter is a transport change, not a UI
rewrite; `src/transport.ts` and the Rust manager are the intended seams. The
Studio control API must exist before the Coordinator can truthfully start,
pause, place, or reconfigure other logical sessions through natural language.
