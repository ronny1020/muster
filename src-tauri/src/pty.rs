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
use crate::output::Output;
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
    output: Arc<Mutex<Output<Channel<InvokeResponseBody>>>>,
    /// The label of the window showing this session, so closing one window
    /// ends its own sessions and leaves every other window's running.
    window: Mutex<String>,
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

/// How each session that has exited ended, by tab id, for a window that
/// adopts a tab whose session ended on the way — its exit event arrived
/// before that window was listening. Cleared when the id spawns again.
#[derive(Default)]
pub struct Exits(Mutex<HashMap<String, u32>>);

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

    /// The tab ids of every running session, in any window.
    pub fn ids(&self) -> Vec<String> {
        self.0.lock().keys().cloned().collect()
    }

    /// Hands a session to another window before that window has attached,
    /// so the window it is leaving can close without ending it.
    ///
    /// A session that has already ended has nothing to move.
    pub fn move_to(&self, id: &str, window: &str) {
        if let Ok(session) = self.get(id) {
            *session.window.lock() = window.to_string();
        }
    }

    /// How many of them one window is showing.
    pub fn live_in(&self, window: &str) -> usize {
        self.0
            .lock()
            .values()
            .filter(|session| *session.window.lock() == window)
            .count()
    }

    /// Ends the sessions one window is showing, when that window closes and
    /// others stay open.
    pub fn end_window(&self, window: &str) {
        // Taken out under the guard and ended after it, for the reason
        // `end_all` gives.
        let mut map = self.0.lock();
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, session)| *session.window.lock() == window)
            .map(|(id, _)| id.clone())
            .collect();
        let ended: Vec<Arc<Session>> = ids.iter().filter_map(|id| map.remove(id)).collect();
        drop(map);
        for session in ended {
            end(&session);
        }
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
    ///
    /// `retiring` runs only when it is, and under the registry's lock, so
    /// nothing can register a new session under the id in between.
    fn forget(&self, id: &str, session: &Weak<Session>, retiring: impl FnOnce()) {
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
            retiring();
            sessions.remove(id);
        }
    }

    /// Lets go of every output channel window `closed` owned — a session it
    /// handed to another window that has not attached yet is still writing
    /// to it, and a closed window's channel never says so itself.
    pub fn park_window(&self, closed: &str) {
        for session in self.0.lock().values() {
            session.output.lock().park(closed);
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
    /// Start a plain shell session with Muster's own startup file, so it
    /// reports where each prompt ends and each command's output begins — see
    /// `crate::shell`. An agent session that hands back starts the shell after
    /// the agent that way instead; the agent's own shell `exec`s it before a
    /// hook could run.
    #[serde(default)]
    pub shell_integration: bool,
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

/// What a session needs in its environment for an agent CLI to broadcast its
/// turn boundaries — the `OSC 777` events the tab notifies from.
///
/// That broadcast is a hook plugin's rather than the CLI's own, and it stays
/// silent until the terminal says it can render the events. Muster parses
/// them, so this says so. Both are wanted: a protocol version on its own
/// leaves the plugin without the client version it also reads, and every hook
/// then exits without printing.
///
/// The version is Muster's own, and it must name no release channel of the
/// terminal the plugin was written for — a version naming its `stable` or
/// `preview` channel is compared against that channel's releases, and a build
/// it has never heard of loses; `dev` is refused too, for when it gains a
/// threshold of its own. `pty_tests.rs` pins that.
const CLI_AGENT_ENV: &[(&str, &str)] = &[
    ("WARP_CLI_AGENT_PROTOCOL_VERSION", "1"),
    (
        "WARP_CLIENT_VERSION",
        concat!("muster/", env!("CARGO_PKG_VERSION")),
    ),
];

/// Advertises the protocol to the session being spawned.
///
/// Called after the `INHERITED_SESSION_MARKERS` strip, never before it: a
/// variable this sets that also appeared in that list would be stripped
/// straight back out again.
///
/// It reaches a WSL session only by accident. `cmd` there is `wsl.exe`, and
/// only what `WSLENV` names crosses into the distro — which this app sets only
/// for the hand-back token, so `TERM`, `COLORTERM` and `SCROLLBACK_ENV` do not
/// cross either.
/// A `WSLENV` the user's own Windows environment exports is inherited like
/// any other variable, so what crosses is whatever they happened to list.
fn advertise_protocol(cmd: &mut CommandBuilder) {
    for (key, value) in CLI_AGENT_ENV {
        cmd.env(key, value);
    }
}

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
/// a cold start behind a login shell can take seconds, and cheap: a stat per
/// tick, and under a hand-back's `sh` a `ps` and a `pgrep` until the agent is
/// found and one `pgrep` after — and only for an agent that publishes one at
/// all.
const SESSION_ID_ATTEMPTS: u32 = 40;
const SESSION_ID_INTERVAL: Duration = Duration::from_millis(500);

/// What the caller learns about the session it just started.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
    /// Names this registration, quoted back by `pty_kill`.
    pub epoch: u64,
    /// Whether this session was actually started with Muster's own startup
    /// file, which is the only session whose `OSC 133` reports mean anything —
    /// in a session with a `handback_token`, only once it has handed back,
    /// since until then the terminal is the agent's.
    ///
    /// Answered here rather than worked out again in the frontend: the same
    /// rule computed in two places drifts, and only this side knows whether
    /// the scripts could be written at all. A session that was not injected
    /// into can still be *printed* to — by the agent it runs, or by whatever
    /// its commands output — so a boundary from one is another program's
    /// claim about a shell that is not there.
    pub shell_integration: bool,
    /// The token this session's hand-back announcement carries, or `None` for
    /// a session that announces none — `platform::hands_back`. The frontend
    /// believes an announcement only with this token, since anything the
    /// agent prints can say `OSC 777;muster-handback` too.
    pub handback_token: Option<String>,
}

/// Emitted once a session's process exits, so the tab can show its status.
#[derive(Clone, serde::Serialize)]
struct ExitPayload {
    id: String,
    code: u32,
}

/// Points a running session's output at a different window, replaying what
/// was sent after byte `from` — the count the old window's screen already
/// shows — and answering the offset that replay starts at.
///
/// This is how a tab moves between windows: `pty_spawn` on a live id ends the
/// child that was there, so it cannot be used to adopt one. Swap **before**
/// the old window lets go — the reader thread still stops when the channel it
/// is writing to dies, which is what keeps a pty nobody displays from parking
/// a thread forever.
#[tauri::command]
pub fn pty_reattach(
    window: tauri::Window,
    sessions: tauri::State<'_, Sessions>,
    exits: tauri::State<'_, Exits>,
    id: String,
    from: u64,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    // A session that ended on the way says how, so the tab can show it ended
    // rather than sit there taking keystrokes for nothing — asked first, since
    // a session that has exited can still be registered for a moment. An exit
    // never outlives a respawn under the same id, which clears it.
    if let Some(code) = exits.0.lock().get(&id) {
        return Err(format!("exited:{code}"));
    }
    let session = sessions.get(&id)?;
    *session.window.lock() = window.label().to_string();
    let start = session
        .output
        .lock()
        .redirect(on_output, window.label(), from);
    Ok(start)
}

#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    window: tauri::Window,
    sessions: tauri::State<'_, Sessions>,
    options: SpawnOptions,
    on_output: Channel<InvokeResponseBody>,
) -> Result<Spawned, String> {
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
        shell_integration,
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
    let launch = Launch {
        backend,
        distro: Some(distro.as_str()),
        cwd: &cwd,
        program: &program,
        args: &args,
        via_shell: login_shell,
    };
    let hands_back = platform::hands_back(&launch);
    let handback_token = hands_back.then(new_token);

    // A plain shell, or the one an agent hands back to, and only on the host:
    // a WSL session's shell reads the distro's filesystem, where a path
    // written here names nothing.
    let integration =
        (shell_integration && (program.is_empty() || hands_back) && backend == Backend::Native)
            .then(|| crate::shell::prepare(&app, &platform::default_shell()))
            .flatten();
    let resolved = platform::integrated_argv(&launch, integration.as_ref());
    // A hand-back carries its integration on its own command line, for the
    // reason `platform::shell_after` gives.
    let plain_integration = integration.as_ref().filter(|_| !hands_back);

    let mut cmd = CommandBuilder::new(&resolved.program);
    match plain_integration.filter(|it| !it.args.is_empty()) {
        // bash cannot be given both `-l` and an init file, so an integration
        // that needs one replaces the arguments rather than adding to them.
        Some(it) => cmd.args(&it.args),
        None => cmd.args(&resolved.args),
    }
    cmd.cwd(&resolved.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    apply_mode(&mut cmd, scrollback);
    for marker in INHERITED_SESSION_MARKERS {
        cmd.env_remove(marker);
    }
    advertise_protocol(&mut cmd);
    if let Some(integration) = plain_integration {
        for (key, value) in &integration.env {
            cmd.env(key, value);
        }
    }
    if let Some(token) = &handback_token {
        pass_token(&mut cmd, token, backend);
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

    let output = Arc::new(Mutex::new(Output::new(on_output, window.label())));
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
        window: Mutex::new(window.label().to_string()),
    });
    // Held weakly by the reader thread, so it can tell "my child exited" from
    // "a newer session has taken this id" — see `Sessions::forget`.
    let registered = Arc::downgrade(&session);
    // A tab started again after its session ended is live again — cleared
    // under the registry's lock, the one `forget` records an exit under, so
    // a dying session cannot record its exit between the two.
    let previous = {
        let mut registry = sessions.0.lock();
        app.state::<Exits>().0.lock().remove(&id);
        registry.insert(id.clone(), session)
    };
    // Re-using a live id would otherwise drop the old session's killer and
    // leave its child running.
    if let Some(previous) = previous {
        end(&previous);
    }

    // The agent's own id for this conversation, which is the only thing that
    // can reopen it later. It is published shortly *after* the CLI starts, so
    // this watches for it rather than asking once, and gives up rather than
    // waiting on an agent that never publishes one.
    let publishes = crate::sessions::publishes_session_id(&agent_id);
    if let (Some(record), Some(pid), true) = (record.clone(), group, publishes) {
        let app = app.clone();
        let cwd = cwd.clone();
        let agent_id = agent_id.clone();
        // Stops as soon as the session does, rather than statting a pid the OS
        // is free to hand to another process — which would otherwise record
        // some unrelated conversation's id against this tab's record.
        let ended = killed.clone();
        std::thread::spawn(move || {
            let mut agent: Option<u32> = None;
            for _ in 0..SESSION_ID_ATTEMPTS {
                std::thread::sleep(SESSION_ID_INTERVAL);
                if ended.load(Ordering::SeqCst) {
                    return;
                }
                // The agent is the pty's child, or — in a session that hands
                // back — the child of the `sh` holding the terminal for it.
                // That child is followed, not re-found: once it has gone, the
                // `sh` is the user's shell, and a `claude` started in it is a
                // different conversation from the one this record holds.
                let pid = pid as u32;
                let mut found = crate::sessions::published_session_id(&agent_id, pid);
                if found.is_none() {
                    // Adopted only while the `sh` still holds the terminal for
                    // it: an agent that exits before the first tick leaves a
                    // shell whose next child is something the user started.
                    if agent.is_none() && !platform::is_wrapper(pid) {
                        continue;
                    }
                    let children = platform::children_of(pid);
                    agent = agent.or(children.first().copied());
                    match agent {
                        Some(child) if children.contains(&child) => {
                            found = crate::sessions::published_session_id(&agent_id, child);
                        }
                        // The agent has gone without publishing one.
                        Some(_) => return,
                        None => {}
                    }
                }
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
            // the record because the send failed.
            if let Some(journal) = journal.as_mut() {
                journal.write(&buf[..len]);
            }
            // Through the shared handle, so a window that adopts this tab
            // receives the next chunk. The lock covers the enqueue alone.
            //
            // A failed send does not end the loop. The window it failed to is
            // either closing — and `Destroyed` ends its sessions, which ends
            // this loop at EOF — or handing the session to another window,
            // which must find the session still drained and the backlog
            // still filling when it attaches.
            reader_output.lock().send(&buf[..len]);
        }
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        // The child is gone, so the registry must let go of it: the pane stays
        // mounted behind the "session ended" overlay, so nothing else will.
        // A deliberate close needs no banner; the tab is already a launcher.
        let deliberate = killed.load(Ordering::SeqCst);
        // Recorded as the registry lets go, so a window adopting the tab finds
        // how it ended rather than nothing at all. Only an exit of its own,
        // and only while it is still the session under that id: one ended to
        // make way for a respawn, or racing one, must not report the new
        // session as over.
        app.state::<Sessions>().forget(&id, &registered, || {
            if !deliberate {
                app.state::<Exits>().0.lock().insert(id.clone(), code);
            }
        });
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
    Ok(Spawned {
        epoch,
        shell_integration: integration.is_some(),
        handback_token,
    })
}

/// A fresh, unguessable token for one session's hand-back announcement.
///
/// From the standard library's randomly keyed hasher: it needs to be
/// unpredictable to a program in the session, not cryptographically strong,
/// and the hasher's keys are secret — seeded from the OS once per thread and
/// stepped for every `RandomState`.
fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default(),
    );
    format!("{:016x}", hasher.finish())
}

/// Hands the token to the `sh` that announces the hand-back — see
/// `platform::HANDBACK_TOKEN_ENV`. A WSL session's environment reaches the
/// distro only through what `WSLENV` names, so the variable is added there
/// too, to whatever the user's own `WSLENV` already carries.
fn pass_token(cmd: &mut CommandBuilder, token: &str, backend: Backend) {
    cmd.env(platform::HANDBACK_TOKEN_ENV, token);
    if backend == Backend::Wsl {
        let inherited = std::env::var("WSLENV").unwrap_or_default();
        let named = format!("{}/u", platform::HANDBACK_TOKEN_ENV);
        let joined = if inherited.is_empty() {
            named
        } else {
            format!("{inherited}:{named}")
        };
        cmd.env("WSLENV", joined);
    }
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
    let Some(leader) = sessions
        .get(&id)
        .ok()
        .and_then(|session| foreground_of(&session))
    else {
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

/// Signals a session's process groups and lets its reader thread wind down.
///
/// The group, not the process: the child is a session leader, so an agent's own
/// subprocesses — a dev server, an MCP server — survive a signal sent only to
/// the leader. And `SIGHUP` alone is a request; anything ignoring it needs
/// `SIGKILL`, or the tab closes while the work keeps running.
///
/// Two groups, because an interactive shell runs each command as a job in a
/// group of its own — the one holding the terminal — and a tab's shell is
/// interactive, whether it was a shell tab from the start or the one an agent
/// handed back to. The group recorded at spawn is the shell's, so on its own
/// it would reach everything but the command running in it. An agent before
/// its hand-back needs no second group: it shares the `sh` holding its
/// terminal, which the spawn group is.
fn end(session: &Session) {
    session.killed.store(true, Ordering::SeqCst);
    signal_groups(&[session.group, foreground_of(session)]);
    // Whatever the group signal reached, the leader still gets the library's
    // own hangup — this is the only path on hosts with no process groups.
    let _ = session.killer.lock().kill();
}

/// The process currently holding the terminal, where the host has the concept.
///
/// `MasterPty::process_group_leader` is itself `#[cfg(unix)]` in portable-pty,
/// so this cannot merely return `None` on Windows — the call has to be absent.
///
/// Only a group in this session's own terminal session counts. Linux keeps
/// reporting a foreground group's id after its last member has gone, until
/// something reclaims the terminal — and an id that has since been reused by
/// an unrelated process group would otherwise take `end`'s `SIGKILL`.
///
/// The session is asked of a member, not of the id: a pipeline's leader can
/// exit before the rest of it — `cat f | less` — and the id then names no
/// process for `getsid` to answer about.
#[cfg(unix)]
fn foreground_of(session: &Session) -> Option<i32> {
    let group = session.master.lock().process_group_leader()?;
    let leader = session.group?;
    // SAFETY: a plain query of another process's session id.
    let in_session = |pid: i32| unsafe { libc::getsid(pid) } == leader;
    let owned = in_session(group)
        || platform::group_members(group)
            .into_iter()
            .any(|pid| in_session(pid as i32));
    owned.then_some(group)
}

#[cfg(not(unix))]
fn foreground_of(_session: &Session) -> Option<i32> {
    None
}

#[cfg(unix)]
fn signal_groups(groups: &[Option<i32>]) {
    let mut targets: Vec<i32> = groups
        .iter()
        .flatten()
        .copied()
        .filter(|group| *group > 1)
        .collect();
    targets.dedup();
    if targets.is_empty() {
        return;
    }
    for group in &targets {
        unsafe { libc::killpg(*group, libc::SIGHUP) };
    }
    // A short grace period so a well-behaved process can save and exit before
    // it is killed outright.
    std::thread::sleep(Duration::from_millis(150));
    for group in &targets {
        unsafe { libc::killpg(*group, libc::SIGKILL) };
    }
}

#[cfg(not(unix))]
fn signal_groups(_groups: &[Option<i32>]) {}

/// Exercises the real chain behind the status bar's directory: a PTY, a shell
/// that changes directory, and reading that directory back out. Unit tests
/// cannot reach it — only a live process group can.
#[cfg(all(test, unix))]
#[path = "pty_tests.rs"]
mod cwd_tests;
