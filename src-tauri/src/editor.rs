//! Opening a session's directory in the user's editor.
//!
//! Editors are found by their launcher command rather than by looking for an
//! installed application, because the command is what can open a directory —
//! and it is the same thing the user would type themselves.

use std::path::{Path, PathBuf};

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
    ("antigravity", "Antigravity IDE"),
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

/// Application bundles for the editors whose shell command is opt-in.
///
/// macOS installs an editor as a bundle and leaves the `PATH` alone: VS Code's
/// `code` arrives only if you run "Shell Command: Install 'code' command" from
/// its palette, and most people never do. Looking for the command alone
/// therefore misses editors that are installed and working, which is what the
/// settings pane showing nothing but Neovim looked like.
/// The command, the bundle to look for, and the tool inside it — which is not
/// always named after the command: Antigravity's editor is `Antigravity IDE`,
/// whose tool is `antigravity-ide`, while plain `Antigravity.app` beside it is
/// only a language server. An empty tool name means the bundle ships none of
/// the VS Code family's `Contents/Resources/app/bin`, and `open` is the way in.
const BUNDLES: &[(&str, &str, &str)] = &[
    ("code", "Visual Studio Code", "code"),
    ("cursor", "Cursor", "cursor"),
    ("antigravity", "Antigravity IDE", "antigravity-ide"),
    ("windsurf", "Windsurf", "windsurf"),
    (
        "code-insiders",
        "Visual Studio Code - Insiders",
        "code-insiders",
    ),
    ("codium", "VSCodium", "codium"),
    ("zed", "Zed", ""),
    ("subl", "Sublime Text", ""),
    ("idea", "IntelliJ IDEA", ""),
    ("webstorm", "WebStorm", ""),
    ("pycharm", "PyCharm", ""),
];

/// Where macOS keeps applications: everyone's, then this user's.
fn bundle_roots() -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = platform::home() {
        roots.push(Path::new(&home).join("Applications"));
    }
    roots
}

/// The bundle for an editor command, and the tool it ships, if this machine
/// has that editor installed.
fn bundle_for(command: &str) -> Option<(PathBuf, &'static str)> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let (_, app, cli) = BUNDLES.iter().find(|(known, _, _)| *known == command)?;
    bundle_in(&bundle_roots(), app).map(|bundle| (bundle, *cli))
}

/// The first root holding `<app>.app`. Split out from [`bundle_for`] so the
/// lookup is testable without an editor installed.
fn bundle_in(roots: &[PathBuf], app: &str) -> Option<PathBuf> {
    roots
        .iter()
        .map(|root| root.join(format!("{app}.app")))
        .find(|bundle| bundle.is_dir())
}

/// The command-line tool a bundle ships, which takes the same flags as the
/// shell command would — including the one that opens a file at a line.
fn bundle_cli(bundle: &Path, cli: &str) -> Option<PathBuf> {
    if cli.is_empty() {
        return None;
    }
    let path = bundle.join("Contents/Resources/app/bin").join(cli);
    path.is_file().then_some(path)
}

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
        .filter(|(command, _)| {
            found.iter().any(|name| name == command) || bundle_for(command).is_some()
        })
        .map(|(command, name)| Editor {
            command: (*command).into(),
            name: (*name).into(),
        })
        .collect()
}

/// Editors that take `-g path:line:column` to open at a position. They are all
/// VS Code derivatives, which is also why they share the flag — Antigravity
/// IDE ships a launcher script byte-identical to VS Code's own.
const GOTO_FLAG: &[&str] = &[
    "code",
    "code-insiders",
    "codium",
    "cursor",
    "windsurf",
    "antigravity",
];

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

/// How an editor is actually started on this machine.
#[derive(Debug, PartialEq)]
enum Launcher {
    /// The tool inside an installed bundle — the same binary the shell command
    /// is a symlink to, so it takes the same flags.
    Cli(PathBuf),
    /// The bundle itself, handed to `open`. No flags reach the editor this
    /// way, so a line number is dropped rather than mangled.
    Bundle(PathBuf),
    /// The bare command, resolved by a login shell. The only route on Linux
    /// and Windows, where an installer puts the command on `PATH` itself.
    Shell,
}

/// Preferring the bundle costs nothing where a shell command exists — it is a
/// symlink into the same bundle — and saves spawning a login shell to find it.
fn launcher(command: &str) -> Launcher {
    let Some((bundle, cli)) = bundle_for(command) else {
        return Launcher::Shell;
    };
    bundle_cli(&bundle, cli)
        .map(Launcher::Cli)
        .unwrap_or(Launcher::Bundle(bundle))
}

/// Opens `target` — a file or a directory — in `command`, detached, so the
/// editor outlives this call and a slow launch never blocks the window.
#[tauri::command(async)]
pub fn open_in_editor(target: String, command: String, line: Option<u32>) -> Result<(), String> {
    if !KNOWN.iter().any(|(known, _)| *known == command) {
        // The command asked for must be one of ours, never one that arrived as
        // data. Note what this does and does not promise: it fixes *which*
        // editor may be asked for, not which binary answers — the bundle
        // routes run whatever sits at that path, and the shell route resolves
        // the name through the user's own `PATH`. Both are writable by anyone
        // who already has a session in this app.
        return Err(format!("unknown editor {command}"));
    }

    let cwd = working_dir(&target);
    let mut process = match launcher(&command) {
        Launcher::Cli(cli) => {
            let mut process = platform::command(&cli);
            process.args(open_args(&command, &target, line));
            process
        }
        Launcher::Bundle(bundle) => {
            let mut process = platform::command("open");
            process.arg("-a").arg(&bundle).arg(&target);
            process
        }
        Launcher::Shell => {
            let argv = platform::argv(&platform::Launch {
                backend: platform::Backend::Native,
                distro: None,
                cwd: &cwd,
                program: &command,
                args: &open_args(&command, &target, line),
                via_shell: true,
            });
            let mut process = platform::command(&argv.program);
            process.args(&argv.args);
            process
        }
    };

    let child = process
        .current_dir(&cwd)
        .spawn()
        .map_err(|error| format!("could not start {command}: {error}"))?;

    // Reaped on a thread of its own. Dropping a `Child` does not wait for it,
    // and `open` exits the moment it has handed the path over — so without
    // this every Open-in-editor click left a defunct process behind for the
    // life of the app.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
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
