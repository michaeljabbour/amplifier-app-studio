//! Shared resolution of Studio's state directory, and owner-only file creation.
//!
//! The `AMPLIFIER_HOME | ~/.amplifier` chain was copied verbatim in four modules, and the
//! umask-safe secret writer existed only inside the amplifier-host binary even though the host
//! registry needed exactly the same guarantee. One definition each.

use std::path::{Path, PathBuf};

/// Studio's state directory: `$AMPLIFIER_HOME`, else `~/.amplifier`, else a relative fallback.
pub fn amplifier_home() -> PathBuf {
    std::env::var_os("AMPLIFIER_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".amplifier")))
        .unwrap_or_else(|| PathBuf::from(".amplifier"))
}

/// Writes a secret so it is never readable by other users, not even briefly.
///
/// `fs::write` followed by `set_permissions` creates the file at the process umask -- typically
/// 0644 -- and only narrows it afterwards, leaving a window in which any local user can read it.
/// The mode is applied at creation instead.
pub fn write_secret(path: &Path, value: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        file.write_all(format!("{value}\n").as_bytes())
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        // `.mode()` applies only when the file is created, so an existing secret written by an
        // older build still has to be narrowed explicitly.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect {}: {error}", path.display()))?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, format!("{value}\n"))
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;

    Ok(())
}

/// Creates a directory only its owner can enter.
///
/// On Unix `recursive(true).mode(0o700)` applies 0700 to every component it CREATES, not just the
/// leaf, so pointing AMPLIFIER_HOME at a fresh nested path makes the intermediates owner-only too.
/// An already-existing directory is left as it is -- an `~/.amplifier` created 0755 by an earlier
/// build is not narrowed by this.
pub fn create_private_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_owner_only_from_the_moment_they_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("token");
        write_secret(&path, "0123456789abcdef0123456789abcdef").expect("write");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read").trim(),
            "0123456789abcdef0123456789abcdef"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "secret file mode");
            let dir_mode = std::fs::metadata(path.parent().unwrap())
                .expect("dir metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700, "created parent directory mode");
        }
    }

    #[test]
    fn rewriting_a_secret_narrows_a_previously_wide_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("token");
        std::fs::write(&path, "old").expect("seed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("widen");
        }

        write_secret(&path, "0123456789abcdef0123456789abcdef").expect("write");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "an existing 0644 secret must be narrowed");
        }
    }
}
