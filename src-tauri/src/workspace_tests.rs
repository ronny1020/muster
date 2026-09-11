#[test]
fn a_directory_is_told_apart_from_a_file_and_from_nothing() {
    assert_eq!(kind_of(env!("CARGO_MANIFEST_DIR")), "directory");
    assert_eq!(
        kind_of(&format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR"))),
        "file"
    );
    assert_eq!(kind_of("/definitely/not/here"), "missing");
}

#[test]
fn the_home_shorthand_is_expanded_before_asking_the_filesystem() {
    // The launcher shows and sends tilde paths; `metadata` does not expand.
    assert_eq!(kind_of("~"), "directory");
}

#[test]
fn the_starred_ref_is_the_current_branch() {
    let out = "*\0main\x003 hours ago\0origin/main\n \0topic\x002 days ago\0";
    let branches = parse_branches(Some(out));
    assert_eq!(branches.len(), 2);
    assert!(branches[0].current);
    assert_eq!(branches[0].name, "main");
    assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
    assert!(!branches[1].current);
    // A branch with no upstream must read as absent, not as an empty name.
    assert_eq!(branches[1].upstream, None);
}

#[test]
fn a_remote_branch_is_offered_under_the_name_a_checkout_would_create() {
    let out = " \0origin/feature/nested\x001 day ago\0";
    let remote = remote_only(Some(out), &HashSet::new());
    assert_eq!(remote.len(), 1);
    assert_eq!(remote[0].name, "feature/nested");
    assert!(remote[0].remote);
    // The full ref is what it would start from, so it is worth keeping.
    assert_eq!(remote[0].upstream.as_deref(), Some("origin/feature/nested"));
}

#[test]
fn a_remote_branch_that_already_exists_locally_is_not_offered_twice() {
    let out = " \0origin/main\x001 day ago\0\n \0origin/other\x002 days ago\0";
    let local = HashSet::from(["main".to_string()]);
    let names: Vec<_> = remote_only(Some(out), &local)
        .into_iter()
        .map(|b| b.name)
        .collect();
    assert_eq!(names, vec!["other"]);
}

#[test]
fn the_remote_head_symref_is_not_a_branch() {
    let out = " \0origin/HEAD\x001 day ago\0";
    assert!(remote_only(Some(out), &HashSet::new()).is_empty());
}

#[test]
fn two_remotes_carrying_one_branch_offer_it_once() {
    let out = " \0origin/shared\x001 day ago\0\n \0fork/shared\x002 days ago\0";
    assert_eq!(remote_only(Some(out), &HashSet::new()).len(), 1);
}

#[test]
fn a_directory_that_is_not_a_repository_lists_no_branches() {
    assert!(read_branches("/definitely/not/here").is_empty());
}

#[test]
fn a_branch_name_that_could_be_read_as_an_option_is_refused() {
    // `git checkout --orphan` would create a branch rather than switch.
    assert!(checkout(".", "--orphan").is_err());
    assert!(checkout(".", "-f").is_err());
    assert!(checkout(".", "").is_err());
}

#[test]
fn checking_out_a_missing_branch_reports_gits_own_words() {
    // In a repository of its own, never this one: `git checkout` takes
    // `.git/index.lock`, so pointing it at the working repo made the test race
    // every other test that shells out to git — and anything else touching the
    // checkout — for a lock it had no business holding.
    let repo = std::env::temp_dir().join(format!(
        "muster-checkout-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("mkdir");
    assert!(
        git(&repo, &["init", "--quiet"]).is_some(),
        "the throwaway repository should initialise"
    );

    let error = checkout(&repo.to_string_lossy(), "muster-no-such-branch")
        .expect_err("a branch that does not exist cannot be checked out");
    let _ = std::fs::remove_dir_all(&repo);

    // The message has to name the branch, or the panel shows nothing useful.
    assert!(error.contains("muster-no-such-branch"), "{error}");
}

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
