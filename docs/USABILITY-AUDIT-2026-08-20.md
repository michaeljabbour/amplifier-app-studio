# Amplifier Studio usability audit — 2026-08-20

This audit covers the desktop Studio, its iOS/Android layout contract, durable
session continuity, multi-session controls, and the first Studio-owned PTY
workbench. The evidence board is in
[Figma](https://www.figma.com/board/GXAr3LncAGLCjrOIjGkR0n/Amplifier-Studio-%E2%80%94-Session-Continuity-UX-Audit).

## Outcome

Studio 0.1.42 makes the durable runtime visible and recoverable instead of
treating a tab as the process itself. The same design language now covers Agent
sessions, mobile Work, and native terminal sessions. The release intentionally
does not claim durable mobile host authentication; that remains blocked on a
reviewed OS-keychain/keystore implementation and signed physical-device proof.

## Evidence and root causes

- The three reported screenshots were captured from installed Studio 0.1.40,
  even though the header offered an update to 0.1.41. The runtime emitted 49
  transcript messages and the native bridge delivered all 51 replay records
  (begin, 49 messages, end). Studio 0.1.40 did not reduce
  `transcript.message`; 0.1.41 already fixed that compatibility hole.
- The exact reported history was converted into a reducer regression: 25 user
  messages and 24 assistant messages remain ordered through `history.end`, an
  idle status update, and two trailing notices.
- The original close path discarded the tab after a rejected stop request. On
  phone layouts the only close control was hidden, and the drawer offered no
  lifecycle action.
- Output actions used the globally selected bridge instead of the session's
  owning host. Remote output could therefore open against the wrong machine.
- Mobile hid the Work/Inspector surface, so run state, plan, outputs, context,
  and child-agent activity were unreachable.
- Remote WebSocket loss only appeared in diagnostic logs. The composer still
  looked ready and failed only after send.
- `New session` invoked a native folder picker before explaining what Studio
  was about to create.
- MUX Plex contains a mature tmux product, but its FastAPI service, PWA,
  federation settings, CSS, and ttyd lifecycle are coupled to that product.
  Copying them would also inherit an unauthenticated writable ttyd boundary and
  conflicting ownership of global tmux hooks.

## Changes made

| Area | Change | User-visible result |
| --- | --- | --- |
| History | Require the accepted transcript batch to match the runtime's exact replay count, add the 49-message release regression, and reveal the last restored exchange | A partial or empty replay cannot masquerade as a complete restore |
| Lifecycle | Split **Detach view** from destructive **Stop runtime**; keep detached live runtimes in the mobile and desktop drawers; retain failed-stop state | Closing a view no longer silently stops or makes paid work unreachable |
| Tabs | Added native tab semantics, roving Arrow/Home/End focus, and separate close buttons | Parallel sessions are keyboard-operable and screen-reader coherent |
| Remote state | Bound outputs to the owning host and surfaced connected/reconnecting state | Drafts remain visible and sending is disabled honestly while offline |
| Desktop setup | Opened the Studio setup sheet before the native folder picker | The user understands project, host, bundle, and model choices before leaving the app |
| Mobile Work | Added a full-screen Work hub with Run, Loop, Plan, Setup, Bundles, Outputs, and Context; global attention opens its owning session | A background approval never opens an unrelated session |
| Mobile lifecycle | Added touch-sized overflow actions for Detach and Stop | A phone user can stop cost-bearing work explicitly |
| Mobile navigation | Hydrate the real compute-host ID before readiness checks and route Android Back through the topmost Studio surface | Cold start no longer falls back to a false local-runtime error, and Back dismisses UI before leaving the app |
| Mobile setup | Replaced the dark-theme engine card and duplicate remote actions with one MADE surface and **Connect compute host** action | The setup blocker is legible and unambiguous on phone |
| Reading scale | Raised MADE operational text and terminal scale while preserving the existing typography and palette | Dense controls remain legible without changing the product character |
| PTY workbench | Added backend-neutral contracts, a coordinator, MUX Plex adapter boundary, native tmux adapter, and Studio-native work surface; bind IO to immutable pane IDs and key drafts by terminal; make the live pane consume the remaining workbench height | Local durable shells can be supervised without another tmux client redirecting a command, and the terminal reads as a first-class Studio workspace rather than an embedded utility |
| Release security | Every Vite build mode and release check inspect loaded env files and reject `VITE_STUDIO_BRIDGE_TOKEN`; disposable QA builds require an explicit override | A bearer credential cannot be smuggled into a published client through a custom build mode or env file |

## PTY ownership and safety

The native desktop backend is a thin Rust argv bridge. It never invokes a
shell, uses an exact session plus immutable `%pane_id` for pane IO, bounds
names/input/capture/geometry, and only
terminates with `tmux kill-session -t =name`. Detach, reconnect, polling
failure, and Studio shutdown never create or terminate a tmux session. Studio
does not call `kill-server` and does not own the tmux process tree. Text plus
Enter is one literal PTY write, and passive/external sessions are not resized.

MUX Plex remains a reference and optional remote backend. Studio does not
import its server package or frontend. A future remote adapter must receive
credentials from native protected storage, verify TLS through the system trust
store, default input to denied, and keep view permission distinct from typing
permission.

## Remaining release boundary

Mobile currently persists host metadata but keeps the bearer credential only
for the WebView session. Cold relaunch therefore cannot authenticate a saved
host. The existing native host registry/keychain commands are desktop-only.
The audited Tauri Stronghold support matrix does not claim tested iOS/Android
support, and the closest community keyring plugin would require a Rust toolchain
and entitlement change plus an Android backend that is still described as
pre-release. No plaintext fallback was added.

Required acceptance before advertising durable mobile hosts:

1. iOS Keychain and Android Keystore-backed implementations behind the existing
   native host command names.
2. Signed physical-device tests for cold relaunch, locked device, credential
   rotation/removal, reinstall, backup behavior, and token-leak scanning.
3. A reviewed entitlement/toolchain/dependency change and a first-class pairing
   flow that stores the credential only after a successful host probe.

## Validation record

- Frontend: 40 Vitest files / 229 tests, 10 release tests, typecheck, production
  build, and version advance check all passed.
- Rust: formatting, 60 all-target tests, and all-target check passed.
- Native tmux: isolated exact-name create, immutable-pane input after another
  client switched the active window, capture, detach/reconnect, and exact
  single-session cleanup passed.
- Mobile: iPhone 17 Pro simulator build/install/launch passed; the same-viewport
  before/after comparison verifies the MADE setup-card contrast and single CTA.
  Android universal debug APK build passed. Physical-device credential
  persistence is explicitly not claimed.
- Visual: reported screenshots and audit captures are preserved on the Figma
  board. A rebuilt macOS QA app was then driven through the real Terminal
  toggle, terminal creation, command submission, live output, Detach, and
  Terminate surface. The same-viewport comparison exposed and fixed the empty
  lower work area, duplicate desktop Agent action, and disabled-looking MADE
  composer; the implemented before/after frame and decision note are on the
  board.
