# Tauri IPC command surface

Every `#[tauri::command]` is an entry point reachable by any JavaScript running in Studio's main
webview. **Tauri v2 capabilities do not gate app-defined commands** — the allowlist in
`src-tauri/capabilities/` scopes *plugin* commands only. A minimal capability file therefore says
nothing about this surface, which is why it needed auditing separately.

Threat model: an attacker needs script execution inside the main webview. The CSP forbids inline
and remote script, and agent-authored markdown goes through DOMPurify, so this is not reachable
today. But agent output *is* untrusted — a model reading a hostile repository can be
prompt-injected — so a sanitizer bypass would escalate directly to whatever these commands allow.
That makes their blast radius worth bounding on its own.

35 commands: 28 in `lib.rs`, 7 in `local_tmux.rs`.

## Commands that reach the filesystem or credentials

| Command | Untrusted input | Guard | Bounded |
|---|---|---|---|
| `open_output` | `project_dir`, `path` | `resolve_output_path`: canonicalize both, reject outside project | yes |
| `read_output_preview` | `project_dir`, `path` | same | yes, size-capped |
| `list_stored_sessions` | `project_dir` | `canonical_project_dir` | n/a |
| `export_stored_session` | `project_dir`, `session_id` | `canonical_project_dir` + slug charset | n/a |
| `import_stored_session` | payload | schema-checked, 32 MB body cap on the HTTP twin | yes |
| `clone_github_repository` | url, dir | strict `https://github.com/owner/repo` parser, argv-only git with `--` | yes |
| `list_catalog` / `add_bundle` | `project_dir` | `canonical_project_dir` | n/a |
| `read_runtime_settings` / `apply_runtime_settings` | `project_dir` | `canonical_project_dir` | n/a |
| `load_attachment_paths` | **any absolute path** | **none beyond existence** | count 8, 20 MB each, 64 MB docx inflation |
| `write_diagnostics` | **any absolute path** | absolute + parent is a directory | 64 MB |
| `resolve_runtime_host_token` | host `id` | registry lookup | returns a **plaintext bearer token** to JS |
| `store_runtime_host_token` | host `id`, token | length 32–4096; macOS Security framework, Windows Credential Manager, Linux 0600 file under `$AMPLIFIER_HOME/credentials` | yes |
| `terminal_tmux_*` (7) | session name | validated argv bridge, charset-checked | yes |

Everything else (`fetch_update`, `install_update`, `start_session`, `send_op`, `stop_session`,
`runtime_status`, `install_runtime`, `configure_provider`, `transcription_status`,
`transcribe_audio`, `list_runtime_hosts`, `save_runtime_host`, `remove_runtime_host`,
`default_project_dir`) does not take a caller-supplied path.

## Known gaps

Three commands are broader than they need to be. All are logged as of 0.1.50 so abuse is at least
visible, but logging is not a control.

1. **`load_attachment_paths` is an arbitrary-file-read primitive.** It accepts any absolute path
   and returns base64 to the webview. Only the JS-side picker in `src/nativePickers.ts` scopes it.
2. **`write_diagnostics` is an arbitrary-file-write primitive**, up to 64 MB, scoped only by the
   JS-side save dialog.
3. **`resolve_runtime_host_token` hands a bearer token to JS** with no caller check.

A home-directory allowlist would not help: the credentials worth stealing (`~/.ssh`, `~/.aws`)
live under home, and legitimate attachments come from anywhere.

The real fix is to stop trusting JS with the path at all: move the native dialog into Rust
(`tauri-plugin-dialog` has a Rust API) so the backend both chooses the path and uses it, or issue
a single-use backend-held capability from the dialog result. That is a change to the picker flow
and needs interactive testing on each desktop platform, so it is deliberately not bundled with the
logging change — see the note in `CHANGELOG.md` for 0.1.50.
