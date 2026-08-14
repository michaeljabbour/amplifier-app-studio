use crate::{
    catalog,
    protocol::{SessionEvent, StartSessionOptions},
    runtime_setup,
    session::{AttachmentId, EventSink, SessionManager},
    store,
};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{broadcast, mpsc},
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};

const DEFAULT_BIND: &str = "127.0.0.1:4317";
const TOKEN_ENV: &str = "AMPLIFIER_STUDIO_BRIDGE_TOKEN";
const ORIGINS_ENV: &str = "AMPLIFIER_STUDIO_ALLOWED_ORIGINS";
const ROOTS_ENV: &str = "AMPLIFIER_STUDIO_ALLOWED_PROJECT_ROOTS";
const OUTBOUND_CAPACITY: usize = 256;
const WS_PROTOCOL: &str = "amplifier-studio";
const WS_BEARER_PREFIX: &str = "amplifier-studio.bearer.";

#[derive(Clone)]
struct ServerState {
    manager: SessionManager,
    default_project_dir: String,
    security: BridgeSecurity,
    shutdown: broadcast::Sender<()>,
}

#[derive(Clone)]
struct BridgeSecurity {
    bearer_token: Arc<[u8]>,
    allowed_origins: Arc<[String]>,
    allowed_project_roots: Arc<[PathBuf]>,
}

#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub bind: SocketAddr,
    pub frontend_dir: PathBuf,
    pub default_project_dir: PathBuf,
    bearer_token: Vec<u8>,
    allowed_origins: Vec<String>,
    allowed_project_roots: Vec<PathBuf>,
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
        let mut token_file: Option<PathBuf> = None;
        let mut origins = Vec::new();
        let mut roots = Vec::new();
        let mut values = args.into_iter().map(Into::into).skip(1);
        while let Some(argument) = values.next() {
            match argument.as_str() {
                "--bind" => {
                    let value = require_arg(&mut values, "--bind requires an IP:port value")?;
                    bind = value
                        .parse()
                        .map_err(|error| format!("Invalid --bind value '{value}': {error}"))?;
                }
                "--frontend" => {
                    frontend_dir =
                        PathBuf::from(require_arg(&mut values, "--frontend requires a directory")?);
                }
                "--token-file" => {
                    token_file = Some(PathBuf::from(require_arg(
                        &mut values,
                        "--token-file requires a path",
                    )?));
                }
                "--origin" => {
                    let value = require_arg(&mut values, "--origin requires an exact origin")?;
                    origins.push(normalize_origin(&value)?);
                }
                "--allow-project-root" => {
                    roots.push(PathBuf::from(require_arg(
                        &mut values,
                        "--allow-project-root requires a directory",
                    )?));
                }
                "--help" | "-h" => return Err(usage()),
                unknown => return Err(format!("Unknown argument '{unknown}'\n\n{}", usage())),
            }
        }

        if !bind.ip().is_loopback() {
            return Err(
                "The bridge remains loopback-only. Put an authenticated TLS tunnel or reverse proxy in front of it for remote access."
                    .to_owned(),
            );
        }

        if origins.is_empty() {
            if let Ok(configured) = env::var(ORIGINS_ENV) {
                for origin in configured
                    .split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                {
                    origins.push(normalize_origin(origin)?);
                }
            }
        }
        if origins.is_empty() {
            origins.push(format!("http://{bind}"));
        }
        origins.sort();
        origins.dedup();

        if roots.is_empty() {
            if let Some(configured) = env::var_os(ROOTS_ENV) {
                roots.extend(env::split_paths(&configured));
            }
        }
        let allowed_project_roots = roots
            .iter()
            .map(|root| canonical_allowed_root(root))
            .collect::<Result<Vec<_>, _>>()?;
        let default_project_dir = allowed_project_roots.first().cloned().unwrap_or_default();

        let bearer_token = match token_file {
            Some(path) => std::fs::read_to_string(&path).map_err(|error| {
                format!(
                    "Could not read bridge token file {}: {error}",
                    path.display()
                )
            })?,
            None => env::var(TOKEN_ENV).map_err(|_| {
                format!(
                    "The web bridge requires a bearer token. Set {TOKEN_ENV} or pass --token-file."
                )
            })?,
        };
        let bearer_token = bearer_token.trim().as_bytes().to_vec();
        if !(32..=4096).contains(&bearer_token.len()) {
            return Err("The bridge bearer token must contain 32 to 4096 bytes".to_owned());
        }

        Ok(Self {
            bind,
            frontend_dir,
            default_project_dir,
            bearer_token,
            allowed_origins: origins,
            allowed_project_roots,
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

    let (shutdown, _) = broadcast::channel(1);
    let state = ServerState {
        manager: SessionManager::default(),
        default_project_dir: options.default_project_dir.to_string_lossy().into_owned(),
        security: BridgeSecurity {
            bearer_token: options.bearer_token.into(),
            allowed_origins: options.allowed_origins.into(),
            allowed_project_roots: options.allowed_project_roots.into(),
        },
        shutdown: shutdown.clone(),
    };
    let index = options.frontend_dir.join("index.html");
    let assets = ServeDir::new(&options.frontend_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(index));
    let cors_origins = state
        .security
        .allowed_origins
        .iter()
        .map(|origin| {
            HeaderValue::from_str(origin).map_err(|error| {
                format!("Origin '{origin}' cannot be used in HTTP headers: {error}")
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cors = CorsLayer::new()
        .allow_origin(cors_origins)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    let api = Router::new()
        .route("/health", get(health))
        .route("/config", get(config))
        .route("/stored-sessions", get(stored_sessions))
        .route("/catalog", get(capability_catalog))
        .route("/catalog/bundles", post(register_bundle))
        .route("/runtime", get(runtime_status))
        .route("/output-preview", get(output_preview))
        .route(
            "/transcription",
            get(transcription_status)
                .post(transcribe_audio)
                .layer(axum::extract::DefaultBodyLimit::max(35 * 1024 * 1024)),
        )
        .route("/session/{gui_id}", get(session_upgrade))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ))
        // This outer layer answers browser preflight before bearer middleware;
        // actual API requests still require the token.
        .layer(cors);
    let shutdown_manager = state.manager.clone();
    let cleanup_manager = state.manager.clone();
    let app = Router::new()
        .nest("/api", api)
        .fallback_service(assets)
        .with_state(state);

    let listener = TcpListener::bind(options.bind)
        .await
        .map_err(|error| format!("Could not bind {}: {error}", options.bind))?;
    println!("Amplifier Studio web bridge: http://{}", options.bind);
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_manager, shutdown))
        .await
        .map_err(|error| format!("Web bridge failed: {error}"));
    let cleanup = cleanup_manager.stop_all().await;
    match (result, cleanup) {
        (Err(server), Err(cleanup)) => Err(format!("{server}; {cleanup}")),
        (Err(server), Ok(())) => Err(server),
        (Ok(()), Err(cleanup)) => Err(cleanup),
        (Ok(()), Ok(())) => Ok(()),
    }
}

pub async fn run_from_env() -> Result<(), String> {
    serve(ServerOptions::from_args(env::args())?).await
}

async fn shutdown_signal(manager: SessionManager, shutdown: broadcast::Sender<()>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }

    // Close even idle/authenticated sockets that never started a runtime;
    // otherwise Axum's graceful shutdown would wait for them indefinitely.
    let _ = shutdown.send(());
    let _ = manager.stop_all().await;
    let _ = shutdown.send(());
}

async fn require_bearer(
    State(state): State<ServerState>,
    request: Request,
    next: Next,
) -> Response {
    if request_authenticated(request.headers(), &state.security.bearer_token) {
        return next.run(request).await;
    }
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "A valid Amplifier Studio bearer token is required" })),
    )
        .into_response();
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"amplifier-studio\""),
    );
    response
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
        "projectRootCount": state.security.allowed_project_roots.len(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredQuery {
    project_dir: Option<String>,
}

async fn stored_sessions(
    State(state): State<ServerState>,
    Query(query): Query<StoredQuery>,
) -> Result<Json<Value>, ServerError> {
    let roots = state.security.allowed_project_roots.to_vec();
    let project = match query.project_dir {
        Some(project) => {
            Some(authorize_project_dir(&project, &roots).map_err(ServerError::forbidden)?)
        }
        None => None,
    };
    let sessions = tokio::task::spawn_blocking(move || {
        if let Some(project) = project {
            return store::list_stored_sessions(Some(project.to_string_lossy().into_owned()));
        }
        let mut sessions = Vec::new();
        for root in roots {
            sessions.extend(store::list_stored_sessions(Some(
                root.to_string_lossy().into_owned(),
            ))?);
        }
        sessions.sort_by_key(|session| std::cmp::Reverse(session.mtime_ms));
        let mut seen = HashSet::new();
        sessions.retain(|session| seen.insert(session.session_id.clone()));
        Ok(sessions)
    })
    .await
    .map_err(|error| ServerError::internal(format!("Session scan task failed: {error}")))?
    .map_err(ServerError::internal)?;
    serde_json::to_value(sessions).map(Json).map_err(|error| {
        ServerError::internal(format!("Could not encode stored sessions: {error}"))
    })
}

async fn capability_catalog(
    State(state): State<ServerState>,
    Query(query): Query<StoredQuery>,
) -> Result<Json<Value>, ServerError> {
    let project = resolve_api_project(query.project_dir, &state.security.allowed_project_roots)
        .map_err(ServerError::forbidden)?;
    let catalog = tokio::task::spawn_blocking(move || {
        catalog::list_catalog(Some(project.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| ServerError::internal(format!("Capability catalog task failed: {error}")))?
    .map_err(ServerError::internal)?;
    serde_json::to_value(catalog).map(Json).map_err(|error| {
        ServerError::internal(format!("Could not encode capability catalog: {error}"))
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddBundleRequest {
    project_dir: Option<String>,
    uri: String,
    name: Option<String>,
}

async fn register_bundle(
    State(state): State<ServerState>,
    Json(request): Json<AddBundleRequest>,
) -> Result<Json<Value>, ServerError> {
    let project = resolve_api_project(request.project_dir, &state.security.allowed_project_roots)
        .map_err(ServerError::forbidden)?;
    let catalog = tokio::task::spawn_blocking(move || {
        catalog::add_bundle(
            Some(project.to_string_lossy().into_owned()),
            request.uri,
            request.name,
        )
    })
    .await
    .map_err(|error| ServerError::internal(format!("Bundle registration task failed: {error}")))?
    .map_err(ServerError::internal)?;
    serde_json::to_value(catalog).map(Json).map_err(|error| {
        ServerError::internal(format!("Could not encode capability catalog: {error}"))
    })
}

async fn runtime_status() -> Result<Json<Value>, ServerError> {
    serde_json::to_value(runtime_setup::status())
        .map(Json)
        .map_err(|error| ServerError::internal(format!("Could not encode runtime status: {error}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputPreviewQuery {
    project_dir: String,
    path: String,
}

async fn output_preview(
    State(state): State<ServerState>,
    Query(query): Query<OutputPreviewQuery>,
) -> Result<Json<Value>, ServerError> {
    const MAX_PREVIEW_BYTES: u64 = 24 * 1024 * 1024;
    let project = authorize_project_dir(&query.project_dir, &state.security.allowed_project_roots)
        .map_err(ServerError::forbidden)?;
    let output = crate::resolve_output_path(&project.to_string_lossy(), &query.path)
        .map_err(ServerError::forbidden)?;
    let media_type = crate::output_media_type(&output)
        .ok_or_else(|| ServerError::forbidden("This output type cannot be previewed inline"))?;
    let (length, data) = tokio::task::spawn_blocking(move || {
        let metadata = std::fs::metadata(&output)
            .map_err(|error| format!("Could not inspect output: {error}"))?;
        if metadata.len() > MAX_PREVIEW_BYTES {
            return Err("Inline image previews can be up to 24 MB".to_owned());
        }
        let bytes = std::fs::read(&output)
            .map_err(|error| format!("Could not read output preview: {error}"))?;
        Ok((metadata.len(), STANDARD.encode(bytes)))
    })
    .await
    .map_err(|error| ServerError::internal(format!("Output preview task failed: {error}")))?
    .map_err(ServerError::internal)?;
    Ok(Json(json!({
        "mediaType": media_type,
        "data": data,
        "size": length,
    })))
}

async fn transcription_status() -> Result<Json<Value>, ServerError> {
    serde_json::to_value(crate::transcription::status())
        .map(Json)
        .map_err(|error| {
            ServerError::internal(format!("Could not encode transcription status: {error}"))
        })
}

async fn transcribe_audio(
    Json(request): Json<crate::transcription::TranscriptionRequest>,
) -> Result<Json<Value>, ServerError> {
    crate::transcription::transcribe(request)
        .await
        .map(|text| Json(json!({ "text": text })))
        .map_err(ServerError::internal)
}

async fn session_upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    AxumPath(gui_id): AxumPath<String>,
    State(state): State<ServerState>,
) -> Response {
    if !origin_allowed(&headers, &state.security.allowed_origins) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "WebSocket Origin is not allowed" })),
        )
            .into_response();
    }
    ws.protocols([WS_PROTOCOL])
        .on_upgrade(move |socket| session_socket(socket, state, gui_id))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Start { options: StartSessionOptions },
    Attach { since: Option<u64> },
    Op { op: Value },
    Stop,
}

#[derive(Clone)]
struct Outbound {
    sender: mpsc::Sender<Value>,
    overflowed: Arc<AtomicBool>,
}

impl Outbound {
    fn send(&self, value: Value) {
        match self.sender.try_send(value) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.overflowed.store(true, Ordering::Release);
            }
        }
    }

    fn error(&self, message: impl Into<String>) {
        self.send(json!({ "type": "error", "message": message.into() }));
    }
}

async fn session_socket(socket: WebSocket, state: ServerState, gui_id: String) {
    let mut shutdown = state.shutdown.subscribe();
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (event_tx, mut event_rx) = mpsc::channel::<Value>(OUTBOUND_CAPACITY);
    let overflowed = Arc::new(AtomicBool::new(false));
    let outbound = Outbound {
        sender: event_tx,
        overflowed: overflowed.clone(),
    };
    let writer = tokio::spawn(async move {
        while let Some(value) = event_rx.recv().await {
            let terminal = value.get("type").and_then(Value::as_str) == Some("event")
                && value.get("channel").and_then(Value::as_str) == Some("exit");
            let Ok(encoded) = serde_json::to_string(&value) else {
                continue;
            };
            if socket_tx.send(Message::Text(encoded.into())).await.is_err() {
                break;
            }
            if terminal {
                let _ = socket_tx
                    .send(Message::Close(Some(CloseFrame {
                        code: 1000,
                        reason: "runtime exited".into(),
                    })))
                    .await;
                break;
            }
            if overflowed.swap(false, Ordering::AcqRel) {
                let _ = socket_tx
                    .send(Message::Close(Some(CloseFrame {
                        code: 1013,
                        reason: "client fell behind; reconnect to replay".into(),
                    })))
                    .await;
                break;
            }
        }
    });

    let mut attachment: Option<AttachmentId> = None;
    loop {
        let next = tokio::select! {
            message = socket_rx.next() => message,
            _ = shutdown.recv() => break,
        };
        let Some(message) = next else {
            break;
        };
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
                outbound.error(format!("Invalid bridge message: {error}"));
                continue;
            }
        };

        match request {
            ClientMessage::Start { mut options } if attachment.is_none() => {
                if options.gui_id != gui_id {
                    outbound.error("WebSocket path and options.guiId do not match");
                    continue;
                }
                let project = match authorize_project_dir(
                    &options.project_dir,
                    &state.security.allowed_project_roots,
                ) {
                    Ok(project) => project,
                    Err(error) => {
                        outbound.error(error);
                        continue;
                    }
                };
                options.project_dir = project.to_string_lossy().into_owned();
                let sink = socket_sink(outbound.clone());
                match state.manager.start_attached(options, sink).await {
                    Ok((result, id)) => {
                        attachment = Some(id);
                        outbound.send(json!({
                            "type": "ready",
                            "guiId": result.gui_id,
                            "projectDir": result.project_dir,
                            "attached": false,
                        }));
                    }
                    Err(error) => outbound.error(error),
                }
            }
            ClientMessage::Attach { since } if attachment.is_none() => {
                let sink = socket_sink(outbound.clone());
                match state.manager.attach(&gui_id, sink).await {
                    Ok(id) => {
                        attachment = Some(id);
                        outbound.send(json!({
                            "type": "ready",
                            "guiId": gui_id,
                            "attached": true,
                            "since": since.unwrap_or(0),
                        }));
                        if let Err(error) = state
                            .manager
                            .send(
                                &gui_id,
                                json!({ "op": "history.replay", "since": since.unwrap_or(0) }),
                            )
                            .await
                        {
                            outbound.error(error);
                        } else if let Err(error) = state
                            .manager
                            .send(&gui_id, json!({ "op": "session.status" }))
                            .await
                        {
                            outbound.error(error);
                        }
                    }
                    Err(error) => outbound.error(error),
                }
            }
            ClientMessage::Start { .. } | ClientMessage::Attach { .. } => {
                outbound.error("This WebSocket is already attached to a session");
            }
            ClientMessage::Op { op } if attachment.is_some() => {
                let current = state
                    .manager
                    .attachment_is_current(&gui_id, attachment.expect("checked above"))
                    .await
                    .unwrap_or(false);
                if !current {
                    outbound.error("This connection was replaced by a newer session attachment");
                } else if let Err(error) = state.manager.send(&gui_id, op).await {
                    outbound.error(error);
                }
            }
            ClientMessage::Stop if attachment.is_some() => {
                let current = state
                    .manager
                    .attachment_is_current(&gui_id, attachment.expect("checked above"))
                    .await
                    .unwrap_or(false);
                if !current {
                    outbound.error("This connection was replaced by a newer session attachment");
                } else {
                    match state.manager.stop(&gui_id).await {
                        Ok(stopped) => {
                            outbound.send(json!({ "type": "stopped", "stopped": stopped }));
                        }
                        Err(error) => outbound.error(error),
                    }
                }
            }
            _ => outbound.error("Send a start or attach message before session operations"),
        }
    }

    if let Some(id) = attachment {
        let _ = state.manager.detach(&gui_id, id).await;
    }
    writer.abort();
}

fn socket_sink(outbound: Outbound) -> EventSink {
    Arc::new(move |event: SessionEvent| {
        outbound.send(json!({
            "type": "event",
            "channel": event.channel,
            "payload": event.payload,
        }));
    })
}

fn request_authenticated(headers: &HeaderMap, expected: &[u8]) -> bool {
    bearer_from_authorization(headers)
        .or_else(|| bearer_from_websocket_protocol(headers))
        .is_some_and(|provided| constant_time_token_eq(&provided, expected))
}

fn bearer_from_authorization(headers: &HeaderMap) -> Option<Vec<u8>> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return None;
    }
    Some(token.as_bytes().to_vec())
}

fn bearer_from_websocket_protocol(headers: &HeaderMap) -> Option<Vec<u8>> {
    let value = headers.get(header::SEC_WEBSOCKET_PROTOCOL)?.to_str().ok()?;
    value
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix(WS_BEARER_PREFIX))
        .filter(|encoded| encoded.len() <= 8192)
        .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
}

fn constant_time_token_eq(provided: &[u8], expected: &[u8]) -> bool {
    if provided.len() != expected.len() {
        let mut padded = vec![0_u8; expected.len()];
        let copy_len = provided.len().min(expected.len());
        padded[..copy_len].copy_from_slice(&provided[..copy_len]);
        let _ = padded.ct_eq(expected);
        return false;
    }
    bool::from(provided.ct_eq(expected))
}

fn origin_allowed(headers: &HeaderMap, allowed: &[String]) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    allowed.iter().any(|candidate| candidate == origin)
}

fn authorize_project_dir(value: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let requested = Path::new(value.trim());
    let canonical = requested.canonicalize().map_err(|error| {
        format!(
            "Project directory '{}' is unavailable: {error}",
            requested.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!("'{}' is not a directory", canonical.display()));
    }
    if roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(canonical)
    } else {
        Err(format!(
            "Project directory '{}' is outside the bridge's allowed project roots",
            canonical.display()
        ))
    }
}

fn resolve_api_project(value: Option<String>, roots: &[PathBuf]) -> Result<PathBuf, String> {
    match value.filter(|value| !value.trim().is_empty()) {
        Some(value) => authorize_project_dir(&value, roots),
        None => roots
            .first()
            .cloned()
            .ok_or_else(|| "The bridge has no allowed project roots".to_owned()),
    }
}

fn canonical_allowed_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = root.canonicalize().map_err(|error| {
        format!(
            "Allowed project root '{}' is unavailable: {error}",
            root.display()
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "Allowed project root '{}' is not a directory",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn normalize_origin(value: &str) -> Result<String, String> {
    let origin = value.trim().trim_end_matches('/');
    let Some((scheme, authority)) = origin.split_once("://") else {
        return Err(format!("Invalid Origin '{value}'"));
    };
    if scheme.is_empty()
        || authority.is_empty()
        || authority.contains('/')
        || authority.contains('?')
        || authority.contains('#')
    {
        return Err(format!("Invalid Origin '{value}'"));
    }
    Ok(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    ))
}

fn require_arg<I>(values: &mut I, message: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    values.next().ok_or_else(|| message.to_owned())
}

#[derive(Debug)]
struct ServerError {
    status: StatusCode,
    message: String,
}

impl ServerError {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

fn usage() -> String {
    format!(
        "Usage: amplifier-studio-server [--bind 127.0.0.1:4317] [--frontend ../dist] [--token-file PATH] [--origin ORIGIN]... [--allow-project-root PATH]...\n\nSet {TOKEN_ENV} instead of --token-file. Optional lists may also use {ORIGINS_ENV} (comma-separated) and {ROOTS_ENV} (platform path-separated)."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    fn token_file(directory: &Path) -> PathBuf {
        let path = directory.join("token");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(file, "0123456789abcdef0123456789abcdef").unwrap();
        path
    }

    #[test]
    fn bridge_refuses_public_bind_even_when_authenticated() {
        let temp = tempfile::tempdir().unwrap();
        let token = token_file(temp.path());
        let result = ServerOptions::from_args([
            "server",
            "--bind",
            "0.0.0.0:4317",
            "--token-file",
            token.to_str().unwrap(),
        ]);
        assert!(result.unwrap_err().contains("loopback-only"));
    }

    #[test]
    fn bridge_requires_a_strong_token() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("token");
        fs::write(&path, "short").unwrap();
        let result = ServerOptions::from_args(["server", "--token-file", path.to_str().unwrap()]);
        assert!(result.unwrap_err().contains("32 to 4096 bytes"));
    }

    #[test]
    fn bridge_accepts_exact_origins_and_canonical_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("projects");
        fs::create_dir(&root).unwrap();
        let token = token_file(temp.path());
        let options = ServerOptions::from_args([
            "server",
            "--bind",
            "127.0.0.1:9999",
            "--frontend",
            "/tmp/studio-dist",
            "--token-file",
            token.to_str().unwrap(),
            "--origin",
            "https://studio.example.com/",
            "--allow-project-root",
            root.to_str().unwrap(),
        ])
        .expect("valid server options");
        assert_eq!(options.bind.port(), 9999);
        assert_eq!(options.allowed_origins, ["https://studio.example.com"]);
        assert_eq!(
            options.allowed_project_roots,
            [root.canonicalize().unwrap()]
        );
    }

    #[test]
    fn bearer_comparison_and_websocket_encoding_are_strict() {
        let token = b"0123456789abcdef0123456789abcdef";
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer 0123456789abcdef0123456789abcdef"),
        );
        assert!(request_authenticated(&headers, token));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer 0123456789abcdef0123456789abcdeg"),
        );
        assert!(!request_authenticated(&headers, token));

        headers.remove(header::AUTHORIZATION);
        let encoded = URL_SAFE_NO_PAD.encode(token);
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(&format!("{WS_PROTOCOL}, {WS_BEARER_PREFIX}{encoded}")).unwrap(),
        );
        assert!(request_authenticated(&headers, token));
    }

    #[test]
    fn websocket_origin_is_an_exact_required_match() {
        let mut headers = HeaderMap::new();
        let allowed = vec!["https://studio.example.com".to_owned()];
        assert!(!origin_allowed(&headers, &allowed));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://studio.example.com.evil.test"),
        );
        assert!(!origin_allowed(&headers, &allowed));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://studio.example.com"),
        );
        assert!(origin_allowed(&headers, &allowed));
    }

    #[test]
    fn project_roots_default_deny_and_allow_real_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("projects");
        let project = root.join("one");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        let root = root.canonicalize().unwrap();

        assert!(authorize_project_dir(project.to_str().unwrap(), &[]).is_err());
        assert_eq!(
            authorize_project_dir(project.to_str().unwrap(), &[root]).unwrap(),
            project.canonicalize().unwrap()
        );
        assert!(
            authorize_project_dir(outside.to_str().unwrap(), &[temp.path().join("projects")])
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn project_root_check_resolves_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("projects");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("escape")).unwrap();

        assert!(authorize_project_dir(
            root.join("escape").to_str().unwrap(),
            &[root.canonicalize().unwrap()]
        )
        .unwrap_err()
        .contains("outside"));
    }
}
