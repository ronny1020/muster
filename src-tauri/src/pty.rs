//! PTY-backed shell sessions, one per terminal tab.

use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
};

#[cfg(unix)]
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter, Manager,
};

use crate::platform::{self, Backend, Launch};

/// Live handles for one tab.
///
/// Each field carries its own lock rather than sharing one. That is
/// load-bearing: a write to a child that has stopped reading blocks until the
/// pty buffer drains, and under one shared lock that stalled `pty_kill` — which
/// had already removed the session from the map, so a retry did nothing and the
/// agent was orphaned for the life of the app.
struct Session {
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
}

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

    /// Forgets a session whose child has exited.
    ///
    /// Without this the map keeps finished sessions, so the quit prompt counts
    /// tabs with nothing running and `end_all` signals pids the reader thread
    /// already reaped — which the OS is free to have recycled.
    pub fn forget(&self, id: &str) {
        self.0.lock().remove(id);
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

/// Emitted once a session's process exits, so the tab can show its status.
#[derive(Clone, serde::Serialize)]
struct ExitPayload {
    id: String,
    code: u32,
}

#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    sessions: tauri::State<'_, Sessions>,
    options: SpawnOptions,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
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

    let previous = sessions.0.lock().insert(
        id.clone(),
        Arc::new(Session {
            master: Mutex::new(pair.master),
            stdin,
            group,
            killer: Mutex::new(killer),
            killed: killed.clone(),
        }),
    );
    // Re-using a live id would otherwise drop the old session's killer and
    // leave its child running.
    if let Some(previous) = previous {
        end(&previous);
    }

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(len) = reader.read(&mut buf) {
            if len == 0
                || on_output
                    .send(InvokeResponseBody::Raw(buf[..len].to_vec()))
                    .is_err()
            {
                break;
            }
        }
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        // The child is gone, so the registry must let go of it: the pane stays
        // mounted behind the "session ended" overlay, so nothing else will.
        app.state::<Sessions>().forget(&id);
        // A deliberate close needs no banner; the tab is already a launcher.
        if !killed.load(Ordering::SeqCst) {
            let _ = app.emit("pty://exit", ExitPayload { id, code });
        }
    });

    Ok(())
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
pub fn pty_kill(sessions: tauri::State<'_, Sessions>, id: String) {
    let Some(session) = sessions.0.lock().remove(&id) else {
        return;
    };
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
