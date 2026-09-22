//! What a session did, read from the agent's own transcript rather than from
//! the terminal.
//!
//! A clickable session lives in the alternate buffer — see `SCROLLBACK_ENV` in
//! `pty.rs` — which is `rows` tall and keeps no history, so every surface that
//! scans the scrollback has nothing to read there. The agent has kept a record
//! of the same conversation all along, and it is the better source anyway: the
//! turns are structured rather than inferred from a tint, they carry their own
//! text, and they survive a `--continue` that the scan cannot see.
//!
//! Claude Code alone is read here. Its file is one JSON object per line under
//! `~/.claude/projects/<directory>/<session>.jsonl`, and the fields taken are
//! the few that are stable across releases. Anything unexpected is skipped
//! rather than failing the read: this is another program's private file, and a
//! rail with a turn missing beats a pane with an error in it.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

use serde_json::Value;
use tauri::AppHandle;

/// How much of a transcript one read covers — the **tail**, never the head.
///
/// The file is append-only and oldest first, so a bound taken from the front
/// keeps the beginning of a long session and silently drops the end. Measured
/// on a 23,796-line record: reading the first 20,000 lines found 105 turns
/// whose newest was three hours stale, against 120 for the whole file. Since
/// the rail then shows the newest dozen of whatever it is handed, that is not
/// a truncation — it is the wrong answer, presented as current.
///
/// Bounded in bytes rather than lines because one line can carry a pasted
/// attachment, so a line count says nothing about the work.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// How many turns of each kind are kept, newest last. The rail shows a
/// dozen; the rest is the bound on what a long record can build. `read_turns`
/// applies it between lines as well as at the end, so a long file costs one
/// window rather than all of it — within a line it does not apply, and one
/// line is bounded only by `MAX_BYTES`.
const MAX_TURNS: usize = 200;

/// How much of a turn is kept. The rail shows its first line; this is the
/// bound on what crosses IPC, since the text is the CLI's own JSON rather
/// than something a terminal cell has already filtered.
///
/// A path gets its own bound below: the two are different kinds of value, and
/// only one of them has a length the host itself limits.
const MAX_TEXT: usize = 4_000;

/// Longest path a turn may name.
///
/// Every host stops well short of this — 1024 bytes on macOS, 4096 on Linux —
/// so a longer value is not a path that was ever opened but a string an agent
/// chose to write, and skipping it loses nothing real. Without it the message
/// caps above were the only ones, and SECURITY.md's claim that what a turn
/// carries is bounded held for the text and not for the file.
const MAX_PATH: usize = 4096;

/// One thing worth marking beside a session.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// `message` for something the user sent, `file` for one the agent
    /// touched.
    pub kind: String,
    /// What the rail shows: the first line of a message, or the file's name.
    pub label: String,
    /// The whole turn, where a label's one line is not enough. Empty for a
    /// file.
    pub text: String,
    /// Absolute path, for a file. Empty for a message.
    pub path: String,
    /// The agent's own timestamp, as it wrote it.
    pub at: String,
}

/// The turns of the conversation a tab is running, oldest first.
///
/// Empty whenever anything is missing — no record, no published id, no
/// transcript, another agent — because every caller's answer to "no turns" is
/// to fall back to reading the terminal.
#[tauri::command]
pub async fn agent_turns(app: AppHandle, cwd: String, id: String) -> Vec<Turn> {
    tauri::async_runtime::spawn_blocking(move || turns_for(&app, &cwd, &id))
        .await
        .unwrap_or_default()
}

fn turns_for(app: &AppHandle, cwd: &str, tab_id: &str) -> Vec<Turn> {
    let Some(dir) = crate::sessions::claude_project_dir(cwd) else {
        return Vec::new();
    };
    // Newest id first, and on to the next when one names no file — see
    // `session_ids_for` for why a published id is not a promise of one.
    crate::journal::session_ids_for(app, cwd, tab_id)
        .into_iter()
        .find_map(|session_id| open_tail(&dir.join(format!("{session_id}.jsonl"))))
        .map(read_turns)
        .unwrap_or_default()
}

/// The last `MAX_BYTES` of a transcript, from a line boundary, or `None`.
///
/// Refuses a symlink, and hands back a reader that cannot outrun the cap —
/// both because this read happens on its own, with no click behind it. The
/// app's other automatic reads are bounded for the same reason (see
/// AGENTS.md); a `.jsonl` that is a link to `/dev/zero`, or one very long
/// line, would otherwise grow without limit inside a blocking task.
///
/// A seek lands mid-line and half an object parses as nothing, so the partial
/// first line is dropped — one turn at the far end of the window rather than
/// a garbled one.
///
/// The reader that finds that line break is wound back to it before the file
/// is handed on. A `BufReader` advances the descriptor by a whole fill rather
/// than by the line it returned, and discards the rest when it drops, so
/// leaving the position where it lands skips several turns instead of one
/// fragment.
fn open_tail(path: &std::path::Path) -> Option<impl Read> {
    let info = std::fs::symlink_metadata(path).ok()?;
    if !info.is_file() {
        return None;
    }
    // Opened without following, so the refusal above cannot be raced: an
    // agent can replace its own transcript with a link between the check and
    // the open, and this read happens on a status edge with no click behind
    // it. Same call, and the same reason, as `read_capped`.
    let mut file = crate::review::open_without_following(path).ok()?;
    if info.len() > MAX_BYTES {
        file.seek(SeekFrom::End(-(MAX_BYTES as i64))).ok()?;
        let mut reader = BufReader::new(&mut file);
        let mut partial = Vec::new();
        reader.read_until(b'\n', &mut partial).ok()?;
        let unread = reader.buffer().len() as i64;
        drop(reader);
        file.seek(SeekFrom::Current(-unread)).ok()?;
    }
    Some(file.take(MAX_BYTES))
}

/// Parses a transcript into turns. Split from the file handling so a test can
/// hand it the shapes a release has actually produced.
///
/// Decoded in one bounded read rather than line by line, and lossily: an
/// iterator over `lines()` ends at the first `Err`, which would cost every
/// later turn where this module promises to lose only the line. The caller's
/// cap is what makes reading it whole safe.
pub fn read_turns<R: Read>(mut reader: R) -> Vec<Turn> {
    let mut raw = Vec::new();
    if reader.read_to_end(&mut raw).is_err() && raw.is_empty() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&raw);
    let mut turns: Vec<Turn> = Vec::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // A sidechain is a subagent's own conversation, which belongs to the
        // agent rather than to the person reading the rail.
        if entry["isSidechain"].as_bool().unwrap_or(false) {
            continue;
        }
        let at = entry["timestamp"].as_str().unwrap_or_default().to_string();
        match entry["type"].as_str() {
            Some("user") => {
                if let Some(text) = user_text(&entry) {
                    turns.push(Turn {
                        kind: "message".into(),
                        label: first_line(&text),
                        text,
                        path: String::new(),
                        at,
                    });
                }
            }
            Some("assistant") => {
                for path in touched_paths(&entry) {
                    turns.push(Turn {
                        kind: "file".into(),
                        label: tail_of(&path),
                        text: String::new(),
                        path,
                        at: at.clone(),
                    });
                }
            }
            _ => {}
        }
        // Trimmed as it goes rather than at the end, so a long record costs
        // one window of turns rather than all of them.
        if turns.len() > MAX_TURNS * 4 {
            keep_newest(&mut turns);
        }
    }
    keep_newest(&mut turns);
    turns
}

/// Drops all but the newest `MAX_TURNS` of **each kind**, oldest first.
///
/// Per kind because one cap over the mixed list is a cap the kinds compete
/// for: a single agent turn can name hundreds of files, and those would then
/// push every message you typed out of a window the rail reads only messages
/// from — leaving a clickable tab with no dots after a tool-heavy turn.
fn keep_newest(turns: &mut Vec<Turn>) {
    let over = |kind: &str| {
        turns
            .iter()
            .filter(|turn| turn.kind == kind)
            .count()
            .saturating_sub(MAX_TURNS)
    };
    let (mut messages, mut files) = (over("message"), over("file"));
    if messages == 0 && files == 0 {
        return;
    }
    turns.retain(|turn| {
        let budget = if turn.kind == "message" {
            &mut messages
        } else {
            &mut files
        };
        if *budget == 0 {
            return true;
        }
        *budget -= 1;
        false
    });
}

/// Sources of a `user` entry that are a person writing free text.
///
/// Most `user` entries are not: measured across this machine's transcripts,
/// 16,072 carry no source at all (tool results, compaction summaries, paste
/// captions) and 354 are `system` (task notifications). `typed` is the plain
/// case and `queued` is the same thing submitted while the agent was still
/// working — 38 of those here, reading `btw, check out branch first` and
/// `update pr body`, which is exactly what the rail is for.
///
/// `suggestion_accepted` is deliberately left out. Those 36 entries are the
/// user choosing an offered action rather than writing, so the text may be
/// the CLI's own wording; a rail that claims you said something you picked
/// from a list is worse than one that misses it.
const WRITTEN_BY_HAND: &[&str] = &["typed", "queued"];

/// What the person typed, or `None` for a turn they did not write.
///
/// Gated on `promptSource` because that is the CLI's own distinction — a
/// heuristic over the text would have to guess again on every release.
fn user_text(entry: &Value) -> Option<String> {
    if !WRITTEN_BY_HAND.contains(&entry["promptSource"].as_str()?) {
        return None;
    }
    let content = &entry["message"]["content"];
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.chars().take(MAX_TEXT).collect())
}

/// Every file an assistant turn named through a tool call.
///
/// Read from the call's own arguments rather than from what was printed: the
/// rendered line is elided when it is too long for the column, and a path torn
/// by a cursor move is exactly what the scrollback scan has to work around.
fn touched_paths(entry: &Value) -> Vec<String> {
    let Some(blocks) = entry["message"]["content"].as_array() else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|block| block["type"] == "tool_use")
        .filter_map(|block| {
            let input = &block["input"];
            // Not a bare `path`: the tools that take one — a glob, a search —
            // point it at a **directory**, and a directory on a rail of files
            // is a dot whose click opens nothing.
            ["file_path", "notebook_path"]
                .iter()
                .find_map(|key| input[key].as_str())
                .map(str::to_string)
        })
        .filter(|path| !path.is_empty() && path.len() <= MAX_PATH)
        .collect()
}

/// How much of a label is kept, for every kind of turn.
const MAX_LABEL: usize = 120;

fn first_line(text: &str) -> String {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_LABEL)
        .collect()
}

/// The name at the end of a path, cut to the bound every other label carries.
///
/// A path has no separator in it by necessity, so without the cut a label
/// could run to `MAX_PATH` where a message's runs to 120 — one field breaking
/// the promise the rest of them keep.
fn tail_of(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .chars()
        .take(MAX_LABEL)
        .collect()
}

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
