//! Filesystem and git facts about a tab's working directory, for the status bar.

use std::{collections::HashSet, path::Path};

use crate::platform;

/// Git state of a working directory, or `repo: false` when it isn't one.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo: bool,
    /// Branch name, or a short SHA when the head is detached.
    pub branch: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicted: u32,
}

impl GitStatus {
    fn dirty(&self) -> bool {
        self.staged + self.modified + self.untracked + self.conflicted > 0
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    /// Absolute path, tilde-collapsed for display.
    pub path: String,
    pub label: String,
    pub exists: bool,
    pub git: GitStatus,
    /// True when the directory holds uncommitted work.
    pub dirty: bool,
}

#[tauri::command]
pub async fn workspace_info(cwd: String) -> Workspace {
    let fallback = cwd.clone();
    tauri::async_runtime::spawn_blocking(move || read_workspace(cwd))
        .await
        .unwrap_or_else(|_| read_workspace(fallback))
}

/// Two `git` subprocesses, so it belongs on the blocking pool.
fn read_workspace(cwd: String) -> Workspace {
    let cwd = expand_home(&cwd);
    let path = Path::new(&cwd);
    let git = git_status(path);
    Workspace {
        label: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| cwd.clone()),
        dirty: git.dirty(),
        git,
        exists: path.is_dir(),
        path: collapse_home(&cwd),
    }
}

/// One entry of a directory's git history, as the history panel shows it.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Relative age, e.g. `3 hours ago`.
    pub when: String,
    /// Decorations on this commit: branch names, `tag: v1` stripped to `v1`.
    pub refs: Vec<String>,
    /// Committed locally but not yet on the tracked upstream branch.
    pub unpushed: bool,
}

/// Field separator for the log format; NUL cannot appear in any git field.
const LOG_FORMAT: &str = "--format=%H%x00%h%x00%s%x00%an%x00%ar%x00%D";

#[tauri::command]
pub async fn git_log(cwd: String, limit: u32) -> Vec<Commit> {
    tauri::async_runtime::spawn_blocking(move || read_log(cwd, limit))
        .await
        .unwrap_or_default()
}

fn read_log(cwd: String, limit: u32) -> Vec<Commit> {
    let cwd = expand_home(&cwd);
    let cwd = Path::new(&cwd);
    let Some(out) = git(cwd, &["log", LOG_FORMAT, &format!("--max-count={limit}")]) else {
        return Vec::new();
    };
    parse_log(&out, &unpushed_shas(cwd))
}

/// Shas present locally but not on the upstream branch. Empty when the branch
/// has no upstream, where "unpushed" has no meaning.
fn unpushed_shas(cwd: &Path) -> HashSet<String> {
    git(cwd, &["rev-list", "@{upstream}..HEAD"])
        .into_iter()
        .flat_map(|out| out.lines().map(str::to_string).collect::<Vec<_>>())
        .collect()
}

fn parse_log(out: &str, unpushed: &HashSet<String>) -> Vec<Commit> {
    out.lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let sha = fields.next()?.to_string();
            Some(Commit {
                short: fields.next()?.to_string(),
                subject: fields.next()?.to_string(),
                author: fields.next()?.to_string(),
                when: fields.next()?.to_string(),
                refs: parse_refs(fields.next().unwrap_or_default()),
                unpushed: unpushed.contains(&sha),
                sha,
            })
        })
        .collect()
}

fn parse_refs(decorations: &str) -> Vec<String> {
    decorations
        .split(", ")
        .map(|reference| reference.trim().trim_start_matches("tag: ").to_string())
        .filter(|reference| !reference.is_empty())
        .collect()
}

/// One branch the history panel can switch to.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// What to check out — for a remote-only branch, the local name it creates.
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    /// Relative age of its tip, e.g. `3 hours ago`.
    pub when: String,
    /// Only a remote has it, so checking out starts a local branch from it.
    pub remote: bool,
}

/// NUL separates the fields; no ref name or date can contain one.
const BRANCH_FORMAT: &str =
    "--format=%(HEAD)%00%(refname:short)%00%(committerdate:relative)%00%(upstream:short)";

#[tauri::command]
pub async fn git_branches(cwd: String) -> Vec<Branch> {
    tauri::async_runtime::spawn_blocking(move || read_branches(&cwd))
        .await
        .unwrap_or_default()
}

/// Local branches first, most recently committed to first, then branches only
/// a remote has.
fn read_branches(cwd: &str) -> Vec<Branch> {
    let cwd = expand_home(cwd);
    let path = Path::new(&cwd);
    let sort = "--sort=-committerdate";
    let mut branches =
        parse_branches(git(path, &["for-each-ref", BRANCH_FORMAT, sort, "refs/heads"]).as_deref());
    let local: HashSet<String> = branches.iter().map(|b| b.name.clone()).collect();
    branches.extend(remote_only(
        git(path, &["for-each-ref", BRANCH_FORMAT, sort, "refs/remotes"]).as_deref(),
        &local,
    ));
    branches
}

fn parse_branches(out: Option<&str>) -> Vec<Branch> {
    let Some(out) = out else { return Vec::new() };
    out.lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let head = fields.next()?;
            let name = fields.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            Some(Branch {
                name,
                current: head.trim() == "*",
                when: fields.next().unwrap_or_default().to_string(),
                upstream: fields.next().filter(|u| !u.is_empty()).map(str::to_string),
                remote: false,
            })
        })
        .collect()
}

/// Remote refs with no local branch of the same name, as checkout candidates.
///
/// The remote prefix is dropped because that is the name a checkout creates;
/// `origin/HEAD` is a symbolic ref to another entry, never its own branch.
fn remote_only(out: Option<&str>, local: &HashSet<String>) -> Vec<Branch> {
    let mut seen = HashSet::new();
    parse_branches(out)
        .into_iter()
        .filter_map(|branch| {
            let full = branch.name;
            let name = full.split_once('/').map(|(_, rest)| rest)?.to_string();
            if name == "HEAD" || local.contains(&name) || !seen.insert(name.clone()) {
                return None;
            }
            Some(Branch {
                name,
                current: false,
                upstream: Some(full),
                when: branch.when,
                remote: true,
            })
        })
        .collect()
}

/// Switches the working directory to `branch`, or explains why git refused.
///
/// Uncommitted work that the switch would overwrite is the usual refusal, and
/// git's own message names the files — so it is passed through rather than
/// summarised.
#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || checkout(&cwd, &branch))
        .await
        .unwrap_or_else(|_| Err("checkout did not run".to_string()))
}

fn checkout(cwd: &str, branch: &str) -> Result<(), String> {
    // A leading dash would be read as an option, and `--` cannot precede a
    // branch because git takes what follows it as paths.
    if branch.is_empty() || branch.starts_with('-') {
        return Err(format!("not a branch name: {branch}"));
    }
    let cwd = expand_home(cwd);
    run_git(Path::new(&cwd), &["checkout", branch]).map(|_| ())
}

/// Like `git`, but keeps git's stderr so a failure can be shown to the user.
fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = platform::command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string());
    }
    let error = String::from_utf8_lossy(&out.stderr).trim_end().to_string();
    Err(if error.is_empty() {
        "git refused the checkout".to_string()
    } else {
        error
    })
}

/// Whether a path is a directory, a file, or absent.
///
/// A click on a path in the output has to choose between revealing a folder in
/// the file manager and opening a file in an editor, and only the filesystem
/// knows which it is.
#[tauri::command]
pub async fn path_kind(path: String) -> &'static str {
    tauri::async_runtime::spawn_blocking(move || kind_of(&path))
        .await
        .unwrap_or("missing")
}

fn kind_of(path: &str) -> &'static str {
    // Follows symlinks on purpose: a link to a directory should reveal like one.
    match std::fs::metadata(expand_home(path)) {
        Ok(meta) if meta.is_dir() => "directory",
        Ok(_) => "file",
        Err(_) => "missing",
    }
}

#[tauri::command(async)]
pub fn home_dir() -> String {
    platform::home().unwrap_or_else(|| root().into())
}

/// Where a path falls back to when the user has no readable home.
fn root() -> &'static str {
    if cfg!(windows) {
        "C:\\"
    } else {
        "/"
    }
}

/// `~`-collapsed for display, only at a path boundary — a sibling directory
/// whose name merely starts the same way is left alone.
/// Turns a leading `~` into the home directory, the way a shell would.
///
/// The inverse of [`collapse_home`], and it has to exist: the launcher shows
/// tilde paths, so without this a directory typed as `~/code` would be checked
/// — and created — under a folder literally named `~`.
pub fn expand_home(path: &str) -> String {
    let Some(home) = platform::home() else {
        return path.to_string();
    };
    match path {
        "~" => home,
        // `~name` is another user's home, which this does not resolve; only a
        // separator marks the end of the current user's `~`.
        _ if path.starts_with("~/") || path.starts_with("~\\") => {
            format!("{home}{}", &path[1..])
        }
        _ => path.to_string(),
    }
}

/// Creates `path` and every missing parent, and reports the absolute path made.
///
/// Offered when the launcher finds a directory that is not there yet, so a new
/// project can be started without leaving the app for a shell.
#[tauri::command]
pub async fn create_directory(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || make_directory(path))
        .await
        .map_err(|error| error.to_string())?
}

fn make_directory(path: String) -> Result<String, String> {
    let expanded = expand_home(path.trim());
    if expanded.is_empty() {
        return Err("no directory given".into());
    }

    let target = Path::new(&expanded);
    if target.is_dir() {
        // Already there — the same outcome the caller asked for.
        return Ok(expanded);
    }
    if target.exists() {
        return Err(format!(
            "{} exists and is not a directory",
            collapse_home(&expanded)
        ));
    }

    std::fs::create_dir_all(target)
        .map_err(|error| format!("could not create {}: {error}", collapse_home(&expanded)))?;
    Ok(expanded)
}

pub fn collapse_home(path: &str) -> String {
    let Some(home) = platform::home().filter(|home| !home.is_empty()) else {
        return path.to_string();
    };
    match path.strip_prefix(&home) {
        Some("") => "~".into(),
        Some(rest) if starts_at_boundary(rest) => format!("~{rest}"),
        _ => path.to_string(),
    }
}

/// Both separators count: a Windows path can arrive in either form.
fn starts_at_boundary(rest: &str) -> bool {
    rest.starts_with('/') || rest.starts_with('\\')
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = platform::command("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Reads branch, upstream divergence and worktree counts from one
/// `git status --porcelain=v2` call.
fn git_status(cwd: &Path) -> GitStatus {
    let Some(out) = git(
        cwd,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ],
    ) else {
        return GitStatus::default();
    };

    let mut status = GitStatus {
        repo: true,
        ..Default::default()
    };
    for line in out.lines() {
        match line.split_once(' ') {
            Some(("#", header)) => read_branch_header(&mut status, header),
            _ => count_entry(&mut status, line),
        }
    }
    if status.branch.is_empty() {
        status.branch = "(empty)".into();
    }
    status
}

fn read_branch_header(status: &mut GitStatus, header: &str) {
    let mut fields = header.split_whitespace();
    match (fields.next(), fields.next()) {
        (Some("branch.oid"), Some(oid)) if status.branch.is_empty() => {
            status.branch = oid.chars().take(7).collect();
        }
        (Some("branch.head"), Some("(detached)")) => status.detached = true,
        (Some("branch.head"), Some(head)) => {
            status.detached = false;
            status.branch = head.to_string();
        }
        (Some("branch.upstream"), Some(upstream)) => status.upstream = Some(upstream.to_string()),
        (Some("branch.ab"), Some(ahead)) => {
            status.ahead = parse_count(ahead);
            status.behind = fields.next().map(parse_count).unwrap_or(0);
        }
        _ => {}
    }
}

/// `branch.ab` counts arrive signed, as `+2 -1`.
fn parse_count(field: &str) -> u32 {
    field.trim_start_matches(['+', '-']).parse().unwrap_or(0)
}

/// Porcelain v2 entries: `1`/`2` carry an XY status pair, `?` is untracked,
/// `u` is an unresolved merge.
fn count_entry(status: &mut GitStatus, line: &str) {
    let mut fields = line.split_whitespace();
    match fields.next() {
        Some("?") => status.untracked += 1,
        Some("u") => status.conflicted += 1,
        Some("1" | "2") => {
            let mut xy = fields.next().unwrap_or("..").chars();
            if xy.next().is_some_and(|c| c != '.') {
                status.staged += 1;
            }
            if xy.next().is_some_and(|c| c != '.') {
                status.modified += 1;
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
