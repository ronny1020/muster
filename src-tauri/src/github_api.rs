//! The pull request a pushed branch has on github.com, asked of GitHub's
//! public API with no credential, for when the user's `gh` cannot answer.
//!
//! Only `api.github.com` is asked, never another host a remote names, and no
//! login or token is sent: what comes back is what anyone may read about a
//! public repository. A private repository's name and branch are still sent,
//! and GitHub answers that it has no such repository. GitHub allows such a
//! client 60 requests an hour, so each answer is kept for [`FRESH_FOR`] and a
//! read inside it costs nothing.

use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use serde::Deserialize;

use crate::{
    pull_request::{is_sha, Checks, PullRequest, PullRequestState, Stage},
    workspace::git,
};

/// How long one answer stands: three requests each — more for a renamed
/// repository, whose redirects count too — so about 36 of the hour's 60 for a
/// branch left on screen.
const FRESH_FOR: Duration = Duration::from_secs(5 * 60);

/// How long GitHub has to answer each request.
const DEADLINE: Duration = Duration::from_secs(10);

/// More than any pull request list, check-run page or status this asks for.
const MAX_BODY_BYTES: u64 = 2 * 1024 * 1024;

type Answers = HashMap<String, (Instant, PullRequestState)>;

/// Answers already given, by repository and branch. One that never arrived is
/// not kept, so a dropped connection costs one poll rather than five minutes;
/// a refusal is.
static ANSWERS: LazyLock<Mutex<Answers>> = LazyLock::new(Mutex::default);

/// The pull request of the branch checked out in `cwd`, or
/// [`PullRequestState::Absent`] when the branch has no push target on
/// github.com, was never pushed, or GitHub did not answer.
pub(super) fn read(cwd: &Path) -> PullRequestState {
    let Some(target) = push_target(cwd) else {
        return PullRequestState::Absent;
    };
    let key = format!("{}\n{}:{}", target.base, target.owner, target.branch);
    if let Some(state) = remembered(&key) {
        return state;
    }
    let Some((state, settled)) = ask(&target) else {
        return PullRequestState::Absent;
    };
    if settled {
        answers().insert(key, (Instant::now(), state.clone()));
    }
    state
}

fn answers() -> std::sync::MutexGuard<'static, Answers> {
    ANSWERS.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn remembered(key: &str) -> Option<PullRequestState> {
    let mut answers = answers();
    answers.retain(|_, (at, _)| at.elapsed() < FRESH_FOR);
    answers.get(key).map(|(_, state)| state.clone())
}

/// Where a branch's pull request is looked for.
#[derive(Debug, PartialEq)]
struct Target {
    /// `owner/repo` of the repository the pull request is opened against.
    base: String,
    /// The owner of the repository the branch is pushed to.
    owner: String,
    /// The branch's name there.
    branch: String,
}

/// The branch's push target, and the base repository chosen as `gh` chooses
/// it — the remote `gh repo set-default` marked, else `upstream`, `github`,
/// `origin` and the push remote in that order — so a fork's pull request is
/// looked for where it was opened.
fn push_target(cwd: &Path) -> Option<Target> {
    let head = git(cwd, &["symbolic-ref", "--quiet", "HEAD"])?;
    let local = head.strip_prefix("refs/heads/")?;
    let line = git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(push:remotename)%00%(push)",
            &head,
        ],
    )?;
    let (remote, pushed) = line.split_once('\0')?;
    let remote = if remote.is_empty() { "origin" } else { remote };
    // `%(push)` is empty for a branch pushed without `-u`, and for one whose
    // upstream has another name under `push.default=simple`; the ref a push
    // under the branch's own name leaves stands in for it.
    let (branch, pushed) = match pushed.strip_prefix(&format!("refs/remotes/{remote}/")) {
        Some(branch) => (branch.to_string(), pushed.to_string()),
        None => (local.to_string(), format!("refs/remotes/{remote}/{local}")),
    };
    // Never pushed: there is nothing to ask about, and a local branch's name
    // is not sent anywhere.
    git(cwd, &["rev-parse", "--verify", "--quiet", &pushed])?;
    let (owner, _) = repository_of(&remote_url(cwd, remote, &["--push"])?)?;
    let remotes = git(cwd, &["remote"])?;
    let marked = git(
        cwd,
        &["config", "--get-regexp", r"^remote\..*\.gh-resolved$"],
    )
    .unwrap_or_default();
    let marked = marked.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        (value == "base")
            .then_some(key)?
            .strip_prefix("remote.")?
            .strip_suffix(".gh-resolved")
    });
    let (base_owner, base_name) = marked
        .into_iter()
        .chain(["upstream", "github", "origin", remote])
        .filter(|name| remotes.lines().any(|listed| listed == *name))
        .find_map(|name| repository_of(&remote_url(cwd, name, &[])?))?;
    Some(Target {
        base: format!("{base_owner}/{base_name}"),
        owner,
        branch,
    })
}

/// The URL `git` fetches `remote` from, or pushes to with `--push`, with
/// `insteadOf` rewrites applied.
fn remote_url(cwd: &Path, remote: &str, flags: &[&str]) -> Option<String> {
    // A name git would read as an option.
    if remote.starts_with('-') {
        return None;
    }
    let mut args = vec!["remote", "get-url"];
    args.extend(flags);
    args.push(remote);
    git(cwd, &args)
}

/// `(owner, repo)` of a github.com remote URL, in any of the forms git
/// accepts for it; `None` for another host or a name the API path could not
/// carry as it is.
fn repository_of(url: &str) -> Option<(String, String)> {
    let path = ["https://", "http://", "ssh://", "git://"]
        .into_iter()
        .find_map(|scheme| url.strip_prefix(scheme))
        .and_then(|rest| {
            let (authority, path) = rest.split_once('/')?;
            let host = authority.rsplit('@').next()?.split(':').next()?;
            host.eq_ignore_ascii_case("github.com").then_some(path)
        })
        .or_else(|| {
            let (user_host, path) = url.split_once(':')?;
            let host = user_host.rsplit('@').next()?;
            (!user_host.contains('/') && host.eq_ignore_ascii_case("github.com")).then_some(path)
        })?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    let plain = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    };
    (plain(owner) && plain(repo)).then(|| (owner.to_string(), repo.to_string()))
}

/// What GitHub says about the target, and whether it is settled enough to
/// keep, or `None` when a request never got an answer.
fn ask(target: &Target) -> Option<(PullRequestState, bool)> {
    let route = format!(
        "repos/{}/pulls?state=all&per_page=10&head={}",
        target.base,
        encode(&format!("{}:{}", target.owner, target.branch))
    );
    // A refusal is an answer: a private repository is a 404 and the hour's
    // limit a 403, and asking again each minute would spend the limit on both.
    let pull = match get::<Vec<RawPull>>(&route) {
        Reply::Body(pulls) => pick(pulls),
        Reply::Refused => None,
        Reply::Failed => return None,
    };
    let Some(pull) = pull else {
        return Some((PullRequestState::Absent, true));
    };
    let (checks, settled) = checks_of(&target.base, &pull.head.sha);
    Some((PullRequestState::Found(summarize(pull, checks)), settled))
}

/// The check runs and the commit statuses on `sha`, which `gh pr checks`
/// counts together: a CI reporting through the older status API has no runs.
/// The flag is whether the answer may be kept.
fn checks_of(base: &str, sha: &str) -> (Option<Checks>, bool) {
    if !is_sha(sha) {
        return (None, true);
    }
    let runs = get::<RawCheckRuns>(&format!(
        "repos/{base}/commits/{sha}/check-runs?per_page=100"
    ));
    let statuses = get::<RawStatus>(&format!("repos/{base}/commits/{sha}/status?per_page=100"));
    match (runs, statuses) {
        (Reply::Body(runs), Reply::Body(statuses)) => {
            (Some(count(&runs.check_runs, &statuses.statuses)), true)
        }
        (Reply::Failed, _) | (_, Reply::Failed) => (None, false),
        _ => (None, true),
    }
}

/// An open pull request over a closed one, as `gh pr view` prefers it; the
/// list comes newest first.
fn pick(pulls: Vec<RawPull>) -> Option<RawPull> {
    let open = pulls.iter().position(|pull| pull.state == "open");
    pulls.into_iter().nth(open.unwrap_or(0))
}

fn summarize(pull: RawPull, checks: Option<Checks>) -> PullRequest {
    let stage = match (pull.state.as_str(), pull.merged_at.is_some(), pull.draft) {
        (_, true, _) => Stage::Merged,
        ("closed", _, _) => Stage::Closed,
        (_, _, true) => Stage::Draft,
        _ => Stage::Open,
    };
    PullRequest {
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        stage,
        // The review decision is not part of the REST answer.
        review: None,
        checks,
        head: pull.head.sha,
    }
}

/// Counted as `pull_request::count_checks` counts `gh`'s buckets, where a
/// neutral run is skipped: a cancelled, timed-out or stale run failed to
/// verify what it was there for.
fn count(runs: &[RawCheckRun], statuses: &[RawCommitStatus]) -> Checks {
    let mut checks = Checks::default();
    for run in runs {
        match (run.status.as_str(), run.conclusion.as_deref()) {
            ("completed", Some("success")) => checks.passed += 1,
            ("completed", Some("skipped" | "neutral")) => {}
            ("completed", _) => checks.failed += 1,
            _ => checks.pending += 1,
        }
    }
    for status in statuses {
        match status.state.as_str() {
            "success" => checks.passed += 1,
            "pending" => checks.pending += 1,
            _ => checks.failed += 1,
        }
    }
    checks
}

/// Percent-encodes everything outside RFC 3986's unreserved set, so a branch
/// name cannot add a parameter to the query.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// Redirects a repository's rename or transfer can answer with, followed by
/// hand so that none leaves `api.github.com`.
const MAX_HOPS: usize = 3;

/// How one request ended.
enum Reply<T> {
    Body(T),
    /// GitHub answered with a 4xx, or a redirect off the API: asking again
    /// soon gets the same answer.
    Refused,
    /// No usable answer — the network, a 5xx, a body that did not parse — so
    /// the next poll may do better.
    Failed,
}

fn get<T: serde::de::DeserializeOwned>(route: &str) -> Reply<T> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(DEADLINE))
        .max_redirects(0)
        .build()
        .into();
    let mut url = format!("{API}{route}");
    for _ in 0..=MAX_HOPS {
        let mut response = match agent
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", "Muster")
            .call()
        {
            Ok(response) => response,
            Err(ureq::Error::StatusCode(code)) if (400..500).contains(&code) => {
                return Reply::Refused;
            }
            Err(_) => return Reply::Failed,
        };
        if response.status().is_redirection() {
            let next = response
                .headers()
                .get("location")
                .and_then(|location| location.to_str().ok())
                .and_then(same_api);
            match next {
                Some(next) => url = next.to_string(),
                None => return Reply::Refused,
            }
            continue;
        }
        let mut body = Vec::new();
        let read = response
            .body_mut()
            .as_reader()
            .take(MAX_BODY_BYTES)
            .read_to_end(&mut body);
        return match read.ok().and_then(|_| serde_json::from_slice(&body).ok()) {
            Some(value) => Reply::Body(value),
            None => Reply::Failed,
        };
    }
    Reply::Refused
}

const API: &str = "https://api.github.com/";

/// `location`, when it stays on the API; a redirect anywhere else is refused.
fn same_api(location: &str) -> Option<&str> {
    location.starts_with(API).then_some(location)
}

#[derive(Deserialize)]
struct RawPull {
    number: u64,
    title: String,
    html_url: String,
    state: String,
    #[serde(default)]
    draft: bool,
    merged_at: Option<String>,
    head: RawHead,
}

#[derive(Deserialize)]
struct RawHead {
    sha: String,
}

#[derive(Deserialize)]
struct RawCheckRuns {
    check_runs: Vec<RawCheckRun>,
}

#[derive(Deserialize)]
struct RawCheckRun {
    status: String,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
struct RawStatus {
    statuses: Vec<RawCommitStatus>,
}

#[derive(Deserialize)]
struct RawCommitStatus {
    state: String,
}

#[cfg(test)]
#[path = "github_api_tests.rs"]
mod tests;
