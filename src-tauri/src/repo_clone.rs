use reqwest::Url;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

const CLONE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const CLONE_BUSY: &str =
    "Another repository clone is already running. Wait for it to finish, then try again.";
static CLONE_SLOT: Semaphore = Semaphore::const_new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubRepository {
    owner: String,
    name: String,
    clone_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRepositoryResult {
    pub path: String,
    pub repository: String,
}

pub fn local_dev_workspace() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Studio could not locate your home folder".to_owned())?;
    let dev = home.join("dev");
    std::fs::create_dir_all(&dev).map_err(|error| {
        format!(
            "Could not create the dev workspace '{}': {error}",
            dev.display()
        )
    })?;
    dev.canonicalize().map_err(|error| {
        format!(
            "Could not open the dev workspace '{}': {error}",
            dev.display()
        )
    })
}

/// Select the configured `dev` workspace for a remote host. Host cloning never
/// guesses outside the explicit project-root allowlist.
pub fn configured_dev_workspace(
    _default_project_dir: &str,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "Amplifier Host could not locate its home folder".to_owned())?;
    configured_dev_workspace_at(&home, allowed_roots)
}

fn configured_dev_workspace_at(home: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let dev = home
        .join("dev")
        .canonicalize()
        .map_err(|error| format!("Could not open the host's ~/dev workspace: {error}"))?;
    if allowed_roots.iter().any(|root| dev.starts_with(root)) {
        return Ok(dev);
    }

    Err(
        "This host has no authorized dev workspace. Add ~/dev as an Amplifier Host project root before cloning."
            .to_owned(),
    )
}

pub async fn clone_github_repository_into(
    repository_url: &str,
    dev_workspace: &Path,
) -> Result<CloneRepositoryResult, String> {
    let repository = parse_github_repository(repository_url)?;
    let _clone_slot = CLONE_SLOT
        .try_acquire()
        .map_err(|_| CLONE_BUSY.to_owned())?;
    let parent = dev_workspace
        .canonicalize()
        .map_err(|error| format!("Could not open the dev workspace: {error}"))?;
    if !parent.is_dir() {
        return Err("The configured dev workspace is not a directory".to_owned());
    }
    let target = parent.join(&repository.name);
    if !target.starts_with(&parent) {
        return Err("The repository destination falls outside the dev workspace".to_owned());
    }
    if target.exists() {
        return Err(format!(
            "'{}' already exists in the dev workspace. Choose it as an existing project instead.",
            repository.name
        ));
    }
    std::fs::create_dir(&target).map_err(|error| {
        format!(
            "Could not reserve '{}' in the dev workspace: {error}",
            repository.name
        )
    })?;

    let mut command = Command::new("git");
    command
        .args(clone_args(&repository.clone_url))
        .arg(&target)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| {
        let detail = if error.kind() == std::io::ErrorKind::NotFound {
            "Git is not installed on this compute host. Install Git, then try the clone again."
                .to_owned()
        } else {
            format!("Could not start Git: {error}")
        };
        format!(
            "{detail}. The incomplete directory remains at '{}' so Studio never deletes project files automatically.",
            target.display()
        )
    })?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Studio could not read Git's error output".to_owned())?;
    let clone = async {
        let (status, stderr) = tokio::join!(child.wait(), read_bounded_stderr(stderr));
        status
            .map(|status| (status, stderr))
            .map_err(|error| format!("Could not wait for Git: {error}"))
    };
    let completed = match timeout(CLONE_TIMEOUT, clone).await {
        Ok(result) => result,
        Err(_) => {
            let _ = timeout(Duration::from_secs(5), async {
                let _ = child.kill().await;
                let _ = child.wait().await;
            })
            .await;
            Err("Cloning timed out after 10 minutes".to_owned())
        }
    };

    let result = match completed {
        Ok((status, _)) if status.success() => Ok(()),
        Ok((_, stderr)) => {
            let detail = concise_git_error(&stderr);
            Err(if detail.is_empty() {
                format!(
                    "Git could not clone {}/{}",
                    repository.owner, repository.name
                )
            } else {
                format!(
                    "Git could not clone {}/{}: {detail}",
                    repository.owner, repository.name
                )
            })
        }
        Err(error) => Err(error),
    };

    result.map_err(|error| {
        format!(
            "{error}. The incomplete directory remains at '{}' so Studio never deletes project files automatically.",
            target.display()
        )
    })?;
    if !target.join(".git").is_dir() {
        return Err(format!(
            "Git reported success, but the cloned repository at '{}' is incomplete",
            target.display()
        ));
    }

    Ok(CloneRepositoryResult {
        path: target.to_string_lossy().into_owned(),
        repository: format!("{}/{}", repository.owner, repository.name),
    })
}

fn parse_github_repository(value: &str) -> Result<GithubRepository, String> {
    if value != value.trim() || value.chars().any(char::is_control) {
        return Err("Remove whitespace or control characters from the GitHub URL.".to_owned());
    }
    let url = Url::parse(value).map_err(|_| {
        "Enter a GitHub repository URL such as https://github.com/owner/repository".to_owned()
    })?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Use a plain HTTPS GitHub repository URL without credentials, a port, query, or fragment."
                .to_owned(),
        );
    }
    let segments = url
        .path_segments()
        .ok_or_else(|| "The GitHub URL has no repository path".to_owned())?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err(
            "Use the repository URL itself, not a branch, issue, file, or organization page."
                .to_owned(),
        );
    }
    let owner = segments[0];
    let name = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if !valid_owner(owner) || !valid_repository_name(name) {
        return Err("The GitHub owner or repository name is invalid".to_owned());
    }
    Ok(GithubRepository {
        owner: owner.to_owned(),
        name: name.to_owned(),
        clone_url: format!("https://github.com/{owner}/{name}.git"),
    })
}

fn valid_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 39
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_repository_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn clone_args(url: &str) -> Vec<&str> {
    vec!["clone", "--quiet", "--", url]
}

fn concise_git_error(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .trim()
        .chars()
        .take(1200)
        .collect()
}

async fn read_bounded_stderr(mut stderr: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
    const LIMIT: usize = 16 * 1024;
    let mut captured = Vec::with_capacity(LIMIT);
    let mut chunk = [0_u8; 8192];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = LIMIT.saturating_sub(captured.len());
                captured.extend_from_slice(&chunk[..read.min(remaining)]);
            }
        }
    }
    captured
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_plain_github_repository_urls() {
        let repository =
            parse_github_repository("https://github.com/microsoft/amplifier.git").unwrap();
        assert_eq!(repository.owner, "microsoft");
        assert_eq!(repository.name, "amplifier");
        assert_eq!(
            repository.clone_url,
            "https://github.com/microsoft/amplifier.git"
        );

        for invalid in [
            " https://github.com/microsoft/amplifier",
            "git@github.com:microsoft/amplifier.git",
            "http://github.com/microsoft/amplifier",
            "https://user:secret@github.com/microsoft/amplifier",
            "https://github.com/microsoft/amplifier/tree/main",
            "https://github.com/microsoft/amplifier?tab=readme",
            "https://gitlab.com/microsoft/amplifier",
            "https://github.com/microsoft/../amplifier",
        ] {
            assert!(
                parse_github_repository(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[tokio::test]
    async fn stderr_capture_is_bounded_while_fully_draining() {
        let input = vec![b'x'; 128 * 1024];
        let captured = read_bounded_stderr(std::io::Cursor::new(input)).await;
        assert_eq!(captured.len(), 16 * 1024);
    }

    #[test]
    fn clone_argv_is_literal_and_option_terminated() {
        assert_eq!(
            clone_args("https://github.com/microsoft/amplifier.git"),
            [
                "clone",
                "--quiet",
                "--",
                "https://github.com/microsoft/amplifier.git"
            ]
        );
    }

    #[test]
    fn remote_clone_requires_an_authorized_dev_workspace() {
        let root = tempfile::tempdir().unwrap();
        let dev = root.path().join("dev");
        std::fs::create_dir(&dev).unwrap();
        let canonical = dev.canonicalize().unwrap();
        assert_eq!(
            configured_dev_workspace_at(root.path(), std::slice::from_ref(&canonical)).unwrap(),
            canonical
        );

        let other = tempfile::tempdir().unwrap();
        assert!(
            configured_dev_workspace_at(root.path(), &[other.path().canonicalize().unwrap()])
                .is_err()
        );
    }

    #[tokio::test]
    async fn refuses_to_overwrite_an_existing_destination() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("amplifier")).unwrap();
        let error =
            clone_github_repository_into("https://github.com/microsoft/amplifier", root.path())
                .await
                .unwrap_err();
        assert!(error.contains("already exists"));
        assert!(root.path().join("amplifier").is_dir());
    }
}
