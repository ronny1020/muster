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
    /// Whether the upstream is the remote's branch of the same name.
    #[serde(skip)]
    pub tracks_own_name: bool,
    /// Whether the drawer's Push sends this branch under its own name for the
    /// first time — see [`read_push_state`]. The label reads Publish then, and
    /// `sync::push_target` acts on this same field.
    pub publishes: bool,
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
    /// Exists and cannot be read. Always `false` unless the caller asked to
    /// probe — see `workspace_info`.
    pub denied: bool,
    pub git: GitStatus,
    /// True when the directory holds uncommitted work.
    pub dirty: bool,
}

/// Facts about a directory, and — only when asked — whether it can be read.
///
/// `probe` defaults to **off**, and that default is the whole point. Answering
/// it costs a `read_dir`, which is enumeration rather than a stat, and on
/// macOS enumeration is what raises the TCC prompt. The only caller that needs
/// the answer is the launcher, on a click; the status footer polls this same
/// command on a timer, in every mounted pane, against the directory the
/// *agent* has since `cd`-ed into. Probing there would put a permission
/// dialog on screen at a moment the user did nothing to cause — and a "Don't
/// Allow" is remembered, which is the unrecoverable state `blocked.ts` exists
/// to explain. Same reasoning, and the same shape, as `git_changes(counts)`.
#[tauri::command]
pub async fn workspace_info(cwd: String, probe: Option<bool>) -> Workspace {
    let probe = probe.unwrap_or(false);
    let fallback = cwd.clone();
    tauri::async_runtime::spawn_blocking(move || read_workspace(cwd, probe))
        .await
        .unwrap_or_else(|_| read_workspace(fallback, probe))
}

/// Two `git` subprocesses, so it belongs on the blocking pool.
fn read_workspace(cwd: String, probe: bool) -> Workspace {
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
        denied: probe && is_unreadable(path),
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

/// Shas present locally but not where a push goes — the push target when that
/// differs from the upstream, as the `↑` count is measured. Empty when the
/// branch has no upstream, where "unpushed" has no meaning.
fn unpushed_shas(cwd: &Path) -> HashSet<String> {
    let base = push_base(cwd, &git_status(cwd)).unwrap_or_else(|| "@{upstream}".to_string());
    git(cwd, &["rev-list", &format!("{base}..HEAD")])
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
/// summarised. It runs under `op` like the drawers' other writes, so the same
/// Cancel reaches a post-checkout hook or an LFS download that stalls.
#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String, op: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || checkout(&cwd, &branch, &op))
        .await
        .unwrap_or_else(|_| Err("checkout did not run".to_string()))
}

fn checkout(cwd: &str, branch: &str, op: &str) -> Result<(), String> {
    // A leading dash would be read as an option, and `--` cannot precede a
    // branch because git takes what follows it as paths.
    if branch.is_empty() || branch.starts_with('-') {
        return Err(format!("not a branch name: {branch}"));
    }
    let cwd = expand_home(cwd);
    // `switch`, never `checkout`: given a name that is no longer a branch —
    // one an agent deleted after the list was read — `checkout` takes it for
    // a path and restores that directory from the index, discarding unstaged
    // work in it without a word. `switch` only ever switches, and still starts
    // a local branch from a remote-only one.
    crate::sync::run_git_as(Path::new(&cwd), &["switch", branch], op).map(|_| ())
}

/// Variables that tell git which repository to act on, overriding `-C`.
///
/// Git exports `GIT_INDEX_FILE` to its hooks, and this repository's
/// pre-commit hook runs the Rust tests — so a test's `git add --all` in a
/// scratch repository would write the scratch tree over the commit being made.
/// A Muster started from a hook or a shell that exported `GIT_DIR` would point
/// every tab's git at one repository the same way.
const REPOSITORY_OVERRIDES: [&str; 5] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
];

/// `git -C <cwd>`, answering about `cwd` and nothing an environment names.
pub(crate) fn git_in(cwd: &Path) -> std::process::Command {
    let mut command = platform::command("git");
    without_repository_overrides(&mut command)
        .arg("-C")
        .arg(cwd);
    command
}

/// Removes [`REPOSITORY_OVERRIDES`] from a git child's environment, and from
/// the login-`PATH` probe's, whose prompt runs git. PTY sessions are not
/// covered: a shell started there keeps whatever the app inherited.
pub(crate) fn without_repository_overrides(
    command: &mut std::process::Command,
) -> &mut std::process::Command {
    for name in REPOSITORY_OVERRIDES {
        command.env_remove(name);
    }
    command
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

/// Whether a directory exists but this app is not allowed to read it.
///
/// Worth telling apart from "missing", because the two need opposite things
/// from the user and the wrong one is actively misleading: the launcher offers
/// to *create* a missing directory, and offering that for a directory already
/// there — full of their work — reads as the app having lost it.
///
/// `read_dir` rather than `metadata`, and asked of every directory rather than
/// only of one that failed `is_dir`: `metadata` merely stats, which needs
/// nothing but search permission on the parent, so an unreadable directory
/// still answers `is_dir() == true` and only enumeration is refused. Gating
/// this on `!is_dir()` skips exactly the case it exists for. Enumerating is
/// also what a shell, `git` and an agent each do in a working directory, and
/// on macOS it is what the permission covers.
pub fn is_unreadable(path: &Path) -> bool {
    match std::fs::read_dir(path) {
        Ok(_) => false,
        Err(error) => is_denied(&error),
    }
}

fn is_denied(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::PermissionDenied)
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

/// `git` output with trailing whitespace trimmed, or `None` when it failed —
/// the caller wanted a fact, not a message. [`crate::sync::run_git_as`] is the one that keeps
/// stderr, and [`git_verbatim`] the one that keeps whitespace.
pub(crate) fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    git_verbatim(cwd, args).map(|out| out.trim_end().to_string())
}

/// `git` output exactly as git wrote it.
///
/// A unified diff needs this: its blank context line is a single space, so
/// trimming the end of a patch deletes the diff's last rows whenever the file
/// ends in blank lines — and those rows are precisely what a reviewer checks
/// when an agent may have eaten a trailing newline.
pub(crate) fn git_verbatim(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = git_in(cwd).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Reads branch, upstream divergence and worktree counts from one
/// `git status --porcelain=v2` call.
pub(crate) fn git_status(cwd: &Path) -> GitStatus {
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
    status.tracks_own_name = tracks_own_name(&status);
    read_push_state(cwd, &mut status);
    status
}

/// Fills in what a push of the current branch would do: whether it publishes,
/// and how many commits it has to send.
///
/// A branch publishes when it has no upstream, or tracks a branch of another
/// name — which is what `git checkout -b fix origin/main` leaves, and pushing
/// that anywhere but under its own name would land the work on `main` — unless
/// pushes go to another remote and have landed there before, which is a fork
/// workflow's ordinary push.
fn read_push_state(cwd: &Path, status: &mut GitStatus) {
    let base = push_base(cwd, status);
    if let Some(ahead) = base.as_deref().and_then(|base| ahead_of(cwd, base)) {
        status.ahead = ahead;
    }
    status.publishes = !status.detached && !status.tracks_own_name && base.is_none();
}

/// Commits on `HEAD` that `base` does not have.
fn ahead_of(cwd: &Path, base: &str) -> Option<u32> {
    git(cwd, &["rev-list", "--count", &format!("{base}..HEAD")])?
        .parse()
        .ok()
}

/// The ref a push of the current branch last landed on, when pushes go
/// somewhere other than the upstream's remote and have landed there before.
///
/// `branch.ab` counts against the upstream, but the drawer's Push sends to
/// [`push_remote`] — and in a fork workflow (`pushRemote` or
/// `remote.pushDefault` set) those differ, and counted against the upstream
/// the number would not fall after a push, reading as one that had not
/// landed. `ahead` means "to push"
/// wherever it is shown, so it is counted from here when this answers. Git's
/// own `@{push}` would answer this, but under the default `push.default=simple`
/// it refuses a triangular setup outright.
fn push_base(cwd: &Path, status: &GitStatus) -> Option<String> {
    let tracked = tracked_remote(status)?;
    let target = push_remote(cwd, &status.branch);
    if target == tracked {
        return None;
    }
    let pushed = format!("refs/remotes/{target}/{}", status.branch);
    git(cwd, &["rev-parse", "--verify", "--quiet", &pushed])?;
    Some(pushed)
}

/// Where a push of `branch` goes: its `pushRemote`, then `remote.pushDefault`,
/// then the remote it tracks, then the repository's only remote, then
/// `origin` — the order `git push` itself uses, with the only remote added so
/// a repository whose remote is not called `origin` still publishes.
///
/// The first two are what a fork workflow sets — track the canonical
/// repository, push to your own — so ignoring them would publish an agent's
/// branch to the repository everyone shares. One `git config` call rather than
/// one per key, because the status poll asks this in every pane.
pub(crate) fn push_remote(cwd: &Path, branch: &str) -> String {
    let branch_key = format!("branch.{}", regex_escape(branch));
    let pattern = format!("^({branch_key}\\.(pushremote|remote)|remote\\.pushdefault)$");
    let config = git(cwd, &["config", "--get-regexp", &pattern]).unwrap_or_default();
    // `--get-regexp` lowercases a key's section and name but keeps its
    // subsection — the branch — as written. It prints system, then global,
    // then local, and for a key set twice the last one is the one git uses.
    let value = |key: &str| {
        config.lines().rev().find_map(|line| {
            let (name, value) = line.split_once(' ')?;
            (name == key).then(|| value.to_string())
        })
    };
    value(&format!("branch.{branch}.pushremote"))
        .or_else(|| value("remote.pushdefault"))
        // `.` is the repository itself, which has nowhere to publish to.
        .or_else(|| value(&format!("branch.{branch}.remote")).filter(|remote| remote != "."))
        .or_else(|| sole_remote(cwd))
        .unwrap_or_else(|| "origin".to_string())
}

/// The repository's one remote, whatever it is called, or `None` when there
/// are several.
fn sole_remote(cwd: &Path) -> Option<String> {
    let remotes = git(cwd, &["remote"])?;
    let mut names = remotes.lines();
    let only = names.next()?.to_string();
    names.next().is_none().then_some(only)
}

/// `text` with every extended-regex metacharacter escaped, for a branch name
/// inside a `--get-regexp` pattern.
fn regex_escape(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            let special = "\\^$.|?*+()[]{}".contains(c);
            special.then_some('\\').into_iter().chain([c])
        })
        .collect()
}

/// The remote the upstream is on: `origin/<name>` names it first.
pub(crate) fn tracked_remote(status: &GitStatus) -> Option<&str> {
    Some(status.upstream.as_deref()?.split_once('/')?.0)
}

/// `origin/<name>` names the remote first; a remote whose own name holds a
/// slash reads as tracking another name, and is published rather than pushed.
fn tracks_own_name(status: &GitStatus) -> bool {
    !status.detached
        && status
            .upstream
            .as_deref()
            .and_then(|upstream| upstream.split_once('/'))
            .is_some_and(|(_, branch)| branch == status.branch)
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
