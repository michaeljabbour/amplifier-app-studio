use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use subtle::ConstantTimeEq;
use tokio::io::AsyncWriteExt;

/// The reviewed amplifier-runtime revision. Both the bootstrap script URL and the `--ref`
/// argument resolve to this commit, so "what Studio installs" is a single reviewable value.
///
/// This is the identity Studio actually cares about, and `REQUIRED_RUNTIME_VERSION` cannot stand
/// in for it: the runtime's version only moves on release commits, so multiple revisions can
/// honestly report the same version. A version check can therefore pass when the pin has
/// drifted, which is the case it exists to catch. `installed_runtime_commit` reads
/// the commit the package manager recorded and `status()` compares it against this constant.
const RUNTIME_INSTALL_REF: &str = "5cb6916bb7d6025be90b633f5baafbccb98e7396";

/// Bootstrap scripts are fetched from the pinned commit and checksum-verified before they run.
///
/// These used to be `curl .../main/scripts/install.sh | bash` and an `Invoke-RestMethod` piped
/// into `[scriptblock]::Create`. Only the `--ref` ARGUMENT was pinned; the script consuming it
/// was whatever the mutable `main` branch held at click time, with no checksum and no
/// signature. That made any push to (or compromise of) amplifier-runtime@main arbitrary code
/// execution on every Studio install, in a different trust domain from the minisign-verified
/// Tauri updater. Refresh both digests with `scripts/runtime-installer-digest.sh` whenever
/// RUNTIME_INSTALL_REF moves.
const INSTALL_SCRIPT_SHA256: &str =
    "a0904a1f8d7e6a11117f5398cd8faeb4a3a56b32cd30394136e4c6731075e611";
#[cfg(target_os = "windows")]
const WINDOWS_INSTALL_SCRIPT_SHA256: &str =
    "85c13a6bd4f14b51c6e434081d437e4ae136b2ae4fe65e0183f7fa66271369aa";

const REQUIRED_RUNTIME_VERSION: &str = "0.1.10";
const RUNTIME_BINARY_ENV: &str = "AMPLIFIER_STUDIO_RUNTIME_BIN";
const NEUTRAL_RUNTIME_BINARY: &str = "amplifier-runtime";

fn install_script_url(file: &str) -> String {
    format!("https://raw.githubusercontent.com/michaeljabbour/amplifier-runtime/{RUNTIME_INSTALL_REF}/scripts/{file}")
}

/// Downloads a bootstrap script over HTTPS and returns it only if it matches `expected_sha256`.
async fn fetch_verified_install_script(
    url: &str,
    expected_sha256: &str,
) -> Result<Vec<u8>, String> {
    let response = reqwest::Client::builder()
        .https_only(true)
        .build()
        .map_err(|error| format!("Could not start the Amplifier installer: {error}"))?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not download the Amplifier installer: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download the Amplifier installer: {} returned {}",
            url,
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the Amplifier installer: {error}"))?;
    let actual = hex_digest(&bytes);
    // Constant-time compare so a mismatch cannot be probed byte by byte.
    if !bool::from(actual.as_bytes().ct_eq(expected_sha256.as_bytes())) {
        return Err(format!(
            "The Amplifier installer failed its integrity check and was not run. Expected SHA-256 {expected_sha256}, got {actual}."
        ));
    }
    Ok(bytes.to_vec())
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Writes the verified script to a private temp file. Returned path is owner-only on Unix.
fn stage_install_script(contents: &[u8], file_name: &str) -> Result<PathBuf, String> {
    let path = env::temp_dir().join(format!(
        "amplifier-runtime-{RUNTIME_INSTALL_REF}-{file_name}"
    ));
    std::fs::write(&path, contents)
        .map_err(|error| format!("Could not stage the Amplifier installer: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the Amplifier installer: {error}"))?;
    }
    Ok(path)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub current: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
    /// The revision actually installed, when the package manager recorded one.
    pub commit: Option<String>,
    pub adapter: String,
    pub install_supported: bool,
    pub provider_status_available: bool,
    pub provider_configured: bool,
    pub provider_message: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ProviderStatus {
    configured: bool,
    message: String,
    remediation: String,
}

pub fn status() -> RuntimeStatus {
    let resolved = resolve_runtime();
    let executable = resolved.as_ref().map(|runtime| runtime.executable.clone());
    let version = executable.as_ref().and_then(read_version);
    let installed = executable.is_some() && version.is_some();
    let commit = executable
        .as_ref()
        .and_then(|path| installed_runtime_commit(path));
    // Compare the commit when one is recorded, and fall back to the version when it is not.
    // The version alone cannot detect pin drift: the runtime's version moves only on release
    // commits, so multiple revisions can report the same version and the check can otherwise
    // pass in exactly the case it exists to catch.
    let version_ok = version
        .as_deref()
        .is_some_and(|value| runtime_version_at_least(value, REQUIRED_RUNTIME_VERSION));
    let current = match commit.as_deref() {
        Some(installed_commit) => version_ok && installed_commit == RUNTIME_INSTALL_REF,
        None => version_ok,
    };
    let install_supported = cfg!(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    ));
    let provider = executable.as_ref().and_then(read_provider_status);
    let provider_status_available = provider.is_some();
    let provider_configured = provider.as_ref().is_some_and(|state| state.configured);
    let provider_message = provider.as_ref().map_or_else(
        || {
            if installed {
                "Update the Amplifier runtime to verify provider setup".to_owned()
            } else {
                "Install the Amplifier runtime first".to_owned()
            }
        },
        |state| {
            if state.configured || state.remediation.is_empty() {
                state.message.clone()
            } else {
                format!("{} · {}", state.message, state.remediation)
            }
        },
    );
    let adapter = resolved
        .as_ref()
        .map_or(RuntimeAdapter::Missing, |runtime| runtime.adapter)
        .as_str()
        .to_owned();
    let message = if installed && current {
        "Amplifier runtime is ready".to_owned()
    } else if installed {
        // Say which identity is wrong. A version-only update message is baffling when the
        // installed runtime already reports the required version -- which is the normal case for
        // pin drift between releases.
        match commit.as_deref() {
            Some(installed_commit) if installed_commit != RUNTIME_INSTALL_REF => format!(
                "Amplifier runtime is pinned to {} but {} is installed; reinstall to update",
                &RUNTIME_INSTALL_REF[..12],
                &installed_commit[..12],
            ),
            _ => format!("Amplifier runtime {REQUIRED_RUNTIME_VERSION} update required"),
        }
    } else if executable.is_some() {
        "The Amplifier runtime was found but did not pass its version check".to_owned()
    } else if install_supported {
        "Amplifier's session runtime is not installed yet".to_owned()
    } else {
        "Use a configured Rust bridge on this platform; local runtime installation is not supported yet"
            .to_owned()
    };
    RuntimeStatus {
        installed,
        current,
        executable: executable.map(|path| path.to_string_lossy().into_owned()),
        version,
        commit,
        adapter,
        install_supported,
        provider_status_available,
        provider_configured,
        provider_message,
        message,
    }
}

pub async fn install() -> Result<RuntimeStatus, String> {
    let current = status();
    if current.installed && current.current && current.provider_status_available {
        return Ok(current);
    }
    if !current.install_supported {
        return Err(
            "Local runtime installation is supported on macOS, Linux, and Windows. Configure an HTTPS Rust bridge for iOS, Android, or web use."
                .to_owned(),
        );
    }

    // Download -> verify -> execute, never fetch-and-pipe: the bytes are checked against a
    // pinned digest before anything is handed to a shell.
    #[cfg(target_os = "windows")]
    let script_name = "install.ps1";
    #[cfg(not(target_os = "windows"))]
    let script_name = "install.sh";
    #[cfg(target_os = "windows")]
    let expected_digest = WINDOWS_INSTALL_SCRIPT_SHA256;
    #[cfg(not(target_os = "windows"))]
    let expected_digest = INSTALL_SCRIPT_SHA256;

    let url = install_script_url(script_name);
    let script = fetch_verified_install_script(&url, expected_digest).await?;
    let script_path = stage_install_script(&script, script_name)?;
    let script_arg = script_path.as_os_str().to_owned();

    #[cfg(target_os = "windows")]
    let output = tokio::process::Command::new("powershell.exe")
        .args([
            OsStr::new("-NoLogo"),
            OsStr::new("-NoProfile"),
            OsStr::new("-NonInteractive"),
            OsStr::new("-ExecutionPolicy"),
            OsStr::new("Bypass"),
            OsStr::new("-File"),
            script_arg.as_os_str(),
            OsStr::new("-Ref"),
            OsStr::new(RUNTIME_INSTALL_REF),
            OsStr::new("-NoUpdateShell"),
        ])
        .output()
        .await
        .map_err(|error| format!("Could not start the Amplifier installer: {error}"))?;
    #[cfg(not(target_os = "windows"))]
    let output = tokio::process::Command::new("bash")
        .args([
            OsStr::new("-o"),
            OsStr::new("pipefail"),
            script_arg.as_os_str(),
            OsStr::new("--ref"),
            OsStr::new(RUNTIME_INSTALL_REF),
            OsStr::new("--no-update-shell"),
        ])
        .output()
        .await
        .map_err(|error| format!("Could not start the Amplifier installer: {error}"))?;
    let _ = std::fs::remove_file(&script_path);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("Amplifier installer exited with {}", output.status)
        } else {
            detail
        });
    }

    let installed = status();
    if installed.installed && installed.current {
        Ok(installed)
    } else {
        Err("The installer finished, but the Amplifier runtime could not be verified. Restart Studio or run its doctor command in a terminal.".to_owned())
    }
}

pub async fn configure_provider(
    provider_type: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<RuntimeStatus, String> {
    let provider_type = provider_type.trim();
    if provider_type.is_empty()
        || provider_type.len() > 100
        || !provider_type
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(
            "Provider type must use letters, numbers, dots, dashes, or underscores".to_owned(),
        );
    }
    let api_key = api_key.trim();
    if api_key.is_empty() || api_key.len() > 16_384 || api_key.chars().any(char::is_control) {
        return Err("Enter a valid provider API key".to_owned());
    }
    let binary = resolve_runtime()
        .map(|runtime| runtime.executable)
        .ok_or_else(|| "Install the Amplifier runtime first".to_owned())?;
    let mut args = vec![
        "provider".to_owned(),
        "add".to_owned(),
        provider_type.to_owned(),
        "--api-key-stdin".to_owned(),
        "--yes".to_owned(),
    ];
    if let Some(model) = clean_option(model, "model")? {
        args.extend(["--model".to_owned(), model]);
    }
    if let Some(base_url) = clean_option(base_url, "base URL")? {
        args.extend(["--base-url".to_owned(), base_url]);
    }

    let mut command = tokio::process::Command::new(&binary);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = runtime_path(&binary) {
        command.env("PATH", path);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start provider setup: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Provider setup stdin is unavailable".to_owned())?;
    stdin
        .write_all(format!("{api_key}\n").as_bytes())
        .await
        .map_err(|error| format!("Could not send the provider credential: {error}"))?;
    drop(stdin);
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("Provider setup did not finish: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("Provider setup exited with {}", output.status)
        } else {
            detail
        });
    }
    let updated = status();
    if updated.provider_configured {
        Ok(updated)
    } else {
        Err(
            "Provider setup finished, but the runtime still reports no configured provider"
                .to_owned(),
        )
    }
}

fn clean_option(value: Option<String>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
    else {
        return Ok(None);
    };
    if value.len() > 2_048 || value.chars().any(char::is_control) {
        return Err(format!("Enter a valid {label}"));
    }
    Ok(Some(value))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeAdapter {
    Neutral,
    Configured,
    Missing,
}

impl RuntimeAdapter {
    fn as_str(self) -> &'static str {
        match self {
            Self::Neutral => "neutral",
            Self::Configured => "configured",
            Self::Missing => "missing",
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedRuntime {
    executable: PathBuf,
    adapter: RuntimeAdapter,
}

pub(crate) fn binary_or_command() -> PathBuf {
    resolve_runtime()
        .map(|runtime| runtime.executable)
        .unwrap_or_else(|| PathBuf::from(NEUTRAL_RUNTIME_BINARY))
}

/// Build a deterministic executable search path for the out-of-process
/// runtime and everything it launches (notably `uv`). Finder and updater
/// restarts do not inherit the user's interactive shell PATH on macOS, even
/// though Studio can still resolve the per-user runtime directly.
/// Keep the runtime binary's own directory first, preserve inherited entries,
/// then add the conventional per-user and platform tool locations.
pub(crate) fn runtime_path(executable: &std::path::Path) -> Option<OsString> {
    runtime_path_from(
        executable,
        env::var_os("PATH").as_deref(),
        dirs::home_dir().as_deref(),
    )
}

fn runtime_path_from(
    executable: &std::path::Path,
    inherited: Option<&OsStr>,
    home: Option<&std::path::Path>,
) -> Option<OsString> {
    let mut directories = Vec::<PathBuf>::new();
    let mut push = |directory: PathBuf| {
        if !directory.as_os_str().is_empty() && !directories.contains(&directory) {
            directories.push(directory);
        }
    };

    if let Some(parent) = executable.parent() {
        push(parent.to_path_buf());
    }
    if let Some(path) = inherited {
        for directory in env::split_paths(path) {
            push(directory);
        }
    }
    if let Some(home) = home {
        push(home.join(".local/bin"));
        push(home.join(".cargo/bin"));
        #[cfg(target_os = "windows")]
        {
            push(home.join("AppData/Local/Programs/Python/Scripts"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        push(PathBuf::from("/opt/homebrew/bin"));
        push(PathBuf::from("/usr/local/bin"));
    }
    #[cfg(unix)]
    for directory in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        push(PathBuf::from(directory));
    }

    env::join_paths(directories).ok()
}

fn resolve_runtime() -> Option<ResolvedRuntime> {
    if let Some(configured) = env::var_os(RUNTIME_BINARY_ENV) {
        let candidate = PathBuf::from(configured);
        if candidate.is_file() {
            return Some(ResolvedRuntime {
                executable: candidate,
                adapter: RuntimeAdapter::Configured,
            });
        }
    }
    if let Some(home) = dirs::home_dir() {
        for (name, adapter) in runtime_candidates() {
            let preferred = home.join(".local/bin").join(name);
            if preferred.is_file() {
                return Some(ResolvedRuntime {
                    executable: preferred,
                    adapter,
                });
            }
        }
    }

    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        for (name, adapter) in runtime_candidates() {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(ResolvedRuntime {
                    executable: candidate,
                    adapter,
                });
            }
        }
    }
    None
}

fn runtime_candidates() -> Vec<(String, RuntimeAdapter)> {
    let suffix = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    vec![(
        format!("{NEUTRAL_RUNTIME_BINARY}{suffix}"),
        RuntimeAdapter::Neutral,
    )]
}

/// The commit the package manager recorded for the installed runtime.
///
/// `amplifier-runtime --version` reports only the release version, which is the same string for
/// every revision between releases, so the binary cannot answer this. A PEP 610 install records the
/// resolved revision in `direct_url.json` beside the dist-info, and both uv and pip write it.
/// Absent (a path install, a wheel from an index) means "unknown", not "wrong".
fn installed_runtime_commit(executable: &Path) -> Option<String> {
    // .../<env>/bin/amplifier-runtime -> .../<env>
    let env_root = executable
        .canonicalize()
        .ok()?
        .parent()?
        .parent()?
        .to_path_buf();
    let site_packages = std::fs::read_dir(env_root.join("lib"))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("site-packages"))
        .find(|path| path.is_dir())?;

    let dist_info = std::fs::read_dir(&site_packages)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("amplifier_runtime-") && name.ends_with(".dist-info")
                })
        })?;

    let raw = std::fs::read_to_string(dist_info.join("direct_url.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let commit = parsed
        .get("vcs_info")?
        .get("commit_id")?
        .as_str()?
        .trim()
        .to_owned();
    (commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit())).then_some(commit)
}

fn read_version(executable: &PathBuf) -> Option<String> {
    let mut command = Command::new(executable);
    command.arg("--version");
    if let Some(path) = runtime_path(executable) {
        command.env("PATH", path);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!version.is_empty()).then_some(version)
}

fn runtime_version_at_least(raw: &str, required: &str) -> bool {
    fn parts(value: &str) -> Option<Vec<u64>> {
        let version = value
            .split_whitespace()
            .last()?
            .trim_start_matches('v')
            .split(['+', '-'])
            .next()?;
        let parsed = version
            .split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        (!parsed.is_empty()).then_some(parsed)
    }

    let Some(mut actual) = parts(raw) else {
        return false;
    };
    let Some(mut minimum) = parts(required) else {
        return false;
    };
    let width = actual.len().max(minimum.len());
    actual.resize(width, 0);
    minimum.resize(width, 0);
    actual >= minimum
}

fn read_provider_status(executable: &PathBuf) -> Option<ProviderStatus> {
    let mut command = Command::new(executable);
    command.args(["provider", "status", "--format", "json"]);
    if let Some(path) = runtime_path(executable) {
        command.env("PATH", path);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_status_never_claims_ready_without_a_version() {
        let runtime = status();
        assert_eq!(
            runtime.installed,
            runtime.executable.is_some() && runtime.version.is_some()
        );
        if !runtime.installed {
            assert!(!runtime.provider_configured);
        }
        // `current` is no longer version-only. A recorded commit must also match the pin,
        // because the runtime's version does not move between releases and so cannot express
        // pin drift at all. An install with no recorded commit still falls back to the version.
        let version_ok = runtime
            .version
            .as_deref()
            .is_some_and(|value| runtime_version_at_least(value, REQUIRED_RUNTIME_VERSION));
        let expected = match runtime.commit.as_deref() {
            Some(commit) => version_ok && commit == RUNTIME_INSTALL_REF,
            None => version_ok,
        };
        assert_eq!(runtime.current, expected);
        if runtime.current {
            assert!(
                version_ok,
                "a ready runtime must still satisfy the version floor"
            );
        }
    }

    #[test]
    fn runtime_version_gate_accepts_required_and_newer_versions() {
        assert!(runtime_version_at_least(
            "amplifier-runtime, version 0.1.10",
            REQUIRED_RUNTIME_VERSION
        ));
        assert!(runtime_version_at_least(
            "amplifier-runtime, version 0.2.0",
            REQUIRED_RUNTIME_VERSION
        ));
        assert!(!runtime_version_at_least(
            "amplifier-runtime, version 0.1.9",
            REQUIRED_RUNTIME_VERSION
        ));
        assert!(!runtime_version_at_least(
            "unknown",
            REQUIRED_RUNTIME_VERSION
        ));
    }

    #[test]
    fn runtime_path_keeps_runtime_and_user_tool_directories_without_duplicates() {
        let runtime_dir = PathBuf::from("runtime-bin");
        let home = PathBuf::from("example-home");
        let inherited =
            env::join_paths([PathBuf::from("system-bin"), runtime_dir.clone()]).expect("test path");
        let path = runtime_path_from(
            &runtime_dir.join(NEUTRAL_RUNTIME_BINARY),
            Some(&inherited),
            Some(&home),
        )
        .expect("runtime path");
        let directories = env::split_paths(&path).collect::<Vec<_>>();

        assert_eq!(directories[0], runtime_dir);
        assert!(directories.contains(&home.join(".local/bin")));
        assert!(directories.contains(&home.join(".cargo/bin")));
        assert_eq!(
            directories
                .iter()
                .filter(|entry| entry.as_os_str() == "runtime-bin")
                .count(),
            1
        );
    }

    #[test]
    fn only_the_neutral_runtime_is_a_discovery_candidate() {
        let candidates = runtime_candidates();
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].0.starts_with(NEUTRAL_RUNTIME_BINARY));
        assert_eq!(candidates[0].1, RuntimeAdapter::Neutral);
    }

    #[test]
    fn runtime_adapter_names_are_stable_transport_values() {
        assert_eq!(RuntimeAdapter::Neutral.as_str(), "neutral");
        assert_eq!(RuntimeAdapter::Configured.as_str(), "configured");
        assert_eq!(RuntimeAdapter::Missing.as_str(), "missing");
    }

    #[test]
    fn installers_pin_the_reviewed_runtime_revision() {
        for file in ["install.sh", "install.ps1"] {
            let url = install_script_url(file);
            assert!(url.starts_with("https://"));
            assert!(url.contains("michaeljabbour/amplifier-runtime"));
            assert!(url.contains(RUNTIME_INSTALL_REF));
            assert!(!url.contains("amplifier-app-tui"));
        }
    }

    /// The bootstrap script must come from an immutable commit, never a branch. A branch URL is
    /// remote code execution on every install the moment that branch changes.
    #[test]
    fn installer_urls_never_reference_a_mutable_branch() {
        for file in ["install.sh", "install.ps1"] {
            let url = install_script_url(file);
            for branch in ["/main/", "/master/", "/HEAD/", "/refs/heads/"] {
                assert!(
                    !url.contains(branch),
                    "{url} resolves through mutable {branch}"
                );
            }
        }
        assert_eq!(RUNTIME_INSTALL_REF.len(), 40);
        assert!(RUNTIME_INSTALL_REF.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// The pin is a commit, so the check has to be a commit.
    ///
    /// REQUIRED_RUNTIME_VERSION cannot stand in for it: the runtime's version only advances on
    /// release commits, so multiple revisions can honestly report the same version. A version
    /// check therefore passes in exactly the situation it exists to catch. Verified against the
    /// real installation on a developer machine, where the guard reported current=false with
    /// the required version and a superseded commit.
    #[test]
    fn a_matching_version_does_not_excuse_a_mismatched_commit() {
        let required = REQUIRED_RUNTIME_VERSION;
        assert!(runtime_version_at_least(
            "amplifier-runtime, version 0.1.10",
            required
        ));

        let superseded = "b9568a25287ddf83ff7aa321aaefdc8ecf30ca52";
        assert_ne!(
            superseded, RUNTIME_INSTALL_REF,
            "fixture must be a revision the pin has moved past",
        );
        // The predicate status() applies: a recorded commit decides, a missing one falls back.
        let current = |commit: Option<&str>, version_ok: bool| match commit {
            Some(installed) => version_ok && installed == RUNTIME_INSTALL_REF,
            None => version_ok,
        };
        assert!(
            !current(Some(superseded), true),
            "same version, older commit must not pass"
        );
        assert!(current(Some(RUNTIME_INSTALL_REF), true));
        assert!(
            current(None, true),
            "an unrecorded commit must not block a valid install"
        );
        assert!(!current(Some(RUNTIME_INSTALL_REF), false));
    }

    #[test]
    fn installer_digests_are_full_sha256_values() {
        let digests = [
            INSTALL_SCRIPT_SHA256,
            #[cfg(target_os = "windows")]
            WINDOWS_INSTALL_SCRIPT_SHA256,
        ];
        for digest in digests {
            assert_eq!(digest.len(), 64, "{digest} is not a SHA-256 hex digest");
            assert!(digest
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        }
    }

    #[test]
    fn hex_digest_matches_known_sha256_vectors() {
        assert_eq!(
            hex_digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex_digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
