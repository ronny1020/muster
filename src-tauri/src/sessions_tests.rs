use super::*;

#[test]
fn a_tilde_path_matches_the_store_the_same_as_its_absolute_form() {
    let home = platform::home().unwrap();
    // The failure this guards against disabled Continue on real history.
    assert_eq!(
        count_sessions("claude", &format!("{home}/muster-no-such-dir")),
        count_sessions("claude", "~/muster-no-such-dir"),
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
    assert_eq!(count_sessions("codex", "/work"), None);
    assert_eq!(count_sessions("antigravity", "/work"), None);
    assert_eq!(count_sessions("shell", "/work"), None);
}

#[test]
fn claude_always_answers_with_a_count() {
    assert!(count_sessions("claude", "/definitely/not/here").is_some());
    assert_eq!(count_sessions("claude", "/definitely/not/here"), Some(0));
}

#[test]
fn finds_this_repos_own_claude_sessions_if_any_exist() {
    // Whether this machine has history is its business; that the lookup
    // runs and answers is ours.
    let count = count_sessions("claude", env!("CARGO_MANIFEST_DIR"));
    assert!(count.is_some());
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
