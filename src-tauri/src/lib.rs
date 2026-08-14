mod catalog;
#[cfg(desktop)]
mod image_drop;
mod protocol;
#[cfg(desktop)]
mod runtime_settings;
mod runtime_setup;
mod session;
mod store;
mod transcription;
pub mod web_server;

#[cfg(desktop)]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use catalog::CapabilityCatalog;
use protocol::{SessionEvent, StartSessionOptions, StartSessionResult};
use serde_json::Value;
use session::{EventSink, SessionManager};
use std::sync::Arc;
use store::StoredSession;

#[cfg(desktop)]
#[derive(Default)]
struct DesktopLifecycle {
    // 0 = running, 1 = draining children, 2 = final exit requested.
    exit_phase: std::sync::atomic::AtomicU8,
    update_installing: std::sync::atomic::AtomicBool,
}
#[cfg(desktop)]
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};
#[cfg(desktop)]
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
mod app_updates {
    use crate::session::SessionManager;
    use serde::Serialize;
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    #[derive(Default)]
    pub struct PendingUpdate(pub Mutex<Option<Update>>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateMetadata {
        version: String,
        current_version: String,
        body: Option<String>,
        date: Option<String>,
    }

    #[derive(Clone, Serialize)]
    #[serde(tag = "event", content = "data")]
    enum DownloadEvent {
        #[serde(rename_all = "camelCase")]
        Started {
            content_length: Option<u64>,
        },
        #[serde(rename_all = "camelCase")]
        Progress {
            chunk_length: usize,
        },
        Finished,
    }

    #[tauri::command]
    pub async fn fetch_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
    ) -> Result<Option<UpdateMetadata>, String> {
        let update = app
            .updater()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string())?;
        let metadata = update.as_ref().map(|item| UpdateMetadata {
            version: item.version.clone(),
            current_version: item.current_version.clone(),
            body: item.body.clone(),
            date: item.date.map(|date| date.to_string()),
        });
        *pending_update
            .0
            .lock()
            .map_err(|_| "The update state is unavailable".to_owned())? = update;
        Ok(metadata)
    }

    #[tauri::command]
    pub async fn install_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
        sessions: State<'_, SessionManager>,
        lifecycle: State<'_, crate::DesktopLifecycle>,
    ) -> Result<(), String> {
        let update = pending_update
            .0
            .lock()
            .map_err(|_| "The update state is unavailable".to_owned())?
            .take()
            .ok_or_else(|| "There is no pending update".to_owned())?;
        lifecycle
            .update_installing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let progress_app = app.clone();
        let finished_app = app.clone();
        let mut started = false;
        let bytes = match update
            .download(
                move |chunk_length, content_length| {
                    if !started {
                        let _ = progress_app.emit(
                            "app://update/progress",
                            DownloadEvent::Started { content_length },
                        );
                        started = true;
                    }
                    let _ = progress_app.emit(
                        "app://update/progress",
                        DownloadEvent::Progress { chunk_length },
                    );
                },
                move || {
                    let _ = finished_app.emit("app://update/progress", DownloadEvent::Finished);
                },
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                lifecycle
                    .update_installing
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                return Err(error.to_string());
            }
        };

        // Download and signature verification happen first, while the current
        // session remains usable. Only once the update is ready do we drain
        // every owned runtime. This is mandatory before restart: kill_on_drop
        // is not reliable across Tauri's process-replacement path.
        if let Err(error) = sessions.stop_all().await {
            sessions.resume_after_failed_update();
            lifecycle
                .update_installing
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(error);
        }
        if let Err(error) = update.install(bytes) {
            sessions.resume_after_failed_update();
            lifecycle
                .update_installing
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(error.to_string());
        }
        app.restart();
    }
}

#[tauri::command]
async fn start_session(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    options: StartSessionOptions,
) -> Result<StartSessionResult, String> {
    if cfg!(mobile) {
        return Err(
            "Native mobile sessions require an HTTPS Rust bridge URL. Open Bridge settings in Amplifier Studio."
                .to_owned(),
        );
    }
    let sink: EventSink = Arc::new(move |event: SessionEvent| {
        let name = format!("session://{}/{}", event.gui_id, event.channel);
        let _ = app.emit(&name, event.payload);
    });
    manager.start(options, sink).await
}

#[tauri::command]
async fn send_op(
    manager: State<'_, SessionManager>,
    gui_id: String,
    op: Value,
) -> Result<(), String> {
    manager.send(&gui_id, op).await
}

#[tauri::command]
async fn stop_session(manager: State<'_, SessionManager>, gui_id: String) -> Result<bool, String> {
    manager.stop(&gui_id).await
}

#[tauri::command]
async fn list_stored_sessions(project_dir: Option<String>) -> Result<Vec<StoredSession>, String> {
    tauri::async_runtime::spawn_blocking(move || store::list_stored_sessions(project_dir))
        .await
        .map_err(|error| format!("Session scan task failed: {error}"))?
}

#[tauri::command]
async fn list_catalog(project_dir: Option<String>) -> Result<CapabilityCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || catalog::list_catalog(project_dir))
        .await
        .map_err(|error| format!("Capability catalog task failed: {error}"))?
}

#[tauri::command]
async fn add_bundle(
    project_dir: Option<String>,
    uri: String,
    name: Option<String>,
) -> Result<CapabilityCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || catalog::add_bundle(project_dir, uri, name))
        .await
        .map_err(|error| format!("Bundle registration task failed: {error}"))?
}

#[tauri::command]
async fn runtime_status() -> Result<runtime_setup::RuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(runtime_setup::status)
        .await
        .map_err(|error| format!("Runtime check failed: {error}"))
}

#[tauri::command]
async fn install_runtime() -> Result<runtime_setup::RuntimeStatus, String> {
    runtime_setup::install().await
}

#[tauri::command]
async fn configure_provider(
    provider_type: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<runtime_setup::RuntimeStatus, String> {
    runtime_setup::configure_provider(provider_type, api_key, model, base_url).await
}

#[tauri::command]
async fn transcription_status() -> Result<transcription::TranscriptionStatus, String> {
    Ok(transcription::status())
}

#[tauri::command]
async fn transcribe_audio(request: transcription::TranscriptionRequest) -> Result<String, String> {
    transcription::transcribe(request).await
}

#[cfg(desktop)]
#[tauri::command]
async fn read_runtime_settings(
    project_dir: String,
) -> Result<runtime_settings::RuntimeSettingsSnapshot, String> {
    runtime_settings::read(project_dir).await
}

#[cfg(desktop)]
#[tauri::command]
async fn apply_runtime_settings(
    project_dir: String,
    changes: Vec<runtime_settings::RuntimeSettingChange>,
) -> Result<runtime_settings::RuntimeSettingsSnapshot, String> {
    runtime_settings::apply(project_dir, changes).await
}

#[cfg(desktop)]
#[tauri::command]
async fn load_attachment_paths(
    paths: Vec<String>,
) -> Result<Vec<image_drop::NativeAttachment>, String> {
    let paths = paths
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    tauri::async_runtime::spawn_blocking(move || image_drop::load_attachments(&paths))
        .await
        .map_err(|error| format!("Attachment loading task failed: {error}"))?
}

#[cfg(desktop)]
#[tauri::command]
async fn write_diagnostics(path: String, contents: String) -> Result<(), String> {
    const MAX_DIAGNOSTICS_BYTES: usize = 64 * 1024 * 1024;
    if contents.len() > MAX_DIAGNOSTICS_BYTES {
        return Err("Diagnostics exceed Studio's 64 MB export limit".to_owned());
    }
    let path = std::path::PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("Choose an absolute diagnostics destination".to_owned());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Choose a diagnostics destination with a parent directory".to_owned())?;
    if !parent.is_dir() {
        return Err("The diagnostics destination directory is unavailable".to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, contents).map_err(|error| {
            format!(
                "Could not write diagnostics to '{}': {error}",
                path.display()
            )
        })
    })
    .await
    .map_err(|error| format!("Diagnostics export task failed: {error}"))?
}

#[tauri::command]
fn default_project_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("Could not determine a default project directory: {error}"))
}

#[cfg(desktop)]
#[tauri::command]
fn open_output(app: AppHandle, project_dir: String, path: String) -> Result<(), String> {
    let output = resolve_output_path(&project_dir, &path)?;
    app.opener()
        .open_path(output.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Could not open output: {error}"))
}

pub(crate) fn resolve_output_path(
    project_dir: &str,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let project = std::path::PathBuf::from(project_dir)
        .canonicalize()
        .map_err(|error| format!("Could not open project directory: {error}"))?;
    let candidate = std::path::PathBuf::from(path);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        project.join(candidate)
    };
    let output = candidate
        .canonicalize()
        .map_err(|error| format!("Output does not exist: {error}"))?;
    if !output.starts_with(&project) {
        return Err("Studio only opens outputs inside this session's project directory".to_owned());
    }
    if !output.is_file() {
        return Err("The selected output is not a file".to_owned());
    }
    Ok(output)
}

#[cfg(desktop)]
#[tauri::command]
fn read_output_preview(project_dir: String, path: String) -> Result<Value, String> {
    const MAX_PREVIEW_BYTES: u64 = 24 * 1024 * 1024;
    let output = resolve_output_path(&project_dir, &path)?;
    let metadata =
        std::fs::metadata(&output).map_err(|error| format!("Could not inspect output: {error}"))?;
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err("Inline image previews can be up to 24 MB".to_owned());
    }
    let media_type = output_media_type(&output)
        .ok_or_else(|| "This output type cannot be previewed inline".to_owned())?;
    let data = std::fs::read(&output)
        .map_err(|error| format!("Could not read output preview: {error}"))?;
    Ok(serde_json::json!({
        "mediaType": media_type,
        "data": STANDARD.encode(data),
    }))
}

pub(crate) fn output_media_type(path: &std::path::Path) -> Option<&'static str> {
    match path
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|_app| {
            #[cfg(desktop)]
            {
                _app.handle().plugin(tauri_plugin_dialog::init())?;
                _app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                _app.handle().plugin(tauri_plugin_opener::init())?;
                _app.manage(app_updates::PendingUpdate::default());
                _app.manage(DesktopLifecycle::default());
            }
            Ok(())
        })
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            start_session,
            send_op,
            stop_session,
            list_stored_sessions,
            list_catalog,
            add_bundle,
            runtime_status,
            install_runtime,
            configure_provider,
            transcription_status,
            transcribe_audio,
            default_project_dir,
            #[cfg(desktop)]
            load_attachment_paths,
            #[cfg(desktop)]
            write_diagnostics,
            #[cfg(desktop)]
            read_runtime_settings,
            #[cfg(desktop)]
            apply_runtime_settings,
            #[cfg(desktop)]
            open_output,
            #[cfg(desktop)]
            read_output_preview,
            #[cfg(desktop)]
            app_updates::fetch_update,
            #[cfg(desktop)]
            app_updates::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Amplifier Studio");

    #[cfg(desktop)]
    {
        use std::sync::atomic::Ordering;

        app.run(move |app, event| {
            // AppKit can restore the process without restoring an onscreen
            // window. Make both a cold start and a dock reopen recover the
            // configured main webview instead of leaving Studio headless.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Ready = &event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                return;
            }

            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                // The updater has already drained sessions before asking Tauri
                // to restart, and Tauri does not allow restart to be delayed.
                if code == Some(tauri::RESTART_EXIT_CODE) {
                    return;
                }
                let lifecycle = app.state::<DesktopLifecycle>();
                if lifecycle.update_installing.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    return;
                }
                if lifecycle.exit_phase.load(Ordering::SeqCst) == 2 {
                    return;
                }
                api.prevent_exit();
                match lifecycle.exit_phase.compare_exchange(
                    0,
                    1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => {}
                    Err(1) => return,
                    Err(2) => return,
                    Err(_) => return,
                }
                let app = app.clone();
                let sessions = app.state::<SessionManager>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    // Do not trap the user in an unquittable app if a child is
                    // already unhealthy; stop_all includes a bounded timeout
                    // and kill fallback for every owned runtime.
                    let _ = sessions.stop_all().await;
                    app.state::<DesktopLifecycle>()
                        .exit_phase
                        .store(2, Ordering::SeqCst);
                    // On macOS, requesting a second graceful exit after the
                    // original application-terminate event was prevented can
                    // leave AppKit waiting forever. Every owned runtime has
                    // already been drained (or hit its bounded kill fallback),
                    // so perform Tauri's documented cleanup and finish the
                    // process directly instead of re-entering ExitRequested.
                    app.cleanup_before_exit();
                    std::process::exit(code.unwrap_or(0));
                });
            }
        });
    }

    #[cfg(mobile)]
    app.run(|_, _| {});
}

#[cfg(all(test, desktop))]
mod output_tests {
    use super::{output_media_type, resolve_output_path};

    #[test]
    fn opens_only_existing_files_inside_the_project() {
        let project = tempfile::tempdir().unwrap();
        let output = project.path().join("result.txt");
        std::fs::write(&output, "result").unwrap();
        assert_eq!(
            resolve_output_path(project.path().to_str().unwrap(), "result.txt").unwrap(),
            output.canonicalize().unwrap()
        );

        let outside = tempfile::NamedTempFile::new().unwrap();
        let error = resolve_output_path(
            project.path().to_str().unwrap(),
            outside.path().to_str().unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("inside this session's project"));
    }

    #[test]
    fn recognizes_only_supported_inline_image_outputs() {
        assert_eq!(
            output_media_type(std::path::Path::new("result.PNG")),
            Some("image/png")
        );
        assert_eq!(
            output_media_type(std::path::Path::new("diagram.svg")),
            Some("image/svg+xml")
        );
        assert_eq!(output_media_type(std::path::Path::new("notes.md")), None);
    }
}
