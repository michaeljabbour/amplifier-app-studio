use crate::runtime_setup;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, process::Command};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleOption {
    pub name: String,
    pub active: bool,
    pub location: String,
    pub status: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
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
    let cwd = resolve_cwd(project_dir)?;
    let bundles = run_cli(&cwd, &["bundle", "list", "--format", "json"])?;
    let providers = run_cli(&cwd, &["provider", "list", "--format", "json"])?;
    Ok(CapabilityCatalog {
        bundles: parse_json(&bundles, "bundle")?,
        providers: parse_json(&providers, "provider")?,
    })
}

pub fn add_bundle(
    project_dir: Option<String>,
    uri: String,
    name: Option<String>,
) -> Result<CapabilityCatalog, String> {
    let cwd = resolve_cwd(project_dir)?;
    let source = normalize_github_bundle(&uri)?;
    let mut args = vec!["bundle".to_owned(), "add".to_owned(), "--global".to_owned()];
    if let Some(name) = name
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        if name.len() > 100 || name.chars().any(char::is_control) {
            return Err("Bundle name must be 100 characters or fewer".to_owned());
        }
        args.extend(["--name".to_owned(), name]);
    }
    args.push(source);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_cli(&cwd, &refs)?;
    list_catalog(Some(cwd.to_string_lossy().into_owned()))
}

fn resolve_cwd(project_dir: Option<String>) -> Result<PathBuf, String> {
    match project_dir.filter(|value| !value.trim().is_empty()) {
        Some(value) => PathBuf::from(value)
            .canonicalize()
            .map_err(|error| format!("Could not open project directory: {error}")),
        None => std::env::current_dir()
            .map_err(|error| format!("Could not read the current directory: {error}")),
    }
}

fn normalize_github_bundle(uri: &str) -> Result<String, String> {
    let value = uri.trim().trim_end_matches('/');
    let tail = value
        .strip_prefix("git+https://github.com/")
        .or_else(|| value.strip_prefix("https://github.com/"))
        .ok_or_else(|| "Enter a GitHub HTTPS repository URL".to_owned())?;
    if tail.is_empty()
        || tail
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("Enter a valid GitHub repository URL".to_owned());
    }
    let (repository, fragment) = tail
        .split_once('#')
        .map_or((tail, None), |(base, suffix)| (base, Some(suffix)));
    if fragment.is_some_and(|value| {
        !value.starts_with("subdirectory=") || value.len() <= "subdirectory=".len()
    }) {
        return Err("Only a #subdirectory=... fragment is supported".to_owned());
    }
    if repository.contains('?') {
        return Err("Remove query parameters from the GitHub bundle URL".to_owned());
    }
    let slash = repository
        .find('/')
        .ok_or_else(|| "GitHub URL must include an owner and repository".to_owned())?;
    let owner = &repository[..slash];
    let remainder = &repository[slash + 1..];
    let (repo, reference) = remainder
        .split_once('@')
        .map_or((remainder, "main"), |(repo, reference)| (repo, reference));
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if owner.is_empty() || repo.is_empty() || repo.contains('/') || reference.is_empty() {
        return Err(
            "GitHub URL must identify one repository; use #subdirectory=... for a bundle inside it"
                .to_owned(),
        );
    }
    let suffix = fragment
        .map(|value| format!("#{value}"))
        .unwrap_or_default();
    Ok(format!(
        "git+https://github.com/{owner}/{repo}@{reference}{suffix}"
    ))
}

fn run_cli(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let binary = runtime_setup::binary_or_command();
    let mut command = Command::new(&binary);
    command
        .args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("COLUMNS", "5000");
    if let Some(path) = runtime_setup::runtime_path(&binary) {
        command.env("PATH", path);
    }
    let output = command
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

fn parse_json<T: serde::de::DeserializeOwned>(output: &str, kind: &str) -> Result<T, String> {
    serde_json::from_str(output.trim()).map_err(|error| {
        format!(
            "Amplifier returned an invalid {kind} catalog. Update amplifier-tui and retry: {error}"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bundle_json_contract() {
        let rows = r#"[{"name":"anchors","active":false,"location":"/tmp/anchors.md","status":""},{"name":"tui","active":true,"location":"/tmp/tui.md","status":"default"}]"#;
        let parsed: Vec<BundleOption> = parse_json(rows, "bundle").unwrap();
        assert_eq!(parsed.len(), 2);
        assert!(parsed[1].active);
        assert_eq!(parsed[0].name, "anchors");
    }

    #[test]
    fn parses_provider_json_contract() {
        let rows = r#"[{"name":"anthropic","module":"provider-anthropic","model":"claude-opus-5","active":true},{"name":"openai","module":"provider-openai","model":"gpt-5.5","active":false}]"#;
        let parsed: Vec<ProviderOption> = parse_json(rows, "provider").unwrap();
        assert_eq!(parsed[0].model, "claude-opus-5");
        assert!(parsed[0].active);
        assert_eq!(parsed[1].name, "openai");
    }

    #[test]
    fn rejects_human_formatted_catalogs_with_upgrade_guidance() {
        let error = parse_json::<Vec<BundleOption>>("│ ● │ tui │", "bundle").unwrap_err();
        assert!(error.contains("Update amplifier-tui"));
    }

    #[test]
    fn normalizes_friendly_github_bundle_links() {
        assert_eq!(
            normalize_github_bundle("https://github.com/example/amplifier-bundle-demo").unwrap(),
            "git+https://github.com/example/amplifier-bundle-demo@main"
        );
        assert_eq!(
            normalize_github_bundle(
                "git+https://github.com/example/modules@v2#subdirectory=bundles/demo.yaml"
            )
            .unwrap(),
            "git+https://github.com/example/modules@v2#subdirectory=bundles/demo.yaml"
        );
    }

    #[test]
    fn rejects_non_github_bundle_sources() {
        assert!(normalize_github_bundle("https://example.com/bundle").is_err());
        assert!(normalize_github_bundle("https://github.com/example/repo/tree/main").is_err());
    }
}
