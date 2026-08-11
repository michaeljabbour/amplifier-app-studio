use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Runtime, Webview, WebviewEvent};

const MAX_IMAGE_COUNT: usize = 4;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const IMAGE_DROP_EVENT: &str = "app://native-image-drop";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeImage {
    name: String,
    media_type: &'static str,
    data: String,
    size: u64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum NativeImageDrop {
    Enter,
    Leave,
    Drop { images: Vec<NativeImage> },
    Error { message: String },
}

pub fn handle_webview_event<R: Runtime>(webview: &Webview<R>, event: &WebviewEvent) {
    let immediate = match event {
        WebviewEvent::DragDrop(tauri::DragDropEvent::Enter { .. }) => Some(NativeImageDrop::Enter),
        WebviewEvent::DragDrop(tauri::DragDropEvent::Leave) => Some(NativeImageDrop::Leave),
        _ => None,
    };
    if let Some(payload) = immediate {
        let _ = webview.emit(IMAGE_DROP_EVENT, payload);
        return;
    }

    let WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event else {
        return;
    };
    let paths = paths.clone();
    let webview = webview.clone();
    std::thread::spawn(move || {
        let payload = match load_images(&paths) {
            Ok(images) => NativeImageDrop::Drop { images },
            Err(message) => NativeImageDrop::Error { message },
        };
        let _ = webview.emit(IMAGE_DROP_EVENT, payload);
    });
}

fn load_images(paths: &[PathBuf]) -> Result<Vec<NativeImage>, String> {
    if paths.is_empty() {
        return Err("Drop a PNG, JPEG, GIF, or WebP image.".to_owned());
    }
    if paths.len() > MAX_IMAGE_COUNT {
        return Err(format!("Attach up to {MAX_IMAGE_COUNT} images per turn."));
    }

    let mut total = 0_u64;
    let mut images = Vec::with_capacity(paths.len());
    for path in paths {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("Could not read {}: {error}", display_name(path)))?;
        if !metadata.is_file() {
            return Err(format!("{} is not a file.", display_name(path)));
        }
        let size = metadata.len();
        if size == 0 || size > MAX_IMAGE_BYTES {
            return Err("Each image must be non-empty and no larger than 20 MB.".to_owned());
        }
        total = total.saturating_add(size);
        if total > MAX_IMAGE_TOTAL_BYTES {
            return Err("Image attachments can total up to 32 MB per turn.".to_owned());
        }

        let bytes = std::fs::read(path)
            .map_err(|error| format!("Could not read {}: {error}", display_name(path)))?;
        let media_type = image_media_type(&bytes).ok_or_else(|| {
            format!(
                "{} is not a valid PNG, JPEG, GIF, or WebP image.",
                display_name(path)
            )
        })?;
        images.push(NativeImage {
            name: display_name(path),
            media_type,
            data: STANDARD.encode(bytes),
            size,
        });
    }
    Ok(images)
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

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_supported_images_from_native_paths() {
        let directory = tempfile::tempdir().unwrap();
        let png = directory.path().join("diagram.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();

        let images = load_images(&[png]).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].name, "diagram.png");
        assert_eq!(images[0].media_type, "image/png");
        assert_eq!(images[0].size, 12);
    }

    #[test]
    fn rejects_extension_only_images() {
        let directory = tempfile::tempdir().unwrap();
        let fake = directory.path().join("not-really.png");
        std::fs::write(&fake, b"plain text").unwrap();

        let error = load_images(&[fake]).unwrap_err();
        assert!(error.contains("not a valid PNG"));
    }
}
