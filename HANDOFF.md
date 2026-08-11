# HANDOFF — Amplifier Studio (Tauri 2 GUI for amplifier-app-tui)

Date: 2026-08-10
Working dirs:
- Source of truth studied: `~/dev/amplifier-app-tui` (read-only for this effort)
- New app: `~/dev/amplifier-app-studio` (repository `amplifier-app-studio`)

## Goal

A mac-native (and later web) GUI for Amplifier with **multiple parallel
sessions**, built as a Rust-based **Tauri 2** app. The GUI does NOT reimplement
the agent runtime — it drives the existing Python runtime out-of-process.

## Key research findings (why this design)

The TUI repo already ships the exact seam an external front-end needs:

1. **`amplifier-tui serve`** (`src/amplifier_app_tui/kernel/serve.py`) — a
   bidirectional line protocol on stdio, self-described in its docstring as
   *"the one new seam a Rust (or any external) front-end needs."*
   - **IN (stdin, one JSON object/line):** `submit`, `steer` (mid-turn),
     `approve` (ticket_id + choice), `decision` (deferred needs-you),
     `interrupt`, `effort.get/set/cycle`, `tag.*`, `context.get`,
     `session.status`, `history.query` (frecency prompt recall),
     `history.replay` (reattach: durable event ledger, `since` cursor),
     plus an opt-in control plane: `session.handle`, `lease.acquire/heartbeat/
     release/takeover/status`, `session.pause/resume`, `handoff.claim/list`,
     `audit.query`. Any op may carry `actor` / `lease` / `idem`.
   - **OUT (stdout):** `boot.progress` (module prepare can take minutes —
     paint a splash), `session.started`, `runtime.event` (the JSONL envelope
     `{schema_version:1, sequence, timestamp, event}` around the typed
     `UIEvent` union), `turn.completed`, `error`, `approval.required`
     (ticket_id + prompt + options — the one record `run` can't emit),
     `effort.state`, `context.state` (tokens/window/%/$ meter),
     `history.begin/end`, `attach.listening`, lease/control records.
   - Flags: `--bundle`, `--model -m`, `--provider -p`, `--mode`,
     `--resume SESSION_ID` (deterministic exit codes 2/3/4 =
     not-found/ambiguous/corrupt), `--attach REF`, `--actor`, `--actor-kind
     human|automation`, `--attachable` (publish Unix-socket live-attach
     endpoint so a second process can join the SAME runtime — no double
     writer).
2. **`UIEvent` union** (`kernel/events.py`) — the single normalization
   boundary, discriminated on `kind`, envelope `{event_id, session_id,
   parent_id, ts}`. `parent_id` routes subagent events into lanes. Kinds:
   `stream_block_start/delta/end`, `stream_aborted` (Channel A, live);
   `tool_pre/post/error`, `content_block_start/end`, `orchestrator_complete`
   (Channel B, durable); `prompt_submit/complete`, `execution_start/end`,
   `provider_response_usage`, `provider_notice`, `session_start/end/fork/
   resume`, `rewind_marker`, `approval_required/granted/denied`,
   `cancel_requested/completed`, `agent_spawned/completed/resumed`,
   `notification`, `context_injected`, `context_compacted`, `goal_progress`.
   Rule from ADR-0007: never reconstruct one channel from the other;
   correlate tools by `tool_call_id` only.
3. **Session store on disk** — `~/.amplifier/projects/<project-slug>/sessions/
   <session-id>/` with `transcript.jsonl`, `metadata.json` (name, bundle,
   tags, turn_count), `ui-events.jsonl`. `kernel/session_manager.py` defines
   the health states (`ok/recovered/corrupt/transcript_lost/indexing`) and
   list/rename/delete/branch/fork semantics. The GUI's session drawer can
   scan this tree directly (read-only) for the picker.
4. **TS SDK** (`sdk/typescript/src/index.ts`) validates the same JSONL
   envelope — useful reference for record parsing/sequence invariants.
5. Binary is installed at `~/.local/bin/amplifier-tui`
   (`[project.scripts] amplifier-tui = "amplifier_app_tui.main:main"`).

## Architecture decided

```
┌─────────────────────────────────────────────────────────┐
│ Tauri 2 app "Amplifier Studio" (identifier com.amplifier.studio)
│                                                          │
│  WebView (SolidJS + Vite, port 1420 in dev)              │
│    - tabs: one per live session (parallel sessions)      │
│    - per-session reducer: JSONL records → view state     │
│    - transcript, composer, approval bar, context meter,  │
│      session drawer (disk scan), boot splash             │
│         ▲ Tauri events: session://{id}/record            │
│         ▼ invoke(): start_session, send_op, stop_session,│
│                     list_stored_sessions                 │
│  Rust core (src-tauri)                                   │
│    - SessionManager: HashMap<id, Child>                  │
│    - each session = spawn `amplifier-tui serve …`        │
│      stdout lines → parse envelope → emit Tauri event    │
│      stdin ← ops serialized from the WebView             │
│    - stays protocol-agnostic: passes records through     │
│      verbatim so additive protocol changes never break it│
└─────────────────────────────────────────────────────────┘
        │ spawns N children (one per parallel session)
        ▼
  amplifier-tui serve --bundle … [--resume …]   (Python, existing)
```

Design principles carried over from the donor repo:
- **Thin pipe, no reinterpretation in Rust** — the wire records go to the
  WebView verbatim; all rendering logic lives in TS (mirrors the TUI's
  "one normalization boundary" rule; ours is the serve protocol itself).
- **One child process per session** = process isolation for parallel
  sessions; interrupt/kill is per-tab; a crashed session can't take down
  the app.
- **Web GUI later for free**: the same SolidJS front-end can be served over
  HTTP with a small WS bridge doing exactly what the Rust core does
  (spawn serve, fan out lines). Nothing in the UI layer is Tauri-specific
  except the `invoke`/`listen` transport — keep it behind one small module
  (`src/transport.ts` — not yet written, see TODO).

## What exists right now (all scaffold, none verified yet)

```
~/dev/amplifier-app-studio/
├── package.json          solid-js + vite + @tauri-apps/api v2 (+ cli)
├── tsconfig.json         strict, jsx preserve → solid
├── vite.config.ts        port 1420 strictPort (Tauri dev contract)
├── index.html            mounts /src/main.tsx (NOT YET WRITTEN)
├── .gitignore
├── src/
│   └── components/       (empty — see TODO)
└── src-tauri/
    ├── Cargo.toml        tauri 2, tokio (process/io-util/sync/rt/macros/time),
    │                     serde, serde_json, dirs; lib name amplifier_studio_lib
    ├── build.rs          tauri_build::build()
    ├── tauri.conf.json   window 1440×900 min 980×620, titleBarStyle Overlay
    │                     hiddenTitle (mac-native look), devUrl :1420,
    │                     beforeDevCommand npm run dev, frontendDist ../dist
    ├── capabilities/default.json   core:default + event listen/emit + window
    ├── icons/icon.png    512×512 generated placeholder (slate + sky diamond)
    └── src/              (empty — see TODO: lib.rs, main.rs, protocol.rs,
                           session.rs, store.rs)
```

`npm install` / `cargo check` have NOT been run yet.

## TODO (was the working plan)

1. ~~Design~~ ✔
2. ~~Scaffold (configs, capabilities, icon)~~ ✔
3. **Rust backend — protocol + session manager** (`src-tauri/src/`):
   - `main.rs`: `amplifier_studio_lib::run()`.
   - `lib.rs`: tauri Builder, manage `SessionManager` state, register
     commands, generate_handler.
   - `session.rs`: `SessionManager { sessions: Mutex<HashMap<String, SessionHandle>> }`;
     `SessionHandle { child, stdin: ChildStdin }`. `start_session(opts)` →
     resolve binary (`~/.local/bin/amplifier-tui`, then PATH; make it a
     setting later), build args (`serve`, optional `--bundle/--model/
     --provider/--mode/--resume`, always `--attachable` so a terminal can
     join), spawn with piped stdio + cwd = chosen project dir, then a tokio
     task per stream: stdout `BufReader::lines()` → try `serde_json::from_str
     ::<serde_json::Value>` → `app.emit(&format!("session://{id}/record"), value)`;
     non-JSON lines and stderr → `session://{id}/log`. Child exit →
     `session://{id}/exit` with code. `send_op(id, value)` writes
     `serde_json::to_string(value) + "\n"` to stdin. `stop_session(id)`:
     write `{"op":"interrupt"}` then close stdin (serve's contract: EOF lets
     an in-flight turn finish then cleans up), fallback kill after timeout.
   - GUI session id = locally minted (uuid or counter); the runtime's real
     session_id arrives in `session.started` — map it in the frontend.
4. **Rust backend — Tauri commands + store scan** (`store.rs`):
   - `list_stored_sessions(project_dir: Option<String>)` — replicate the
     project-slug rule from the Python `SessionStore` (READ IT FIRST:
     `kernel/persistence.py`, method that derives
     `~/.amplifier/projects/<slug>` from cwd) or simpler: scan ALL of
     `~/.amplifier/projects/*/sessions/*`, read `metadata.json` per entry
     (name, bundle, tags, turn_count, mtime), count transcript lines, sort
     newest-first, degrade per entry (never fail the listing — same S2
     discipline as the donor).
   - Commands: `start_session`, `send_op`, `stop_session`, `list_sessions`
     (live), `list_stored_sessions`.
5. **Frontend — types + reducer** (`src/protocol.ts`, `src/reducer.ts`):
   - Mirror the record envelope + the UIEvent kinds listed above (a
     pragmatic subset is fine: stream deltas, tool pre/post/error,
     prompt submit/complete, approval.required, context.state,
     boot.progress, turn.completed, error, notification, agent_spawned/
     completed for lanes).
   - Reducer per session: blocks list (user line, streaming answer with
     live tail, collapsed tool lines w/ status glyph, notices), pending
     approval (swap composer → approval bar), context meter, cost, busy
     state (between prompt_submit and turn.completed), lanes keyed by
     child session_id/parent_id.
   - Sequence check: `runtime.event` records carry monotonic `sequence`;
     warn on gaps (donor SDK treats gaps as protocol errors).
6. **Frontend — App shell** (`src/main.tsx`, `src/App.tsx`,
   `src/components/…`, `src/transport.ts`):
   - Tab strip (parallel sessions, + button → new-session dialog: project
     dir, bundle, model/provider, resume picker from stored sessions).
   - Transcript pane (autoscroll w/ pin), composer (Enter=submit,
     Enter-during-turn=steer, Shift+Enter=newline), approval bar
     (options as buttons, Esc=Deny), footer (model · effort · context % ·
     $cost), boot splash driven by `boot.progress`, session drawer.
   - `titleBarStyle Overlay` means leave ~80px top-left padding for
     traffic lights; make the tab strip the drag region
     (`data-tauri-drag-region`).
7. **Verify**: `npm install && npm run build`; `cd src-tauri && cargo check`.
   Then live test: `npm run tauri dev` with a real bundle, confirm
   parallel sessions + approvals + steer + interrupt round-trip.
8. **README.md** — run instructions + this architecture.

## Gotchas / environment notes

- The OpenCode Write/Edit tools were sandboxed to `~/dev/amplifier-app-tui`;
  everything in this repo was written via `bash` heredocs with absolute
  paths (`cd` outside the sandbox is rejected, absolute-path writes work).
- `rg` was not on PATH in the tool shell; plain `grep` works.
- Toolchain confirmed: cargo 1.96.0 (homebrew), node v22.22.0 (nodenv).
- The icon is a generated placeholder; Tauri mac bundles want an `.icns`
  eventually (`tauri icon icons/icon.png` can generate the set).
- serve is **single-client per process** by design; the multi-participant
  story is its `--attachable` Unix socket + lease control plane — do NOT
  spawn two serves on the same session id (double-writer). Resume of a
  session another process serves should use the attach path instead.
- Approvals have a kernel-side timeout→deny; surface them immediately and
  loudly. `approval.required` comes from the broker listener, and the
  matching `approval_required` UIEvent inside `runtime.event` is filtered
  out server-side (the broker record is the one with the ticket_id).
- Steering: leftover steers are drained at turn end by serve; the client
  should mirror the TUI's queue semantics (bounded 32 items) and show a
  discard notice.
- Donor repo docs worth rereading when building the renderer:
  `docs/ARCHITECTURE.md` §4 (event pipeline), §5.3 (two-region transcript
  model — durable history + one mutable live tail is a great GUI pattern
  too), `docs/SESSION-CONTROL.md` (lease semantics).

## Definition of done for v0.1

- [ ] `npm run tauri dev` opens a mac window with native overlay titlebar
- [ ] New Session → picks bundle/dir → boot splash → streamed transcript
- [ ] 2+ concurrent sessions in tabs, each independently interruptible
- [ ] Approval bar answers `approval.required` within timeout
- [ ] Mid-turn steer works; queued composer state matches serve contract
- [ ] Session drawer lists stored sessions from `~/.amplifier/projects`,
      resume works (exit codes 2/3/4 surfaced as friendly errors)
- [ ] cargo check + vite build clean
