use super::*;

#[test]
fn keeps_one_command_per_line() {
    assert_eq!(parse_probe("code\ncursor\n"), ["code", "cursor"]);
}

#[test]
fn ignores_chatter_a_login_profile_prints() {
    let out = "Welcome to your shell\ncode\n\n  zed  \nnvm: version 20\n";
    assert_eq!(parse_probe(out), ["code", "zed"]);
}

#[test]
fn an_empty_answer_means_no_editor_was_found() {
    assert!(parse_probe("").is_empty());
    assert!(parse_probe("\n\n").is_empty());
}

#[test]
fn refuses_a_command_that_is_not_in_the_table() {
    let error = open_in_editor("/tmp".into(), "rm -rf /".into(), None).unwrap_err();
    assert!(error.contains("unknown editor"));
}

#[test]
fn opens_a_vs_code_derivative_at_the_line() {
    assert_eq!(open_args("code", "/a/b.ts", Some(42)), ["-g", "/a/b.ts:42"]);
    assert_eq!(open_args("cursor", "/a/b.ts", Some(7)), ["-g", "/a/b.ts:7"]);
}

#[test]
fn drops_the_line_for_an_editor_that_has_no_flag_for_it() {
    // Better to open at line 1 than to be refused over an unknown flag.
    assert_eq!(open_args("zed", "/a/b.ts", Some(42)), ["/a/b.ts"]);
    assert_eq!(open_args("idea", "/a/b.ts", Some(42)), ["/a/b.ts"]);
}

#[test]
fn passes_a_bare_target_when_there_is_no_line() {
    assert_eq!(open_args("code", "/a/b.ts", None), ["/a/b.ts"]);
}

#[test]
fn runs_from_a_directory_target_itself() {
    assert_eq!(
        working_dir(env!("CARGO_MANIFEST_DIR")),
        env!("CARGO_MANIFEST_DIR")
    );
}

#[test]
fn runs_from_a_file_targets_parent() {
    let file = format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
    assert_eq!(working_dir(&file), env!("CARGO_MANIFEST_DIR"));
}

#[test]
fn falls_back_to_the_current_directory_for_a_bare_name() {
    assert_eq!(working_dir("notes.md"), ".");
}

#[test]
fn every_known_editor_is_listed_once() {
    let commands: Vec<&str> = KNOWN.iter().map(|(command, _)| *command).collect();
    let unique: std::collections::HashSet<_> = commands.iter().collect();
    assert_eq!(unique.len(), commands.len());
}

#[test]
fn detection_answers_without_erroring_on_this_machine() {
    // Which editors exist is the machine's business; that the probe returns
    // a well-formed answer is ours.
    for editor in available() {
        assert!(!editor.command.is_empty());
        assert!(KNOWN.iter().any(|(command, _)| *command == editor.command));
    }
}
