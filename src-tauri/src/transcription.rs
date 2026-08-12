use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::{env, path::PathBuf};

const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = (MAX_AUDIO_BYTES * 4 / 3) + 8;
const DEFAULT_MODEL: &str = "gpt-transcribe";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionStatus {
    pub available: bool,
    pub provider: Option<&'static str>,
    pub model: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionRequest {
    pub media_type: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
struct TranscriptionResponse {
    text: String,
}

pub fn status() -> TranscriptionStatus {
    if openai_api_key().is_some() {
        let model = transcription_model();
        return TranscriptionStatus {
            available: true,
            provider: Some("openai"),
            model: Some(model.clone()),
            message: format!(
                "Audio is sent to OpenAI {model} using the existing runtime-host credential"
            ),
        };
    }
    TranscriptionStatus {
        available: false,
        provider: None,
        model: None,
        message: "Add OPENAI_API_KEY to the runtime host; Studio will not create or overwrite a key for dictation"
            .to_owned(),
    }
}

pub async fn transcribe(request: TranscriptionRequest) -> Result<String, String> {
    let key = openai_api_key().ok_or_else(|| status().message)?;
    let format = audio_format(&request.media_type)?;
    if request.data.len() > MAX_BASE64_BYTES {
        return Err("The microphone recording exceeds the 25 MB transcription limit".to_owned());
    }
    let bytes = STANDARD
        .decode(request.data.trim())
        .map_err(|_| "The microphone recording was not valid base64 audio".to_owned())?;
    if bytes.is_empty() {
        return Err("The microphone recording was empty".to_owned());
    }
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("The microphone recording exceeds the 25 MB transcription limit".to_owned());
    }

    let model = transcription_model();
    let part = Part::bytes(bytes)
        .file_name(format!("dictation.{format}"))
        .mime_str(&request.media_type)
        .map_err(|error| format!("Unsupported microphone content type: {error}"))?;
    let form = Form::new().text("model", model).part("file", part);
    let response = reqwest::Client::new()
        .post("https://api.openai.com/v1/audio/transcriptions")
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Could not reach the transcription provider: {error}"))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the transcription response: {error}"))?;
    if !status.is_success() {
        let detail = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.pointer("/error/message")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| "The transcription provider rejected the recording".to_owned());
        return Err(format!("{detail} ({status})"));
    }
    let result: TranscriptionResponse = serde_json::from_slice(&body)
        .map_err(|error| format!("The transcription provider returned invalid JSON: {error}"))?;
    let text = result.text.trim().to_owned();
    if text.is_empty() {
        return Err("No speech was detected in the recording".to_owned());
    }
    Ok(text)
}

fn transcription_model() -> String {
    env::var("AMPLIFIER_STUDIO_TRANSCRIPTION_MODEL")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| {
            !value.is_empty() && value.len() <= 100 && !value.chars().any(char::is_control)
        })
        .unwrap_or_else(|| DEFAULT_MODEL.to_owned())
}

fn openai_api_key() -> Option<String> {
    env::var("OPENAI_API_KEY")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(read_key_from_amplifier_home)
}

fn read_key_from_amplifier_home() -> Option<String> {
    let path = env::var_os("AMPLIFIER_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".amplifier")))?
        .join("keys.env");
    let contents = std::fs::read_to_string(path).ok()?;
    parse_env_value(&contents, "OPENAI_API_KEY")
}

fn parse_env_value(contents: &str, name: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        if key.trim() != name {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|item| item.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|item| item.strip_suffix('\''))
            })
            .unwrap_or(value)
            .trim()
            .to_owned();
        (!value.is_empty()).then_some(value)
    })
}

fn audio_format(media_type: &str) -> Result<&'static str, String> {
    match media_type.split(';').next().unwrap_or_default().trim() {
        "audio/webm" => Ok("webm"),
        "audio/mp4" | "audio/x-m4a" => Ok("m4a"),
        "audio/mpeg" => Ok("mp3"),
        "audio/wav" | "audio/x-wav" => Ok("wav"),
        _ => Err("Studio supports WebM, MP4/M4A, MP3, or WAV microphone recordings".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_existing_key_without_mutating_the_file() {
        let contents = "# keep\nANTHROPIC_API_KEY=other\nexport OPENAI_API_KEY='existing-key'\n";
        assert_eq!(
            parse_env_value(contents, "OPENAI_API_KEY").as_deref(),
            Some("existing-key")
        );
        assert_eq!(contents.lines().count(), 3);
    }

    #[test]
    fn accepts_only_documented_file_transcription_formats() {
        assert_eq!(audio_format("audio/webm;codecs=opus").unwrap(), "webm");
        assert_eq!(audio_format("audio/mp4").unwrap(), "m4a");
        assert!(audio_format("audio/ogg").is_err());
    }
}
