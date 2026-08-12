use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Options accepted by the thin process bridge. Field names are camelCase on
/// the invoke boundary so the Solid client never needs a Rust-shaped adapter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionOptions {
    pub gui_id: String,
    pub project_dir: String,
    #[serde(default)]
    pub bundle: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub resume_id: Option<String>,
}

impl StartSessionOptions {
    pub fn trimmed(mut self) -> Self {
        self.gui_id = self.gui_id.trim().to_owned();
        self.project_dir = self.project_dir.trim().to_owned();
        self.bundle = trim_option(self.bundle);
        self.model = trim_option(self.model);
        self.provider = trim_option(self.provider);
        self.mode = trim_option(self.mode);
        self.resume_id = trim_option(self.resume_id);
        self
    }
}

fn trim_option(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionResult {
    pub gui_id: String,
    pub project_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLog {
    pub stream: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub message: String,
}

/// Transport-neutral output from a managed runtime. Tauri maps this to its
/// event bus; the web bridge serializes the same value over WebSocket.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub gui_id: String,
    pub channel: &'static str,
    pub payload: Value,
}

pub fn require_object(value: &Value) -> Result<(), String> {
    if value.is_object() {
        Ok(())
    } else {
        Err("protocol operation must be a JSON object".to_owned())
    }
}
