//! Local tmux transport for Studio's terminal domain.
//!
//! This module is intentionally a narrow argv bridge. It validates identifiers
//! and bounds, invokes the local `tmux` executable without a shell, and returns
//! raw pane/session data. Connection generations, polling, reconnect, and all
//! UI state remain in TypeScript.

use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Output;
use tokio::process::Command;

const MAX_CAPTURE_LINES: u32 = 5_000;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_KEYS: usize = 32;
const NOT_FOUND: &str = "TMUX_SESSION_NOT_FOUND";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTmuxSession {
    name: String,
    created_at: Option<u64>,
    last_activity_at: Option<u64>,
    cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTmuxCapture {
    snapshot: String,
    history_size: u32,
    pane_height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxInvocation {
    program: &'static str,
    args: Vec<OsString>,
}

impl TmuxInvocation {
    fn new(args: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        Self {
            program: "tmux",
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    async fn output(self) -> Result<Output, String> {
        Command::new(self.program)
            .args(&self.args)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    "tmux is not installed or is not available on Studio's PATH".to_owned()
                } else {
                    format!("Could not invoke tmux: {error}")
                }
            })
    }
}

#[tauri::command]
pub async fn terminal_tmux_list() -> Result<Vec<LocalTmuxSession>, String> {
    let output = TmuxInvocation::new([
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_created}\t#{session_activity}\t#{pane_current_path}",
    ])
    .output()
    .await?;
    if !output.status.success() {
        let stderr = output_text(&output.stderr);
        if no_server_running(&stderr) {
            return Ok(Vec::new());
        }
        return Err(tmux_failure("list sessions", &output));
    }

    Ok(parse_session_list(&output_text(&output.stdout)))
}

#[tauri::command]
pub async fn terminal_tmux_create(name: String, project_dir: Option<String>) -> Result<(), String> {
    validate_session_name(&name)?;
    let mut args = vec![
        OsString::from("new-session"),
        OsString::from("-d"),
        OsString::from("-s"),
        OsString::from(&name),
    ];
    if let Some(project_dir) = project_dir {
        let cwd = validate_project_dir(&project_dir)?;
        args.push(OsString::from("-c"));
        args.push(cwd.into_os_string());
    }
    run_checked("create session", TmuxInvocation::new(args)).await?;
    ensure_exact_session(&name).await
}

#[tauri::command]
pub async fn terminal_tmux_capture(name: String, lines: u32) -> Result<LocalTmuxCapture, String> {
    validate_session_name(&name)?;
    if !(1..=MAX_CAPTURE_LINES).contains(&lines) {
        return Err(format!(
            "Capture lines must be between 1 and {MAX_CAPTURE_LINES}"
        ));
    }
    let target = exact_pane_target(&name);
    let snapshot = run_checked(
        "capture session",
        TmuxInvocation::new(vec![
            OsString::from("capture-pane"),
            OsString::from("-p"),
            OsString::from("-J"),
            OsString::from("-t"),
            OsString::from(&target),
            OsString::from("-S"),
            OsString::from(format!("-{lines}")),
        ]),
    )
    .await?;
    let metrics = run_checked(
        "inspect session history",
        TmuxInvocation::new(vec![
            OsString::from("display-message"),
            OsString::from("-p"),
            OsString::from("-t"),
            OsString::from(target),
            OsString::from("#{history_size}\t#{pane_height}"),
        ]),
    )
    .await?;
    let mut fields = metrics.trim_end().splitn(2, '\t');
    let history_size = fields
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let pane_height = fields
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok(LocalTmuxCapture {
        snapshot,
        history_size,
        pane_height,
    })
}

#[tauri::command]
pub async fn terminal_tmux_send(
    name: String,
    text: Option<String>,
    keys: Vec<String>,
    enter: bool,
) -> Result<(), String> {
    validate_session_name(&name)?;
    if !text.as_deref().is_some_and(|value| !value.is_empty()) && keys.is_empty() && !enter {
        return Err("Terminal input cannot be empty".to_owned());
    }
    if text
        .as_ref()
        .is_some_and(|value| value.len() > MAX_INPUT_BYTES)
    {
        return Err(format!(
            "Terminal input cannot exceed {MAX_INPUT_BYTES} UTF-8 bytes"
        ));
    }
    if text.as_ref().is_some_and(|value| value.contains('\0')) {
        return Err("Terminal input cannot contain a NUL byte".to_owned());
    }
    if keys.len() > MAX_KEYS {
        return Err(format!(
            "A terminal input can contain at most {MAX_KEYS} keys"
        ));
    }

    let invocations = send_invocations(&name, text.as_deref(), &keys, enter)?;
    for invocation in invocations {
        run_checked("send terminal input", invocation).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_tmux_resize(name: String, columns: u16, rows: u16) -> Result<(), String> {
    validate_session_name(&name)?;
    if !(2..=1_000).contains(&columns) || !(1..=1_000).contains(&rows) {
        return Err("Terminal size must be between 2x1 and 1000x1000".to_owned());
    }
    run_checked(
        "resize session",
        TmuxInvocation::new(vec![
            OsString::from("resize-window"),
            OsString::from("-t"),
            OsString::from(exact_pane_target(&name)),
            OsString::from("-x"),
            OsString::from(columns.to_string()),
            OsString::from("-y"),
            OsString::from(rows.to_string()),
        ]),
    )
    .await
    .map(|_| ())
}

#[tauri::command]
pub async fn terminal_tmux_rename(name: String, new_name: String) -> Result<(), String> {
    validate_session_name(&name)?;
    validate_session_name(&new_name)?;
    if name == new_name {
        return Ok(());
    }
    run_checked(
        "rename session",
        TmuxInvocation::new(vec![
            OsString::from("rename-session"),
            OsString::from("-t"),
            OsString::from(exact_target(&name)),
            OsString::from(&new_name),
        ]),
    )
    .await?;
    ensure_exact_session(&new_name).await
}

#[tauri::command]
pub async fn terminal_tmux_terminate(name: String) -> Result<(), String> {
    validate_session_name(&name)?;
    run_checked("terminate session", terminate_invocation(&name))
        .await
        .map(|_| ())
}

async fn ensure_exact_session(name: &str) -> Result<(), String> {
    run_checked(
        "verify session",
        TmuxInvocation::new(["has-session", "-t", &exact_target(name)]),
    )
    .await
    .map(|_| ())
}

async fn run_checked(operation: &str, invocation: TmuxInvocation) -> Result<String, String> {
    let output = invocation.output().await?;
    if !output.status.success() {
        return Err(tmux_failure(operation, &output));
    }
    Ok(output_text(&output.stdout))
}

fn tmux_failure(operation: &str, output: &Output) -> String {
    let stderr = output_text(&output.stderr);
    let message = stderr.trim();
    if missing_session(message) {
        return format!("{NOT_FOUND}: The tmux session no longer exists");
    }
    if message.is_empty() {
        format!("Could not {operation}: tmux exited with {}", output.status)
    } else {
        format!("Could not {operation}: {message}")
    }
}

fn output_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn no_server_running(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("no server running")
        || stderr.contains("failed to connect to server")
        || stderr.contains("error connecting to")
}

fn missing_session(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("can't find session")
        || stderr.contains("can't find window")
        || stderr.contains("can't find pane")
        || stderr.contains("session not found")
}

fn validate_project_dir(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("The terminal project folder must be an absolute path".to_owned());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not open terminal project folder: {error}"))?;
    if !canonical.is_dir() {
        return Err("The terminal project folder is not a directory".to_owned());
    }
    Ok(canonical)
}

fn validate_session_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    let first_ok = bytes
        .first()
        .is_some_and(|value| value.is_ascii_alphanumeric() || *value == b'_');
    let rest_ok = bytes
        .iter()
        .skip(1)
        .all(|value| value.is_ascii_alphanumeric() || matches!(*value, b'_' | b'-'));
    if bytes.len() > 64 || !first_ok || !rest_ok {
        return Err(
            "Terminal names must be 1-64 ASCII letters, numbers, underscores, or hyphens and cannot start with a hyphen"
                .to_owned(),
        );
    }
    Ok(())
}

fn exact_target(name: &str) -> String {
    format!("={name}")
}

fn exact_pane_target(name: &str) -> String {
    // `=` makes the session segment exact; the trailing `:` selects its
    // active window/pane. Passing only `=name` to a target-pane command is
    // rejected by tmux (and dropping `=` would reintroduce prefix matching).
    format!("={name}:")
}

fn parse_session_list(stdout: &str) -> Vec<LocalTmuxSession> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(4, '\t');
            let name = fields.next()?.to_owned();
            // Studio only operates exact, tmux-stable identifiers. Existing
            // sessions with names outside this set stay untouched and hidden.
            validate_session_name(&name).ok()?;
            let created_at = fields.next().and_then(|value| value.parse().ok());
            let last_activity_at = fields.next().and_then(|value| value.parse().ok());
            let cwd = fields
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            Some(LocalTmuxSession {
                name,
                created_at,
                last_activity_at,
                cwd,
            })
        })
        .collect()
}

fn send_invocations(
    name: &str,
    text: Option<&str>,
    keys: &[String],
    enter: bool,
) -> Result<Vec<TmuxInvocation>, String> {
    let target = exact_pane_target(name);
    let mut result = Vec::new();
    if let Some(text) = text.filter(|value| !value.is_empty()) {
        result.push(exit_copy_mode_invocation(&target));
        result.push(TmuxInvocation::new(vec![
            OsString::from("send-keys"),
            OsString::from("-l"),
            OsString::from("-t"),
            OsString::from(&target),
            OsString::from("--"),
            OsString::from(text),
        ]));
    }
    for key in keys
        .iter()
        .map(|value| validate_key(value))
        .chain(enter.then_some(Ok("Enter")))
    {
        let key = key?;
        result.push(exit_copy_mode_invocation(&target));
        result.push(TmuxInvocation::new(vec![
            OsString::from("send-keys"),
            OsString::from("-t"),
            OsString::from(&target),
            OsString::from(key),
        ]));
    }
    Ok(result)
}

fn exit_copy_mode_invocation(target: &str) -> TmuxInvocation {
    TmuxInvocation::new(["copy-mode", "-q", "-t", target])
}

fn validate_key(key: &str) -> Result<&str, String> {
    match key {
        "Enter" | "Escape" | "Tab" | "C-c" | "C-d" | "Up" | "Down" | "Left" | "Right"
        | "PageUp" | "PageDown" => Ok(key),
        _ => Err(format!("Unsupported terminal key: {key}")),
    }
}

fn terminate_invocation(name: &str) -> TmuxInvocation {
    TmuxInvocation::new(["kill-session", "-t", &exact_target(name)])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(invocation: &TmuxInvocation) -> Vec<String> {
        invocation
            .args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn accepts_only_exact_tmux_stable_session_names() {
        for valid in ["a", "studio-build", "_agent_12", "A1"] {
            assert!(validate_session_name(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            "-leading",
            "has space",
            "build.js",
            "name:window",
            "$(touch /tmp/pwned)",
            "snowman-☃",
        ] {
            assert!(validate_session_name(invalid).is_err(), "{invalid}");
        }
        assert!(validate_session_name(&"a".repeat(65)).is_err());
    }

    #[test]
    fn literal_input_is_one_argv_and_never_a_shell_program() {
        let hostile = "; rm -rf / && $(reboot) `id` | tee /tmp/pwned";
        let plans = send_invocations("alpha", Some(hostile), &[], true).unwrap();
        assert!(plans.iter().all(|plan| plan.program == "tmux"));
        assert!(plans
            .iter()
            .all(|plan| !args(plan).iter().any(|arg| arg == "-c")));
        assert_eq!(
            args(&plans[1]),
            vec!["send-keys", "-l", "-t", "=alpha:", "--", hostile]
        );
        assert_eq!(
            plans
                .iter()
                .flat_map(args)
                .filter(|value| value == hostile)
                .count(),
            1
        );
    }

    #[test]
    fn terminate_targets_one_exact_session_and_never_the_server() {
        let plan = terminate_invocation("studio-build");
        assert_eq!(plan.program, "tmux");
        assert_eq!(args(&plan), vec!["kill-session", "-t", "=studio-build"]);
        assert!(!args(&plan).iter().any(|value| value == "kill-server"));
    }

    #[test]
    fn session_list_filters_names_that_cannot_be_operated_exactly() {
        let parsed = parse_session_list(
            "alpha\t1\t2\t/work/alpha\nbuild.js\t3\t4\t/work/dot\nbeta\t5\t6\t/work/beta\n",
        );
        assert_eq!(
            parsed
                .iter()
                .map(|session| session.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
        assert_eq!(parsed[0].cwd.as_deref(), Some("/work/alpha"));
    }

    #[test]
    fn key_allowlist_excludes_tmux_prefix_and_arbitrary_tokens() {
        assert!(validate_key("C-c").is_ok());
        assert!(validate_key("C-b").is_err());
        assert!(validate_key("; kill-server").is_err());
    }
}
