use std::{
    path::Path,
    process::{Command, Stdio},
};

use super::*;

/// A repository of its own under the temp dir, never this one: pointing a test
/// at the working repository races every other test for its `index.lock`.
fn scratch_repo(name: &str) -> std::path::PathBuf {
    let repo = std::env::temp_dir().join(format!(
        "muster-{name}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("mkdir");
    // The fixture's commits are throwaway, so they must not depend on the
    // developer's identity or signing key being usable from a test.
    for args in [
        &["init", "--quiet"][..],
        &["config", "user.name", "Muster Test"],
        &["config", "user.email", "test@example.invalid"],
        &["config", "commit.gpgsign", "false"],
        // A global `core.hooksPath` would otherwise run the developer's hooks
        // here and ignore the ones these tests plant.
        &["config", "core.hooksPath", ".git/hooks"],
    ] {
        assert!(git(&repo, args).is_some(), "git {args:?} failed");
    }
    repo
}

fn committed_files(repo: &Path) -> Vec<String> {
    git(repo, &["show", "--name-only", "--format=", "HEAD"])
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn committing_with_nothing_staged_takes_every_change_including_new_files() {
    let repo = scratch_repo("commit-all");
    std::fs::write(repo.join("new.txt"), "hello\n").expect("write");

    let summary = commit(&repo.to_string_lossy(), "add a file", "test").expect("commit");
    let files = committed_files(&repo);
    let _ = std::fs::remove_dir_all(&repo);

    assert!(summary.contains("add a file"), "{summary}");
    assert_eq!(files, ["new.txt"]);
}

#[test]
fn committing_with_something_staged_takes_only_what_was_staged() {
    let repo = scratch_repo("commit-staged");
    std::fs::write(repo.join("chosen.txt"), "a\n").expect("write");
    std::fs::write(repo.join("left.txt"), "b\n").expect("write");
    git(&repo, &["add", "chosen.txt"]).expect("stage");

    commit(&repo.to_string_lossy(), "only the chosen one", "test").expect("commit");
    let files = committed_files(&repo);
    let _ = std::fs::remove_dir_all(&repo);

    assert_eq!(files, ["chosen.txt"]);
}

#[test]
fn a_blank_commit_message_is_refused_before_git_runs() {
    assert!(commit(".", "", "test").is_err());
    assert!(commit(".", "  \n ", "test").is_err());
}

#[test]
fn a_message_starting_with_a_dash_is_a_message_not_an_option() {
    let repo = scratch_repo("commit-dash");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");

    let result = commit(&repo.to_string_lossy(), "--amend", "test");
    let subject = git(&repo, &["log", "-1", "--format=%s"]);
    let _ = std::fs::remove_dir_all(&repo);

    result.expect("commit");
    assert_eq!(subject.as_deref(), Some("--amend"));
}

#[test]
fn committing_a_clean_tree_reports_gits_own_words() {
    let repo = scratch_repo("commit-clean");
    let error = commit(&repo.to_string_lossy(), "nothing here", "test").expect_err("clean tree");
    let _ = std::fs::remove_dir_all(&repo);

    // git prints this one to stdout, so a stderr-only error would be blank.
    assert!(error.contains("nothing to commit"), "{error}");
}

#[test]
fn pushing_a_repository_with_no_remote_explains_itself() {
    let repo = scratch_repo("push-no-remote");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");

    let error = push(&repo.to_string_lossy(), "test").expect_err("no remote to push to");
    let _ = std::fs::remove_dir_all(&repo);

    assert!(error.contains("origin"), "{error}");
}

#[test]
fn a_refused_commit_of_everything_leaves_nothing_staged() {
    let repo = scratch_repo("commit-refused");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").expect("hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    let result = commit(&repo.to_string_lossy(), "refused", "test");
    let staged = git(&repo, &["diff", "--cached", "--name-only"]);
    let _ = std::fs::remove_dir_all(&repo);

    assert!(result.is_err(), "the hook should refuse the commit");
    // Left staged, the retry after a fix would commit the pre-fix copy.
    assert_eq!(staged.as_deref(), Some(""));
}

#[test]
fn a_refused_commit_keeps_what_the_user_staged() {
    let repo = scratch_repo("commit-refused-staged");
    std::fs::write(repo.join("chosen.txt"), "a\n").expect("write");
    git(&repo, &["add", "chosen.txt"]).expect("stage");
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").expect("hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    let _ = commit(&repo.to_string_lossy(), "refused", "test");
    let staged = git(&repo, &["diff", "--cached", "--name-only"]);
    let _ = std::fs::remove_dir_all(&repo);

    assert_eq!(staged.as_deref(), Some("chosen.txt"));
}

/// The checked-out branch. Not `--short`, which answers `heads/<name>` beside
/// a tag of the same name.
fn current_branch(repo: &Path) -> Option<String> {
    let full = git(repo, &["symbolic-ref", "--quiet", "HEAD"])?;
    full.strip_prefix("refs/heads/").map(str::to_string)
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
}

fn configure_upstream(repo: &Path, merge: &str) {
    let branch = current_branch(repo).expect("on a branch");
    // A real remote, so `git status` reports the upstream the way the label
    // reads it, even once the ref behind it is gone.
    for (key, value) in [
        (
            "remote.origin.url".to_string(),
            "https://example.invalid/r.git".to_string(),
        ),
        (
            "remote.origin.fetch".to_string(),
            "+refs/heads/*:refs/remotes/origin/*".to_string(),
        ),
        (format!("branch.{branch}.remote"), "origin".to_string()),
        (format!("branch.{branch}.merge"), merge.to_string()),
    ] {
        git(repo, &["config", &key, &value]).expect("config");
    }
}

fn status_reports_upstream(repo: &Path) -> bool {
    git(repo, &["status", "--porcelain=v2", "--branch"])
        .unwrap_or_default()
        .lines()
        .any(|line| line.starts_with("# branch.upstream "))
}

#[test]
fn a_branch_whose_upstream_was_deleted_is_pushed_not_published() {
    let repo = scratch_repo("gone-upstream");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    let branch = current_branch(&repo).expect("branch");
    // As a merged pull request leaves it: configured, with no ref behind it.
    configure_upstream(&repo, &format!("refs/heads/{branch}"));

    let reported = status_reports_upstream(&repo);
    let publishes = git_status(&repo).publishes;
    let _ = std::fs::remove_dir_all(&repo);

    assert!(
        reported,
        "the label is drawn from this, so it must still read Push"
    );
    assert!(!publishes);
}

#[test]
fn a_branch_tracking_another_name_is_published_under_its_own() {
    let repo = scratch_repo("other-name");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    // `git checkout -b feat origin/main` leaves exactly this.
    configure_upstream(&repo, "refs/heads/some-other-branch");

    let target = push_target(&repo);
    let publishes = git_status(&repo).publishes;
    let _ = std::fs::remove_dir_all(&repo);

    assert!(publishes);
    assert_eq!(target.remote, "origin");
}

#[test]
fn a_branch_with_no_upstream_is_published_to_origin() {
    let repo = scratch_repo("no-upstream");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");

    let target = push_target(&repo);
    let publishes = git_status(&repo).publishes;
    let _ = std::fs::remove_dir_all(&repo);

    assert!(publishes);
    assert_eq!(target.remote, "origin");
}

#[test]
fn a_tag_named_like_the_branch_does_not_hide_its_upstream() {
    let repo = scratch_repo("tag-shadow");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    let branch = current_branch(&repo).expect("branch");
    git(&repo, &["tag", &branch]).expect("tag");
    configure_upstream(&repo, &format!("refs/heads/{branch}"));

    let publishes = git_status(&repo).publishes;
    let _ = std::fs::remove_dir_all(&repo);

    // `symbolic-ref --short` answers `heads/<branch>` here.
    assert!(!publishes);
}

#[test]
fn a_refused_commit_of_everything_leaves_nothing_staged_from_a_subdirectory() {
    let repo = scratch_repo("commit-refused-subdir");
    std::fs::create_dir_all(repo.join("sub")).expect("mkdir");
    std::fs::write(repo.join("top.txt"), "a\n").expect("write");
    std::fs::write(repo.join("sub/in.txt"), "b\n").expect("write");
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").expect("hook");
    make_executable(&hook);

    let result = commit(&repo.join("sub").to_string_lossy(), "refused", "test");
    let staged = git(&repo, &["diff", "--cached", "--name-only"]);
    let _ = std::fs::remove_dir_all(&repo);

    assert!(result.is_err(), "the hook should refuse the commit");
    // `add --all` took the whole repository, so the reset has to as well.
    assert_eq!(staged.as_deref(), Some(""));
}

#[cfg(unix)]
#[test]
fn a_cancelled_commit_stops_its_hook_and_unstages() {
    let repo = scratch_repo("commit-cancel");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    let hook = repo.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nsleep 30\n").expect("hook");
    make_executable(&hook);

    let op = format!("cancel-{:?}", std::thread::current().id());
    let cwd = repo.to_string_lossy().into_owned();
    let worker = {
        let op = op.clone();
        std::thread::spawn(move || commit(&cwd, "never lands", &op))
    };
    let started = std::time::Instant::now();
    while !git_cancel(op.clone()) {
        assert!(
            started.elapsed().as_secs() < 10,
            "the commit never registered"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let result = worker.join().expect("worker");
    let elapsed = started.elapsed();
    let staged = git(&repo, &["diff", "--cached", "--name-only"]);
    let _ = std::fs::remove_dir_all(&repo);

    assert_eq!(result, Err("Cancelled.".to_string()));
    // The hook sleeps for 30s; it has to have been stopped, not waited out.
    assert!(elapsed.as_secs() < 10, "took {elapsed:?}");
    assert_eq!(staged.as_deref(), Some(""));
}

#[test]
fn cancelling_nothing_says_so() {
    assert!(!git_cancel("no-such-op".to_string()));
}

#[test]
fn the_path_is_read_from_between_the_markers_whatever_a_profile_prints() {
    let out = format!("welcome!\n{PATH_MARKER}/opt/homebrew/bin:/usr/bin{PATH_MARKER}bye");
    assert_eq!(
        between_markers(&out).as_deref(),
        Some("/opt/homebrew/bin:/usr/bin")
    );
    assert_eq!(between_markers("no markers"), None);
    assert_eq!(
        between_markers(&format!("{PATH_MARKER}{PATH_MARKER}")),
        None
    );
}

#[test]
fn a_path_the_shell_did_not_expand_is_refused() {
    // nushell passes `"$PATH"` through as text.
    assert_eq!(
        between_markers(&format!("{PATH_MARKER}$PATH{PATH_MARKER}")),
        None
    );
}

#[test]
fn a_relative_entry_is_dropped_without_losing_the_rest() {
    // A quoted `~/bin` is never expanded, and is harmless beside good entries.
    let out = format!("{PATH_MARKER}~/bin:/opt/homebrew/bin:.:/usr/bin{PATH_MARKER}");
    assert_eq!(
        between_markers(&out).as_deref(),
        Some("/opt/homebrew/bin:/usr/bin")
    );
}

#[test]
fn a_fork_workflow_publishes_to_the_push_remote() {
    let repo = scratch_repo("push-remote");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    configure_upstream(&repo, "refs/heads/main-of-upstream");
    git(&repo, &["config", "remote.pushDefault", "fork"]).expect("config");

    let target = push_target(&repo);
    let publishes = git_status(&repo).publishes;
    let _ = std::fs::remove_dir_all(&repo);

    assert!(publishes);
    assert_eq!(target.remote, "fork");
    // The fork workflow tracks the canonical repository on purpose.
    assert!(!target.sets_upstream);
}

#[test]
fn the_head_of_stdout_and_the_tail_of_stderr_are_kept() {
    let mut head = Vec::new();
    keep_bytes(&mut head, b"[main abc] subject\n", Keep::Head);
    keep_bytes(&mut head, &vec![b'x'; MAX_OUTPUT], Keep::Head);
    assert!(head.starts_with(b"[main abc] subject"));
    assert_eq!(head.len(), MAX_OUTPUT);

    let mut tail = Vec::new();
    keep_bytes(&mut tail, &vec![b'x'; MAX_OUTPUT], Keep::Tail);
    keep_bytes(&mut tail, b"\nerror: failed to push", Keep::Tail);
    assert!(tail.ends_with(b"error: failed to push"));
    assert_eq!(tail.len(), MAX_OUTPUT);
}

fn piped(command: &mut Command) -> std::process::Child {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn")
}

#[cfg(unix)]
#[test]
fn a_background_job_holding_the_pipe_does_not_hold_the_result() {
    // The shell exits at once; the `sleep` it leaves behind keeps stdout open.
    let child = piped(without_terminal(
        Command::new("/bin/sh").args(["-c", "echo done; sleep 30 &"]),
    ));
    let started = std::time::Instant::now();
    let out = finish(child, &|| false).expect("finish");

    assert!(
        started.elapsed().as_secs() < 5,
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "done");
}

#[cfg(unix)]
#[test]
fn the_end_of_a_long_refusal_is_what_is_kept() {
    let script = "(head -c 200000 /dev/zero | tr '\\0' x; echo; echo 'the refusal') >&2";
    let out = finish(piped(Command::new("/bin/sh").args(["-c", script])), &|| {
        false
    })
    .expect("finish");

    assert!(out.stderr.len() <= MAX_OUTPUT);
    assert!(String::from_utf8_lossy(&out.stderr)
        .trim_end()
        .ends_with("the refusal"));
}

#[cfg(unix)]
#[test]
fn a_stop_that_arrives_after_success_is_not_a_cancel() {
    let child = piped(Command::new("/bin/sh").args(["-c", "exit 0"]));
    // Let it finish before the first poll can see it running.
    std::thread::sleep(std::time::Duration::from_millis(200));
    let out = finish(child, &|| true).expect("finish");

    assert!(out.status.success());
    assert!(!out.stopped);
}

#[test]
fn a_repository_whose_only_remote_is_not_origin_publishes_there() {
    let repo = scratch_repo("sole-remote");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    git(
        &repo,
        &["remote", "add", "github", "https://example.invalid/r.git"],
    )
    .expect("remote");

    let target = push_target(&repo);
    let publishes = git_status(&repo).publishes;
    let _ = std::fs::remove_dir_all(&repo);

    assert!(publishes);
    assert_eq!(target.remote, "github");
}

#[test]
fn a_fork_workflow_counts_what_is_waiting_for_the_fork() {
    let root = scratch_repo("push-target-count");
    let repo = root.join("work");
    let bare = |name: &str| {
        let path = root.join(name);
        std::fs::create_dir_all(&path).expect("mkdir");
        git(&path, &["init", "--quiet", "--bare"]).expect("bare");
        path
    };
    let (origin, fork) = (bare("origin.git"), bare("fork.git"));
    std::fs::create_dir_all(&repo).expect("mkdir");
    for args in [
        &["init", "--quiet"][..],
        &["config", "user.name", "Muster Test"],
        &["config", "user.email", "test@example.invalid"],
        &["config", "commit.gpgsign", "false"],
        &["config", "core.hooksPath", ".git/hooks"],
    ] {
        git(&repo, args).expect("setup");
    }
    git(
        &repo,
        &["remote", "add", "origin", &origin.to_string_lossy()],
    )
    .expect("origin");
    git(&repo, &["remote", "add", "fork", &fork.to_string_lossy()]).expect("fork");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    git(
        &repo,
        &["push", "--quiet", "--set-upstream", "origin", "HEAD"],
    )
    .expect("to origin");
    git(&repo, &["config", "remote.pushDefault", "fork"]).expect("pushDefault");
    std::fs::write(repo.join("g.txt"), "y\n").expect("write");
    commit(&repo.to_string_lossy(), "second", "test").expect("commit");
    git(&repo, &["push", "--quiet", "fork", "HEAD"]).expect("to fork");

    let status = git_status(&repo);
    let _ = std::fs::remove_dir_all(&root);

    // Two ahead of origin, none waiting for the fork, which is where Push goes.
    assert_eq!(status.ahead, 0);
}

#[test]
fn a_branch_name_with_regex_characters_still_finds_its_push_remote() {
    let repo = scratch_repo("regex-branch");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    git(&repo, &["checkout", "--quiet", "-b", "release-1.2+fix"]).expect("branch");
    // A second branch the unescaped `.` and `+` would also match.
    git(
        &repo,
        &["config", "branch.release-1x2fix.pushRemote", "wrong"],
    )
    .expect("decoy");
    git(
        &repo,
        &["config", "branch.release-1.2+fix.pushRemote", "fork"],
    )
    .expect("config");

    let remote = push_remote(&repo, "release-1.2+fix");
    let _ = std::fs::remove_dir_all(&repo);

    assert_eq!(remote, "fork");
}

#[test]
fn a_branch_name_in_capitals_still_finds_its_push_remote() {
    let repo = scratch_repo("capital-branch");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    git(&repo, &["config", "branch.MyBranch.pushRemote", "fork"]).expect("config");

    let remote = push_remote(&repo, "MyBranch");
    let _ = std::fs::remove_dir_all(&repo);

    // git lowercases the key's name, never the branch inside it.
    assert_eq!(remote, "fork");
}

#[test]
fn a_branch_made_from_origin_main_takes_its_own_name_as_upstream() {
    let repo = scratch_repo("from-main");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    commit(&repo.to_string_lossy(), "first", "test").expect("commit");
    configure_upstream(&repo, "refs/heads/some-other-branch");

    let target = push_target(&repo);
    let publishes = git_status(&repo).publishes;
    let _ = std::fs::remove_dir_all(&repo);

    assert!(publishes && target.sets_upstream);
}

#[cfg(unix)]
#[test]
fn a_stop_after_the_commit_landed_reports_it_landed() {
    let repo = scratch_repo("post-commit-stop");
    std::fs::write(repo.join("f.txt"), "x\n").expect("write");
    let hook = repo.join(".git/hooks/post-commit");
    std::fs::write(&hook, "#!/bin/sh\nsleep 30\n").expect("hook");
    make_executable(&hook);

    let op = format!("post-commit-{:?}", std::thread::current().id());
    let cwd = repo.to_string_lossy().into_owned();
    let worker = {
        let op = op.clone();
        std::thread::spawn(move || commit(&cwd, "lands", &op))
    };
    // Wait for the hook, which runs only once the commit exists.
    let started = std::time::Instant::now();
    while git(&repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_none() {
        assert!(started.elapsed().as_secs() < 10, "the commit never landed");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(git_cancel(op), "the commit is still running its hook");
    let result = worker.join().expect("worker");
    let subject = git(&repo, &["log", "-1", "--format=%s"]);
    let _ = std::fs::remove_dir_all(&repo);

    assert_eq!(result, Ok(LANDED_ANYWAY.to_string()));
    assert_eq!(subject.as_deref(), Some("lands"));
}
