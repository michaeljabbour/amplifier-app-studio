use crate::runtime_setup;
use serde::Serialize;
use std::{path::PathBuf, process::Command};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleOption {
    pub name: String,
    pub active: bool,
    pub location: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOption {
    pub name: String,
    pub module: String,
    pub model: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityCatalog {
    pub bundles: Vec<BundleOption>,
    pub providers: Vec<ProviderOption>,
}

pub fn list_catalog(project_dir: Option<String>) -> Result<CapabilityCatalog, String> {
    let cwd = match project_dir.filter(|value| !value.trim().is_empty()) {
        Some(value) => PathBuf::from(value)
            .canonicalize()
            .map_err(|error| format!("Could not open project directory: {error}"))?,
        None => std::env::current_dir()
            .map_err(|error| format!("Could not read the current directory: {error}"))?,
    };
    let bundles = run_cli(&cwd, &["bundle", "list"])?;
    let providers = run_cli(&cwd, &["provider", "list"])?;
    Ok(CapabilityCatalog {
        bundles: parse_bundles(&bundles),
        providers: parse_providers(&providers),
    })
}

fn run_cli(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let binary = runtime_setup::binary_or_command();
    let output = Command::new(&binary)
        .args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("COLUMNS", "200")
        .output()
        .map_err(|error| format!("Could not run {}: {error}", binary.display()))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("{} {} failed", binary.display(), args.join(" "))
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_bundles(output: &str) -> Vec<BundleOption> {
    output
        .lines()
        .filter_map(|line| {
            if !line.starts_with('│') {
                return None;
            }
            let columns: Vec<_> = line.split('│').map(str::trim).collect();
            let name = columns.get(2).copied().unwrap_or_default();
            if name.is_empty() || name == "Name" {
                return None;
            }
            Some(BundleOption {
                name: name.to_owned(),
                active: columns.get(1).is_some_and(|value| value.contains('●')),
                location: columns.get(3).copied().unwrap_or_default().to_owned(),
                status: columns.get(4).copied().unwrap_or_default().to_owned(),
            })
        })
        .collect()
}

fn parse_providers(output: &str) -> Vec<ProviderOption> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || !trimmed.contains('·') {
                return None;
            }
            let active = trimmed.starts_with('★');
            let clean = trimmed.trim_start_matches('★').trim();
            let parts: Vec<_> = clean.split('·').map(str::trim).collect();
            let name = parts.first().copied().unwrap_or_default();
            let module = parts.get(1).copied().unwrap_or_default();
            let tail = parts.last().copied().unwrap_or_default();
            let model = tail
                .rsplit_once('(')
                .and_then(|(_, suffix)| suffix.strip_suffix(')'))
                .unwrap_or_default();
            if name.is_empty() {
                return None;
            }
            Some(ProviderOption {
                name: name.to_owned(),
                module: module.to_owned(),
                model: model.to_owned(),
                active,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bundle_table_rows() {
        let rows = "│   │ anchors │ /tmp/anchors.md │ │\n│ ● │ tui │ /tmp/tui.md │ default │";
        let parsed = parse_bundles(rows);
        assert_eq!(parsed.len(), 2);
        assert!(parsed[1].active);
        assert_eq!(parsed[0].name, "anchors");
    }

    #[test]
    fn parses_provider_matrix_rows() {
        let rows = "★ anthropic · provider-anthropic · pri 1 · global (claude-opus-5)\n  openai · provider-openai · pri 2 · global (gpt-5.5)";
        let parsed = parse_providers(rows);
        assert_eq!(parsed[0].model, "claude-opus-5");
        assert!(parsed[0].active);
        assert_eq!(parsed[1].name, "openai");
    }
}
