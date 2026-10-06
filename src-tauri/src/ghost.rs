//! The label that follows a tab dragged off its strip.
//!
//! The pointer leaves the window it is dragging from, and a page cannot draw
//! outside its own window, so the label is a window of its own: borderless,
//! transparent, click-through and never focused. While a drag is torn off, a
//! thread moves it to the cursor and asks the same question the drop will —
//! `window::target_under_cursor` — because no other window hears a single
//! event while the button is held, so nothing else can know what is under it.

use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::window::{desktop_position, target_under_cursor, Carry, DropTarget, Point, Strips};

/// The label window's own label, which every list of real windows skips.
pub const LABEL: &str = "ghost";

/// Numbers each drag, so the follow loop of one that has ended stops even if
/// another has started — and holds what the label last said, for a label
/// page that was still loading when it was said.
#[derive(Default)]
pub struct Ghost {
    /// The drag the label is following, numbered by the page.
    drag: AtomicU64,
    /// The highest drag the page has ended. `ghost_show` is async and
    /// `ghost_hide` is not, so a quick tear-and-release can deliver the hide
    /// first — and the show that follows must not bring the label back.
    ended: AtomicU64,
    said: Mutex<Option<GhostState>>,
    /// When the dragging page last said it is still dragging.
    beat: Mutex<Option<Instant>>,
}

/// What the label shows about the tab it follows.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhostRequest {
    title: String,
    accent: String,
    /// The window's only tab, which carries its window instead of opening one.
    lone: bool,
    /// Where on the tab the pointer holds it, in the window's CSS pixels: a
    /// lone tab's window follows the pointer by this point.
    grab: Option<Point>,
    /// Which drag this is, counted by the page; `ghost_hide` quotes it.
    drag: u64,
}

/// What the label says, and what the window under it shows.
#[derive(serde::Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GhostState {
    title: String,
    accent: String,
    /// `strip` over another window's tabs, `window` for a lone tab carrying
    /// its window, `new` for anywhere else.
    over: &'static str,
}

/// Where a hovered window should mark the tab's landing place, in its CSS
/// pixels, or `None` once the drag has left it — in the colour of the agent
/// the tab is running.
#[derive(serde::Serialize, Clone)]
struct Hover {
    x: Option<f64>,
    accent: String,
}

/// The most of a title the label shows. A title is whatever the agent set,
/// and the label is redrawn from it for the whole drag.
const TITLE_CHARS: usize = 120;

/// How far the label sits from the cursor, so it never hides what is under it.
const OFFSET: (f64, f64) = (14.0, 18.0);
/// One frame at 60Hz.
const FRAME: Duration = Duration::from_millis(16);
/// How long the label outlives the dragging page's last heartbeat. A page
/// that reloads or dies mid-drag never sends the hide, and the label would
/// otherwise follow the pointer for the rest of the run.
const SILENCE: Duration = Duration::from_millis(1000);

/// Shows the label beside the cursor and keeps it there until `ghost_hide`.
///
/// `async`, because the first call builds the label's window, and building a
/// window in a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn ghost_show(
    app: AppHandle,
    window: tauri::Window,
    ghost: tauri::State<'_, Ghost>,
    request: GhostRequest,
) -> Result<(), String> {
    let drag = request.drag;
    if drag <= ghost.ended.load(Ordering::SeqCst) {
        return Ok(());
    }
    ghost.drag.store(drag, Ordering::SeqCst);
    *ghost.beat.lock() = Some(Instant::now());
    let label = label_window(&app)?;
    let source = window.label().to_string();
    let primary = window.primary_monitor().ok().flatten();
    let carry = request
        .grab
        .filter(|_| request.lone)
        .and_then(|grab| Carry::of(&window, grab));
    let request = GhostRequest {
        title: request.title.chars().take(TITLE_CHARS).collect(),
        ..request
    };
    std::thread::spawn(move || {
        let drag = Drag {
            id: drag,
            source,
            primary,
            carry,
        };
        follow(&app, &label, &drag, &request);
    });
    Ok(())
}

/// The dragging page is still dragging; see `SILENCE`.
#[tauri::command]
pub fn ghost_beat(ghost: tauri::State<'_, Ghost>) {
    *ghost.beat.lock() = Some(Instant::now());
}

/// What the label says now, for its page to read once it has mounted: the
/// first word of the first drag is sent while that page is still loading.
#[tauri::command]
pub fn ghost_state(ghost: tauri::State<'_, Ghost>) -> Option<GhostState> {
    ghost.said.lock().clone()
}

/// Hides the label and ends drag `drag`, and every drag before it.
#[tauri::command]
pub fn ghost_hide(app: AppHandle, ghost: tauri::State<'_, Ghost>, drag: u64) {
    ghost.ended.fetch_max(drag, Ordering::SeqCst);
    // A late hide for an earlier drag leaves a newer one's label alone.
    if ghost.drag.load(Ordering::SeqCst) > drag {
        return;
    }
    *ghost.said.lock() = None;
    if let Some(label) = app.get_webview_window(LABEL) {
        let _ = label.hide();
    }
}

/// Closes the label's window, for when the last real window has closed: a
/// hidden window still keeps the app running.
pub fn close(app: &AppHandle) {
    if let Some(label) = app.get_webview_window(LABEL) {
        let _ = label.destroy();
    }
}

/// One drag the label follows.
struct Drag {
    id: u64,
    source: String,
    primary: Option<tauri::Monitor>,
    /// Set for a lone tab, whose window moves with the pointer.
    carry: Option<Carry>,
}

fn follow(app: &AppHandle, label: &WebviewWindow, drag: &Drag, request: &GhostRequest) {
    let strips = app.state::<Strips>();
    let ghost = app.state::<Ghost>();
    let carried = drag
        .carry
        .and_then(|carry| Some((carry, app.get_webview_window(&drag.source)?)));
    let mut said: Option<GhostState> = None;
    let mut hovered: Option<String> = None;
    let current = |ghost: &Ghost| {
        ghost.drag.load(Ordering::SeqCst) == drag.id && ghost.ended.load(Ordering::SeqCst) < drag.id
    };
    while current(&ghost) {
        let silent = !matches!(*ghost.beat.lock(), Some(beat) if beat.elapsed() <= SILENCE);
        if silent {
            ghost.ended.fetch_max(drag.id, Ordering::SeqCst);
            *ghost.said.lock() = None;
            let _ = label.hide();
            break;
        }
        let found = target_under_cursor(
            app,
            &strips,
            &drag.source,
            drag.primary.as_ref(),
            carried.is_some(),
        );
        if let Some((target, (x, y))) = found {
            if let Some((carry, window)) = &carried {
                let (left, top) = carry.spot(x, y);
                let _ = window.set_position(desktop_position(left, top));
            }
            let _ = label.set_position(desktop_position(x + OFFSET.0, y + OFFSET.1));
            let over = match (&target, request.lone) {
                (DropTarget::Strip { .. }, _) => "strip",
                (_, true) => "window",
                _ => "new",
            };
            let state = GhostState {
                title: request.title.clone(),
                accent: request.accent.clone(),
                over,
            };
            if said.as_ref() != Some(&state) {
                *ghost.said.lock() = Some(state.clone());
                let _ = app.emit_to(LABEL, "muster://ghost", state.clone());
                // Shown only for a drag that is still on, and checked again
                // after: a hide that ran while this frame was working out
                // the target must not be undone by it.
                if said.is_none() && current(&ghost) {
                    let _ = label.show();
                    if !current(&ghost) {
                        let _ = label.hide();
                    }
                }
                said = Some(state);
            }
            let now = match &target {
                DropTarget::Strip { label, .. } => Some(label.clone()),
                _ => None,
            };
            if hovered != now {
                if let Some(left) = &hovered {
                    let _ = app.emit_to(left, "muster://drop-hover", hover(None, request));
                }
            }
            if let DropTarget::Strip { label, x } = &target {
                let _ = app.emit_to(label, "muster://drop-hover", hover(Some(*x), request));
            }
            hovered = now;
        }
        std::thread::sleep(FRAME);
    }
    if let Some(left) = &hovered {
        let _ = app.emit_to(left, "muster://drop-hover", hover(None, request));
    }
}

fn hover(x: Option<f64>, request: &GhostRequest) -> Hover {
    Hover {
        x,
        accent: request.accent.clone(),
    }
}

/// The label's window, built hidden on first use and kept for the next drag.
fn label_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(label) = app.get_webview_window(LABEL) {
        return Ok(label);
    }
    let label = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::default())
        .title("")
        .inner_size(300.0, 56.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focusable(false)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Click-through, so it never becomes the window under the pointer.
    let _ = label.set_ignore_cursor_events(true);
    Ok(label)
}
