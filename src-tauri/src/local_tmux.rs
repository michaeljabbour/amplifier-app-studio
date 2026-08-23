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
const SESSION_FORMAT: &str = "#{session_name}\t#{session_id}\t#{pane_id}\t#{session_created}\t#{session_activity}\t#{pane_current_path}";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTmuxSession {
    name: String,
    session_id: String,
    pane_id: String,
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
    cursor_x: u32,
    cursor_y: u32,
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
                    // The commands are registered for every desktop target, so Windows reaches
                    // here too. "Install tmux" is not advice a Windows user can act on, and the
                    // old wording implied a PATH problem they could fix.
                    if cfg!(windows) {
                        "The terminal workbench needs tmux, which does not run on Windows. Use a session on a macOS or Linux compute host instead.".to_owned()
                    } else {
                        "tmux is not installed or is not available on Studio's PATH".to_owned()
                    }
                } else {
                    format!("Could not invoke tmux: {error}")
                }
            })
    }
}

#[tauri::command]
pub async fn terminal_tmux_list() -> Result<Vec<LocalTmuxSession>, String> {
    let output = TmuxInvocation::new(["list-sessions", "-F", SESSION_FORMAT])
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
pub async fn terminal_tmux_create(
    name: String,
    project_dir: Option<String>,
) -> Result<LocalTmuxSession, String> {
    validate_session_name(&name)?;
    let mut args = vec![
        OsString::from("new-session"),
        OsString::from("-d"),
        OsString::from("-P"),
        OsString::from("-F"),
        OsString::from(SESSION_FORMAT),
        OsString::from("-s"),
        OsString::from(&name),
    ];
    if let Some(project_dir) = project_dir {
        let cwd = validate_project_dir(&project_dir)?;
        args.push(OsString::from("-c"));
        args.push(cwd.into_os_string());
    }
    let output = run_checked("create session", TmuxInvocation::new(args)).await?;
    let session = parse_session_list(&output)
        .into_iter()
        .next()
        .ok_or_else(|| {
            "tmux created a session without returning a stable pane identity".to_owned()
        })?;
    if session.name != name {
        return Err("tmux returned a different session than Studio created".to_owned());
    }
    ensure_exact_session(&name).await?;
    Ok(session)
}

#[tauri::command]
pub async fn terminal_tmux_capture(
    name: String,
    pane_id: String,
    lines: u32,
) -> Result<LocalTmuxCapture, String> {
    validate_session_name(&name)?;
    validate_pane_id(&pane_id)?;
    if !(1..=MAX_CAPTURE_LINES).contains(&lines) {
        return Err(format!(
            "Capture lines must be between 1 and {MAX_CAPTURE_LINES}"
        ));
    }
    let target = exact_pane_target(&name, &pane_id)?;
    let snapshot = run_checked(
        "capture session",
        TmuxInvocation::new(vec![
            OsString::from("capture-pane"),
            OsString::from("-p"),
            OsString::from("-e"),
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
            OsString::from("#{history_size}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}"),
        ]),
    )
    .await?;
    let mut fields = metrics.trim_end().splitn(4, '\t');
    let history_size = fields
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let pane_height = fields
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let cursor_x = fields
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let cursor_y = fields
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok(LocalTmuxCapture {
        snapshot,
        history_size,
        pane_height,
        cursor_x,
        cursor_y,
    })
}

#[tauri::command]
pub async fn terminal_tmux_send(
    name: String,
    pane_id: String,
    text: Option<String>,
    keys: Vec<String>,
    enter: bool,
) -> Result<(), String> {
    validate_session_name(&name)?;
    validate_pane_id(&pane_id)?;
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

    let invocations = send_invocations(&name, &pane_id, text.as_deref(), &keys, enter)?;
    for invocation in invocations {
        run_checked("send terminal input", invocation).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_tmux_resize(
    name: String,
    pane_id: String,
    columns: u16,
    rows: u16,
) -> Result<(), String> {
    validate_session_name(&name)?;
    validate_pane_id(&pane_id)?;
    if !(2..=1_000).contains(&columns) || !(1..=1_000).contains(&rows) {
        return Err("Terminal size must be between 2x1 and 1000x1000".to_owned());
    }
    run_checked(
        "resize session",
        TmuxInvocation::new(vec![
            OsString::from("resize-window"),
            OsString::from("-t"),
            OsString::from(exact_pane_target(&name, &pane_id)?),
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
    // The absolute-path requirement is genuinely stricter than the shared rule, so it layers on
    // top rather than being folded in.
    if !Path::new(value.trim()).is_absolute() {
        return Err("The terminal project folder must be an absolute path".to_owned());
    }
    crate::project_dir::canonical_project_dir(value)
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

fn validate_session_id(session_id: &str) -> Result<(), String> {
    validate_tmux_id(session_id, b'$', "session")
}

fn validate_pane_id(pane_id: &str) -> Result<(), String> {
    validate_tmux_id(pane_id, b'%', "pane")
}

fn validate_tmux_id(value: &str, prefix: u8, kind: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if !(2..=21).contains(&bytes.len())
        || bytes[0] != prefix
        || !bytes[1..].iter().all(u8::is_ascii_digit)
    {
        return Err(format!("Invalid tmux {kind} identity"));
    }
    Ok(())
}

fn exact_target(name: &str) -> String {
    format!("={name}")
}

fn exact_pane_target(name: &str, pane_id: &str) -> Result<String, String> {
    validate_session_name(name)?;
    validate_pane_id(pane_id)?;
    // The exact session qualifier prevents a valid pane id from crossing the
    // session boundary if a pane is moved. The immutable `%pane_id` prevents
    // another tmux client changing the active window/pane from retargeting IO.
    Ok(format!("={name}:.{pane_id}"))
}

fn parse_session_list(stdout: &str) -> Vec<LocalTmuxSession> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, '\t');
            let name = fields.next()?.to_owned();
            // Studio only operates exact, tmux-stable identifiers. Existing
            // sessions with names outside this set stay untouched and hidden.
            validate_session_name(&name).ok()?;
            let session_id = fields.next()?.to_owned();
            validate_session_id(&session_id).ok()?;
            let pane_id = fields.next()?.to_owned();
            validate_pane_id(&pane_id).ok()?;
            let created_at = fields.next().and_then(|value| value.parse().ok());
            let last_activity_at = fields.next().and_then(|value| value.parse().ok());
            let cwd = fields
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            Some(LocalTmuxSession {
                name,
                session_id,
                pane_id,
                created_at,
                last_activity_at,
                cwd,
            })
        })
        .collect()
}

fn send_invocations(
    name: &str,
    pane_id: &str,
    text: Option<&str>,
    keys: &[String],
    enter: bool,
) -> Result<Vec<TmuxInvocation>, String> {
    let target = exact_pane_target(name, pane_id)?;
    let mut result = Vec::new();
    if let Some(text) = text.filter(|value| !value.is_empty()) {
        result.push(exit_copy_mode_invocation(&target));
        // The command-composer path sends text + Enter as one literal byte
        // sequence, so even pane destruction cannot split the command from
        // its submission. A carriage return is the PTY byte for Enter.
        let literal = if enter && keys.is_empty() {
            format!("{text}\r")
        } else {
            text.to_owned()
        };
        result.push(TmuxInvocation::new(vec![
            OsString::from("send-keys"),
            OsString::from("-l"),
            OsString::from("-t"),
            OsString::from(&target),
            OsString::from("--"),
            OsString::from(literal),
        ]));
    }
    let enter = enter && !(text.is_some_and(|value| !value.is_empty()) && keys.is_empty());
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
        let plans = send_invocations("alpha", "%17", Some(hostile), &[], true).unwrap();
        assert!(plans.iter().all(|plan| plan.program == "tmux"));
        assert!(plans
            .iter()
            .all(|plan| !args(plan).iter().any(|arg| arg == "-c")));
        assert_eq!(
            args(&plans[1]),
            vec![
                "send-keys",
                "-l",
                "-t",
                "=alpha:.%17",
                "--",
                &format!("{hostile}\r"),
            ]
        );
        assert_eq!(
            plans
                .iter()
                .flat_map(args)
                .filter(|value| value == &format!("{hostile}\r"))
                .count(),
            1
        );
        assert_eq!(
            plans
                .iter()
                .filter(|plan| args(plan).iter().any(|value| value == "Enter"))
                .count(),
            0,
            "text + Enter must be one literal PTY write"
        );
    }

    #[test]
    fn pane_targets_are_exact_scoped_immutable_ids() {
        assert_eq!(exact_pane_target("alpha", "%42").unwrap(), "=alpha:.%42");
        for invalid in ["42", "%", "%1:2", "%$(id)", "%1.other"] {
            assert!(validate_pane_id(invalid).is_err(), "{invalid}");
        }
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
            "alpha\t$1\t%2\t1\t2\t/work/alpha\nbuild.js\t$3\t%4\t3\t4\t/work/dot\nbeta\t$5\t%6\t5\t6\t/work/beta\n",
        );
        assert_eq!(
            parsed
                .iter()
                .map(|session| session.name.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );
        assert_eq!(parsed[0].session_id, "$1");
        assert_eq!(parsed[0].pane_id, "%2");
        assert_eq!(parsed[0].cwd.as_deref(), Some("/work/alpha"));
    }

    #[test]
    fn key_allowlist_excludes_tmux_prefix_and_arbitrary_tokens() {
        assert!(validate_key("C-c").is_ok());
        assert!(validate_key("C-b").is_err());
        assert!(validate_key("; kill-server").is_err());
    }

    #[test]
    fn immutable_pane_target_survives_an_active_window_switch() {
        use std::process::Command as StdCommand;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        if StdCommand::new("tmux").arg("-V").output().is_err() {
            return;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let socket = format!("studio-pane-test-{}-{nonce}", std::process::id());
        let tmux = |args: &[&str]| {
            StdCommand::new("tmux")
                .arg("-L")
                .arg(&socket)
                .args(args)
                .output()
                .expect("run isolated tmux")
        };
        let checked = |args: &[&str]| {
            let output = tmux(args);
            assert!(
                output.status.success(),
                "tmux {:?}: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            output
        };

        checked(&["new-session", "-d", "-s", "alpha", "-n", "one"]);
        checked(&["new-window", "-d", "-t", "=alpha", "-n", "two"]);
        let pane_one_output = checked(&["list-panes", "-t", "=alpha:one", "-F", "#{pane_id}"]);
        let pane_one = String::from_utf8_lossy(&pane_one_output.stdout)
            .trim()
            .to_owned();
        let plans = send_invocations(
            "alpha",
            &pane_one,
            Some("printf STUDIO_IMMUTABLE_PANE"),
            &[],
            true,
        )
        .unwrap();
        assert_eq!(plans.len(), 2, "text + Enter is one send-keys invocation");

        // Exit copy mode while window one is active, then let another client
        // switch the session before Studio sends the command.
        for plan in plans.iter().take(1) {
            let plan_args = args(plan);
            checked(&plan_args.iter().map(String::as_str).collect::<Vec<_>>());
        }
        checked(&["select-window", "-t", "=alpha:two"]);
        for plan in plans.iter().skip(1) {
            let plan_args = args(plan);
            checked(&plan_args.iter().map(String::as_str).collect::<Vec<_>>());
        }

        let mut pane_one_capture = String::new();
        for _ in 0..20 {
            let captured = checked(&["capture-pane", "-p", "-t", &pane_one]);
            pane_one_capture = String::from_utf8_lossy(&captured.stdout).into_owned();
            if pane_one_capture.contains("STUDIO_IMMUTABLE_PANE") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let pane_two_capture = checked(&["capture-pane", "-p", "-t", "=alpha:two"]);
        let pane_two_capture = String::from_utf8_lossy(&pane_two_capture.stdout);
        assert!(pane_one_capture.contains("STUDIO_IMMUTABLE_PANE"));
        assert!(!pane_two_capture.contains("STUDIO_IMMUTABLE_PANE"));

        // The isolated server exits when its only exact session is removed;
        // production code never invokes kill-server.
        checked(&["kill-session", "-t", "=alpha"]);
    }
}
