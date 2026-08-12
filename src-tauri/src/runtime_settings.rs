use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::process::Command;

const SECTIONS: [&str; 6] = [
    "providers",
    "models-routing",
    "bundles",
    "directory-access",
    "notifications",
    "behavior",
];

const FIELD_PATHS: [&str; 29] = [
    "providers.anthropic.api_key",
    "providers.openai.api_key",
    "providers.azure-openai.api_key",
    "providers.azure-openai.endpoint",
    "providers.gemini.api_key",
    "providers.google.api_key",
    "providers.github-copilot.token",
    "routing.matrix",
    "routing.enabled",
    "tui.bundle.active",
    "bundle.app",
    "tui.bundle.deferred",
    "tui.permissions.write_boundary",
    "tui.permissions.governance",
    "notifications.suppress",
    "notifications.desktop.enabled",
    "notifications.push.enabled",
    "notifications.push.server",
    "notifications.push.priority",
    "notifications.push.tags",
    "notifications.push.topic",
    "context.max_tokens",
    "context.compact_threshold",
    "context.auto_compact",
    "tui.hooks.suppress",
    "tui.pricing.live",
    "tui.resume.use_active_bundle",
    "tui.preflight.verify_provider",
    "tui.preflight.verify_live",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingValue {
    pub path: String,
    pub display: String,
    pub source: String,
    pub source_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingsSnapshot {
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
    let mut values = Vec::with_capacity(FIELD_PATHS.len());
    for section in SECTIONS {
        let output = run(&project, ["settings", "get", section]).await?;
        values.extend(parse_settings_output(&output)?);
    }
    if values.len() != FIELD_PATHS.len()
        || FIELD_PATHS
            .iter()
            .any(|path| !values.iter().any(|value| value.path == *path))
    {
        return Err("The installed amplifier-tui settings registry is incompatible with this Studio release. Update both apps and try again.".to_owned());
    }

    let version = run(&project, ["--version"]).await?;
    let paths_output = run(&project, ["config", "paths", "--json"]).await?;
    let paths = serde_json::from_str(&paths_output)
        .map_err(|error| format!("Could not read Amplifier settings paths: {error}"))?;

    Ok(RuntimeSettingsSnapshot {
        project_dir: project.to_string_lossy().into_owned(),
        values,
        version,
        paths,
        recent_changes: recent_changes(),
    })
}

pub async fn apply(
    project_dir: String,
    changes: Vec<RuntimeSettingChange>,
) -> Result<RuntimeSettingsSnapshot, String> {
    if changes.is_empty() {
        return read(project_dir).await;
    }
    if changes.len() > FIELD_PATHS.len() {
        return Err("Too many settings changes were submitted".to_owned());
    }
    let project = project_directory(&project_dir)?;
    for change in changes {
        if !FIELD_PATHS.contains(&change.path.as_str()) {
            return Err(format!("Unknown Amplifier setting: {}", change.path));
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

async fn run<'a, const N: usize>(project: &Path, args: [&'a str; N]) -> Result<String, String> {
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
        .map_err(|error| format!("Could not start amplifier-tui settings: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("amplifier-tui settings exited with {}", output.status)
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn parse_settings_output(output: &str) -> Result<Vec<RuntimeSettingValue>, String> {
    let mut values = Vec::new();
    let mut lines = output.lines();
    while let Some(line) = lines.next() {
        let Some((path, display)) = line.split_once(" = ") else {
            continue;
        };
        if path.starts_with(char::is_whitespace) {
            continue;
        }
        let source_line = lines
            .next()
            .ok_or_else(|| format!("Missing settings source for {path}"))?;
        let source_label = source_line
            .strip_prefix("  source: ")
            .ok_or_else(|| format!("Invalid settings source for {path}"))?
            .trim()
            .to_owned();
        let source = source_label
            .split_once(' ')
            .map_or(source_label.as_str(), |(name, _)| name)
            .to_owned();
        values.push(RuntimeSettingValue {
            path: path.to_owned(),
            display: display.to_owned(),
            source,
            source_label,
        });
    }
    Ok(values)
}

fn recent_changes() -> Vec<Value> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(contents) = std::fs::read_to_string(home.join(".amplifier/settings-changes.jsonl"))
    else {
        return Vec::new();
    };
    let mut changes = contents
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str(line).ok())
        .take(5)
        .collect::<Vec<_>>();
    changes.reverse();
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_redacted_values_and_provenance() {
        let values = parse_settings_output(
            "providers.anthropic.api_key = configured\n  source: env (ANTHROPIC_API_KEY)\nrouting.matrix = balanced\n  source: default",
        )
        .expect("settings output should parse");
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].display, "configured");
        assert_eq!(values[0].source, "env");
        assert_eq!(values[1].source_label, "default");
    }

    #[test]
    fn rejects_a_non_directory_project_context() {
        let temporary = tempfile::NamedTempFile::new().expect("temporary file");
        let error = project_directory(temporary.path().to_string_lossy().as_ref())
            .expect_err("files are not valid project contexts");
        assert!(error.contains("not a directory"));
    }
}
