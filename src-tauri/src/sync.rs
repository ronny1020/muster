//! Commit, pull and push — the writes the review and history drawers make —
//! and the way this app runs any git command that may take its time.
//!
//! Each of the three runs under an `op` id the frontend chose, so the button
//! beside it can cancel it: a hook, a remote or a credential prompt can all
//! stall, and a drawer stuck on "Running git…" has no other way out.

use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex, OnceLock, PoisonError},
    thread,
    time::Duration,
};

use crate::workspace::{expand_home, git, git_in, git_status, push_remote, tracked_remote};

/// Commits the working tree with `message`, answering git's one-line summary.
///
/// What is staged is what gets committed — someone who staged half a change
/// in the terminal meant it. With nothing staged, every uncommitted change is
/// staged first, untracked files included, and unstaged again if the commit
/// fails: a hook that refuses would otherwise leave the whole tree staged, and
/// the retry after fixing a file would commit the copy from before the fix.
#[tauri::command]
pub async fn git_commit(cwd: String, message: String, op: String) -> Result<String, String> {
    blocking(move || commit(&cwd, &message, &op)).await
}

/// Fast-forwards the current branch from its upstream, or explains why not.
///
/// Fast-forward only: a pull that merged or rebased could stop half-way with
/// conflicts in a tree an agent is working in, and git's refusal says what to
/// do instead.
#[tauri::command]
pub async fn git_pull(cwd: String, op: String) -> Result<String, String> {
    blocking(move || {
        let cwd = expand_home(&cwd);
        let path = Path::new(&cwd);
        let running = Running::new(&op, path);
        remote(path, &["pull", "--ff-only"], &running)
    })
    .await
}

/// Pushes the current branch, or publishes it where a plain push would not go
/// where the drawer's label said — see [`push_target`].
#[tauri::command]
pub async fn git_push(cwd: String, op: String) -> Result<String, String> {
    blocking(move || push(&cwd, &op)).await
}

/// Asks the git command running under `op` to stop; `false` when none is.
#[tauri::command]
pub fn git_cancel(op: String) -> bool {
    match lock_running().get_mut(&op) {
        Some(requested) => {
            *requested = true;
            true
        }
        None => false,
    }
}

async fn blocking<F>(job: F) -> Result<String, String>
where
    F: FnOnce() -> Result<String, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .unwrap_or_else(|_| Err("git did not run".to_string()))
}

fn commit(cwd: &str, message: &str, op: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("a commit needs a message".to_string());
    }
    let cwd = expand_home(cwd);
    let path = Path::new(&cwd);
    let running = Running::new(op, path);
    // `--quiet` exits 1 when something is staged, and 0 when nothing is.
    let stages_everything = git(path, &["diff", "--cached", "--quiet"]).is_some();
    let committed = (|| {
        if stages_everything {
            run(git_in(path).args(["add", "--all"]), Some(&running))?;
        }
        // `-m` takes the next argument as its value, so a message starting
        // with a dash is still a message.
        run(git_in(path).args(["commit", "-m", message]), Some(&running))
    })();
    if committed.is_err() && stages_everything {
        // `:/` is the whole tree whichever subdirectory the session is in, as
        // `add --all` was; a pathspec keeps a merge in progress, which a bare
        // `reset` would end. Not cancellable: it is the cleanup.
        let _ = run(git_in(path).args(["reset", "--quiet", "--", ":/"]), None);
    }
    Ok(committed?.lines().next().unwrap_or_default().to_string())
}

fn push(cwd: &str, op: &str) -> Result<String, String> {
    let cwd = expand_home(cwd);
    let path = Path::new(&cwd);
    let running = Running::new(op, path);
    let target = push_target(path);
    let mut args = vec!["push"];
    if target.sets_upstream {
        args.push("--set-upstream");
    }
    // `HEAD` rather than a bare `push`, so the branch the label named is the
    // only one sent, whatever `push.default` says — `matching` would push
    // every branch with a counterpart on the remote.
    args.extend([target.remote.as_str(), "HEAD"]);
    remote(path, &args, &running)
}

struct PushTarget {
    remote: String,
    /// Whether the push also makes the branch it lands on the upstream — only
    /// ever when it publishes (`GitStatus::publishes`, which the label reads).
    sets_upstream: bool,
}

/// Where the current branch goes, and what going there does.
///
/// The status is re-read here rather than taken from the drawer's last poll,
/// so if the branch moved in between, this answer is the fresher one.
///
/// Publishing tracks the new branch only when the upstream was on the same
/// remote, or there was none: a branch made from `origin/main` should follow
/// `origin/<its name>` once it has one. A fork workflow tracks the canonical
/// repository on purpose and pushes to its own, so there the upstream is left
/// where the user put it — moving it would make Pull fetch from the fork.
fn push_target(cwd: &Path) -> PushTarget {
    let status = git_status(cwd);
    let remote = push_remote(cwd, &status.branch);
    let elsewhere = matches!(tracked_remote(&status), Some(tracked) if tracked != remote);
    PushTarget {
        sets_upstream: status.publishes && !elsewhere,
        remote,
    }
}

/// A git call that talks to a remote.
///
/// Nobody is watching a terminal for git to ask for a password on, so
/// `GIT_TERMINAL_PROMPT=0` makes a missing credential fail with git's own
/// message rather than wait for an answer nobody can type. A credential helper
/// or an SSH agent still answers as it would in a shell.
fn remote(cwd: &Path, args: &[&str], running: &Running) -> Result<String, String> {
    let mut command = git_in(cwd);
    command.env("GIT_TERMINAL_PROMPT", "0");
    run(command.args(args), Some(running))
}

/// A cancellable git write that keeps git's stderr so a refusal can be shown
/// to the user.
pub(crate) fn run_git_as(cwd: &Path, args: &[&str], op: &str) -> Result<String, String> {
    let running = Running::new(op, cwd);
    run(git_in(cwd).args(args), Some(&running))
}

/// Git's stdout on success; its stderr — or, when that is empty, its stdout,
/// where `commit` says "nothing to commit" — on failure.
///
/// Runs with the login shell's `PATH` and no terminal: hooks and credential
/// helpers are the user's own programs, and see what a terminal would give
/// them — except a terminal to prompt on. See [`login_path`] and
/// [`without_terminal`].
fn run(command: &mut Command, running: Option<&Running>) -> Result<String, String> {
    if let Some(path) = login_path() {
        command.env("PATH", path);
    }
    let child = without_terminal(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run git: {error}"))?;
    let out = finish(child, &|| running.is_some_and(Running::cancelled))
        .map_err(|error| format!("could not run git: {error}"))?;
    if out.stopped {
        return match running {
            Some(running) if running.head_moved() => Ok(LANDED_ANYWAY.to_string()),
            _ => Err(CANCELLED.to_string()),
        };
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim_end().to_string();
    Err(match (stderr.is_empty(), stdout.is_empty()) {
        (false, _) => stderr,
        (true, false) => stdout,
        (true, true) => format!("git exited with {}", out.status),
    })
}

/// Cancellation requests, keyed by the `op` a command runs under.
fn lock_running() -> std::sync::MutexGuard<'static, HashMap<String, bool>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    RUNNING
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// What a stopped command answers, and what it answers when its write had
/// already landed — see [`Running::head_moved`].
const CANCELLED: &str = "Cancelled.";
const LANDED_ANYWAY: &str = "Done — git had finished before the stop; a hook after it was stopped.";

/// An `op` that [`git_cancel`] can reach for as long as this lives.
struct Running {
    op: String,
    cwd: std::path::PathBuf,
    /// Where `HEAD` pointed, and at what, when the op began.
    head: (Option<String>, Option<String>),
}

impl Running {
    fn new(op: &str, cwd: &Path) -> Self {
        lock_running().insert(op.to_string(), false);
        Self {
            op: op.to_string(),
            cwd: cwd.to_path_buf(),
            head: head_of(cwd),
        }
    }

    fn cancelled(&self) -> bool {
        lock_running().get(&self.op).copied().unwrap_or(false)
    }

    /// Whether `HEAD` moved since the op began.
    ///
    /// Git commits before `post-commit` runs and switches before
    /// `post-checkout` does, and the hook's exit status becomes git's — so
    /// stopping a hook that hangs there reads as a failed write when the write
    /// is done. Called cancelled, it would keep the commit's draft for a
    /// second commit and the branch switcher open on a stale branch.
    fn head_moved(&self) -> bool {
        head_of(&self.cwd) != self.head
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        lock_running().remove(&self.op);
    }
}

fn head_of(cwd: &Path) -> (Option<String>, Option<String>) {
    (
        git(cwd, &["symbolic-ref", "--quiet", "HEAD"]),
        git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]),
    )
}

/// How much of each stream is kept. A hook can print without end, and the
/// drawer shows a few lines.
const MAX_OUTPUT: usize = 64 * 1024;

/// How long a stopped command has to clean up before it is killed outright.
#[cfg_attr(not(unix), allow(dead_code))]
const GRACE: Duration = Duration::from_secs(2);

/// How long to wait for a stream's end once the command itself has exited.
const DRAIN_GRACE: Duration = Duration::from_millis(500);

struct Finished {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// Stopped before it succeeded. A command that finished its work in the
    /// moment the stop arrived did not stop, whatever was asked.
    stopped: bool,
}

/// Waits for `child`, stopping it once `stop` answers true.
///
/// Polled rather than blocked on, because only the thread that owns the child
/// can stop it without racing its exit: a pid handed to another thread may
/// have been reaped and reused by the time that thread signals it.
fn finish(mut child: Child, stop: &dyn Fn() -> bool) -> std::io::Result<Finished> {
    // Git's summary leads its stdout — `[main abc123] subject` before a
    // `create mode` line per new file — and its refusal ends its stderr, after
    // whatever a hook printed.
    let stdout = child.stdout.take().map(|out| Drain::start(out, Keep::Head));
    let stderr = child.stderr.take().map(|err| Drain::start(err, Keep::Tail));
    let mut asked = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if stop() {
            asked = true;
            break terminate(&mut child)?;
        }
        thread::sleep(Duration::from_millis(20));
    };
    Ok(Finished {
        status,
        stdout: stdout.map(Drain::finish).unwrap_or_default(),
        stderr: stderr.map(Drain::finish).unwrap_or_default(),
        stopped: asked && !status.success(),
    })
}

/// Which [`MAX_OUTPUT`] bytes of a stream to keep.
#[derive(Clone, Copy)]
enum Keep {
    Head,
    Tail,
}

/// A stream read to its end on a thread of its own, so a full pipe never
/// blocks the child.
struct Drain {
    kept: Arc<Mutex<Vec<u8>>>,
    ended: mpsc::Receiver<()>,
}

impl Drain {
    fn start(mut stream: impl Read + Send + 'static, keep: Keep) -> Self {
        let kept = Arc::new(Mutex::new(Vec::new()));
        let (done, ended) = mpsc::channel();
        let into = Arc::clone(&kept);
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                let read = match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                let mut kept = into.lock().unwrap_or_else(PoisonError::into_inner);
                keep_bytes(&mut kept, &chunk[..read], keep);
            }
            let _ = done.send(());
        });
        Self { kept, ended }
    }

    /// What the stream held, waiting only briefly for its end: a background
    /// job the command started — a hook's, a startup file's — inherits the
    /// pipe and can hold it open for as long as it runs, and waiting for that
    /// would hold every later git write in the app behind it.
    fn finish(self) -> Vec<u8> {
        let _ = self.ended.recv_timeout(DRAIN_GRACE);
        std::mem::take(&mut *self.kept.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// Adds `chunk` to `kept`, holding it to [`MAX_OUTPUT`] from the end `keep`
/// names.
fn keep_bytes(kept: &mut Vec<u8>, chunk: &[u8], keep: Keep) {
    match keep {
        Keep::Head => {
            let room = MAX_OUTPUT.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
        }
        Keep::Tail => {
            kept.extend_from_slice(chunk);
            let over = kept.len().saturating_sub(MAX_OUTPUT);
            kept.drain(..over);
        }
    }
}

/// Ends `child` and everything it started, politely first where that exists.
///
/// On Unix, `SIGTERM` to the whole process group — the child leads one of its
/// own, see [`without_terminal`] — reaches the hook or `ssh` git is waiting
/// on, and git removes its `index.lock` on that signal; `SIGKILL` would leave
/// the lock for every later command to trip over. Only after [`GRACE`] is the
/// group killed. Windows has no group signal: `taskkill /T` ends the tree —
/// `git.exe` there is a launcher for the real one — forcibly, so a lock can be
/// left behind.
fn terminate(child: &mut Child) -> std::io::Result<ExitStatus> {
    #[cfg(unix)]
    if let Ok(group) = i32::try_from(child.id()) {
        // SAFETY: plain syscalls on a group this process created and has not
        // yet reaped, so the id cannot have been reused.
        unsafe { libc::kill(-group, libc::SIGTERM) };
        let deadline = std::time::Instant::now() + GRACE;
        while std::time::Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(20));
        }
        unsafe { libc::kill(-group, libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        let _ = crate::platform::command("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .output();
    }
    child.kill()?;
    child.wait()
}

/// Starts the child in a session of its own, with no controlling terminal.
///
/// A Muster started from a shell has that shell's terminal, and `ssh` prompts
/// on `/dev/tty` rather than on stdin — so a host-key question or a key
/// passphrase would wait in a terminal nobody is looking at. Without a
/// terminal they fail instead, with a message the drawer can show. gpg's
/// pinentry is out of reach here: gpg-agent starts it, not git.
fn without_terminal(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid` is async-signal-safe and touches no memory, which
        // is all `pre_exec` asks of the closure it runs after `fork`.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    command
}

/// The `PATH` the user's login shell sets up, or `None` where it cannot be
/// read.
///
/// A Dock-launched app inherits launchd's bare `PATH`, and the programs a
/// commit runs are the user's own — a husky hook calling `bunx`, a git-lfs
/// `pre-push`, `gh` as a credential helper — installed where only their
/// profile looks. Sessions get that `PATH` by running through the login shell;
/// these commands borrow it. Read on the first click that needs it, because it
/// runs the user's startup files, and bounded, because those can wait on
/// something nobody will answer. A success is kept for the life of the app; a
/// failure only for [`RETRY_AFTER`], since a slow first start — a cold `nvm` —
/// should not cost every commit until the app restarts.
fn login_path() -> Option<String> {
    static FOUND: OnceLock<String> = OnceLock::new();
    static FAILED_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    if let Some(path) = FOUND.get() {
        return Some(path.clone());
    }
    let recently_failed = FAILED_AT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .is_some_and(|at| at.elapsed() < RETRY_AFTER);
    if recently_failed {
        return None;
    }
    match read_login_path() {
        Some(path) => Some(FOUND.get_or_init(|| path).clone()),
        None => {
            *FAILED_AT.lock().unwrap_or_else(PoisonError::into_inner) =
                Some(std::time::Instant::now());
            None
        }
    }
}

/// How long a failed read of the login `PATH` is believed before it is tried
/// again.
const RETRY_AFTER: Duration = Duration::from_secs(60);

/// Marks where the `PATH` starts and ends, since startup files can print.
#[cfg_attr(not(unix), allow(dead_code))]
const PATH_MARKER: &str = "__MUSTER_PATH__";

/// How long the login shell has to start before its `PATH` is given up on.
#[cfg(unix)]
const LOGIN_DEADLINE: Duration = Duration::from_secs(5);

#[cfg(unix)]
fn read_login_path() -> Option<String> {
    let mut command = Command::new(crate::platform::default_shell());
    // A prompt plugin runs `git status` here, which refreshes whatever index
    // `GIT_INDEX_FILE` names.
    crate::workspace::without_repository_overrides(&mut command);
    // `-i` as well as `-l`, for the reason `platform::posix_shell_args` gives:
    // the `PATH` edits that matter live in the interactive startup file.
    // On stderr, whose tail is what `finish` keeps: the marker is the last
    // thing printed, however much a startup file said before it.
    command.args([
        "-l",
        "-i",
        "-c",
        &format!("printf '%s%s%s' {PATH_MARKER} \"$PATH\" {PATH_MARKER} >&2"),
    ]);
    let child = without_terminal(&mut command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + LOGIN_DEADLINE;
    let out = finish(child, &|| std::time::Instant::now() > deadline).ok()?;
    if out.stopped || !out.status.success() {
        return None;
    }
    between_markers(&String::from_utf8_lossy(&out.stderr))
}

/// Windows resolves the shims PowerShell sessions need without a profile, and
/// its GUI apps inherit the user's `PATH` already.
#[cfg(not(unix))]
fn read_login_path() -> Option<String> {
    None
}

#[cfg_attr(not(unix), allow(dead_code))]
/// The absolute directories of the `PATH` between the markers, or `None`
/// when there are none.
///
/// A shell that does not expand `"$PATH"` — nushell passes it through as
/// text — would otherwise hand back a `PATH` naming no directory at all, and
/// then no `git` could be found for any write in the app. A relative entry in
/// an otherwise good one — a quoted `~/bin`, a `.` — is only dropped: it
/// names nothing from a directory a hook did not choose, and refusing the whole
/// `PATH` over it would cost every hook the rest.
fn between_markers(out: &str) -> Option<String> {
    let (_, rest) = out.split_once(PATH_MARKER)?;
    let (path, _) = rest.split_once(PATH_MARKER)?;
    let dirs: Vec<&str> = path.split(':').filter(|dir| dir.starts_with('/')).collect();
    (!dirs.is_empty()).then(|| dirs.join(":"))
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
