//! How a working tree sits among the other worktrees of its repository.
//!
//! Every git call in this app runs with `-C` in a tab's own directory, which
//! answers correctly from a linked worktree on its own. What `-C` cannot see
//! is the neighbours: the branch another worktree holds, which `git switch`
//! refuses, and a worktree nested inside this one, which git lists as an
//! untracked directory.

use std::path::{Path, PathBuf};

use crate::workspace::git;

/// Where a working tree's repository keeps itself, from one `rev-parse`.
pub(crate) struct Layout {
    /// The top of this working tree, resolved.
    pub root: PathBuf,
    /// The directory every worktree of the repository shares, resolved.
    pub common: PathBuf,
    /// Whether this is a linked worktree rather than the main one.
    is_linked: bool,
    /// Whether `<common-dir>/worktrees` exists. Git removes it once the last
    /// linked worktree is pruned, so [`neighbours`] skips `git worktree list`
    /// without it.
    repo_has_linked: bool,
}

/// One entry of `git worktree list`.
#[derive(Debug, PartialEq)]
pub(crate) struct Worktree {
    /// Resolved, so it compares with [`Layout::root`].
    pub path: PathBuf,
    /// The branch checked out there; `None` when detached or bare.
    pub branch: Option<String>,
}

/// What a tree has around it among the repository's worktrees.
#[derive(Default)]
pub(crate) struct Neighbours {
    /// Linked worktrees inside this tree, relative to its root in git's
    /// forward-slash form.
    ///
    /// `.claude/worktrees/<name>` and `.worktrees/<name>` are where agents put
    /// them, and few repositories ignore either. Git lists such a directory as
    /// untracked, but it is another branch's checkout rather than a file this
    /// tree's agent wrote, and the review panel cannot open it as one.
    pub nested: Vec<String>,
    /// The main worktree when this tree is a linked one — the first entry
    /// [`list`] gives, so the checkout where git records one and the
    /// repository itself where it does not: a bare repository, or one made
    /// with `--separate-git-dir`.
    pub main: Option<PathBuf>,
}

/// The layout of the tree `cwd` is in, or `None` outside one — a bare
/// repository and the inside of `.git` have no top level to answer with.
pub(crate) fn layout(cwd: &Path) -> Option<Layout> {
    let out = git(
        cwd,
        &[
            "rev-parse",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
        ],
    )?;
    let mut lines = out.lines();
    let (root, git_dir, common) = (lines.next()?, lines.next()?, lines.next()?);
    // `--git-dir` and `--git-common-dir` answer relative to `cwd` from a main
    // checkout and absolute from a linked one.
    let git_dir = resolved(&cwd.join(git_dir));
    let common = resolved(&cwd.join(common));
    Some(Layout {
        root: resolved(Path::new(root)),
        repo_has_linked: common.join("worktrees").is_dir(),
        is_linked: git_dir != common,
        common,
    })
}

/// The worktrees around `layout`'s tree. Runs `git worktree list` only when
/// the repository has a linked worktree, because the status poll asks this in
/// every pane.
pub(crate) fn neighbours(layout: &Layout) -> Neighbours {
    if !layout.repo_has_linked {
        return Neighbours::default();
    }
    let trees = list(&layout.root);
    Neighbours {
        main: layout
            .is_linked
            .then(|| trees.first().map(|tree| tree.path.clone()))
            .flatten(),
        nested: trees
            .iter()
            .filter_map(|tree| relative_below(&layout.root, &tree.path))
            .collect(),
    }
}

/// [`excluding`] the worktrees nested in the tree `cwd` is in.
pub(crate) fn nested_pathspecs(cwd: &Path) -> Vec<String> {
    layout(cwd)
        .map(|layout| excluding(&neighbours(&layout).nested))
        .unwrap_or_default()
}

/// Every worktree of the repository `cwd` is in, the main one first.
///
/// `-z` because a path may hold a newline, which would split a record in
/// two; a git older than 2.36 lacks it and answers in lines instead.
pub(crate) fn list(cwd: &Path) -> Vec<Worktree> {
    let records = git(cwd, &["worktree", "list", "--porcelain", "-z"])
        .map(|out| parse_list(out.split('\0')))
        .or_else(|| {
            git(cwd, &["worktree", "list", "--porcelain"]).map(|out| parse_list(out.lines()))
        })
        .unwrap_or_default();
    records
        .into_iter()
        .enumerate()
        .map(|(index, record)| {
            let path = if index == 0 {
                main_checkout(record.path, record.bare)
            } else {
                record.path
            };
            Worktree {
                path: resolved(&path),
                branch: record.branch,
            }
        })
        .collect()
}

/// The main tree's checkout, which git lists by its git directory for a
/// submodule, answered by the `core.worktree` that directory records,
/// relative to itself.
///
/// Only the first record can be listed that way. A linked one without a
/// `.git` is a stale or orphaned entry, and asking git there would cost a
/// failed call per poll — or, inside another repository, read that
/// repository's `core.worktree` instead.
fn main_checkout(path: PathBuf, bare: bool) -> PathBuf {
    if bare || path.join(".git").exists() {
        return path;
    }
    match git(&path, &["config", "core.worktree"]) {
        Some(worktree) if !worktree.is_empty() => path.join(worktree),
        _ => path,
    }
}

/// One porcelain record, before its path is resolved.
#[derive(Debug, PartialEq)]
struct Record {
    path: PathBuf,
    branch: Option<String>,
    bare: bool,
}

/// Each record opens with `worktree <path>`; a `branch refs/heads/<name>`
/// field follows unless the tree is detached or bare.
fn parse_list<'a>(fields: impl Iterator<Item = &'a str>) -> Vec<Record> {
    let mut records: Vec<Record> = Vec::new();
    for field in fields {
        if let Some(path) = field.strip_prefix("worktree ") {
            records.push(Record {
                path: PathBuf::from(path),
                branch: None,
                bare: false,
            });
        } else if let Some(record) = records.last_mut() {
            if let Some(branch) = field.strip_prefix("branch ") {
                record.branch = Some(branch.trim_start_matches("refs/heads/").to_string());
            } else if field == "bare" {
                record.bare = true;
            }
        }
    }
    records
}

/// `path` relative to `root`, joined with `/`, when it lies strictly inside it.
fn relative_below(root: &Path, path: &Path) -> Option<String> {
    let parts: Vec<_> = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Pathspecs that cover the whole tree except `nested`, or none when there is
/// nothing to leave out — an empty pathspec list already means everything.
///
/// `:(top)` anchors the positive half at the root whatever directory git runs
/// from; the exclusions are literal, for the reason "A pathspec must be
/// literal" in `src-tauri/AGENTS.md` gives.
pub(crate) fn excluding(nested: &[String]) -> Vec<String> {
    if nested.is_empty() {
        return Vec::new();
    }
    std::iter::once(":(top)".to_string())
        .chain(
            nested
                .iter()
                .map(|path| format!(":(exclude,top,literal){path}")),
        )
        .collect()
}

/// `path` with its symlinks resolved, in a spelling git and `CreateProcessW`
/// both accept.
///
/// Resolved because git echoes the spelling it was asked with, so one tree
/// reached through a symlink — `/tmp` for `/private/tmp`, or a linked home —
/// answers two different strings. Windows' `canonicalize` answers an
/// extended-length path (`\\?\C:\repo`), which is not interchangeable with
/// the one git prints and which a process cannot be started in, so the prefix
/// is dropped, keeping the resolution without the spelling.
pub(crate) fn resolved(path: &Path) -> PathBuf {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return path.to_path_buf();
    };
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(share) => PathBuf::from(format!(r"\\{share}")),
        None => match text.strip_prefix(r"\\?\") {
            Some(local) => PathBuf::from(local),
            None => canonical,
        },
    }
}

#[cfg(test)]
#[path = "worktree_tests.rs"]
pub(crate) mod tests;
