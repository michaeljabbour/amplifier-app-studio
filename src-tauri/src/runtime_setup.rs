use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::{OsStr, OsString},
    path::PathBuf,
    process::{Command, Stdio},
};
use tokio::io::AsyncWriteExt;

#[cfg(test)]
const RUNTIME_INSTALL_REF: &str = "4388bf981b416a53e6baff771e6b3e6c1b76f068";
const INSTALL_COMMAND: &str = "curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/michaeljabbour/amplifier-runtime/main/scripts/install.sh | bash -s -- --ref 4388bf981b416a53e6baff771e6b3e6c1b76f068 --no-update-shell";
const RUNTIME_BINARY_ENV: &str = "AMPLIFIER_STUDIO_RUNTIME_BIN";
const NEUTRAL_RUNTIME_BINARY: &str = "amplifier-runtime";
#[cfg(target_os = "windows")]
const WINDOWS_INSTALL_COMMAND: &str = "$ErrorActionPreference='Stop'; $script=Invoke-RestMethod -UseBasicParsing 'https://raw.githubusercontent.com/michaeljabbour/amplifier-runtime/main/scripts/install.ps1'; & ([scriptblock]::Create($script)) -Ref '4388bf981b416a53e6baff771e6b3e6c1b76f068' -NoUpdateShell";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
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
    let message = if installed {
        "Amplifier runtime is ready".to_owned()
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
        executable: executable.map(|path| path.to_string_lossy().into_owned()),
        version,
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
    if current.installed && current.provider_status_available {
        return Ok(current);
    }
    if !current.install_supported {
        return Err(
            "Local runtime installation is supported on macOS, Linux, and Windows. Configure an HTTPS Rust bridge for iOS, Android, or web use."
                .to_owned(),
        );
    }

    #[cfg(target_os = "windows")]
    let output = tokio::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_INSTALL_COMMAND,
        ])
        .output()
        .await
        .map_err(|error| format!("Could not start the Amplifier installer: {error}"))?;
    #[cfg(not(target_os = "windows"))]
    let output = tokio::process::Command::new("bash")
        .args(["-o", "pipefail", "-c", INSTALL_COMMAND])
        .output()
        .await
        .map_err(|error| format!("Could not start the Amplifier installer: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("Amplifier installer exited with {}", output.status)
        } else {
            detail
        });
    }

    let installed = status();
    if installed.installed {
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
        assert!(INSTALL_COMMAND.contains("michaeljabbour/amplifier-runtime"));
        assert!(INSTALL_COMMAND.contains(RUNTIME_INSTALL_REF));
        assert!(!INSTALL_COMMAND.contains("amplifier-app-tui"));
        #[cfg(target_os = "windows")]
        {
            assert!(WINDOWS_INSTALL_COMMAND.contains("michaeljabbour/amplifier-runtime"));
            assert!(WINDOWS_INSTALL_COMMAND.contains(RUNTIME_INSTALL_REF));
            assert!(!WINDOWS_INSTALL_COMMAND.contains("amplifier-app-tui"));
        }
    }
}
