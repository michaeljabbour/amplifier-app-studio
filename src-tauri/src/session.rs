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
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
    time::{sleep, timeout, Instant},
};

const STOP_GRACE: Duration = Duration::from_secs(5);
const STOP_TASK_GRACE: Duration = Duration::from_secs(8);
const EXIT_POLL: Duration = Duration::from_millis(120);

pub type EventSink = Arc<dyn Fn(SessionEvent) + Send + Sync + 'static>;
pub type AttachmentId = u64;

type AttachedSink = Arc<RwLock<Option<(AttachmentId, EventSink)>>>;

#[derive(Clone)]
struct SessionHandle {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    sink: AttachedSink,
    info: LiveSession,
}

#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    accepting: Arc<AtomicBool>,
    next_attachment: Arc<AtomicU64>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            accepting: Arc::new(AtomicBool::new(true)),
            next_attachment: Arc::new(AtomicU64::new(1)),
        }
    }
}

impl SessionManager {
    pub async fn start(
        &self,
        options: StartSessionOptions,
        sink: EventSink,
    ) -> Result<StartSessionResult, String> {
        self.start_attached(options, sink)
            .await
            .map(|(result, _)| result)
    }

    /// Start a runtime and return the attachment lease for its initial event
    /// subscriber. Native Tauri callers use [`start`]; the reconnectable web
    /// bridge keeps this id so a stale socket cannot detach a newer subscriber.
    pub async fn start_attached(
        &self,
        options: StartSessionOptions,
        sink: EventSink,
    ) -> Result<(StartSessionResult, AttachmentId), String> {
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(
                "Amplifier Studio is shutting down and cannot start another runtime".to_owned(),
            );
        }
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
        // Serialize the post-spawn gate and insertion with stop_all's map
        // snapshot. If shutdown won the race, this child never becomes owned
        // state; if insertion won, stop_all necessarily sees it.
        let mut sessions = self.sessions.lock().await;
        if !self.accepting.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("Amplifier Studio is shutting down and stopped the new runtime".to_owned());
        }
        if sessions.contains_key(&options.gui_id) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!("session '{}' already exists", options.gui_id));
        }
        if let Some(resume_id) = options.resume_id.as_deref() {
            let duplicate = sessions.values().any(|handle| {
                handle.info.project_dir == project_dir_string
                    && handle.info.resume_id.as_deref() == Some(resume_id)
            });
            if duplicate {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err("That stored session is already open in Amplifier Studio".to_owned());
            }
        }
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
        let attachment_id = self.next_attachment.fetch_add(1, Ordering::Relaxed);
        let attached_sink = Arc::new(RwLock::new(Some((attachment_id, sink))));
        let handle = SessionHandle {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            sink: attached_sink.clone(),
            info,
        };
        sessions.insert(options.gui_id.clone(), handle.clone());
        drop(sessions);

        let routed_sink = routed_sink(attached_sink);
        spawn_stdout_reader(routed_sink.clone(), options.gui_id.clone(), stdout);
        spawn_stderr_reader(routed_sink.clone(), options.gui_id.clone(), stderr);
        self.spawn_exit_monitor(routed_sink, options.gui_id.clone(), handle.child.clone());

        Ok((
            StartSessionResult {
                gui_id: options.gui_id,
                project_dir: project_dir_string,
            },
            attachment_id,
        ))
    }

    /// Replace the current event subscriber without changing the runtime.
    pub async fn attach(&self, gui_id: &str, sink: EventSink) -> Result<AttachmentId, String> {
        let handle = self
            .sessions
            .lock()
            .await
            .get(gui_id)
            .cloned()
            .ok_or_else(|| format!("live session '{gui_id}' was not found"))?;
        let attachment_id = self.next_attachment.fetch_add(1, Ordering::Relaxed);
        replace_sink(&handle.sink, Some((attachment_id, sink)))?;
        Ok(attachment_id)
    }

    /// Remove a subscriber only if it still owns the current attachment lease.
    /// The child process, stdin, and durable session remain alive.
    pub async fn detach(&self, gui_id: &str, attachment_id: AttachmentId) -> Result<bool, String> {
        let handle = match self.sessions.lock().await.get(gui_id).cloned() {
            Some(handle) => handle,
            None => return Ok(false),
        };
        let mut slot = handle
            .sink
            .write()
            .map_err(|_| "session event subscriber is unavailable".to_owned())?;
        if slot
            .as_ref()
            .is_some_and(|(current_id, _)| *current_id == attachment_id)
        {
            *slot = None;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Check that a web connection still owns the active subscriber lease.
    /// A reconnect replaces the lease, making operations from a stale socket
    /// harmless instead of creating a second writer.
    pub async fn attachment_is_current(
        &self,
        gui_id: &str,
        attachment_id: AttachmentId,
    ) -> Result<bool, String> {
        let handle = match self.sessions.lock().await.get(gui_id).cloned() {
            Some(handle) => handle,
            None => return Ok(false),
        };
        let slot = handle
            .sink
            .read()
            .map_err(|_| "session event subscriber is unavailable".to_owned())?;
        Ok(slot
            .as_ref()
            .is_some_and(|(current_id, _)| *current_id == attachment_id))
    }

    pub async fn send(&self, gui_id: &str, op: Value) -> Result<(), String> {
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(
                "Amplifier Studio is shutting down and cannot accept more operations".to_owned(),
            );
        }
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

    /// Stop every runtime owned by this Studio process.
    ///
    /// Tauri restarts replace the GUI process. If its children are not
    /// explicitly drained first, an attachable `amplifier-tui serve` process
    /// can survive with stdout still pointing at the departed GUI. A later
    /// Studio process then attaches to a live-but-unreadable owner and appears
    /// to accept messages without ever receiving their events.
    pub async fn stop_all(&self) -> Result<(), String> {
        self.accepting.store(false, Ordering::SeqCst);
        let gui_ids = self
            .sessions
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();

        let results = futures_util::future::join_all(gui_ids.into_iter().map(|gui_id| {
            let manager = self.clone();
            async move {
                match timeout(STOP_TASK_GRACE, manager.stop(&gui_id)).await {
                    Ok(result) => result.map_err(|error| format!("{gui_id}: {error}")),
                    Err(_) => Err(format!(
                        "{gui_id}: timed out while draining the Amplifier runtime"
                    )),
                }
            }
        }))
        .await;

        let errors = results
            .into_iter()
            .filter_map(Result::err)
            .collect::<Vec<_>>();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Could not stop every Amplifier runtime: {}",
                errors.join("; ")
            ))
        }
    }

    /// Re-open the manager after an updater failure that happened *after* the
    /// current runtimes were drained.
    ///
    /// Ordinary quit/restart paths never call this: once shutdown begins they
    /// remain closed. The updater is the sole recovery path because a failed
    /// install leaves the current Studio process alive and usable.
    pub fn resume_after_failed_update(&self) {
        self.accepting.store(true, Ordering::SeqCst);
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

fn routed_sink(slot: AttachedSink) -> EventSink {
    Arc::new(move |event| {
        let sink = slot
            .read()
            .ok()
            .and_then(|current| current.as_ref().map(|(_, sink)| sink.clone()));
        if let Some(sink) = sink {
            sink(event);
        }
    })
}

fn replace_sink(
    slot: &AttachedSink,
    next: Option<(AttachmentId, EventSink)>,
) -> Result<(), String> {
    *slot
        .write()
        .map_err(|_| "session event subscriber is unavailable".to_owned())? = next;
    Ok(())
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
    use std::sync::Mutex as StdMutex;

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

    #[tokio::test]
    async fn stopping_an_empty_manager_is_safe() {
        SessionManager::default().stop_all().await.unwrap();
    }

    #[tokio::test]
    async fn draining_manager_rejects_new_starts_and_operations() {
        let manager = SessionManager::default();
        manager.stop_all().await.unwrap();
        let sink: EventSink = Arc::new(|_| {});
        let error = manager
            .start(
                StartSessionOptions {
                    gui_id: "late-start".to_owned(),
                    project_dir: "/unused".to_owned(),
                    bundle: None,
                    model: None,
                    provider: None,
                    mode: None,
                    resume_id: None,
                },
                sink,
            )
            .await
            .unwrap_err();
        assert!(error.contains("shutting down"));
        assert!(manager
            .send(
                "late-start",
                serde_json::json!({ "op": "submit", "text": "no" })
            )
            .await
            .unwrap_err()
            .contains("shutting down"));
    }

    #[tokio::test]
    async fn failed_update_recovery_reopens_a_drained_manager() {
        let manager = SessionManager::default();
        manager.stop_all().await.unwrap();
        manager.resume_after_failed_update();

        let error = manager
            .send(
                "not-running",
                serde_json::json!({ "op": "submit", "text": "try again" }),
            )
            .await
            .unwrap_err();
        assert!(error.contains("not found"));
        assert!(!error.contains("shutting down"));
    }

    #[test]
    fn routed_sink_can_be_replaced_and_stale_detach_is_detectable() {
        let first_events = Arc::new(StdMutex::new(Vec::new()));
        let second_events = Arc::new(StdMutex::new(Vec::new()));
        let first_capture = first_events.clone();
        let second_capture = second_events.clone();
        let first: EventSink =
            Arc::new(move |event| first_capture.lock().unwrap().push(event.gui_id));
        let second: EventSink =
            Arc::new(move |event| second_capture.lock().unwrap().push(event.gui_id));
        let slot = Arc::new(RwLock::new(Some((1, first))));
        let route = routed_sink(slot.clone());

        route(SessionEvent {
            gui_id: "one".into(),
            channel: "record",
            payload: Value::Null,
        });
        replace_sink(&slot, Some((2, second))).unwrap();
        route(SessionEvent {
            gui_id: "two".into(),
            channel: "record",
            payload: Value::Null,
        });

        assert_eq!(*first_events.lock().unwrap(), vec!["one"]);
        assert_eq!(*second_events.lock().unwrap(), vec!["two"]);
        assert_eq!(slot.read().unwrap().as_ref().map(|(id, _)| *id), Some(2));
    }
}
