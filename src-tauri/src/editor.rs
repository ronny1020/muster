//! Opening a session's directory in the user's editor.
//!
//! Editors are found by their launcher command rather than by looking for an
//! installed application, because the command is what can open a directory —
//! and it is the same thing the user would type themselves.

use std::path::Path;

use crate::platform;

/// An editor the user could open a directory with.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub command: String,
    pub name: String,
}

/// Editor launchers worth looking for, most common first. The order decides
/// which one a tab offers when the user has not picked a favourite.
const KNOWN: &[(&str, &str)] = &[
    ("code", "VS Code"),
    ("cursor", "Cursor"),
    ("antigravity", "Antigravity"),
    ("windsurf", "Windsurf"),
    ("zed", "Zed"),
    ("subl", "Sublime Text"),
    ("idea", "IntelliJ IDEA"),
    ("webstorm", "WebStorm"),
    ("pycharm", "PyCharm"),
    ("code-insiders", "VS Code Insiders"),
    ("codium", "VSCodium"),
    ("nvim", "Neovim"),
    ("vim", "Vim"),
];

/// Which of the known editors this machine can actually launch.
///
/// One login shell answers for all of them: a shell per candidate would mean a
/// dozen profile evaluations, and the profile is exactly what puts an editor's
/// command on `PATH` in the first place.
#[tauri::command]
pub async fn editors() -> Vec<Editor> {
    tauri::async_runtime::spawn_blocking(available)
        .await
        .unwrap_or_default()
}

/// Spawns a whole login shell, so it belongs on the blocking pool.
fn available() -> Vec<Editor> {
    let found = probe(
        &KNOWN
            .iter()
            .map(|(command, _)| *command)
            .collect::<Vec<_>>(),
    );
    KNOWN
        .iter()
        .filter(|(command, _)| found.iter().any(|name| name == command))
        .map(|(command, name)| Editor {
            command: (*command).into(),
            name: (*name).into(),
        })
        .collect()
}

/// Editors that take `-g path:line:column` to open at a position. They are all
/// VS Code derivatives, which is also why they share the flag.
const GOTO_FLAG: &[&str] = &["code", "code-insiders", "codium", "cursor", "windsurf"];

/// Arguments that open `target` in `command`, at `line` where the editor can.
///
/// A line number is dropped rather than guessed at: an editor given a flag it
/// does not know would refuse to open the file at all, which is worse than
/// landing on line 1.
fn open_args(command: &str, target: &str, line: Option<u32>) -> Vec<String> {
    match line {
        Some(line) if GOTO_FLAG.contains(&command) => {
            vec!["-g".into(), format!("{target}:{line}")]
        }
        _ => vec![target.to_string()],
    }
}

/// The directory to run the editor from: `target` itself when it is one, else
/// its parent. Handing a file to `current_dir` fails outright.
fn working_dir(target: &str) -> String {
    let path = Path::new(target);
    let dir = if path.is_dir() {
        Some(path)
    } else {
        path.parent()
    };
    dir.filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".into())
}

/// Opens `target` — a file or a directory — in `command`, detached, so the
/// editor outlives this call and a slow launch never blocks the window.
#[tauri::command(async)]
pub fn open_in_editor(target: String, command: String, line: Option<u32>) -> Result<(), String> {
    if !KNOWN.iter().any(|(known, _)| *known == command) {
        // Only ever run a command from the table, never one that arrived as data.
        return Err(format!("unknown editor {command}"));
    }

    let args = open_args(&command, &target, line);
    let cwd = working_dir(&target);
    let argv = platform::argv(&platform::Launch {
        backend: platform::Backend::Native,
        distro: None,
        cwd: &cwd,
        program: &command,
        args: &args,
        via_shell: true,
    });

    platform::command(&argv.program)
        .args(&argv.args)
        .current_dir(&argv.cwd)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start {command}: {error}"))
}

/// Asks one login shell which of `candidates` it can resolve.
fn probe(candidates: &[&str]) -> Vec<String> {
    let script = format!(
        "for c in {}; do command -v \"$c\" >/dev/null 2>&1 && echo \"$c\"; done",
        candidates.join(" ")
    );
    let output = platform::command(platform::default_shell())
        .args(shell_args(&script))
        .output();

    match output {
        Ok(out) => parse_probe(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => Vec::new(),
    }
}

/// PowerShell needs its own spelling of "run this script and exit".
#[cfg(windows)]
fn shell_args(script: &str) -> Vec<String> {
    let powershell = format!(
        "foreach ($c in @({})) {{ if (Get-Command $c -ErrorAction SilentlyContinue) {{ $c }} }}",
        script_names(script)
            .iter()
            .map(|name| format!("'{name}'"))
            .collect::<Vec<_>>()
            .join(",")
    );
    vec!["-NoLogo".into(), "-Command".into(), powershell]
}

/// The candidate names back out of the POSIX script, so the two shells stay
/// driven by one list.
#[cfg(windows)]
fn script_names(script: &str) -> Vec<&str> {
    script
        .split_once("for c in ")
        .and_then(|(_, rest)| rest.split_once(';'))
        .map(|(names, _)| names.split_whitespace().collect())
        .unwrap_or_default()
}

/// `-i` for the same reason a session needs it: an editor's launcher command is
/// usually on a `PATH` that only `.zshrc` sets.
#[cfg(unix)]
fn shell_args(script: &str) -> Vec<String> {
    vec!["-l".into(), "-i".into(), "-c".into(), script.into()]
}

/// One resolved command per line; anything else the profile printed is noise.
fn parse_probe(out: &str) -> Vec<String> {
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.contains(char::is_whitespace))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
