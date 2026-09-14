//! Naming and expiry for pasted attachments. The name is what decides how an
//! agent's file tool reads the contents, and the expiry is what stops a
//! directory of everything ever pasted accumulating forever.

use super::*;

fn at(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}

#[test]
fn a_pasted_patch_is_named_as_one() {
    // The extension is the only thing telling a file tool this is a diff
    // rather than prose, and a diff read as prose loses its highlighting.
    assert!(attachment_name(at(1), "diff --git a/x b/x\n").ends_with(".patch"));
    assert!(attachment_name(at(1), "--- a/x\n+++ b/x\n").ends_with(".patch"));
}

#[test]
fn pasted_json_is_named_as_json_even_when_it_is_indented() {
    assert!(attachment_name(at(1), "  {\"a\": 1}").ends_with(".json"));
    assert!(attachment_name(at(1), "\n[1, 2]").ends_with(".json"));
}

#[test]
fn anything_else_is_plain_text() {
    assert!(attachment_name(at(1), "a stack trace\n  at main").ends_with(".txt"));
    // A brace somewhere in the middle does not make a log into JSON.
    assert!(attachment_name(at(1), "error: {oops}").ends_with(".txt"));
}

#[test]
fn two_pastes_in_the_same_second_do_not_share_a_name() {
    // Named to the millisecond, because a paste followed immediately by
    // another would otherwise overwrite the first and hand the agent one path
    // for two different things.
    let first = attachment_name(at(1), "a");
    let later = attachment_name(at(1) + Duration::from_millis(1), "a");
    assert_ne!(first, later);
}

#[test]
fn the_name_is_a_bare_filename() {
    // It is joined onto a directory, so anything with a separator in it would
    // write outside the attachments folder.
    for text in ["../../etc/passwd", "{\"../x\": 1}", "diff --git a/../x b/x"] {
        let name = attachment_name(at(1), text);
        assert!(!name.contains('/'), "{name} carries a separator");
        assert!(!name.contains('\\'), "{name} carries a separator");
    }
}

#[test]
fn the_sweep_drops_old_attachments_and_keeps_new_ones() {
    let dir = std::env::temp_dir().join(format!(
        "muster-attach-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch");

    let old = dir.join("paste-1.txt");
    let fresh = dir.join("paste-2.txt");
    fs::write(&old, b"gone").expect("write");
    fs::write(&fresh, b"kept").expect("write");
    fs::File::options()
        .write(true)
        .open(&old)
        .expect("open")
        .set_modified(SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30))
        .expect("backdate");

    sweep(&dir, Duration::from_secs(60 * 60 * 24 * 14));

    assert!(!old.exists(), "a month-old attachment survived");
    assert!(fresh.exists(), "today's attachment was swept");
}
