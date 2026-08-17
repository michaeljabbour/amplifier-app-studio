# Design QA — Amplifier Studio phone shell

## Comparison setup

- Primary references: the Settings, Amplifier Agent home, focused transcript, and ChatGPT mobile screenshots supplied during the review.
- Updated states: clean Settings, unified Amplifier Agent home, focused transcript scrolling, and transcript after `Jump to latest`.
- Viewport: iPhone 17 Pro, iOS 26.5, 1206 × 2622 pixels. The reference and updated Settings states were opened together at original resolution in one visual comparison pass.

## Fidelity and interaction review

- Header: the nonfunctional Chat/Work segmented control is gone. Phone chrome is now one 56 px safe-area row with a menu button, a plain centered `Amplifier Agent` title, and the runtime/settings control.
- Product language: the home eyebrow, transcript accessibility label, working state, answer label, composer prompt, and startup copy consistently call the surface `Amplifier Agent`.
- Project context: Settings no longer carries a project directory from one runtime host to another. Remembered contexts are isolated by host URL, and an active session contributes its directory only when its runtime URL matches the selected settings host.
- Settings regression: the stale remote-host project-directory validation error in the reference is absent. The connected host resolves its own configured project root in the updated Bundles state.
- Mobile hierarchy: the implementation keeps the reference-inspired safe-area app bar, one calm primary surface, bottom composer, and one-handed drawer while retaining Amplifier's warm editorial identity.
- Keyboard resilience: `visualViewport` height keeps fixed chrome and composer actions above the iOS keyboard without input auto-zoom. The focused shell is no longer transformed, avoiding a WebKit compositing trap around nested scrolling.
- Transcript navigation: the conversation owns a dedicated flexed `pan-y` scroll surface. While the composer is focused, a captured pointer pan drives the same scroll element and a native non-passive `touchstart` listener prevents WebKit from transferring focus. `Jump to latest` is an independent overlay, targets a bottom sentinel, and reasserts the exact final position.
- Icons and tap targets: visible controls use Lucide icons and 44–52 px primary touch targets; no emoji or hand-drawn substitute icons remain in the touched shell.

## Iteration log

1. Initial capture: P1 — desktop tab strip, dense status footer, overlapping mobile composer, and desktop modal/file-browser behavior.
2. First phone shell: P1 — desktop title-bar dragging intercepted mode taps; P2 — focused WKWebView could pan fixed chrome.
3. Resume flow: P1 — a fresh mobile client could still receive an already-open failure from a detached host runtime.
4. Keyboard pass: P1 — the app bar disappeared and the input accessory covered composer actions.
5. Settings pass: P1 — a generic `connected` storage key leaked a Linux project root from the Spark host into the local macOS host.
6. Header pass: P1 — Work was a separate control without a reliable mobile destination; the mode split also consumed disproportionate top chrome.
7. Final comparison: URL-qualified settings contexts, runtime-matched active project selection, and the unified Amplifier Agent header remove the reported P1 regressions. No visible P0, P1, or P2 findings remain in the compared state.
8. First transcript pass: P1 remained — moving the jump control fixed its button path, but Web Inspector measured a focused Simulator drag at `scrollTop: 1200` before and after; focus transferred from the textarea to the transcript.
9. Focused-scroll pass: the keyboard transform was removed, focused pointer/touch defaults are both canceled, and pointer movement is clamped directly onto the transcript. The live bundled handler moved `scrollTop` from `1200` to `1520` for a 320 px upward pan while retaining textarea focus. `Jump to latest` measured `scrollTop: 4644`, `max: 4644`, and removed itself.

## Verification

- Computer Use + Safari Web Inspector: launched the rebuilt app in Simulator, resumed the long transcript, reproduced the frozen focused state, measured real pointer/touch default cancellation with textarea focus retained, exercised the live pointer-move handler (`1200 → 1520`), and confirmed `Jump to latest` reaches the exact maximum (`4644`) and dismisses itself. The Computer Use drag injector emits down/up but no move events, so live move dispatch was exercised through the attached Inspector rather than inferred from screenshots.
- Frontend: 30 files, 155 tests passed.
- Rust: 46 tests passed, including fresh-client durable reattachment.
- Native: iPhone Simulator debug build succeeded and the rebuilt bundle was installed on iPhone 17 Pro / iOS 26.5.
- Source hygiene: `git diff --check` passed.

final result: passed
