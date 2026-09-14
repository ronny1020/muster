//! Whether an agent has anything to continue in a given directory.
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

use std::path::Path;

use crate::platform;

/// How many recorded sessions an agent has for `cwd`, or `None` when the
/// agent's session store is unknown to us.
#[tauri::command]
pub async fn agent_sessions(agent_id: String, cwd: String) -> Option<u32> {
    tauri::async_runtime::spawn_blocking(move || count_sessions(&agent_id, &cwd))
        .await
        .ok()?
}

fn count_sessions(agent_id: &str, cwd: &str) -> Option<u32> {
    match agent_id {
        "claude" => Some(claude_sessions(cwd)),
        // Codex keeps sessions under `$CODEX_HOME`, and Antigravity under its
        // own directory, but neither layout is verified here — so say nothing
        // rather than guess and hide a working mode.
        _ => None,
    }
}

/// Claude Code files each project under `~/.claude/projects`, named after the
/// directory with its separators flattened, and one `.jsonl` per session.
fn claude_sessions(cwd: &str) -> u32 {
    let Some(home) = platform::home() else {
        return 0;
    };
    let projects = Path::new(&home).join(".claude").join("projects");
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return 0;
    };

    // The launcher shows and sends tilde paths, and the store's own names are
    // absolute — so without expanding first the match always fails and the
    // mode is disabled on a directory that does have history.
    let wanted = normalize_key(&crate::workspace::expand_home(cwd));
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if normalize_key(&name) == wanted {
            return count_transcripts(&entry.path());
        }
    }
    0
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
    // Refused rather than trusted: it is written by another program and ends up
    // in an argv, so it may only be the shape an id actually is.
    let usable = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    usable.then(|| id.to_string())
}
