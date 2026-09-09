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
mod tests {
    use super::*;

    #[test]
    fn a_tilde_path_matches_the_store_the_same_as_its_absolute_form() {
        let home = platform::home().unwrap();
        // The failure this guards against disabled Continue on real history.
        assert_eq!(
            count_sessions("claude", &format!("{home}/muster-no-such-dir")),
            count_sessions("claude", "~/muster-no-such-dir"),
        );
    }

    #[test]
    fn a_path_and_its_flattened_store_name_agree() {
        assert_eq!(
            normalize_key("/Users/ada/Documents/temp/ai-terminal"),
            normalize_key("-Users-ada-Documents-temp-ai-terminal"),
        );
    }

    #[test]
    fn punctuation_in_a_directory_name_does_not_break_the_match() {
        // The store's substitution rule is unknown, so a dot must compare equal
        // to whatever it was replaced with.
        assert_eq!(
            normalize_key("/work/my.project"),
            normalize_key("-work-my-project")
        );
        assert_eq!(
            normalize_key("/work/my_project"),
            normalize_key("-work-my-project")
        );
    }

    #[test]
    fn different_directories_do_not_collide() {
        assert_ne!(normalize_key("/work/one"), normalize_key("/work/two"));
        assert_ne!(normalize_key("/a/b"), normalize_key("/a/b/c"));
    }

    #[test]
    fn repeated_and_trailing_separators_are_ignored() {
        assert_eq!(normalize_key("/work//repo/"), normalize_key("/work/repo"));
    }

    #[test]
    fn an_unknown_agent_reports_nothing_rather_than_zero() {
        // Zero would hide Continue; None leaves it to the CLI to decide.
        assert_eq!(count_sessions("codex", "/work"), None);
        assert_eq!(count_sessions("antigravity", "/work"), None);
        assert_eq!(count_sessions("shell", "/work"), None);
    }

    #[test]
    fn claude_always_answers_with_a_count() {
        assert!(count_sessions("claude", "/definitely/not/here").is_some());
        assert_eq!(count_sessions("claude", "/definitely/not/here"), Some(0));
    }

    #[test]
    fn finds_this_repos_own_claude_sessions_if_any_exist() {
        // Whether this machine has history is its business; that the lookup
        // runs and answers is ours.
        let count = count_sessions("claude", env!("CARGO_MANIFEST_DIR"));
        assert!(count.is_some());
    }

    #[test]
    fn counts_only_transcript_files() {
        let dir = std::env::temp_dir().join(format!("muster-sessions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("a.jsonl"), b"{}").expect("write");
        std::fs::write(dir.join("b.jsonl"), b"{}").expect("write");
        std::fs::write(dir.join("notes.txt"), b"x").expect("write");

        let counted = count_transcripts(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(counted, 2);
    }
}
