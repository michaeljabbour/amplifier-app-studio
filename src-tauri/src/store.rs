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
    pub summary: String,
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
    sessions.sort_by_key(|session| std::cmp::Reverse(session.mtime_ms));
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
    let transcript_scan = scan_transcript_with_backup(&transcript_path);
    let transcript = transcript_scan.as_ref().map(|scan| scan.count);
    let transcript_summary = transcript_scan.map(|scan| scan.summary).unwrap_or_default();
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

    let stored_name = string_field(&metadata, "name");
    let name = if stored_name.trim().is_empty() {
        friendly_title(transcript_summary.first_user.as_deref(), &project_slug)
    } else {
        stored_name
    };
    let project_dir = nonempty_string_field(&metadata, "working_dir")
        .or_else(|| project_dir_hint.map(str::to_owned));
    let summary = friendly_summary(
        transcript_summary.last_assistant.as_deref(),
        turn_count_from(&metadata),
        message_count,
        project_dir.as_deref(),
    );

    StoredSession {
        name,
        bundle: nonempty_string_field(&metadata, "bundle").unwrap_or_else(|| "unknown".to_owned()),
        model: nonempty_string_field(&metadata, "model"),
        tags: string_array_field(&metadata, "tags"),
        turn_count: turn_count_from(&metadata),
        project_dir,
        session_id,
        message_count,
        mtime_ms,
        project_slug,
        state,
        summary,
    }
}

#[derive(Default)]
struct TranscriptSummary {
    first_user: Option<String>,
    last_assistant: Option<String>,
}

struct TranscriptScan {
    count: u64,
    summary: TranscriptSummary,
}

fn scan_transcript_with_backup(path: &Path) -> Option<TranscriptScan> {
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
        let mut summary = TranscriptSummary::default();
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
            let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) else {
                valid = false;
                break;
            };
            count = count.saturating_add(1);
            let Some(role) = record.get("role").and_then(Value::as_str) else {
                continue;
            };
            let Some(text) = readable_content(record.get("content")) else {
                continue;
            };
            if role == "user" && summary.first_user.is_none() && user_visible_prompt(&text) {
                summary.first_user = Some(text);
            } else if role == "assistant" {
                summary.last_assistant = Some(text);
            }
        }
        if valid {
            return Some(TranscriptScan { count, summary });
        }
    }
    if saw_candidate {
        None
    } else {
        Some(TranscriptScan {
            count: 0,
            summary: TranscriptSummary::default(),
        })
    }
}

#[cfg(test)]
fn read_transcript_summary(path: &Path) -> TranscriptSummary {
    scan_transcript_with_backup(path)
        .map(|scan| scan.summary)
        .unwrap_or_default()
}

fn readable_content(content: Option<&Value>) -> Option<String> {
    let raw = match content? {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                let object = block.as_object()?;
                let kind = object
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !matches!(kind, "text" | "output_text") {
                    return None;
                }
                object
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let clean = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (!clean.is_empty()).then_some(clean)
}

fn friendly_title(first_user: Option<&str>, project_slug: &str) -> String {
    if let Some(prompt) = first_user {
        let clean = humanize(prompt)
            .trim_start_matches(|character: char| !character.is_alphanumeric())
            .split_whitespace()
            .take(8)
            .collect::<Vec<_>>()
            .join(" ");
        if !clean.is_empty() {
            return capitalize_first(&sentence_fragment(&clean, 58));
        }
    }
    let project = project_slug.trim_start_matches('-').replace('-', " ");
    if project.trim().is_empty() {
        "Untitled Amplifier run".to_owned()
    } else {
        format!("Work in {}", sentence_fragment(&project, 42))
    }
}

fn friendly_summary(
    last_assistant: Option<&str>,
    turn_count: Option<u64>,
    message_count: u64,
    project_dir: Option<&str>,
) -> String {
    let location = project_dir
        .and_then(|path| Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty());
    let progress = match turn_count {
        Some(turns) if turns > 0 => format!(
            "{turns} {} saved",
            if turns == 1 { "turn" } else { "turns" }
        ),
        _ if message_count > 0 => format!("{message_count} transcript messages saved"),
        _ => "Saved run".to_owned(),
    };
    let progress = location.map_or(progress.clone(), |project| {
        format!("{progress} in {project}")
    });
    if let Some(last) = last_assistant {
        let update = sentence_fragment(&humanize(last), 140);
        return format!(
            "Last update: {}. {progress}.",
            update.trim_end_matches(['.', '!', '?'])
        );
    }
    match (turn_count, message_count) {
        (Some(turns), _) if turns > 0 => format!(
            "Paused after {turns} {}. Resume to continue where Amplifier left off.",
            if turns == 1 { "turn" } else { "turns" }
        ),
        (_, messages) if messages > 0 => {
            format!("{messages} transcript messages saved. Resume to continue.")
        }
        _ => "Ready to continue this saved run.".to_owned(),
    }
}

fn user_visible_prompt(value: &str) -> bool {
    let normalized = value.trim_start().to_ascii_lowercase();
    !normalized.starts_with("<system-reminder")
        && !normalized.starts_with("system-reminder")
        && !normalized.contains("amplifier-studio-project-plan\">")
}

fn humanize(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if matches!(character, '*' | '`' | '#' | '_' | '<' | '>') {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn capitalize_first(value: &str) -> String {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    first.to_uppercase().chain(characters).collect()
}

fn sentence_fragment(value: &str, max_chars: usize) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() <= max_chars {
        return clean;
    }
    let shortened = clean
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    format!("{}…", shortened.trim_end())
}

fn turn_count_from(metadata: &Map<String, Value>) -> Option<u64> {
    metadata.get("turn_count").and_then(Value::as_u64)
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

#[cfg(test)]
fn read_transcript_with_backup(path: &Path) -> Option<u64> {
    scan_transcript_with_backup(path).map(|scan| scan.count)
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
        .replace(['/', '\\'], "-")
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
    fn unnamed_sessions_get_a_readable_title_and_last_response_summary() {
        let temp = tempfile::tempdir().expect("tempdir");
        let transcript = temp.path().join("transcript.jsonl");
        fs::write(
            &transcript,
            concat!(
                "{\"role\":\"user\",\"content\":\"Audit the release process and fix the updater\"}\n",
                "{\"role\":\"assistant\",\"content\":\"The updater is repaired. The remaining release blocker is Apple notarization.\"}\n"
            ),
        )
        .expect("transcript");
        let summary = read_transcript_summary(&transcript);
        assert_eq!(
            friendly_title(summary.first_user.as_deref(), "-Users-me-project"),
            "Audit the release process and fix the updater"
        );
        assert_eq!(
            friendly_summary(
                summary.last_assistant.as_deref(),
                Some(2),
                4,
                Some("/Users/me/amplifier-app-studio")
            ),
            "Last update: The updater is repaired. The remaining release blocker is Apple notarization. 2 turns saved in amplifier-app-studio."
        );
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
