//! The font families installed on this machine, and which hold a grid.
//!
//! Both answers come from Rust: enumeration needs a platform API neither
//! webview exposes, and the monospace flag lives inside the font file.
//!
//! Shape borrowed from Warp: enumerate, drop what cannot draw Latin, read the
//! font's own flag.

use font_kit::source::SystemSource;

/// A family name, and whether the picker should offer it for a terminal.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    pub monospaced: bool,
}

/// Every installed family, sorted, each marked.
///
/// Reached only when the font picker opens, because answering parses every
/// font file the platform knows about — including the user-writable
/// `~/Library/Fonts` and `~/.local/share/fonts` — through CoreText,
/// DirectWrite or FreeType, in the process that owns every PTY. A click asks
/// for that; startup does not.
///
/// On the blocking pool because it takes 3.2s for 248 families here, and
/// `pty_write` and `pty_resize` share the worker pool.
///
/// The `catch_unwind` holds only in dev and test: `[profile.release]` sets
/// `panic = "abort"`, so a platform source that panics — font-kit's fontconfig
/// backend unwraps a failed `dlopen` — aborts the app. Every check in
/// AGENTS.md's list runs under `panic = "unwind"`.
#[tauri::command]
pub async fn font_families() -> Vec<FontFamily> {
    tauri::async_runtime::spawn_blocking(|| std::panic::catch_unwind(families).unwrap_or_default())
        .await
        .unwrap_or_default()
}

/// The cached answer, or a fresh attempt when the last one came back empty.
///
/// Empty means the platform source was unreachable, so it is not stored: the
/// frontend's fallback list covers it and a later call may succeed. The lock
/// is held across the read so the first caller pays the 3.2s and the rest wait
/// on its answer.
fn families() -> Vec<FontFamily> {
    static FAMILIES: std::sync::Mutex<Option<Vec<FontFamily>>> = std::sync::Mutex::new(None);
    let mut slot = FAMILIES.lock().unwrap_or_else(|held| held.into_inner());
    if let Some(cached) = slot.as_ref() {
        return cached.clone();
    }
    let found = read_families();
    if !found.is_empty() {
        *slot = Some(found.clone());
    }
    found
}

fn read_families() -> Vec<FontFamily> {
    let source = SystemSource::new();
    let mut names = source.all_families().unwrap_or_default();
    names.sort_by_key(|name| name.to_lowercase());
    names.dedup();
    names
        .into_iter()
        .map(|name| {
            let monospaced = source
                .select_family_by_name(&name)
                .map(|family| family.fonts().iter().any(draws_a_fixed_pitch_grid))
                // Any face is enough: Osaka ships both fixed and variable
                // ones, and the picker gives one answer per family.
                .unwrap_or(false);
            FontFamily { name, monospaced }
        })
        .collect()
}

/// Fixed-pitch *and* able to draw Latin.
///
/// Latin coverage matters because a machine carries dozens of Arabic, Hebrew,
/// Indic and emoji faces that are fixed-pitch in their own script with no `W`;
/// offered here, they would draw every column through a fallback face.
fn draws_a_fixed_pitch_grid(handle: &font_kit::handle::Handle) -> bool {
    handle
        .load()
        .map(|font| font.is_monospace() && font.glyph_for_char('W').is_some())
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "fonts_tests.rs"]
mod tests;
