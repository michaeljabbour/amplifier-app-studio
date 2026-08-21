//! One definition of "turn a caller-supplied project directory into a usable path".
//!
//! Six modules had grown their own version of this, and they disagreed on two axes that matter:
//! whether the input is trimmed, and whether the result is required to be a directory at all.
//! Same job, different answers for the same input:
//!
//! - `store.rs` trimmed; `session.rs` did not, so `"/tmp/project "` resolved on one path and
//!   failed with "No such file or directory" on the other.
//! - `catalog.rs` skipped the `is_dir` check entirely. `canonicalize` succeeds on a FILE, and the
//!   result was handed to `Command::current_dir`, which fails later with the unhelpful
//!   "Not a directory (os error 20)" instead of naming the real problem at the boundary.
//!
//! A caller that needs something stricter (an absolute-path requirement, a containment check
//! against allowed roots) layers it on top rather than reimplementing the base.

use std::path::{Path, PathBuf};

/// Trims, canonicalizes, and requires the result to be an existing directory.
pub fn canonical_project_dir(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose a project folder first".to_owned());
    }
    let canonical = Path::new(trimmed)
        .canonicalize()
        .map_err(|error| format!("Project directory '{trimmed}' is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("'{}' is not a directory", canonical.display()));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_does_not_change_the_answer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_string_lossy().into_owned();
        let bare = canonical_project_dir(&path).expect("bare path resolves");
        // The divergence this module exists to remove: one copy trimmed, another did not, so the
        // same directory resolved from one call site and failed from the other.
        assert_eq!(
            canonical_project_dir(&format!("  {path}  ")).expect("padded resolves"),
            bare
        );
        assert_eq!(
            canonical_project_dir(&format!("{path}\n")).expect("newline resolves"),
            bare
        );
    }

    #[test]
    fn a_file_is_rejected_at_the_boundary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "x").expect("seed");
        // canonicalize() succeeds on a file. Without the is_dir check the path reached
        // Command::current_dir and failed there as "Not a directory (os error 20)".
        let error = canonical_project_dir(&file.to_string_lossy()).expect_err("file rejected");
        assert!(error.contains("is not a directory"), "{error}");
    }

    #[test]
    fn empty_and_missing_paths_say_what_is_wrong() {
        assert!(canonical_project_dir("   ")
            .expect_err("empty")
            .contains("Choose a project folder"));
        let missing = canonical_project_dir("/definitely/not/here/at/all").expect_err("missing");
        assert!(missing.contains("is unavailable"), "{missing}");
    }
}
