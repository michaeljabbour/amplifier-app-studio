#![cfg_attr(
    not(any(target_os = "ios", target_os = "android")),
    allow(dead_code, unused_variables)
)]

const KEYCHAIN_SERVICE: &str = "com.amplifier.studio.amplifier-host";

fn checked_account(account: &str) -> Result<&str, String> {
    let account = account.trim();
    if account.is_empty()
        || account.len() > 128
        || !account
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("The compute credential identifier is invalid".to_owned());
    }
    Ok(account)
}

fn checked_token(token: &str) -> Result<&str, String> {
    let token = token.trim();
    if !(32..=4096).contains(&token.as_bytes().len()) {
        return Err("Compute access tokens must contain 32 to 4096 bytes".to_owned());
    }
    Ok(token)
}

#[tauri::command]
pub fn store_mobile_bridge_token(account: String, token: String) -> Result<(), String> {
    let account = checked_account(&account)?;
    let token = checked_token(&token)?;

    #[cfg(target_os = "ios")]
    {
        let options = apple_password_options(account);
        return security_framework::passwords::set_generic_password_options(
            token.as_bytes(),
            options,
        )
        .map_err(|error| format!("Could not save compute access in iOS Keychain: {error}"));
    }

    #[cfg(target_os = "android")]
    {
        use keyring_core::api::CredentialStoreApi;
        let store = android_native_keyring_store::Store::new()
            .map_err(|error| format!("Could not open Android secure storage: {error}"))?;
        let entry = store
            .build(KEYCHAIN_SERVICE, account, None)
            .map_err(|error| format!("Could not prepare Android secure storage: {error}"))?;
        return entry.set_password(token).map_err(|error| {
            format!("Could not save compute access in Android Keystore: {error}")
        });
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    Err("Mobile secure storage is only available on iOS and Android".to_owned())
}

#[tauri::command]
pub fn resolve_mobile_bridge_token(account: String) -> Result<Option<String>, String> {
    let account = checked_account(&account)?;

    #[cfg(target_os = "ios")]
    {
        return match security_framework::passwords::generic_password(apple_password_options(
            account,
        )) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "iOS Keychain returned an invalid compute credential".to_owned()),
            // errSecItemNotFound. Missing access is a normal reconnect state, not a native fault.
            Err(error) if error.code() == -25_300 => Ok(None),
            Err(error) => Err(format!(
                "Could not read compute access from iOS Keychain: {error}"
            )),
        };
    }

    #[cfg(target_os = "android")]
    {
        use keyring_core::api::CredentialStoreApi;
        let store = android_native_keyring_store::Store::new()
            .map_err(|error| format!("Could not open Android secure storage: {error}"))?;
        let entry = store
            .build(KEYCHAIN_SERVICE, account, None)
            .map_err(|error| format!("Could not prepare Android secure storage: {error}"))?;
        return match entry.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!(
                "Could not read compute access from Android Keystore: {error}"
            )),
        };
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    Err("Mobile secure storage is only available on iOS and Android".to_owned())
}

#[tauri::command]
pub fn delete_mobile_bridge_token(account: String) -> Result<(), String> {
    let account = checked_account(&account)?;

    #[cfg(target_os = "ios")]
    {
        return match security_framework::passwords::delete_generic_password_options(
            apple_password_options(account),
        ) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25_300 => Ok(()),
            Err(error) => Err(format!(
                "Could not remove compute access from iOS Keychain: {error}"
            )),
        };
    }

    #[cfg(target_os = "android")]
    {
        use keyring_core::api::CredentialStoreApi;
        let store = android_native_keyring_store::Store::new()
            .map_err(|error| format!("Could not open Android secure storage: {error}"))?;
        let entry = store
            .build(KEYCHAIN_SERVICE, account, None)
            .map_err(|error| format!("Could not prepare Android secure storage: {error}"))?;
        return match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "Could not remove compute access from Android Keystore: {error}"
            )),
        };
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    Err("Mobile secure storage is only available on iOS and Android".to_owned())
}

#[cfg(target_os = "ios")]
fn apple_password_options(account: &str) -> security_framework::passwords::PasswordOptions {
    use security_framework::access_control::{ProtectionMode, SecAccessControl};

    let mut options = security_framework::passwords::PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        account,
    );
    // Keep the host credential device-local and backed by Apple's data-protection keychain.
    options.set_access_synchronized(Some(false));
    let access_control = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
        0,
    )
    .expect("iOS must support device-local data-protection keychain access");
    options.set_access_control(access_control);
    options.use_protected_keychain();
    options
}

#[cfg(test)]
mod tests {
    use super::{checked_account, checked_token};

    #[test]
    fn accepts_generated_host_accounts_and_bounded_tokens() {
        assert_eq!(
            checked_account("host-spark-288f.tail422ba7.ts.net-443-abc123"),
            Ok("host-spark-288f.tail422ba7.ts.net-443-abc123")
        );
        assert!(checked_token(&"a".repeat(32)).is_ok());
        assert!(checked_token(&"a".repeat(4096)).is_ok());
    }

    #[test]
    fn rejects_ambiguous_accounts_and_unbounded_tokens() {
        for account in [
            "",
            "../host",
            "host/account",
            "host account",
            "host@account",
        ] {
            assert!(checked_account(account).is_err(), "accepted {account:?}");
        }
        assert!(checked_account(&"a".repeat(129)).is_err());
        assert!(checked_token("short").is_err());
        assert!(checked_token(&"a".repeat(4097)).is_err());
    }
}
