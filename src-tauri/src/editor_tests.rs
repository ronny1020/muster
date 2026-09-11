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

#[test]
fn an_installed_bundle_is_found_without_a_shell_command() {
    // macOS leaves `PATH` alone when it installs an editor: VS Code's `code`
    // arrives only if you run it from the palette, so looking for the command
    // alone reported nothing but Neovim on a machine with two editors on it.
    let root = std::env::temp_dir().join(format!(
        "muster-apps-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let bundle = root.join("Visual Studio Code.app");
    std::fs::create_dir_all(&bundle).expect("mkdir");

    let roots = [root.clone()];
    let found = bundle_in(&roots, "Visual Studio Code");
    let missing = bundle_in(&roots, "Cursor");
    let _ = std::fs::remove_dir_all(&root);

    assert_eq!(found.as_deref(), Some(bundle.as_path()));
    assert_eq!(missing, None);
}

#[test]
fn the_tool_inside_a_bundle_is_preferred_to_the_bundle_itself() {
    // It takes the same flags as the shell command, including the one that
    // opens a file at a line; `open -a` takes none of them.
    let root = std::env::temp_dir().join(format!(
        "muster-cli-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let bundle = root.join("Visual Studio Code.app");
    let bin = bundle.join("Contents/Resources/app/bin");
    std::fs::create_dir_all(&bin).expect("mkdir");

    assert_eq!(bundle_cli(&bundle, "code"), None, "no tool shipped yet");
    std::fs::write(bin.join("code"), "#!/bin/sh\n").expect("write");
    let cli = bundle_cli(&bundle, "code");
    // A bundle listed with no tool is never probed for one.
    assert_eq!(bundle_cli(&bundle, ""), None);
    let _ = std::fs::remove_dir_all(&root);

    assert_eq!(cli.as_deref(), Some(bin.join("code").as_path()));
}

#[test]
fn an_editor_with_no_bundle_is_left_to_the_login_shell() {
    // Which is the only route on Linux and Windows, where the installer puts
    // the command on `PATH` itself.
    assert_eq!(launcher("nvim"), Launcher::Shell);
}

#[test]
fn the_tool_is_not_always_named_after_the_command() {
    // Antigravity's editor is `Antigravity IDE`, whose tool is
    // `antigravity-ide`; plain `Antigravity.app` beside it is a language
    // server and opens nothing.
    let entry = BUNDLES
        .iter()
        .find(|(command, _, _)| *command == "antigravity")
        .expect("antigravity is a known editor");

    assert_eq!((entry.1, entry.2), ("Antigravity IDE", "antigravity-ide"));
}

#[test]
fn every_bundle_names_an_editor_the_table_knows() {
    // A bundle for a command that is not in `KNOWN` could never be launched:
    // `open_in_editor` refuses anything outside that table.
    for (command, app, _) in BUNDLES {
        assert!(
            KNOWN.iter().any(|(known, _)| known == command),
            "{app} claims the unknown command {command}"
        );
    }
}

#[test]
fn every_editor_that_ships_a_vs_code_launcher_jumps_to_the_line() {
    // The bundles carrying a `Contents/Resources/app/bin` tool are the VS Code
    // family, and the flag comes with the fork. Antigravity IDE's launcher is
    // byte-identical to VS Code's.
    for (command, app, cli) in BUNDLES.iter().filter(|(_, _, cli)| !cli.is_empty()) {
        assert!(
            GOTO_FLAG.contains(command),
            "{app} ships {cli} but is not offered a line number"
        );
    }
}
