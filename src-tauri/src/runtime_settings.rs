use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingValue {
    pub path: String,
    pub display: String,
    pub source: String,
    pub source_label: String,
    pub source_file: Option<String>,
    pub applies: String,
    pub remote_writable: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingsSnapshot {
    pub schema_version: u16,
    #[serde(rename = "type")]
    pub record_type: String,
    pub project_dir: String,
    pub values: Vec<RuntimeSettingValue>,
    pub version: String,
    pub paths: Value,
    pub recent_changes: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingChange {
    pub path: String,
    pub action: String,
    pub value: Option<String>,
    pub scope: String,
}

pub async fn read(project_dir: String) -> Result<RuntimeSettingsSnapshot, String> {
    let project = project_directory(&project_dir)?;
    let output = run(&project, ["settings", "get", "--json"]).await?;
    let snapshot: RuntimeSettingsSnapshot = serde_json::from_str(&output)
        .map_err(|error| format!("Could not read Runtime's settings snapshot: {error}"))?;
    if snapshot.schema_version != 1 || snapshot.record_type != "settings.values" {
        return Err("The installed Amplifier runtime settings protocol is incompatible with this Studio release. Update both components and try again.".to_owned());
    }
    if Path::new(&snapshot.project_dir) != project {
        return Err("Runtime returned settings for a different project directory".to_owned());
    }
    Ok(snapshot)
}

pub async fn apply(
    project_dir: String,
    changes: Vec<RuntimeSettingChange>,
) -> Result<RuntimeSettingsSnapshot, String> {
    if changes.is_empty() {
        return read(project_dir).await;
    }
    let project = project_directory(&project_dir)?;
    let snapshot = read(project.to_string_lossy().into_owned()).await?;
    if changes.len() > snapshot.values.len() {
        return Err("Too many settings changes were submitted".to_owned());
    }
    let fields = snapshot
        .values
        .iter()
        .map(|value| (value.path.as_str(), value.remote_writable))
        .collect::<HashMap<_, _>>();
    for change in changes {
        match fields.get(change.path.as_str()) {
            None => return Err(format!("Unknown Amplifier setting: {}", change.path)),
            Some(false) => {
                return Err(format!(
                    "{} is host-only and cannot be changed through a remote client",
                    change.path
                ))
            }
            Some(true) => {}
        }
        let scope = match change.scope.as_str() {
            "global" => "--global",
            "project" => "--project",
            "local" => "--local",
            _ => return Err("Settings scope must be global, project, or local".to_owned()),
        };
        match change.action.as_str() {
            "set" => {
                let value = change
                    .value
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| format!("Enter a value for {}", change.path))?;
                if value.len() > 65_536 || value.contains('\0') {
                    return Err(format!("The value for {} is not valid", change.path));
                }
                run_owned(
                    &project,
                    vec![
                        "settings".to_owned(),
                        "set".to_owned(),
                        change.path,
                        value,
                        scope.to_owned(),
                    ],
                )
                .await?;
            }
            "unset" => {
                run_owned(
                    &project,
                    vec![
                        "settings".to_owned(),
                        "unset".to_owned(),
                        change.path,
                        scope.to_owned(),
                    ],
                )
                .await?;
            }
            _ => return Err("Settings action must be set or unset".to_owned()),
        }
    }
    read(project.to_string_lossy().into_owned()).await
}

fn project_directory(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose a project folder before editing Amplifier settings".to_owned());
    }
    let path = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|error| format!("Could not open the settings project folder: {error}"))?;
    if !path.is_dir() {
        return Err("The settings project folder is not a directory".to_owned());
    }
    Ok(path)
}

async fn run<const N: usize>(project: &Path, args: [&str; N]) -> Result<String, String> {
    run_owned(project, args.into_iter().map(str::to_owned).collect()).await
}

async fn run_owned(project: &Path, args: Vec<String>) -> Result<String, String> {
    let binary = crate::runtime_setup::binary_or_command();
    let mut command = Command::new(&binary);
    command.args(&args).current_dir(project);
    if let Some(path) = crate::runtime_setup::runtime_path(&binary) {
        command.env("PATH", path);
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("Could not start Amplifier runtime settings: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("Amplifier runtime settings exited with {}", output.status)
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runtime_owned_redacted_snapshot() {
        let snapshot: RuntimeSettingsSnapshot = serde_json::from_str(
            r#"{"schemaVersion":1,"type":"settings.values","projectDir":"/tmp/project","values":[{"path":"providers.anthropic.api_key","display":"configured","source":"env","sourceLabel":"env (ANTHROPIC_API_KEY)","sourceFile":null,"applies":"next-session","remoteWritable":false}],"version":"0.1.6","paths":{},"recentChanges":[]}"#,
        )
        .expect("Runtime snapshot should parse");
        assert_eq!(snapshot.schema_version, 1);
        assert_eq!(snapshot.values[0].display, "configured");
        assert_eq!(snapshot.values[0].source, "env");
        assert!(!snapshot.values[0].remote_writable);
    }

    #[test]
    fn rejects_a_non_directory_project_context() {
        let temporary = tempfile::NamedTempFile::new().expect("temporary file");
        let error = project_directory(temporary.path().to_string_lossy().as_ref())
            .expect_err("files are not valid project contexts");
        assert!(error.contains("not a directory"));
    }
}
