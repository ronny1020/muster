//! Reading what changed in a working tree, and the files themselves, for the
//! review panel.
//!
//! Read-only on purpose: nothing here stages, discards or writes. An agent is
//! the thing editing the tree, and the panel is how the user reads what it
//! did — so the only verbs are "what changed", "show me that diff", "show me
//! that file", and the same questions asked of a commit in the history.

use std::{
    collections::HashSet,
    io::Write,
    path::{Component, Path},
    process::Stdio,
};

use crate::{
    workspace::{
        commit_from_fields, expand_home, git, git_in, git_verbatim, unpushed_shas, Commit,
        LOG_FORMAT,
    },
    worktree,
};

/// One file the review panel lists.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Repo-relative, in git's own forward-slash form on every host.
    pub path: String,
    pub status: &'static str,
    /// Where a rename came from; `None` for every other status.
    pub old_path: Option<String>,
    pub insertions: u32,
    pub deletions: u32,
    pub binary: bool,
    /// False when the file was listed but never read for its line count, which
    /// is not the same as counting zero — the list says so rather than
    /// showing a number it did not take.
    ///
    /// It governs its neighbours: when it is false, `insertions`, `deletions`
    /// and `binary` were never determined either. They read 0, 0 and false
    /// because nothing looked, and `binary` has no flag of its own — so check
    /// this one before trusting it.
    pub counted: bool,
}

/// The changed-file set of one working tree.
#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub repo: bool,
    /// Absolute repository root. Every `path` here is relative to it — not to
    /// the session's directory — so a click on a path needs it to match.
    pub root: String,
    /// What makes two working trees the same repository.
    ///
    /// A linked worktree has its own root and its own index, so `root` cannot
    /// answer "are these two tabs editing one project" — which is precisely
    /// the arrangement parallel agents are run in. `--git-common-dir` resolves
    /// every worktree of a repo to the one directory they share.
    pub common_dir: String,
    /// What the diff is against: a branch name, or empty for uncommitted work.
    pub base: String,
    /// Set when a base branch was asked for and git could not resolve it.
    pub error: Option<String>,
    pub files: Vec<ChangedFile>,
}

/// A unified diff of one file, as the diff view renders it.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// `git diff` output, or a synthesised all-added patch for a new file.
    pub patch: String,
    pub truncated: bool,
}

/// A file read for the preview pane.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub text: String,
    /// Size on disk, which `text` may be a prefix of.
    pub bytes: u64,
    pub truncated: bool,
}

/// One entry of a directory, for the file tree.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Absolute, so a click needs nothing else to open it.
    pub path: String,
    pub directory: bool,
    pub bytes: u64,
    pub symlink: bool,
    /// Matched by a `.gitignore`. Shown, but dimmed: a build output is part of
    /// the directory you are looking at, and not part of the work.
    pub ignored: bool,
}

/// Ceiling on anything crossing the IPC bridge as one string. Both a diff and
/// a file preview are read into memory whole and then rendered by a syntax
/// highlighter, so this is a real limit rather than a formality.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// A directory with more entries than this is a build output, not a project
/// tree, and drawing all of it helps nobody.
const MAX_ENTRIES: usize = 4096;

/// How many new files get their lines counted.
///
/// Counting means reading the file, and this runs whenever the tree moves. A
/// repository with an un-ignored `dist/` in it — the state right after an agent
/// runs a build — otherwise turns every read into thousands of them.
const MAX_COUNTED: usize = 512;

/// Git's hash of the empty tree, which is what a repository with no commits
/// has to be diffed against — `HEAD` does not resolve there.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// `counts` reads each new file to count the lines it would add. A caller that
/// only wants to know *which* files differ passes `false` and touches nothing:
/// the reads are what raise a filesystem permission prompt, and asking for one
/// because a path was clicked in the terminal is asking too early.
#[tauri::command]
pub async fn git_changes(cwd: String, base: Option<String>, counts: Option<bool>) -> Changes {
    let counts = counts.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || read_changes(&cwd, base.as_deref(), counts))
        .await
        .unwrap_or_default()
}

fn read_changes(cwd: &str, base: Option<&str>, counts: bool) -> Changes {
    let Some(layout) = worktree::layout(Path::new(&expand_home(cwd))) else {
        return Changes::default();
    };
    let root = layout.root.as_path();

    let mut changes = Changes {
        repo: true,
        root: root.to_string_lossy().into_owned(),
        common_dir: layout.common.to_string_lossy().into_owned(),
        base: base.unwrap_or_default().to_string(),
        ..Default::default()
    };
    let Some(rev) = resolve_base(root, base) else {
        changes.error = Some(format!("no such branch: {}", base.unwrap_or_default()));
        return changes;
    };

    changes.files = tracked_changes(root, &[&rev]);
    // A path can reach both passes — `git rm --cached x` leaves `x` deleted
    // against HEAD and untracked in the worktree — and two rows for one file
    // is two rows with the same key, both highlighting when either is picked.
    let tracked: HashSet<String> = changes.files.iter().map(|f| f.path.clone()).collect();
    changes.files.extend(
        untracked_changes(&layout, counts)
            .into_iter()
            .filter(|file| !tracked.contains(&file.path)),
    );
    changes
}

/// The repository a directory is in, as [`worktree::Layout::root`], or `None`
/// when it is not in one.
///
/// Resolved for the reason [`worktree::resolved`] gives. Two tabs on one tree
/// reached by two spellings would otherwise compare unequal and warn about
/// every file they share, which is the always-on warning the collision
/// detector exists to avoid.
///
/// Every git call here runs from the top level rather than the session's own
/// directory, and that is load-bearing: run from a subdirectory, `git diff`
/// reports paths relative to the root but `ls-files` reports them relative to
/// the cwd *and* only lists what is below it, so a session in `src/` would
/// list half the changes and mismatch the other half against the panel's
/// paths. One directory for all of them is what keeps every path in this
/// module root-relative.
fn repo_root(cwd: &str) -> Option<String> {
    worktree::layout(Path::new(cwd)).map(|layout| layout.root.to_string_lossy().into_owned())
}

/// What to diff against: the point the branches diverged for a base branch,
/// so the base's own later commits never read as the user's work; `HEAD` for
/// uncommitted changes, either way including everything in the working tree.
fn resolve_base(root: &Path, base: Option<&str>) -> Option<String> {
    let Some(name) = base.map(str::trim).filter(|name| !name.is_empty()) else {
        return Some(head_or_empty_tree(root));
    };
    // A leading dash would be read as an option.
    if name.starts_with('-') {
        return None;
    }
    git(root, &["merge-base", "HEAD", name]).filter(|sha| !sha.is_empty())
}

/// What a commit changed: the commit against its first parent, or against the
/// empty tree when it is the first. A merge reads as what it brought into the
/// branch it was made on, which is what the history drawer lists it under.
///
/// `None` unless `sha` is a hex object id that names a commit — it reaches git
/// as an argument, and a leading dash or a revision expression would be read
/// as something else.
fn commit_range(root: &Path, sha: &str) -> Option<[String; 2]> {
    let id = (7..=64).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit());
    if !id {
        return None;
    }
    let commit = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{sha}^{{commit}}"),
        ],
    )
    .filter(|sha| !sha.is_empty())?;
    let parent = git(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("{commit}^1")],
    )
    .filter(|sha| !sha.is_empty())
    .unwrap_or_else(|| EMPTY_TREE.to_string());
    Some([parent, commit])
}

/// The files one commit changed, for the history drawer. `base` carries the
/// commit's full sha.
#[tauri::command]
pub async fn git_commit_files(cwd: String, sha: String) -> Result<Changes, String> {
    tauri::async_runtime::spawn_blocking(move || read_commit_files(&cwd, &sha))
        .await
        .map_err(|error| error.to_string())?
}

fn read_commit_files(cwd: &str, sha: &str) -> Result<Changes, String> {
    let layout = worktree::layout(Path::new(&expand_home(cwd)))
        .ok_or_else(|| "not a git repository".to_string())?;
    let root = layout.root.as_path();
    let [parent, commit] =
        commit_range(root, sha).ok_or_else(|| format!("no such commit: {sha}"))?;
    Ok(Changes {
        repo: true,
        common_dir: layout.common.to_string_lossy().into_owned(),
        files: tracked_changes(root, &[&parent, &commit]),
        base: commit,
        root: root.to_string_lossy().into_owned(),
        error: None,
    })
}

fn head_or_empty_tree(root: &Path) -> String {
    git(root, &["rev-parse", "--verify", "HEAD"])
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| EMPTY_TREE.to_string())
}

/// Files git already knows about, with their line counts: one revision against
/// the working tree, or two against each other.
///
/// Two calls because no single `git diff` reports both the status letter and
/// the line counts, and the status is what tells a deletion from an edit.
fn tracked_changes(root: &Path, revs: &[&str]) -> Vec<ChangedFile> {
    // `--no-relative` because `diff.relative` is a config a user can set, and
    // it would make every path here relative to the cwd instead of the root.
    let args = [&["diff", "-z", "--no-relative", "-M"][..], revs].concat();
    let statuses = git(root, &[&args[..], &["--name-status"]].concat()).unwrap_or_default();
    let counts = git(root, &[&args[..], &["--numstat"]].concat()).unwrap_or_default();
    merge_records(parse_name_status(&statuses), &parse_numstat(&counts))
}

/// A `--name-status -z` record: the letter, the path, and a rename's source.
#[derive(Debug, PartialEq)]
struct StatusRecord {
    letter: char,
    path: String,
    old_path: Option<String>,
}

/// A `--numstat -z` record. Counts are `None` for a binary file, which git
/// writes as `-`.
#[derive(Debug, PartialEq)]
struct CountRecord {
    path: String,
    insertions: Option<u32>,
    deletions: Option<u32>,
}

/// `-z` output is NUL-separated, and a rename spends two fields on its paths:
/// `R100\0old\0new\0`. Splitting on NUL and consuming fields in order is what
/// keeps the two shapes apart.
fn parse_name_status(out: &str) -> Vec<StatusRecord> {
    let mut fields = out.split('\0').filter(|field| !field.is_empty());
    let mut records = Vec::new();
    while let Some(letter) = fields.next() {
        let Some(letter) = letter.chars().next() else {
            continue;
        };
        let Some(first) = fields.next() else { break };
        // `R` and `C` carry a similarity score and two paths; nothing else does.
        let renamed = matches!(letter, 'R' | 'C');
        let old_path = renamed.then(|| first.to_string());
        let path = if renamed {
            match fields.next() {
                Some(path) => path.to_string(),
                None => break,
            }
        } else {
            first.to_string()
        };
        records.push(StatusRecord {
            letter,
            path,
            old_path,
        });
    }
    records
}

/// `ins\tdel\tpath\0`, except for a rename, which writes `ins\tdel\t\0old\0new\0`.
fn parse_numstat(out: &str) -> Vec<CountRecord> {
    let mut fields = out.split('\0').filter(|field| !field.is_empty());
    let mut records = Vec::new();
    while let Some(head) = fields.next() {
        let mut columns = head.splitn(3, '\t');
        let insertions = columns.next().map(parse_count);
        let deletions = columns.next().map(parse_count);
        let inline = columns.next().unwrap_or_default();
        // An empty third column means the paths are the next two fields; the
        // second of them is the name the diff is filed under.
        let path = if inline.is_empty() {
            match (fields.next(), fields.next()) {
                (Some(_old), Some(new)) => new.to_string(),
                _ => break,
            }
        } else {
            inline.to_string()
        };
        records.push(CountRecord {
            path,
            insertions: insertions.flatten(),
            deletions: deletions.flatten(),
        });
    }
    records
}

/// `None` for git's `-`, which marks a binary file rather than zero lines.
fn parse_count(field: &str) -> Option<u32> {
    field.trim().parse().ok()
}

fn merge_records(statuses: Vec<StatusRecord>, counts: &[CountRecord]) -> Vec<ChangedFile> {
    statuses
        .into_iter()
        .map(|record| {
            let count = counts.iter().find(|entry| entry.path == record.path);
            ChangedFile {
                status: status_name(record.letter),
                insertions: count.and_then(|c| c.insertions).unwrap_or(0),
                deletions: count.and_then(|c| c.deletions).unwrap_or(0),
                // Only git can say a tracked file is binary, and it says so by
                // writing `-` where the counts go.
                binary: count.is_some_and(|c| c.insertions.is_none()),
                path: record.path,
                old_path: record.old_path,
                counted: true,
            }
        })
        .collect()
}

fn status_name(letter: char) -> &'static str {
    match letter {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "conflicted",
        'T' => "typechange",
        _ => "modified",
    }
}

/// Files git has never seen, which is what a new file an agent just wrote is.
///
/// Their line counts cannot come from `git diff`, so the file is read and its
/// lines counted — the same read that decides whether it is text at all. That
/// read only happens when `counts` says someone is going to show the number.
/// A worktree nested in this one is left out — see [`worktree::Neighbours`].
fn untracked_changes(layout: &worktree::Layout, counts: bool) -> Vec<ChangedFile> {
    let root = layout.root.as_path();
    let skip = worktree::excluding(&worktree::neighbours(layout).nested);
    let mut args = vec!["ls-files", "-z", "--others", "--exclude-standard", "--"];
    args.extend(skip.iter().map(String::as_str));
    let Some(out) = git(root, &args) else {
        return Vec::new();
    };
    out.split('\0')
        .filter(|path| !path.is_empty())
        .enumerate()
        .map(|(index, path)| {
            let full = root.join(path);
            // Counted only when it is worth reading and safe to: this read
            // happens with no click at all, so a path that goes through a
            // symlink is left alone rather than followed out of the tree.
            let counted = counts && index < MAX_COUNTED && !links_above(root, &full);
            let (insertions, binary) = if counted {
                new_file_lines(&full)
            } else {
                (0, false)
            };
            ChangedFile {
                path: path.to_string(),
                status: "untracked",
                old_path: None,
                insertions,
                deletions: 0,
                binary,
                counted,
            }
        })
        .collect()
}

/// Lines a new file would add, and whether it is binary.
fn new_file_lines(path: &Path) -> (u32, bool) {
    match read_capped(path) {
        Ok(file) if !file.text.is_empty() => (count_lines(&file.text), false),
        Ok(_) => (0, false),
        Err(ReadError::Binary) => (0, true),
        // Unreadable is not the same as binary, and guessing either way would
        // put a wrong count next to the file's name.
        Err(ReadError::Io(_)) => (0, false),
    }
}

fn count_lines(text: &str) -> u32 {
    let newlines = text.matches('\n').count();
    // A file whose last line has no terminator still has that line.
    let trailing = usize::from(!text.ends_with('\n'));
    (newlines + trailing) as u32
}

#[tauri::command]
pub async fn git_file_diff(
    cwd: String,
    path: String,
    base: Option<String>,
    context: Option<u32>,
    commit: Option<String>,
    old_path: Option<String>,
) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || match commit {
        Some(sha) => read_commit_file_diff(&cwd, &path, old_path.as_deref(), &sha, context),
        None => read_file_diff(&cwd, &path, base.as_deref(), context),
    })
    .await
    .map_err(|error| error.to_string())?
}

fn read_file_diff(
    cwd: &str,
    path: &str,
    base: Option<&str>,
    context: Option<u32>,
) -> Result<FileDiff, String> {
    let top = repo_root(&expand_home(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    let root = Path::new(&top);
    let rev = resolve_base(root, base).ok_or_else(|| "no such branch".to_string())?;
    // `-U` past the file's length just means the whole file, which is how the
    // panel offers full context without a second command.
    let unified = format!("-U{}", context.unwrap_or(3).min(100_000));
    let spec = literal_spec(path);

    // Verbatim: a blank context line is a single space, and trimming the patch
    // would drop the diff's last rows for any file ending in blank lines.
    let patch = git_verbatim(
        root,
        &["diff", &unified, "--no-relative", "-M", &rev, "--", &spec],
    )
    .filter(|patch| !patch.is_empty())
    .map(Ok)
    // No diff from a file git has never seen means the whole of it is the
    // change, which is what a new file from an agent looks like. For a tracked
    // file it means exactly what it says — nothing textual moved — and
    // synthesising an all-added patch there would show an unchanged file as new.
    .unwrap_or_else(|| {
        if tracked(root, path) {
            Ok(String::new())
        } else {
            added_patch(root, path)
        }
    })?;

    Ok(FileDiff {
        path: path.to_string(),
        truncated: patch.len() > MAX_BYTES,
        patch: capped(patch),
    })
}

/// One file's diff within one commit. No untracked fallback: a commit is
/// history, so an empty patch means the file did not change in it.
///
/// A rename needs both names in the pathspec: given only the new one, `-M`
/// has no old side to pair it with and the file reads as wholly added.
fn read_commit_file_diff(
    cwd: &str,
    path: &str,
    old_path: Option<&str>,
    sha: &str,
    context: Option<u32>,
) -> Result<FileDiff, String> {
    let top = repo_root(&expand_home(cwd)).ok_or_else(|| "not a git repository".to_string())?;
    let root = Path::new(&top);
    let [parent, commit] =
        commit_range(root, sha).ok_or_else(|| format!("no such commit: {sha}"))?;
    let unified = format!("-U{}", context.unwrap_or(3).min(100_000));
    let specs: Vec<String> = std::iter::once(path)
        .chain(old_path)
        .map(literal_spec)
        .collect();
    let head = [
        "diff",
        &unified,
        "--no-relative",
        "-M",
        &parent,
        &commit,
        "--",
    ];
    let args: Vec<&str> = head
        .into_iter()
        .chain(specs.iter().map(String::as_str))
        .collect();
    let patch = git_verbatim(root, &args).unwrap_or_default();
    Ok(FileDiff {
        path: path.to_string(),
        truncated: patch.len() > MAX_BYTES,
        patch: capped(patch),
    })
}

/// One commit in a file's history, with the name the file had in it.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommit {
    #[serde(flatten)]
    pub commit: Commit,
    /// Repo-relative. Differs from today's name before a rename, and it is
    /// the name that commit's diff is filed under.
    pub path: String,
    /// The name it had before this commit, when this commit renamed it.
    pub old_path: Option<String>,
}

/// A file's history, for the file column.
#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    /// Absolute repository root, which every `path` is relative to.
    pub root: String,
    pub commits: Vec<FileCommit>,
}

/// The commits that changed one file, newest first, following it across
/// renames.
#[tauri::command]
pub async fn git_file_log(cwd: String, path: String, limit: u32) -> FileHistory {
    tauri::async_runtime::spawn_blocking(move || read_file_log(&cwd, &path, limit))
        .await
        .unwrap_or_default()
}

/// The history comes from the file's own repository, found from its folder,
/// because the tab's directory may hold several repositories or none, and a
/// submodule's file means nothing to the repository around it. The tab's is
/// the fallback for a file whose folder is gone too.
fn read_file_log(cwd: &str, path: &str, limit: u32) -> FileHistory {
    let file = expand_home(path);
    let file = Path::new(&file);
    let folder = file
        .parent()
        .filter(|folder| folder.is_dir())
        .map(|folder| folder.to_string_lossy().into_owned());
    let Some(top) = folder
        .and_then(|folder| repo_root(&folder))
        .or_else(|| repo_root(&expand_home(cwd)))
    else {
        return FileHistory::default();
    };
    let root = Path::new(&top);
    let Some(relative) = repo_relative(root, file) else {
        return FileHistory::default();
    };
    let max = format!("--max-count={limit}");
    let spec = literal_spec(&relative);
    let args = [
        "log",
        "-z",
        "--name-status",
        "--follow",
        LOG_FORMAT,
        &max,
        "--",
        &spec,
    ];
    let commits = git_verbatim(root, &args)
        .map(|out| parse_file_log(&out, &unpushed_shas(root)))
        .unwrap_or_default();
    FileHistory {
        root: top.clone(),
        commits,
    }
}

/// `log -z --name-status` output: each commit's six format fields, then its
/// status letter behind a newline, then its path — two, old then new, for a
/// rename or copy — every field NUL-terminated. The newline is what tells a
/// status from the next commit's sha.
fn parse_file_log(out: &str, unpushed: &HashSet<String>) -> Vec<FileCommit> {
    let mut tokens = out.split('\0').peekable();
    let mut commits = Vec::new();
    while tokens.peek().is_some_and(|token| !token.trim().is_empty()) {
        let Some(commit) = commit_from_fields(&mut tokens, unpushed) else {
            break;
        };
        let Some(status) = tokens.next_if(|token| token.starts_with('\n')) else {
            continue;
        };
        let Some(first) = tokens.next() else { break };
        // Two paths for a rename or a copy. Only a rename's source is kept:
        // a copy's source still exists with edits of its own, and naming it
        // in the diff's pathspec would show those under the copy's name.
        let (path, old_path) = match status[1..].chars().next() {
            Some('R') => match tokens.next() {
                Some(path) => (path, Some(first.to_string())),
                None => break,
            },
            Some('C') => match tokens.next() {
                Some(path) => (path, None),
                None => break,
            },
            _ => (first, None),
        };
        commits.push(FileCommit {
            commit,
            path: path.to_string(),
            old_path,
        });
    }
    commits
}

/// `path` relative to the repository root, in git's forward-slash form, or
/// `None` for a path outside it.
///
/// Only the folder is resolved, never the file: a deleted file still has a
/// history, and a symlink's history is the link's own, not its target's. The
/// root is resolved again rather than taken as given, because on Windows
/// `repo_root` drops the `\\?\` prefix `canonicalize` adds, and a verbatim
/// path never strips a plain one.
fn repo_relative(root: &Path, path: &Path) -> Option<String> {
    let relative = match path.strip_prefix(root) {
        Ok(relative) => relative.to_path_buf(),
        Err(_) => {
            let folder = std::fs::canonicalize(path.parent()?).ok()?;
            let base = std::fs::canonicalize(root).ok()?;
            folder.strip_prefix(&base).ok()?.join(path.file_name()?)
        }
    };
    let mut parts = Vec::new();
    for part in relative.components() {
        match part {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::CurDir => {}
            // `..` would climb back out of the root it was stripped from.
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Whether git has the file in its index, which is what tells a new file from
/// one that simply has no changes.
fn tracked(root: &Path, path: &str) -> bool {
    git(root, &["ls-files", "-z", "--", &literal_spec(path)])
        .is_some_and(|out| !out.trim_matches('\0').is_empty())
}

/// A pathspec that names exactly this path, from the repository root.
///
/// `:/x` is not literal: git reads the rest as pathspec language, so a file an
/// agent named `:setup.sh` resolved to the tracked `setup.sh` beside it — an
/// empty diff for a new file — and one named `!x` or `*x` matched other files
/// or the whole repository. `literal` turns that off; `top` keeps it anchored
/// at the root, which is the form every path in this module takes.
fn literal_spec(path: &str) -> String {
    format!(":(top,literal){path}")
}

/// A patch presenting an untracked file as entirely added.
///
/// `git diff --no-index` could do this, but it needs a null device by name,
/// which differs per host — and the output would then be filed under a path
/// that is not the one asked about.
fn added_patch(root: &Path, path: &str) -> Result<String, String> {
    let file = read_capped(&root.join(path)).map_err(|error| error.to_string())?;
    let mut patch = format!("--- /dev/null\n+++ b/{path}\n");
    if file.text.is_empty() {
        return Ok(patch);
    }
    patch.push_str(&format!("@@ -0,0 +1,{} @@\n", count_lines(&file.text)));
    for line in file.text.split_inclusive('\n') {
        patch.push('+');
        patch.push_str(line.trim_end_matches('\n'));
        patch.push('\n');
    }
    Ok(patch)
}

/// At most [`MAX_BYTES`] of `text`, cut at a character boundary.
///
/// Counted in bytes, because that is what crosses the bridge: taking that many
/// *characters* instead let a patch of CJK or emoji through at four times the
/// ceiling the constant exists to impose.
fn capped(text: String) -> String {
    if text.len() <= MAX_BYTES {
        return text;
    }
    let mut end = MAX_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<TextFile, String> {
    tauri::async_runtime::spawn_blocking(move || read_text(path))
        .await
        .map_err(|error| error.to_string())?
}

fn read_text(path: String) -> Result<TextFile, String> {
    let expanded = expand_home(&path);
    let file = read_capped(Path::new(&expanded)).map_err(|error| match error {
        ReadError::Binary => format!("not a text file: {path}"),
        ReadError::Io(message) => message,
    })?;
    Ok(TextFile {
        path: expanded,
        text: file.text,
        bytes: file.bytes,
        truncated: file.truncated,
    })
}

struct Capped {
    text: String,
    bytes: u64,
    truncated: bool,
}

#[derive(Debug)]
enum ReadError {
    Binary,
    Io(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Binary => write!(formatter, "not a text file"),
            ReadError::Io(message) => write!(formatter, "{message}"),
        }
    }
}

/// Reads at most [`MAX_BYTES`] of a file as text, refusing anything binary.
///
/// A NUL byte is the test, which is the same heuristic git uses. Reading the
/// prefix rather than the whole file is what keeps a click on a multi-gigabyte
/// log from taking the window with it.
fn read_capped(path: &Path) -> Result<Capped, ReadError> {
    use std::io::Read;

    // `symlink_metadata` does not follow the link, which is the point — the
    // same stance, and the same reason, as `image.rs`: a repository can ship
    // `docs/notes.md -> ~/.ssh/id_ed25519`, and the line count for an
    // untracked file is read with no click at all.
    let metadata =
        std::fs::symlink_metadata(path).map_err(|error| ReadError::Io(error.to_string()))?;
    if metadata.file_type().is_symlink() {
        return Err(ReadError::Io(format!(
            "refusing to follow a symlink: {}",
            path.display()
        )));
    }
    if !metadata.is_file() {
        return Err(ReadError::Io(format!("not a file: {}", path.display())));
    }
    let mut buffer = Vec::new();
    open_without_following(path)
        .map_err(|error| ReadError::Io(error.to_string()))?
        .take(MAX_BYTES as u64)
        .read_to_end(&mut buffer)
        .map_err(|error| ReadError::Io(error.to_string()))?;
    if buffer.contains(&0) {
        return Err(ReadError::Binary);
    }
    Ok(Capped {
        text: String::from_utf8_lossy(&buffer).into_owned(),
        bytes: metadata.len(),
        truncated: metadata.len() > buffer.len() as u64,
    })
}

/// Opens a file, refusing in the kernel if it turns out to be a symlink.
///
/// The `symlink_metadata` check above is a separate syscall from the open, so
/// on its own it is check-then-use: a path can become a link between the two.
/// `O_NOFOLLOW` closes that, and is the only part of the refusal that cannot
/// be raced.
#[cfg(unix)]
pub fn open_without_following(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

/// Windows has no `O_NOFOLLOW`, so the check above stands alone there.
#[cfg(not(unix))]
pub fn open_without_following(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::open(path)
}

/// Whether any directory between `root` and `path` is a symlink.
///
/// `read_capped` refuses a link as the *final* component, but an intermediate
/// one is how a repository points out of itself: a committed `docs -> ~/.ssh`
/// makes everything under `docs/` look repo-relative while resolving somewhere
/// else entirely. Only components below `root` are checked — the directory the
/// user opened may itself legitimately sit under a link, and refusing that
/// would refuse the whole tree.
fn links_above(root: &Path, path: &Path) -> bool {
    let Ok(rest) = path.strip_prefix(root) else {
        return false;
    };
    let mut walked = root.to_path_buf();
    for part in rest.components() {
        walked.push(part);
        if walked == path {
            break;
        }
        match std::fs::symlink_metadata(&walked) {
            Ok(meta) if meta.file_type().is_symlink() => return true,
            // Unreadable is not a reason to read on.
            Err(_) => return true,
            _ => {}
        }
    }
    false
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || read_directory(path))
        .await
        .map_err(|error| error.to_string())?
}

/// One directory's entries, unsorted and unfiltered — which of them to show,
/// and in what order, is the tree's decision rather than the filesystem's.
fn read_directory(path: String) -> Result<Vec<Entry>, String> {
    let expanded = expand_home(&path);
    let entries = std::fs::read_dir(&expanded).map_err(|error| format!("{expanded}: {error}"))?;

    let mut listing = Vec::new();
    let mut names = Vec::new();
    for entry in entries.flatten().take(MAX_ENTRIES) {
        // `DirEntry::metadata` does not follow the link, which is what reports a
        // symlink as what it is. Whether it *points* at a directory still
        // decides if the tree offers to expand it.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let symlink = meta.file_type().is_symlink();
        let directory = if symlink {
            std::fs::metadata(entry.path()).is_ok_and(|target| target.is_dir())
        } else {
            meta.is_dir()
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        names.push(name.clone());
        listing.push(Entry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            directory,
            bytes: if directory { 0 } else { meta.len() },
            symlink,
            ignored: false,
        });
    }

    let ignored = ignored_names(Path::new(&expanded), &names);
    for entry in &mut listing {
        entry.ignored = ignored.contains(&entry.name);
    }
    Ok(listing)
}

/// Which of these names git is ignoring, asked once for the whole directory.
///
/// One `check-ignore` per listing rather than one per file, and over stdin
/// rather than argv, because a directory can hold thousands of names and an
/// argument list cannot. A directory outside a repository has no ignores, which
/// is what the empty set means here — as does a git that refused, since the
/// answer only decides how a row is tinted.
fn ignored_names(dir: &Path, names: &[String]) -> HashSet<String> {
    if names.is_empty() {
        return HashSet::new();
    }
    let Ok(mut child) = git_in(dir)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashSet::new();
    };

    if let Some(mut stdin) = child.stdin.take() {
        let mut payload = Vec::new();
        for name in names {
            payload.extend_from_slice(name.as_bytes());
            payload.push(0);
        }
        // Written from a thread of its own. git answers as it reads, so a
        // directory whose ignored names outrun the pipe buffer fills git's
        // stdout, which stops git reading stdin, which blocks this write —
        // and writing then reading from one thread is exactly that deadlock.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
    }

    // Exit code 1 means "nothing matched", which is an answer rather than a
    // failure, so the status is not checked.
    let Ok(out) = child.wait_with_output() else {
        return HashSet::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
#[path = "review_tests.rs"]
mod tests;
