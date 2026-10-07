//! What a session's own shell tells the terminal: the `OSC 133` boundaries it
//! is started with, and the history file it keeps them in.
//!
//! Nothing in the pty stream says where a prompt ends and a command's output
//! begins — measured across 91 recorded sessions on this machine, no shell
//! emits those markers on its own. So a plain shell session is started with a
//! startup file of Muster's own, which sources the user's and then reports the
//! boundaries. Everything the terminal draws around a command — the copy
//! button, the suggestion as you type — reads them.
//!
//! The string building is compiled on every target so a Windows or WSL launch
//! can be checked from a Mac, the way the rest of the launch path is.

use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// A shell Muster ships an integration for.
///
/// Only these two, and the reason is testability as much as effort: both are
/// on this machine, so what they emit was measured rather than reasoned
/// about. PowerShell and fish have their own mechanisms and neither has been
/// run here; a session in one simply reports no boundaries, which costs it the
/// two surfaces and nothing else.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shell {
    Zsh,
    Bash,
}

/// What a spawn needs so the shell reports its command boundaries.
#[derive(Debug, Default, PartialEq)]
pub struct Integration {
    pub env: Vec<(String, String)>,
    /// Arguments that **replace** the shell's own. Empty leaves them alone.
    pub args: Vec<String>,
}

/// Which integration a shell path takes, or `None` for one with none.
///
/// The stem rather than the whole path, so `/bin/zsh`, `/usr/local/bin/zsh`
/// and Windows' `bash.exe` all answer the same. `sh` deliberately does not
/// match: it is `dash` on most Linux hosts, where `--init-file` is not a flag
/// at all.
pub fn shell_kind(shell: &str) -> Option<Shell> {
    match stem(shell).to_ascii_lowercase().as_str() {
        "zsh" => Some(Shell::Zsh),
        "bash" => Some(Shell::Bash),
        _ => None,
    }
}

/// The program's own name out of a path, for either host's separator.
///
/// `Path::file_stem` answers for the host it is compiled on, so a Windows path
/// read on a Mac comes back whole — and the choice between shells is decided
/// here rather than at the host, so it has to be testable from either.
fn stem(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name.split_once('.').map_or(name, |(stem, _)| stem)
}

/// The environment and arguments that inject `dir`'s scripts into `shell`.
///
/// The two shells need opposite things, and neither is a preference:
///
/// zsh reads its startup files from `ZDOTDIR`, so pointing that at Muster's
/// own directory is the whole injection — and `USER_ZDOTDIR` is how the shims
/// there find the user's files to source. A login shell keeps its `-l`.
///
/// bash has no such variable. `--init-file` is the only way in, and bash
/// ignores it for a **login** shell — so `-l` has to go, and the login chain
/// the flag would have run is imitated inside the script. `MUSTER_SHELL_LOGIN`
/// is what tells it to.
pub fn integration_for(
    shell: Shell,
    dir: &Path,
    home: Option<&str>,
    zdotdir: Option<&str>,
) -> Integration {
    match shell {
        Shell::Zsh => Integration {
            env: vec![
                ("ZDOTDIR".into(), dir.join("zsh").to_string_lossy().into()),
                (
                    "USER_ZDOTDIR".into(),
                    zdotdir.or(home).unwrap_or_default().into(),
                ),
            ],
            args: Vec::new(),
        },
        Shell::Bash => Integration {
            env: vec![("MUSTER_SHELL_LOGIN".into(), "1".into())],
            args: vec![
                "--init-file".into(),
                dir.join("bash.sh").to_string_lossy().into(),
            ],
        },
    }
}

/// The scripts, held in the binary so there is nothing to install and nothing
/// to keep in step with a release.
const ZSH_FILES: &[(&str, &str)] = &[
    (".zshenv", include_str!("../shell/zsh/zshenv.zsh")),
    (".zprofile", include_str!("../shell/zsh/zprofile.zsh")),
    (".zshrc", include_str!("../shell/zsh/zshrc.zsh")),
    (".zlogin", include_str!("../shell/zsh/zlogin.zsh")),
];
const BASH_FILE: (&str, &str) = ("bash.sh", include_str!("../shell/bash.sh"));

/// Writes the scripts where the shell can read them, or `None` if it cannot.
///
/// Re-written only when the contents differ, since this runs on every spawn:
/// an upgrade has to replace them, and a session that reads a half-written
/// file gets a shell with no prompt at all — which is why the write goes
/// through a temp file and a rename, the same as `store.rs`. Restoring a deck
/// of shell tabs spawns them at once, so two of these run concurrently on the
/// first launch after an upgrade, and a plain `write` truncates before it
/// fills.
fn install(app: &AppHandle, shell: Shell) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("shell");
    match shell {
        Shell::Zsh => {
            let zsh = dir.join("zsh");
            std::fs::create_dir_all(&zsh).ok()?;
            for (name, body) in ZSH_FILES {
                write_if_changed(&zsh.join(name), body)?;
            }
        }
        Shell::Bash => {
            std::fs::create_dir_all(&dir).ok()?;
            write_if_changed(&dir.join(BASH_FILE.0), BASH_FILE.1)?;
        }
    }
    Some(dir)
}

fn write_if_changed(path: &Path, body: &str) -> Option<()> {
    if std::fs::read_to_string(path).is_ok_and(|held| held == body) {
        return Some(());
    }
    // Unique per call, not per process: the race this exists for is two
    // `pty_spawn`s inside *one* Muster — restoring a deck spawns them at once
    // — so a name built from the pid alone is the same name for both, and one
    // truncates the other's file before either rename lands.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let ticket = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = path.with_extension(format!("tmp{}-{ticket}", std::process::id()));
    std::fs::write(&temp, body).ok()?;
    let renamed = std::fs::rename(&temp, path).ok();
    if renamed.is_none() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

/// What to spawn `shell` with so it reports its command boundaries, or `None`
/// where there is no integration for it or the scripts cannot be written.
pub fn prepare(app: &AppHandle, shell: &str) -> Option<Integration> {
    let kind = shell_kind(shell)?;
    let dir = install(app, kind)?;
    Some(integration_for(
        kind,
        &dir,
        crate::platform::home().as_deref(),
        std::env::var("ZDOTDIR")
            .ok()
            .filter(|d| !d.is_empty())
            .as_deref(),
    ))
}

/// How much of a history file to read. It is append-only and oldest first, so
/// this is taken from the end — the newest commands are the ones a suggestion
/// is drawn from.
const MAX_HISTORY_BYTES: u64 = 512 * 1024;

/// How many commands to hand back. Enough that a suggestion is usually there,
/// small enough that the list crosses the IPC boundary on one keystroke's
/// worth of time.
const MAX_HISTORY: usize = 500;

/// The commands a shell's history file holds, newest first and deduplicated.
///
/// The path is the shell's own answer, reported over `OSC 133;P;HistFile` —
/// not a guess at `~/.zsh_history`, which is wrong for everyone who moved it
/// and for every session whose `ZDOTDIR` is not their home.
///
/// Read without following a link and bounded at both ends, for the reason
/// AGENTS.md's "automatic reads are bounded" invariant gives: this happens on
/// a keystroke, with no click behind it.
#[tauri::command(async)]
pub fn shell_history(path: String) -> Vec<String> {
    let path = crate::workspace::expand_home(&path);
    let Some(reader) = crate::transcript::open_tail(Path::new(&path), MAX_HISTORY_BYTES) else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    let mut reader = reader;
    if reader.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    // Lossy rather than strict: one byte that is not UTF-8 — zsh's own
    // metafication, a latin-1 filename in a command — would otherwise cost
    // the whole list, which is indistinguishable from a history with nothing
    // in it.
    commands_in(&String::from_utf8_lossy(&bytes))
}

/// The commands in a history file's text, newest first.
///
/// One parser for both shells because the formats overlap rather than differ:
/// zsh's extended history writes `: <started>:<elapsed>;<command>` and bash
/// writes the command alone, with a `#<seconds>` line before it when
/// `HISTTIMEFORMAT` is set. A line that is neither is the command itself.
///
/// A line the person hid by starting it with a space is dropped, whatever the
/// shell's own `ignorespace` setting did or did not do with it.
///
/// A command zsh wrote across several lines is dropped rather than joined:
/// what this feeds is a suggestion the terminal **types into the shell** when
/// it is accepted, and a newline in that is a line submitted by a keystroke
/// that promised to complete one. bash marks no continuation at all — with
/// its default `cmdhist` a `for` loop is written as plain lines — so its
/// halves are offered as commands of their own, and accepting one types a
/// fragment. Only a shell reporting the command itself could fix that.
fn commands_in(text: &str) -> Vec<String> {
    let mut whole: Vec<&str> = Vec::new();
    let mut continues = false;
    for line in text.lines() {
        // zsh escapes an embedded newline by ending the line with a
        // backslash: this line carries on into the next, and neither half is
        // worth offering on its own.
        let continued = std::mem::replace(&mut continues, line.ends_with('\\'));
        if continued || continues {
            continue;
        }
        whole.push(line);
    }

    let mut found: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for line in whole.iter().rev() {
        let written = strip_metadata(line);
        // A leading space is how a shell is asked not to record a line. Both
        // still write it when the option is off, so the space is the only
        // thing left saying the person meant to hide it — and it has to be
        // read before the trim below removes it.
        if written.starts_with([' ', '\t']) {
            continue;
        }
        let command = written.trim();
        if command.is_empty() || command.chars().any(char::is_control) {
            continue;
        }
        if !seen.insert(command) {
            continue;
        }
        found.push(command.to_string());
        if found.len() >= MAX_HISTORY {
            break;
        }
    }
    found
}

/// The command in a history line, with whatever the shell wrote in front of it
/// removed.
fn strip_metadata(line: &str) -> &str {
    // bash's timestamp line, which is a comment carrying only digits. A real
    // `# …` comment the user typed is kept.
    if let Some(rest) = line.strip_prefix('#') {
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            return "";
        }
        return line;
    }
    // zsh's extended history: `: <started>:<elapsed>;<command>`.
    let Some(rest) = line.strip_prefix(": ") else {
        return line;
    };
    let Some((stamp, command)) = rest.split_once(';') else {
        return line;
    };
    let Some((started, elapsed)) = stamp.split_once(':') else {
        return line;
    };
    let numeric = |field: &str| !field.is_empty() && field.chars().all(|c| c.is_ascii_digit());
    if numeric(started) && numeric(elapsed) {
        command
    } else {
        line
    }
}

#[cfg(test)]
#[path = "shell_tests.rs"]
mod shell_tests;
