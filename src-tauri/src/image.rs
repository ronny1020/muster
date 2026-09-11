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

/// Reads an image for the webview.
///
/// `within` confines it: the resolved path must sit inside that directory,
/// resolved too. A caller that has one passes it — a markdown document asks
/// for its own folder, because rendering it reads every image it names with no
/// click at all, and a repository can point a folder anywhere with a committed
/// symlink. The terminal's overlay and the background picker pass nothing:
/// there the user named the file.
#[tauri::command]
pub async fn read_image(path: String, within: Option<String>) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || read(path, within))
        .await
        .map_err(|error| error.to_string())?
}

/// Whether `path` resolves to somewhere inside `root`, links and all.
///
/// Textual checks cannot answer this: `docs/pics/x.png` is inside `docs` by
/// spelling even when `pics` is a link to another disk. Both sides are
/// canonicalised, so both are compared as the filesystem sees them.
fn inside(root: &str, path: &Path) -> bool {
    let (Ok(root), Ok(path)) = (std::fs::canonicalize(root), std::fs::canonicalize(path)) else {
        return false;
    };
    path.starts_with(root)
}

#[cfg(test)]
fn read_unconfined(path: String) -> Result<Preview, String> {
    read(path, None)
}

fn read(path: String, within: Option<String>) -> Result<Preview, String> {
    if let Some(root) = within.as_deref() {
        if !inside(root, Path::new(&path)) {
            return Err(format!("outside this document's folder: {path}"));
        }
    }
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
#[path = "image_tests.rs"]
mod tests;
