//! Where the app's own state lives: one JSON file beside the journal, read
//! once and written whole. See AGENTS.md's "Tabs and settings belong to the
//! app" invariant for why it is not the webview's `localStorage`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

/// The whole store, held in memory so a write does not re-read the file.
#[derive(Default)]
pub struct Store(Mutex<Option<BTreeMap<String, String>>>);

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("state.json"))
}

/// Reads the store, answering an empty one for anything unreadable: losing the
/// tabs is bad, and refusing to start is worse.
fn load_from(file: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Replaces the file in one step, so an interrupted write cannot leave a
/// half-written state that parses as an empty one and loses every tab.
fn save_to(file: &Path, entries: &BTreeMap<String, String>) -> Option<()> {
    let dir = file.parent()?;
    fs::create_dir_all(dir).ok()?;
    let text = serde_json::to_string(entries).ok()?;
    let temp = file.with_extension("json.tmp");
    let mut handle = fs::File::create(&temp).ok()?;
    handle.write_all(text.as_bytes()).ok()?;
    handle.sync_all().ok()?;
    fs::rename(&temp, file).ok()
}

fn load(app: &AppHandle) -> BTreeMap<String, String> {
    path(app).map(|file| load_from(&file)).unwrap_or_default()
}

fn save(app: &AppHandle, entries: &BTreeMap<String, String>) -> Option<()> {
    save_to(&path(app)?, entries)
}

#[tauri::command]
pub fn state_read(app: AppHandle, store: State<'_, Store>) -> BTreeMap<String, String> {
    let mut held = store.0.lock().expect("store poisoned");
    held.get_or_insert_with(|| load(&app)).clone()
}

/// Stores `value` under `key`, or forgets the key when `value` is `None`.
/// `async` so the fsync runs off the thread that draws the window: a settings
/// field writes on every keystroke, and a blocking command body is dispatched
/// inline, so each one stalled the UI for a whole-store write and flush.
#[tauri::command(async)]
pub fn state_write(app: AppHandle, store: State<'_, Store>, key: String, value: Option<String>) {
    let mut held = store.0.lock().expect("store poisoned");
    let entries = held.get_or_insert_with(|| load(&app));
    match value {
        Some(value) => entries.insert(key, value),
        None => entries.remove(&key),
    };
    let _ = save(&app, entries);
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
