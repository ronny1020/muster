//! The shapes here were taken from a real transcript on this machine, not
//! invented: a 3,445-line record held 433 `user` entries of which 32 were
//! typed prompts, and the rest were tool results and command expansions.

use std::io::Read;

use super::{open_tail, read_turns, MAX_BYTES, MAX_TURNS};

fn turns(lines: &[&str]) -> Vec<super::Turn> {
    read_turns(lines.join("\n").as_bytes())
}

#[test]
fn a_typed_prompt_becomes_a_message() {
    let found = turns(&[
        r#"{"type":"user","promptSource":"typed","timestamp":"2026-09-18T03:50:24Z","message":{"content":"check the click function"}}"#,
    ]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, "message");
    assert_eq!(found[0].label, "check the click function");
    assert_eq!(found[0].at, "2026-09-18T03:50:24Z");
}

/// Most `user` entries are not prompts — 16,072 of this machine's carry no
/// source at all (tool results, compaction summaries, paste captions) and 354
/// are `system` task notifications. Taking them all would put every one of
/// those on the rail as something you "said".
#[test]
fn a_user_entry_that_was_not_written_by_hand_is_not_a_message() {
    let found = turns(&[
        r#"{"type":"user","message":{"content":"<tool_result>ok</tool_result>"}}"#,
        r#"{"type":"user","promptSource":"system","message":{"content":"a notification"}}"#,
    ]);
    assert!(found.is_empty());
}

#[test]
fn a_message_sent_as_content_blocks_reads_the_text_ones() {
    let found = turns(&[
        r#"{"type":"user","promptSource":"typed","message":{"content":[{"type":"image"},{"type":"text","text":"first"},{"type":"text","text":"second"}]}}"#,
    ]);
    assert_eq!(found[0].text, "first\nsecond");
    assert_eq!(found[0].label, "first");
}

#[test]
fn a_tool_call_names_the_file_it_touched() {
    let found = turns(&[
        r#"{"type":"assistant","timestamp":"t","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/work/repo/src/App.tsx"}}]}}"#,
    ]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].kind, "file");
    assert_eq!(found[0].path, "/work/repo/src/App.tsx");
    assert_eq!(found[0].label, "App.tsx");
}

/// A tool call with no path at all is most of them — Bash, Task, WebFetch.
#[test]
fn a_tool_call_with_no_path_contributes_nothing() {
    let found = turns(&[
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
    ]);
    assert!(found.is_empty());
}

/// A subagent's conversation is the agent's own working, not the session the
/// person is reading.
#[test]
fn a_sidechain_turn_is_left_out() {
    let found = turns(&[
        r#"{"type":"user","isSidechain":true,"promptSource":"typed","message":{"content":"inside a subagent"}}"#,
    ]);
    assert!(found.is_empty());
}

/// This is another program's private file. A release that changes it, or a
/// half-written last line, must cost a turn rather than the whole rail.
#[test]
fn a_line_that_is_not_json_is_skipped_rather_than_fatal() {
    let found = turns(&[
        "not json at all",
        r#"{"type":"user","promptSource":"typed","message":{"content":"still read"}}"#,
        r#"{"type":"user","promptSource":"typed","message":{"conte"#,
    ]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].label, "still read");
}

#[test]
fn an_empty_transcript_is_no_turns_rather_than_an_error() {
    assert!(turns(&[]).is_empty());
}

/// The rail draws one line, so a pasted essay must not become the label.
#[test]
fn a_label_is_the_first_line_that_has_anything_on_it() {
    let found = turns(&[
        r#"{"type":"user","promptSource":"typed","message":{"content":"\n\n  the point  \nthe detail"}}"#,
    ]);
    assert_eq!(found[0].label, "the point");
    assert!(found[0].text.starts_with("the point"));
}

/// A prompt submitted while the agent was still working is still a prompt.
/// Measured on this machine: 38 of them, reading like `btw, check out branch
/// first` — exactly what someone looks for on the rail afterwards.
#[test]
fn a_queued_prompt_is_a_message_too() {
    let found = turns(&[
        r#"{"type":"user","promptSource":"queued","message":{"content":"btw, check out branch first"}}"#,
    ]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].label, "btw, check out branch first");
}

/// Accepting an offered action is not writing one. The text may be the CLI's
/// own wording, and a rail that quotes it back as yours is worse than one
/// that leaves it out.
#[test]
fn an_accepted_suggestion_is_not_a_message() {
    let found = turns(&[
        r#"{"type":"user","promptSource":"suggestion_accepted","message":{"content":"push it"}}"#,
    ]);
    assert!(found.is_empty());
}

/// The tools that take a bare `path` point it at a directory, which is a dot
/// on a rail of files whose click opens nothing.
#[test]
fn a_directory_argument_is_not_a_file() {
    let found = turns(&[
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Glob","input":{"path":"/work/repo/src","pattern":"*.ts"}}]}}"#,
    ]);
    assert!(found.is_empty());
}

/// The file is append-only and oldest first, so what a bound keeps has to be
/// the end. Keeping the start shows a stale turn as the newest one.
#[test]
fn a_long_record_keeps_its_newest_turns() {
    let lines: Vec<String> = (0..MAX_TURNS + 40)
        .map(|i| {
            format!(
                r#"{{"type":"user","promptSource":"typed","message":{{"content":"message number {i}"}}}}"#
            )
        })
        .collect();
    let found = read_turns(lines.join("\n").as_bytes());
    assert_eq!(found.len(), MAX_TURNS);
    assert_eq!(
        found.last().map(|turn| turn.label.as_str()),
        Some(format!("message number {}", MAX_TURNS + 39).as_str())
    );
}

/// A directory of this test's own, so the file cases below cannot see each
/// other's leftovers.
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("muster-transcript-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch directory");
    dir
}

fn read_all(reader: impl Read) -> String {
    let mut text = String::new();
    let mut reader = reader;
    reader.read_to_string(&mut text).expect("readable");
    text
}

#[test]
fn a_transcript_that_fits_is_read_whole() {
    let dir = scratch("whole");
    let path = dir.join("session.jsonl");
    std::fs::write(&path, "one\ntwo\n").expect("written");
    assert_eq!(read_all(open_tail(&path).expect("opened")), "one\ntwo\n");
}

#[test]
fn a_symlinked_transcript_is_refused_rather_than_followed() {
    // The read happens on a status edge with no click behind it, so a link
    // planted where a transcript belongs must not become a read of whatever
    // it points at.
    let dir = scratch("link");
    let real = dir.join("secret");
    std::fs::write(&real, "{}\n").expect("written");
    let link = dir.join("session.jsonl");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real, &link).expect("linked");
    #[cfg(windows)]
    if std::os::windows::fs::symlink_file(&real, &link).is_err() {
        return; // Unprivileged Windows cannot create one; nothing to test.
    }
    assert!(open_tail(&link).is_none());
}

#[test]
fn an_oversized_transcript_is_read_from_the_end_at_a_line_boundary() {
    // The bound has to leave a whole line: a `BufReader` advances the file by
    // its own fill rather than by the line it returned, so a window that is
    // not wound back starts kilobytes late and loses turns, not a fragment.
    let dir = scratch("tail");
    let path = dir.join("session.jsonl");
    let filler = "x".repeat(4_095);
    let mut body = String::new();
    while body.len() < (MAX_BYTES as usize) + 4_096 {
        body.push_str(&filler);
        body.push('\n');
    }
    body.push_str("last\n");
    std::fs::write(&path, &body).expect("written");

    let read = read_all(open_tail(&path).expect("opened"));
    assert!(read.len() as u64 <= MAX_BYTES, "the cap holds");
    assert!(
        read.ends_with("last\n"),
        "the end of the file is what is kept"
    );
    assert!(
        read.starts_with(&filler),
        "the window opens on a whole line, not mid-one"
    );
}

#[test]
fn a_tool_heavy_turn_cannot_push_your_messages_out_of_the_window() {
    // One agent turn can name hundreds of files. Capping the mixed list would
    // let those evict every message, and the rail reads messages only — so a
    // clickable tab would lose its dots after a long turn.
    let mut lines = vec![String::from(
        r#"{"type":"user","promptSource":"typed","message":{"content":"the first thing i asked"}}"#,
    )];
    for index in 0..(MAX_TURNS * 3) {
        lines.push(format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","input":{{"file_path":"/tmp/f{index}.rs"}}}}]}}}}"#
        ));
    }
    let found = turns(&lines.iter().map(String::as_str).collect::<Vec<_>>());
    let messages: Vec<_> = found.iter().filter(|turn| turn.kind == "message").collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].label, "the first thing i asked");
    assert_eq!(
        found.iter().filter(|turn| turn.kind == "file").count(),
        MAX_TURNS
    );
}

/// A transcript is another program's file, and an agent picks what it writes
/// there. A path is the one field with no cap of its own — the message caps
/// do not cover it — so an absurd one is skipped rather than carried into the
/// UI and across the IPC bridge.
#[test]
fn a_file_turn_naming_an_absurd_path_is_skipped() {
    let huge = "/".to_string() + &"a".repeat(super::MAX_PATH);
    let line = format!(
        r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","input":{{"file_path":"{huge}"}}}}]}}}}"#
    );
    assert!(turns(&[&line]).is_empty(), "no turn carries it");

    let fine = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"file_path":"/tmp/real.rs"}}]}}"#;
    assert_eq!(turns(&[fine]).len(), 1, "an ordinary path still counts");
}
