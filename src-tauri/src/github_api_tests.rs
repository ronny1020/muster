use super::*;

#[test]
fn every_form_git_accepts_for_a_github_remote_names_its_repository() {
    for url in [
        "https://github.com/o/r.git",
        "https://github.com/o/r",
        "https://github.com/o/r/",
        "https://user@github.com/o/r.git",
        "http://github.com/o/r",
        "git@github.com:o/r.git",
        "GitHub.com:o/r",
        "ssh://git@github.com/o/r.git",
        "ssh://git@github.com:22/o/r.git",
        "git://github.com/o/r.git",
    ] {
        assert_eq!(
            repository_of(url),
            Some(("o".to_string(), "r".to_string())),
            "{url}"
        );
    }
}

#[test]
fn another_host_or_a_name_the_api_path_cannot_carry_is_not_asked_about() {
    for url in [
        "https://gitlab.com/o/r.git",
        "https://github.com.evil.example/o/r",
        "git@ghe.example.com:o/r.git",
        "https://github.com/o",
        "https://github.com/o/r?x=1",
        "https://github.com/o/../r",
        "https://github.com/o/r%2F..",
        "/srv/git/r.git",
        "../r",
    ] {
        assert_eq!(repository_of(url), None, "{url}");
    }
}

#[test]
fn a_branch_name_cannot_add_a_query_parameter() {
    assert_eq!(encode("o:feat/a&state=x#y"), "o%3Afeat%2Fa%26state%3Dx%23y");
    assert_eq!(encode("o:fix-1.2_x~"), "o%3Afix-1.2_x~");
}

fn pull(state: &str, merged: bool) -> RawPull {
    RawPull {
        number: 7,
        title: "T".into(),
        html_url: "https://github.com/o/r/pull/7".into(),
        state: state.into(),
        draft: false,
        merged_at: merged.then(|| "2026-11-01T00:00:00Z".into()),
        head: RawHead {
            sha: "abc".into(),
            repo: Some(RawRepo {
                full_name: "me/fork".into(),
            }),
        },
    }
}

#[test]
fn an_open_pull_request_is_preferred_over_a_newer_closed_one() {
    let mut open = pull("open", false);
    open.number = 9;
    assert_eq!(
        pick(vec![pull("closed", true), open], "me/fork")
            .unwrap()
            .number,
        9
    );
    assert_eq!(
        pick(vec![pull("closed", true)], "Me/Fork").unwrap().number,
        7
    );
    assert!(pick(Vec::new(), "me/fork").is_none());
}

#[test]
fn a_same_named_branch_in_another_repository_of_the_owner_is_not_ours() {
    let mut theirs = pull("open", false);
    theirs.head.repo = Some(RawRepo {
        full_name: "me/other".into(),
    });
    let mut gone = pull("open", false);
    gone.head.repo = None;
    assert!(pick(vec![theirs, gone], "me/fork").is_none());
}

#[test]
fn the_stage_is_read_from_state_merged_at_and_draft() {
    assert_eq!(summarize(pull("closed", true), None).stage, Stage::Merged);
    assert_eq!(summarize(pull("closed", false), None).stage, Stage::Closed);
    assert_eq!(summarize(pull("open", false), None).stage, Stage::Open);
    let mut draft = pull("open", false);
    draft.draft = true;
    assert_eq!(summarize(draft, None).stage, Stage::Draft);
    assert_eq!(summarize(pull("open", false), None).head, "abc");
}

#[test]
fn checks_and_statuses_are_counted_as_gh_buckets_them_with_neutral_and_skipped_left_out() {
    let runs: RawCheckRuns = serde_json::from_str(
        r#"{"check_runs":[
            {"status":"completed","conclusion":"success"},
            {"status":"completed","conclusion":"neutral"},
            {"status":"completed","conclusion":"failure"},
            {"status":"completed","conclusion":"cancelled"},
            {"status":"completed","conclusion":"timed_out"},
            {"status":"completed","conclusion":"skipped"},
            {"status":"in_progress","conclusion":null},
            {"status":"queued","conclusion":null}
        ]}"#,
    )
    .unwrap();
    let status: RawStatus = serde_json::from_str(
        r#"{"state":"failure","statuses":[
            {"state":"success","context":"vercel"},
            {"state":"pending","context":"netlify"},
            {"state":"error","context":"jenkins"},
            {"state":"failure","context":"circleci"}
        ]}"#,
    )
    .unwrap();
    assert_eq!(
        count(&runs.check_runs, &status.statuses),
        Checks {
            passed: 2,
            failed: 5,
            pending: 3
        }
    );
}

#[test]
fn the_api_s_pull_request_list_parses_as_github_sends_it() {
    let pulls: Vec<RawPull> = serde_json::from_str(
        r#"[{"number":3,"title":"X","html_url":"https://github.com/o/r/pull/3",
             "state":"open","draft":true,"merged_at":null,
             "head":{"sha":"0123abcd","ref":"feat"},"user":{"login":"o"}}]"#,
    )
    .unwrap();
    assert_eq!(pulls[0].number, 3);
    assert!(pulls[0].draft);
}

/// A repository of its own under the temp dir, with throwaway commits that do
/// not depend on the developer's identity, signing key or hooks.
fn scratch_repo(name: &str) -> std::path::PathBuf {
    let repo = std::env::temp_dir().join(format!(
        "muster-gh-api-{name}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).expect("mkdir");
    for args in [
        &["init", "--quiet", "--initial-branch=feat"][..],
        &["config", "user.name", "Muster Test"],
        &["config", "user.email", "test@example.invalid"],
        &["config", "commit.gpgsign", "false"],
        // A directory that does not exist: no hook runs, including the
        // `prepare-commit-msg` that `--no-verify` does not skip.
        &["config", "core.hooksPath", "no-hooks"],
        &[
            "commit",
            "--quiet",
            "--no-verify",
            "--allow-empty",
            "-m",
            "one",
        ],
        &["remote", "add", "origin", "git@github.com:me/fork.git"],
    ] {
        assert!(git(&repo, args).is_some(), "git {args:?} failed");
    }
    repo
}

#[test]
fn a_branch_never_pushed_is_not_asked_about() {
    let repo = scratch_repo("unpushed");
    git(&repo, &["config", "branch.feat.remote", "origin"]).unwrap();
    git(&repo, &["config", "branch.feat.merge", "refs/heads/feat"]).unwrap();
    assert_eq!(push_target(&repo), None);
    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn a_fork_s_branch_is_looked_for_in_the_repository_upstream_names() {
    let repo = scratch_repo("fork");
    git(
        &repo,
        &[
            "remote",
            "add",
            "upstream",
            "https://github.com/them/project",
        ],
    )
    .unwrap();
    git(&repo, &["config", "branch.feat.remote", "origin"]).unwrap();
    git(&repo, &["config", "branch.feat.merge", "refs/heads/feat"]).unwrap();
    git(&repo, &["update-ref", "refs/remotes/origin/feat", "HEAD"]).unwrap();
    assert_eq!(
        push_target(&repo),
        Some(Target {
            base: "them/project".into(),
            head: "me/fork".into(),
            branch: "feat".into(),
        })
    );
    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn a_branch_pushed_without_an_upstream_is_found_by_its_own_name() {
    let repo = scratch_repo("no-upstream");
    git(&repo, &["update-ref", "refs/remotes/origin/feat", "HEAD"]).unwrap();
    assert_eq!(
        push_target(&repo),
        Some(Target {
            base: "me/fork".into(),
            head: "me/fork".into(),
            branch: "feat".into(),
        })
    );
    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn the_head_owner_is_where_the_branch_is_pushed_and_set_default_picks_the_base() {
    let repo = scratch_repo("push-url");
    git(
        &repo,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/them/project",
        ],
    )
    .unwrap();
    git(
        &repo,
        &[
            "remote",
            "set-url",
            "--push",
            "origin",
            "git@github.com:me/fork.git",
        ],
    )
    .unwrap();
    git(
        &repo,
        &[
            "remote",
            "add",
            "upstream",
            "https://github.com/someone/else",
        ],
    )
    .unwrap();
    git(&repo, &["config", "remote.origin.gh-resolved", "base"]).unwrap();
    git(&repo, &["update-ref", "refs/remotes/origin/feat", "HEAD"]).unwrap();
    assert_eq!(
        push_target(&repo),
        Some(Target {
            base: "them/project".into(),
            head: "me/fork".into(),
            branch: "feat".into(),
        })
    );
    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn a_redirect_is_followed_only_while_it_stays_on_the_api() {
    let renamed = "https://api.github.com/repositories/1/pulls?state=all";
    assert_eq!(same_api(renamed), Some(renamed));
    assert_eq!(same_api("https://api.github.com.evil.example/x"), None);
    assert_eq!(same_api("http://api.github.com/x"), None);
    assert_eq!(same_api("/repositories/1"), None);
}
