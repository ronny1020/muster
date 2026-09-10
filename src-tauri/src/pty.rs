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
mod cwd_tests {
    use std::{
        io::Write,
        sync::{atomic::AtomicBool, mpsc, Arc},
        time::{Duration, Instant},
    };

    use parking_lot::Mutex;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    use super::{end, Session, Sessions};

    /// Polls until the leader reports `expected`, or gives up.
    fn wait_for_cwd(master: &dyn portable_pty::MasterPty, expected: &str) -> Option<String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut last = None;
        while Instant::now() < deadline {
            if let Some(leader) = master.process_group_leader() {
                last = crate::platform::process_cwd(leader);
                if last.as_deref() == Some(expected) {
                    return last;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        last
    }

    /// The failure the previous kill missed: an agent's own subprocesses.
    ///
    /// A signal to the leader alone leaves them running, because the child is a
    /// session leader and they are in its group, not its parentage.
    #[test]
    fn quitting_ends_every_session_and_empties_the_registry() {
        // Closing the window never unmounts the frontend, so `end_all` is the
        // only thing standing between quitting and orphaned agents. Assert on
        // grandchildren: a direct child stays a zombie until it is waited on,
        // and a zombie still answers `kill(pid, 0)`.
        let sessions = Sessions::default();
        let mut children = Vec::new();
        let mut grandchildren = Vec::new();

        for index in 0..2 {
            let marker = std::env::temp_dir()
                .join(format!("muster-quit-{}-{index}.pid", std::process::id()));
            let _ = std::fs::remove_file(&marker);

            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .expect("openpty");
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.args([
                "-c",
                &format!(
                    "sleep 60 & echo $! > {}; exec sleep 60",
                    marker.to_string_lossy()
                ),
            ]);
            let child = pair.slave.spawn_command(cmd).expect("spawn");
            drop(pair.slave);

            let group = child.process_id().map(|pid| pid as i32);
            let killer = child.clone_killer();
            let _reader = pair.master.try_clone_reader().expect("reader");
            let (stdin, _queued) = mpsc::channel::<Vec<u8>>();
            sessions.0.lock().insert(
                format!("tab-{index}"),
                Arc::new(Session {
                    master: Mutex::new(pair.master),
                    stdin,
                    group,
                    killer: Mutex::new(killer),
                    killed: Arc::new(AtomicBool::new(false)),
                }),
            );

            grandchildren.push((wait_for_pid(&marker), marker));
            children.push(child);
        }

        assert_eq!(sessions.live(), 2, "both sessions should be registered");
        assert!(
            grandchildren.iter().all(|(pid, _)| alive(*pid)),
            "the grandchildren should be running before the quit",
        );

        sessions.end_all();
        assert_eq!(sessions.live(), 0, "the registry must be emptied");

        // Generous on purpose: `end` sleeps 150ms between SIGHUP and SIGKILL
        // for every session, and this waits on two whole process trees. A tight
        // bound here fails on a loaded CI runner rather than on a real bug.
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline && grandchildren.iter().any(|(pid, _)| alive(*pid)) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let survivors: Vec<i32> = grandchildren
            .iter()
            .filter(|(pid, _)| alive(*pid))
            .map(|(pid, _)| *pid)
            .collect();
        for child in children.iter_mut() {
            let _ = child.wait();
        }
        for (_, marker) in &grandchildren {
            let _ = std::fs::remove_file(marker);
        }
        assert!(
            survivors.is_empty(),
            "quitting must not leave an agent's subprocesses running: {survivors:?}",
        );
    }

    #[test]
    fn ending_a_session_reaches_the_children_the_agent_started() {
        let marker = std::env::temp_dir().join(format!("muster-group-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&marker);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        // A grandchild that outlives its parent shell, exactly like a dev server
        // an agent leaves running.
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            &format!(
                "sleep 60 & echo $! > {}; exec sleep 60",
                marker.to_string_lossy()
            ),
        ]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let group = child.process_id().map(|pid| pid as i32);
        let killer = child.clone_killer();
        let _reader = pair.master.try_clone_reader().expect("reader");

        let grandchild = wait_for_pid(&marker);
        assert!(alive(grandchild), "the grandchild should be running first");

        let (stdin, _queued) = mpsc::channel::<Vec<u8>>();
        end(&Session {
            master: Mutex::new(pair.master),
            stdin,
            group,
            killer: Mutex::new(killer),
            killed: Arc::new(AtomicBool::new(false)),
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && alive(grandchild) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let still_running = alive(grandchild);
        let _ = child.wait();
        let _ = std::fs::remove_file(&marker);
        assert!(
            !still_running,
            "a subprocess the agent started must not survive the tab closing",
        );
    }

    /// The pid the shell wrote, once it has written it.
    fn wait_for_pid(marker: &std::path::Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(marker) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the shell never reported its background pid");
    }

    /// Signal 0 tests for existence without delivering anything.
    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Pins the reasoning behind `Session::killer`: dropping the pty handles is
    /// NOT enough to end a session, because the reader thread holds a cloned
    /// master fd and a pty only hangs up when the last one closes.
    #[test]
    fn dropping_the_pty_handles_leaves_the_child_running_but_the_killer_ends_it() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut killer = child.clone_killer();
        // What the app holds onto: a clone of the reader, exactly as pty_spawn does.
        let _reader = pair.master.try_clone_reader().expect("reader");
        drop(pair.master);

        std::thread::sleep(Duration::from_millis(300));
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "dropping the master and writer must NOT be relied on to end a session",
        );

        killer.kill().expect("kill");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if child.try_wait().expect("try_wait").is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the killer did not end the child");
    }

    #[test]
    fn reads_back_a_directory_the_shell_changed_itself() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.cwd(env!("CARGO_MANIFEST_DIR"));
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        // The shell has to be running before its own directory means anything.
        assert_eq!(
            wait_for_cwd(&*pair.master, env!("CARGO_MANIFEST_DIR")).as_deref(),
            Some(env!("CARGO_MANIFEST_DIR")),
            "launch directory should be readable from the foreground process group",
        );

        // A directory made for this test, and the path the OS will actually
        // report for it: `/tmp` is a symlink to `/private/tmp` on macOS but is
        // itself on Linux, so the expected value has to be resolved, not
        // written down.
        let target = std::env::temp_dir().join(format!("muster-cd-{}", std::process::id()));
        std::fs::create_dir_all(&target).expect("mkdir");
        let resolved = std::fs::canonicalize(&target)
            .expect("canonicalize")
            .to_string_lossy()
            .into_owned();

        let mut writer = pair.master.take_writer().expect("writer");
        writer
            .write_all(format!("cd '{}'\n", target.to_string_lossy()).as_bytes())
            .expect("write");
        writer.flush().expect("flush");

        let moved = wait_for_cwd(&*pair.master, &resolved);
        let _ = child.kill();
        let _ = std::fs::remove_dir(&target);
        assert_eq!(
            moved.as_deref(),
            Some(resolved.as_str()),
            "a `cd` typed into the terminal should move the reported directory",
        );
    }
}
