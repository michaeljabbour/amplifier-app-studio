use crate::protocol::{
    require_object, LiveSession, ProcessExit, ProcessLog, SessionEvent, StartSessionOptions,
    StartSessionResult,
};
use crate::runtime_setup;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
    time::{sleep, Instant},
};

const STOP_GRACE: Duration = Duration::from_secs(5);
const EXIT_POLL: Duration = Duration::from_millis(120);

pub type EventSink = Arc<dyn Fn(SessionEvent) + Send + Sync + 'static>;

#[derive(Clone)]
struct SessionHandle {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    info: LiveSession,
}

#[derive(Clone, Default)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
}

impl SessionManager {
    pub async fn start(
        &self,
        options: StartSessionOptions,
        sink: EventSink,
    ) -> Result<StartSessionResult, String> {
        let options = options.trimmed();
        validate_gui_id(&options.gui_id)?;
        if options.project_dir.is_empty() {
            return Err("Choose a project directory before starting a session".to_owned());
        }
        if options.model.is_some() != options.provider.is_some() {
            return Err("Model and provider overrides must be supplied together".to_owned());
        }

        let project_dir = canonical_project_dir(&options.project_dir)?;
        let project_dir_string = project_dir.to_string_lossy().into_owned();

        {
            let sessions = self.sessions.lock().await;
            if sessions.contains_key(&options.gui_id) {
                return Err(format!("session '{}' already exists", options.gui_id));
            }
            if let Some(resume_id) = options.resume_id.as_deref() {
                let duplicate = sessions.values().any(|handle| {
                    handle.info.project_dir == project_dir_string
                        && handle.info.resume_id.as_deref() == Some(resume_id)
                });
                if duplicate {
                    return Err(
                        "That stored session is already open in Amplifier Studio".to_owned()
                    );
                }
            }
        }

        let binary = runtime_setup::binary_or_command();
        let mut command = Command::new(&binary);
        command.arg("serve");
        push_option(&mut command, "--bundle", options.bundle.as_deref());
        push_option(&mut command, "--model", options.model.as_deref());
        push_option(&mut command, "--provider", options.provider.as_deref());
        push_option(&mut command, "--mode", options.mode.as_deref());
        if let Some(resume_id) = options.resume_id.as_deref() {
            // `--attach` first joins a live owner and only falls back to a
            // stored resume. This preserves serve's no-double-writer rule if
            // a terminal process happens to own the selected session.
            command.arg("--attach").arg(resume_id);
        }
        command.arg("--attachable");
        command
            .current_dir(&project_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|error| {
            format!(
                "Could not start {}: {error}. Install amplifier-tui at ~/.local/bin or on PATH.",
                binary.display()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "amplifier-tui did not expose stdin".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "amplifier-tui did not expose stdout".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "amplifier-tui did not expose stderr".to_owned())?;
        let pid = child.id();

        let info = LiveSession {
            gui_id: options.gui_id.clone(),
            project_dir: project_dir_string.clone(),
            bundle: options.bundle.clone(),
            model: options.model.clone(),
            provider: options.provider.clone(),
            mode: options.mode.clone(),
            resume_id: options.resume_id.clone(),
            pid,
        };
        let handle = SessionHandle {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            info,
        };
        self.sessions
            .lock()
            .await
            .insert(options.gui_id.clone(), handle.clone());

        spawn_stdout_reader(sink.clone(), options.gui_id.clone(), stdout);
        spawn_stderr_reader(sink.clone(), options.gui_id.clone(), stderr);
        self.spawn_exit_monitor(sink, options.gui_id.clone(), handle.child.clone());

        Ok(StartSessionResult {
            gui_id: options.gui_id,
            project_dir: project_dir_string,
        })
    }

    pub async fn send(&self, gui_id: &str, op: Value) -> Result<(), String> {
        require_object(&op)?;
        let handle = self
            .sessions
            .lock()
            .await
            .get(gui_id)
            .cloned()
            .ok_or_else(|| format!("live session '{gui_id}' was not found"))?;
        let mut stdin = handle.stdin.lock().await;
        let stdin = stdin
            .as_mut()
            .ok_or_else(|| "session input is already closed".to_owned())?;
        let mut line = serde_json::to_vec(&op)
            .map_err(|error| format!("Could not serialize protocol operation: {error}"))?;
        line.push(b'\n');
        stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("Could not write to amplifier-tui: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush amplifier-tui input: {error}"))
    }

    pub async fn stop(&self, gui_id: &str) -> Result<bool, String> {
        let handle = match self.sessions.lock().await.get(gui_id).cloned() {
            Some(handle) => handle,
            None => return Ok(false),
        };

        // Interrupt first, then close stdin. serve treats EOF as a graceful
        // cleanup request and lets the interrupted turn settle its durable
        // state before exiting.
        if let Some(mut stdin) = handle.stdin.lock().await.take() {
            let _ = stdin.write_all(b"{\"op\":\"interrupt\"}\n").await;
            let _ = stdin.flush().await;
            drop(stdin);
        }

        let deadline = Instant::now() + STOP_GRACE;
        loop {
            let exited = {
                let mut child = handle.child.lock().await;
                child
                    .try_wait()
                    .map_err(|error| format!("Could not inspect amplifier-tui: {error}"))?
                    .is_some()
            };
            if exited {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                break;
            }
            sleep(EXIT_POLL).await;
        }

        let mut child = handle.child.lock().await;
        child
            .kill()
            .await
            .map_err(|error| format!("Could not stop amplifier-tui: {error}"))?;
        Ok(true)
    }

    pub async fn list(&self) -> Vec<LiveSession> {
        let mut sessions: Vec<_> = self
            .sessions
            .lock()
            .await
            .values()
            .map(|handle| handle.info.clone())
            .collect();
        sessions.sort_by(|left, right| left.gui_id.cmp(&right.gui_id));
        sessions
    }

    fn spawn_exit_monitor(&self, sink: EventSink, gui_id: String, child: Arc<Mutex<Child>>) {
        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            let status = loop {
                let result = {
                    let mut child = child.lock().await;
                    child.try_wait()
                };
                match result {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => sleep(EXIT_POLL).await,
                    Err(error) => {
                        emit_log(
                            &sink,
                            &gui_id,
                            "bridge",
                            format!("process monitor failed: {error}"),
                        );
                        break None;
                    }
                }
            };

            // Dropping the final stdin handle prevents a stale writer after
            // an unexpected process exit. Remove only this GUI id; ids are
            // unique for the lifetime of the app.
            sessions.lock().await.remove(&gui_id);
            let code = status.as_ref().and_then(std::process::ExitStatus::code);
            let payload = ProcessExit {
                code,
                message: exit_message(code),
            };
            emit_serialized(&sink, &gui_id, "exit", payload);
        });
    }
}

fn spawn_stdout_reader(sink: EventSink, gui_id: String, stdout: tokio::process::ChildStdout) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(record) if record.is_object() => {
                        emit_value(&sink, &gui_id, "record", record);
                    }
                    _ => emit_log(&sink, &gui_id, "stdout", line),
                },
                Ok(None) => break,
                Err(error) => {
                    emit_log(
                        &sink,
                        &gui_id,
                        "bridge",
                        format!("stdout read failed: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(sink: EventSink, gui_id: String, stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => emit_log(&sink, &gui_id, "stderr", line),
                Ok(None) => break,
                Err(error) => {
                    emit_log(
                        &sink,
                        &gui_id,
                        "bridge",
                        format!("stderr read failed: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn emit_log(sink: &EventSink, gui_id: &str, stream: &'static str, message: String) {
    emit_serialized(sink, gui_id, "log", ProcessLog { stream, message });
}

fn emit_serialized<T: serde::Serialize>(
    sink: &EventSink,
    gui_id: &str,
    channel: &'static str,
    payload: T,
) {
    match serde_json::to_value(payload) {
        Ok(payload) => emit_value(sink, gui_id, channel, payload),
        Err(error) => emit_value(
            sink,
            gui_id,
            "log",
            serde_json::json!({
                "stream": "bridge",
                "message": format!("could not serialize bridge event: {error}"),
            }),
        ),
    }
}

fn emit_value(sink: &EventSink, gui_id: &str, channel: &'static str, payload: Value) {
    sink(SessionEvent {
        gui_id: gui_id.to_owned(),
        channel,
        payload,
    });
}

fn exit_message(code: Option<i32>) -> String {
    match code {
        Some(0) => "Session closed cleanly".to_owned(),
        Some(2) => "Stored session was not found in this project".to_owned(),
        Some(3) => "Session id matched more than one stored session".to_owned(),
        Some(4) => "Stored session is damaged and cannot be resumed".to_owned(),
        Some(code) => format!("amplifier-tui exited with code {code}"),
        None => "amplifier-tui ended without an exit code".to_owned(),
    }
}

fn canonical_project_dir(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "Project directory '{}' is unavailable: {error}",
            path.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!("'{}' is not a directory", canonical.display()));
    }
    Ok(canonical)
}

fn push_option(command: &mut Command, flag: &str, value: Option<&str>) {
    if let Some(value) = value {
        command.arg(flag).arg(value);
    }
}

fn validate_gui_id(gui_id: &str) -> Result<(), String> {
    let valid = !gui_id.is_empty()
        && gui_id.len() <= 80
        && gui_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err("guiId must contain only letters, numbers, '-' or '_'".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_event_safe_gui_ids() {
        assert!(validate_gui_id("7c833764-b757-44a8").is_ok());
        assert!(validate_gui_id("bad/id").is_err());
        assert!(validate_gui_id("").is_err());
    }

    #[test]
    fn exit_codes_are_friendly() {
        assert!(exit_message(Some(2)).contains("not found"));
        assert!(exit_message(Some(3)).contains("more than one"));
        assert!(exit_message(Some(4)).contains("damaged"));
    }
}
