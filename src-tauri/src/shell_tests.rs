use std::path::Path;

use super::{commands_in, integration_for, shell_kind, Shell};

#[test]
fn a_shell_is_recognised_by_its_name_wherever_it_is_installed() {
    assert_eq!(shell_kind("/bin/zsh"), Some(Shell::Zsh));
    assert_eq!(shell_kind("/opt/homebrew/bin/bash"), Some(Shell::Bash));
    assert_eq!(
        shell_kind("C:\\Program Files\\Git\\bin\\bash.exe"),
        Some(Shell::Bash)
    );
}

#[test]
fn a_shell_with_no_integration_is_left_alone() {
    // `sh` is `dash` on most Linux hosts, which has no `--init-file` at all.
    assert_eq!(shell_kind("/bin/sh"), None);
    assert_eq!(shell_kind("pwsh.exe"), None);
    assert_eq!(shell_kind("/usr/bin/fish"), None);
}

#[test]
fn zsh_is_redirected_by_zdotdir_and_told_where_the_users_own_files_are() {
    let it = integration_for(
        Shell::Zsh,
        Path::new("/data/shell"),
        Some("/home/ada"),
        None,
    );
    assert!(it
        .env
        .contains(&("ZDOTDIR".into(), "/data/shell/zsh".into())));
    assert!(it
        .env
        .contains(&("USER_ZDOTDIR".into(), "/home/ada".into())));
    // The login flag the session already carries is the one that reads the
    // profile, so nothing about the arguments changes.
    assert!(it.args.is_empty(), "zsh keeps its own arguments");
}

#[test]
fn a_users_own_zdotdir_is_what_the_shims_source_from() {
    // Set on this machine, so their startup files are not in their home and
    // sourcing from `$HOME` would run none of them.
    let it = integration_for(
        Shell::Zsh,
        Path::new("/data/shell"),
        Some("/home/ada"),
        Some("/home/ada/.config/zsh"),
    );
    assert!(it
        .env
        .contains(&("USER_ZDOTDIR".into(), "/home/ada/.config/zsh".into())));
}

#[test]
fn bash_takes_an_init_file_in_place_of_its_arguments() {
    let it = integration_for(
        Shell::Bash,
        Path::new("/data/shell"),
        Some("/home/ada"),
        None,
    );
    assert_eq!(
        it.args,
        vec!["--init-file".to_string(), "/data/shell/bash.sh".to_string()]
    );
    // bash ignores an init file for a login shell, so `-l` is dropped and the
    // script runs the login chain itself — which it only does when told.
    assert!(it.env.contains(&("MUSTER_SHELL_LOGIN".into(), "1".into())));
}

#[test]
fn history_is_newest_first_and_says_each_command_once() {
    let history = "git status\nls\ngit status\n";
    assert_eq!(commands_in(history), vec!["git status", "ls"]);
}

#[test]
fn zsh_extended_history_metadata_is_not_part_of_the_command() {
    let history = ": 1758000000:0;cargo test\n: 1758000100:12;git push\n";
    assert_eq!(commands_in(history), vec!["git push", "cargo test"]);
}

#[test]
fn a_line_that_only_looks_like_metadata_is_kept_whole() {
    // A real command can start this way, and dropping its first word would
    // offer a suggestion that runs something else.
    let history = ": not a stamp;echo hi\n";
    assert_eq!(commands_in(history), vec![": not a stamp;echo hi"]);
}

#[test]
fn a_bash_timestamp_line_is_not_offered_as_a_command() {
    let history = "#1758000000\nmake build\n";
    assert_eq!(commands_in(history), vec!["make build"]);
}

#[test]
fn a_line_hidden_with_a_leading_space_is_not_offered() {
    // A leading space asks a shell not to record the line; both still write
    // it when the option is off, so the space is what says it was meant to be
    // hidden — and it has to be read before it is trimmed away.
    let history = " aws configure set secret abc\nls\n";
    assert_eq!(commands_in(history), vec!["ls"]);
}

#[test]
fn a_hidden_line_is_recognised_through_zshs_own_metadata() {
    let history = ": 1758000000:0; aws configure set secret abc\n: 1758000100:0;ls\n";
    assert_eq!(commands_in(history), vec!["ls"]);
}

#[test]
fn a_comment_someone_typed_is_still_a_command() {
    let history = "# leaving a note\n";
    assert_eq!(commands_in(history), vec!["# leaving a note"]);
}

#[test]
fn a_command_written_across_lines_is_dropped_rather_than_joined() {
    // Accepting a suggestion types it into the shell, so a newline in one is
    // a line submitted by the keystroke that promised to complete one.
    let history = "echo one \\\nand two\nls\n";
    assert_eq!(commands_in(history), vec!["ls"]);
}

#[test]
fn a_command_carrying_a_control_byte_is_refused() {
    let history = "ls\nrm -rf /\u{1b}[200~\n";
    assert_eq!(commands_in(history), vec!["ls"]);
}
