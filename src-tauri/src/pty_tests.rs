use std::{
    io::Write,
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use tauri::ipc::{Channel, InvokeResponseBody};

use super::{apply_mode, end, Session, Sessions, INHERITED_SESSION_MARKERS, SCROLLBACK_ENV};
use std::sync::Weak;

/// An output channel that goes nowhere, for a session under test.
fn discard() -> Channel<InvokeResponseBody> {
    Channel::new(|_| Ok(()))
}

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
        let marker =
            std::env::temp_dir().join(format!("muster-quit-{}-{index}.pid", std::process::id()));
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
                output: Arc::new(Mutex::new(discard())),
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
        output: Arc::new(Mutex::new(discard())),
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

/// A tab moving between windows must not end the agent that is running in it.
/// `pty_spawn` cannot do this — it ends whatever held the id — so the swap is
/// the only route, and it has to leave the child alone.
#[test]
fn re_pointing_a_session_leaves_its_child_running() {
    let pair = native_pty_system()
        .openpty(PtySize::default())
        .expect("openpty");
    let mut command = CommandBuilder::new("sleep");
    command.arg("30");
    let child = pair.slave.spawn_command(command).expect("spawn");
    drop(pair.slave);
    let group = child.process_id().map(|pid| pid as i32);
    let killer = child.clone_killer();
    let (stdin, _queued) = mpsc::channel::<Vec<u8>>();

    let sessions = Sessions::default();
    sessions.0.lock().insert(
        "tab-move".to_string(),
        Arc::new(Session {
            master: Mutex::new(pair.master),
            stdin,
            group,
            killer: Mutex::new(killer),
            killed: Arc::new(AtomicBool::new(false)),
            output: Arc::new(Mutex::new(discard())),
        }),
    );

    let session = sessions.get("tab-move").expect("session");
    *session.output.lock() = discard();

    assert!(
        alive(group.expect("group")),
        "swapping the output must not touch the child"
    );
    assert!(
        sessions.0.lock().contains_key("tab-move"),
        "the session stays registered under the same id"
    );
    end(&session);
}

/// Re-pointing an id nothing is running under is an error, not a new session.
#[test]
fn re_pointing_an_unknown_session_fails() {
    let sessions = Sessions::default();
    assert!(sessions.get("no-such-tab").is_err());
}

/// The markers are stripped after the environment is set, so a variable named
/// in both lists would be removed by the loop that follows it — setting it and
/// stripping it reads as working and leaves the agent in the alternate buffer.
#[test]
fn nothing_the_session_needs_is_also_stripped_from_it() {
    for (key, _) in SCROLLBACK_ENV {
        assert!(
            !INHERITED_SESSION_MARKERS.contains(key),
            "{key} is both set and removed"
        );
    }
}

/// A clicks session must *remove* the variable, not merely decline to set it:
/// `CommandBuilder` seeds itself from this process's own environment, so a
/// Muster started from a shell that exports it would hand it to every session
/// and the mode control would silently do nothing.
#[test]
fn a_clicks_session_strips_a_variable_it_inherited() {
    let mut cmd = CommandBuilder::new("true");
    for (key, value) in SCROLLBACK_ENV {
        cmd.env(key, value);
    }
    apply_mode(&mut cmd, false);
    for (key, _) in SCROLLBACK_ENV {
        assert!(
            cmd.get_env(key).is_none(),
            "{key} survived a clicks session"
        );
    }
}

#[test]
fn a_scrollback_session_carries_the_variable() {
    let mut cmd = CommandBuilder::new("true");
    apply_mode(&mut cmd, true);
    for (key, value) in SCROLLBACK_ENV {
        assert_eq!(cmd.get_env(key).and_then(|set| set.to_str()), Some(*value));
    }
}

/// A session for the registry to hold, with a child that outlives the test.
fn parked_session() -> (Arc<Session>, i32) {
    let pair = native_pty_system()
        .openpty(PtySize::default())
        .expect("openpty");
    let mut command = CommandBuilder::new("sleep");
    command.arg("30");
    let child = pair.slave.spawn_command(command).expect("spawn");
    drop(pair.slave);
    let group = child.process_id().map(|pid| pid as i32);
    let killer = child.clone_killer();
    let (stdin, _queued) = mpsc::channel::<Vec<u8>>();
    let session = Arc::new(Session {
        master: Mutex::new(pair.master),
        stdin,
        group,
        killer: Mutex::new(killer),
        killed: Arc::new(AtomicBool::new(false)),
        output: Arc::new(Mutex::new(discard())),
    });
    (session, group.expect("group"))
}

/// Reopening a conversation — the mode control, the width repair, a record
/// from the journal — respawns under the **same tab id**, so the new session
/// is registered while the old child is still dying. The old reader thread
/// then reports its exit, and forgetting by id alone would drop the live
/// session: the terminal keeps drawing, because the reader thread owns the
/// output channel rather than the registry, so the tab looks healthy and only
/// typing is dead.
#[test]
fn a_dying_session_does_not_forget_the_one_that_replaced_it() {
    let sessions = Sessions::default();
    let (old, old_pid) = parked_session();
    let (new, new_pid) = parked_session();
    let old_identity = Arc::downgrade(&old);

    sessions.0.lock().insert("tab".to_string(), old.clone());
    let replaced = sessions.0.lock().insert("tab".to_string(), new.clone());
    assert!(replaced.is_some(), "the respawn took the id");

    // What the old child's reader thread does once `child.wait()` returns.
    sessions.forget("tab", &old_identity);

    let still_there = sessions
        .get("tab")
        .expect("the new session is still registered");
    assert!(
        Arc::ptr_eq(&still_there, &new),
        "the old session's exit must not unregister the one that replaced it"
    );

    end(&old);
    end(&new);
    let _ = (old_pid, new_pid);
}

/// The other half: a session that really is the current one is forgotten, or
/// the quit prompt counts tabs with nothing running.
#[test]
fn a_session_that_is_still_the_current_one_is_forgotten_on_exit() {
    let sessions = Sessions::default();
    let (only, _pid) = parked_session();
    let identity = Arc::downgrade(&only);
    sessions.0.lock().insert("tab".to_string(), only.clone());

    sessions.forget("tab", &identity);

    assert!(sessions.get("tab").is_err(), "the registry let go of it");
    assert_eq!(sessions.live(), 0);
    end(&only);
}

/// A weak handle to a session nothing holds any more names nothing to remove.
#[test]
fn forgetting_a_session_already_gone_leaves_the_registry_alone() {
    let sessions = Sessions::default();
    let (current, _pid) = parked_session();
    sessions.0.lock().insert("tab".to_string(), current.clone());

    let stale: Weak<Session> = {
        let (gone, _) = parked_session();
        let weak = Arc::downgrade(&gone);
        end(&gone);
        weak
    };
    sessions.forget("tab", &stale);

    assert!(
        sessions.get("tab").is_ok(),
        "an unrelated session is untouched"
    );
    end(&current);
}
