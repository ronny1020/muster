//! What an agent has to continue in a given directory — how much, and which.
//!
//! `claude --continue` in a directory with no history prints
//! `No conversation found to continue` and exits, which reads as a broken app
//! rather than an empty one. Knowing beforehand lets the launcher offer only
//! the modes that can work.
//!
//! The answer is deliberately three-valued. `None` means *this agent's store
//! is not one we know how to read* — and an unknown store must leave the mode
//! enabled, because refusing a launch that would have worked is the worse
//! failure of the two.
//!
//! Listing the conversations themselves is the other half, and it answers
//! two-valued on purpose: an empty list costs the start screen nothing but the
//! CLI's own picker. `agent_session_list` has why.

use std::path::{Path, PathBuf};

use crate::platform;

/// How many recorded sessions an agent has for `cwd`, or `None` when we cannot
/// say.
///
/// The difference between `None` and `Some(0)` is load-bearing, because a
/// caller hides a control on a zero: the ⟳ that reprints a conversation after
/// a resize, and the mode switch. A zero must therefore mean "the store was
/// read and holds nothing for this directory", never "the store could not be
/// found" — the second reported as the first takes the only repair for a
/// resize away from a tab whose conversation is right there.
#[tauri::command]
pub async fn agent_sessions(agent_id: String, cwd: String, backend: String) -> Option<u32> {
    tauri::async_runtime::spawn_blocking(move || count_sessions(&agent_id, &cwd, &backend))
        .await
        .ok()?
}

fn count_sessions(agent_id: &str, cwd: &str, backend: &str) -> Option<u32> {
    // A session in a WSL distro writes its store inside that distro, while
    // `platform::home()` is this process's own — so every key misses and the
    // honest answer is that we cannot see it, not that it is empty.
    if backend != "native" {
        return None;
    }
    match agent_id {
        "claude" => claude_sessions(cwd),
        // Codex keeps sessions under `$CODEX_HOME`, and Antigravity under its
        // own directory, but neither layout is verified here — so say nothing
        // rather than guess and hide a working mode.
        _ => None,
    }
}

/// Claude Code files each project under `~/.claude/projects`, named after the
/// directory with its separators flattened, and one `.jsonl` per session.
///
/// `None` where that root cannot be read at all — no home, no `.claude`, or a
/// permission the app does not have.
fn claude_sessions(cwd: &str) -> Option<u32> {
    let projects = projects_root()?;
    // Read once here rather than leaning on `claude_project_dir`, which cannot
    // tell a root it could not open from one that held no match.
    std::fs::read_dir(&projects).ok()?;
    Some(
        claude_project_dir(cwd)
            .map(|dir| count_transcripts(&dir))
            .unwrap_or(0),
    )
}

/// `~/.claude/projects`, where Claude Code files every project.
fn projects_root() -> Option<PathBuf> {
    Some(
        Path::new(&platform::home()?)
            .join(".claude")
            .join("projects"),
    )
}

/// Where Claude Code keeps this directory's transcripts, if it has any.
pub fn claude_project_dir(cwd: &str) -> Option<PathBuf> {
    let projects = projects_root()?;
    let wanted = store_keys(cwd);
    // Ordered by key rather than by whatever `read_dir` yields first: both
    // spellings can exist as directories — a store written before the CLI
    // canonicalised, or a path reachable two ways — and the listing order is
    // the filesystem's, so without this the tab can be handed the folder that
    // does not hold its ids and the rail falls silently empty.
    let entries: Vec<_> = std::fs::read_dir(projects).ok()?.flatten().collect();
    wanted.iter().find_map(|key| {
        entries.iter().find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if &normalize_key(&name) != key {
                return None;
            }
            // A project directory that is itself a link points the reads below
            // it anywhere: this one happens on a status edge with no click, so
            // it is refused the same way `read_capped` refuses one. `~/.claude`
            // above it may legitimately be a link — that is the user's own
            // home, not something an agent chose.
            let path = entry.path();
            std::fs::symlink_metadata(&path)
                .ok()
                .filter(|info| info.is_dir())
                .map(|_| path)
        })
    })
}

/// Every spelling of `cwd` the store might have filed this directory under.
///
/// Two, because two things can differ. The launcher shows and sends tilde
/// paths while the store's names are absolute, so the expansion is what stops
/// the match failing on a directory that does have history. And the CLI files
/// a project under the path its own process resolved to, which is not the one
/// the user typed whenever a link stands between them — on macOS `/tmp` is a
/// symlink to `/private/tmp`, so a tab opened at `/tmp/x` found nothing at all
/// and the launcher offered no Continue for a conversation that was there.
///
/// Both are kept rather than only the resolved one: resolving needs the
/// directory to exist, and a record outlives the directory it was made in.
fn store_keys(cwd: &str) -> Vec<String> {
    let expanded = crate::workspace::expand_home(cwd);
    let resolved = std::fs::canonicalize(&expanded)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| expanded.clone());
    let mut keys = vec![normalize_key(&expanded)];
    let resolved = normalize_key(&resolved);
    if !keys.contains(&resolved) {
        keys.push(resolved);
    }
    keys
}

/// How many past conversations one directory offers.
///
/// Newest first, so what the bound drops is what is least likely to be
/// wanted — and each one listed costs a bounded read of its transcript's head
/// for the line beside it.
const MAX_LISTED: usize = 30;

/// What a directory's store holds, and whether the bound hid any of it.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSessions {
    /// Newest first, and at most `MAX_LISTED` of them.
    pub listed: Vec<PastSession>,
    /// Whether the store holds conversations this list does not carry.
    ///
    /// Answered here rather than by comparing the list against the count
    /// beside it: the two apply different rules to the same directory — the
    /// count asks only for the extension — so a store with one odd entry in it
    /// would report more history than it has. Only the listing knows what it
    /// dropped.
    pub more: bool,
}

/// One past conversation, as a list offers it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSession {
    /// The agent's own id for the conversation, which is what `--resume`
    /// takes.
    pub id: String,
    /// Seconds since the epoch, from the transcript's mtime — when the
    /// conversation was last written to.
    pub at: u64,
    /// The first thing the person typed in it; empty when the transcript
    /// holds none.
    pub summary: String,
}

/// The conversations an agent's own store holds for `cwd`, newest first.
///
/// Empty wherever the store cannot be read — another agent, a WSL session, a
/// directory with no history — because the caller's answer to an empty list is
/// to launch the CLI's own picker, which is what every agent had before this
/// existed. That makes the emptiness harmless in a way `agent_sessions`'
/// cannot afford, so this one is not three-valued.
#[tauri::command]
pub async fn agent_session_list(agent_id: String, cwd: String, backend: String) -> PastSessions {
    tauri::async_runtime::spawn_blocking(move || list_sessions(&agent_id, &cwd, &backend))
        .await
        .unwrap_or_default()
}

fn list_sessions(agent_id: &str, cwd: &str, backend: &str) -> PastSessions {
    // Same two limits as the count above: only Claude Code's layout is
    // verified, and a distro's store is not this process's to read.
    if backend != "native" || agent_id != "claude" {
        return PastSessions::default();
    }
    claude_project_dir(cwd)
        .map(|dir| listed_in(&dir))
        .unwrap_or_default()
}

/// Every conversation one project directory holds, newest first and bounded.
///
/// Ordered on the mtime itself rather than on the second it falls in: two
/// sessions written within the same second still have an order, and it is the
/// one the bound below drops from.
fn listed_in(dir: &Path) -> PastSessions {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return PastSessions::default();
    };
    let mut found: Vec<(std::time::SystemTime, PathBuf, String)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()? != "jsonl" {
                return None;
            }
            let id = path.file_stem()?.to_string_lossy().into_owned();
            // The file name is another program's, and it becomes
            // `--resume <id>` in a real argv.
            if !is_session_id(&id) {
                return None;
            }
            // A directory or a symlink can carry the same name, and neither
            // is a conversation: `opening_message` refuses to read one, so
            // the row would offer a resume with nothing behind it.
            let info = entry.metadata().ok()?;
            if !info.is_file() {
                return None;
            }
            Some((info.modified().ok()?, path, id))
        })
        .collect();
    found.sort_by_key(|(at, ..)| std::cmp::Reverse(*at));
    let more = found.len() > MAX_LISTED;
    found.truncate(MAX_LISTED);
    PastSessions {
        // Read after the bound, never before: the summary is the expensive part.
        listed: found
            .into_iter()
            .map(|(at, path, id)| PastSession {
                summary: crate::transcript::opening_message(&path),
                at: crate::journal::seconds_since_epoch(at),
                id,
            })
            .collect(),
        more,
    }
}

fn count_transcripts(dir: &Path) -> u32 {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
                .count() as u32
        })
        .unwrap_or(0)
}

/// A directory path and the store's name for it, reduced to one spelling.
///
/// Matching this way rather than reproducing the encoding means the exact
/// substitution rule does not have to be known — only that it maps every
/// separator and punctuation mark to the same thing.
pub fn normalize_key(value: &str) -> String {
    let flattened: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // Repeated and edge separators carry no information either way.
    flattened
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;

/// The agent's own session id for a running child, where the CLI publishes one.
///
/// Claude Code keeps a live registry at `~/.claude/sessions/<pid>.json` and
/// writes it shortly after starting, which is why the caller polls rather than
/// asking once. This is the only id that can resume *that* conversation — our
/// own journal is keyed on the tab, which outlives any one session.
pub fn published_session_id(agent_id: &str, pid: u32) -> Option<String> {
    if agent_id != "claude" {
        return None;
    }
    let home = platform::home()?;
    let path = Path::new(&home)
        .join(".claude")
        .join("sessions")
        .join(format!("{pid}.json"));
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = value.get("sessionId")?.as_str()?;
    is_session_id(id).then(|| id.to_string())
}

/// Windows resolves these to devices whatever directory or extension they are
/// spelled with, so `CON.jsonl` opens the console rather than a file.
const DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Whether a value another program published is the shape a session id is.
///
/// Refused rather than trusted, because it arrives from a file anyone can
/// write and reaches two places that both take it literally: an **argv**, and
/// a **path** joined under `~/.claude/projects`.
///
/// The leading `-` is the one that matters most, and the alphabet alone does
/// not catch it: `--dangerously-skip-permissions` is thirty characters of
/// ASCII letters and hyphens, so an agent that published it as its own session
/// id would have the journal's Resume button spawn
/// `claude --resume --dangerously-skip-permissions` — a flag in front of a
/// program nobody typed, which SECURITY.md names as out of bounds.
///
/// The device names are the path half, and they matter on Windows only: the
/// alphabet already excludes `.`, `/`, `\` and `:`, so `..`, an absolute path
/// and an alternate data stream cannot be spelled at all.
pub fn is_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !DEVICE_NAMES.contains(&id.to_ascii_uppercase().as_str())
}
