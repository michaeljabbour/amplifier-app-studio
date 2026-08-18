use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};

const REGISTRY_VERSION: u16 = 1;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHost {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(alias = "token_ref")]
    pub token_ref: String,
    #[serde(default, alias = "default_project_root")]
    pub default_project_root: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct HostRegistry {
    version: u16,
    hosts: Vec<RuntimeHost>,
}

pub fn list() -> Result<Vec<RuntimeHost>, String> {
    let path = registry_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    // Amplifier clients write deterministic JSON, which is valid YAML and
    // keeps this Rust-side reader small. Fail explicitly if a hand-edited
    // YAML-only file needs normalization.
    let registry: HostRegistry = serde_json::from_str(&text).map_err(|error| {
        format!(
            "Could not parse {}: {error}. Fix or remove that registry, then configure the host again in Studio Settings.",
            path.display()
        )
    })?;
    if registry.version != REGISTRY_VERSION {
        return Err(format!(
            "{} uses host registry version {}; Studio requires version {REGISTRY_VERSION}",
            path.display(),
            registry.version
        ));
    }
    for host in &registry.hosts {
        validate(host)?;
    }
    Ok(registry.hosts)
}

pub fn upsert(host: RuntimeHost) -> Result<Vec<RuntimeHost>, String> {
    validate(&host)?;
    let mut hosts = list()?;
    if let Some(existing) = hosts.iter_mut().find(|existing| existing.id == host.id) {
        *existing = host;
    } else {
        hosts.push(host);
    }
    hosts.sort_by_cached_key(|host| (host.name.to_lowercase(), host.id.clone()));
    write(&hosts)?;
    Ok(hosts)
}

pub fn remove(id: &str) -> Result<Vec<RuntimeHost>, String> {
    let mut hosts = list()?;
    hosts.retain(|host| host.id != id);
    write(&hosts)?;
    Ok(hosts)
}

pub fn resolve_token(id: &str) -> Result<String, String> {
    let host = list()?
        .into_iter()
        .find(|host| host.id == id)
        .ok_or_else(|| format!("Unknown Amplifier host '{id}'"))?;
    if let Some(variable) = host.token_ref.strip_prefix("env:") {
        return env::var(variable)
            .ok()
            .filter(|value| (32..=4096).contains(&value.trim().as_bytes().len()))
            .map(|value| value.trim().to_owned())
            .ok_or_else(|| format!("Set {variable} to the bearer token for host '{id}'"));
    }
    #[cfg(target_os = "macos")]
    if let Some(account) = host.token_ref.strip_prefix("keychain:") {
        let output = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "amplifier-host",
                "-a",
                account,
                "-w",
            ])
            .output()
            .map_err(|error| format!("Could not read macOS Keychain: {error}"))?;
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if (32..=4096).contains(&token.as_bytes().len()) {
                return Ok(token);
            }
        }
        return Err(format!(
            "No valid macOS Keychain token exists for host '{id}'"
        ));
    }
    #[cfg(target_os = "windows")]
    if let Some(account) = host.token_ref.strip_prefix("keychain:") {
        return windows_resolve_token(account).map_err(|error| {
            format!("Could not read the secure credential for host '{id}': {error}")
        });
    }
    Err(format!(
        "Token reference '{}' is not supported on this platform",
        host.token_ref
    ))
}

pub fn store_token(id: &str, token: &str) -> Result<(), String> {
    let host = list()?
        .into_iter()
        .find(|host| host.id == id)
        .ok_or_else(|| format!("Unknown Amplifier host '{id}'"))?;
    let token = token.trim();
    if !(32..=4096).contains(&token.as_bytes().len()) {
        return Err("Host bearer tokens must contain 32 to 4096 bytes".to_owned());
    }
    #[cfg(target_os = "macos")]
    if let Some(account) = host.token_ref.strip_prefix("keychain:") {
        let output = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                "amplifier-host",
                "-a",
                account,
                "-w",
                token,
            ])
            .output()
            .map_err(|error| format!("Could not write macOS Keychain: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        return Err("macOS Keychain rejected the Amplifier Host token".to_owned());
    }
    #[cfg(target_os = "windows")]
    if let Some(account) = host.token_ref.strip_prefix("keychain:") {
        return windows_store_token(account, token)
            .map_err(|error| format!("Could not protect the credential for host '{id}': {error}"));
    }
    Err(format!(
        "Host '{}' does not use a secure credential reference on this platform",
        host.id
    ))
}

#[cfg(any(target_os = "windows", test))]
fn credential_target(account: &str) -> String {
    format!("Amplifier Studio/amplifier-host/{account}")
}

#[cfg(target_os = "windows")]
fn windows_resolve_token(account: &str) -> Result<String, String> {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = credential_target(account);
    let target_wide = target
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    if unsafe { CredReadW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    if credential.is_null() {
        return Err("Windows Credential Manager returned an empty credential".to_owned());
    }

    let token_result = unsafe {
        let credential = &*credential;
        if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
            Err("Windows Credential Manager returned an empty token".to_owned())
        } else {
            let blob = std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            );
            String::from_utf8(blob.to_vec())
                .map(|value| value.trim().to_owned())
                .map_err(|_| "Windows Credential Manager returned a non-UTF-8 token".to_owned())
        }
    };
    unsafe { CredFree(credential.cast()) };

    let token = token_result?;
    if !(32..=4096).contains(&token.as_bytes().len()) {
        return Err("Windows Credential Manager returned an invalid bearer token".to_owned());
    }
    Ok(token)
}

#[cfg(target_os = "windows")]
fn windows_store_token(account: &str, token: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    if token.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(format!(
            "Windows Credential Manager accepts at most {CRED_MAX_CREDENTIAL_BLOB_SIZE} bytes"
        ));
    }
    let target = credential_target(account);
    let mut target_wide = target
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut username_wide = account
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut token_blob = token.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target_wide.as_mut_ptr(),
        CredentialBlobSize: token_blob.len() as u32,
        CredentialBlob: token_blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username_wide.as_mut_ptr(),
        ..Default::default()
    };

    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

fn write(hosts: &[RuntimeHost]) -> Result<(), String> {
    let path = registry_path();
    let parent = path
        .parent()
        .ok_or_else(|| "Amplifier host registry path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let temporary = parent.join(format!(".hosts-{}.yaml", std::process::id()));
    let encoded = serde_json::to_vec_pretty(&HostRegistry {
        version: REGISTRY_VERSION,
        hosts: hosts.to_vec(),
    })
    .map_err(|error| format!("Could not encode Amplifier hosts: {error}"))?;
    fs::write(&temporary, encoded)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect {}: {error}", temporary.display()))?;
    }
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not replace {}: {error}", path.display()))
}

fn validate(host: &RuntimeHost) -> Result<(), String> {
    if host.id.is_empty()
        || host.id.len() > 63
        || !host.id.chars().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || ".-_".contains(value)
        })
    {
        return Err(
            "Host ids use lowercase letters, numbers, dots, dashes, and underscores".into(),
        );
    }
    if host.name.trim().is_empty() || host.name.len() > 80 {
        return Err("Host names must contain 1 to 80 characters".into());
    }
    let url = reqwest::Url::parse(&host.url).map_err(|_| "Host URL is invalid".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Host URL must be an HTTP(S) origin".into());
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !loopback {
        return Err("Remote Amplifier hosts require HTTPS".into());
    }
    if !host.token_ref.starts_with("env:") && !host.token_ref.starts_with("keychain:") {
        return Err("Host token_ref must use env: or keychain:".into());
    }
    Ok(())
}

fn registry_path() -> PathBuf {
    env::var_os("AMPLIFIER_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".amplifier")))
        .unwrap_or_else(|| PathBuf::from(".amplifier"))
        .join("hosts.yaml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_http_is_rejected() {
        assert!(validate(&RuntimeHost {
            id: "sam".into(),
            name: "SAM".into(),
            url: "http://sam.example.test".into(),
            token_ref: "env:SAM_TOKEN".into(),
            default_project_root: None,
        })
        .unwrap_err()
        .contains("HTTPS"));
    }

    #[test]
    fn credential_target_is_namespaced_by_host_account() {
        assert_eq!(
            credential_target("spark-01"),
            "Amplifier Studio/amplifier-host/spark-01"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_secure_credentials_round_trip() {
        use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

        let account = format!("credential-test-{}", std::process::id());
        let token = "amplifier-windows-test-token-000000000000";
        windows_store_token(&account, token).expect("store disposable Windows credential");
        let resolved = windows_resolve_token(&account);

        let target = credential_target(&account);
        let target_wide = target
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        assert_ne!(
            unsafe { CredDeleteW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0) },
            0,
            "delete disposable Windows credential: {}",
            std::io::Error::last_os_error()
        );

        assert_eq!(
            resolved.expect("resolve disposable Windows credential"),
            token
        );
    }
}
