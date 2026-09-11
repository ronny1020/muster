//! Host differences: which shell a session runs through, how a process's
//! working directory is read back, and where the user's home is.
//!
//! Everything that builds a command line is compiled on every platform, so a
//! Windows or WSL launch can be unit-tested from a Mac. Only the choice
//! between them, and the process inspection behind it, is `cfg`-gated.

use std::{ffi::OsStr, process::Command};

/// Which world a session runs in. On Windows a session can run either the
/// host's own shell or one inside a WSL distro; elsewhere there is only the host.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Native,
    Wsl,
}

/// What the frontend needs about the host to draw itself and offer the right
/// launch options.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// `macos`, `windows` or `linux`.
    pub os: &'static str,
    pub path_separator: String,
    /// Whether a session's working directory can be read back as it changes.
    pub follows_cwd: bool,
    /// Distros a session can run inside; empty unless this is Windows with WSL.
    pub wsl_distros: Vec<String>,
}

#[tauri::command(async)]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        path_separator: std::path::MAIN_SEPARATOR.to_string(),
        follows_cwd: FOLLOWS_CWD,
        wsl_distros: wsl_distros(),
    }
}

/// Everything needed to turn a session request into a command line.
pub struct Launch<'a> {
    pub backend: Backend,
    pub distro: Option<&'a str>,
    pub cwd: &'a str,
    /// Empty for a plain interactive shell session.
    pub program: &'a str,
    pub args: &'a [String],
    /// Resolve `program` through a login shell instead of running it directly.
    pub via_shell: bool,
}

/// A resolved command line.
#[derive(Debug, PartialEq)]
pub struct Argv {
    pub program: String,
    pub args: Vec<String>,
    /// Directory the process starts in. A WSL session's own directory lives
    /// inside the distro, which the Windows side of it cannot sit in, so the
    /// two differ there.
    pub cwd: String,
}

/// A stale `wsl` setting can never strand a session: off Windows it is ignored
/// rather than spawning an `wsl.exe` that isn't there.
pub fn argv(launch: &Launch) -> Argv {
    match launch.backend {
        Backend::Wsl if cfg!(windows) => wsl_argv(launch),
        _ => native_argv(launch),
    }
}

fn native_argv(launch: &Launch) -> Argv {
    let cwd = launch.cwd.to_string();
    // A program the caller asked to run without a shell replaces the wrapper;
    // an empty program *is* the shell, so it always keeps it.
    if !launch.via_shell && !launch.program.is_empty() {
        return Argv {
            program: launch.program.to_string(),
            args: launch.args.to_vec(),
            cwd,
        };
    }
    Argv {
        program: default_shell(),
        args: native_shell_args(launch.program, launch.args),
        cwd,
    }
}

#[cfg(unix)]
fn native_shell_args(program: &str, args: &[String]) -> Vec<String> {
    posix_shell_args(program, args)
}

#[cfg(windows)]
fn native_shell_args(program: &str, args: &[String]) -> Vec<String> {
    powershell_args(program, args)
}

fn wsl_argv(launch: &Launch) -> Argv {
    Argv {
        program: "wsl.exe".into(),
        args: wsl_args(launch),
        // `--cd` alone decides the session's directory, so the Windows side of
        // it can start anywhere real — the distro's filesystem is reached over
        // a share that a process cannot use as its own working directory.
        cwd: home().unwrap_or_else(|| "C:\\".into()),
    }
}

/// `wsl.exe` arguments for a session inside a distro.
fn wsl_args(launch: &Launch) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(distro) = launch.distro.filter(|distro| !distro.is_empty()) {
        args.push("-d".into());
        args.push(distro.to_string());
    }
    args.push("--cd".into());
    args.push(wsl_path(launch.cwd));

    if launch.program.is_empty() {
        // No command leaves the distro's own login shell, interactive.
        return args;
    }
    args.push("--".into());
    if launch.via_shell {
        // `bash` is the one login shell every distro is guaranteed to have.
        args.push("bash".into());
        args.push("-lic".into());
        args.push(format!(
            "exec {}",
            posix_command_line(launch.program, launch.args)
        ));
    } else {
        args.push(launch.program.to_string());
        args.extend(launch.args.iter().cloned());
    }
    args
}

/// Arguments that make a POSIX shell run `program args...` and nothing else.
/// An empty program leaves an interactive login shell.
///
/// `-i` is load-bearing, not decoration. A login shell alone reads `.zprofile`
/// and `.zshenv`, but the `PATH` edits that put `mise`, `nvm` and
/// `~/.local/bin` on it live in `.zshrc`, which only an *interactive* shell
/// sources — so without `-i` a GUI-launched session cannot find the very CLIs
/// this app exists to run. Under a pty the interactive shell prints nothing of
/// its own before the command.
#[cfg_attr(not(unix), allow(dead_code))]
fn posix_shell_args(program: &str, args: &[String]) -> Vec<String> {
    if program.is_empty() {
        return vec!["-l".into()];
    }
    vec![
        "-l".into(),
        "-i".into(),
        "-c".into(),
        format!("exec {}", posix_command_line(program, args)),
    ]
}

/// The same for PowerShell, which is also what resolves the `.cmd` and `.ps1`
/// shims npm-installed CLIs ship as — `CreateProcess` on its own will not.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_args(program: &str, args: &[String]) -> Vec<String> {
    if program.is_empty() {
        return vec!["-NoLogo".into()];
    }
    vec![
        "-NoLogo".into(),
        "-Command".into(),
        format!("& {}", powershell_command_line(program, args)),
    ]
}

fn posix_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

/// PowerShell's single-quoted literal: nothing expands inside it, and an
/// embedded quote is written twice.
fn powershell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "''"))
}

/// `program args...` as one command line, safe to hand to a POSIX shell.
fn posix_command_line(program: &str, args: &[String]) -> String {
    join_quoted(program, args, posix_quote)
}

fn powershell_command_line(program: &str, args: &[String]) -> String {
    join_quoted(program, args, powershell_quote)
}

fn join_quoted(program: &str, args: &[String], quote: fn(&str) -> String) -> String {
    let mut line = quote(program);
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    line
}

/// Which shell's quoting a command line is being written for.
///
/// Named rather than derived from the host so the drop text for every shell is
/// testable from any machine, the way the rest of this module's string
/// building is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Quoting {
    Posix,
    Powershell,
}

/// The text a file drop inserts into a session.
///
/// Every path quoted for the shell that session runs and space-separated, with
/// a trailing space so the next argument can be typed straight after — which
/// is what every terminal has done with a dropped file for thirty years.
///
/// `translate` turns Windows paths into the distro's own, because a `C:\`
/// path pasted into a WSL shell names nothing. It is the same translation
/// `--cd` gets at launch.
pub fn drop_text(paths: &[String], quoting: Quoting, translate: bool) -> String {
    let quote = match quoting {
        Quoting::Posix => posix_quote,
        Quoting::Powershell => powershell_quote,
    };
    let mut line = String::new();
    for path in paths
        .iter()
        .filter(|path| !path.is_empty() && !has_control(path))
    {
        let path = if translate {
            wsl_path(path)
        } else {
            path.to_string()
        };
        line.push_str(&quote(&path));
        line.push(' ');
    }
    line
}

/// Whether a path carries a byte that would be read as a key rather than text.
///
/// Quoting is not enough on its own: the text is delivered through xterm's
/// bracketed paste, which wraps it in `ESC[200~`…`ESC[201~` and does not strip
/// an end marker embedded in the middle. A filename containing that sequence —
/// git stores arbitrary path bytes, and an agent chooses its own filenames —
/// therefore ends paste mode early, and everything after it arrives as
/// keystrokes, with a carriage return to submit them. A path with a control
/// byte in it is never worth typing, so it is dropped rather than repaired.
fn has_control(path: &str) -> bool {
    path.chars().any(|c| c.is_control())
}

/// What to type into a session when files are dropped on it.
#[tauri::command(async)]
pub fn drop_paths(paths: Vec<String>, backend: Backend) -> String {
    // The host decides the quoting; `drop_text` only writes it.
    let quoting = if cfg!(windows) && backend == Backend::Native {
        Quoting::Powershell
    } else {
        Quoting::Posix
    };
    drop_text(&paths, quoting, backend == Backend::Wsl)
}

/// A Windows path as the distro sees it: `C:\code` becomes `/mnt/c/code`, a
/// `\\wsl$\Ubuntu\home\ada` share becomes `/home/ada`, and a path that is
/// already distro-shaped is left alone.
pub fn wsl_path(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    if let Some(inside) = wsl_share_path(&slashed) {
        return inside;
    }
    let mut chars = slashed.chars();
    match (chars.next(), chars.next()) {
        (Some(drive), Some(':')) if drive.is_ascii_alphabetic() => {
            let rest = slashed[2..].trim_start_matches('/');
            let mount = format!("/mnt/{}", drive.to_ascii_lowercase());
            if rest.is_empty() {
                mount
            } else {
                format!("{mount}/{rest}")
            }
        }
        _ => slashed,
    }
}

/// The distro-side path behind a `\\wsl$\<distro>\...` or `\\wsl.localhost\...`
/// share, which is how Windows reaches a distro's own filesystem.
fn wsl_share_path(slashed: &str) -> Option<String> {
    let rest = slashed
        .strip_prefix("//wsl$/")
        .or_else(|| slashed.strip_prefix("//wsl.localhost/"))?;
    let (_distro, path) = rest.split_once('/').unwrap_or((rest, ""));
    Some(format!("/{path}"))
}

/// The user's home directory, whichever variable this host names it in.
pub fn home() -> Option<String> {
    ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|home| !home.is_empty())
}

/// A child process that never flashes a console window of its own. Windows
/// gives a GUI app's children a console unless told otherwise, which would
/// blink a black window on every git poll.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(target_os = "macos")]
const DEFAULT_UNIX_SHELL: &str = "/bin/zsh";
#[cfg(all(unix, not(target_os = "macos")))]
const DEFAULT_UNIX_SHELL: &str = "/bin/bash";

/// The shell a native session runs through.
#[cfg(unix)]
pub fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| DEFAULT_UNIX_SHELL.into())
}

/// PowerShell 7 when the user has it, else the one every Windows ships with.
#[cfg(windows)]
pub fn default_shell() -> String {
    if on_path("pwsh.exe") {
        "pwsh.exe".into()
    } else {
        "powershell.exe".into()
    }
}

#[cfg(windows)]
fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
}

/// Whether [`process_cwd`] can answer at all, which decides whether the status
/// bar follows a `cd` typed in the terminal or stays on the launch directory.
pub const FOLLOWS_CWD: bool = cfg!(unix);

/// Working directory of the process that currently owns the terminal.
///
/// `cd` inside the terminal is invisible to this process — the shell changes
/// its own directory, not ours — so the status bar has to read it back from
/// whichever process holds the far end.
#[cfg(target_os = "macos")]
pub fn process_cwd(pid: i32) -> Option<String> {
    let out = command("/usr/sbin/lsof")
        .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
        .output()
        .ok()?;
    parse_lsof_cwd(&String::from_utf8_lossy(&out.stdout))
}

/// Linux publishes it as a symlink, so no subprocess is needed.
#[cfg(target_os = "linux")]
pub fn process_cwd(pid: i32) -> Option<String> {
    let path = std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?;
    Some(path.to_str()?.to_string()).filter(|path| path.starts_with('/'))
}

/// Windows has no foreground process group and no public route to another
/// process's working directory, so a session's path stays the one it launched
/// in. [`FOLLOWS_CWD`] tells the frontend to say so rather than imply movement.
#[cfg(windows)]
pub fn process_cwd(_pid: i32) -> Option<String> {
    None
}

/// `lsof -F` output is one field per line, tagged by its first character; the
/// `n` field of the `cwd` descriptor holds the path.
#[cfg(target_os = "macos")]
fn parse_lsof_cwd(out: &str) -> Option<String> {
    out.lines()
        .find_map(|line| line.strip_prefix('n'))
        .map(str::to_string)
        .filter(|path| path.starts_with('/'))
}

/// Distros `wsl.exe` can start a session in. Empty off Windows, and empty when
/// WSL is not installed.
#[cfg(windows)]
fn wsl_distros() -> Vec<String> {
    command("wsl.exe")
        .args(["--list", "--quiet"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| parse_wsl_distros(&out.stdout))
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn wsl_distros() -> Vec<String> {
    Vec::new()
}

/// `wsl.exe --list --quiet` writes UTF-16, one distro per line.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_wsl_distros(out: &[u8]) -> Vec<String> {
    decode_windows_text(out)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// UTF-16 little-endian as Windows console tools emit it, falling back to
/// UTF-8 for anything that isn't. A byte-order mark settles it; without one,
/// the NUL sitting between every ASCII character does.
fn decode_windows_text(bytes: &[u8]) -> String {
    let (body, marked) = match bytes.strip_prefix(&[0xff, 0xfe]) {
        Some(body) => (body, true),
        None => (bytes, false),
    };
    let interleaved = body.len() >= 2 && body.chunks(2).take(8).all(|pair| pair.get(1) == Some(&0));
    if !marked && !interleaved {
        return String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string();
    }
    let units = body
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
    char::decode_utf16(units)
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

#[cfg(test)]
#[path = "platform_tests.rs"]
mod tests;
