mod catalog;
mod protocol;
mod runtime_setup;
mod session;
mod store;
pub mod web_server;

use catalog::CapabilityCatalog;
use protocol::{LiveSession, SessionEvent, StartSessionOptions, StartSessionResult};
use serde_json::Value;
use session::{EventSink, SessionManager};
use std::sync::Arc;
use store::StoredSession;
#[cfg(desktop)]
use tauri::Manager;
use tauri::{AppHandle, Emitter, State};

#[cfg(desktop)]
mod app_updates {
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
    ) -> Result<(), String> {
        let update = pending_update
            .0
            .lock()
            .map_err(|_| "The update state is unavailable".to_owned())?
            .take()
            .ok_or_else(|| "There is no pending update".to_owned())?;
        let progress_app = app.clone();
        let finished_app = app.clone();
        let mut started = false;
        update
            .download_and_install(
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
            .map_err(|error| error.to_string())?;
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
async fn list_sessions(manager: State<'_, SessionManager>) -> Result<Vec<LiveSession>, String> {
    Ok(manager.list().await)
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
fn default_project_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("Could not read the current directory: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(desktop)]
            {
                _app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                _app.manage(app_updates::PendingUpdate::default());
            }
            Ok(())
        })
        .manage(SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            start_session,
            send_op,
            stop_session,
            list_sessions,
            list_stored_sessions,
            list_catalog,
            runtime_status,
            install_runtime,
            default_project_dir,
            #[cfg(desktop)]
            app_updates::fetch_update,
            #[cfg(desktop)]
            app_updates::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Amplifier Studio");
}
