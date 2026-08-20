# Studio PTY foundation

This slice makes terminal sessions a Studio domain instead of embedding the
MuxPlex application. No MuxPlex PWA, FastAPI implementation, CSS, settings
storage, or vendored terminal assets are copied here.

## Boundary

`src/terminal/types.ts` is the backend-neutral contract. It names host and
project identity, lifecycle, connection generation, reconnect state, attention,
scrollback cursors, capabilities, and these operations:

- list, create, attach, detach, terminate, and rename;
- capture and older-scrollback paging;
- authorized input and PTY resize.

`TerminalCoordinator` owns concurrent attachments and suppresses callbacks from
an older socket after a reconnect or session switch. Reconnect calls `attach`
again and never calls `create`, so the durable tmux session is not respawned.

`MuxplexTerminalAdapter` implements the contract using MuxPlex's public API:

| Studio operation | MuxPlex operation |
| --- | --- |
| list | `GET /api/sessions` |
| create | `POST /api/sessions` |
| attach/reconnect | idempotent `POST /api/sessions/{name}/connect`, then `WS /terminal/ws?session=...` with subprotocol `tty` |
| detach | close only this Studio WebSocket |
| terminate | `DELETE /api/sessions/{name}` |
| rename | `POST /api/sessions/{name}/rename` |
| capture/page | `GET /api/sessions/{name}?lines=...&before=...` |
| command input | `POST /api/sessions/{name}/input` |
| interactive input/resize | ttyd binary commands `0x30` / `0x31` |

Detach intentionally does not call `DELETE /api/sessions/current`. That MuxPlex
endpoint clears group-global selection; using it for one of two explicitly
addressed Studio attachments could disturb the other. Closing the client relay
is the honest per-terminal detach and leaves tmux running.

## Credential and TLS integration

The TypeScript adapter never accepts a token, base URL, certificate bypass, or
credential query parameter. It receives an injected `MuxplexTransport` that
only sees relative paths. The native host is responsible for resolving a host
record and its credential reference.

The Tauri integration should add two thin commands behind that interface:

1. `terminal_http_request(host_id, request)` — resolve the bearer key from the
   OS keychain or protected host configuration, add `Accept: application/json`
   and `Authorization` host-side, and execute only allowlisted relative MuxPlex
   routes.
2. `terminal_open_socket(host_id, request, channel)` — open the authenticated
   WebSocket with the `tty` subprotocol and forward opaque binary/text frames
   through a Tauri channel. The TypeScript adapter continues to own ttyd frame
   semantics.

Use the system trust store or a user-approved CA bundle for both commands.
Never use `danger_accept_invalid_certs`, `verify=false`, a localhost exemption,
URL tokens, or `localStorage` credentials. Rust remains a credentialed byte
transport; lifecycle, reconnect generations, paging, and authorization state
remain in TypeScript.

## Work-surface integration

`src/components/TerminalWorkSurface.tsx` is a Studio MADE vertical slice with a
host/project session rail, live/read-only/reconnect state, attention badges,
safe create/rename/detach/terminate controls, paged scrollback, a command
composer, and a compact mobile layout. It renders terminal output as sanitized
plain text; a later full-screen TUI milestone can replace only the screen view
with a terminal emulator without changing the coordinator or adapter.

Exact App integration points:

1. Construct one `TerminalBackend` per configured runtime host after the native
   transport is available. Start with `inputAuthorization: "read-only"` unless
   the operator's host policy explicitly grants MuxPlex input.
2. Add a `TerminalCoordinator` to the Studio workbench owner and dispose it when
   that host workspace closes.
3. Add a `Terminal sessions` destination to `CapabilityPalette` or the top
   workbench switcher and render `<TerminalWorkSurface coordinator={...} />` in
   the center work area. This branch deliberately does not edit `App.tsx`, so it
   can merge independently of the concurrent usability work.
4. On mobile, route the same component as a full-height workspace rather than a
   modal. Its session rail becomes a horizontal picker and its command actions
   retain 44-pixel targets below 720px.

## Current adapter assumptions

- One adapter targets one local MuxPlex host. Federation sessions can become a
  second backend implementation; this slice does not guess remote credentials
  or reuse MuxPlex's federation proxy.
- MuxPlex supports explicit per-session ttyd WebSockets, rename, and absolute
  `before` scrollback cursors. Older servers need capability negotiation before
  enabling those controls.
- MuxPlex does not expose a caller-specific input-capability endpoint. Studio's
  host policy therefore defaults to read-only, and an HTTP 403 permanently
  downgrades that terminal for the coordinator lifetime.
- `POST /api/sessions/{name}/input` is used for deliberate line/key actions so
  server authorization failures are visible. Low-latency interactive bytes are
  only sent when the injected host policy already grants input.
