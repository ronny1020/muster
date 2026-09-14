//! Bounds and path safety for the session journal. Every test here protects a
//! way the record could grow without limit, lose the part worth keeping, or let
//! a tab id reach the filesystem as something other than a filename.

use super::*;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "muster-journal-{name}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch");
    dir
}

#[test]
fn a_tab_id_that_is_not_a_bare_name_is_refused() {
    // Every one of these would escape the journal directory or collide with
    // another session's file if it were pasted into a path.
    for hostile in [
        "../../etc/passwd",
        "a/b",
        "a\\b",
        "session.log",
        "",
        "with space",
        "café",
    ] {
        assert_eq!(file_stem(hostile), None, "accepted {hostile:?}");
    }
}

#[test]
fn a_real_tab_id_survives_unchanged() {
    let id = "0b8f6e3a-2c41-4f7d-9a55-1e2d3c4b5a60";
    assert_eq!(file_stem(id).as_deref(), Some(id));
}

#[test]
fn one_directory_is_one_folder_however_its_path_was_spelled() {
    // The launcher sends tilde paths, recents send absolute ones, and a trailing
    // separator comes free from a folder picker. All three are the same repo.
    let expanded = key("/Users/x/code/muster");
    assert_eq!(key("/Users/x/code/muster/"), expanded);
    assert_eq!(key("/Users/x//code/muster"), expanded);
    assert!(!expanded.is_empty());
}

#[test]
fn a_path_with_nothing_nameable_in_it_still_has_a_folder() {
    assert!(key("/").starts_with("root-"), "{}", key("/"));
    // And the root is one directory however many separators name it.
    assert_eq!(key("/"), key("//"));
}

#[test]
fn reading_a_journal_returns_its_tail_not_its_head() {
    let dir = scratch("tail");
    let path = dir.join("s.log");
    fs::write(&path, b"0123456789").expect("write");

    assert_eq!(tail_bytes(&path, 4).expect("tail"), b"6789");
    // Asking for more than there is returns the file, not an error.
    assert_eq!(tail_bytes(&path, 100).expect("tail"), b"0123456789");
}

#[test]
fn a_session_that_never_stops_printing_stays_bounded() {
    let dir = scratch("cap");
    let path = dir.join("s.log");
    let mut journal = Journal {
        name: "s".to_string(),
        file: File::create(&path).expect("create"),
        path: path.clone(),
        written: 0,
        detached: false,
    };

    let chunk = vec![b'x'; 64 * 1024];
    let mut total = 0u64;
    while total < MAX_SESSION_BYTES * 2 {
        journal.write(&chunk);
        total += chunk.len() as u64;
    }

    let len = fs::metadata(&path).expect("stat").len();
    assert!(
        len <= MAX_SESSION_BYTES,
        "grew to {len}, past the {MAX_SESSION_BYTES} cap"
    );
}

#[test]
fn trimming_keeps_the_end_of_the_session() {
    let dir = scratch("trim");
    let path = dir.join("s.log");
    let mut journal = Journal {
        name: "s".to_string(),
        file: File::create(&path).expect("create"),
        path: path.clone(),
        written: 0,
        detached: false,
    };

    journal.write(&vec![b'o'; MAX_SESSION_BYTES as usize]);
    journal.write(b"THE LAST THING IT PRINTED");

    let kept = fs::read(&path).expect("read");
    assert!(kept.ends_with(b"THE LAST THING IT PRINTED"));
}

#[test]
fn the_sweep_drops_old_records_and_keeps_new_ones() {
    let root = scratch("sweep");
    let repo = root.join("a-repo");
    fs::create_dir_all(&repo).expect("dir");
    let old = repo.join("old.log");
    let fresh = repo.join("fresh.log");
    fs::write(&old, b"gone").expect("write");
    fs::write(&fresh, b"kept").expect("write");
    // Backdated through the file itself, so the test does not wait a day.
    let long_ago = SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30);
    File::options()
        .write(true)
        .open(&old)
        .expect("open")
        .set_modified(long_ago)
        .expect("backdate");

    sweep(&root, Duration::from_secs(60 * 60 * 24 * 14), &[]);

    assert!(
        !old.exists(),
        "a month-old record survived a 14-day retention"
    );
    assert!(fresh.exists(), "today's record was swept");
}

#[test]
fn a_repo_whose_records_all_expired_leaves_no_empty_folder() {
    let root = scratch("empty");
    let repo = root.join("a-repo");
    fs::create_dir_all(&repo).expect("dir");
    let stale = repo.join("only.log");
    fs::write(&stale, b"gone").expect("write");
    File::options()
        .write(true)
        .open(&stale)
        .expect("open")
        .set_modified(SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30))
        .expect("backdate");

    sweep(&root, Duration::from_secs(60 * 60 * 24 * 14), &[]);

    assert!(!repo.exists(), "an emptied repo folder was left behind");
}

#[test]
fn a_running_session_keeps_its_record_however_old_it_looks() {
    // An agent idle overnight has an mtime past the retention period while its
    // handle is still open. On Unix the delete succeeds against an open file,
    // so the rest of that session would be recorded into an unlinked inode.
    let root = scratch("live");
    let repo = root.join("a-repo");
    fs::create_dir_all(&repo).expect("dir");
    // Stamped, like a real record — a fixture named `tab-7.log` passes even
    // when the guard only ever compares whole strings.
    let running = repo.join("tab-7-1789000000000.log");
    fs::write(&running, b"still going").expect("write");
    File::options()
        .write(true)
        .open(&running)
        .expect("open")
        .set_modified(SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30))
        .expect("backdate");

    sweep(
        &root,
        Duration::from_secs(60 * 60 * 24 * 14),
        &["tab-7".to_string()],
    );

    assert!(running.exists(), "a live session's record was swept");

    // And a record of a tab that is *not* running still expires.
    let finished = repo.join("tab-9-1789000000000.log");
    fs::write(&finished, b"done").expect("write");
    File::options()
        .write(true)
        .open(&finished)
        .expect("open")
        .set_modified(SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30))
        .expect("backdate");
    sweep(
        &root,
        Duration::from_secs(60 * 60 * 24 * 14),
        &["tab-7".to_string()],
    );
    assert!(!finished.exists(), "an expired record was protected");
}

#[test]
fn two_directories_that_flatten_alike_get_their_own_folder() {
    // `normalize_key` maps every separator to the same character, so these two
    // are one name to it — and one folder would list one project's sessions
    // under the other's.
    assert_ne!(key("/work/a-b"), key("/work/a/b"));
}

#[test]
fn a_very_deep_directory_still_has_a_creatable_folder_name() {
    // Longer than NAME_MAX and `create_dir_all` fails with ENAMETOOLONG, which
    // reads as "nothing recorded here" with the setting still switched on.
    let deep = format!("/work/{}", "segment/".repeat(80));
    assert!(key(&deep).len() <= 100, "{} is too long", key(&deep).len());
}

#[test]
fn trimming_survives_the_staging_file_being_left_behind() {
    // The staged file is a sibling in the same directory, so it must not be
    // mistaken for a record or block the next trim.
    let dir = scratch("staged");
    let path = dir.join("s.log");
    let mut journal = Journal {
        name: "s".to_string(),
        file: File::create(&path).expect("create"),
        path: path.clone(),
        written: 0,
        detached: false,
    };
    fs::write(path.with_extension("log.trimming"), b"stale").expect("write");

    journal.write(&vec![b'o'; MAX_SESSION_BYTES as usize]);
    journal.write(b"END");

    assert!(fs::read(&path).expect("read").ends_with(b"END"));
}

#[test]
fn one_spelling_agrees_on_separators_without_erasing_them() {
    assert_eq!(one_spelling("/a/b/"), "/a/b");
    assert_eq!(one_spelling("/a//b"), "/a/b");
    assert_eq!(one_spelling("/a/b"), "/a/b");
    // The distinction the digest exists to keep.
    assert_ne!(one_spelling("/a/b"), one_spelling("/a-b"));
    assert_eq!(one_spelling("///"), "/");
}

#[test]
fn a_records_sidecar_goes_when_the_record_does_and_not_before() {
    // The sidecar is written once at spawn while the log keeps growing, so its
    // own mtime is always the older of the two — judging it on that would drop
    // the agent and conversation of a session still inside its retention.
    let root = scratch("meta");
    let repo = root.join("a-repo");
    fs::create_dir_all(&repo).expect("dir");
    let long_ago = SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30);

    // A live-ish record: fresh log, ancient sidecar.
    fs::write(repo.join("busy.log"), b"printing").expect("write");
    fs::write(repo.join("busy.meta"), b"{}").expect("write");
    File::options()
        .write(true)
        .open(repo.join("busy.meta"))
        .expect("open")
        .set_modified(long_ago)
        .expect("backdate");

    // An expired record, sidecar and all.
    fs::write(repo.join("old.log"), b"gone").expect("write");
    fs::write(repo.join("old.meta"), b"{}").expect("write");
    File::options()
        .write(true)
        .open(repo.join("old.log"))
        .expect("open")
        .set_modified(long_ago)
        .expect("backdate");

    sweep(&root, Duration::from_secs(60 * 60 * 24 * 14), &[]);

    assert!(repo.join("busy.log").exists());
    assert!(
        repo.join("busy.meta").exists(),
        "a live record lost the sidecar naming its conversation"
    );
    assert!(!repo.join("old.log").exists());
    assert!(!repo.join("old.meta").exists(), "a sidecar was orphaned");
}

#[test]
fn one_directory_is_one_folder_whatever_case_it_was_typed_in() {
    // macOS and Windows do not distinguish these, and the launcher's typed
    // path and the folder picker's canonicalised one routinely disagree — two
    // folders would mean "nothing recorded here" for a directory with records.
    assert_eq!(key("/Users/x/Code/app"), key("/Users/x/code/app"));
}

#[test]
fn a_trim_that_cannot_stage_keeps_the_real_length_rather_than_zero() {
    // Zeroing the counter puts the next trim a whole cap away, so a directory
    // that stays unwritable grows the log by 4 MB every cycle — unbounded.
    let dir = scratch("cap-failure");
    let path = dir.join("s.log");
    let mut journal = Journal {
        name: "s".to_string(),
        file: File::create(&path).expect("create"),
        path: path.clone(),
        written: MAX_SESSION_BYTES + 1,
        detached: false,
    };
    fs::write(&path, vec![b'x'; 4096]).expect("seed");
    // A directory in place of the staging file makes `File::create` fail the
    // way an unwritable directory does, without changing permissions.
    fs::create_dir_all(path.with_extension("log.trimming")).expect("block");

    journal.trim();

    assert_ne!(journal.written, 0, "the cap was reset to zero");
    assert_eq!(journal.written, 4096);
}
