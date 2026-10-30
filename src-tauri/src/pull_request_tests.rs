use super::*;

fn found(json: &str) -> PullRequest {
    match parse(json.as_bytes()) {
        PullRequestState::Found(pull_request) => pull_request,
        other => panic!("expected a pull request, got {other:?}"),
    }
}

fn pull_request_with(fields: &str) -> String {
    format!(
        r#"{{"number":18,"title":"Worktrees","url":"https://github.com/o/r/pull/18",
            "state":"OPEN","isDraft":false,"reviewDecision":""{fields}}}"#
    )
}

#[test]
fn an_open_pull_request_is_read_as_gh_prints_it() {
    let pull_request = found(&pull_request_with(""));
    assert_eq!(pull_request.number, 18);
    assert_eq!(pull_request.url, "https://github.com/o/r/pull/18");
    assert_eq!(pull_request.stage, Stage::Open);
    assert_eq!(pull_request.review, None);
    assert_eq!(pull_request.checks, None);
}

#[test]
fn a_draft_is_its_own_stage_only_while_open() {
    let draft = pull_request_with("").replace(r#""isDraft":false"#, r#""isDraft":true"#);
    assert_eq!(found(&draft).stage, Stage::Draft);
    let merged = draft.replace(r#""state":"OPEN""#, r#""state":"MERGED""#);
    assert_eq!(found(&merged).stage, Stage::Merged);
}

#[test]
fn each_review_decision_is_named_and_an_empty_one_is_none() {
    for (decision, review) in [
        ("APPROVED", Some(Review::Approved)),
        ("CHANGES_REQUESTED", Some(Review::ChangesRequested)),
        ("REVIEW_REQUIRED", Some(Review::Required)),
        ("", None),
    ] {
        let json = pull_request_with("").replace(
            r#""reviewDecision":"""#,
            &format!(r#""reviewDecision":"{decision}""#),
        );
        assert_eq!(found(&json).review, review, "{decision}");
    }
}

#[test]
fn checks_are_counted_in_gh_s_buckets_with_cancelled_startup_failed_and_stale_as_failed() {
    let json = br#"[
        {"bucket":"pass","state":"SUCCESS"},
        {"bucket":"fail","state":"FAILURE"},
        {"bucket":"cancel","state":"CANCELLED"},
        {"bucket":"pending","state":"STARTUP_FAILURE"},
        {"bucket":"pending","state":"STALE"},
        {"bucket":"skipping","state":"SKIPPED"},
        {"bucket":"pending","state":"IN_PROGRESS"},
        {"bucket":"pending","state":"PENDING"}
    ]"#;
    assert_eq!(
        count_checks(json),
        Some(Checks {
            passed: 1,
            failed: 4,
            pending: 2
        })
    );
    assert_eq!(count_checks(br#"[{"bucket":"pass""#), None);
}

#[test]
fn only_gh_s_no_checks_message_reads_as_a_head_with_no_checks() {
    assert!(reports_no_checks(
        b"no checks reported on the 'feat/x' branch\n"
    ));
    assert!(!reports_no_checks(b"HTTP 502: Bad Gateway\n"));
    assert!(!reports_no_checks(b""));
}

#[test]
fn output_that_is_not_a_pull_request_is_absent_rather_than_an_error() {
    assert_eq!(parse(b"no pull requests found"), PullRequestState::Absent);
    assert_eq!(parse(b"{}"), PullRequestState::Absent);
}

#[test]
fn a_directory_that_no_longer_exists_is_absent_not_a_missing_gh() {
    let gone = std::env::temp_dir().join(format!("muster-gone-{}", std::process::id()));
    assert_eq!(read(&gone), PullRequestState::Absent);
}

#[test]
fn the_wire_format_is_tagged_by_kind_with_the_pull_request_inline() {
    let json = serde_json::to_value(parse(pull_request_with("").as_bytes())).unwrap();
    assert_eq!(json["kind"], "found");
    assert_eq!(json["number"], 18);
    assert_eq!(json["stage"], "open");
    assert!(json["checks"].is_null());
    assert_eq!(
        serde_json::to_value(PullRequestState::SignedOut).unwrap()["kind"],
        "signedOut"
    );
}
