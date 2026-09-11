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
