use serde::{Deserialize, Serialize};
use std::{env, fs, io::Read, path::PathBuf};

const NATIVE_STUDIO_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    bind: String,
    frontend: String,
    origins: Vec<String>,
    allowed_project_roots: Vec<String>,
    #[serde(default)]
    default_project_root: Option<String>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = env::args().collect::<Vec<_>>();
    match args.get(1).map(String::as_str) {
        Some("enable") => enable(&args[2..]).await,
        Some("status") => status(),
        Some("token") if args.get(2).map(String::as_str) == Some("rotate") => rotate_token(),
        Some("help") => {
            println!("{}", usage());
            Ok(())
        }
        _ => amplifier_studio_lib::web_server::run_from_env().await,
    }
}

async fn enable(args: &[String]) -> Result<(), String> {
    let mut bind = "127.0.0.1:4317".to_owned();
    let mut frontend = default_frontend();
    let mut origins = Vec::new();
    let mut roots = Vec::new();
    let mut default_project_root = None;
    let mut values = args.iter();
    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--bind" => bind = next(&mut values, "--bind requires IP:port")?.to_owned(),
            "--frontend" => {
                frontend = next(&mut values, "--frontend requires a directory")?.to_owned()
            }
            "--origin" => {
                origins.push(next(&mut values, "--origin requires an origin")?.to_owned())
            }
            "--allow-project-root" => roots
                .push(next(&mut values, "--allow-project-root requires a directory")?.to_owned()),
            "--default-project-root" => {
                default_project_root = Some(
                    next(&mut values, "--default-project-root requires a directory")?.to_owned(),
                )
            }
            "--help" | "-h" => return Err(usage()),
            unknown => {
                return Err(format!(
                    "Unknown enable argument '{unknown}'\n\n{}",
                    usage()
                ))
            }
        }
    }
    if roots.is_empty() {
        let project_home = match default_project_root.as_ref() {
            Some(path) => path.clone(),
            None => default_project_home()?,
        };
        roots.push(project_home.clone());
        default_project_root = Some(project_home);
    } else if default_project_root.is_none() {
        default_project_root = roots.first().cloned();
    }
    if origins.is_empty() {
        origins.push(format!("http://{bind}"));
    }
    for origin in NATIVE_STUDIO_ORIGINS {
        if !origins.iter().any(|candidate| candidate == origin) {
            origins.push(origin.to_owned());
        }
    }
    let config = HostConfig {
        bind,
        frontend,
        origins,
        allowed_project_roots: roots,
        default_project_root,
    };
    write_config(&config)?;
    let token_path = token_path();
    if !token_path.exists() {
        let token = new_token()?;
        write_secret(&token_path, &token)?;
        println!("Amplifier Host token (save it in the client keychain): {token}");
    }
    println!("Amplifier Host configuration: {}", config_path().display());
    println!("Starting in the foreground; put this command behind launchd, systemd, or your process supervisor.");
    serve_config(config).await
}

fn status() -> Result<(), String> {
    let config = read_config()?;
    let value = serde_json::json!({
        "version": 1,
        "configured": true,
        "bind": config.bind,
        "origins": config.origins,
        "allowedProjectRoots": config.allowed_project_roots,
        "defaultProjectRoot": config.default_project_root,
        "tokenFile": token_path(),
        "tokenPresent": token_path().is_file(),
        "configFile": config_path(),
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&value)
            .map_err(|error| format!("Could not encode host status: {error}"))?
    );
    Ok(())
}

fn rotate_token() -> Result<(), String> {
    let token = new_token()?;
    write_secret(&token_path(), &token)?;
    println!("New Amplifier Host token (update every client keychain): {token}");
    Ok(())
}

async fn serve_config(config: HostConfig) -> Result<(), String> {
    let mut args = vec![
        "amplifier-host".to_owned(),
        "--bind".to_owned(),
        config.bind,
        "--frontend".to_owned(),
        config.frontend,
        "--token-file".to_owned(),
        token_path().to_string_lossy().into_owned(),
    ];
    for origin in config.origins {
        args.extend(["--origin".to_owned(), origin]);
    }
    for root in config.allowed_project_roots {
        args.extend(["--allow-project-root".to_owned(), root]);
    }
    if let Some(root) = config.default_project_root {
        args.extend(["--default-project-root".to_owned(), root]);
    }
    let options = amplifier_studio_lib::web_server::ServerOptions::from_args(args)?;
    amplifier_studio_lib::web_server::serve(options).await
}

fn read_config() -> Result<HostConfig, String> {
    let path = config_path();
    let text = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Amplifier Host is not enabled at {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&text)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))
}

fn write_config(config: &HostConfig) -> Result<(), String> {
    let path = config_path();
    let parent = path
        .parent()
        .ok_or_else(|| "Host config has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let encoded = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Could not encode Amplifier Host configuration: {error}"))?;
    let temporary = path.with_extension("json.new");
    fs::write(&temporary, encoded)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not replace {}: {error}", path.display()))
}

/// Writes a secret so it is never readable by other users, not even briefly.
///
/// This used to be `fs::write` followed by `set_permissions(0o600)`, which creates the file at
/// the process umask first -- typically 0644 -- and only narrows it afterwards. The bearer token
/// was therefore world-readable for the window between those two calls, under a directory that
/// was itself created 0755. The mode is now applied at creation time, and the parent directory
/// is created 0700, so the token is never exposed even transiently.
fn write_secret(path: &PathBuf, value: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        file.write_all(format!("{value}\n").as_bytes())
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        // `.mode()` only applies when the file is created, so an existing token written by an
        // older build still has to be narrowed explicitly.
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect {}: {error}", path.display()))?;
    }
    #[cfg(not(unix))]
    fs::write(path, format!("{value}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;

    Ok(())
}

/// Creates a directory that only its owner can enter, on Unix.
fn create_private_dir(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        Ok(())
    }
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|error| format!("Could not obtain operating-system randomness: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn amplifier_home() -> PathBuf {
    env::var_os("AMPLIFIER_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".amplifier")))
        .unwrap_or_else(|| PathBuf::from(".amplifier"))
}

fn config_path() -> PathBuf {
    amplifier_home().join("host").join("config.json")
}

fn token_path() -> PathBuf {
    amplifier_home().join("host").join("token")
}

fn default_frontend() -> String {
    let mut candidates = Vec::new();
    if let Some(configured) = env::var_os("AMPLIFIER_HOST_FRONTEND") {
        candidates.push(PathBuf::from(configured));
    }
    if let Ok(executable) = env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("dist"));
            candidates.push(directory.join("../share/amplifier-host"));
            candidates.push(directory.join("../Resources"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"));
    candidates
        .into_iter()
        .find(|path| path.join("index.html").is_file())
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"))
        .to_string_lossy()
        .into_owned()
}

fn default_project_home() -> Result<String, String> {
    let home = dirs::home_dir().ok_or_else(|| {
        "Could not resolve a home directory; pass --allow-project-root explicitly".to_owned()
    })?;
    let project_home = home.join("dev");
    fs::create_dir_all(&project_home).map_err(|error| {
        format!(
            "Could not create the default project home {}: {error}",
            project_home.display()
        )
    })?;
    Ok(project_home.to_string_lossy().into_owned())
}

fn next<'a>(values: &mut std::slice::Iter<'a, String>, message: &str) -> Result<&'a str, String> {
    values
        .next()
        .map(String::as_str)
        .ok_or_else(|| message.to_owned())
}

fn usage() -> String {
    "Amplifier Host\n\n\
     amplifier-host enable [--allow-project-root PATH] [--default-project-root PATH] [--origin ORIGIN] [--bind 127.0.0.1:4317]\n\
     amplifier-host status\n\
     amplifier-host token rotate\n\
     amplifier-host [serve options]\n\n\
     Without a project-root option, enable creates and exposes ~/dev as the project home.\n\
     The listener stays loopback-only. Put Tailscale Serve, an SSH tunnel, or an authenticated TLS reverse proxy in front of it."
        .to_owned()
}
