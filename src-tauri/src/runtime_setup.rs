use serde::Serialize;
use std::{env, path::PathBuf, process::Command};

const INSTALL_COMMAND: &str = "curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/michaeljabbour/amplifier-app-tui/main/scripts/install.sh | bash -s --";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub installed: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub install_supported: bool,
    pub message: String,
}

pub fn status() -> RuntimeStatus {
    let executable = resolve_binary();
    let version = executable.as_ref().and_then(read_version);
    let installed = executable.is_some() && version.is_some();
    let install_supported = cfg!(any(target_os = "macos", target_os = "linux"));
    let message = if installed {
        "Amplifier runtime is ready".to_owned()
    } else if executable.is_some() {
        "amplifier-tui was found but did not pass its version check".to_owned()
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
        install_supported,
        message,
    }
}

pub async fn install() -> Result<RuntimeStatus, String> {
    let current = status();
    if current.installed {
        return Ok(current);
    }
    if !current.install_supported {
        return Err(
            "Local runtime installation is supported on macOS and Linux. Configure an HTTPS Rust bridge for Windows, iOS, Android, or web use."
                .to_owned(),
        );
    }

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
        Err("The installer finished, but amplifier-tui could not be verified. Restart Studio or run amplifier-tui doctor in a terminal.".to_owned())
    }
}

pub(crate) fn binary_or_command() -> PathBuf {
    resolve_binary().unwrap_or_else(|| PathBuf::from("amplifier-tui"))
}

fn resolve_binary() -> Option<PathBuf> {
    if let Some(home) = dirs::home_dir() {
        let preferred = home.join(".local/bin/amplifier-tui");
        if preferred.is_file() {
            return Some(preferred);
        }
        #[cfg(target_os = "windows")]
        {
            let preferred_exe = home.join(".local/bin/amplifier-tui.exe");
            if preferred_exe.is_file() {
                return Some(preferred_exe);
            }
        }
    }

    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        let candidate = directory.join("amplifier-tui");
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "windows")]
        {
            let candidate_exe = directory.join("amplifier-tui.exe");
            if candidate_exe.is_file() {
                return Some(candidate_exe);
            }
        }
    }
    None
}

fn read_version(executable: &PathBuf) -> Option<String> {
    let output = Command::new(executable).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!version.is_empty()).then_some(version)
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
    }
}
