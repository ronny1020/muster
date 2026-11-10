//! The app's own log: errors, panics, sessions that ended badly, and the
//! moments the app stopped answering.
//!
//! It records what happened to the app, never what happened in a terminal — no
//! PTY output, no keystrokes, no arguments an agent was started with.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// The log's file name, without the `.log` the plugin adds.
const FILE_NAME: &str = "muster";

/// One file of this size, plus the one before it.
const MAX_FILE_BYTES: u128 = 1_000_000;

/// How long the native main thread may take to answer before it counts as
/// stalled. It draws every window, so a few seconds is already a frozen app.
const MAIN_THREAD_LIMIT: Duration = Duration::from_secs(5);

/// How long the focused window's page may go without a heartbeat. Longer than
/// the main thread's: the page's own timers are coarser, and a long `git` read
/// or a large paste can hold it for a second or two without anything wrong.
const PAGE_LIMIT: Duration = Duration::from_secs(10);

const TICK: Duration = Duration::from_secs(1);

/// How long after the main thread recovers before the page is judged again:
/// longer than the page's 2s heartbeat interval, so a live page has beaten.
const MAIN_GRACE: Duration = Duration::from_secs(5);

/// The log plugin, writing to the platform's log directory —
/// `~/Library/Logs/<identifier>/` on macOS.
///
/// `KeepSome(1)` keeps the previous file on rotation, so the lines just before
/// a hang survive it.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some(FILE_NAME.into()),
        }))
        .level(log::LevelFilter::Info)
        // It logs a failed spawn's whole command line and directory itself,
        // which the log promises never to hold; the app logs that failure on
        // its own terms in `pty.rs`.
        .level_for("portable_pty", log::LevelFilter::Off)
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(1))
        .timezone_strategy(TimezoneStrategy::UseLocal);
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder.build()
}

/// Writes a panic to the log before the process goes.
///
/// The release profile is `panic = "abort"`, so a panic ends the app at once
/// and its message would otherwise reach only a stderr nobody sees.
pub fn record_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        log::logger().flush();
        previous(info);
    }));
}

/// The last heartbeat of each window's page, and which window has the keyboard.
#[derive(Default)]
pub struct Watchdog {
    beats: Mutex<HashMap<String, Instant>>,
    focused: Mutex<Focus>,
    quitting: AtomicBool,
}

/// The window with the keyboard, and how many times any window has taken it —
/// so a window that loses and regains it between two ticks is still a new
/// watch, and the stall it had is not reported as over.
#[derive(Default)]
struct Focus {
    label: Option<String>,
    count: u64,
}

/// The page the watchdog judges: which focus it is, and how long it is silent.
#[derive(Debug, PartialEq)]
struct Watched {
    label: String,
    focus: u64,
    silence: Duration,
}

impl Watchdog {
    /// Watches the window that gained the keyboard, and forgives it the
    /// silence it kept while it did not have it: a background webview's
    /// timers are throttled, so its last beat can be long ago and mean nothing.
    pub fn focus(&self, label: &str, focused: bool) {
        let mut current = self.focused.lock();
        if focused {
            self.beats.lock().insert(label.to_string(), Instant::now());
            current.label = Some(label.to_string());
            current.count += 1;
        } else if current.label.as_deref() == Some(label) {
            current.label = None;
        }
    }

    /// Stops the watch for good: the app is on its way out.
    pub fn quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn forget(&self, label: &str) {
        self.beats.lock().remove(label);
        self.focus(label, false);
    }

    /// The focused window's page, and how long it has been silent.
    fn focused_silence(&self, now: Instant) -> Option<Watched> {
        let (label, focus) = {
            let current = self.focused.lock();
            (current.label.clone()?, current.count)
        };
        let beat = *self.beats.lock().get(&label)?;
        Some(Watched {
            label,
            focus,
            silence: now.saturating_duration_since(beat),
        })
    }
}

/// A page's sign of life, sent on a timer from every app window.
#[tauri::command]
pub fn log_heartbeat(window: tauri::Window, watchdog: tauri::State<'_, Watchdog>) {
    watchdog
        .beats
        .lock()
        .insert(window.label().to_string(), Instant::now());
}

/// How serious a line the page writes is.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
}

/// The longest message the page may write in one line. A stack trace fits; a
/// runaway string does not fill the file in one go.
const MAX_MESSAGE_CHARS: usize = 8_000;

/// The most the pages may write, together, in one burst, and the rate it
/// refills at, per minute. The refill is continuous, so no boundary lets two
/// bursts through at once. A flood therefore takes the pages minutes to fill
/// a 1 MB file, and the file kept from before it survives: two rotations close
/// together, with `KeepSome(1)`, would delete it. The longest line,
/// `MAX_MESSAGE_CHARS` of four-byte characters, still fits.
const PAGE_BYTES_PER_MINUTE: f64 = 128.0 * 1024.0;

const MINUTE: Duration = Duration::from_secs(60);

/// What a line costs beyond its message — the date, level and target the
/// plugin writes, and the newline — so an empty message is not free.
const LINE_OVERHEAD: usize = 64;

static PAGE_BUDGET: Mutex<Budget> = Mutex::new(Budget {
    bytes: PAGE_BYTES_PER_MINUTE,
    since: None,
    dropped: 0,
});

/// The pages' allowance of log bytes, a bucket refilled at
/// `PAGE_BYTES_PER_MINUTE`.
struct Budget {
    bytes: f64,
    since: Option<Instant>,
    dropped: u32,
}

impl Budget {
    /// Whether a line of `cost` bytes fits, and how many lines were dropped
    /// since the last that did, which the next one to fit reports once.
    fn take(&mut self, now: Instant, cost: usize) -> (bool, u32) {
        if let Some(since) = self.since {
            let refill = now.saturating_duration_since(since).as_secs_f64() / MINUTE.as_secs_f64()
                * PAGE_BYTES_PER_MINUTE;
            self.bytes = (self.bytes + refill).min(PAGE_BYTES_PER_MINUTE);
        }
        self.since = Some(now);
        let cost = cost as f64;
        if cost <= self.bytes {
            self.bytes -= cost;
            (true, std::mem::take(&mut self.dropped))
        } else {
            self.dropped += 1;
            (false, 0)
        }
    }
}

/// Records an error the page caught or failed to catch.
#[tauri::command]
pub fn log_write(window: tauri::Window, level: Level, message: String) {
    // Clipped before, so a runaway string costs nothing to make safe, and
    // after, since spelling out a control character lengthens it.
    let safe = defang(clip(&message, MAX_MESSAGE_CHARS));
    let message = clip(&safe, MAX_MESSAGE_CHARS);
    let label = window.label();
    let (fits, dropped) = PAGE_BUDGET
        .lock()
        .take(Instant::now(), message.len() + label.len() + LINE_OVERHEAD);
    if dropped > 0 {
        log::warn!(target: "webview", "{dropped} more lines from the pages were dropped");
    }
    if !fits {
        return;
    }
    match level {
        Level::Error => log::error!(target: "webview", "[{label}] {message}"),
        Level::Warn => log::warn!(target: "webview", "[{label}] {message}"),
    }
}

/// Where the log is, for the settings pane to reveal.
#[tauri::command]
pub fn log_path(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    Ok(dir
        .join(format!("{FILE_NAME}.log"))
        .to_string_lossy()
        .into_owned())
}

/// A page's message made safe to append: every line after the first is
/// indented, so a message cannot forge a record of its own, and every other
/// control character is spelled out, so reading the file in a terminal runs no
/// escape sequence. The Unicode line and paragraph separators, which a log
/// viewer may break a line at, and the bidi controls, which reorder what a line
/// shows, are spelled out too. An error message can name a file, and an agent
/// chooses its own filenames.
fn defang(text: &str) -> String {
    let mut safe = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\n' => safe.push_str("\n    "),
            '\t' => safe.push('\t'),
            c if c.is_control() || reshapes_text(c) => safe.extend(c.escape_default()),
            c => safe.push(c),
        }
    }
    safe
}

/// The format characters that break or reorder a line where they are drawn.
fn reshapes_text(c: char) -> bool {
    matches!(
        c,
        '\u{061C}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
    )
}

fn clip(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

/// Starts the thread that notices when the app stops answering.
///
/// Two things can freeze it, and they look the same from outside: the native
/// main thread, which draws every window and runs every window event, and a
/// window's page, which runs the whole interface. The first is probed with a
/// task posted to it; the second sends a heartbeat. Only the focused window's
/// page is judged, because a background webview's timers are throttled.
///
/// The thread never takes a lock anything else holds for long, so it keeps
/// running — and keeps writing — while the rest of the app is stuck.
pub fn watch<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let answered = Arc::new(Mutex::new(Instant::now()));
    let _ = std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || {
            let mut main = Stall::default();
            let mut page = Stall::default();
            let mut watched: Option<(String, u64)> = None;
            let mut sent = Instant::now();
            // When the main thread last answered after a stall, or the
            // thread's start, which covers a page still loading. A heartbeat is
            // a command the main thread runs, so the page is not judged until
            // the heartbeats held up behind that stall have had time to land.
            let mut main_back = sent;
            probe(&app, &answered);
            loop {
                std::thread::sleep(TICK);
                // Quitting ends every session on the main thread, which is
                // not a freeze.
                if app.state::<Watchdog>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                let now = Instant::now();

                let pending = *answered.lock() < sent;
                let main_silence = if pending {
                    now.saturating_duration_since(sent)
                } else {
                    Duration::ZERO
                };
                // One probe in flight at a time, so a stalled thread is not
                // handed a backlog to work through when it wakes.
                if !pending {
                    sent = now;
                    probe(&app, &answered);
                }
                match main.observe(main_silence, MAIN_THREAD_LIMIT) {
                    Some(Change::Stalled(age)) => log::warn!(
                        "the main thread has not answered for {}s; the app is frozen",
                        age.as_secs()
                    ),
                    Some(Change::Recovered(age)) => {
                        main_back = now;
                        log::warn!(
                            "the main thread answered again after about {}s",
                            age.as_secs()
                        )
                    }
                    None => {}
                }

                let silence = app.state::<Watchdog>().focused_silence(now);
                let key = silence.as_ref().map(|w| (w.label.clone(), w.focus));
                if key != watched {
                    if let (Some((label, _)), Some(longest)) = (&watched, page.longest) {
                        log::warn!(
                            "window {label} lost the keyboard while frozen, after about {}s; it is no longer watched",
                            longest.as_secs()
                        );
                    }
                    page = Stall::default();
                    watched = key;
                }
                let Some(Watched { label, silence, .. }) = silence else {
                    continue;
                };
                if main.stalled() || now.saturating_duration_since(main_back) < MAIN_GRACE {
                    continue;
                }
                match page.observe(silence, PAGE_LIMIT) {
                    Some(Change::Stalled(age)) => log::warn!(
                        "window {label} has not answered for {}s; its page is frozen",
                        age.as_secs()
                    ),
                    Some(Change::Recovered(age)) => log::warn!(
                        "window {label} answered again after about {}s",
                        age.as_secs()
                    ),
                    None => {}
                }
            }
        });
}

/// Posts a task to the main thread that records when it ran.
fn probe<R: Runtime>(app: &AppHandle<R>, answered: &Arc<Mutex<Instant>>) {
    let answered = answered.clone();
    let _ = app.run_on_main_thread(move || *answered.lock() = Instant::now());
}

#[derive(Debug, PartialEq)]
enum Change {
    Stalled(Duration),
    Recovered(Duration),
}

/// Turns a stream of "silent for this long" readings into the two moments
/// worth a line: when the silence passed its limit, and when it ended — with
/// the longest silence seen, which is the length of the stall to within a tick.
#[derive(Default)]
struct Stall {
    longest: Option<Duration>,
}

impl Stall {
    fn stalled(&self) -> bool {
        self.longest.is_some()
    }

    fn observe(&mut self, silence: Duration, limit: Duration) -> Option<Change> {
        match self.longest {
            None if silence > limit => {
                self.longest = Some(silence);
                Some(Change::Stalled(silence))
            }
            None => None,
            Some(longest) if silence <= limit => {
                self.longest = None;
                Some(Change::Recovered(longest))
            }
            Some(longest) => {
                self.longest = Some(longest.max(silence));
                None
            }
        }
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
