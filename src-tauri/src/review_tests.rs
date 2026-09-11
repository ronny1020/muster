use super::*;

#[test]
fn a_rename_carries_both_of_its_paths() {
    // `-z` spends two fields on a rename and one on everything else, so a
    // parser that assumed one field would read the next record's letter as a
    // path and then desynchronise for the rest of the diff.
    let out = "M\0src/pty.rs\0R094\0src/old.rs\0src/new.rs\0A\0docs/new.md\0";
    let records = parse_name_status(out);

    assert_eq!(records.len(), 3);
    assert_eq!(records[0].path, "src/pty.rs");
    assert_eq!(records[0].old_path, None);
    assert_eq!(records[1].path, "src/new.rs");
    assert_eq!(records[1].old_path.as_deref(), Some("src/old.rs"));
    assert_eq!(records[2].letter, 'A');
    assert_eq!(records[2].path, "docs/new.md");
}

#[test]
fn a_truncated_record_ends_the_parse_rather_than_inventing_a_path() {
    let records = parse_name_status("M\0src/pty.rs\0R094\0src/old.rs\0");

    assert_eq!(records.len(), 1, "the half-written rename is dropped");
    assert_eq!(records[0].path, "src/pty.rs");
}

#[test]
fn counts_are_read_from_both_numstat_shapes() {
    // A rename leaves the third column empty and puts its paths in the two
    // fields that follow; the destination is the name the diff is filed under.
    let out = "3\t1\tsrc/pty.rs\x0012\t0\t\0src/old.rs\0src/new.rs\0";
    let counts = parse_numstat(out);

    assert_eq!(counts.len(), 2);
    assert_eq!(counts[0].path, "src/pty.rs");
    assert_eq!(counts[0].insertions, Some(3));
    assert_eq!(counts[0].deletions, Some(1));
    assert_eq!(counts[1].path, "src/new.rs");
    assert_eq!(counts[1].insertions, Some(12));
}

#[test]
fn a_binary_file_has_no_line_counts_rather_than_zero() {
    // git writes `-` for both columns. Zero would read as "nothing changed".
    let counts = parse_numstat("-\t-\ticons/icon.png\0");

    assert_eq!(counts[0].insertions, None);
    assert_eq!(counts[0].deletions, None);
}

#[test]
fn a_file_with_no_counts_of_its_own_is_reported_as_binary() {
    let statuses = parse_name_status("M\0icons/icon.png\0M\0src/pty.rs\0");
    let counts = parse_numstat("-\t-\ticons/icon.png\x004\t2\tsrc/pty.rs\0");
    let files = merge_records(statuses, &counts);

    assert!(files[0].binary, "the `-` columns are what marks it binary");
    assert_eq!(files[0].insertions, 0);
    assert!(!files[1].binary);
    assert_eq!((files[1].insertions, files[1].deletions), (4, 2));
}

#[test]
fn a_similarity_score_still_reads_as_a_rename() {
    let files = merge_records(parse_name_status("R100\0a.txt\0b.txt\0"), &[]);

    assert_eq!(files[0].status, "renamed");
    assert_eq!(files[0].old_path.as_deref(), Some("a.txt"));
}

#[test]
fn an_unterminated_last_line_is_still_a_line() {
    assert_eq!(count_lines("one\ntwo\n"), 2);
    assert_eq!(count_lines("one\ntwo"), 2);
    assert_eq!(count_lines("one"), 1);
}

#[test]
fn a_base_branch_name_starting_with_a_dash_is_refused() {
    // It would reach `git merge-base` as an option.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert_eq!(resolve_base(root, Some("--upload-pack=sh")), None);
}

#[test]
fn a_blank_base_means_the_uncommitted_state() {
    // The panel sends the selector's value straight through, and "" is what an
    // unset selector holds — it must mean HEAD, not "no such branch".
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(resolve_base(root, Some("   ")).is_some());
}

#[test]
fn a_file_of_bytes_is_refused_rather_than_shown_as_mojibake() {
    let file = scratch("binary").join("payload.bin");
    std::fs::write(&file, [0x89, 0x50, 0x00, 0x01]).expect("write");

    assert!(matches!(read_capped(&file), Err(ReadError::Binary)));
    let _ = std::fs::remove_dir_all(file.parent().expect("parent"));
}

#[test]
fn a_new_file_is_presented_as_a_patch_that_adds_all_of_it() {
    let root = scratch("added");
    std::fs::write(root.join("new.txt"), "alpha\nbeta\n").expect("write");

    let patch = added_patch(&root, "new.txt").expect("a readable file has a patch");
    let _ = std::fs::remove_dir_all(&root);

    assert_eq!(
        patch,
        "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n"
    );
}

#[test]
fn an_empty_new_file_gets_a_patch_with_no_hunk() {
    // `@@ -0,0 +1,0 @@` is not a hunk any diff parser accepts.
    let root = scratch("added-empty");
    std::fs::write(root.join("empty.txt"), "").expect("write");

    let patch = added_patch(&root, "empty.txt").expect("patch");
    let _ = std::fs::remove_dir_all(&root);

    assert!(!patch.contains("@@"), "{patch}");
}

#[test]
fn a_repository_with_no_commits_still_reports_what_is_staged() {
    // In a throwaway repository, and with nothing committed: `git diff HEAD`
    // cannot resolve there, and falling back to the empty tree is the only
    // thing that makes a first commit's worth of work reviewable.
    let root = scratch("changes");
    assert!(
        git(&root, &["init", "--quiet"]).is_some(),
        "the throwaway repository should initialise"
    );
    std::fs::write(root.join("tracked.txt"), "one\ntwo\n").expect("write");
    std::fs::write(root.join("loose.txt"), "three\n").expect("write");
    assert!(git(&root, &["add", "tracked.txt"]).is_some(), "add");

    let changes = read_changes(&root.to_string_lossy(), None, true);
    let _ = std::fs::remove_dir_all(&root);

    assert!(changes.repo);
    let tracked = changes
        .files
        .iter()
        .find(|file| file.path == "tracked.txt")
        .expect("the staged file is a change");
    assert_eq!((tracked.status, tracked.insertions), ("added", 2));

    let loose = changes
        .files
        .iter()
        .find(|file| file.path == "loose.txt")
        .expect("an untracked file is a change too — it is what a new file is");
    assert_eq!((loose.status, loose.insertions), ("untracked", 1));
}

#[test]
fn a_directory_that_is_not_there_is_an_error_not_an_empty_tree() {
    // An empty list would read as "this folder has nothing in it".
    assert!(read_directory("/definitely/not/here".into()).is_err());
}

#[test]
fn a_listing_reports_directories_and_sizes() {
    let root = scratch("listing");
    std::fs::create_dir_all(root.join("nested")).expect("mkdir");
    std::fs::write(root.join("file.txt"), "abc").expect("write");

    let mut entries = read_directory(root.to_string_lossy().into_owned()).expect("listing");
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let _ = std::fs::remove_dir_all(&root);

    assert_eq!(entries.len(), 2);
    assert_eq!(
        (entries[0].name.as_str(), entries[0].directory),
        ("file.txt", false)
    );
    assert_eq!(entries[0].bytes, 3);
    assert!(entries[1].directory);
}

#[test]
fn a_session_in_a_subdirectory_still_reports_paths_from_the_repository_root() {
    // Run from a subdirectory, `ls-files` lists only what is below it and
    // names it relative to there, while `git diff` names everything from the
    // root — so the panel's list and a clicked path would disagree.
    let root = scratch("subdir");
    assert!(git(&root, &["init", "--quiet"]).is_some(), "init");
    std::fs::create_dir_all(root.join("src/deep")).expect("mkdir");
    std::fs::write(root.join("src/deep/new.ts"), "export {}\n").expect("write");
    std::fs::write(root.join("top.md"), "# top\n").expect("write");

    let changes = read_changes(&root.join("src").to_string_lossy(), None, true);
    let paths: Vec<&str> = changes.files.iter().map(|f| f.path.as_str()).collect();
    let _ = std::fs::remove_dir_all(&root);

    assert!(paths.contains(&"src/deep/new.ts"), "{paths:?}");
    // A file outside the session's own directory is still part of the change.
    assert!(paths.contains(&"top.md"), "{paths:?}");
    assert!(
        changes.root.ends_with(
            root.file_name()
                .expect("the scratch directory has a name")
                .to_str()
                .expect("utf-8")
        ),
        "root should be the repository, not the session's directory: {}",
        changes.root
    );
}

#[test]
fn a_file_git_already_has_is_told_apart_from_a_new_one() {
    // It decides whether an empty diff means "nothing moved" or "all of this
    // is new", and getting it backwards shows an unchanged file as added.
    let root = scratch("tracked");
    assert!(git(&root, &["init", "--quiet"]).is_some(), "init");
    std::fs::create_dir_all(root.join("src")).expect("mkdir");
    std::fs::write(root.join("src/known.ts"), "export {}\n").expect("write");
    std::fs::write(root.join("src/loose.ts"), "export {}\n").expect("write");
    assert!(git(&root, &["add", "src/known.ts"]).is_some(), "add");

    let known = tracked(&root, "src/known.ts");
    let loose = tracked(&root, "src/loose.ts");
    let _ = std::fs::remove_dir_all(&root);

    assert!(known, "a file in the index is tracked");
    assert!(!loose, "a file git has never seen is not");
}

/// A directory of this test's own, never the working repository: these tests
/// write files and run `git`, and sharing a tree would race every other test
/// that shells out.
fn scratch(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "muster-review-{label}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("the scratch directory should be creatable");
    path
}

#[test]
fn a_patch_keeps_the_blank_lines_a_file_ends_with() {
    // `git()` trims trailing whitespace, and a unified diff's blank context
    // line is a single space — so the trimmed patch lost the file's last rows
    // while its `@@` header still promised them.
    let root = scratch("verbatim");
    assert!(git(&root, &["init", "--quiet"]).is_some(), "init");
    std::fs::write(root.join("f.txt"), "one\ntwo\nthree\n \n \n").expect("write");
    assert!(git(&root, &["add", "f.txt"]).is_some(), "add");
    std::fs::write(root.join("f.txt"), "one\nCHANGED\nthree\n \n \n").expect("write");

    let diff = read_file_diff(&root.to_string_lossy(), "f.txt", None, None).expect("diff");
    let _ = std::fs::remove_dir_all(&root);

    let rows = diff
        .patch
        .lines()
        .filter(|line| line.starts_with(' ') || line.starts_with(['+', '-']))
        .filter(|line| !line.starts_with("+++") && !line.starts_with("---"))
        .count();
    // Three context lines, one removed and one added.
    assert_eq!(rows, 5, "{:?}", diff.patch);
    assert!(diff.patch.ends_with('\n'), "{:?}", diff.patch);
}

#[test]
fn the_cap_counts_the_bytes_that_cross_the_bridge() {
    // Characters are what the old cap counted, so four-byte content went over
    // the ceiling by four times.
    let wide = "🙂".repeat(MAX_BYTES);
    let capped = capped(wide);

    assert!(capped.len() <= MAX_BYTES, "{} bytes", capped.len());
    // Cut at a boundary, so the string is still the characters it contains.
    assert!(capped.chars().all(|c| c == '🙂'));
}

#[test]
fn text_under_the_cap_is_returned_whole() {
    assert_eq!(capped("short".to_string()), "short");
}

#[test]
fn a_pathspec_names_one_file_and_never_git_s_own_language() {
    // `:/x` left the rest as pathspec language: a file named `:setup.sh`
    // resolved to the tracked `setup.sh` beside it, so a new file showed an
    // empty diff, and `!x` inverted the whole thing.
    assert_eq!(literal_spec("src/App.tsx"), ":(top,literal)src/App.tsx");
    assert_eq!(literal_spec(":setup.sh"), ":(top,literal):setup.sh");
    assert_eq!(literal_spec("!notes.md"), ":(top,literal)!notes.md");
}

/// Unix-only: `:` is reserved in a Windows filename, so the hostile name this
/// defends against cannot be created there at all. `literal_spec`'s own test
/// above covers the construction on every platform.
#[cfg(unix)]
#[test]
fn a_new_file_named_like_a_pathspec_shows_its_own_diff() {
    let root = scratch("pathspec");
    assert!(git(&root, &["init", "--quiet"]).is_some(), "init");
    std::fs::write(root.join("setup.sh"), "echo tracked\n").expect("write");
    assert!(git(&root, &["add", "setup.sh"]).is_some(), "add");
    // The agent's new file, named to be read as pathspec magic.
    std::fs::write(root.join(":setup.sh"), "echo hostile\n").expect("write");

    let diff = read_file_diff(&root.to_string_lossy(), ":setup.sh", None, None).expect("diff");
    let _ = std::fs::remove_dir_all(&root);

    assert!(diff.patch.contains("hostile"), "{:?}", diff.patch);
}

#[test]
fn a_symlink_is_refused_rather_than_read_through() {
    // `git ls-files --others` lists one, and the line count for an untracked
    // file is read with no click — so a link out of the tree was followed
    // automatically. Same stance as `image.rs`, and for the same reason.
    let root = scratch("symlink");
    let secret = root.join("secret.txt");
    std::fs::write(&secret, "sensitive\n").expect("write");
    let link = root.join("notes.md");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&secret, &link).expect("symlink");
    #[cfg(windows)]
    let _ = std::os::windows::fs::symlink_file(&secret, &link);

    let refused = matches!(read_capped(&link), Err(ReadError::Io(_)));
    let direct = read_capped(&secret).expect("the target itself still reads");
    let _ = std::fs::remove_dir_all(&root);

    assert!(refused, "a symlink must not be followed");
    assert_eq!(direct.text, "sensitive\n");
}

#[test]
fn only_so_many_new_files_are_read_for_their_line_counts() {
    // Reading every untracked file on every poll is what an un-ignored build
    // output turns into thousands of reads.
    assert_eq!(MAX_COUNTED, 512);
}

#[test]
fn a_listing_says_which_entries_git_is_ignoring() {
    // A build output is part of the directory and not part of the work, so the
    // tree shows it dimmed rather than hiding it or treating it as source.
    let root = scratch("ignored");
    assert!(git(&root, &["init", "--quiet"]).is_some(), "init");
    std::fs::write(root.join(".gitignore"), "dist/\n*.log\n").expect("write");
    std::fs::create_dir_all(root.join("dist")).expect("mkdir");
    std::fs::write(root.join("build.log"), "noise\n").expect("write");
    std::fs::write(root.join("main.ts"), "export {}\n").expect("write");

    let mut entries = read_directory(root.to_string_lossy().into_owned()).expect("listing");
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let _ = std::fs::remove_dir_all(&root);

    let ignored: Vec<&str> = entries
        .iter()
        .filter(|entry| entry.ignored)
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(ignored, ["build.log", "dist"]);
    // The file that carries the rules is not itself ignored, nor is the source.
    assert!(entries.iter().any(|e| e.name == "main.ts" && !e.ignored));
    assert!(entries.iter().any(|e| e.name == ".gitignore" && !e.ignored));
}

#[test]
fn a_directory_outside_a_repository_ignores_nothing() {
    let root = scratch("no-repo");
    std::fs::write(root.join("a.log"), "x\n").expect("write");

    let entries = read_directory(root.to_string_lossy().into_owned()).expect("listing");
    let _ = std::fs::remove_dir_all(&root);

    assert!(entries.iter().all(|entry| !entry.ignored));
}

#[test]
fn a_directory_of_ignored_files_does_not_deadlock_the_listing() {
    // git answers `check-ignore` as it reads, so a listing whose ignored names
    // outrun the pipe buffer fills git's stdout, which stops git reading
    // stdin. Writing and reading from one thread hangs there — and a hang is
    // how this test fails, since there is no wrong answer to assert on.
    let root = scratch("ignored-many");
    assert!(git(&root, &["init", "--quiet"]).is_some(), "init");
    std::fs::write(root.join(".gitignore"), "*.tmp\n").expect("write");

    let long = "a".repeat(120);
    let names: Vec<String> = (0..1200).map(|n| format!("{long}-{n}.tmp")).collect();
    for name in &names {
        std::fs::write(root.join(name), "x").expect("write");
    }

    let ignored = ignored_names(&root, &names);
    let _ = std::fs::remove_dir_all(&root);

    // Well past a 64 KB pipe in both directions.
    assert!(names.len() * long.len() > 128 * 1024);
    assert_eq!(ignored.len(), names.len());
}

#[test]
fn a_directory_that_is_a_link_hides_everything_under_it() {
    // `read_capped` refuses a link as the last component, but a committed
    // `docs -> ~/.ssh` makes every path under `docs/` look repo-relative while
    // resolving somewhere else — and the line count for a new file is taken
    // with no click at all.
    let root = scratch("links-above");
    let outside = scratch("links-outside");
    std::fs::write(outside.join("secret.txt"), "sensitive\n").expect("write");
    std::fs::create_dir_all(root.join("real")).expect("mkdir");
    std::fs::write(root.join("real/note.txt"), "fine\n").expect("write");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("docs")).expect("symlink");
    #[cfg(windows)]
    let _ = std::os::windows::fs::symlink_dir(&outside, root.join("docs"));

    let through_link = links_above(&root, &root.join("docs/secret.txt"));
    let ordinary = links_above(&root, &root.join("real/note.txt"));
    // The root may itself sit under a link — a temp directory usually does —
    // and refusing that would refuse the whole tree.
    let root_itself = links_above(&root, &root.join("real"));
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside);

    assert!(through_link, "a path through a linked directory is refused");
    assert!(!ordinary, "an ordinary nested path is not");
    assert!(!root_itself, "the components of the root are not checked");
}

#[test]
fn a_path_outside_the_root_is_not_judged_by_this() {
    // `strip_prefix` fails, and the caller's own confinement decides.
    let root = scratch("links-unrelated");
    let verdict = links_above(&root, Path::new("/etc/hosts"));
    let _ = std::fs::remove_dir_all(&root);

    assert!(!verdict);
}

#[test]
fn asking_only_which_files_differ_reports_no_numbers() {
    // What this pins is what is *reported*: an implementation that read each
    // file and then discarded the answer would satisfy every assertion here.
    // That nothing is opened has no test, and not for want of trying — the
    // one observable difference would be a file whose open blocks, and git
    // omits a fifo from `ls-files --others` entirely, so it never reaches the
    // read. The property is held by the `counts &&` short-circuit in
    // `untracked_changes`; read that line before changing it.
    let root = scratch("no-counts");
    assert!(git(&root, &["init", "--quiet"]).is_some(), "init");
    std::fs::write(root.join("new.txt"), "one\ntwo\nthree\n").expect("write");

    let counted = read_changes(&root.to_string_lossy(), None, true);
    let listed = read_changes(&root.to_string_lossy(), None, false);
    let _ = std::fs::remove_dir_all(&root);

    let with = counted
        .files
        .iter()
        .find(|f| f.path == "new.txt")
        .expect("listed");
    let without = listed
        .files
        .iter()
        .find(|f| f.path == "new.txt")
        .expect("listed");

    assert_eq!((with.insertions, with.counted), (3, true));
    // Same file, same status, no number — and the list says it took none.
    assert_eq!((without.insertions, without.counted), (0, false));
    assert_eq!(without.status, "untracked");
}
