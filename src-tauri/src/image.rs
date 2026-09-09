//! Reading an image off disk so a terminal tab can preview it.
//!
//! The webview never fetches anything itself: it asks for a path, and gets
//! back a `data:` URI — so no remote host is contacted to show a local file,
//! and the policy needs no `https:` source for images.
//!
//! The MIME type comes from the extension, not the bytes. An SVG therefore
//! reaches an `<img>` tag on the strength of its name alone; that is safe only
//! because an SVG loaded through `<img>` gets no scripting and no subresource
//! loads, which is a browser rule this app does not itself enforce.

use std::path::Path;

use base64::Engine;

/// An image ready to drop into an `<img src>`.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// `data:<mime>;base64,…`
    pub data_url: String,
    pub bytes: usize,
    /// Path as given, for the caption.
    pub path: String,
}

/// Extensions worth previewing, mapped to the MIME type the webview needs.
/// An allowlist rather than a sniff: the point is to refuse anything that is
/// not an image, before reading it.
const PREVIEWABLE: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("bmp", "image/bmp"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
];

/// A base64 `data:` URI costs a third more than the file, and the whole thing
/// crosses the IPC bridge as one string, so this is a real ceiling rather than
/// a formality.
const MAX_BYTES: usize = 12 * 1024 * 1024;

/// The MIME type for a path, or `None` when it is not a previewable image.
pub fn mime_for(path: &str) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    PREVIEWABLE
        .iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, mime)| *mime)
}

#[tauri::command]
pub async fn read_image(path: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || read(path))
        .await
        .map_err(|error| error.to_string())?
}

fn read(path: String) -> Result<Preview, String> {
    let mime = mime_for(&path).ok_or_else(|| format!("not a previewable image: {path}"))?;

    // `symlink_metadata` does not follow the link, which is the point: a
    // repository can ship `diagram.svg -> ~/.ssh/id_rsa`, and the extension
    // allowlist only ever inspected the name.
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!("refusing to follow a symlink: {path}"));
    }
    if !metadata.is_file() {
        return Err(format!("not a file: {path}"));
    }
    // Checked before reading, so an enormous file is never loaded into memory.
    let bytes = metadata.len() as usize;
    if bytes > MAX_BYTES {
        return Err(format!("too large to preview: {} MB", bytes / 1_048_576));
    }

    let contents = std::fs::read(&path).map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&contents);
    Ok(Preview {
        data_url: format!("data:{mime};base64,{encoded}"),
        bytes: contents.len(),
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_common_image_extensions() {
        assert_eq!(mime_for("/tmp/shot.png"), Some("image/png"));
        assert_eq!(mime_for("/tmp/photo.jpg"), Some("image/jpeg"));
        assert_eq!(mime_for("/tmp/photo.jpeg"), Some("image/jpeg"));
        assert_eq!(mime_for("diagram.svg"), Some("image/svg+xml"));
    }

    #[test]
    fn an_extension_is_matched_whatever_its_case() {
        assert_eq!(mime_for("/tmp/SHOT.PNG"), Some("image/png"));
        assert_eq!(mime_for("/tmp/Photo.JpEg"), Some("image/jpeg"));
    }

    #[test]
    fn refuses_anything_that_is_not_an_image() {
        for path in [
            "/etc/passwd",
            "notes.txt",
            "run.sh",
            "archive.tar.gz",
            "noext",
        ] {
            assert_eq!(mime_for(path), None, "{path} should not be previewable");
        }
    }

    #[test]
    fn a_dotfile_is_not_mistaken_for_an_extension() {
        // `Path::extension` returns None for a leading-dot name with no suffix.
        assert_eq!(mime_for("/home/ada/.png"), None);
        assert_eq!(mime_for(".gitignore"), None);
    }

    #[test]
    fn refuses_a_non_image_before_touching_the_filesystem() {
        // The path does not exist; the extension check must reject it anyway.
        let error = read("/definitely/not/here.txt".into()).unwrap_err();
        assert!(error.contains("not a previewable image"), "{error}");
    }

    #[test]
    fn reports_a_missing_file_rather_than_panicking() {
        let error = read("/definitely/not/here.png".into()).unwrap_err();
        assert!(!error.contains("not a previewable image"), "{error}");
    }

    #[test]
    fn refuses_a_directory_that_merely_looks_like_an_image() {
        let dir = std::env::temp_dir().join("muster-preview-test.png");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let error = read(dir.to_string_lossy().into()).unwrap_err();
        let _ = std::fs::remove_dir(&dir);
        assert!(error.contains("not a file"), "{error}");
    }

    #[test]
    fn refuses_a_symlink_however_it_is_named() {
        let dir = std::env::temp_dir().join(format!("muster-symlink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let secret = dir.join("secret");
        std::fs::write(&secret, b"private").expect("write");
        let link = dir.join("diagram.png");
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");

        let error = read(link.to_string_lossy().into()).unwrap_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(error.contains("symlink"), "{error}");
    }

    #[test]
    fn encodes_a_real_file_as_a_data_uri() {
        // The smallest valid PNG: an 8-bit 1x1 image.
        const PIXEL: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89,
        ];
        let path = std::env::temp_dir().join("muster-preview-test-pixel.png");
        std::fs::write(&path, PIXEL).expect("write");

        let preview = read(path.to_string_lossy().into()).expect("read");
        let _ = std::fs::remove_file(&path);

        assert!(preview.data_url.starts_with("data:image/png;base64,"));
        assert_eq!(preview.bytes, PIXEL.len());
        assert!(
            preview.data_url.len() > PIXEL.len(),
            "base64 expands the payload"
        );
    }
}
