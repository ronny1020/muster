//! Where the app's own state lives: one JSON file beside the journal, read
//! once and written whole. See AGENTS.md's "Tabs and settings belong to the
//! app" invariant for why it is not the webview's `localStorage`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, EventTarget, Manager, State};

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
///
/// Every other window is told, because each holds the store in a cache it
/// read at startup: without the news, a settings change in one window would
/// be undone by the next write from another.
#[tauri::command(async)]
pub fn state_write(
    app: AppHandle,
    window: tauri::Window,
    store: State<'_, Store>,
    key: String,
    value: Option<String>,
) {
    let mut held = store.0.lock().expect("store poisoned");
    // A closing window's last deck write can land after `Destroyed` forgot
    // its tabs, and would bring the window back on the next launch. Checked
    // under the lock `forget_window` takes, so the two cannot interleave.
    if let Some(label) = key.strip_prefix(DECK_PREFIX) {
        if app.get_webview_window(label).is_none() {
            return;
        }
    }
    let entries = held.get_or_insert_with(|| load(&app));
    match &value {
        Some(value) => entries.insert(key.clone(), value.clone()),
        None => entries.remove(&key),
    };
    let _ = save(&app, entries);
    drop(held);
    let writer = window.label().to_string();
    let _ = app.emit_filter(
        "muster://state",
        StateChange { key, value },
        |target| !matches!(target, EventTarget::WebviewWindow { label } if *label == writer),
    );
}

/// One entry another window changed.
#[derive(Clone, serde::Serialize)]
struct StateChange {
    key: String,
    value: Option<String>,
}

/// The labels of the windows that have a tab list stored, besides `main`, which
/// the config always opens — the windows to bring back on launch.
///
/// `main` always opens, so when its own list is gone — it was closed while
/// another window stayed open — one stored window's tabs become `main`'s
/// rather than opening beside a blank `main`.
pub fn stored_windows(app: &AppHandle) -> Vec<String> {
    let store = app.state::<Store>();
    let mut held = store.0.lock().expect("store poisoned");
    let entries = held.get_or_insert_with(|| load(app));
    if promote_to_main(entries) {
        let _ = save(app, entries);
    }
    windows_in(entries)
}

/// Moves one stored window's tabs to `main` when `main` has none stored.
fn promote_to_main(entries: &mut BTreeMap<String, String>) -> bool {
    let main = format!("{DECK_PREFIX}main");
    if entries.contains_key(&main) {
        return false;
    }
    let Some(label) = windows_in(entries).into_iter().next() else {
        return false;
    };
    let Some(deck) = entries.remove(&format!("{DECK_PREFIX}{label}")) else {
        return false;
    };
    entries.insert(main, deck);
    true
}

fn windows_in(entries: &BTreeMap<String, String>) -> Vec<String> {
    entries
        .keys()
        .filter_map(|key| key.strip_prefix(DECK_PREFIX))
        .filter(|label| *label != "main" && crate::window::is_window_label(label))
        .map(str::to_string)
        .collect()
}

/// Forgets a window's tab list, for a window closed while others stay open:
/// like Chrome, its tabs go with it rather than coming back next launch.
pub fn forget_window(app: &AppHandle, label: &str) {
    let store = app.state::<Store>();
    let mut held = store.0.lock().expect("store poisoned");
    let entries = held.get_or_insert_with(|| load(app));
    if entries.remove(&format!("{DECK_PREFIX}{label}")).is_some() {
        let _ = save(app, entries);
    }
}

/// The key each window's tab list is stored under, followed by its label —
/// `persist.ts` writes it.
const DECK_PREFIX: &str = "muster.deck:";

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
