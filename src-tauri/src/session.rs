use crate::protocol::{
    require_object, ProcessExit, ProcessLog, SessionEvent, StartSessionOptions, StartSessionResult,
};
use crate::runtime_setup;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{watch, Mutex, RwLock},
    time::{sleep, timeout, Instant},
};

const STOP_GRACE: Duration = Duration::from_secs(5);
const STOP_TASK_GRACE: Duration = Duration::from_secs(8);
const EXIT_POLL: Duration = Duration::from_millis(120);
const SINK_BACKPRESSURE_RETRY: Duration = Duration::from_millis(2);
#[cfg(not(test))]
const EVENT_REATTACH_GRACE: Duration = Duration::from_secs(5);
#[cfg(test)]
const EVENT_REATTACH_GRACE: Duration = Duration::from_millis(200);
pub const DUPLICATE_RESUME_ERROR: &str = "That stored session is already open in Amplifier Studio";

/// Returns `true` when the event was accepted (or no subscriber remains) and
/// `false` when a bounded transport needs the runtime reader to apply
/// backpressure and retry. This keeps a durable history burst larger than the
/// WebSocket queue from silently losing its tail.
pub type EventSink = Arc<
    dyn for<'event> Fn(&'event SessionEvent) -> Pin<Box<dyn Future<Output = bool> + Send + 'event>>
        + Send
        + Sync
        + 'static,
>;
pub type AttachmentId = u64;

#[derive(Debug, Clone)]
pub struct NetworkPrincipal {
    pub id: String,
    pub kind: &'static str,
    pub permissions: &'static str,
}

type AttachedSink = Arc<AttachmentSlot>;

struct AttachmentSlot {
    current: RwLock<Option<(AttachmentId, EventSink)>>,
    changes: watch::Sender<u64>,
    released: AtomicBool,
}

fn attached_sink(initial: Option<(AttachmentId, EventSink)>) -> AttachedSink {
    let (changes, _) = watch::channel(0);
    Arc::new(AttachmentSlot {
        current: RwLock::new(initial),
        changes,
        released: AtomicBool::new(false),
    })
}

#[derive(Clone)]
struct SessionHandle {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    sink: AttachedSink,
    resume_identity: Option<(String, String)>,
    detached_owner: bool,
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
        self.start_attached_as(options, sink, None).await
    }

    /// Start a runtime for an authenticated network peer. The host adapter
    /// authenticates transport; amplifier-runtime's StaticPolicy remains the
    /// authority for read/write/control and lease semantics.
    pub async fn start_network_attached(
        &self,
        options: StartSessionOptions,
        sink: EventSink,
        principal: NetworkPrincipal,
    ) -> Result<(StartSessionResult, AttachmentId), String> {
        self.start_attached_as(options, sink, Some(principal)).await
    }

    async fn start_attached_as(
        &self,
        options: StartSessionOptions,
        sink: EventSink,
        network_principal: Option<NetworkPrincipal>,
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
                    return Err(DUPLICATE_RESUME_ERROR.to_owned());
                }
            }
        }

        let binary = runtime_setup::binary_or_command();
        let detached_owner = network_principal.is_some();
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
        if detached_owner {
            command.arg("--detached");
        }
        if let Some(principal) = network_principal {
            command
                .arg("--peer-principal")
                .arg(principal.id)
                .arg("--peer-kind")
                .arg(principal.kind)
                .arg("--peer-permissions")
                .arg(principal.permissions);
        }
        command
            .current_dir(&project_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(!detached_owner);
        let durable_stderr = if detached_owner {
            let path = detached_runtime_log_path(&options.gui_id)?;
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|error| {
                    format!(
                        "Could not open durable runtime log {}: {error}",
                        path.display()
                    )
                })?;
            command.stderr(Stdio::from(file));
            Some(path)
        } else {
            command.stderr(Stdio::piped());
            None
        };

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
                return Err(DUPLICATE_RESUME_ERROR.to_owned());
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
        let stderr = child.stderr.take();
        let attachment_id = self.next_attachment.fetch_add(1, Ordering::Relaxed);
        let attached_sink = attached_sink(Some((attachment_id, sink)));
        let handle = SessionHandle {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            sink: attached_sink.clone(),
            resume_identity: options
                .resume_id
                .clone()
                .map(|resume_id| (project_dir_string.clone(), resume_id)),
            detached_owner,
        };
        sessions.insert(options.gui_id.clone(), handle.clone());
        drop(sessions);

        let routed_sink = routed_sink(attached_sink.clone());
        let mut readers = vec![spawn_stdout_reader(
            routed_sink.clone(),
            options.gui_id.clone(),
            stdout,
        )];
        if let Some(stderr) = stderr {
            readers.push(spawn_stderr_reader(
                routed_sink.clone(),
                options.gui_id.clone(),
                stderr,
            ));
        } else if let Some(path) = durable_stderr {
            let log_sink = routed_sink.clone();
            let log_gui_id = options.gui_id.clone();
            readers.push(tokio::spawn(async move {
                deliver_log(
                    &log_sink,
                    &log_gui_id,
                    "host",
                    format!("Detached runtime diagnostics: {}", path.display()),
                )
                .await;
            }));
        }
        self.spawn_exit_monitor(
            routed_sink,
            attached_sink,
            options.gui_id.clone(),
            handle.child.clone(),
            readers,
        );

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
        // Hold the session map lock through sink replacement. Final exit uses
        // the same lock to capture the last subscriber and remove the handle,
        // so attach either wins and receives exit or fails before `ready`.
        let sessions = self.sessions.lock().await;
        let handle = sessions
            .get(gui_id)
            .ok_or_else(|| format!("live session '{gui_id}' was not found"))?;
        let attachment_id = self.next_attachment.fetch_add(1, Ordering::Relaxed);
        replace_sink(&handle.sink, Some((attachment_id, sink))).await?;
        Ok(attachment_id)
    }

    /// Attach a newly opened Studio client to the live runtime that already
    /// owns a durable session. Network runtimes intentionally outlive a phone
    /// WebView, so a fresh app process may only know the durable session id.
    pub async fn attach_resume(
        &self,
        project_dir: &str,
        resume_id: &str,
        sink: EventSink,
    ) -> Result<(String, AttachmentId), String> {
        let canonical_project = canonical_project_dir(project_dir)?
            .to_string_lossy()
            .into_owned();
        let sessions = self.sessions.lock().await;
        let (gui_id, handle) = sessions
            .iter()
            .find(|(_, handle)| {
                handle
                    .resume_identity
                    .as_ref()
                    .is_some_and(|(project, session)| {
                        project == &canonical_project && session == resume_id
                    })
            })
            .ok_or_else(|| DUPLICATE_RESUME_ERROR.to_owned())?;
        let attachment_id = self.next_attachment.fetch_add(1, Ordering::Relaxed);
        replace_sink(&handle.sink, Some((attachment_id, sink))).await?;
        Ok((gui_id.clone(), attachment_id))
    }

    /// Remove a subscriber only if it still owns the current attachment lease.
    /// The child process, stdin, and durable session remain alive.
    pub async fn detach(&self, gui_id: &str, attachment_id: AttachmentId) -> Result<bool, String> {
        let sessions = self.sessions.lock().await;
        let handle = match sessions.get(gui_id) {
            Some(handle) => handle,
            None => return Ok(false),
        };
        let mut slot = handle.sink.current.write().await;
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
        let sessions = self.sessions.lock().await;
        let handle = match sessions.get(gui_id) {
            Some(handle) => handle,
            None => return Ok(false),
        };
        let slot = handle.sink.current.read().await;
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

        // A network owner deliberately survives EOF, so an explicit stop must
        // send quit. Local desktop owners retain the older interrupt + EOF
        // drain used by app updates and ordinary window shutdown.
        if let Some(mut stdin) = handle.stdin.lock().await.take() {
            let operation = if handle.detached_owner {
                b"{\"op\":\"quit\"}\n".as_slice()
            } else {
                b"{\"op\":\"interrupt\"}\n".as_slice()
            };
            let _ = stdin.write_all(operation).await;
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

    /// Release every network-owned runtime without stopping it.
    ///
    /// The runtime's detached owner keeps the durable session and attach
    /// socket alive after this host adapter exits. A replacement host does not
    /// yet reconstruct this manager's process handles, so deployments keep the
    /// host stable and use stored resume after a host-process restart.
    pub async fn release_all(&self) -> Result<(), String> {
        self.accepting.store(false, Ordering::SeqCst);
        let handles = {
            let mut sessions = self.sessions.lock().await;
            sessions
                .drain()
                .map(|(_, handle)| handle)
                .collect::<Vec<_>>()
        };
        for handle in handles {
            handle.stdin.lock().await.take();
            release_sink(&handle.sink).await;
        }
        Ok(())
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

    fn spawn_exit_monitor(
        &self,
        sink: EventSink,
        attached_sink: AttachedSink,
        gui_id: String,
        child: Arc<Mutex<Child>>,
        readers: Vec<tokio::task::JoinHandle<()>>,
    ) {
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
                        deliver_log(
                            &sink,
                            &gui_id,
                            "bridge",
                            format!("process monitor failed: {error}"),
                        )
                        .await;
                        break None;
                    }
                }
            };

            let code = status.as_ref().and_then(std::process::ExitStatus::code);
            deliver_exit_and_remove_session(&sessions, &attached_sink, &gui_id, readers, code)
                .await;
        });
    }
}

async fn deliver_exit_and_remove_session(
    sessions: &Arc<Mutex<HashMap<String, SessionHandle>>>,
    attached_sink: &AttachedSink,
    gui_id: &str,
    readers: Vec<tokio::task::JoinHandle<()>>,
    code: Option<i32>,
) {
    // Keep the handle and attachment lease available while the final reader
    // tail drains. If the WebSocket is replaced in this interval, routed_sink
    // can move the remaining records to the new subscriber.
    for reader in readers {
        let _ = reader.await;
    }

    let exit = SessionEvent {
        gui_id: gui_id.to_owned(),
        channel: "exit",
        payload: serde_json::to_value(ProcessExit {
            code,
            message: exit_message(code),
        })
        .unwrap_or_else(|error| {
            serde_json::json!({
                "code": code,
                "message": format!("Could not serialize runtime exit: {error}"),
            })
        }),
    };

    let mut changes = attached_sink.changes.subscribe();
    let mut reconnect_deadline: Option<Instant> = None;
    loop {
        // Snapshot the current attachment without holding either lock across
        // a potentially backpressured WebSocket write.
        let candidate = {
            let sessions = sessions.lock().await;
            let Some(handle) = sessions.get(gui_id) else {
                return;
            };
            if !Arc::ptr_eq(&handle.sink, attached_sink) {
                return;
            }
            let candidate = attached_sink.current.read().await.clone();
            candidate
        };

        let Some((attachment_id, sink)) = candidate else {
            if let Some(deadline) = reconnect_deadline {
                if timeout(
                    deadline.saturating_duration_since(Instant::now()),
                    changes.changed(),
                )
                .await
                .is_ok()
                {
                    continue;
                }
            }
            // No client remains. Serialize absence with attach: either this
            // removes the ended session first, or a new attachment wins and
            // the loop delivers exit to that exact lease.
            let mut sessions = sessions.lock().await;
            let remove = if let Some(handle) = sessions.get(gui_id) {
                Arc::ptr_eq(&handle.sink, attached_sink)
                    && attached_sink.current.read().await.is_none()
            } else {
                return;
            };
            if remove {
                sessions.remove(gui_id);
                return;
            }
            continue;
        };

        if !sink(&exit).await {
            if attached_sink.released.load(Ordering::SeqCst) {
                return;
            }
            let deadline = Instant::now() + EVENT_REATTACH_GRACE;
            reconnect_deadline = Some(deadline);
            if timeout(
                deadline.saturating_duration_since(Instant::now()),
                changes.changed(),
            )
            .await
            .is_err()
            {
                // No replacement arrived. The runtime has already durably
                // recorded its tail, so release this ended handle rather than
                // spin forever on a dead writer.
                let mut sessions = sessions.lock().await;
                let current_attachment = if let Some(handle) = sessions.get(gui_id) {
                    if !Arc::ptr_eq(&handle.sink, attached_sink) {
                        return;
                    }
                    attached_sink.current.read().await.clone()
                } else {
                    return;
                };
                if current_attachment
                    .as_ref()
                    .map_or(true, |(current_id, _)| *current_id == attachment_id)
                {
                    sessions.remove(gui_id);
                    return;
                }
                // A replacement attachment won while the finalizer waited for
                // the manager lock. Deliver exit to that exact lease before
                // removing the ended session.
                continue;
            }
            continue;
        }

        // Queue acceptance is insufficient: EventSink resolves true only
        // after the WebSocket writer confirms the frame was sent. Remove the
        // session iff the same attachment still owns the lease. If a newer
        // attachment won during delivery, it must receive its own exit before
        // Studio can acknowledge it as terminal.
        let mut sessions = sessions.lock().await;
        let remove = if let Some(handle) = sessions.get(gui_id) {
            Arc::ptr_eq(&handle.sink, attached_sink)
                && attached_sink
                    .current
                    .read()
                    .await
                    .as_ref()
                    .is_some_and(|(current_id, _)| *current_id == attachment_id)
        } else {
            return;
        };
        if remove {
            sessions.remove(gui_id);
            return;
        }
    }
}

#[cfg(test)]
async fn deliver_exit_after_readers(
    sink: &EventSink,
    gui_id: &str,
    readers: Vec<tokio::task::JoinHandle<()>>,
    code: Option<i32>,
) {
    // The process has exited, but BufReader may still hold the final
    // stdout/stderr lines. Wait for both ordered readers to drain before
    // publishing the terminal exit frame; the WebSocket writer closes after
    // exit and must never overtake replay history.
    for reader in readers {
        let _ = reader.await;
    }
    let payload = ProcessExit {
        code,
        message: exit_message(code),
    };
    deliver_serialized(sink, gui_id, "exit", payload).await;
}

fn detached_runtime_log_path(gui_id: &str) -> Result<PathBuf, String> {
    let root = std::env::var_os("AMPLIFIER_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".amplifier")))
        .unwrap_or_else(|| PathBuf::from(".amplifier"));
    let directory = root.join("host-logs");
    fs::create_dir_all(&directory).map_err(|error| {
        format!(
            "Could not create detached runtime log directory {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory.join(format!("{gui_id}.stderr.log")))
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
        let slot = slot.clone();
        Box::pin(async move {
            let mut changes = slot.changes.subscribe();
            let mut reconnect_deadline: Option<Instant> = None;
            loop {
                // Snapshot and release the lease before awaiting network I/O;
                // attach must never hold the global manager lock behind a
                // stalled WebSocket. If the attachment changes after a
                // confirmed send, repeat the event for the new lease so the
                // cutover may duplicate one record but can never lose it.
                if slot.released.load(Ordering::SeqCst) {
                    return true;
                }
                let candidate = slot.current.read().await.clone();
                let Some((attachment_id, sink)) = candidate else {
                    let Some(deadline) = reconnect_deadline else {
                        return true;
                    };
                    if timeout(
                        deadline.saturating_duration_since(Instant::now()),
                        changes.changed(),
                    )
                    .await
                    .is_err()
                    {
                        return true;
                    }
                    continue;
                };
                if !sink(event).await {
                    // This event was selected for a concrete client but the
                    // writer did not flush it. Keep the reader parked across
                    // detach until a replacement arrives; treating an empty
                    // slot as success here would recreate the lost-tail bug.
                    reconnect_deadline = Some(Instant::now() + EVENT_REATTACH_GRACE);
                    let deadline = reconnect_deadline.expect("set above");
                    if timeout(
                        deadline.saturating_duration_since(Instant::now()),
                        changes.changed(),
                    )
                    .await
                    .is_err()
                    {
                        return true;
                    }
                    continue;
                }
                let current = slot.current.read().await.clone();
                match current {
                    Some((current_id, _)) if current_id == attachment_id => return true,
                    Some(_) => {
                        reconnect_deadline = None;
                    }
                    // The exact client accepted the frame before detaching;
                    // no duplicate is required until another lease exists.
                    None => return true,
                }
            }
        })
    })
}

async fn replace_sink(
    slot: &AttachedSink,
    next: Option<(AttachmentId, EventSink)>,
) -> Result<(), String> {
    *slot.current.write().await = next;
    slot.changes.send_modify(|generation| *generation += 1);
    Ok(())
}

async fn release_sink(slot: &AttachedSink) {
    slot.released.store(true, Ordering::SeqCst);
    *slot.current.write().await = None;
    slot.changes.send_modify(|generation| *generation += 1);
}

fn spawn_stdout_reader(
    sink: EventSink,
    gui_id: String,
    stdout: tokio::process::ChildStdout,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(record) if record.is_object() => {
                        deliver_value(&sink, &gui_id, "record", record).await;
                    }
                    _ => deliver_log(&sink, &gui_id, "stdout", line).await,
                },
                Ok(None) => break,
                Err(error) => {
                    deliver_log(
                        &sink,
                        &gui_id,
                        "bridge",
                        format!("stdout read failed: {error}"),
                    )
                    .await;
                    break;
                }
            }
        }
    })
}

fn spawn_stderr_reader(
    sink: EventSink,
    gui_id: String,
    stderr: tokio::process::ChildStderr,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => deliver_log(&sink, &gui_id, "stderr", line).await,
                Ok(None) => break,
                Err(error) => {
                    deliver_log(
                        &sink,
                        &gui_id,
                        "bridge",
                        format!("stderr read failed: {error}"),
                    )
                    .await;
                    break;
                }
            }
        }
    })
}

async fn deliver_log(sink: &EventSink, gui_id: &str, stream: &'static str, message: String) {
    deliver_serialized(sink, gui_id, "log", ProcessLog { stream, message }).await;
}

async fn deliver_serialized<T: serde::Serialize>(
    sink: &EventSink,
    gui_id: &str,
    channel: &'static str,
    payload: T,
) {
    match serde_json::to_value(payload) {
        Ok(payload) => deliver_value(sink, gui_id, channel, payload).await,
        Err(error) => {
            deliver_value(
                sink,
                gui_id,
                "log",
                serde_json::json!({
                    "stream": "bridge",
                    "message": format!("could not serialize bridge event: {error}"),
                }),
            )
            .await
        }
    }
}

async fn deliver_value(sink: &EventSink, gui_id: &str, channel: &'static str, payload: Value) {
    let event = SessionEvent {
        gui_id: gui_id.to_owned(),
        channel,
        payload,
    };
    while !sink(&event).await {
        sleep(SINK_BACKPRESSURE_RETRY).await;
    }
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

    fn sync_sink(deliver: impl Fn(&SessionEvent) -> bool + Send + Sync + 'static) -> EventSink {
        let deliver = Arc::new(deliver);
        Arc::new(move |event| {
            let deliver = deliver.clone();
            Box::pin(async move { deliver(event) })
        })
    }

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
        let sink = sync_sink(|_| true);
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

    #[tokio::test]
    async fn bounded_sink_backpressure_retries_the_same_event_until_accepted() {
        use std::sync::atomic::AtomicUsize;

        let attempts = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(StdMutex::new(Vec::new()));
        let attempts_for_sink = attempts.clone();
        let accepted_for_sink = accepted.clone();
        let sink = sync_sink(move |event| {
            let attempt = attempts_for_sink.fetch_add(1, Ordering::SeqCst) + 1;
            if attempt < 4 {
                return false;
            }
            accepted_for_sink.lock().unwrap().push(event.clone());
            true
        });

        deliver_value(
            &sink,
            "restored-session",
            "record",
            serde_json::json!({ "type": "history.end", "count": 298 }),
        )
        .await;

        assert_eq!(attempts.load(Ordering::SeqCst), 4);
        let accepted = accepted.lock().unwrap();
        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].payload["type"], "history.end");
    }

    #[tokio::test]
    async fn exit_waits_for_the_final_reader_event() {
        let delivered = Arc::new(StdMutex::new(Vec::new()));
        let delivered_for_sink = delivered.clone();
        let sink = sync_sink(move |event| {
            delivered_for_sink.lock().unwrap().push(event.clone());
            true
        });
        let reader_sink = sink.clone();
        let reader = tokio::spawn(async move {
            tokio::task::yield_now().await;
            deliver_value(
                &reader_sink,
                "ordered-session",
                "record",
                serde_json::json!({ "type": "history.end", "count": 300 }),
            )
            .await;
        });

        deliver_exit_after_readers(&sink, "ordered-session", vec![reader], Some(0)).await;

        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 2);
        assert_eq!(delivered[0].channel, "record");
        assert_eq!(delivered[0].payload["type"], "history.end");
        assert_eq!(delivered[1].channel, "exit");
    }

    #[tokio::test]
    async fn session_remains_attachable_until_the_reader_tail_and_exit_are_delivered() {
        let manager = SessionManager::default();
        let delivered = Arc::new(StdMutex::new(Vec::new()));
        let delivered_for_sink = delivered.clone();
        let sink = sync_sink(move |event| {
            delivered_for_sink.lock().unwrap().push(event.clone());
            true
        });
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = Command::new("true").spawn().unwrap();
        let sink_slot = attached_sink(Some((1, sink.clone())));
        manager.sessions.lock().await.insert(
            "ordered-session".to_owned(),
            SessionHandle {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(None)),
                sink: sink_slot.clone(),
                resume_identity: None,
                detached_owner: false,
            },
        );

        let sessions_for_reader = manager.sessions.clone();
        let reader_sink = sink.clone();
        let attachable_during_drain = Arc::new(AtomicBool::new(false));
        let attachable_for_reader = attachable_during_drain.clone();
        let reader = tokio::spawn(async move {
            attachable_for_reader.store(
                sessions_for_reader
                    .lock()
                    .await
                    .contains_key("ordered-session"),
                Ordering::SeqCst,
            );
            deliver_value(
                &reader_sink,
                "ordered-session",
                "record",
                serde_json::json!({ "type": "history.end", "count": 300 }),
            )
            .await;
        });

        deliver_exit_and_remove_session(
            &manager.sessions,
            &sink_slot,
            "ordered-session",
            vec![reader],
            Some(0),
        )
        .await;

        assert!(attachable_during_drain.load(Ordering::SeqCst));
        assert!(!manager
            .sessions
            .lock()
            .await
            .contains_key("ordered-session"));
        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 2);
        assert_eq!(delivered[0].payload["type"], "history.end");
        assert_eq!(delivered[1].channel, "exit");
    }

    #[tokio::test]
    async fn attach_during_reader_drain_receives_the_tail_and_exit() {
        let manager = SessionManager::default();
        let original_events = Arc::new(StdMutex::new(Vec::new()));
        let original_capture = original_events.clone();
        let original_sink = sync_sink(move |event| {
            original_capture.lock().unwrap().push(event.clone());
            true
        });
        let sink_slot = attached_sink(Some((1, original_sink)));
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = Command::new("true").spawn().unwrap();
        manager.sessions.lock().await.insert(
            "reattach-during-drain".to_owned(),
            SessionHandle {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(None)),
                sink: sink_slot.clone(),
                resume_identity: None,
                detached_owner: false,
            },
        );

        let (reader_started_tx, reader_started_rx) = tokio::sync::oneshot::channel();
        let (release_reader_tx, release_reader_rx) = tokio::sync::oneshot::channel();
        let reader_sink = routed_sink(sink_slot.clone());
        let reader = tokio::spawn(async move {
            let _ = reader_started_tx.send(());
            let _ = release_reader_rx.await;
            deliver_value(
                &reader_sink,
                "reattach-during-drain",
                "record",
                serde_json::json!({ "type": "history.end", "count": 300 }),
            )
            .await;
        });
        let sessions = manager.sessions.clone();
        let finalizer = tokio::spawn(async move {
            deliver_exit_and_remove_session(
                &sessions,
                &sink_slot,
                "reattach-during-drain",
                vec![reader],
                Some(0),
            )
            .await;
        });
        reader_started_rx.await.unwrap();

        let replacement_events = Arc::new(StdMutex::new(Vec::new()));
        let replacement_capture = replacement_events.clone();
        let replacement_sink = sync_sink(move |event| {
            replacement_capture.lock().unwrap().push(event.clone());
            true
        });
        manager
            .attach("reattach-during-drain", replacement_sink)
            .await
            .unwrap();
        release_reader_tx.send(()).unwrap();
        finalizer.await.unwrap();

        assert!(original_events.lock().unwrap().is_empty());
        let replacement_events = replacement_events.lock().unwrap();
        assert_eq!(replacement_events.len(), 2);
        assert_eq!(replacement_events[0].payload["type"], "history.end");
        assert_eq!(replacement_events[1].channel, "exit");
        assert!(!manager
            .sessions
            .lock()
            .await
            .contains_key("reattach-during-drain"));
    }

    #[tokio::test]
    async fn resume_attach_during_reader_drain_receives_the_tail_and_exit() {
        let project = tempfile::tempdir().unwrap();
        let project_path = project
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let manager = SessionManager::default();
        let original_sink = sync_sink(|_| true);
        let sink_slot = attached_sink(Some((1, original_sink)));
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = Command::new("true").spawn().unwrap();
        manager.sessions.lock().await.insert(
            "resume-during-drain".to_owned(),
            SessionHandle {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(None)),
                sink: sink_slot.clone(),
                resume_identity: Some((project_path.clone(), "durable-restore".to_owned())),
                detached_owner: true,
            },
        );

        let (reader_started_tx, reader_started_rx) = tokio::sync::oneshot::channel();
        let (release_reader_tx, release_reader_rx) = tokio::sync::oneshot::channel();
        let reader_sink = routed_sink(sink_slot.clone());
        let reader = tokio::spawn(async move {
            let _ = reader_started_tx.send(());
            let _ = release_reader_rx.await;
            deliver_value(
                &reader_sink,
                "resume-during-drain",
                "record",
                serde_json::json!({ "type": "history.end", "count": 300 }),
            )
            .await;
        });
        let sessions = manager.sessions.clone();
        let finalizer = tokio::spawn(async move {
            deliver_exit_and_remove_session(
                &sessions,
                &sink_slot,
                "resume-during-drain",
                vec![reader],
                Some(0),
            )
            .await;
        });
        reader_started_rx.await.unwrap();

        let replacement_events = Arc::new(StdMutex::new(Vec::new()));
        let replacement_capture = replacement_events.clone();
        let replacement_sink = sync_sink(move |event| {
            replacement_capture.lock().unwrap().push(event.clone());
            true
        });
        let (gui_id, _) = manager
            .attach_resume(&project_path, "durable-restore", replacement_sink)
            .await
            .unwrap();
        assert_eq!(gui_id, "resume-during-drain");
        release_reader_tx.send(()).unwrap();
        finalizer.await.unwrap();

        let replacement_events = replacement_events.lock().unwrap();
        assert_eq!(replacement_events.len(), 2);
        assert_eq!(replacement_events[0].payload["type"], "history.end");
        assert_eq!(replacement_events[1].channel, "exit");
        assert!(manager
            .attach_resume(&project_path, "durable-restore", sync_sink(|_| true))
            .await
            .is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn in_flight_tail_replays_to_attachment_that_wins_during_ack() {
        use std::sync::Barrier;

        let manager = SessionManager::default();
        let original_events = Arc::new(StdMutex::new(Vec::new()));
        let original_capture = original_events.clone();
        let acceptance_gate = Arc::new(Barrier::new(2));
        let acceptance_gate_for_sink = acceptance_gate.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let original_sink = sync_sink(move |event| {
            entered_tx.send(()).unwrap();
            acceptance_gate_for_sink.wait();
            original_capture.lock().unwrap().push(event.clone());
            true
        });
        let sink_slot = attached_sink(Some((0, original_sink)));
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = Command::new("true").spawn().unwrap();
        manager.sessions.lock().await.insert(
            "in-flight-cutover".to_owned(),
            SessionHandle {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(None)),
                sink: sink_slot.clone(),
                resume_identity: None,
                detached_owner: false,
            },
        );

        let route = routed_sink(sink_slot.clone());
        let route_task = tokio::spawn(async move {
            route(&SessionEvent {
                gui_id: "in-flight-cutover".to_owned(),
                channel: "record",
                payload: serde_json::json!({ "type": "history.end", "count": 300 }),
            })
            .await
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let replacement_events = Arc::new(StdMutex::new(Vec::new()));
        let replacement_capture = replacement_events.clone();
        let replacement_sink = sync_sink(move |event| {
            replacement_capture.lock().unwrap().push(event.clone());
            true
        });
        let manager_for_attach = manager.clone();
        let attach_task = tokio::spawn(async move {
            manager_for_attach
                .attach("in-flight-cutover", replacement_sink)
                .await
        });
        timeout(Duration::from_secs(1), attach_task)
            .await
            .expect("reattach is not blocked by the old socket")
            .unwrap()
            .unwrap();

        acceptance_gate.wait();
        assert!(route_task.await.unwrap());

        assert_eq!(original_events.lock().unwrap().len(), 1);
        assert_eq!(replacement_events.lock().unwrap().len(), 1);
        let next_route = routed_sink(sink_slot);
        assert!(
            next_route(&SessionEvent {
                gui_id: "in-flight-cutover".to_owned(),
                channel: "record",
                payload: serde_json::json!({ "type": "session.status" }),
            })
            .await
        );
        assert_eq!(replacement_events.lock().unwrap().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_tail_delivery_waits_through_detach_for_replacement() {
        let (failed_tx, failed_rx) = std::sync::mpsc::channel();
        let failed_tx = Arc::new(StdMutex::new(Some(failed_tx)));
        let failed_tx_for_sink = failed_tx.clone();
        let failing_sink = sync_sink(move |_| {
            if let Some(sender) = failed_tx_for_sink.lock().unwrap().take() {
                sender.send(()).unwrap();
            }
            false
        });
        let slot = attached_sink(Some((1, failing_sink)));
        let route = routed_sink(slot.clone());
        let delivery = tokio::spawn(async move {
            route(&SessionEvent {
                gui_id: "retry-tail".to_owned(),
                channel: "record",
                payload: serde_json::json!({ "type": "history.end", "count": 300 }),
            })
            .await
        });
        failed_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        replace_sink(&slot, None).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!delivery.is_finished());

        let replacement_events = Arc::new(StdMutex::new(Vec::new()));
        let replacement_capture = replacement_events.clone();
        replace_sink(
            &slot,
            Some((
                2,
                sync_sink(move |event| {
                    replacement_capture.lock().unwrap().push(event.clone());
                    true
                }),
            )),
        )
        .await
        .unwrap();

        assert!(timeout(Duration::from_secs(1), delivery)
            .await
            .expect("replacement receives failed tail")
            .unwrap());
        assert_eq!(replacement_events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn failed_tail_delivery_expires_to_durable_replay_without_busy_waiting() {
        let attempts = Arc::new(AtomicU64::new(0));
        let attempts_for_sink = attempts.clone();
        let slot = attached_sink(Some((
            1,
            sync_sink(move |_| {
                attempts_for_sink.fetch_add(1, Ordering::SeqCst);
                false
            }),
        )));
        let route = routed_sink(slot.clone());
        let delivery = tokio::spawn(async move {
            route(&SessionEvent {
                gui_id: "durable-fallback".to_owned(),
                channel: "record",
                payload: serde_json::json!({ "type": "history.end", "count": 300 }),
            })
            .await
        });
        while attempts.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        replace_sink(&slot, None).await.unwrap();

        assert!(timeout(Duration::from_secs(1), delivery)
            .await
            .expect("bounded reconnect grace expires")
            .unwrap());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn release_wakes_a_failed_delivery_without_waiting_for_grace() {
        let (failed_tx, failed_rx) = tokio::sync::oneshot::channel();
        let failed_tx = Arc::new(StdMutex::new(Some(failed_tx)));
        let failed_tx_for_sink = failed_tx.clone();
        let slot = attached_sink(Some((
            1,
            sync_sink(move |_| {
                if let Some(sender) = failed_tx_for_sink.lock().unwrap().take() {
                    let _ = sender.send(());
                }
                false
            }),
        )));
        let route = routed_sink(slot.clone());
        let delivery = tokio::spawn(async move {
            route(&SessionEvent {
                gui_id: "release-tail".to_owned(),
                channel: "record",
                payload: serde_json::json!({ "type": "history.end", "count": 300 }),
            })
            .await
        });
        failed_rx.await.unwrap();

        release_sink(&slot).await;
        assert!(timeout(Duration::from_millis(50), delivery)
            .await
            .expect("release wakes delivery waiter")
            .unwrap());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reattach_during_final_exit_flush_receives_its_own_exit() {
        use std::sync::Barrier;

        let project = tempfile::tempdir().unwrap();
        let project_path = project
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let manager = SessionManager::default();
        let exit_gate = Arc::new(Barrier::new(2));
        let exit_gate_for_sink = exit_gate.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let sink = sync_sink(move |event| {
            assert_eq!(event.channel, "exit");
            entered_tx.send(()).unwrap();
            exit_gate_for_sink.wait();
            true
        });
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = Command::new("true").spawn().unwrap();
        let sink_slot = attached_sink(Some((0, sink)));
        manager.sessions.lock().await.insert(
            "finalizer-wins".to_owned(),
            SessionHandle {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(None)),
                sink: sink_slot.clone(),
                resume_identity: Some((project_path.clone(), "durable-final".to_owned())),
                detached_owner: true,
            },
        );

        let sessions = manager.sessions.clone();
        let finalizer = tokio::spawn(async move {
            deliver_exit_and_remove_session(
                &sessions,
                &sink_slot,
                "finalizer-wins",
                Vec::new(),
                Some(0),
            )
            .await;
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let replacement_events = Arc::new(StdMutex::new(Vec::new()));
        let replacement_capture = replacement_events.clone();
        manager
            .attach(
                "finalizer-wins",
                sync_sink(move |event| {
                    replacement_capture.lock().unwrap().push(event.clone());
                    true
                }),
            )
            .await
            .unwrap();

        exit_gate.wait();
        finalizer.await.unwrap();

        let replacement_events = replacement_events.lock().unwrap();
        assert_eq!(replacement_events.len(), 1);
        assert_eq!(replacement_events[0].channel, "exit");
        assert!(manager
            .attach_resume(&project_path, "durable-final", sync_sink(|_| true))
            .await
            .is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attachment_that_wins_at_exit_grace_expiry_receives_exit() {
        let manager = SessionManager::default();
        let (failed_tx, failed_rx) = tokio::sync::oneshot::channel();
        let failed_tx = Arc::new(StdMutex::new(Some(failed_tx)));
        let failed_tx_for_sink = failed_tx.clone();
        let old_sink = sync_sink(move |_| {
            if let Some(sender) = failed_tx_for_sink.lock().unwrap().take() {
                let _ = sender.send(());
            }
            false
        });
        let sink_slot = attached_sink(Some((1, old_sink)));
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = Command::new("true").spawn().unwrap();
        manager.sessions.lock().await.insert(
            "grace-boundary-attach".to_owned(),
            SessionHandle {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(None)),
                sink: sink_slot.clone(),
                resume_identity: None,
                detached_owner: false,
            },
        );

        let sessions = manager.sessions.clone();
        let finalizer_slot = sink_slot.clone();
        let finalizer = tokio::spawn(async move {
            deliver_exit_and_remove_session(
                &sessions,
                &finalizer_slot,
                "grace-boundary-attach",
                Vec::new(),
                Some(0),
            )
            .await;
        });
        failed_rx.await.unwrap();

        // Model attach's critical section precisely: it holds the manager lock
        // while replacing the lease, then publishes the generation before it
        // releases that lock. Let the finalizer's grace expire in between.
        let sessions_guard = manager.sessions.lock().await;
        let replacement_events = Arc::new(StdMutex::new(Vec::new()));
        let replacement_capture = replacement_events.clone();
        *sink_slot.current.write().await = Some((
            2,
            sync_sink(move |event| {
                replacement_capture.lock().unwrap().push(event.clone());
                true
            }),
        ));
        tokio::time::sleep(EVENT_REATTACH_GRACE + Duration::from_millis(20)).await;
        sink_slot.changes.send_modify(|generation| *generation += 1);
        drop(sessions_guard);

        timeout(Duration::from_secs(1), finalizer)
            .await
            .expect("replacement receives exit after the grace-boundary race")
            .unwrap();
        let replacement_events = replacement_events.lock().unwrap();
        assert_eq!(replacement_events.len(), 1);
        assert_eq!(replacement_events[0].channel, "exit");
        assert!(!manager
            .sessions
            .lock()
            .await
            .contains_key("grace-boundary-attach"));
    }

    #[tokio::test]
    async fn old_finalizer_cannot_target_a_reused_gui_id() {
        let manager = SessionManager::default();
        let old_slot = attached_sink(Some((1, sync_sink(|_| true))));
        let new_events = Arc::new(StdMutex::new(Vec::new()));
        let new_capture = new_events.clone();
        let new_slot = attached_sink(Some((
            2,
            sync_sink(move |event| {
                new_capture.lock().unwrap().push(event.clone());
                true
            }),
        )));
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let child = Command::new("true").spawn().unwrap();
        manager.sessions.lock().await.insert(
            "reused-gui-id".to_owned(),
            SessionHandle {
                child: Arc::new(Mutex::new(child)),
                stdin: Arc::new(Mutex::new(None)),
                sink: new_slot.clone(),
                resume_identity: None,
                detached_owner: false,
            },
        );

        deliver_exit_and_remove_session(
            &manager.sessions,
            &old_slot,
            "reused-gui-id",
            Vec::new(),
            Some(0),
        )
        .await;

        let sessions = manager.sessions.lock().await;
        assert!(sessions
            .get("reused-gui-id")
            .is_some_and(|handle| Arc::ptr_eq(&handle.sink, &new_slot)));
        assert!(new_events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn routed_sink_can_be_replaced_and_stale_detach_is_detectable() {
        let first_events = Arc::new(StdMutex::new(Vec::new()));
        let second_events = Arc::new(StdMutex::new(Vec::new()));
        let first_capture = first_events.clone();
        let second_capture = second_events.clone();
        let first = sync_sink(move |event| {
            first_capture.lock().unwrap().push(event.gui_id.clone());
            true
        });
        let second = sync_sink(move |event| {
            second_capture.lock().unwrap().push(event.gui_id.clone());
            true
        });
        let slot = attached_sink(Some((1, first)));
        let route = routed_sink(slot.clone());

        route(&SessionEvent {
            gui_id: "one".into(),
            channel: "record",
            payload: Value::Null,
        })
        .await;
        replace_sink(&slot, Some((2, second))).await.unwrap();
        route(&SessionEvent {
            gui_id: "two".into(),
            channel: "record",
            payload: Value::Null,
        })
        .await;

        assert_eq!(*first_events.lock().unwrap(), vec!["one"]);
        assert_eq!(*second_events.lock().unwrap(), vec!["two"]);
        assert_eq!(
            slot.current.read().await.as_ref().map(|(id, _)| *id),
            Some(2)
        );
    }

    #[tokio::test]
    async fn fresh_mobile_client_can_attach_by_durable_resume_identity() {
        let project = tempfile::tempdir().unwrap();
        let project_path = project
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let manager = SessionManager::default();
        let child = Arc::new(Mutex::new(Command::new("sleep").arg("60").spawn().unwrap()));
        let original_sink = sync_sink(|_| true);
        let sink_slot = attached_sink(Some((1, original_sink)));
        manager.sessions.lock().await.insert(
            "live-mobile-session".to_owned(),
            SessionHandle {
                child: child.clone(),
                stdin: Arc::new(Mutex::new(None)),
                sink: sink_slot,
                resume_identity: Some((project_path.clone(), "durable-123".to_owned())),
                detached_owner: true,
            },
        );

        let replacement_sink = sync_sink(|_| true);
        let (gui_id, attachment_id) = manager
            .attach_resume(&project_path, "durable-123", replacement_sink)
            .await
            .unwrap();

        assert_eq!(gui_id, "live-mobile-session");
        assert!(manager
            .attachment_is_current(&gui_id, attachment_id)
            .await
            .unwrap());
        child.lock().await.kill().await.unwrap();
    }
}
