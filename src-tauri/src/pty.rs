//! PTY-backed shell sessions, one per terminal tab.

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Weak,
    },
};

use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter, Manager,
};

use crate::journal::{Journal, JournalMeta};
use crate::platform::{self, Backend, Launch};

/// Live handles for one tab.
///
/// Each field carries its own lock rather than sharing one. That is
/// load-bearing: a write to a child that has stopped reading blocks until the
/// pty buffer drains, and under one shared lock that stalled `pty_kill` — which
/// had already removed the session from the map, so a retry did nothing and the
/// agent was orphaned for the life of the app.
struct Session {
    /// Which registration this is — see `EPOCHS`.
    epoch: u64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Stdin goes through a queue drained by one thread, so bytes reach the
    /// child in the order they were typed. Commands run as independent tasks
    /// and would otherwise race each other for the writer.
    stdin: mpsc::Sender<Vec<u8>>,
    /// The child's process group, for signalling every descendant rather than
    /// just the leader.
    group: Option<i32>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    /// Set once the session is deliberately ended, so the reader thread can
    /// tell a kill apart from the child exiting on its own.
    killed: Arc<AtomicBool>,
    /// Where this session's output goes, which is whichever window is showing
    /// the tab. Swappable so a tab can move between windows without its child
    /// being ended and respawned — `pty_spawn` on a live id kills what was
    /// there, so moving a tab cannot go through it.
    ///
    /// Shared with the reader thread rather than looked up per chunk: the
    /// thread starts before `pty_spawn` has finished registering the session,
    /// so a lookup would miss on the first chunk and end the thread before a
    /// single byte reached the window.
    output: Arc<Mutex<Channel<InvokeResponseBody>>>,
}

/// Counts every session ever registered, so one can be told apart from
/// whatever later takes its tab id.
///
/// A tab reopening its conversation kills and respawns under the **same** id,
/// and the two are separate async commands with no ordering between them — so
/// a kill meant for the old session can arrive after the new one is
/// registered. Removing by id alone would then end the session that just
/// started, and because `end` marks it deliberate the reader thread reports no
/// exit: the tab keeps its terminal, shows no ended bar and no way back, and
/// has no process behind it.
static EPOCHS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Arc<Session>>>);

impl Sessions {
    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no session {id}"))
    }

    /// How many sessions are still running, for a close prompt.
    pub fn live(&self) -> usize {
        self.0.lock().len()
    }

    /// Forgets a session whose child has exited, if it is still the one
    /// registered under that id.
    ///
    /// Without this the map keeps finished sessions, so the quit prompt counts
    /// tabs with nothing running and `end_all` signals pids the reader thread
    /// already reaped — which the OS is free to have recycled.
    ///
    /// The identity check is what makes it safe during a relaunch. A tab
    /// reopening its conversation — the mode control, the width repair,
    /// reopening a record — spawns under the **same id**, so the new session
    /// is in the map before the old child has finished dying. Removing by id
    /// alone deletes the live session, and every write then answers
    /// `no session <id>`: the terminal goes on drawing, because the reader
    /// thread holds the output channel rather than the map, so the tab looks
    /// healthy and only typing is dead.
    fn forget(&self, id: &str, session: &Weak<Session>) {
        // A `Weak` that cannot be upgraded is a session nothing holds, and the
        // map holds a strong reference to everything in it — so there is
        // nothing of this session left to remove.
        let Some(mine) = session.upgrade() else {
            return;
        };
        let mut sessions = self.0.lock();
        if sessions
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, &mine))
        {
            sessions.remove(id);
        }
    }

    /// Ends every session, for quit.
    ///
    /// Quitting never unmounts the frontend, so no `pty_kill` is ever issued
    /// and nothing else reaches the agents' own subprocesses — a dev server an
    /// agent started outlives the app that started it.
    pub fn end_all(&self) {
        // Drained into a vec first: `end` sleeps between SIGHUP and SIGKILL,
        // and holding the map guard across those sleeps would block the event
        // loop for 150ms per session at exit.
        let sessions: Vec<Arc<Session>> = self.0.lock().drain().map(|(_, s)| s).collect();
        for session in sessions {
            end(&session);
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    pub id: String,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    /// Run through an interactive login shell. GUI apps inherit a bare `PATH`
    /// — from launchd on macOS, from the desktop session on Linux — so tools
    /// installed by the user's profile (nvm, mise, ~/.local/bin) are only
    /// visible once the shell's rc files have run. On Windows the shell is also
    /// what resolves the `.cmd` and `.ps1` shims npm-installed CLIs ship as.
    #[serde(default)]
    pub login_shell: bool,
    /// Whether the session runs on the host or inside a WSL distro.
    #[serde(default)]
    pub backend: Backend,
    /// Which distro, when the backend is WSL. Empty means the default one.
    #[serde(default)]
    pub distro: String,
    /// Record this session's output so it outlives the process. Off unless the
    /// caller asks: the record holds whatever the agent printed.
    #[serde(default)]
    pub journal: bool,
    /// Which agent this is, so a record remembers what wrote it and the panel
    /// can offer that agent's own resume.
    #[serde(default)]
    pub agent_id: String,
    /// Keep this session out of the alternate buffer, trading the agent's
    /// mouse for a scrollback — see `SCROLLBACK_ENV`. The frontend always
    /// sends it, from the tab's mode; the serde default only covers a caller
    /// that predates the field.
    #[serde(default)]
    pub scrollback: bool,
}

/// Session-scoped variables an agent CLI exports for the processes it spawns.
/// Launching this app from inside such a session would otherwise leak them into
/// every tab — a nested Claude Code, for one, sees `CLAUDE_CODE_CHILD_SESSION`
/// and stops saving its transcript, so `--continue` and `--resume` find nothing.
/// A terminal's sessions are top-level, never children of whatever started it.
const INHERITED_SESSION_MARKERS: &[&str] = &[
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

/// What an agent CLI needs in its environment to leave a scrollback behind,
/// set only for a session that asked for it.
///
/// A TUI in the alternate buffer is exactly `rows` tall and keeps no history,
/// so a session run that way has nothing for the scrollback surfaces to read:
/// no message marks, no path beside the scrollbar, and a find bar over one
/// screen. Out of it, the whole session is in the normal buffer and every one
/// of those surfaces works.
///
/// The price is the mouse. Claude Code reports mouse events from its
/// fullscreen renderer alone, so a session held in the normal buffer answers
/// the keyboard and nothing else: its own prompts, the subagent picker and
/// the running-shell list all stop taking a click. The two cannot be had at
/// once, which is why this is a per-session choice rather than a constant —
/// `SpawnOptions::scrollback` carries it, and a tab flips between them by
/// reopening the conversation with the agent's own `continue`.
///
/// The variable is undocumented and only Claude Code reads it; another agent
/// ignores it, so a tab of anything else is unaffected either way.
const SCROLLBACK_ENV: &[(&str, &str)] = &[("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1")];

/// Puts the session's mode into the environment it is spawned with.
///
/// Removing is as load-bearing as setting. `CommandBuilder` seeds itself from
/// *this* process's environment, so a Muster launched from a shell that
/// exports the variable hands it to every session it spawns — and a shell tab
/// is itself a session run in whichever mode the tab is in, which makes the
/// dev loop the ordinary way to arrive there. Declining to set it would leave
/// that inherited copy in place: the agent keeps the classic renderer, reports
/// no mouse, and the control that claims to have switched the tab changes
/// nothing.
fn apply_mode(cmd: &mut CommandBuilder, scrollback: bool) {
    for (key, value) in SCROLLBACK_ENV {
        if scrollback {
            cmd.env(key, value);
        } else {
            cmd.env_remove(key);
        }
    }
}

/// How long to watch for the agent to publish its session id. Generous, since
/// a cold start behind a login shell can take seconds, and cheap: one stat per
/// tick against one file.
const SESSION_ID_ATTEMPTS: u32 = 40;
const SESSION_ID_INTERVAL: Duration = Duration::from_millis(500);

/// Emitted once a session's process exits, so the tab can show its status.
#[derive(Clone, serde::Serialize)]
struct ExitPayload {
    id: String,
    code: u32,
}

/// Points a running session's output at a different window.
///
/// This is how a tab moves between windows: `pty_spawn` on a live id ends the
/// child that was there, so it cannot be used to adopt one. Swap **before**
/// the old window lets go — the reader thread still stops when the channel it
/// is writing to dies, which is what keeps a pty nobody displays from parking
/// a thread forever.
#[tauri::command]
pub fn pty_reattach(
    sessions: tauri::State<'_, Sessions>,
    id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let session = sessions.get(&id)?;
    *session.output.lock() = on_output;
    Ok(())
}

#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    sessions: tauri::State<'_, Sessions>,
    options: SpawnOptions,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let SpawnOptions {
        id,
        cwd,
        program,
        args,
        cols,
        rows,
        login_shell,
        backend,
        distro,
        journal,
        agent_id,
        scrollback,
    } = options;

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // `~` reaches here from the launcher, from a saved default and from the
    // recents list. Without expanding it the directory check passes and the
    // spawn then fails on a directory literally named `~`.
    let cwd = crate::workspace::expand_home(&cwd);
    let resolved = platform::argv(&Launch {
        backend,
        distro: Some(distro.as_str()),
        cwd: &cwd,
        program: &program,
        args: &args,
        via_shell: login_shell,
    });

    let mut cmd = CommandBuilder::new(&resolved.program);
    cmd.args(&resolved.args);
    cmd.cwd(&resolved.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    apply_mode(&mut cmd, scrollback);
    for marker in INHERITED_SESSION_MARKERS {
        cmd.env_remove(marker);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|error| {
        // A failed start is still an ended session as far as the tab is
        // concerned, so report it the same way — otherwise the tab keeps a null
        // exit code and the "Back to start" button never appears.
        let _ = app.emit(
            "pty://exit",
            ExitPayload {
                id: id.clone(),
                code: 127,
            },
        );
        error.to_string()
    })?;
    // The slave is the child's end; holding it open would keep the pty alive
    // after the child exits.
    drop(pair.slave);
    let killer = child.clone_killer();
    // portable-pty puts the child in its own session, so the child's pid is
    // also its process-group id — which is what reaches its descendants.
    let group = child.process_id().map(|pid| pid as i32);

    // From here on the child exists, so every failure has to kill it rather
    // than drop it and leak.
    let mut on_partial_failure = {
        let mut killer = child.clone_killer();
        move |error: String| {
            let _ = killer.kill();
            error
        }
    };
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| on_partial_failure(e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| on_partial_failure(e.to_string()))?;

    let mut journal = journal.then(|| Journal::open(&app, &cwd, &id)).flatten();
    // The record's own name, captured before the journal moves into the reader
    // thread. Naming a sidecar after the tab instead puts it where no reader
    // looks and the next sweep deletes it as an orphan.
    let record = journal.as_ref().map(|journal| journal.name().to_string());
    if let Some(record) = &record {
        crate::journal::remember(
            &app,
            &cwd,
            record,
            JournalMeta {
                agent_id: agent_id.clone(),
                session_id: String::new(),
            },
        );
    }

    let output = Arc::new(Mutex::new(on_output));
    let (stdin, queued) = mpsc::channel::<Vec<u8>>();
    let killed = Arc::new(AtomicBool::new(false));

    // One writer thread, so stdin order is the order the frontend sent, and no
    // blocking write ever occupies an async worker.
    std::thread::spawn(move || {
        let mut writer = writer;
        for chunk in queued {
            if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    let epoch = EPOCHS.fetch_add(1, Ordering::SeqCst);
    let session = Arc::new(Session {
        epoch,
        master: Mutex::new(pair.master),
        stdin,
        group,
        killer: Mutex::new(killer),
        killed: killed.clone(),
        output: output.clone(),
    });
    // Held weakly by the reader thread, so it can tell "my child exited" from
    // "a newer session has taken this id" — see `Sessions::forget`.
    let registered = Arc::downgrade(&session);
    let previous = sessions.0.lock().insert(id.clone(), session);
    // Re-using a live id would otherwise drop the old session's killer and
    // leave its child running.
    if let Some(previous) = previous {
        end(&previous);
    }

    // The agent's own id for this conversation, which is the only thing that
    // can reopen it later. It is published shortly *after* the CLI starts, so
    // this watches for it rather than asking once, and gives up rather than
    // waiting on an agent that never publishes one.
    if let (Some(record), Some(pid)) = (record.clone(), group) {
        let app = app.clone();
        let cwd = cwd.clone();
        let agent_id = agent_id.clone();
        // Stops as soon as the session does, rather than statting a pid the OS
        // is free to hand to another process — which would otherwise record
        // some unrelated conversation's id against this tab's record.
        let ended = killed.clone();
        std::thread::spawn(move || {
            for _ in 0..SESSION_ID_ATTEMPTS {
                std::thread::sleep(SESSION_ID_INTERVAL);
                if ended.load(Ordering::SeqCst) {
                    return;
                }
                let found = crate::sessions::published_session_id(&agent_id, pid as u32);
                if let Some(session_id) = found {
                    crate::journal::remember(
                        &app,
                        &cwd,
                        &record,
                        JournalMeta {
                            agent_id: String::new(),
                            session_id,
                        },
                    );
                    return;
                }
            }
        });
    }

    let reader_output = output.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(len) = reader.read(&mut buf) {
            if len == 0 {
                break;
            }
            // Recorded before it is sent, so a chunk is never dropped from
            // the record because the send failed. Note the loop still ends on
            // a failed send: the frontend going away means the window is
            // closing, and reading a pty nobody is displaying is not worth a
            // parked thread.
            if let Some(journal) = journal.as_mut() {
                journal.write(&buf[..len]);
            }
            // Through the shared handle, so a window that adopts this tab
            // receives the next chunk. The lock covers the enqueue alone.
            if reader_output
                .lock()
                .send(InvokeResponseBody::Raw(buf[..len].to_vec()))
                .is_err()
            {
                break;
            }
        }
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        // The child is gone, so the registry must let go of it: the pane stays
        // mounted behind the "session ended" overlay, so nothing else will.
        app.state::<Sessions>().forget(&id, &registered);
        // A deliberate close needs no banner; the tab is already a launcher.
        let deliberate = killed.load(Ordering::SeqCst);
        // Set after that read, never before: this flag is also how anything
        // watching the session learns it is over, and the most common way a
        // session ends is the child exiting on its own — which nothing else
        // records. Without it the session-id watcher keeps statting a pid the
        // OS may already have given to another process.
        killed.store(true, Ordering::SeqCst);
        if !deliberate {
            let _ = app.emit("pty://exit", ExitPayload { id, code });
        }
    });

    // The epoch the caller quotes back when it kills this session — see
    // `EPOCHS`, and `pty_kill`, which refuses a kill that names an older one.
    Ok(epoch)
}

/// Queues keystrokes for the session's writer thread.
///
/// Queueing rather than writing here is what keeps typing in order: commands
/// run as independent tasks, so two direct writes could reach the child
/// transposed.
#[tauri::command(async)]
pub fn pty_write(
    sessions: tauri::State<'_, Sessions>,
    id: String,
    data: String,
) -> Result<(), String> {
    sessions
        .get(&id)?
        .stdin
        .send(data.into_bytes())
        .map_err(|_| format!("session {id} has closed"))
}

#[tauri::command(async)]
pub fn pty_resize(
    sessions: tauri::State<'_, Sessions>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    sessions
        .get(&id)?
        .master
        .lock()
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

/// Working directory of the session's foreground process group, where the host
/// can report one. `None` leaves the frontend on the launch directory.
#[tauri::command]
pub async fn pty_cwd(
    sessions: tauri::State<'_, Sessions>,
    id: String,
) -> Result<Option<String>, String> {
    // An async command holding a `State` reference has to return `Result`, so
    // "no directory to report" is `Ok(None)` rather than an error.
    let Some(leader) = sessions.get(&id).ok().and_then(foreground_group) else {
        return Ok(None);
    };
    // Reading it costs a subprocess on macOS, once per tab per poll, so it
    // belongs on the blocking pool rather than an async worker.
    tauri::async_runtime::spawn_blocking(move || platform::process_cwd(leader))
        .await
        .map_err(|error| error.to_string())
}

/// Ends a session: signals the child's whole process group, then drops the
/// pty handles.
#[tauri::command(async)]
pub fn pty_kill(sessions: tauri::State<'_, Sessions>, id: String, epoch: u64) {
    // Only the registration the caller meant — see `EPOCHS`.
    let mut map = sessions.0.lock();
    // Matched rather than `is_none_or`, which is newer than this crate's MSRV.
    match map.get(&id) {
        Some(current) if current.epoch == epoch => {}
        _ => return,
    }
    let Some(session) = map.remove(&id) else {
        return;
    };
    drop(map);
    end(&session);
}

/// Signals a session's process group and lets its reader thread wind down.
///
/// The group, not the process: the child is a session leader, so an agent's own
/// subprocesses — a dev server, an MCP server — survive a signal sent only to
/// the leader. And `SIGHUP` alone is a request; anything ignoring it needs
/// `SIGKILL`, or the tab closes while the work keeps running.
fn end(session: &Session) {
    session.killed.store(true, Ordering::SeqCst);
    signal_group(session.group);
    // Whatever the group signal reached, the leader still gets the library's
    // own hangup — this is the only path on hosts with no process groups.
    let _ = session.killer.lock().kill();
}

/// The process currently holding the terminal, where the host has the concept.
///
/// `MasterPty::process_group_leader` is itself `#[cfg(unix)]` in portable-pty,
/// so this cannot merely return `None` on Windows — the call has to be absent.
#[cfg(unix)]
fn foreground_group(session: Arc<Session>) -> Option<i32> {
    session.master.lock().process_group_leader()
}

#[cfg(not(unix))]
fn foreground_group(_session: Arc<Session>) -> Option<i32> {
    None
}

#[cfg(unix)]
fn signal_group(group: Option<i32>) {
    let Some(group) = group.filter(|group| *group > 1) else {
        return;
    };
    unsafe {
        libc::killpg(group, libc::SIGHUP);
    }
    // A short grace period so a well-behaved process can save and exit before
    // it is killed outright.
    std::thread::sleep(Duration::from_millis(150));
    unsafe {
        libc::killpg(group, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn signal_group(_group: Option<i32>) {}

/// Exercises the real chain behind the status bar's directory: a PTY, a shell
/// that changes directory, and reading that directory back out. Unit tests
/// cannot reach it — only a live process group can.
#[cfg(all(test, unix))]
#[path = "pty_tests.rs"]
mod cwd_tests;
