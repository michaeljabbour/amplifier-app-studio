use crate::protocol::{
    require_object, ProcessExit, ProcessLog, SessionEvent, StartSessionOptions, StartSessionResult,
};
use crate::runtime_setup;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
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
    resume_identity: Option<(String, String)>,
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
        reject_known_incompatible_tool_route(
            options.provider.as_deref(),
            options.model.as_deref(),
        )?;

        let project_dir = canonical_project_dir(&options.project_dir)?;
        let project_dir_string = project_dir.to_string_lossy().into_owned();

        {
            let sessions = self.sessions.lock().await;
            if sessions.contains_key(&options.gui_id) {
                return Err(format!("session '{}' already exists", options.gui_id));
            }
            if let Some(resume_id) = options.resume_id.as_deref() {
                let duplicate = sessions.values().any(|handle| {
                    handle
                        .resume_identity
                        .as_ref()
                        .is_some_and(|(project, session)| {
                            project == &project_dir_string && session == resume_id
                        })
                });
                if duplicate {
                    return Err(
                        "That stored session is already open in Amplifier Studio".to_owned()
                    );
                }
            }
        }

        if let Some(resume_id) = options.resume_id.as_deref() {
            let resume_id = resume_id.to_owned();
            let relocation_project = project_dir.clone();
            let relocated = tauri::async_runtime::spawn_blocking(move || {
                prepare_relocated_resume(&relocation_project, &resume_id)
            })
            .await
            .map_err(|error| format!("Session relocation check failed: {error}"))??;
            if let Some(source) = relocated {
                emit_log(
                    &sink,
                    &options.gui_id,
                    "bridge",
                    format!(
                        "Recovered the complete stored session after the project moved (source: {})",
                        source.display()
                    ),
                );
            }
        }

        let binary = runtime_setup::binary_or_command();
        let mut command = Command::new(&binary);
        if let Some(path) = runtime_setup::runtime_path(&binary) {
            command.env("PATH", path);
        }
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
                "Could not start {}: {error}. Install the Amplifier runtime at ~/.local/bin or on PATH.",
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
                handle
                    .resume_identity
                    .as_ref()
                    .is_some_and(|(project, session)| {
                        project == &project_dir_string && session == resume_id
                    })
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
            .ok_or_else(|| "The Amplifier runtime did not expose stdin".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "The Amplifier runtime did not expose stdout".to_owned())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "The Amplifier runtime did not expose stderr".to_owned())?;
        let attachment_id = self.next_attachment.fetch_add(1, Ordering::Relaxed);
        let attached_sink = Arc::new(RwLock::new(Some((attachment_id, sink))));
        let handle = SessionHandle {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            sink: attached_sink.clone(),
            resume_identity: options
                .resume_id
                .clone()
                .map(|resume_id| (project_dir_string.clone(), resume_id)),
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
            .map_err(|error| format!("Could not write to the Amplifier runtime: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush Amplifier runtime input: {error}"))
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
                    .map_err(|error| format!("Could not inspect the Amplifier runtime: {error}"))?
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
            .map_err(|error| format!("Could not stop the Amplifier runtime: {error}"))?;
        Ok(true)
    }

    /// Stop every runtime owned by this Studio process.
    ///
    /// Tauri restarts replace the GUI process. If its children are not
    /// explicitly drained first, an attachable Amplifier runtime process
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
    #[cfg(desktop)]
    pub fn resume_after_failed_update(&self) {
        self.accepting.store(true, Ordering::SeqCst);
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

fn reject_known_incompatible_tool_route(
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<(), String> {
    let provider = provider.unwrap_or_default().to_ascii_lowercase();
    let model = model.unwrap_or_default().to_ascii_lowercase();
    let direct_experiment = matches!(
        provider.as_str(),
        "runpod-kimi" | "runpod-glm" | "runpod-next"
    );
    let incompatible_model = model.contains("kimi-k3") || model.contains("glm-5.2");
    if direct_experiment || incompatible_model {
        return Err(
            "This RunPod route does not pass Amplifier's exact streaming tool-call contract. Use the checked runpod routing matrix or runpod-qwen instead."
                .to_owned(),
        );
    }
    Ok(())
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
        Some(code) => format!("Amplifier runtime exited with code {code}"),
        None => "Amplifier runtime ended without an exit code".to_owned(),
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

const RELOCATABLE_SESSION_FILES: &[&str] = &[
    "ui-events.jsonl",
    "transcript.jsonl.backup",
    "transcript.jsonl",
    "metadata.json.backup",
];

fn prepare_relocated_resume(
    project_dir: &Path,
    resume_id: &str,
) -> Result<Option<PathBuf>, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not resolve the Amplifier home directory".to_owned())?;
    prepare_relocated_resume_in(&home.join(".amplifier/projects"), project_dir, resume_id)
}

fn prepare_relocated_resume_in(
    projects_dir: &Path,
    project_dir: &Path,
    resume_id: &str,
) -> Result<Option<PathBuf>, String> {
    validate_resume_storage_id(resume_id)?;
    if !projects_dir.is_dir() {
        return Ok(None);
    }
    let destination = projects_dir
        .join(project_storage_slug(project_dir))
        .join("sessions")
        .join(resume_id);
    if readable_session_metadata(&destination).is_some() {
        return Ok(None);
    }

    let mut candidates = fs::read_dir(projects_dir)
        .map_err(|error| format!("Could not inspect Amplifier session stores: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("sessions").join(resume_id))
        .filter(|candidate| candidate != &destination)
        .filter_map(|candidate| {
            let metadata = readable_session_metadata(&candidate)?;
            let transcript = readable_transcript(&candidate);
            let modified = session_artifact_modified(&candidate);
            Some((candidate, metadata, transcript, modified))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, _, transcript, modified)| {
        std::cmp::Reverse((transcript.is_some(), *modified))
    });
    let Some((source, mut metadata, _, _)) = candidates.into_iter().next() else {
        return Ok(None);
    };
    if session_has_live_owner(&source) {
        return Err(
            "The complete copy of this session still advertises a live owner; close it before relocating the project"
                .to_owned(),
        );
    }

    fs::create_dir_all(&destination).map_err(|error| {
        format!(
            "Could not prepare relocated session directory '{}': {error}",
            destination.display()
        )
    })?;
    for name in RELOCATABLE_SESSION_FILES {
        let from = source.join(name);
        if from.is_file() {
            copy_session_file(&from, &destination.join(name))?;
        }
    }
    metadata.insert(
        "working_dir".to_owned(),
        Value::String(project_dir.to_string_lossy().into_owned()),
    );
    write_session_json(&destination.join("metadata.json"), &Value::Object(metadata))?;
    Ok(Some(source))
}

fn readable_session_metadata(session_dir: &Path) -> Option<serde_json::Map<String, Value>> {
    for name in ["metadata.json", "metadata.json.backup"] {
        let Ok(text) = fs::read_to_string(session_dir.join(name)) else {
            continue;
        };
        if let Ok(Value::Object(metadata)) = serde_json::from_str::<Value>(&text) {
            if metadata.get("recovered").and_then(Value::as_bool) != Some(true) {
                return Some(metadata);
            }
        }
    }
    None
}

fn session_has_live_owner(session_dir: &Path) -> bool {
    let Ok(text) = fs::read_to_string(session_dir.join("attach.json")) else {
        return false;
    };
    let Ok(Value::Object(advert)) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(socket_path) = advert.get("socket_path").and_then(Value::as_str) else {
        return false;
    };
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(socket_path).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = socket_path;
        false
    }
}

fn readable_transcript(session_dir: &Path) -> Option<PathBuf> {
    for name in ["transcript.jsonl", "transcript.jsonl.backup"] {
        let path = session_dir.join(name);
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .all(|line| serde_json::from_str::<Value>(line).is_ok())
        {
            return Some(path);
        }
    }
    None
}

fn session_artifact_modified(session_dir: &Path) -> std::time::SystemTime {
    ["metadata.json", "transcript.jsonl", "ui-events.jsonl"]
        .into_iter()
        .filter_map(|name| fs::metadata(session_dir.join(name)).ok()?.modified().ok())
        .max()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}

fn copy_session_file(source: &Path, destination: &Path) -> Result<(), String> {
    let temporary = destination.with_file_name(format!(
        ".{}.studio-relocate-{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("session"),
        std::process::id(),
    ));
    fs::copy(source, &temporary).map_err(|error| {
        format!(
            "Could not copy relocated session artifact '{}': {error}",
            source.display()
        )
    })?;
    replace_file(&temporary, destination)
}

fn write_session_json(destination: &Path, value: &Value) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize relocated session metadata: {error}"))?;
    let temporary = destination.with_file_name(format!(
        ".metadata.json.studio-relocate-{}.tmp",
        std::process::id(),
    ));
    fs::write(&temporary, contents).map_err(|error| {
        format!(
            "Could not stage relocated session metadata '{}': {error}",
            temporary.display()
        )
    })?;
    replace_file(&temporary, destination)
}

fn replace_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| {
            format!(
                "Could not replace relocated session artifact '{}': {error}",
                destination.display()
            )
        })?;
    }
    fs::rename(temporary, destination).map_err(|error| {
        format!(
            "Could not finalize relocated session artifact '{}': {error}",
            destination.display()
        )
    })
}

fn project_storage_slug(project_dir: &Path) -> String {
    let mut slug = project_dir
        .to_string_lossy()
        .replace(['/', '\\'], "-")
        .replace(':', "");
    if !slug.starts_with('-') {
        slug.insert(0, '-');
    }
    slug
}

fn validate_resume_storage_id(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err("Stored session id contains unsupported path characters".to_owned())
    }
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

    #[test]
    fn rehomes_a_complete_session_after_its_project_directory_moves() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join("projects");
        let project = temp.path().join("renamed-project");
        fs::create_dir_all(&project).unwrap();
        let session_id = "74197986-0d82-4038-9414-67b3c53efd7e";
        let source = projects
            .join("-old-project")
            .join("sessions")
            .join(session_id);
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("metadata.json"),
            serde_json::json!({ "session_id": session_id, "bundle": "tui", "turn_count": 23 })
                .to_string(),
        )
        .unwrap();
        fs::write(
            source.join("metadata.json.backup"),
            serde_json::json!({ "session_id": session_id, "bundle": "tui", "turn_count": 22 })
                .to_string(),
        )
        .unwrap();
        fs::write(
            source.join("transcript.jsonl"),
            "{\"role\":\"user\",\"content\":\"rename it\"}\n",
        )
        .unwrap();
        fs::write(
            source.join("ui-events.jsonl"),
            "{\"kind\":\"prompt_submit\"}\n",
        )
        .unwrap();

        let destination = projects
            .join(project_storage_slug(&project))
            .join("sessions")
            .join(session_id);
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("events.jsonl"), "relocated tail\n").unwrap();

        let relocated = prepare_relocated_resume_in(&projects, &project, session_id).unwrap();
        assert_eq!(relocated.as_deref(), Some(source.as_path()));
        assert_eq!(
            fs::read_to_string(destination.join("transcript.jsonl")).unwrap(),
            "{\"role\":\"user\",\"content\":\"rename it\"}\n"
        );
        assert_eq!(
            fs::read_to_string(destination.join("events.jsonl")).unwrap(),
            "relocated tail\n"
        );
        let metadata: Value =
            serde_json::from_str(&fs::read_to_string(destination.join("metadata.json")).unwrap())
                .unwrap();
        assert_eq!(metadata["working_dir"], project.to_string_lossy().as_ref());
        assert!(
            source.join("metadata.json").is_file(),
            "the original recovery copy is preserved"
        );
    }

    #[test]
    fn does_not_relocate_over_a_healthy_current_session() {
        let temp = tempfile::tempdir().unwrap();
        let projects = temp.path().join("projects");
        let project = temp.path().join("current-project");
        fs::create_dir_all(&project).unwrap();
        let session_id = "session-123";
        let destination = projects
            .join(project_storage_slug(&project))
            .join("sessions")
            .join(session_id);
        fs::create_dir_all(&destination).unwrap();
        fs::write(
            destination.join("metadata.json"),
            serde_json::json!({ "session_id": session_id, "bundle": "tui" }).to_string(),
        )
        .unwrap();

        assert_eq!(
            prepare_relocated_resume_in(&projects, &project, session_id).unwrap(),
            None
        );
    }

    #[test]
    fn rejects_known_runpod_routes_that_corrupt_tool_calls() {
        assert!(reject_known_incompatible_tool_route(
            Some("runpod-kimi"),
            Some("moonshotai/Kimi-K3")
        )
        .is_err());
        assert!(reject_known_incompatible_tool_route(
            Some("runpod-next"),
            Some("zai-org/GLM-5.2-FP8")
        )
        .is_err());
        assert!(reject_known_incompatible_tool_route(
            Some("runpod"),
            Some("deepseek-ai/DeepSeek-V4-Flash-0731")
        )
        .is_ok());
        assert!(reject_known_incompatible_tool_route(
            Some("runpod-qwen"),
            Some("Qwen/Qwen3-Coder-30B-A3B-Instruct")
        )
        .is_ok());
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
