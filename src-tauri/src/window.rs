//! The app's windows past the first, and the tabs handed between them.
//!
//! A window is the config's own window under another label, so every window
//! gets the same frame, minimum size and background — including the Windows
//! file's frameless override, which `tauri.conf.json` alone would lose.

use std::collections::HashMap;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::pty::Sessions;

/// Tabs on their way to a window, by label, in the order they were sent.
///
/// Held here rather than emitted alone, because a window that is still
/// loading has no listener yet: it takes what is waiting once it has mounted,
/// and an event only tells an already running one to look.
#[derive(Default)]
pub struct Handoffs(Mutex<HashMap<String, Vec<String>>>);

impl Handoffs {
    /// What was waiting for a window that closed before taking it — a
    /// serialized scrollback each, which would otherwise be held for the run.
    pub fn forget(&self, label: &str) {
        self.0.lock().remove(label);
    }
}

/// Every window but `main` is labelled `w-<hex>` — the capability file
/// grants `w-*`, so a window under any other label would have no core or
/// plugin permissions.
pub fn is_window_label(label: &str) -> bool {
    label
        .strip_prefix("w-")
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_hexdigit()))
}

/// What `window_open` is asked for.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// A tab for the new window, as `src/app/handoff.ts` writes it.
    handoff: Option<String>,
    /// The tab id of the running session that moves with it.
    session: Option<String>,
    /// Where on the dragged tab the pointer holds it, in the old window's CSS
    /// pixels: the new window opens with that point under the cursor, so the
    /// tab lands where it was dropped. `None` opens it where the OS puts it.
    grab: Option<Point>,
}

/// A point in CSS pixels.
#[derive(serde::Deserialize, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Opens a new window the size of the one asking, optionally carrying a tab,
/// and answers its label.
///
/// A tab's running session belongs to the new window from this call on,
/// before that window has even loaded: the window it left may close as soon
/// as this answers, and closing ends the sessions it owns.
///
/// `async` because a synchronous command runs on the main thread, and
/// building a window there deadlocks on Windows.
#[tauri::command]
pub async fn window_open(
    app: AppHandle,
    window: tauri::Window,
    handoffs: tauri::State<'_, Handoffs>,
    sessions: tauri::State<'_, Sessions>,
    request: OpenRequest,
) -> Result<String, String> {
    let label = new_label();
    if let Some(id) = &request.session {
        sessions.move_to(id, &label);
    }
    if let Some(handoff) = request.handoff {
        handoffs
            .0
            .lock()
            .entry(label.clone())
            .or_default()
            .push(handoff);
    }
    let place = Placement {
        // A maximized window's size is the screen's, which is no size for a
        // window torn out of it — the config's default is.
        size: (!window.is_maximized().unwrap_or(false))
            .then(|| logical_size(&window))
            .flatten(),
        position: request.grab.and_then(|grab| {
            let (x, y) = desktop_cursor(&app, window.primary_monitor().ok().flatten().as_ref())?;
            Some(Carry::of(&window, grab)?.spot(x, y))
        }),
    };
    if let Err(error) = open(&app, &label, place) {
        handoffs.0.lock().remove(&label);
        if let Some(id) = &request.session {
            sessions.move_to(id, window.label());
        }
        return Err(error);
    }
    Ok(label)
}

/// What it takes to keep a window's grabbed point under the cursor, worked
/// out once per drag.
#[derive(Clone, Copy)]
pub struct Carry {
    grab: Point,
    /// Desktop units per CSS pixel.
    scale: f64,
    /// The frame above and beside the client area, in desktop units: `grab`
    /// is measured in the client area, and a window is placed by its frame —
    /// a title bar on Linux, nothing on macOS and frameless Windows.
    frame: (f64, f64),
}

impl Carry {
    pub fn of(window: &tauri::Window, grab: Point) -> Option<Self> {
        let scale = window.scale_factor().ok()?;
        let per = desktop_per_physical(scale);
        let inner = window.inner_position().ok()?;
        let outer = window.outer_position().ok()?;
        Some(Self {
            grab,
            scale: scale / per,
            frame: (
                f64::from(inner.x - outer.x) / per,
                f64::from(inner.y - outer.y) / per,
            ),
        })
    }

    /// Where the window's frame goes, in desktop units, for the grabbed point
    /// to be at `(x, y)`.
    pub fn spot(&self, x: f64, y: f64) -> (f64, f64) {
        (
            x - self.grab.x * self.scale - self.frame.0,
            y - self.grab.y * self.scale - self.frame.1,
        )
    }
}

/// Each window's tab strip, in its own CSS pixels, as it last reported it —
/// and the order windows were last focused in, the only stand-in for z-order
/// there is: nothing reports which window is on top.
#[derive(Default)]
pub struct Strips {
    rects: Mutex<HashMap<String, Rect>>,
    focus: Mutex<(u64, HashMap<String, u64>)>,
}

impl Strips {
    /// A closed window's strip, which no drop may land on.
    pub fn forget(&self, label: &str) {
        self.rects.lock().remove(label);
        self.focus.lock().1.remove(label);
    }

    /// A window came forward.
    pub fn focused(&self, label: &str) {
        let mut focus = self.focus.lock();
        focus.0 += 1;
        let order = focus.0;
        focus.1.insert(label.to_string(), order);
    }

    fn recency(&self, label: &str) -> u64 {
        self.focus.lock().1.get(label).copied().unwrap_or(0)
    }
}

/// A rectangle in CSS pixels, relative to a window's client area.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Records where the calling window's tab strip is, for `window_drop_target`.
/// Reported by the window because only its layout knows; the strip's place on
/// screen is worked out at the drop, since the window may have moved since.
#[tauri::command]
pub fn window_strip(window: tauri::Window, strips: tauri::State<'_, Strips>, rect: Rect) {
    strips.rects.lock().insert(window.label().to_string(), rect);
}

/// Where a tab dragged out of the calling window would land if dropped now —
/// `carrying` when it is the window's only tab, whose window it has been
/// moving along with it.
///
/// Answered from the cursor's position on the desktop rather than anything
/// the dragging window saw, because the drop happens over another window,
/// which the dragging page cannot see into.
#[tauri::command]
pub fn window_drop_target(
    app: AppHandle,
    window: tauri::Window,
    strips: tauri::State<'_, Strips>,
    carrying: bool,
) -> Result<DropTarget, String> {
    let primary = window.primary_monitor().ok().flatten();
    target_under_cursor(&app, &strips, window.label(), primary.as_ref(), carrying)
        .map(|(target, _)| target)
        .ok_or_else(|| "no cursor position".to_string())
}

/// Where a tab dragged out of window `source` would land now, and the cursor
/// in desktop units. `primary` is the primary display, asked of a window by
/// the caller: the app-level monitor calls run on whatever thread calls them,
/// and crash off the main one.
///
/// `carrying` is a lone tab dragging its whole window along: the window is
/// under the cursor by construction, so it cannot be what the drop is over.
pub fn target_under_cursor(
    app: &AppHandle,
    strips: &Strips,
    source: &str,
    primary: Option<&tauri::Monitor>,
    carrying: bool,
) -> Option<(DropTarget, (f64, f64))> {
    let cursor = desktop_cursor(app, primary)?;
    let reported = strips.rects.lock().clone();
    let placed: Vec<Placed> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label != crate::ghost::LABEL)
        .filter_map(|(label, other)| {
            let recency = strips.recency(&label);
            placed(label, &other, reported.get(other.label()), recency)
        })
        .collect();
    Some((drop_target(cursor, source, &placed, carrying), cursor))
}

/// What a dropped tab lands on.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DropTarget {
    /// Another window's tab strip, at `x` CSS pixels along that window.
    Strip { label: String, x: f64 },
    /// Over the window it came from. A tab with others beside it gets a new
    /// window there all the same, as in Chrome; it matters only to a window's
    /// only tab, which is already where it belongs.
    Source,
    /// No window: the tab wants one of its own.
    Outside,
}

/// A window as the drop sees it, in desktop units — points on macOS,
/// physical pixels elsewhere; see `desktop_per_physical`.
#[derive(Debug)]
pub struct Placed {
    pub label: String,
    /// Its client area's top-left corner.
    pub origin: (f64, f64),
    /// Desktop units per CSS pixel.
    pub scale: f64,
    /// Its whole frame: left, top, right, bottom.
    pub frame: (f64, f64, f64, f64),
    pub strip: Option<Rect>,
    /// When it was last focused; later is higher.
    pub recency: u64,
}

/// How far outside a strip a drop still counts as on it, in CSS pixels. One
/// number for entering and for leaving, so a tab at the rim does not bounce.
pub const STRIP_MARGIN: f64 = 12.0;

/// The pure half of `window_drop_target`.
///
/// The dragging window is the focused one, so it is in front: a point inside
/// its frame is over it, whatever strip lies behind. Elsewhere windows
/// overlap and nothing reports which is on top, so of the strips under the
/// cursor the most recently focused window's wins.
pub fn drop_target(
    cursor: (f64, f64),
    source: &str,
    windows: &[Placed],
    carrying: bool,
) -> DropTarget {
    let inside = |window: &Placed| {
        let (left, top, right, bottom) = window.frame;
        (left..right).contains(&cursor.0) && (top..bottom).contains(&cursor.1)
    };
    if !carrying && windows.iter().any(|w| w.label == source && inside(w)) {
        return DropTarget::Source;
    }
    let over = windows
        .iter()
        .filter(|window| window.label != source && on_strip(cursor, window))
        .max_by_key(|window| window.recency);
    match over {
        Some(window) => DropTarget::Strip {
            label: window.label.clone(),
            x: (cursor.0 - window.origin.0) / window.scale,
        },
        None => DropTarget::Outside,
    }
}

fn on_strip(cursor: (f64, f64), window: &Placed) -> bool {
    let Some(strip) = window.strip else {
        return false;
    };
    let to_screen = |css: f64| css * window.scale;
    let margin = to_screen(STRIP_MARGIN);
    let left = window.origin.0 + to_screen(strip.left) - margin;
    let top = window.origin.1 + to_screen(strip.top) - margin;
    let right = left + to_screen(strip.width) + 2.0 * margin;
    let bottom = top + to_screen(strip.height) + 2.0 * margin;
    (left..right).contains(&cursor.0) && (top..bottom).contains(&cursor.1)
}

fn placed(
    label: String,
    window: &WebviewWindow,
    strip: Option<&Rect>,
    recency: u64,
) -> Option<Placed> {
    // A minimized window is not under anything.
    if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let unit = |physical: f64| physical / desktop_per_physical(scale);
    let origin = window.inner_position().ok()?;
    let outer = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Placed {
        label,
        origin: (unit(f64::from(origin.x)), unit(f64::from(origin.y))),
        scale: scale / desktop_per_physical(scale),
        frame: (
            unit(f64::from(outer.x)),
            unit(f64::from(outer.y)),
            unit(f64::from(outer.x) + f64::from(size.width)),
            unit(f64::from(outer.y) + f64::from(size.height)),
        ),
        strip: strip.copied(),
        recency,
    })
}

/// A point in desktop units as a position a window can be moved to.
#[cfg(target_os = "macos")]
pub fn desktop_position(x: f64, y: f64) -> tauri::Position {
    tauri::LogicalPosition::new(x, y).into()
}

#[cfg(not(target_os = "macos"))]
pub fn desktop_position(x: f64, y: f64) -> tauri::Position {
    tauri::PhysicalPosition::new(x, y).into()
}

/// The unit the drop compares positions in, per physical pixel of a window
/// at `scale`.
///
/// macOS reports the cursor scaled by the *primary* display's factor but each
/// window's position by *its own*, so on a Retina laptop beside a 1x display
/// the two disagree; comparing in points, the unit both started in, is
/// exact. Windows and X11 report both in true physical pixels already.
#[cfg(target_os = "macos")]
fn desktop_per_physical(scale: f64) -> f64 {
    scale
}

#[cfg(not(target_os = "macos"))]
fn desktop_per_physical(_scale: f64) -> f64 {
    1.0
}

/// The cursor in the unit `desktop_per_physical` describes.
#[cfg(target_os = "macos")]
fn desktop_cursor(app: &AppHandle, primary: Option<&tauri::Monitor>) -> Option<(f64, f64)> {
    let cursor = app.cursor_position().ok()?;
    let primary = primary?.scale_factor();
    Some((cursor.x / primary, cursor.y / primary))
}

#[cfg(not(target_os = "macos"))]
fn desktop_cursor(app: &AppHandle, _primary: Option<&tauri::Monitor>) -> Option<(f64, f64)> {
    if on_wayland() {
        return None;
    }
    let cursor = app.cursor_position().ok()?;
    Some((cursor.x, cursor.y))
}

/// Wayland tells an app neither where the cursor is nor where its windows
/// are — both read `(0, 0)` — so a hit-test there would find every window's
/// strip under the cursor and merge into whichever was focused last. With no
/// position, a drop there gets a new window and the label stays hidden.
#[cfg(not(target_os = "macos"))]
fn on_wayland() -> bool {
    cfg!(target_os = "linux")
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var("GDK_BACKEND").map_or(true, |backend| !backend.starts_with("x11"))
}

fn logical_size(window: &tauri::Window) -> Option<tauri::LogicalSize<f64>> {
    let size = window.inner_size().ok()?;
    Some(size.to_logical(window.scale_factor().ok()?))
}

/// How a new window is placed; `None` takes the config's own.
#[derive(Default)]
struct Placement {
    size: Option<tauri::LogicalSize<f64>>,
    /// Its frame's top-left, in desktop units — see `desktop_per_physical`.
    position: Option<(f64, f64)>,
}

/// Sends a tab to a window that is already open.
#[tauri::command]
pub fn window_send(
    app: AppHandle,
    window: tauri::Window,
    handoffs: tauri::State<'_, Handoffs>,
    sessions: tauri::State<'_, Sessions>,
    label: String,
    handoff: String,
    session: Option<String>,
) -> Result<(), String> {
    let target = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window {label}"))?;
    if let Some(id) = &session {
        sessions.move_to(id, &label);
    }
    handoffs
        .0
        .lock()
        .entry(label.clone())
        .or_default()
        .push(handoff);
    if let Err(error) = target.emit_to(&label, "muster://handoff", ()) {
        // Taken back whole: the sender resumes the tab, so nothing of it may
        // stay queued for a window that would adopt it later.
        if let Some(queued) = handoffs.0.lock().get_mut(&label) {
            queued.pop();
        }
        if let Some(id) = &session {
            sessions.move_to(id, window.label());
        }
        return Err(error.to_string());
    }
    // The tab came forward in the window it left, so it does in this one.
    let _ = target.set_focus();
    Ok(())
}

/// The tabs waiting for the calling window, which it now owns.
#[tauri::command]
pub fn window_take(window: tauri::Window, handoffs: tauri::State<'_, Handoffs>) -> Vec<String> {
    handoffs.0.lock().remove(window.label()).unwrap_or_default()
}

/// Reopens the windows whose tab lists were stored when the app last quit.
pub fn restore(app: &AppHandle) {
    for label in crate::store::stored_windows(app) {
        let _ = open(app, &label, Placement::default());
    }
}

/// The window to answer an app-wide gesture with — a Dock click, a second
/// launch: the focused one, else `main`, else any.
pub fn front(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    windows
        .values()
        .filter(|window| window.label() != crate::ghost::LABEL)
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| windows.get("main"))
        .or_else(|| {
            windows
                .values()
                .find(|window| window.label() != crate::ghost::LABEL)
        })
        .cloned()
}

fn open(app: &AppHandle, label: &str, place: Placement) -> Result<WebviewWindow, String> {
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window in the config")?;
    config.label = label.to_string();
    if let Some(size) = place.size {
        config.width = size.width;
        config.height = size.height;
    }
    // Placed after it is built, hidden until then: the config takes logical
    // pixels, converted at whichever monitor's scale the OS picks, while the
    // cursor is in desktop units.
    if place.position.is_some() {
        config.visible = false;
        config.center = false;
    }
    let window = WebviewWindowBuilder::from_config(app, &config)
        .and_then(|builder| builder.build())
        .map_err(|e| e.to_string())?;
    if let Some((x, y)) = place.position {
        let _ = window.set_position(desktop_position(x, y));
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(window)
}

/// A label no window has had: the store keys tab lists by label, so a reused
/// one would open a new window onto a closed window's tabs.
fn new_label() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default(),
    );
    format!("w-{:016x}", hasher.finish())
}

#[cfg(test)]
#[path = "window_tests.rs"]
mod tests;
