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
mod tests {
    use super::*;

    /// A porcelain v2 dump as `git status` emits it, header lines first.
    const STATUS: &str = "\
# branch.oid 8c9d0e1f2a3b4c5d6e7f
# branch.head feature/tabs
# branch.upstream origin/feature/tabs
# branch.ab +2 -3
1 M. N... 100644 100644 100644 aaa bbb src/staged.rs
1 .M N... 100644 100644 100644 aaa bbb src/modified.rs
1 MM N... 100644 100644 100644 aaa bbb src/both.rs
2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\told.rs
? untracked.rs
? also-untracked.rs
u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.rs";

    fn parse(dump: &str) -> GitStatus {
        let mut status = GitStatus {
            repo: true,
            ..Default::default()
        };
        for line in dump.lines() {
            match line.split_once(' ') {
                Some(("#", header)) => read_branch_header(&mut status, header),
                _ => count_entry(&mut status, line),
            }
        }
        status
    }

    #[test]
    fn reads_branch_and_divergence() {
        let status = parse(STATUS);
        assert_eq!(status.branch, "feature/tabs");
        assert!(!status.detached);
        assert_eq!(status.upstream.as_deref(), Some("origin/feature/tabs"));
        assert_eq!((status.ahead, status.behind), (2, 3));
    }

    #[test]
    fn counts_each_change_once_per_side() {
        let status = parse(STATUS);
        // Staged: M., MM, R.  Modified: .M, MM.
        assert_eq!(status.staged, 3);
        assert_eq!(status.modified, 2);
        assert_eq!(status.untracked, 2);
        assert_eq!(status.conflicted, 1);
        assert!(status.dirty());
    }

    #[test]
    fn a_detached_head_falls_back_to_the_short_oid() {
        let status = parse("# branch.oid 8c9d0e1f2a3b4c5d6e7f\n# branch.head (detached)");
        assert!(status.detached);
        assert_eq!(status.branch, "8c9d0e1");
    }

    #[test]
    fn a_clean_tree_is_not_dirty() {
        let status = parse("# branch.oid abc123\n# branch.head main");
        assert!(!status.dirty());
        assert_eq!(status.staged + status.modified + status.untracked, 0);
    }

    #[test]
    fn a_branch_with_no_upstream_has_no_divergence() {
        let status = parse("# branch.head main\n# branch.upstream\n? new.rs");
        assert_eq!(status.upstream, None);
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn a_non_repo_reports_no_git_state() {
        let status = git_status(&std::env::temp_dir());
        assert!(!status.repo);
    }

    #[test]
    fn workspace_labels_a_directory_by_its_basename() {
        let workspace = read_workspace(env!("CARGO_MANIFEST_DIR").into());
        assert_eq!(workspace.label, "src-tauri");
        assert!(workspace.exists);
    }

    #[test]
    fn a_missing_directory_is_reported_rather_than_erroring() {
        let workspace = read_workspace("/definitely/not/here".into());
        assert!(!workspace.exists);
        assert!(!workspace.git.repo);
    }

    #[test]
    fn expands_a_leading_tilde_only_at_a_path_boundary() {
        let home = platform::home().unwrap();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/code"), format!("{home}/code"));
        // `~ada` is another user's home, which this deliberately leaves alone.
        assert_eq!(expand_home("~ada/code"), "~ada/code");
        assert_eq!(expand_home("/tmp/x"), "/tmp/x");
        assert_eq!(expand_home("relative/x"), "relative/x");
        assert_eq!(expand_home(""), "");
    }

    #[test]
    fn expanding_and_collapsing_home_are_inverses() {
        let home = platform::home().unwrap();
        assert_eq!(collapse_home(&expand_home("~/code")), "~/code");
        assert_eq!(
            expand_home(&collapse_home(&format!("{home}/code"))),
            format!("{home}/code")
        );
    }

    #[test]
    fn creates_a_directory_and_every_missing_parent() {
        let root = std::env::temp_dir().join(format!("muster-mkdir-{}", std::process::id()));
        let nested = root.join("a/b/c");
        let made = make_directory(nested.to_string_lossy().into()).expect("create");

        assert!(Path::new(&made).is_dir());
        assert_eq!(made, nested.to_string_lossy());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn creating_a_directory_that_already_exists_succeeds() {
        // The caller asked for the directory to be there; it is.
        let existing = env!("CARGO_MANIFEST_DIR");
        assert_eq!(make_directory(existing.into()).unwrap(), existing);
    }

    #[test]
    fn refuses_when_a_file_is_already_in_the_way() {
        let file = std::env::temp_dir().join(format!("muster-mkdir-file-{}", std::process::id()));
        std::fs::write(&file, b"x").expect("write");
        let error = make_directory(file.to_string_lossy().into()).unwrap_err();
        let _ = std::fs::remove_file(&file);
        assert!(error.contains("not a directory"), "{error}");
    }

    #[test]
    fn refuses_an_empty_directory_name() {
        assert!(make_directory("".into()).is_err());
        assert!(make_directory("   ".into()).is_err());
    }

    #[test]
    fn a_directory_typed_with_a_tilde_is_created_under_home_not_under_a_folder_named_tilde() {
        let home = platform::home().unwrap();
        let name = format!("muster-tilde-{}", std::process::id());
        let made = make_directory(format!("~/{name}")).expect("create");

        assert_eq!(made, format!("{home}/{name}"));
        assert!(
            !Path::new("~").exists(),
            "a literal ~ directory must never be made"
        );
        let _ = std::fs::remove_dir(&made);
    }

    #[test]
    fn home_is_collapsed_to_a_tilde_only_at_a_path_boundary() {
        let home = platform::home().unwrap();
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(collapse_home(&home), "~");
        assert_eq!(
            collapse_home(&format!("{home}{sep}code")),
            format!("~{sep}code")
        );
        // A sibling directory that merely starts with the same characters.
        assert_eq!(
            collapse_home(&format!("{home}x{sep}code")),
            format!("{home}x{sep}code")
        );
        assert_eq!(collapse_home("/opt/tools"), "/opt/tools");
    }

    #[test]
    fn a_windows_home_collapses_on_either_separator() {
        // `collapse_home` sees whatever the picker handed back, and Windows
        // paths arrive in both forms.
        assert!(starts_at_boundary(r"\Users"));
        assert!(starts_at_boundary("/Users"));
        assert!(!starts_at_boundary("x/Users"));
    }

    /// One `git log` line per commit, NUL-separated fields.
    fn log_line(sha: &str, short: &str, subject: &str, refs: &str) -> String {
        format!("{sha}\0{short}\0{subject}\0Ada Lovelace\03 hours ago\0{refs}")
    }

    #[test]
    fn parses_a_commit_with_no_decorations() {
        let out = log_line("abc123def", "abc123d", "Add the tab strip", "");
        let commits = parse_log(&out, &HashSet::new());
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].short, "abc123d");
        assert_eq!(commits[0].subject, "Add the tab strip");
        assert_eq!(commits[0].author, "Ada Lovelace");
        assert_eq!(commits[0].when, "3 hours ago");
        assert!(commits[0].refs.is_empty());
        assert!(!commits[0].unpushed);
    }

    #[test]
    fn splits_decorations_and_unwraps_tags() {
        let out = log_line(
            "abc",
            "abc",
            "Ship it",
            "HEAD -> main, origin/main, tag: v1.2.0",
        );
        let commits = parse_log(&out, &HashSet::new());
        assert_eq!(commits[0].refs, ["HEAD -> main", "origin/main", "v1.2.0"]);
    }

    #[test]
    fn flags_only_the_commits_missing_from_upstream() {
        let out = [
            log_line("local2", "local2", "Second local", ""),
            log_line("local1", "local1", "First local", ""),
            log_line("pushed", "pushed", "Already on origin", "origin/main"),
        ]
        .join("\n");
        let unpushed = HashSet::from(["local1".to_string(), "local2".to_string()]);
        let flags: Vec<bool> = parse_log(&out, &unpushed)
            .iter()
            .map(|c| c.unpushed)
            .collect();
        assert_eq!(flags, [true, true, false]);
    }

    #[test]
    fn a_subject_containing_separators_survives() {
        let out = log_line("abc", "abc", "Fix a, b and c: really", "");
        assert_eq!(
            parse_log(&out, &HashSet::new())[0].subject,
            "Fix a, b and c: really"
        );
    }

    #[test]
    fn keeps_every_commit_in_log_order() {
        let out = (0..5)
            .map(|n| {
                log_line(
                    &format!("sha{n}"),
                    &format!("sha{n}"),
                    &format!("Commit {n}"),
                    "",
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let commits = parse_log(&out, &HashSet::new());
        assert_eq!(commits.len(), 5);
        assert_eq!(commits[0].subject, "Commit 0");
        assert_eq!(commits[4].subject, "Commit 4");
    }

    #[test]
    fn a_truncated_record_is_skipped_rather_than_panicking() {
        let out = format!("only-a-sha\n{}", log_line("abc", "abc", "Good one", ""));
        let commits = parse_log(&out, &HashSet::new());
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "Good one");
    }

    #[test]
    fn a_non_repo_has_no_history() {
        assert!(read_log(std::env::temp_dir().to_string_lossy().into_owned(), 20).is_empty());
    }

    #[test]
    fn this_repo_reports_its_own_history() {
        let commits = read_log(env!("CARGO_MANIFEST_DIR").into(), 5);
        // Only meaningful once this working copy has a commit.
        if !commits.is_empty() {
            assert!(!commits[0].short.is_empty());
            assert!(!commits[0].when.is_empty());
        }
    }
}
