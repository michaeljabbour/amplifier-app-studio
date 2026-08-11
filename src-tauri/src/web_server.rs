use crate::{
    catalog,
    protocol::{SessionEvent, StartSessionOptions},
    runtime_setup,
    session::{EventSink, SessionManager},
    store,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::{net::TcpListener, sync::mpsc};
use tower_http::services::{ServeDir, ServeFile};

const DEFAULT_BIND: &str = "127.0.0.1:4317";

#[derive(Clone)]
struct ServerState {
    manager: SessionManager,
    default_project_dir: String,
}

#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub bind: SocketAddr,
    pub frontend_dir: PathBuf,
    pub default_project_dir: PathBuf,
}

impl ServerOptions {
    pub fn from_args<I, S>(args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut bind = DEFAULT_BIND
            .parse::<SocketAddr>()
            .expect("default bridge address is valid");
        let mut frontend_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        let mut values = args.into_iter().map(Into::into).skip(1);
        while let Some(argument) = values.next() {
            match argument.as_str() {
                "--bind" => {
                    let value = values
                        .next()
                        .ok_or_else(|| "--bind requires an IP:port value".to_owned())?;
                    bind = value
                        .parse()
                        .map_err(|error| format!("Invalid --bind value '{value}': {error}"))?;
                }
                "--frontend" => {
                    let value = values
                        .next()
                        .ok_or_else(|| "--frontend requires a directory".to_owned())?;
                    frontend_dir = PathBuf::from(value);
                }
                "--help" | "-h" => return Err(usage()),
                unknown => return Err(format!("Unknown argument '{unknown}'\n\n{}", usage())),
            }
        }

        if !bind.ip().is_loopback() {
            return Err(
                "The v0.1 bridge only binds to loopback. Remote mobile access needs TLS and authentication before a non-loopback bind is safe."
                    .to_owned(),
            );
        }
        let default_project_dir = env::current_dir()
            .map_err(|error| format!("Could not read the current directory: {error}"))?;
        Ok(Self {
            bind,
            frontend_dir,
            default_project_dir,
        })
    }
}

pub async fn serve(options: ServerOptions) -> Result<(), String> {
    if !options.frontend_dir.join("index.html").is_file() {
        return Err(format!(
            "Web frontend was not found at {}. Run `npm run build` first.",
            options.frontend_dir.display()
        ));
    }

    let state = ServerState {
        manager: SessionManager::default(),
        default_project_dir: options.default_project_dir.to_string_lossy().into_owned(),
    };
    let index = options.frontend_dir.join("index.html");
    let assets = ServeDir::new(&options.frontend_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(index));
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(config))
        .route("/api/stored-sessions", get(stored_sessions))
        .route("/api/catalog", get(capability_catalog))
        .route("/api/runtime", get(runtime_status))
        .route("/api/session/{gui_id}", get(session_upgrade))
        .fallback_service(assets)
        .with_state(state);

    let listener = TcpListener::bind(options.bind)
        .await
        .map_err(|error| format!("Could not bind {}: {error}", options.bind))?;
    println!("Amplifier Studio web bridge: http://{}", options.bind);
    axum::serve(listener, app)
        .await
        .map_err(|error| format!("Web bridge failed: {error}"))
}

pub async fn run_from_env() -> Result<(), String> {
    serve(ServerOptions::from_args(env::args())?).await
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "transport": "websocket",
        "localProcess": true,
    }))
}

async fn config(State(state): State<ServerState>) -> Json<Value> {
    Json(json!({
        "defaultProjectDir": state.default_project_dir,
        "transport": "websocket",
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredQuery {
    project_dir: Option<String>,
}

async fn stored_sessions(Query(query): Query<StoredQuery>) -> Result<Json<Value>, ServerError> {
    let sessions =
        tokio::task::spawn_blocking(move || store::list_stored_sessions(query.project_dir))
            .await
            .map_err(|error| ServerError(format!("Session scan task failed: {error}")))?
            .map_err(ServerError)?;
    serde_json::to_value(sessions)
        .map(Json)
        .map_err(|error| ServerError(format!("Could not encode stored sessions: {error}")))
}

async fn capability_catalog(Query(query): Query<StoredQuery>) -> Result<Json<Value>, ServerError> {
    let catalog = tokio::task::spawn_blocking(move || catalog::list_catalog(query.project_dir))
        .await
        .map_err(|error| ServerError(format!("Capability catalog task failed: {error}")))?
        .map_err(ServerError)?;
    serde_json::to_value(catalog)
        .map(Json)
        .map_err(|error| ServerError(format!("Could not encode capability catalog: {error}")))
}

async fn runtime_status() -> Result<Json<Value>, ServerError> {
    serde_json::to_value(runtime_setup::status())
        .map(Json)
        .map_err(|error| ServerError(format!("Could not encode runtime status: {error}")))
}

async fn session_upgrade(
    ws: WebSocketUpgrade,
    AxumPath(gui_id): AxumPath<String>,
    State(state): State<ServerState>,
) -> Response {
    ws.on_upgrade(move |socket| session_socket(socket, state.manager, gui_id))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Start { options: StartSessionOptions },
    Op { op: Value },
    Stop,
}

async fn session_socket(socket: WebSocket, manager: SessionManager, gui_id: String) {
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Value>();
    let outbound = tokio::spawn(async move {
        while let Some(value) = event_rx.recv().await {
            let Ok(encoded) = serde_json::to_string(&value) else {
                continue;
            };
            if socket_tx.send(Message::Text(encoded.into())).await.is_err() {
                break;
            }
        }
    });

    let mut started = false;
    while let Some(message) = socket_rx.next().await {
        let Ok(message) = message else {
            break;
        };
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let request = match serde_json::from_str::<ClientMessage>(&text) {
            Ok(request) => request,
            Err(error) => {
                send_error(&event_tx, format!("Invalid bridge message: {error}"));
                continue;
            }
        };

        match request {
            ClientMessage::Start { options } if !started => {
                if options.gui_id != gui_id {
                    send_error(&event_tx, "WebSocket path and options.guiId do not match");
                    continue;
                }
                let sink_tx = event_tx.clone();
                let sink: EventSink = Arc::new(move |event: SessionEvent| {
                    let _ = sink_tx.send(json!({
                        "type": "event",
                        "channel": event.channel,
                        "payload": event.payload,
                    }));
                });
                match manager.start(options, sink).await {
                    Ok(result) => {
                        started = true;
                        let _ = event_tx.send(json!({
                            "type": "ready",
                            "guiId": result.gui_id,
                            "projectDir": result.project_dir,
                        }));
                    }
                    Err(error) => send_error(&event_tx, error),
                }
            }
            ClientMessage::Start { .. } => {
                send_error(&event_tx, "This WebSocket already owns a session");
            }
            ClientMessage::Op { op } if started => {
                if let Err(error) = manager.send(&gui_id, op).await {
                    send_error(&event_tx, error);
                }
            }
            ClientMessage::Stop if started => match manager.stop(&gui_id).await {
                Ok(stopped) => {
                    let _ = event_tx.send(json!({ "type": "stopped", "stopped": stopped }));
                }
                Err(error) => send_error(&event_tx, error),
            },
            _ => send_error(&event_tx, "Send a start message before session operations"),
        }
    }

    if started {
        let _ = manager.stop(&gui_id).await;
    }
    outbound.abort();
}

fn send_error(sender: &mpsc::UnboundedSender<Value>, message: impl Into<String>) {
    let _ = sender.send(json!({ "type": "error", "message": message.into() }));
}

#[derive(Debug)]
struct ServerError(String);

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": self.0 })),
        )
            .into_response()
    }
}

fn usage() -> String {
    "Usage: amplifier-studio-server [--bind 127.0.0.1:4317] [--frontend ../dist]".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_refuses_public_bind_without_security() {
        let result = ServerOptions::from_args(["server", "--bind", "0.0.0.0:4317"]);
        assert!(result.unwrap_err().contains("only binds to loopback"));
    }

    #[test]
    fn bridge_accepts_loopback_and_frontend_override() {
        let options = ServerOptions::from_args([
            "server",
            "--bind",
            "127.0.0.1:9999",
            "--frontend",
            "/tmp/studio-dist",
        ])
        .expect("valid server options");
        assert_eq!(options.bind.port(), 9999);
        assert_eq!(
            options.frontend_dir,
            std::path::Path::new("/tmp/studio-dist")
        );
    }
}
