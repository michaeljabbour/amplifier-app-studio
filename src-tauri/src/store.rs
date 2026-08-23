use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File},
    hash::{DefaultHasher, Hash, Hasher},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SESSION_EXPORT_SCHEMA: &str = "amplifier-tui/session-export/v1";
const SESSION_EXPORT_SCHEMA_PREFIX: &str = "amplifier-tui/session-export/";
const SESSION_SEARCH_TEXT_LIMIT: usize = 8 * 1024;
const SESSION_SEARCH_HEAD_LIMIT: usize = 2 * 1024;
// v3 rebuilds indexes with durable event counts/signatures so a session whose
// visual ledger changes can never keep a stale cached summary.
const SESSION_INDEX_CACHE_VERSION: u8 = 3;
const SESSION_INDEX_CACHE_FILE: &str = ".studio-session-index-v3.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub session_id: String,
    pub name: String,
    pub bundle: String,
    pub model: Option<String>,
    pub tags: Vec<String>,
    pub turn_count: Option<u64>,
    pub message_count: u64,
    pub event_count: u64,
    pub mtime_ms: u64,
    pub project_slug: String,
    pub project_dir: Option<String>,
    pub state: String,
    pub summary: String,
    #[serde(default)]
    pub search_text: String,
}

#[derive(Default, Serialize, Deserialize)]
struct SessionIndexCache {
    version: u8,
    entries: HashMap<String, CachedStoredSession>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CachedStoredSession {
    signature: u64,
    session: StoredSession,
}

fn projects_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve the home directory".to_owned())?;
    Ok(home.join(".amplifier/projects"))
}

pub fn list_stored_sessions(project_dir: Option<String>) -> Result<Vec<StoredSession>, String> {
    let projects = projects_root()?;
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
    Ok(list_stored_sessions_from(
        &projects,
        project_filter.as_deref(),
        None,
    ))
}

/// List every stored session whose project is the authorized root itself or a
/// descendant of it. Runtime hosts expose roots such as `/home/me/dev`; their
/// durable sessions are stored per concrete project below that root rather
/// than in the root's own project bucket.
pub fn list_stored_sessions_for_roots(roots: &[PathBuf]) -> Result<Vec<StoredSession>, String> {
    Ok(list_stored_sessions_for_roots_from(
        &projects_root()?,
        roots,
    ))
}

fn list_stored_sessions_for_roots_from(projects: &Path, roots: &[PathBuf]) -> Vec<StoredSession> {
    if roots.is_empty() {
        return Vec::new();
    }
    let root_slugs = roots
        .iter()
        .map(|root| project_slug(root))
        .collect::<Vec<_>>();
    list_stored_sessions_from(projects, None, Some(&root_slugs))
}

fn list_stored_sessions_from(
    projects: &Path,
    project_filter: Option<&str>,
    allowed_root_slugs: Option<&[String]>,
) -> Vec<StoredSession> {
    if !projects.is_dir() {
        return Vec::new();
    }
    let directory_hints = project_directory_hints(projects);

    let cache = read_session_index_cache(projects);
    let mut tasks = Vec::new();
    for project in read_dirs(projects) {
        let Ok(file_type) = project.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let slug = project.file_name().to_string_lossy().into_owned();
        if project_filter.is_some_and(|filter| filter != slug) {
            continue;
        }
        if allowed_root_slugs
            .is_some_and(|roots| !roots.iter().any(|root| slug_is_within_root(&slug, root)))
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
            tasks.push((
                entry.path(),
                session_id,
                slug.clone(),
                project_dir_hint.clone(),
            ));
        }
    }
    let mut scanned = tasks
        .into_par_iter()
        .map(
            |(session_dir, session_id, project_slug, project_dir_hint)| {
                // Sampled BEFORE the directory is read, and carried through to the cache write.
                // Re-sampling it at write time paired a post-read signature with a pre-read
                // summary, so an append that landed mid-scan was recorded as already-seen and
                // the stale summary then satisfied every later listing, permanently.
                let signature = session_signature(&session_dir);
                let key = session_cache_key(&project_slug, &session_id);
                if let Some(cached) = cache
                    .entries
                    .get(&key)
                    .filter(|cached| cached.signature == signature)
                {
                    let mut session = cached.session.clone();
                    if session.project_dir.is_none() {
                        session.project_dir = project_dir_hint;
                    }
                    return (key, signature, session);
                }
                let session = summarize(
                    &session_dir,
                    session_id,
                    project_slug,
                    project_dir_hint.as_deref(),
                );
                (key, signature, session)
            },
        )
        .collect::<Vec<_>>();
    scanned.sort_by_key(|(_, _, session)| std::cmp::Reverse(session.mtime_ms));
    write_session_index_cache(projects, &scanned);
    scanned.into_iter().map(|(_, _, session)| session).collect()
}

fn slug_is_within_root(project_slug: &str, root_slug: &str) -> bool {
    project_slug == root_slug
        || if root_slug.ends_with('-') {
            project_slug.starts_with(root_slug)
        } else {
            project_slug.starts_with(&format!("{root_slug}-"))
        }
}

fn session_cache_key(project_slug: &str, session_id: &str) -> String {
    format!("{project_slug}\0{session_id}")
}

fn session_signature(session_dir: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    for path in [
        session_dir.to_path_buf(),
        session_dir.join("metadata.json"),
        session_dir.join("metadata.json.backup"),
        session_dir.join("transcript.jsonl"),
        session_dir.join("transcript.jsonl.backup"),
        session_dir.join("events.jsonl"),
        session_dir.join("ui-events.jsonl"),
    ] {
        path.file_name().hash(&mut hasher);
        match fs::metadata(path) {
            Ok(metadata) => {
                metadata.len().hash(&mut hasher);
                metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos())
                    .hash(&mut hasher);
            }
            Err(_) => false.hash(&mut hasher),
        }
    }
    hasher.finish()
}

fn session_mtime_ms(session_dir: &Path) -> u64 {
    [
        session_dir.to_path_buf(),
        session_dir.join("metadata.json"),
        session_dir.join("metadata.json.backup"),
        session_dir.join("transcript.jsonl"),
        session_dir.join("transcript.jsonl.backup"),
        session_dir.join("events.jsonl"),
        session_dir.join("ui-events.jsonl"),
    ]
    .iter()
    .filter_map(|path| modified_ms(path))
    .max()
    .unwrap_or(0)
}

fn modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn read_session_index_cache(projects: &Path) -> SessionIndexCache {
    let Ok(text) = fs::read_to_string(projects.join(SESSION_INDEX_CACHE_FILE)) else {
        return SessionIndexCache::default();
    };
    let Ok(cache) = serde_json::from_str::<SessionIndexCache>(&text) else {
        return SessionIndexCache::default();
    };
    if cache.version == SESSION_INDEX_CACHE_VERSION {
        cache
    } else {
        SessionIndexCache::default()
    }
}

/// Rebuilds the listing cache from the scan that just ran.
///
/// Deliberately NOT merged into the previous cache: the scan enumerates every session under
/// `projects`, so anything absent from it no longer exists. Merging meant deleted sessions were
/// never evicted, and the file grew without bound while being rewritten in full on every listing.
fn write_session_index_cache(projects: &Path, scanned: &[(String, u64, StoredSession)]) {
    let entries = scanned
        .iter()
        .map(|(key, signature, session)| {
            (
                key.clone(),
                CachedStoredSession {
                    signature: *signature,
                    session: session.clone(),
                },
            )
        })
        .collect();
    let cache = SessionIndexCache {
        version: SESSION_INDEX_CACHE_VERSION,
        entries,
    };
    let Ok(encoded) = serde_json::to_vec(&cache) else {
        return;
    };
    let destination = projects.join(SESSION_INDEX_CACHE_FILE);
    let temporary = projects.join(format!(
        "{SESSION_INDEX_CACHE_FILE}.{}.tmp",
        std::process::id()
    ));
    if fs::write(&temporary, encoded).is_err() {
        return;
    }
    if fs::rename(&temporary, &destination).is_err() {
        let _ = fs::remove_file(&destination);
        let _ = fs::rename(&temporary, &destination);
    }
}

/// Build the same structured, portable checkpoint used by amplifier-runtime.
///
/// Live process state and UI telemetry are intentionally not included. The
/// imported copy remounts its bundle/provider on the destination compute.
pub fn export_stored_session(project_dir: String, session_id: String) -> Result<Value, String> {
    export_stored_session_from(&projects_root()?, project_dir, session_id)
}

fn export_stored_session_from(
    projects: &Path,
    project_dir: String,
    session_id: String,
) -> Result<Value, String> {
    validate_session_id(&session_id)?;
    let project = canonical_project_dir(&project_dir)?;
    let session_dir = projects
        .join(project_slug(&project))
        .join("sessions")
        .join(&session_id);
    if !session_dir.is_dir() {
        return Err(format!(
            "Stored session '{session_id}' was not found in this project"
        ));
    }

    let transcript = load_transcript_records_with_backup(&session_dir.join("transcript.jsonl"))?
        .ok_or_else(|| "The stored transcript is corrupt and cannot be duplicated".to_owned())?;
    if transcript.is_empty() {
        return Err("This runtime attempt did not write a conversation to duplicate".to_owned());
    }
    let (metadata, _) = read_json_with_backup(&session_dir.join("metadata.json"));
    let mut metadata = metadata.unwrap_or_default();
    metadata.insert("session_id".to_owned(), Value::String(session_id.clone()));
    metadata.insert(
        "working_dir".to_owned(),
        Value::String(project.to_string_lossy().into_owned()),
    );

    Ok(serde_json::json!({
        "schema": SESSION_EXPORT_SCHEMA,
        "exported_at": unix_timestamp(),
        "sanitized": false,
        "tool_io_redacted": false,
        "session_id": session_id,
        "metadata": metadata,
        "transcript": transcript,
    }))
}

pub fn import_stored_session(
    project_dir: String,
    payload: Value,
    new_id: String,
    name: Option<String>,
) -> Result<String, String> {
    import_stored_session_into(&projects_root()?, project_dir, payload, new_id, name)
}

fn import_stored_session_into(
    projects: &Path,
    project_dir: String,
    payload: Value,
    new_id: String,
    name: Option<String>,
) -> Result<String, String> {
    validate_session_id(&new_id)?;
    let Value::Object(payload) = payload else {
        return Err("Session transfer payload must be a JSON object".to_owned());
    };
    let schema = payload
        .get("schema")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with(SESSION_EXPORT_SCHEMA_PREFIX))
        .ok_or_else(|| "Session transfer payload has an unrecognized schema".to_owned())?;
    let transcript = payload
        .get("transcript")
        .and_then(Value::as_array)
        .filter(|records| !records.is_empty())
        .ok_or_else(|| "Session transfer payload does not contain a conversation".to_owned())?;
    if transcript.iter().any(|record| !record.is_object()) {
        return Err("Session transfer transcript contains an invalid record".to_owned());
    }

    let project = canonical_project_dir(&project_dir)?;
    let sessions_dir = projects.join(project_slug(&project)).join("sessions");
    fs::create_dir_all(&sessions_dir)
        .map_err(|error| format!("Could not prepare the destination session store: {error}"))?;
    let destination = sessions_dir.join(&new_id);
    if destination.exists() {
        return Err(format!("A stored session named '{new_id}' already exists"));
    }
    let temporary = sessions_dir.join(format!(".{new_id}.importing"));
    if temporary.exists() {
        fs::remove_dir_all(&temporary)
            .map_err(|error| format!("Could not clear an interrupted session import: {error}"))?;
    }
    fs::create_dir(&temporary)
        .map_err(|error| format!("Could not create the imported session: {error}"))?;

    let result: Result<(), String> = (|| {
        let mut metadata = payload
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        metadata.insert("session_id".to_owned(), Value::String(new_id.clone()));
        metadata.insert(
            "working_dir".to_owned(),
            Value::String(project.to_string_lossy().into_owned()),
        );
        metadata.insert("source_schema".to_owned(), Value::String(schema.to_owned()));
        metadata.insert("imported_at".to_owned(), Value::String(unix_timestamp()));
        metadata.insert(
            "imported_from".to_owned(),
            Value::String(
                payload
                    .get("session_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
        );
        metadata.insert(
            "sanitized".to_owned(),
            Value::Bool(
                payload
                    .get("sanitized")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        );
        if let Some(name) = name.map(|value| value.trim().chars().take(50).collect::<String>()) {
            if !name.is_empty() {
                metadata.insert("name".to_owned(), Value::String(name));
            }
        }

        let metadata_text = serde_json::to_string_pretty(&Value::Object(metadata))
            .map_err(|error| format!("Could not encode imported metadata: {error}"))?;
        fs::write(temporary.join("metadata.json"), metadata_text)
            .map_err(|error| format!("Could not write imported metadata: {error}"))?;
        let mut output = File::create(temporary.join("transcript.jsonl"))
            .map_err(|error| format!("Could not write imported transcript: {error}"))?;
        for record in transcript {
            serde_json::to_writer(&mut output, record)
                .map_err(|error| format!("Could not encode imported transcript: {error}"))?;
            output
                .write_all(b"\n")
                .map_err(|error| format!("Could not write imported transcript: {error}"))?;
        }
        output
            .sync_all()
            .map_err(|error| format!("Could not finish imported transcript: {error}"))?;
        // Windows will not rename a directory while a file inside it remains
        // open. Close the transcript explicitly before publishing the atomic
        // import directory; Unix permits the rename either way.
        drop(output);
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("Could not publish the imported session: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result?;
    Ok(new_id)
}

fn canonical_project_dir(project_dir: &str) -> Result<PathBuf, String> {
    crate::project_dir::canonical_project_dir(project_dir)
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if !(8..=128).contains(&session_id.len())
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Stored session id contains unsupported characters".to_owned());
    }
    Ok(())
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn summarize(
    session_dir: &Path,
    session_id: String,
    project_slug: String,
    project_dir_hint: Option<&str>,
) -> StoredSession {
    let metadata_path = session_dir.join("metadata.json");
    let metadata_exists = metadata_path.is_file()
        || metadata_path
            .with_file_name("metadata.json.backup")
            .is_file();
    let (metadata, metadata_recovered_or_corrupt) = read_json_with_backup(&metadata_path);
    let metadata_valid = metadata.is_some();
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
    let event_count = count_ui_events(session_dir);

    let state = if transcript_exists && transcript.is_none() {
        if metadata_valid {
            "transcript_lost"
        } else {
            "corrupt"
        }
    } else if metadata_exists && !metadata_valid {
        "corrupt"
    } else if metadata_recovered_or_corrupt {
        "recovered"
    } else if !metadata_exists && message_count > 0 {
        "indexing"
    } else if message_count == 0 {
        "empty"
    } else {
        "ok"
    };

    let mtime_ms = session_mtime_ms(session_dir);

    let stored_name = string_field(&metadata, "name");
    let name = if stored_name.trim().is_empty() {
        friendly_title(transcript_summary.first_user.as_deref(), &project_slug)
    } else {
        stored_name
    };
    let project_dir = nonempty_string_field(&metadata, "working_dir")
        .or_else(|| project_dir_hint.map(str::to_owned));
    let summary = match state {
        "empty" => "No resumable conversation was written for this runtime attempt.".to_owned(),
        "corrupt" => "Stored session files are corrupt and cannot be resumed safely.".to_owned(),
        "transcript_lost" => {
            "The durable metadata remains, but the conversation transcript is damaged.".to_owned()
        }
        _ => friendly_summary(
            transcript_summary.last_assistant.as_deref(),
            turn_count_from(&metadata),
            message_count,
            project_dir.as_deref(),
        ),
    };

    StoredSession {
        name,
        bundle: nonempty_string_field(&metadata, "bundle").unwrap_or_else(|| "unknown".to_owned()),
        model: nonempty_string_field(&metadata, "model"),
        tags: string_array_field(&metadata, "tags"),
        turn_count: turn_count_from(&metadata),
        project_dir,
        session_id,
        message_count,
        event_count,
        mtime_ms,
        project_slug,
        state: state.to_owned(),
        summary,
        search_text: transcript_summary.search_text,
    }
}

/// Count the durable records amplifier-runtime indexes for `history.replay`.
///
/// Current UI-ledger records carry `kind`; canonical pre-ledger Amplifier hook
/// records carry `event`. The runtime normalizes the latter through its event
/// contract and reports both the delivered UI-event count and this wider
/// indexed-record count. Torn/unparseable and genuinely foreign JSON objects
/// remain excluded.
fn count_ui_events(session_dir: &Path) -> u64 {
    [
        session_dir.join("events.jsonl"),
        session_dir.join("ui-events.jsonl"),
    ]
    .into_iter()
    .filter_map(|path| File::open(path).ok())
    .flat_map(|file| BufReader::new(file).lines())
    .filter_map(Result::ok)
    .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
    .filter(|record| {
        record.as_object().is_some_and(|object| {
            object.get("kind").and_then(Value::as_str).is_some()
                || object.get("event").and_then(Value::as_str).is_some()
        })
    })
    .count()
    .min(u64::MAX as usize) as u64
}

#[derive(Default)]
struct TranscriptSummary {
    first_user: Option<String>,
    last_assistant: Option<String>,
    search_text: String,
    search_terms: HashSet<String>,
    search_head: Vec<String>,
    search_head_bytes: usize,
    search_head_full: bool,
    search_order: VecDeque<String>,
    search_bytes: usize,
}

struct TranscriptScan {
    count: u64,
    summary: TranscriptSummary,
}

/// Whether the file's last byte is a newline, i.e. whether the final append completed.
///
/// This is what separates "the process died part-way through writing a record" from "a record
/// on disk is malformed". Only the former is safe to recover from.
fn ends_with_newline(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(size) = file.seek(SeekFrom::End(0)) else {
        return false;
    };
    if size == 0 {
        return true;
    }
    if file.seek(SeekFrom::Start(size - 1)).is_err() {
        return false;
    }
    let mut last = [0_u8; 1];
    file.read_exact(&mut last).is_ok() && last[0] == b'\n'
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
        // A completed append always ends in a newline; its absence is the signal that the last
        // record was cut short rather than written wrong.
        let tail_may_be_torn = !ends_with_newline(candidate);
        // Peekable so an unparseable line can be told apart from an unparseable *final* line.
        let mut lines = BufReader::new(file).lines().peekable();
        while let Some(line) = lines.next() {
            let Ok(line) = line else {
                valid = false;
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(Value::Object(record)) = serde_json::from_str::<Value>(&line) else {
                // A torn LAST line is a crash or power loss part-way through an append, not a
                // damaged transcript: every record before it is intact. Condemning the whole
                // file here meant one interrupted write hid the entire conversation and sent
                // the reader to a stale backup, or reported the session as unreadable outright.
                //
                // The tolerance is deliberately narrow. All three must hold: it is the final
                // line, the file does not end in a newline, and at least one good record came
                // before it. A malformed-but-complete line, or a file that is nothing but
                // garbage, is still corruption.
                if lines.peek().is_none() && tail_may_be_torn && count > 0 {
                    tracing::warn!(
                        path = %candidate.display(),
                        recovered_records = count,
                        "recovered a transcript whose final append was cut short",
                    );
                    break;
                }
                tracing::error!(
                    path = %candidate.display(),
                    records_before_damage = count,
                    "transcript is damaged; a record before the end of the file did not parse",
                );
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
            if role == "user" && user_visible_prompt(&text) {
                if summary.first_user.is_none() {
                    summary.first_user = Some(text.clone());
                }
                append_search_text(&mut summary, &text);
            } else if role == "assistant" {
                summary.last_assistant = Some(text.clone());
                append_search_text(&mut summary, &text);
            }
        }
        if valid {
            summary.search_text = summary
                .search_head
                .iter()
                .chain(summary.search_order.iter())
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(" ");
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

fn append_search_text(summary: &mut TranscriptSummary, text: &str) {
    for raw in text.split(|character: char| {
        !character.is_alphanumeric() && !matches!(character, '-' | '_' | '.' | '/' | '\\')
    }) {
        let term = raw.trim().to_lowercase();
        if term.len() < 2 || term.len() > 128 || summary.search_terms.contains(&term) {
            continue;
        }
        summary.search_terms.insert(term.clone());
        let head_separator = usize::from(!summary.search_head.is_empty());
        if !summary.search_head_full
            && summary
                .search_head_bytes
                .saturating_add(head_separator)
                .saturating_add(term.len())
                <= SESSION_SEARCH_HEAD_LIMIT
        {
            summary.search_head_bytes = summary
                .search_head_bytes
                .saturating_add(head_separator)
                .saturating_add(term.len());
            summary.search_head.push(term);
            continue;
        }
        summary.search_head_full = true;
        summary.search_bytes = summary
            .search_bytes
            .saturating_add(usize::from(!summary.search_order.is_empty()))
            .saturating_add(term.len());
        summary.search_order.push_back(term);
        let recent_limit = SESSION_SEARCH_TEXT_LIMIT.saturating_sub(summary.search_head_bytes + 1);
        while summary.search_bytes > recent_limit {
            let Some(evicted) = summary.search_order.pop_front() else {
                summary.search_bytes = 0;
                break;
            };
            summary.search_terms.remove(&evicted);
            summary.search_bytes = summary.search_bytes.saturating_sub(evicted.len());
            if !summary.search_order.is_empty() {
                summary.search_bytes = summary.search_bytes.saturating_sub(1);
            }
        }
    }
}

fn load_transcript_records_with_backup(path: &Path) -> Result<Option<Vec<Value>>, String> {
    let backup = path.with_file_name("transcript.jsonl.backup");
    let mut saw_candidate = false;
    for candidate in [path, backup.as_path()] {
        if !candidate.is_file() {
            continue;
        }
        saw_candidate = true;
        let file = match File::open(candidate) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let mut records = Vec::new();
        let mut valid = true;
        for line in BufReader::new(file).lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => {
                    valid = false;
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(record @ Value::Object(_)) => records.push(record),
                _ => {
                    valid = false;
                    break;
                }
            }
        }
        if valid {
            return Ok(Some(records));
        }
    }
    if saw_candidate {
        Ok(None)
    } else {
        Ok(Some(Vec::new()))
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
    let rendered = project_dir.to_string_lossy();
    // Rust's Windows canonicalize() returns extended-length paths such as
    // `\\?\C:\work`, while the Python Amplifier runtime keys the same project
    // as `C:\work`. Remove only that transport prefix so both processes use
    // the existing shared session directory. Preserve UNC's leading pair.
    let normalized = if let Some(rest) = rendered.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = rendered.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        rendered.into_owned()
    };
    let mut slug = normalized.replace(['/', '\\'], "-").replace(':', "");
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

    /// Regression: any unparseable line set `valid = false` and abandoned the whole transcript,
    /// so a crash part-way through a single append hid every message written before it.
    #[test]
    fn a_torn_final_line_keeps_the_records_written_before_it() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("transcript.jsonl");
        let mut file = File::create(&path).expect("transcript");
        writeln!(file, r#"{{"role":"user","content":"first question"}}"#).unwrap();
        writeln!(file, r#"{{"role":"assistant","content":"first answer"}}"#).unwrap();
        // Power loss mid-append: truncated JSON, no trailing newline.
        write!(file, r#"{{"role":"user","content":"third qu"#).unwrap();
        drop(file);

        let scan =
            scan_transcript_with_backup(&path).expect("a torn tail must not condemn the file");
        assert_eq!(scan.count, 2);
        assert_eq!(scan.summary.first_user.as_deref(), Some("first question"));
        assert_eq!(scan.summary.last_assistant.as_deref(), Some("first answer"));
    }

    /// A malformed line that was written *completely* is corruption, not a torn write.
    #[test]
    fn a_complete_but_malformed_final_line_is_still_damage() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("transcript.jsonl");
        let mut file = File::create(&path).expect("transcript");
        writeln!(file, r#"{{"role":"user","content":"first question"}}"#).unwrap();
        writeln!(file, "{{ this is not json").unwrap();
        drop(file);

        assert!(scan_transcript_with_backup(&path).is_none());
    }

    /// The tolerance is deliberately narrow: damage anywhere but the very end still counts.
    #[test]
    fn corruption_before_the_final_line_is_still_damage() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("transcript.jsonl");
        let mut file = File::create(&path).expect("transcript");
        writeln!(file, r#"{{"role":"user","content":"first question"}}"#).unwrap();
        writeln!(file, "{{ this is not json").unwrap();
        writeln!(
            file,
            r#"{{"role":"assistant","content":"after the damage"}}"#
        )
        .unwrap();
        drop(file);

        assert!(scan_transcript_with_backup(&path).is_none());
    }

    #[test]
    fn donor_slug_rule_is_preserved() {
        assert_eq!(
            project_slug(Path::new("/Users/me/dev/proj")),
            "-Users-me-dev-proj"
        );
        assert_eq!(
            project_slug(Path::new(r"\\?\C:\projects\web-app")),
            "-C-projects-web-app"
        );
        assert_eq!(
            project_slug(Path::new(r"\\?\UNC\server\share\project")),
            "--server-share-project"
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
    fn authorized_root_includes_nested_projects_without_collapsing_session_ids() {
        let temp = tempfile::tempdir().expect("tempdir");
        let projects = temp.path().join("projects");
        let allowed = temp.path().join("dev");
        let first = allowed.join("first");
        let second = allowed.join("second");
        let outside = temp.path().join("private");
        for project in [&first, &second, &outside] {
            fs::create_dir_all(project).expect("project");
            let session_dir = projects
                .join(project_slug(project))
                .join("sessions")
                .join("shared-session-1234");
            fs::create_dir_all(&session_dir).expect("session");
            fs::write(
                session_dir.join("metadata.json"),
                serde_json::json!({
                    "name": project.file_name().unwrap().to_string_lossy(),
                    "working_dir": project,
                })
                .to_string(),
            )
            .expect("metadata");
            fs::write(
                session_dir.join("transcript.jsonl"),
                "{\"role\":\"user\",\"content\":\"keep this conversation\"}\n",
            )
            .expect("transcript");
            if project == &first {
                fs::write(
                    session_dir.join("events.jsonl"),
                    concat!(
                        "{\"kind\":\"prompt_submit\",\"event_id\":\"legacy-1\"}\n",
                        "{\"timestamp\":\"foreign hook record\"}\n",
                        "not json\n",
                    ),
                )
                .expect("legacy events");
            }
        }

        let sessions =
            list_stored_sessions_for_roots_from(&projects, std::slice::from_ref(&allowed));
        assert_eq!(sessions.len(), 2);
        assert!(sessions
            .iter()
            .any(|session| session.project_slug == project_slug(&first)));
        assert!(sessions
            .iter()
            .any(|session| session.project_slug == project_slug(&second)));
        assert!(!sessions
            .iter()
            .any(|session| session.project_slug == project_slug(&outside)));
        assert_eq!(
            sessions
                .iter()
                .find(|session| session.project_slug == project_slug(&first))
                .expect("first session")
                .event_count,
            1,
        );
        assert!(projects.join(SESSION_INDEX_CACHE_FILE).is_file());

        let cached = list_stored_sessions_for_roots_from(&projects, std::slice::from_ref(&allowed));
        assert_eq!(cached.len(), 2);

        let first_transcript = projects
            .join(project_slug(&first))
            .join("sessions")
            .join("shared-session-1234")
            .join("transcript.jsonl");
        let mut transcript = fs::OpenOptions::new()
            .append(true)
            .open(first_transcript)
            .expect("open transcript");
        writeln!(
            transcript,
            "{{\"role\":\"assistant\",\"content\":\"cache invalidated after append\"}}"
        )
        .expect("append transcript");
        drop(transcript);
        let first_events = projects
            .join(project_slug(&first))
            .join("sessions")
            .join("shared-session-1234")
            .join("ui-events.jsonl");
        fs::write(
            first_events,
            "{\"kind\":\"prompt_complete\",\"event_id\":\"current-2\"}\n",
        )
        .expect("append current event ledger");
        let refreshed =
            list_stored_sessions_for_roots_from(&projects, std::slice::from_ref(&allowed));
        let first_session = refreshed
            .iter()
            .find(|session| session.project_slug == project_slug(&first))
            .expect("first session");
        assert_eq!(first_session.message_count, 2);
        assert_eq!(first_session.event_count, 2);
        assert!(first_session.search_text.contains("invalidated"));
    }

    #[test]
    fn event_only_runtime_attempt_is_empty_not_perpetually_indexing() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join("events.jsonl"),
            "{\"event\":\"session:end\"}\n",
        )
        .expect("event log");
        let summary = summarize(
            temp.path(),
            "session-empty".into(),
            "-project".into(),
            Some("/project"),
        );
        assert_eq!(summary.state, "empty");
        assert_eq!(summary.message_count, 0);
        assert_eq!(
            summary.event_count, 1,
            "canonical hook records are indexed for legacy replay"
        );
        assert!(summary.summary.contains("No resumable conversation"));
    }

    #[test]
    fn transcript_without_metadata_is_labeled_as_missing_metadata() {
        let temp = tempfile::tempdir().expect("tempdir");
        fs::write(
            temp.path().join("transcript.jsonl"),
            "{\"role\":\"user\",\"content\":\"unfinished\"}\n",
        )
        .expect("transcript");
        let summary = summarize(
            temp.path(),
            "session-partial".into(),
            "-project".into(),
            Some("/project"),
        );
        assert_eq!(summary.state, "indexing");
        assert_eq!(summary.message_count, 1);
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
    fn transcript_search_text_covers_the_conversation_but_not_tool_or_hidden_prompts() {
        let temp = tempfile::tempdir().expect("tempdir");
        let transcript = temp.path().join("transcript.jsonl");
        fs::write(
            &transcript,
            concat!(
                "{\"role\":\"user\",\"content\":\"Find the federated history bug\"}\n",
                "{\"role\":\"tool\",\"content\":\"secret tool output\"}\n",
                "{\"role\":\"user\",\"content\":\"<system-reminder>hidden instruction</system-reminder>\"}\n",
                "{\"role\":\"assistant\",\"content\":\"The nested project scan was repaired\"}\n",
            ),
        )
        .expect("transcript");
        let summary = read_transcript_summary(&transcript);
        assert!(summary.search_text.contains("federated history"));
        assert!(summary.search_text.contains("nested project scan"));
        assert!(!summary.search_text.contains("secret tool output"));
        assert!(!summary.search_text.contains("hidden instruction"));
    }

    #[test]
    fn transcript_search_keeps_recent_terms_when_a_long_session_exceeds_its_payload_budget() {
        let temp = tempfile::tempdir().expect("tempdir");
        let transcript = temp.path().join("transcript.jsonl");
        let mut records =
            String::from("{\"role\":\"user\",\"content\":\"Initial release investigation\"}\n");
        for index in 0..2_000 {
            records.push_str(&format!(
                "{{\"role\":\"assistant\",\"content\":\"diagnostic-token-{index:04}\"}}\n"
            ));
        }
        records
            .push_str("{\"role\":\"assistant\",\"content\":\"Latest provisioning resolution\"}\n");
        fs::write(&transcript, records).expect("transcript");

        let summary = read_transcript_summary(&transcript);
        assert!(summary.search_text.len() <= SESSION_SEARCH_TEXT_LIMIT);
        assert!(summary
            .search_text
            .contains("initial release investigation"));
        assert!(summary
            .search_text
            .contains("latest provisioning resolution"));
        assert!(summary.search_text.contains("diagnostic-token-1999"));
    }

    #[test]
    fn corrupt_and_zero_message_sessions_are_not_reported_ready() {
        let corrupt = tempfile::tempdir().expect("corrupt tempdir");
        fs::write(corrupt.path().join("transcript.jsonl"), "not json\n")
            .expect("corrupt transcript");
        let corrupt_summary = summarize(
            corrupt.path(),
            "session-corrupt".into(),
            "-project".into(),
            Some("/project"),
        );
        assert_eq!(corrupt_summary.state, "corrupt");

        let empty = tempfile::tempdir().expect("empty tempdir");
        fs::write(
            empty.path().join("metadata.json"),
            "{\"name\":\"Started but empty\"}\n",
        )
        .expect("metadata");
        let empty_summary = summarize(
            empty.path(),
            "session-empty-with-metadata".into(),
            "-project".into(),
            Some("/project"),
        );
        assert_eq!(empty_summary.state, "empty");
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

    #[test]
    fn portable_session_round_trip_mints_a_new_resumable_copy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let projects = temp.path().join("projects");
        let source_project = temp.path().join("source");
        let destination_project = temp.path().join("destination");
        fs::create_dir_all(&source_project).expect("source project");
        fs::create_dir_all(&destination_project).expect("destination project");
        let source_id = "source-session-1234";
        let source_dir = projects
            .join(project_slug(
                &source_project.canonicalize().expect("canonical source"),
            ))
            .join("sessions")
            .join(source_id);
        fs::create_dir_all(&source_dir).expect("source session");
        fs::write(
            source_dir.join("metadata.json"),
            serde_json::json!({
                "session_id": source_id,
                "name": "Original",
                "bundle": "anchors",
                "working_dir": source_project,
            })
            .to_string(),
        )
        .expect("metadata");
        fs::write(
            source_dir.join("transcript.jsonl"),
            "{\"role\":\"user\",\"content\":\"Continue this work\"}\n",
        )
        .expect("transcript");

        let payload = export_stored_session_from(
            &projects,
            source_project.to_string_lossy().into_owned(),
            source_id.to_owned(),
        )
        .expect("export");
        let copy_id = "copied-session-5678";
        assert_eq!(
            import_stored_session_into(
                &projects,
                destination_project.to_string_lossy().into_owned(),
                payload,
                copy_id.to_owned(),
                Some("Original copy".to_owned()),
            )
            .expect("import"),
            copy_id
        );

        let copy_dir = projects
            .join(project_slug(
                &destination_project
                    .canonicalize()
                    .expect("canonical destination"),
            ))
            .join("sessions")
            .join(copy_id);
        let (metadata, _) = read_json_with_backup(&copy_dir.join("metadata.json"));
        let metadata = metadata.expect("copied metadata");
        assert_eq!(string_field(&metadata, "session_id"), copy_id);
        assert_eq!(string_field(&metadata, "imported_from"), source_id);
        assert_eq!(string_field(&metadata, "name"), "Original copy");
        assert_eq!(
            string_field(&metadata, "working_dir"),
            destination_project
                .canonicalize()
                .expect("canonical destination")
                .to_string_lossy()
        );
        assert_eq!(
            load_transcript_records_with_backup(&copy_dir.join("transcript.jsonl"))
                .expect("read copied transcript")
                .expect("valid copied transcript")
                .len(),
            1
        );
        assert!(source_dir.exists(), "duplicating must preserve the source");
    }

    #[test]
    fn portable_session_ids_cannot_escape_the_store() {
        assert!(validate_session_id("../../escape").is_err());
        assert!(validate_session_id("valid-session-1234").is_ok());
    }

    #[test]
    fn corrupt_session_cannot_be_exported() {
        let temp = tempfile::tempdir().expect("tempdir");
        let projects = temp.path().join("projects");
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("project");
        let session_id = "corrupt-session-1234";
        let session_dir = projects
            .join(project_slug(
                &project.canonicalize().expect("canonical project"),
            ))
            .join("sessions")
            .join(session_id);
        fs::create_dir_all(&session_dir).expect("session");
        fs::write(session_dir.join("transcript.jsonl"), "not json\n").expect("transcript");
        let error = export_stored_session_from(
            &projects,
            project.to_string_lossy().into_owned(),
            session_id.to_owned(),
        )
        .expect_err("corrupt export should fail");
        assert!(error.contains("corrupt"));
    }
}
