use super::*;

#[test]
fn a_tilde_path_matches_the_store_the_same_as_its_absolute_form() {
    let home = platform::home().unwrap();
    // The failure this guards against disabled Continue on real history.
    assert_eq!(
        count_sessions("claude", &format!("{home}/muster-no-such-dir"), "native"),
        count_sessions("claude", "~/muster-no-such-dir", "native"),
    );
}

#[test]
fn a_path_and_its_flattened_store_name_agree() {
    assert_eq!(
        normalize_key("/Users/ada/Documents/temp/ai-terminal"),
        normalize_key("-Users-ada-Documents-temp-ai-terminal"),
    );
}

#[test]
fn punctuation_in_a_directory_name_does_not_break_the_match() {
    // The store's substitution rule is unknown, so a dot must compare equal
    // to whatever it was replaced with.
    assert_eq!(
        normalize_key("/work/my.project"),
        normalize_key("-work-my-project")
    );
    assert_eq!(
        normalize_key("/work/my_project"),
        normalize_key("-work-my-project")
    );
}

#[test]
fn different_directories_do_not_collide() {
    assert_ne!(normalize_key("/work/one"), normalize_key("/work/two"));
    assert_ne!(normalize_key("/a/b"), normalize_key("/a/b/c"));
}

#[test]
fn repeated_and_trailing_separators_are_ignored() {
    assert_eq!(normalize_key("/work//repo/"), normalize_key("/work/repo"));
}

#[test]
fn an_unknown_agent_reports_nothing_rather_than_zero() {
    // Zero would hide Continue; None leaves it to the CLI to decide.
    assert_eq!(count_sessions("codex", "/work", "native"), None);
    assert_eq!(count_sessions("antigravity", "/work", "native"), None);
    assert_eq!(count_sessions("shell", "/work", "native"), None);
}

/// Whether this machine has a Claude Code store that can be read at all.
///
/// The three assertions below are about the difference between "the store was
/// read and holds nothing here" and "the store could not be read", which is
/// the distinction `agent_sessions` exists to keep — so each one has to say
/// which machine it is on rather than assume the CLI has ever run. A fresh
/// checkout on a CI runner has no store, and a test that assumes one is
/// asserting an environment rather than a behaviour.
fn store_is_readable() -> bool {
    projects_root().is_some_and(|root| std::fs::read_dir(root).is_ok())
}

#[test]
fn a_directory_the_store_has_no_record_of_counts_zero() {
    let expected = if store_is_readable() { Some(0) } else { None };
    assert_eq!(
        count_sessions("claude", "/definitely/not/here", "native"),
        expected
    );
}

/// A zero hides the ⟳, and the ⟳ is the only way to reprint a conversation
/// after a resize — so a session whose store this process cannot see at all
/// must answer "unknown", never "empty". A WSL session keeps its store inside
/// the distro while `platform::home()` is the host's.
#[test]
fn a_session_whose_store_we_cannot_see_answers_unknown_rather_than_empty() {
    assert_eq!(count_sessions("claude", "/work", "wsl"), None);
    assert_eq!(
        count_sessions("claude", "/work", "native").is_some(),
        store_is_readable()
    );
}

#[test]
fn finds_this_repos_own_claude_sessions_if_any_exist() {
    // Whether this machine has history is its business; that the lookup runs
    // and answers the store it can see is ours.
    let count = count_sessions("claude", env!("CARGO_MANIFEST_DIR"), "native");
    assert_eq!(count.is_some(), store_is_readable());
}

#[test]
fn counts_only_transcript_files() {
    let dir = std::env::temp_dir().join(format!("muster-sessions-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join("a.jsonl"), b"{}").expect("write");
    std::fs::write(dir.join("b.jsonl"), b"{}").expect("write");
    std::fs::write(dir.join("notes.txt"), b"x").expect("write");

    let counted = count_transcripts(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(counted, 2);
}

#[test]
fn only_claude_publishes_a_session_id_we_know_how_to_read() {
    // Every other agent's store is unverified here, and guessing an id that
    // then reaches an argv is worse than offering no resume at all.
    assert_eq!(published_session_id("codex", std::process::id()), None);
    assert_eq!(published_session_id("gemini", std::process::id()), None);
    assert_eq!(published_session_id("shell", std::process::id()), None);
}

#[test]
fn a_pid_with_no_registry_entry_yields_nothing_rather_than_erroring() {
    // A session that has not written its entry yet is the normal case for the
    // first moments after a spawn.
    assert_eq!(published_session_id("claude", 0), None);
}

/// macOS puts `/tmp` behind a symlink to `/private/tmp`, and the CLI files a
/// project under the path its own process resolved to — so the directory a
/// user opens and the directory the store names are the same one spelled two
/// ways, and matching only what was typed found nothing.
#[test]
#[cfg(unix)]
fn a_directory_reached_through_a_link_matches_the_store_it_resolves_to() {
    let root = std::env::temp_dir().join(format!("muster-keys-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let real = root.join("real");
    std::fs::create_dir_all(&real).expect("real directory");
    let link = root.join("link");
    std::os::unix::fs::symlink(&real, &link).expect("symlink");

    let keys = super::store_keys(&link.to_string_lossy());
    let resolved = std::fs::canonicalize(&real).expect("canonical");
    assert!(
        keys.contains(&super::normalize_key(&resolved.to_string_lossy())),
        "the resolved spelling is one of the keys"
    );
    assert!(
        keys.contains(&super::normalize_key(&link.to_string_lossy())),
        "the spelling the user typed is still a key"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A record outlives the directory it was made in, so a path that no longer
/// resolves must still match what the store already holds.
#[test]
fn a_directory_that_no_longer_exists_still_matches_its_record() {
    let keys = super::store_keys("/no/such/place/at/all");
    assert_eq!(keys, vec![super::normalize_key("/no/such/place/at/all")]);
}

/// The value reaches an argv: the journal's Resume builds
/// `['--resume', <id>]` from it. An alphabet of letters and hyphens is not
/// enough on its own, because a flag is spelled from exactly that alphabet.
#[test]
fn a_published_id_that_is_really_a_flag_is_refused() {
    assert!(!super::is_session_id("--dangerously-skip-permissions"));
    assert!(!super::is_session_id("-r"));
    assert!(super::is_session_id("019bf2a4-1c7e-7b3f-9a2d-4e5f60718293"));
}

/// The same value is joined into a path, and Windows resolves these names to
/// devices whatever extension follows them.
#[test]
fn a_published_id_naming_a_windows_device_is_refused() {
    for name in ["CON", "nul", "CoM1", "LPT9"] {
        assert!(!super::is_session_id(name), "{name} names a device");
    }
    assert!(super::is_session_id("console"), "a real id is not a device");
}

/// The alphabet is what keeps the path half safe; these are the spellings that
/// would escape the directory if it ever widened.
#[test]
fn a_published_id_cannot_spell_a_path() {
    for bad in ["..", "a/b", "a\\b", "c:stream", "a.b", ""] {
        assert!(!super::is_session_id(bad), "{bad:?} is not an id");
    }
    assert!(!super::is_session_id(&"x".repeat(65)));
}

/// The stem of every file listed becomes `--resume <id>`, so a transcript
/// whose name is not an id is left out rather than offered.
#[test]
fn a_transcript_whose_name_is_not_a_session_id_is_not_offered() {
    let dir = std::env::temp_dir().join(format!("muster-listing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join("--dangerously-skip-permissions.jsonl"), b"{}").expect("write");
    std::fs::write(dir.join("notes.txt"), b"x").expect("write");
    std::fs::write(
        dir.join("019bf2a4-1c7e-7b3f-9a2d-4e5f60718293.jsonl"),
        b"{}",
    )
    .expect("write");

    let ids = super::listed_in(&dir)
        .listed
        .into_iter()
        .map(|past| past.id)
        .collect::<Vec<_>>();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(ids, vec!["019bf2a4-1c7e-7b3f-9a2d-4e5f60718293"]);
}

/// The newest conversation is the one most likely to be wanted, and the bound
/// drops from the other end.
///
/// The two mtimes are set rather than taken from the writes: a filesystem with
/// one-second resolution gives both files the same one, and the sort is stable,
/// so the assertion would fall back to `read_dir` order and pin nothing.
#[test]
fn conversations_are_listed_newest_first() {
    let dir = std::env::temp_dir().join(format!("muster-order-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    for (name, at) in [("older", 1_000_000), ("newer", 2_000_000)] {
        let path = dir.join(format!("{name}.jsonl"));
        std::fs::write(&path, b"{}").expect("write");
        written_at(&path, at);
    }

    let ids = super::listed_in(&dir)
        .listed
        .into_iter()
        .map(|past| past.id)
        .collect::<Vec<_>>();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(ids, vec!["newer", "older"]);
}

/// An empty list is the cue to fall back to the CLI's own picker, which is
/// the right answer for every store this process cannot read.
#[test]
fn a_store_we_do_not_read_lists_nothing_rather_than_guessing() {
    assert!(list_sessions("codex", "/work", "native").listed.is_empty());
    assert!(list_sessions("claude", "/work", "wsl").listed.is_empty());
}

/// A conversation is a file, so a directory or a link wearing the same name is
/// not one — it would draw a row whose resume has nothing behind it.
#[test]
fn only_a_regular_file_is_offered_as_a_conversation() {
    let dir = std::env::temp_dir().join(format!("muster-kinds-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join("realone.jsonl"), b"{}").expect("write");
    std::fs::create_dir_all(dir.join("adirectory.jsonl")).expect("mkdir");
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.join("realone.jsonl"), dir.join("alink.jsonl")).expect("link");

    let ids = super::listed_in(&dir)
        .listed
        .into_iter()
        .map(|past| past.id)
        .collect::<Vec<_>>();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(ids, vec!["realone"]);
}

/// Gives a file an mtime of its own, so an ordering assertion does not depend
/// on how finely this filesystem records one.
fn written_at(path: &std::path::Path, seconds: u64) {
    let when = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("open")
        .set_times(std::fs::FileTimes::new().set_modified(when))
        .expect("set mtime");
}

/// The bound is what hides history, so only the listing can say any is hidden:
/// the count beside it applies none of these filters, and comparing the two
/// would offer the picker for a directory that has nothing more in it.
#[test]
fn a_store_larger_than_the_bound_says_so() {
    let dir = std::env::temp_dir().join(format!("muster-bound-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    for n in 0..super::MAX_LISTED + 5 {
        std::fs::write(dir.join(format!("session-{n:04}.jsonl")), b"{}").expect("write");
    }

    let found = super::listed_in(&dir);
    let counted = super::count_transcripts(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(found.listed.len(), super::MAX_LISTED);
    assert!(found.more, "the store holds more than the list carries");
    assert_eq!(counted, super::MAX_LISTED as u32 + 5);
}

/// And a store the bound did not reach says nothing is hidden, whatever the
/// count says — a directory holding one entry that is not a conversation
/// counts higher than it lists.
#[test]
fn a_store_within_the_bound_offers_no_more() {
    let dir = std::env::temp_dir().join(format!("muster-within-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(dir.join("realone.jsonl"), b"{}").expect("write");
    std::fs::create_dir_all(dir.join("adirectory.jsonl")).expect("mkdir");

    let found = super::listed_in(&dir);
    let counted = super::count_transcripts(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(found.listed.len(), 1);
    assert!(!found.more);
    assert_eq!(counted, 2, "the count sees what the list refused");
}
