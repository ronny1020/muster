use std::path::PathBuf;

use super::*;

/// A repository with a main checkout on `main`, a sibling worktree on `topic`
/// and a worktree nested inside the main checkout on `nested` — the layout
/// `.claude/worktrees/<name>` leaves — plus a branch nobody holds.
///
/// Returns the scratch directory, the main checkout and the sibling.
pub(crate) fn repository_with_worktrees(label: &str) -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "muster-worktree-{label}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let main = dir.join("main");
    let sibling = dir.join("sibling");
    std::fs::create_dir_all(&main).expect("mkdir");
    for args in [
        &["init", "--quiet", "--initial-branch=main"][..],
        &["config", "user.name", "Muster Test"],
        &["config", "user.email", "test@example.invalid"],
        &["config", "commit.gpgsign", "false"],
        // `worktree add` runs `post-checkout`, and a global `core.hooksPath`
        // would run the developer's hook here.
        &["config", "core.hooksPath", ".git/hooks"],
        &["commit", "--quiet", "--allow-empty", "-m", "one"],
        &["branch", "free"],
        &["worktree", "add", "--quiet", "-b", "topic", "../sibling"],
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "nested",
            ".claude/worktrees/nested",
        ],
    ] {
        assert!(git(&main, args).is_some(), "git {args:?} failed");
    }
    (dir, main, sibling)
}

#[test]
fn a_porcelain_listing_names_each_tree_and_the_branch_it_holds() {
    let out = "worktree /repo\nHEAD 1111\nbranch refs/heads/main\n\n\
               worktree /repo-topic\nHEAD 2222\nbranch refs/heads/feature/x\n\n\
               worktree /repo-detached\nHEAD 3333\ndetached\n";
    assert_eq!(
        parse_list(out.lines()),
        vec![
            Record {
                path: "/repo".into(),
                branch: Some("main".into()),
                bare: false,
            },
            Record {
                path: "/repo-topic".into(),
                branch: Some("feature/x".into()),
                bare: false,
            },
            Record {
                path: "/repo-detached".into(),
                branch: None,
                bare: false,
            },
        ]
    );
}

#[test]
fn a_nul_separated_listing_keeps_a_newline_inside_a_path() {
    let out = "worktree /repo\0HEAD 1111\0branch refs/heads/main\0\0\
               worktree /odd\nbranch refs/heads/x\0HEAD 2222\0detached\0\0";
    let trees = parse_list(out.split('\0'));
    assert_eq!(trees.len(), 2);
    assert_eq!(trees[1].path, PathBuf::from("/odd\nbranch refs/heads/x"));
    assert_eq!(trees[1].branch, None);
}

#[test]
fn nothing_to_leave_out_adds_no_pathspec() {
    // An empty list leaves the common case's command line without pathspecs.
    assert!(excluding(&[]).is_empty());
    assert_eq!(
        excluding(&[".claude/worktrees/a".into()]),
        vec![":(top)", ":(exclude,top,literal).claude/worktrees/a"]
    );
}

#[test]
fn a_linked_worktree_knows_its_main_checkout_and_the_main_one_does_not() {
    let (dir, main, sibling) = repository_with_worktrees("layout");
    let from_main = layout(&main).expect("main is a working tree");
    let from_sibling = layout(&sibling).expect("the sibling is one");
    std::fs::create_dir_all(main.join("src")).expect("mkdir");
    let from_subdir = layout(&main.join("src")).expect("a subdirectory is inside one");
    let around_main = neighbours(&from_main);
    let around_sibling = neighbours(&from_sibling);
    let around_subdir = neighbours(&from_subdir);
    let main = resolved(&main);
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(around_main.main, None);
    assert_eq!(around_sibling.main, Some(main.clone()));
    assert_eq!(from_subdir.root, main);
    assert_eq!(around_subdir.main, None);
    assert_eq!(from_sibling.common, from_main.common);
    assert_eq!(around_main.nested, vec![".claude/worktrees/nested"]);
    assert!(around_sibling.nested.is_empty());
}

#[test]
fn a_submodule_main_tree_resolves_to_its_checkout() {
    // Git lists a submodule's main tree by its git directory under the
    // superproject's `.git/modules`, never by the checkout.
    let (dir, lib, _) = repository_with_worktrees("submodule-lib");
    let outer = dir.join("outer");
    std::fs::create_dir_all(&outer).expect("mkdir");
    let source = lib.to_string_lossy().into_owned();
    for args in [
        &["init", "--quiet"][..],
        &["config", "user.name", "Muster Test"],
        &["config", "user.email", "test@example.invalid"],
        &["config", "commit.gpgsign", "false"],
        &["config", "core.hooksPath", ".git/hooks"],
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            &source,
            "sub",
        ],
    ] {
        assert!(git(&outer, args).is_some(), "git {args:?} failed");
    }
    let checkout = outer.join("sub");
    assert!(
        git(
            &checkout,
            &["worktree", "add", "--quiet", "-b", "side", "../../side"]
        )
        .is_some(),
        "the submodule's worktree should be added"
    );
    let around = layout(&dir.join("side")).map(|layout| neighbours(&layout));
    let checkout = resolved(&checkout);
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(around.and_then(|around| around.main), Some(checkout));
}

#[test]
fn an_orphaned_linked_entry_keeps_its_own_path() {
    // Its `.git` gone, git run inside it would answer for the repository
    // around it, whose `core.worktree` names the main checkout.
    let (dir, main, _) = repository_with_worktrees("orphan");
    let main_path = resolved(&main).to_string_lossy().into_owned();
    git(&main, &["config", "core.worktree", &main_path]).expect("config");
    let nested = main.join(".claude/worktrees/nested");
    std::fs::remove_file(nested.join(".git")).expect("orphan it");
    let trees = list(&main);
    let nested = resolved(&nested);
    let _ = std::fs::remove_dir_all(&dir);

    assert!(trees.iter().any(|tree| tree.path == nested), "{trees:?}");
}
