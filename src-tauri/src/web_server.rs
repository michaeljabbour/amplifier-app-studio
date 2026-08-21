use crate::{
    catalog,
    protocol::{SessionEvent, StartSessionOptions},
    repo_clone, runtime_setup,
    session::{AttachmentId, EventSink, NetworkPrincipal, SessionManager, DUPLICATE_RESUME_ERROR},
    store,
};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        OriginalUri, Path as AxumPath, Query, Request, State,
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
    sync::{broadcast, mpsc, oneshot},
    time::{timeout, Duration},
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};

const DEFAULT_BIND: &str = "127.0.0.1:4317";
const API_VERSION: u16 = 1;
const TOKEN_ENV: &str = "AMPLIFIER_HOST_TOKEN";
const ORIGINS_ENV: &str = "AMPLIFIER_HOST_ALLOWED_ORIGINS";
const ROOTS_ENV: &str = "AMPLIFIER_HOST_ALLOWED_PROJECT_ROOTS";
const NATIVE_STUDIO_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];
const LEGACY_TOKEN_ENV: &str = "AMPLIFIER_STUDIO_BRIDGE_TOKEN";
const LEGACY_ORIGINS_ENV: &str = "AMPLIFIER_STUDIO_ALLOWED_ORIGINS";
const LEGACY_ROOTS_ENV: &str = "AMPLIFIER_STUDIO_ALLOWED_PROJECT_ROOTS";
const OUTBOUND_CAPACITY: usize = 256;
const CONTROL_CAPACITY: usize = 16;
const CONTROL_ENQUEUE_TIMEOUT: Duration = Duration::from_millis(250);
const WS_SEND_TIMEOUT: Duration = Duration::from_secs(3);
const WS_PROTOCOL: &str = "amplifier-host.v1";
const LEGACY_WS_PROTOCOL: &str = "amplifier-studio";
const WS_BEARER_PREFIX: &str = "amplifier-host.bearer.";
const LEGACY_WS_BEARER_PREFIX: &str = "amplifier-studio.bearer.";

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
        let mut default_root = None;
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
                "--default-project-root" => {
                    default_root = Some(PathBuf::from(require_arg(
                        &mut values,
                        "--default-project-root requires a directory",
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
            if let Some(configured) = env_with_legacy(ORIGINS_ENV, LEGACY_ORIGINS_ENV) {
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
        // Tauri uses a platform-specific application origin. These exact
        // origins still require the bearer token and let one host serve the
        // macOS, Windows, and mobile shells without per-machine CORS surgery.
        origins.extend(NATIVE_STUDIO_ORIGINS.iter().map(ToString::to_string));
        origins.sort();
        origins.dedup();

        if roots.is_empty() {
            if let Some(configured) = env_os_with_legacy(ROOTS_ENV, LEGACY_ROOTS_ENV) {
                roots.extend(env::split_paths(&configured));
            }
        }
        let allowed_project_roots = roots
            .iter()
            .map(|root| canonical_allowed_root(root))
            .collect::<Result<Vec<_>, _>>()?;
        let default_project_dir = match default_root {
            Some(root) => {
                authorize_project_dir(root.to_string_lossy().as_ref(), &allowed_project_roots)
                    .map_err(|error| format!("Invalid default project root: {error}"))?
            }
            None => allowed_project_roots.first().cloned().unwrap_or_default(),
        };

        let bearer_token = match token_file {
            Some(path) => std::fs::read_to_string(&path).map_err(|error| {
                format!(
                    "Could not read bridge token file {}: {error}",
                    path.display()
                )
            })?,
            None => env_with_legacy(TOKEN_ENV, LEGACY_TOKEN_ENV).ok_or_else(|| {
                format!(
                    "Amplifier Host requires a bearer token. Set {TOKEN_ENV} or pass --token-file."
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

/// Content-Security-Policy served to the browser client.
///
/// Mirrors `app.security.csp` in tauri.conf.json minus the Tauri-only `ipc:`
/// schemes. The host previously sent NO CSP at all, which made the "network off" promise on
/// `amplifier-html` artifacts true only in the desktop app: in a browser the sandboxed frame
/// could navigate ITSELF to an external URL and beacon its contents out. `frame-src` is what
/// stops that -- an artifact's own inner policy governs subresources, not navigation of its own
/// browsing context, so only the embedding page's policy can refuse it.
///
/// `connect-src` deliberately stays as broad as the desktop policy: a browser client may be
/// pointed at a bridge on another origin, and narrowing it to 'self' would break that.
///
/// Artifact frames inherit this policy, and `script-src` has no `'unsafe-inline'`, so an
/// artifact's own inline scripts do not execute. That is the intended behaviour, not a gap.
const BROWSER_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https: wss: http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-src 'self' data: blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// Attaches the browser client's security headers to every response.
async fn browser_security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    // A 101 has already handed the connection to the WebSocket; leave its headers alone.
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        return response;
    }
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(BROWSER_CSP),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// Builds the full HTTP surface.
///
/// Split out of `serve` so tests can exercise the real router -- in particular that the browser
/// security headers are actually attached to responses. Asserting only on the BROWSER_CSP
/// constant would pass even if the layer were never wired up, which is precisely the failure
/// mode this whole area has already produced once.
fn build_app(state: ServerState, frontend_dir: &Path) -> Result<Router, String> {
    let index = frontend_dir.join("index.html");
    let assets = ServeDir::new(frontend_dir)
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
        .route("/directories", get(directories).post(create_directory))
        .route("/repositories/clone", post(clone_repository))
        .route("/stored-sessions", get(stored_sessions))
        .route("/stored-session-export", get(stored_session_export))
        .route(
            "/stored-session-import",
            post(stored_session_import)
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/catalog", get(capability_catalog))
        .route("/catalog/bundles", post(register_bundle))
        .route("/runtime", get(runtime_status))
        .route(
            "/runtime-settings",
            get(runtime_settings_read).post(runtime_settings_apply),
        )
        .route("/output", get(output_download))
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
        // An unknown API path must be answered by the API router, not fall through to the SPA.
        //
        // axum only nests an inner router's fallback when the inner router has one, so without
        // this an unimplemented /v1/api/* path reached the root `.fallback_service(assets)` and
        // returned index.html: HTTP 200, text/html, and -- because that fallback lives outside
        // this CorsLayer -- no access-control-allow-origin. curl sees a healthy 200; a browser
        // sees a CORS failure and `fetch` REJECTS with an opaque TypeError, indistinguishable
        // from a dead tunnel. That is what made a stored session on an older host report itself
        // as unreachable while the host was answering normally. Attached before `.layer(cors)`
        // so the 404 carries CORS headers too.
        .fallback(|OriginalUri(uri): OriginalUri| async move {
            (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": format!(
                        "This Amplifier Host does not implement {}. The host is older than this Studio build; update the host.",
                        uri.path()
                    )
                })),
            )
        })
        // This outer layer answers browser preflight before bearer middleware;
        // actual API requests still require the token.
        .layer(cors);
    let app = Router::new()
        .nest("/v1/api", api.clone())
        // Compatibility alias for Studio builds from before the host surface
        // was versioned. New clients use /v1/api exclusively.
        .nest("/api", api)
        .fallback_service(assets)
        .layer(middleware::from_fn(browser_security_headers))
        .with_state(state);

    Ok(app)
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
    let app = build_app(state.clone(), &options.frontend_dir)?;

    let shutdown_manager = state.manager.clone();
    let cleanup_manager = state.manager.clone();

    let listener = TcpListener::bind(options.bind)
        .await
        .map_err(|error| format!("Could not bind {}: {error}", options.bind))?;
    println!("Amplifier Host v{API_VERSION}: http://{}", options.bind);
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_manager, shutdown))
        .await
        .map_err(|error| format!("Web bridge failed: {error}"));
    let cleanup = cleanup_manager.release_all().await;
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
    let _ = manager.release_all().await;
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
    // Auth rejections were entirely unlogged, so a token-guessing campaign against a
    // tailnet-exposed host was invisible. Log the method and path but never the presented
    // credential.
    tracing::warn!(
        method = %request.method(),
        path = %request.uri().path(),
        "rejected an unauthenticated Amplifier Host request",
    );
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "A valid Amplifier Host bearer token is required" })),
    )
        .into_response();
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Bearer realm=\"amplifier-host\""),
    );
    response
}

async fn health() -> Json<Value> {
    Json(json!({
        "version": API_VERSION,
        "status": "ok",
        "transport": "websocket",
        "localProcess": true,
    }))
}

async fn config(State(state): State<ServerState>) -> Json<Value> {
    // `sessionTransfer` is unconditional: it advertises that this host implements
    // stored-session export/import at all. A client talking to a host that predates those
    // endpoints can then say so, instead of discovering it as an unattributable fetch failure.
    let mut capabilities = vec!["sessionTransfer"];
    if repo_clone::configured_dev_workspace(
        &state.default_project_dir,
        &state.security.allowed_project_roots,
    )
    .is_ok()
    {
        capabilities.push("githubRepositoryClone");
    }
    Json(json!({
        "version": API_VERSION,
        "defaultProjectDir": state.default_project_dir,
        "transport": "websocket",
        "projectRootCount": state.security.allowed_project_roots.len(),
        "capabilities": capabilities,
    }))
}

#[derive(Debug, Deserialize)]
struct DirectoryQuery {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDirectoryRequest {
    parent: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloneRepositoryRequest {
    repository_url: String,
}

async fn clone_repository(
    State(state): State<ServerState>,
    Json(request): Json<CloneRepositoryRequest>,
) -> Result<Json<repo_clone::CloneRepositoryResult>, ServerError> {
    let dev_workspace = repo_clone::configured_dev_workspace(
        &state.default_project_dir,
        &state.security.allowed_project_roots,
    )
    .map_err(ServerError::bad_request)?;
    match repo_clone::clone_github_repository_into(&request.repository_url, &dev_workspace).await {
        Ok(result) => Ok(Json(result)),
        Err(error) if error == repo_clone::CLONE_BUSY => Err(ServerError::too_many_requests(error)),
        Err(error) => Err(ServerError::bad_request(error)),
    }
}

/// Creates one directory inside an already-authorized parent.
///
/// `authorize_project_dir` canonicalizes its argument, so it cannot vet a path
/// that does not exist yet. The parent is authorized instead -- it exists, so it
/// canonicalizes, and resolving it first collapses any symlink before the child
/// name is joined on. The name itself is required to be a single plain segment,
/// which is what keeps `..` and absolute paths from escaping that parent.
async fn create_directory(
    State(state): State<ServerState>,
    Json(request): Json<CreateDirectoryRequest>,
) -> Result<Json<Value>, ServerError> {
    let roots = state.security.allowed_project_roots.to_vec();
    let parent = authorize_project_dir(&request.parent, &roots).map_err(ServerError::forbidden)?;
    let name = request.name.trim().to_owned();
    if name.is_empty() {
        return Err(ServerError::forbidden("Enter a folder name"));
    }
    if name.len() > 128 {
        return Err(ServerError::forbidden(
            "Folder names are limited to 128 characters",
        ));
    }
    if Path::new(&name).components().count() != 1
        || name.contains('/')
        || name.contains('\\')
        || name.starts_with('.')
    {
        return Err(ServerError::forbidden(
            "Folder names must be a single segment and cannot start with a dot",
        ));
    }
    let target = parent.join(&name);
    // The parent is canonical and the name is a single plain segment, so this is
    // belt-and-braces -- but containment is the whole security boundary here.
    if !roots.iter().any(|root| target.starts_with(root)) {
        return Err(ServerError::forbidden(
            "That folder would fall outside the bridge's allowed project roots",
        ));
    }
    let created = target.clone();
    tokio::task::spawn_blocking(move || {
        if created.exists() {
            return Err(format!("'{name}' already exists"));
        }
        std::fs::create_dir(&created).map_err(|error| format!("Could not create '{name}': {error}"))
    })
    .await
    .map_err(|error| ServerError::internal(format!("Directory create task failed: {error}")))?
    .map_err(ServerError::forbidden)?;
    Ok(Json(json!({
        "version": API_VERSION,
        "path": target.to_string_lossy(),
    })))
}

async fn directories(
    State(state): State<ServerState>,
    Query(query): Query<DirectoryQuery>,
) -> Result<Json<Value>, ServerError> {
    let roots = state.security.allowed_project_roots.to_vec();
    let current = match query.path.filter(|value| !value.trim().is_empty()) {
        Some(path) => authorize_project_dir(&path, &roots).map_err(ServerError::forbidden)?,
        None => authorize_project_dir(&state.default_project_dir, &roots)
            .map_err(ServerError::forbidden)?,
    };
    let current_for_scan = current.clone();
    let entries = tokio::task::spawn_blocking(move || {
        let mut entries = std::fs::read_dir(&current_for_scan)
            .map_err(|error| format!("Could not browse the runtime host: {error}"))?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                if !file_type.is_dir() {
                    return None;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    return None;
                }
                Some(json!({
                    "name": name,
                    "path": entry.path().to_string_lossy(),
                }))
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
        Ok::<_, String>(entries)
    })
    .await
    .map_err(|error| ServerError::internal(format!("Directory scan task failed: {error}")))?
    .map_err(ServerError::internal)?;
    let parent = current.parent().and_then(|parent| {
        roots
            .iter()
            .any(|root| parent.starts_with(root))
            .then(|| parent.to_string_lossy().into_owned())
    });
    Ok(Json(json!({
        "version": API_VERSION,
        "path": current.to_string_lossy(),
        "parent": parent,
        "roots": roots.iter().map(|root| root.to_string_lossy()).collect::<Vec<_>>(),
        "directories": entries,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredQuery {
    project_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSessionExportQuery {
    project_dir: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSessionImportRequest {
    project_dir: String,
    payload: Value,
    new_id: String,
    name: Option<String>,
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
        store::list_stored_sessions_for_roots(&roots)
    })
    .await
    .map_err(|error| ServerError::internal(format!("Session scan task failed: {error}")))?
    .map_err(ServerError::internal)?;
    serde_json::to_value(sessions).map(Json).map_err(|error| {
        ServerError::internal(format!("Could not encode stored sessions: {error}"))
    })
}

async fn stored_session_export(
    State(state): State<ServerState>,
    Query(query): Query<StoredSessionExportQuery>,
) -> Result<Json<Value>, ServerError> {
    let project = authorize_project_dir(&query.project_dir, &state.security.allowed_project_roots)
        .map_err(ServerError::forbidden)?;
    let project_dir = project.to_string_lossy().into_owned();
    let session_id = query.session_id;
    let payload =
        tokio::task::spawn_blocking(move || store::export_stored_session(project_dir, session_id))
            .await
            .map_err(|error| ServerError::internal(format!("Session export task failed: {error}")))?
            .map_err(ServerError::internal)?;
    Ok(Json(payload))
}

async fn stored_session_import(
    State(state): State<ServerState>,
    Json(request): Json<StoredSessionImportRequest>,
) -> Result<Json<Value>, ServerError> {
    let project =
        authorize_project_dir(&request.project_dir, &state.security.allowed_project_roots)
            .map_err(ServerError::forbidden)?;
    let project_dir = project.to_string_lossy().into_owned();
    let session_id = tokio::task::spawn_blocking(move || {
        store::import_stored_session(project_dir, request.payload, request.new_id, request.name)
    })
    .await
    .map_err(|error| ServerError::internal(format!("Session import task failed: {error}")))?
    .map_err(ServerError::internal)?;
    Ok(Json(json!({ "sessionId": session_id })))
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
struct RuntimeSettingsQuery {
    project_dir: String,
}

async fn runtime_settings_read(
    State(state): State<ServerState>,
    Query(query): Query<RuntimeSettingsQuery>,
) -> Result<Json<Value>, ServerError> {
    let project = authorize_project_dir(&query.project_dir, &state.security.allowed_project_roots)
        .map_err(ServerError::forbidden)?;
    let snapshot = crate::runtime_settings::read(project.to_string_lossy().into_owned())
        .await
        .map_err(ServerError::internal)?;
    serde_json::to_value(snapshot).map(Json).map_err(|error| {
        ServerError::internal(format!("Could not encode runtime settings: {error}"))
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSettingsApplyRequest {
    project_dir: String,
    changes: Vec<crate::runtime_settings::RuntimeSettingChange>,
}

async fn runtime_settings_apply(
    State(state): State<ServerState>,
    Json(request): Json<RuntimeSettingsApplyRequest>,
) -> Result<Json<Value>, ServerError> {
    let project =
        authorize_project_dir(&request.project_dir, &state.security.allowed_project_roots)
            .map_err(ServerError::forbidden)?;
    if request.changes.iter().any(|change| {
        change.path.starts_with("providers.") || change.path == "notifications.push.topic"
    }) {
        return Err(ServerError::forbidden(
            "Provider credentials and push topics must be configured on the runtime host",
        ));
    }
    let snapshot =
        crate::runtime_settings::apply(project.to_string_lossy().into_owned(), request.changes)
            .await
            .map_err(ServerError::internal)?;
    serde_json::to_value(snapshot).map(Json).map_err(|error| {
        ServerError::internal(format!("Could not encode runtime settings: {error}"))
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputPreviewQuery {
    project_dir: String,
    path: String,
}

async fn output_download(
    State(state): State<ServerState>,
    Query(query): Query<OutputPreviewQuery>,
) -> Result<Response, ServerError> {
    const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
    let project = authorize_project_dir(&query.project_dir, &state.security.allowed_project_roots)
        .map_err(ServerError::forbidden)?;
    let output = crate::resolve_output_path(&project.to_string_lossy(), &query.path)
        .map_err(ServerError::forbidden)?;
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("amplifier-output")
        .replace(['\r', '\n', '"'], "_");
    let media_type = crate::output_media_type(&output).unwrap_or("application/octet-stream");
    let bytes = tokio::task::spawn_blocking(move || {
        let metadata = std::fs::metadata(&output)
            .map_err(|error| format!("Could not inspect output: {error}"))?;
        if metadata.len() > MAX_DOWNLOAD_BYTES {
            return Err(
                "Direct downloads can be up to 64 MB; use artifact.read chunks for larger files"
                    .to_owned(),
            );
        }
        std::fs::read(&output).map_err(|error| format!("Could not read output: {error}"))
    })
    .await
    .map_err(|error| ServerError::internal(format!("Output download task failed: {error}")))?
    .map_err(ServerError::internal)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(media_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
            .map_err(|error| ServerError::internal(format!("Invalid output filename: {error}")))?,
    );
    Ok((headers, bytes).into_response())
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
    ws.protocols([WS_PROTOCOL, LEGACY_WS_PROTOCOL])
        .on_upgrade(move |socket| session_socket(socket, state, gui_id))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Start {
        version: u16,
        options: StartSessionOptions,
    },
    Attach {
        version: u16,
        since: Option<u64>,
    },
    Op {
        version: u16,
        op: Value,
    },
    Stop {
        version: u16,
    },
}

impl ClientMessage {
    fn version(&self) -> u16 {
        match self {
            Self::Start { version, .. }
            | Self::Attach { version, .. }
            | Self::Op { version, .. }
            | Self::Stop { version } => *version,
        }
    }
}

#[derive(Clone)]
struct Outbound {
    sender: mpsc::Sender<OutboundEvent>,
    control_sender: mpsc::Sender<Value>,
}

struct OutboundEvent {
    value: Value,
    delivered: oneshot::Sender<bool>,
}

impl Outbound {
    /// Reserve bounded capacity, queue one cloned value, and resolve only
    /// after the WebSocket writer confirms the frame was sent. A failed or
    /// closed writer rejects delivery so the session reader can retry against
    /// the next attachment without losing an accepted-but-unflushed tail.
    async fn send_event(&self, event: &SessionEvent) -> bool {
        let Ok(permit) = self.sender.reserve().await else {
            return false;
        };
        let (delivered, confirmed) = oneshot::channel();
        permit.send(OutboundEvent {
            value: json!({
                "version": API_VERSION,
                "type": "event",
                "channel": event.channel,
                "payload": event.payload.clone(),
            }),
            delivered,
        });
        matches!(confirmed.await, Ok(true))
    }

    async fn control(&self, mut value: Value) -> bool {
        if let Some(object) = value.as_object_mut() {
            object.insert("version".to_owned(), Value::from(API_VERSION));
        }
        matches!(
            timeout(CONTROL_ENQUEUE_TIMEOUT, self.control_sender.send(value),).await,
            Ok(Ok(()))
        )
    }

    async fn error(&self, message: impl Into<String>) -> bool {
        self.control(json!({ "type": "error", "message": message.into() }))
            .await
    }
}

async fn next_outbound_value(
    control_rx: &mut mpsc::Receiver<Value>,
    event_rx: &mut mpsc::Receiver<OutboundEvent>,
    ready_sent: &mut bool,
) -> Option<(Value, Option<oneshot::Sender<bool>>)> {
    if !*ready_sent {
        let value = control_rx.recv().await?;
        if value.get("type").and_then(Value::as_str) == Some("ready") {
            *ready_sent = true;
        }
        return Some((value, None));
    }

    tokio::select! {
        biased;
        Some(value) = control_rx.recv() => Some((value, None)),
        Some(event) = event_rx.recv() => Some((event.value, Some(event.delivered))),
        else => None,
    }
}

async fn acknowledge_stop_result(outbound: &Outbound, stopped: bool) {
    if !stopped {
        let _ = outbound
            .control(json!({ "type": "stopped", "stopped": false }))
            .await;
    }
    // A successful stop is acknowledged by the ordered exit event. The exit
    // monitor waits for stdout/stderr readers, so using a priority control
    // frame here would let Studio discard the view before final records drain.
}

fn socket_attachment_requires_detach(terminal_exit_delivered: bool) -> bool {
    !terminal_exit_delivered
}

async fn cleanup_socket_attachment(
    manager: &SessionManager,
    attachment: Option<(String, AttachmentId)>,
    terminal_exit_delivered: bool,
) {
    if socket_attachment_requires_detach(terminal_exit_delivered) {
        if let Some((attached_gui_id, id)) = attachment {
            let _ = manager.detach(&attached_gui_id, id).await;
        }
    }
}

pub(crate) async fn finish_socket_attachment(
    manager: &SessionManager,
    attachment: Option<(String, AttachmentId)>,
    terminal_exit_delivered: &AtomicBool,
    writer: &mut tokio::task::JoinHandle<()>,
    writer_finished: bool,
) {
    // A peer close can race the terminal send. Quiesce the writer before
    // loading its marker so the cleanup decision has a hard happens-before
    // boundary: either exit was confirmed and published, or it can no longer
    // become confirmed after this point.
    if !writer_finished {
        writer.abort();
        let _ = (&mut *writer).await;
    }
    cleanup_socket_attachment(
        manager,
        attachment,
        terminal_exit_delivered.load(Ordering::Acquire),
    )
    .await;
}

async fn session_socket(socket: WebSocket, state: ServerState, gui_id: String) {
    let mut shutdown = state.shutdown.subscribe();
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (event_tx, mut event_rx) = mpsc::channel::<OutboundEvent>(OUTBOUND_CAPACITY);
    let (control_tx, mut control_rx) = mpsc::channel::<Value>(CONTROL_CAPACITY);
    let outbound = Outbound {
        sender: event_tx,
        control_sender: control_tx,
    };
    let terminal_exit_delivered = Arc::new(AtomicBool::new(false));
    let writer_terminal_exit_delivered = terminal_exit_delivered.clone();
    let mut writer = tokio::spawn(async move {
        let mut ready_sent = false;
        while let Some((value, delivered)) =
            next_outbound_value(&mut control_rx, &mut event_rx, &mut ready_sent).await
        {
            let terminal = value.get("type").and_then(Value::as_str) == Some("event")
                && value.get("channel").and_then(Value::as_str) == Some("exit");
            let Ok(encoded) = serde_json::to_string(&value) else {
                if let Some(delivered) = delivered {
                    let _ = delivered.send(false);
                }
                continue;
            };
            let sent = matches!(
                timeout(
                    WS_SEND_TIMEOUT,
                    socket_tx.send(Message::Text(encoded.into())),
                )
                .await,
                Ok(Ok(()))
            );
            // Publish terminal delivery before waking the exit finalizer. The
            // reader half may observe the peer's close response before this
            // writer task is joined, but confirmed exit must never be treated
            // as an ordinary disconnect and detached out from under cleanup.
            if sent && terminal {
                writer_terminal_exit_delivered.store(true, Ordering::Release);
            }
            if let Some(delivered) = delivered {
                let _ = delivered.send(sent);
            }
            if !sent {
                break;
            }
            if terminal {
                let _ = timeout(
                    WS_SEND_TIMEOUT,
                    socket_tx.send(Message::Close(Some(CloseFrame {
                        code: 1000,
                        reason: "runtime exited".into(),
                    }))),
                )
                .await;
                break;
            }
        }
    });

    let mut attachment: Option<(String, AttachmentId)> = None;
    let mut writer_finished = false;
    loop {
        let next = tokio::select! {
            message = socket_rx.next() => message,
            _ = shutdown.recv() => break,
            _ = &mut writer => {
                writer_finished = true;
                break;
            },
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
                let _ = outbound
                    .error(format!("Invalid bridge message: {error}"))
                    .await;
                continue;
            }
        };
        if request.version() != API_VERSION {
            let _ = outbound
                .error(format!(
                    "Unsupported Amplifier Host protocol version {}; this host requires version {API_VERSION}",
                    request.version()
                ))
                .await;
            continue;
        }

        match request {
            ClientMessage::Start { mut options, .. } if attachment.is_none() => {
                if options.gui_id != gui_id {
                    let _ = outbound
                        .error("WebSocket path and options.guiId do not match")
                        .await;
                    continue;
                }
                let project = match authorize_project_dir(
                    &options.project_dir,
                    &state.security.allowed_project_roots,
                ) {
                    Ok(project) => project,
                    Err(error) => {
                        let _ = outbound.error(error).await;
                        continue;
                    }
                };
                options.project_dir = project.to_string_lossy().into_owned();
                let sink = socket_sink(outbound.clone());
                let resume_identity = options
                    .resume_id
                    .clone()
                    .map(|resume_id| (options.project_dir.clone(), resume_id));
                let principal = NetworkPrincipal {
                    id: format!("studio-web:{gui_id}"),
                    kind: "human",
                    permissions: "read,write,control",
                };
                match state
                    .manager
                    .start_network_attached(options, sink.clone(), principal)
                    .await
                {
                    Ok((result, id)) => {
                        attachment = Some((result.gui_id.clone(), id));
                        if !outbound
                            .control(json!({
                                "type": "ready",
                                "guiId": result.gui_id,
                                "projectDir": result.project_dir,
                                "attached": false,
                            }))
                            .await
                        {
                            break;
                        }
                    }
                    Err(error) if error == DUPLICATE_RESUME_ERROR && resume_identity.is_some() => {
                        let (project_dir, resume_id) = resume_identity.expect("checked above");
                        match state
                            .manager
                            .attach_resume(&project_dir, &resume_id, sink)
                            .await
                        {
                            Ok((live_gui_id, id)) => {
                                attachment = Some((live_gui_id.clone(), id));
                                if !outbound
                                    .control(json!({
                                        "type": "ready",
                                        "guiId": live_gui_id.clone(),
                                        "projectDir": project_dir,
                                        "attached": true,
                                        "since": 0,
                                    }))
                                    .await
                                {
                                    break;
                                }
                                if let Err(error) = state
                                    .manager
                                    .send(
                                        &live_gui_id,
                                        json!({ "op": "history.replay", "since": 0 }),
                                    )
                                    .await
                                {
                                    let _ = outbound.error(error).await;
                                } else if let Err(error) = state
                                    .manager
                                    .send(&live_gui_id, json!({ "op": "session.status" }))
                                    .await
                                {
                                    let _ = outbound.error(error).await;
                                }
                            }
                            Err(attach_error) => {
                                let _ = outbound.error(attach_error).await;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = outbound.error(error).await;
                    }
                }
            }
            ClientMessage::Attach { since, .. } if attachment.is_none() => {
                let sink = socket_sink(outbound.clone());
                match state.manager.attach(&gui_id, sink).await {
                    Ok(id) => {
                        attachment = Some((gui_id.clone(), id));
                        if !outbound
                            .control(json!({
                                "type": "ready",
                                "guiId": gui_id,
                                "attached": true,
                                "since": since.unwrap_or(0),
                            }))
                            .await
                        {
                            break;
                        }
                        if let Err(error) = state
                            .manager
                            .send(
                                &gui_id,
                                json!({ "op": "history.replay", "since": since.unwrap_or(0) }),
                            )
                            .await
                        {
                            let _ = outbound.error(error).await;
                        } else if let Err(error) = state
                            .manager
                            .send(&gui_id, json!({ "op": "session.status" }))
                            .await
                        {
                            let _ = outbound.error(error).await;
                        }
                    }
                    Err(error) => {
                        let _ = outbound.error(error).await;
                    }
                }
            }
            ClientMessage::Start { .. } | ClientMessage::Attach { .. } => {
                let _ = outbound
                    .error("This WebSocket is already attached to a session")
                    .await;
            }
            ClientMessage::Op { op, .. } if attachment.is_some() => {
                let (attached_gui_id, attachment_id) = attachment.as_ref().expect("checked above");
                let current = state
                    .manager
                    .attachment_is_current(attached_gui_id, *attachment_id)
                    .await
                    .unwrap_or(false);
                if !current {
                    let _ = outbound
                        .error("This connection was replaced by a newer session attachment")
                        .await;
                } else if let Err(error) = state.manager.send(attached_gui_id, op).await {
                    let _ = outbound.error(error).await;
                }
            }
            ClientMessage::Stop { .. } if attachment.is_some() => {
                let (attached_gui_id, attachment_id) = attachment.as_ref().expect("checked above");
                let current = state
                    .manager
                    .attachment_is_current(attached_gui_id, *attachment_id)
                    .await
                    .unwrap_or(false);
                if !current {
                    let _ = outbound
                        .error("This connection was replaced by a newer session attachment")
                        .await;
                } else {
                    match state.manager.stop(attached_gui_id).await {
                        Ok(stopped) => {
                            acknowledge_stop_result(&outbound, stopped).await;
                        }
                        Err(error) => {
                            let _ = outbound.error(error).await;
                        }
                    }
                }
            }
            _ => {
                let _ = outbound
                    .error("Send a start or attach message before session operations")
                    .await;
            }
        }
    }

    finish_socket_attachment(
        &state.manager,
        attachment,
        &terminal_exit_delivered,
        &mut writer,
        writer_finished,
    )
    .await;
}

fn socket_sink(outbound: Outbound) -> EventSink {
    Arc::new(move |event: &SessionEvent| {
        let outbound = outbound.clone();
        Box::pin(async move { outbound.send_event(event).await })
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
        .find_map(|protocol| {
            protocol
                .strip_prefix(WS_BEARER_PREFIX)
                .or_else(|| protocol.strip_prefix(LEGACY_WS_BEARER_PREFIX))
        })
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

fn env_with_legacy(primary: &str, legacy: &str) -> Option<String> {
    env::var(primary)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var(legacy)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

fn env_os_with_legacy(primary: &str, legacy: &str) -> Option<std::ffi::OsString> {
    env::var_os(primary).or_else(|| env::var_os(legacy))
}

#[derive(Debug)]
struct ServerError {
    status: StatusCode,
    message: String,
}

impl ServerError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

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

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
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
        "Usage: amplifier-host [--bind 127.0.0.1:4317] [--frontend ../dist] [--token-file PATH] [--origin ORIGIN]... [--allow-project-root PATH]... [--default-project-root PATH]\n\nSet {TOKEN_ENV} instead of --token-file. Optional lists may also use {ORIGINS_ENV} (comma-separated) and {ROOTS_ENV} (platform path-separated)."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    async fn receive_and_ack(receiver: &mut mpsc::Receiver<OutboundEvent>) -> Value {
        let event = receiver.recv().await.expect("outbound event");
        let value = event.value;
        let _ = event.delivered.send(true);
        value
    }

    fn pending_event(value: Value) -> OutboundEvent {
        let (delivered, _confirmed) = oneshot::channel();
        OutboundEvent { value, delivered }
    }

    fn browser_test_state() -> ServerState {
        let (shutdown, _) = broadcast::channel(1);
        ServerState {
            manager: SessionManager::default(),
            default_project_dir: "/project".to_owned(),
            security: BridgeSecurity {
                bearer_token: b"0123456789abcdef0123456789abcdef".to_vec().into(),
                allowed_origins: vec!["http://127.0.0.1:4317".to_owned()].into(),
                allowed_project_roots: vec![PathBuf::from("/project")].into(),
            },
            shutdown,
        }
    }

    /// Regression: an unimplemented API path fell through to the root `fallback_service(assets)`
    /// and returned the SPA -- HTTP 200, text/html, and no access-control-allow-origin, because
    /// that fallback sits outside the CorsLayer. curl saw a healthy 200; the WebView saw a CORS
    /// failure and `fetch` rejected with an opaque TypeError. A stored session on a host too old
    /// to implement /v1/api/stored-session-export therefore reported itself as unreachable.
    #[tokio::test]
    async fn unknown_api_paths_answer_json_inside_cors() {
        use tower::ServiceExt;

        let frontend = tempfile::tempdir().expect("frontend dir");
        fs::write(
            frontend.path().join("index.html"),
            "<!doctype html><html></html>",
        )
        .expect("index.html");
        let app = build_app(browser_test_state(), frontend.path()).expect("router");

        let response = app
            .oneshot(
                Request::builder()
                    // A path this host does not register at all -- which is what an endpoint
                    // added after the host was built looks like from the host's side.
                    .uri("/v1/api/some-endpoint-added-after-this-host-shipped")
                    // browser_test_state allows this origin; the native Studio origins are added
                    // in ServerOptions construction, which the helper bypasses.
                    .header(header::ORIGIN, "http://127.0.0.1:4317")
                    .header(
                        header::AUTHORIZATION,
                        "Bearer 0123456789abcdef0123456789abcdef",
                    )
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .map(|v| v.to_str().unwrap()),
            Some("http://127.0.0.1:4317"),
            "the 404 must carry CORS headers or the browser reports it as a network failure",
        );
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body");
        let json: Value = serde_json::from_slice(&body).expect("json body, not the SPA");
        let error = json["error"].as_str().expect("error string");
        // OriginalUri, not Uri: inside a nested router Uri is only the remainder.
        assert!(
            error.contains("/v1/api/some-endpoint-added-after-this-host-shipped"),
            "{error}"
        );
        assert!(error.contains("older than this Studio build"), "{error}");
    }

    /// The host advertises stored-session transfer so a client can tell an old host from a new
    /// one before it tries, rather than inferring it from a rejected fetch.
    #[tokio::test]
    async fn config_advertises_session_transfer() {
        use tower::ServiceExt;

        let frontend = tempfile::tempdir().expect("frontend dir");
        fs::write(
            frontend.path().join("index.html"),
            "<!doctype html><html></html>",
        )
        .expect("index.html");
        let app = build_app(browser_test_state(), frontend.path()).expect("router");

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/api/config")
                    .header(
                        header::AUTHORIZATION,
                        "Bearer 0123456789abcdef0123456789abcdef",
                    )
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body");
        let json: Value = serde_json::from_slice(&body).expect("json");
        let capabilities: Vec<&str> = json["capabilities"]
            .as_array()
            .expect("capabilities")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            capabilities.contains(&"sessionTransfer"),
            "{capabilities:?}"
        );
    }

    /// Regression: the browser host shipped no CSP at all, so the "network off" promise on
    /// amplifier-html artifacts was true only in the desktop app. In a browser the sandboxed
    /// frame could navigate ITSELF to an external URL and beacon out; an artifact's own inner
    /// policy governs subresources, not navigation of its own browsing context, so only the
    /// embedding page's frame-src can refuse it.
    ///
    /// This drives the real router rather than the constant: a header that is declared but
    /// never wired up is exactly the failure this area has already produced once.
    #[tokio::test]
    async fn the_browser_host_actually_serves_its_security_headers() {
        use tower::ServiceExt;

        let frontend = tempfile::tempdir().expect("frontend dir");
        fs::write(
            frontend.path().join("index.html"),
            "<!doctype html><html></html>",
        )
        .expect("index.html");

        let app = build_app(browser_test_state(), frontend.path()).expect("router");
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(axum::body::Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        let csp = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .expect("the browser host must serve a Content-Security-Policy")
            .to_str()
            .expect("ascii csp");

        // frame-src is the directive that stops a sandboxed artifact navigating itself out.
        assert!(csp.contains("frame-src 'self' data: blob:"), "{csp}");
        assert!(csp.contains("object-src 'none'"), "{csp}");
        assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .map(|v| v.to_str().unwrap()),
            Some("nosniff")
        );
    }

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
        assert_eq!(
            options.allowed_origins,
            [
                "http://tauri.localhost",
                "https://studio.example.com",
                "https://tauri.localhost",
                "tauri://localhost",
            ]
        );
        assert_eq!(
            options.allowed_project_roots,
            [root.canonicalize().unwrap()]
        );
        assert_eq!(options.default_project_dir, root.canonicalize().unwrap());
    }

    #[test]
    fn bridge_accepts_an_explicit_default_inside_an_allowed_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("dev");
        let default = root.join("active-projects");
        fs::create_dir_all(&default).unwrap();
        let token = token_file(temp.path());
        let options = ServerOptions::from_args([
            "server",
            "--token-file",
            token.to_str().unwrap(),
            "--allow-project-root",
            root.to_str().unwrap(),
            "--default-project-root",
            default.to_str().unwrap(),
        ])
        .expect("valid default project root");
        assert_eq!(options.default_project_dir, default.canonicalize().unwrap());
    }

    #[test]
    fn bridge_rejects_a_default_outside_allowed_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("dev");
        let outside = temp.path().join("private");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let token = token_file(temp.path());
        let error = ServerOptions::from_args([
            "server",
            "--token-file",
            token.to_str().unwrap(),
            "--allow-project-root",
            root.to_str().unwrap(),
            "--default-project-root",
            outside.to_str().unwrap(),
        ])
        .unwrap_err();
        assert!(error.contains("Invalid default project root"));
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

    #[tokio::test]
    async fn replay_larger_than_the_websocket_queue_preserves_its_tail() {
        let (sender, mut receiver) = mpsc::channel::<OutboundEvent>(OUTBOUND_CAPACITY);
        let (control_sender, _control_receiver) = mpsc::channel::<Value>(CONTROL_CAPACITY);
        let sink = socket_sink(Outbound {
            sender,
            control_sender,
        });
        let total = OUTBOUND_CAPACITY + 44;
        let producer = tokio::spawn(async move {
            for sequence in 1..=total {
                let event = SessionEvent {
                    gui_id: "restored-session".to_owned(),
                    channel: "record",
                    payload: json!({
                        "type": if sequence == total { "history.end" } else { "runtime.event" },
                        "sequence": sequence,
                    }),
                };
                while !sink(&event).await {
                    tokio::task::yield_now().await;
                }
            }
        });

        // Let the producer hit the 256-record ceiling observed in the live
        // restore before the simulated WebSocket starts draining.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(!producer.is_finished());

        let mut sequences = Vec::with_capacity(total);
        while sequences.len() < total {
            let value = receive_and_ack(&mut receiver).await;
            sequences.push(value["payload"]["sequence"].as_u64().unwrap() as usize);
        }
        producer.await.unwrap();

        assert_eq!(sequences, (1..=total).collect::<Vec<_>>());
        assert_eq!(sequences.last(), Some(&total));
    }

    #[tokio::test]
    async fn ready_precedes_a_saturated_history_queue() {
        let (sender, mut receiver) = mpsc::channel::<OutboundEvent>(OUTBOUND_CAPACITY);
        let (control_sender, mut control_receiver) = mpsc::channel::<Value>(CONTROL_CAPACITY);
        let outbound = Outbound {
            sender,
            control_sender,
        };
        for sequence in 1..=OUTBOUND_CAPACITY {
            outbound
                .sender
                .try_send(pending_event(json!({
                    "version": API_VERSION,
                    "type": "event",
                    "channel": "record",
                    "payload": { "sequence": sequence },
                })))
                .unwrap();
        }
        let startup_sink = socket_sink(outbound.clone());
        let startup_log = tokio::spawn(async move {
            let event = SessionEvent {
                gui_id: "restored-session".to_owned(),
                channel: "log",
                payload: json!({ "stream": "host", "message": "diagnostics ready" }),
            };
            while !startup_sink(&event).await {
                tokio::task::yield_now().await;
            }
        });
        tokio::task::yield_now().await;
        assert!(!startup_log.is_finished());

        // Startup must not await the event-lane host log. It can reliably
        // queue ready through the separate control lane, which opens the
        // writer gate and lets the saturated replay continue draining.
        assert!(
            outbound
                .control(json!({ "type": "ready", "guiId": "restored-session" }))
                .await
        );

        let mut ready_sent = false;
        let (first, first_delivery) =
            next_outbound_value(&mut control_receiver, &mut receiver, &mut ready_sent)
                .await
                .expect("ready control frame");
        assert_eq!(first["type"], "ready");
        assert!(first_delivery.is_none());
        assert!(ready_sent);

        let (second, second_delivery) =
            next_outbound_value(&mut control_receiver, &mut receiver, &mut ready_sent)
                .await
                .expect("first history frame");
        assert_eq!(second["payload"]["sequence"], 1);
        let _ = second_delivery.expect("event acknowledgement").send(true);
        for _ in 1..OUTBOUND_CAPACITY {
            let (_, delivered) =
                next_outbound_value(&mut control_receiver, &mut receiver, &mut ready_sent)
                    .await
                    .expect("queued history frame");
            let _ = delivered.expect("event acknowledgement").send(true);
        }
        let (startup, delivered) =
            next_outbound_value(&mut control_receiver, &mut receiver, &mut ready_sent)
                .await
                .expect("startup log");
        assert_eq!(startup["payload"]["stream"], "host");
        let _ = delivered.expect("event acknowledgement").send(true);
        tokio::time::timeout(Duration::from_secs(1), startup_log)
            .await
            .expect("startup log unblocked after event drain")
            .unwrap();
    }

    #[tokio::test]
    async fn saturated_control_queue_cannot_block_shutdown_forever() {
        let (sender, _receiver) = mpsc::channel::<OutboundEvent>(OUTBOUND_CAPACITY);
        let (control_sender, _control_receiver) = mpsc::channel::<Value>(CONTROL_CAPACITY);
        let outbound = Outbound {
            sender,
            control_sender,
        };
        for sequence in 0..CONTROL_CAPACITY {
            outbound
                .control_sender
                .try_send(json!({ "type": "error", "sequence": sequence }))
                .unwrap();
        }

        let accepted = tokio::time::timeout(
            Duration::from_secs(1),
            outbound.control(json!({ "type": "stopped" })),
        )
        .await
        .expect("control enqueue is time-bounded");
        assert!(!accepted);
    }

    #[tokio::test]
    async fn successful_stop_waits_for_the_ordered_exit_event() {
        let (sender, _receiver) = mpsc::channel::<OutboundEvent>(OUTBOUND_CAPACITY);
        let (control_sender, mut control_receiver) = mpsc::channel::<Value>(CONTROL_CAPACITY);
        let outbound = Outbound {
            sender,
            control_sender,
        };

        acknowledge_stop_result(&outbound, true).await;
        assert!(matches!(
            control_receiver.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        acknowledge_stop_result(&outbound, false).await;
        let failed = control_receiver.recv().await.expect("failed stop response");
        assert_eq!(failed["type"], "stopped");
        assert_eq!(failed["stopped"], false);
    }

    #[test]
    fn confirmed_terminal_exit_suppresses_disconnect_detach() {
        assert!(socket_attachment_requires_detach(false));

        // The writer publishes this marker before it acknowledges exit to the
        // finalizer, so either writer completion or a peer close sees the same
        // terminal cleanup decision.
        assert!(!socket_attachment_requires_detach(true));
    }

    #[tokio::test]
    async fn large_event_waits_for_capacity_and_confirmed_writer_delivery() {
        let (sender, mut receiver) = mpsc::channel::<OutboundEvent>(1);
        let (control_sender, _control_receiver) = mpsc::channel::<Value>(CONTROL_CAPACITY);
        let outbound = Outbound {
            sender,
            control_sender,
        };
        outbound
            .sender
            .try_send(pending_event(json!({ "payload": { "sequence": 0 } })))
            .unwrap();
        let large_body = "x".repeat(1024 * 1024);
        let large_event = SessionEvent {
            gui_id: "restored-session".to_owned(),
            channel: "record",
            payload: json!({ "body": large_body }),
        };

        let outbound_for_large = outbound.clone();
        let delivery =
            tokio::spawn(async move { outbound_for_large.send_event(&large_event).await });
        tokio::task::yield_now().await;
        assert!(!delivery.is_finished());

        let queued = receiver.recv().await.expect("one queue slot");
        let _ = queued.delivered.send(true);
        let large = receiver.recv().await.expect("large event");
        assert!(!delivery.is_finished());
        assert_eq!(
            large.value["payload"]["body"].as_str().unwrap().len(),
            1024 * 1024
        );
        let _ = large.delivered.send(true);
        assert!(delivery.await.unwrap());
    }

    #[tokio::test]
    async fn closed_writer_rejects_event_delivery_for_reattach() {
        let (sender, receiver) = mpsc::channel::<OutboundEvent>(1);
        let (control_sender, _control_receiver) = mpsc::channel::<Value>(CONTROL_CAPACITY);
        drop(receiver);
        let outbound = Outbound {
            sender,
            control_sender,
        };
        assert!(
            !outbound
                .send_event(&SessionEvent {
                    gui_id: "restored-session".to_owned(),
                    channel: "record",
                    payload: json!({ "type": "history.end", "count": 300 }),
                })
                .await
        );
    }

    #[tokio::test]
    async fn closed_control_lane_rejects_ready_before_event_delivery() {
        let (sender, _receiver) = mpsc::channel::<OutboundEvent>(1);
        let (control_sender, control_receiver) = mpsc::channel::<Value>(1);
        drop(control_receiver);
        let outbound = Outbound {
            sender,
            control_sender,
        };
        assert!(
            !outbound
                .control(json!({ "type": "ready", "guiId": "restored-session" }))
                .await
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
