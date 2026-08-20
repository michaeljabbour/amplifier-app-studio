use base64::{engine::general_purpose::STANDARD, Engine as _};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

const MAX_ATTACHMENT_COUNT: usize = 8;
const MAX_IMAGE_COUNT: usize = 4;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_DOCUMENT_CHARS: usize = 200_000;
const MAX_DOCUMENT_TOTAL_CHARS: usize = 300_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAttachment {
    kind: &'static str,
    name: String,
    media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    size: u64,
    truncated: bool,
}

pub(crate) fn load_attachments(paths: &[PathBuf]) -> Result<Vec<NativeAttachment>, String> {
    if paths.is_empty() {
        return Err("Drop an image, PDF, Word document, or text/code file.".to_owned());
    }
    if paths.len() > MAX_ATTACHMENT_COUNT {
        return Err(format!(
            "Attach up to {MAX_ATTACHMENT_COUNT} files per turn."
        ));
    }

    let mut image_count = 0_usize;
    let mut image_bytes = 0_u64;
    let mut document_chars = 0_usize;
    let mut attachments = Vec::with_capacity(paths.len());
    for path in paths {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("Could not read {}: {error}", display_name(path)))?;
        if !metadata.is_file() {
            return Err(format!("{} is not a file.", display_name(path)));
        }
        let size = metadata.len();
        if size == 0 {
            return Err(format!("{} is empty.", display_name(path)));
        }
        let bytes = std::fs::read(path)
            .map_err(|error| format!("Could not read {}: {error}", display_name(path)))?;

        if let Some(media_type) = image_media_type(&bytes) {
            image_count += 1;
            if image_count > MAX_IMAGE_COUNT {
                return Err(format!("Attach up to {MAX_IMAGE_COUNT} images per turn."));
            }
            if size > MAX_IMAGE_BYTES {
                return Err("Each image must be no larger than 20 MB.".to_owned());
            }
            image_bytes = image_bytes.saturating_add(size);
            if image_bytes > MAX_IMAGE_TOTAL_BYTES {
                return Err("Image attachments can total up to 32 MB per turn.".to_owned());
            }
            attachments.push(NativeAttachment {
                kind: "image",
                name: display_name(path),
                media_type: media_type.to_owned(),
                data: Some(STANDARD.encode(bytes)),
                text: None,
                size,
                truncated: false,
            });
            continue;
        }

        if size > MAX_DOCUMENT_BYTES {
            return Err("Each document must be no larger than 20 MB.".to_owned());
        }
        let media_type = document_media_type(path).ok_or_else(|| {
            format!(
                "{} is not a supported image or document.",
                display_name(path)
            )
        })?;
        let full_text = extract_document_text(path, &bytes, media_type)?;
        if full_text.trim().is_empty() {
            return Err(format!(
                "{} does not contain readable text.",
                display_name(path)
            ));
        }
        let (text, truncated) = truncate_document(full_text);
        document_chars = document_chars.saturating_add(text.chars().count());
        if document_chars > MAX_DOCUMENT_TOTAL_CHARS {
            return Err(
                "Document attachments can contain up to 300,000 extracted characters per turn."
                    .to_owned(),
            );
        }
        attachments.push(NativeAttachment {
            kind: "document",
            name: display_name(path),
            media_type: media_type.to_owned(),
            data: None,
            text: Some(text),
            size,
            truncated,
        });
    }
    Ok(attachments)
}

fn extract_document_text(path: &Path, bytes: &[u8], media_type: &str) -> Result<String, String> {
    match media_type {
        "application/pdf" => {
            if !bytes.starts_with(b"%PDF-") {
                return Err(format!("{} is not a valid PDF.", display_name(path)));
            }
            pdf_extract::extract_text(path).map_err(|error| {
                format!(
                    "Could not extract text from {}: {error}",
                    display_name(path)
                )
            })
        }
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            extract_docx_text(path, bytes)
        }
        _ => String::from_utf8(bytes.to_vec())
            .map_err(|_| format!("{} is not valid UTF-8 text.", display_name(path))),
    }
}

fn extract_docx_text(path: &Path, bytes: &[u8]) -> Result<String, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|error| {
        format!(
            "{} is not a valid Word document: {error}",
            display_name(path)
        )
    })?;
    let mut document = archive.by_name("word/document.xml").map_err(|_| {
        format!(
            "{} is missing its Word document content.",
            display_name(path)
        )
    })?;
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|error| format!("Could not read {}: {error}", display_name(path)))?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut output = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = event.name();
                let name = name.as_ref();
                if name == b"w:t" || name == b"t" {
                    in_text = true;
                }
            }
            Ok(Event::Empty(event)) => {
                let name = event.name();
                let name = name.as_ref();
                if name == b"w:tab" || name == b"tab" {
                    output.push('\t');
                } else if name == b"w:br" || name == b"br" || name == b"w:cr" || name == b"cr" {
                    output.push('\n');
                }
            }
            Ok(Event::Text(event)) if in_text => {
                let decoded = event
                    .decode()
                    .map_err(|error| format!("Could not decode {}: {error}", display_name(path)))?;
                let unescaped = quick_xml::escape::unescape(&decoded)
                    .map_err(|error| format!("Could not decode {}: {error}", display_name(path)))?;
                output.push_str(&unescaped);
            }
            Ok(Event::GeneralRef(event)) if in_text => {
                let reference = event
                    .decode()
                    .map_err(|error| format!("Could not decode {}: {error}", display_name(path)))?;
                let encoded = format!("&{reference};");
                let unescaped = quick_xml::escape::unescape(&encoded)
                    .map_err(|error| format!("Could not decode {}: {error}", display_name(path)))?;
                output.push_str(&unescaped);
            }
            Ok(Event::End(event)) => {
                let name = event.name();
                let name = name.as_ref();
                if name == b"w:t" || name == b"t" {
                    in_text = false;
                } else if (name == b"w:p" || name == b"p") && !output.ends_with('\n') {
                    output.push('\n');
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(format!("Could not parse {}: {error}", display_name(path)));
            }
            _ => {}
        }
    }
    Ok(output)
}

fn truncate_document(text: String) -> (String, bool) {
    if text.chars().count() <= MAX_DOCUMENT_CHARS {
        return (text, false);
    }
    let mut truncated = text.chars().take(MAX_DOCUMENT_CHARS).collect::<String>();
    truncated.push_str(&format!(
        "\n\n[Amplifier Studio truncated this attachment after {MAX_DOCUMENT_CHARS} characters.]"
    ));
    (truncated, true)
}

fn image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn document_media_type(path: &Path) -> Option<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        })
        .trim_start_matches('.')
        .to_ascii_lowercase();
    match extension.as_str() {
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "md" | "markdown" => Some("text/markdown"),
        "json" | "jsonl" => Some("application/json"),
        "csv" => Some("text/csv"),
        "html" | "htm" => Some("text/html"),
        "xml" => Some("application/xml"),
        "txt" | "tsv" | "yaml" | "yml" | "toml" | "css" | "scss" | "less" | "js" | "mjs"
        | "cjs" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "kt" | "swift" | "c"
        | "cc" | "cpp" | "h" | "hpp" | "sh" | "bash" | "zsh" | "fish" | "ps1" | "log" | "sql"
        | "rtf" | "env" | "ini" | "cfg" | "conf" | "properties" | "dockerfile" | "gitignore" => {
            Some("text/plain")
        }
        _ => None,
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn loads_supported_images_and_text_documents() {
        let directory = tempfile::tempdir().unwrap();
        let png = directory.path().join("diagram.png");
        let notes = directory.path().join("notes.md");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
        std::fs::write(&notes, b"# Findings\n\nThe bridge works.").unwrap();

        let attachments = load_attachments(&[png, notes]).unwrap();
        assert_eq!(attachments.len(), 2);
        assert_eq!(attachments[0].kind, "image");
        assert_eq!(attachments[0].media_type, "image/png");
        assert_eq!(attachments[1].kind, "document");
        assert_eq!(
            attachments[1].text.as_deref(),
            Some("# Findings\n\nThe bridge works.")
        );
    }

    #[test]
    fn rejects_extension_only_images() {
        let directory = tempfile::tempdir().unwrap();
        let fake = directory.path().join("not-really.png");
        std::fs::write(&fake, b"plain text").unwrap();

        let error = load_attachments(&[fake]).unwrap_err();
        assert!(error.contains("not a supported image or document"));
    }

    #[test]
    fn rejects_binary_text_files() {
        let directory = tempfile::tempdir().unwrap();
        let fake = directory.path().join("notes.md");
        std::fs::write(&fake, [0xff, 0xfe]).unwrap();

        let error = load_attachments(&[fake]).unwrap_err();
        assert!(error.contains("not valid UTF-8"));
    }

    #[test]
    fn extracts_word_document_paragraphs() {
        let directory = tempfile::tempdir().unwrap();
        let docx = directory.path().join("brief.docx");
        let file = std::fs::File::create(&docx).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>First &amp; second.</w:t></w:r></w:p><w:p><w:r><w:t>Third paragraph.</w:t></w:r></w:p></w:body></w:document>"#,
        ).unwrap();
        archive.finish().unwrap();

        let attachments = load_attachments(&[docx]).unwrap();
        assert_eq!(attachments[0].kind, "document");
        assert_eq!(
            attachments[0].text.as_deref(),
            Some("First & second.\nThird paragraph.\n")
        );
    }
}
