use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::Path,
    time::UNIX_EPOCH,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub session_id: String,
    pub name: String,
    pub bundle: String,
    pub model: Option<String>,
    pub tags: Vec<String>,
    pub turn_count: Option<u64>,
    pub message_count: u64,
    pub mtime_ms: u64,
    pub project_slug: String,
    pub project_dir: Option<String>,
    pub state: &'static str,
}

pub fn list_stored_sessions(project_dir: Option<String>) -> Result<Vec<StoredSession>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve the home directory".to_owned())?;
    let projects = home.join(".amplifier/projects");
    if !projects.is_dir() {
        return Ok(Vec::new());
    }

    let project_filter = match project_dir {
        Some(value) if !value.trim().is_empty() => {
            let canonical = Path::new(value.trim()).canonicalize().map_err(|error| {
                format!(
                    "Project directory '{}' is unavailable: {error}",
                    value.trim()
                )
            })?;
            Some(project_slug(&canonical))
        }
        _ => None,
    };
    let directory_hints = project_directory_hints(&projects);

    let mut sessions = Vec::new();
    for project in read_dirs(&projects) {
        let Ok(file_type) = project.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let slug = project.file_name().to_string_lossy().into_owned();
        if project_filter
            .as_deref()
            .is_some_and(|filter| filter != slug)
        {
            continue;
        }
        let sessions_dir = project.path().join("sessions");
        let entries = read_dirs(&sessions_dir);
        let project_dir_hint = directory_hints
            .get(&slug)
            .cloned()
            .or_else(|| infer_project_dir(&entries, &slug));
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let session_id = entry.file_name().to_string_lossy().into_owned();
            if session_id.starts_with('.') || session_id.contains('_') {
                continue;
            }
            sessions.push(summarize(
                &entry.path(),
                session_id,
                slug.clone(),
                project_dir_hint.as_deref(),
            ));
        }
    }
    sessions.sort_by(|left, right| right.mtime_ms.cmp(&left.mtime_ms));
    Ok(sessions)
}

fn summarize(
    session_dir: &Path,
    session_id: String,
    project_slug: String,
    project_dir_hint: Option<&str>,
) -> StoredSession {
    let metadata_path = session_dir.join("metadata.json");
    let metadata_exists = metadata_path.is_file();
    let (metadata, metadata_recovered) = read_json_with_backup(&metadata_path);
    let metadata = metadata.unwrap_or_default();

    let transcript_path = session_dir.join("transcript.jsonl");
    let transcript = read_transcript_with_backup(&transcript_path);
    let transcript_exists = transcript_path.is_file()
        || transcript_path
            .with_file_name("transcript.jsonl.backup")
            .is_file();
    let message_count = transcript.unwrap_or(0);

    let state = if metadata_exists && metadata_recovered {
        "recovered"
    } else if metadata_exists && transcript_exists && transcript.is_none() {
        "transcript_lost"
    } else if !metadata_exists {
        "indexing"
    } else {
        "ok"
    };

    let mtime_ms = fs::metadata(session_dir)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0);

    StoredSession {
        name: string_field(&metadata, "name"),
        bundle: nonempty_string_field(&metadata, "bundle").unwrap_or_else(|| "unknown".to_owned()),
        model: nonempty_string_field(&metadata, "model"),
        tags: string_array_field(&metadata, "tags"),
        turn_count: metadata.get("turn_count").and_then(Value::as_u64),
        project_dir: nonempty_string_field(&metadata, "working_dir")
            .or_else(|| project_dir_hint.map(str::to_owned)),
        session_id,
        message_count,
        mtime_ms,
        project_slug,
        state,
    }
}

fn read_json_with_backup(path: &Path) -> (Option<Map<String, Value>>, bool) {
    let backup = path.with_file_name("metadata.json.backup");
    let mut saw_candidate = false;
    for (index, candidate) in [path, backup.as_path()].into_iter().enumerate() {
        if !candidate.is_file() {
            continue;
        }
        saw_candidate = true;
        let Ok(text) = fs::read_to_string(candidate) else {
            continue;
        };
        let Ok(Value::Object(value)) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        return (Some(value), index == 1);
    }
    (None, saw_candidate)
}

fn read_transcript_with_backup(path: &Path) -> Option<u64> {
    let backup = path.with_file_name("transcript.jsonl.backup");
    let mut saw_candidate = false;
    for candidate in [path, backup.as_path()] {
        if !candidate.is_file() {
            continue;
        }
        saw_candidate = true;
        let Ok(file) = File::open(candidate) else {
            continue;
        };
        let mut count = 0_u64;
        let mut valid = true;
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else {
                valid = false;
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            if serde_json::from_str::<Value>(&line).is_err() {
                valid = false;
                break;
            }
            count = count.saturating_add(1);
        }
        if valid {
            return Some(count);
        }
    }
    if saw_candidate {
        None
    } else {
        Some(0)
    }
}

fn read_dirs(path: &Path) -> Vec<fs::DirEntry> {
    fs::read_dir(path)
        .map(|entries| entries.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

fn project_directory_hints(projects: &Path) -> HashMap<String, String> {
    let mut hints = HashMap::new();
    for entry in read_dirs(projects) {
        let metadata_path = entry.path().join("metadata.json");
        let (metadata, _) = read_json_with_backup(&metadata_path);
        let Some(metadata) = metadata else {
            continue;
        };
        let Some(candidate) = nonempty_string_field(&metadata, "full_path")
            .or_else(|| nonempty_string_field(&metadata, "working_dir"))
        else {
            continue;
        };
        remember_directory_hint(&mut hints, &candidate);
    }
    hints
}

fn infer_project_dir(entries: &[fs::DirEntry], expected_slug: &str) -> Option<String> {
    for entry in entries {
        let metadata_path = entry.path().join("metadata.json");
        let (metadata, _) = read_json_with_backup(&metadata_path);
        let Some(candidate) = metadata
            .as_ref()
            .and_then(|value| nonempty_string_field(value, "working_dir"))
        else {
            continue;
        };
        let path = Path::new(&candidate);
        // Session discovery must remain a metadata-only operation. Probing a
        // historical working directory here can trigger macOS Files & Folders
        // consent for protected locations (Downloads, Desktop, Documents)
        // before the user has chosen to resume that session. The selected
        // directory is validated later by `SessionManager::start`.
        if project_slug(path) == expected_slug {
            return Some(candidate);
        }
    }
    None
}

fn remember_directory_hint(hints: &mut HashMap<String, String>, candidate: &str) {
    let path = Path::new(candidate);
    // Do not stat arbitrary historical workspaces while building the global
    // session drawer. Besides being unnecessary, that would ask macOS for
    // protected-folder access just to render an index.
    hints.insert(project_slug(path), candidate.to_owned());
}

fn project_slug(project_dir: &Path) -> String {
    let mut slug = project_dir
        .to_string_lossy()
        .replace('/', "-")
        .replace('\\', "-")
        .replace(':', "");
    if !slug.starts_with('-') {
        slug.insert(0, '-');
    }
    slug
}

fn string_field(metadata: &Map<String, Value>, field: &str) -> String {
    metadata
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn nonempty_string_field(metadata: &Map<String, Value>, field: &str) -> Option<String> {
    let value = string_field(metadata, field);
    (!value.is_empty()).then_some(value)
}

fn string_array_field(metadata: &Map<String, Value>, field: &str) -> Vec<String> {
    metadata
        .get(field)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn donor_slug_rule_is_preserved() {
        assert_eq!(
            project_slug(Path::new("/Users/me/dev/proj")),
            "-Users-me-dev-proj"
        );
    }

    #[test]
    fn corrupt_transcript_is_detected() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("transcript.jsonl");
        let mut file = File::create(&path).expect("transcript");
        writeln!(file, "not json").expect("write");
        assert_eq!(read_transcript_with_backup(&path), None);
    }

    #[test]
    fn project_registry_recovers_directory_without_probing_the_workspace() {
        let temp = tempfile::tempdir().expect("tempdir");
        let projects = temp.path().join("projects");
        let project = temp.path().join("protected-or-offline-source-project");
        let registry = projects.join("source-project-abc123");
        fs::create_dir_all(&registry).expect("registry");
        fs::write(
            registry.join("metadata.json"),
            serde_json::json!({ "full_path": project }).to_string(),
        )
        .expect("metadata");

        let hints = project_directory_hints(&projects);
        assert_eq!(
            hints.get(&project_slug(&project)),
            Some(&project.to_string_lossy().into_owned())
        );
        assert!(!project.exists(), "the test workspace must remain unprobed");
    }
}
