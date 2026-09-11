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
