//! The pull request a branch has on GitHub, asked of the user's own `gh`.
//!
//! The app holds no GitHub credential and makes no request of its own: `gh`
//! signs the request with the login the user gave it, and where there is no
//! `gh` or no login the answer says so rather than failing.

use std::{path::Path, time::Duration};

use serde::{Deserialize, Serialize};

use crate::{platform, sync, workspace::without_repository_overrides};

/// What the footer can say about the branch checked out in `cwd`.
///
/// Read by `gh pr view`, which finds the pull request the way `gh` does for the
/// user — through the branch's push target — so a fork's branch named `main`
/// is not mistaken for someone else's.
#[tauri::command]
pub async fn pull_request(cwd: String) -> PullRequestState {
    tauri::async_runtime::spawn_blocking(move || read(Path::new(&cwd)))
        .await
        .unwrap_or(PullRequestState::Absent)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PullRequestState {
    /// No `gh` where the login shell looks.
    Missing,
    /// `gh` holds no login for any host. A login for another host only, or
    /// one that has expired, reads as [`PullRequestState::Absent`], since `gh`
    /// reports those with the exit status it gives everything else.
    SignedOut,
    /// Nothing to show. `gh` gives one exit status for no pull request on this
    /// branch, a remote on a host it does not know, and a request that failed.
    Absent,
    Found(PullRequest),
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    number: u64,
    title: String,
    url: String,
    stage: Stage,
    review: Option<Review>,
    /// `None` when `gh pr checks` failed to answer.
    checks: Option<Checks>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Stage {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Review {
    Approved,
    ChangesRequested,
    Required,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Checks {
    passed: u32,
    failed: u32,
    pending: u32,
}

/// `gh`'s exit status when a command needs a login it does not have.
const AUTH_REQUIRED: i32 = 4;

/// How long `gh` has to answer before the footer stops waiting for it.
const DEADLINE: Duration = Duration::from_secs(20);

/// Variables that change what `gh` answers for every directory alike, so a
/// Muster launched from a shell that exported one would show the same answer
/// in every tab: `GH_REPO` and `GH_HOST` name a repository or host over the one
/// `cwd`'s remotes do — the second leaves none of them matching, so nothing is
/// found — and `GH_FORCE_TTY` and `CLICOLOR_FORCE` colour the JSON, which then
/// does not parse.
const GH_OVERRIDES: [&str; 4] = ["GH_REPO", "GH_HOST", "GH_FORCE_TTY", "CLICOLOR_FORCE"];

fn read(cwd: &Path) -> PullRequestState {
    // A directory that no longer exists fails the spawn with the same error a
    // missing `gh` does.
    if !cwd.is_dir() {
        return PullRequestState::Absent;
    }
    let state = match sync::run_bounded(gh(cwd).args(["pr", "view", "--json", FIELDS]), DEADLINE) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => PullRequestState::Missing,
        Err(_) => PullRequestState::Absent,
        Ok(out) if out.stopped => PullRequestState::Absent,
        Ok(out) if out.status.code() == Some(AUTH_REQUIRED) => PullRequestState::SignedOut,
        Ok(out) if out.status.success() => parse(&out.stdout),
        Ok(_) => PullRequestState::Absent,
    };
    match state {
        PullRequestState::Found(mut pull_request) => {
            pull_request.checks = read_checks(cwd, &pull_request.url);
            PullRequestState::Found(pull_request)
        }
        other => other,
    }
}

/// The checks on the pull request at `url`, asked by its URL so that a branch
/// changed between the two reads cannot answer for another pull request.
///
/// `gh pr checks` exits 0 with `--json` whatever the checks say, and 1 both
/// when the head has no checks and when the request failed; only its message
/// tells those apart, and a head with none has nothing to count.
fn read_checks(cwd: &Path, url: &str) -> Option<Checks> {
    let mut command = gh(cwd);
    command.args(["pr", "checks", url, "--json", "bucket,state"]);
    match sync::run_bounded(&mut command, DEADLINE) {
        Ok(out) if out.stopped => None,
        Ok(out) if out.status.success() => count_checks(&out.stdout),
        Ok(out) if reports_no_checks(&out.stderr) => Some(Checks::default()),
        _ => None,
    }
}

fn reports_no_checks(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr).starts_with("no checks reported")
}

/// `gh`, to be run in `cwd` with nothing inherited that would change its
/// answer and nothing it would ask or send beyond the request itself.
fn gh(cwd: &Path) -> std::process::Command {
    let mut command = platform::command("gh");
    // `gh` runs git to find the branch and its remotes.
    without_repository_overrides(&mut command);
    for name in GH_OVERRIDES {
        command.env_remove(name);
    }
    command
        .current_dir(cwd)
        // Nobody can answer a prompt, and the update check and telemetry are
        // requests the user did not ask for.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_TELEMETRY", "0");
    command
}

const FIELDS: &str = "number,title,url,state,isDraft,reviewDecision";

fn parse(json: &[u8]) -> PullRequestState {
    serde_json::from_slice::<RawPullRequest>(json)
        .map(|raw| PullRequestState::Found(summarize(raw)))
        .unwrap_or(PullRequestState::Absent)
}

/// `gh pr view --json`'s shape, for the fields [`FIELDS`] asks for.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPullRequest {
    number: u64,
    title: String,
    url: String,
    state: String,
    is_draft: bool,
    #[serde(default)]
    review_decision: Option<String>,
}

fn summarize(raw: RawPullRequest) -> PullRequest {
    let stage = match raw.state.as_str() {
        "MERGED" => Stage::Merged,
        "CLOSED" => Stage::Closed,
        _ if raw.is_draft => Stage::Draft,
        _ => Stage::Open,
    };
    let review = match raw.review_decision.as_deref() {
        Some("APPROVED") => Some(Review::Approved),
        Some("CHANGES_REQUESTED") => Some(Review::ChangesRequested),
        Some("REVIEW_REQUIRED") => Some(Review::Required),
        _ => None,
    };
    PullRequest {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        stage,
        review,
        checks: None,
    }
}

/// One check as `gh pr checks --json bucket,state` prints it: `gh` has already
/// kept only the newest run of each, by name, workflow and triggering event.
#[derive(Deserialize)]
struct RawCheck {
    bucket: String,
    state: String,
}

/// Counts the checks in the buckets `gh pr checks` puts them in, skipped ones
/// not at all.
///
/// A cancelled check, a workflow that failed to start and a check GitHub gave
/// up on as stale count as failed, where `gh` buckets the first on its own and
/// the others as pending: what they were there to verify was not verified, and
/// the last two never will be.
fn count_checks(json: &[u8]) -> Option<Checks> {
    let mut checks = Checks::default();
    for check in serde_json::from_slice::<Vec<RawCheck>>(json).ok()? {
        match (check.bucket.as_str(), check.state.as_str()) {
            (_, "STARTUP_FAILURE" | "STALE") | ("fail" | "cancel", _) => checks.failed += 1,
            ("pass", _) => checks.passed += 1,
            ("skipping", _) => {}
            _ => checks.pending += 1,
        }
    }
    Some(checks)
}

#[cfg(test)]
#[path = "pull_request_tests.rs"]
mod tests;
