use super::*;

const LIMIT: Duration = Duration::from_secs(5);

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

#[test]
fn a_stall_is_reported_once_and_its_end_with_the_longest_silence() {
    let mut stall = Stall::default();
    assert_eq!(stall.observe(secs(1), LIMIT), None);
    assert_eq!(
        stall.observe(secs(6), LIMIT),
        Some(Change::Stalled(secs(6)))
    );
    assert_eq!(stall.observe(secs(30), LIMIT), None);
    assert_eq!(
        stall.observe(secs(0), LIMIT),
        Some(Change::Recovered(secs(30)))
    );
    assert_eq!(stall.observe(secs(0), LIMIT), None);
}

#[test]
fn silence_at_the_limit_is_not_a_stall() {
    let mut stall = Stall::default();
    assert_eq!(stall.observe(LIMIT, LIMIT), None);
}

#[test]
fn a_window_that_regains_focus_is_forgiven_its_throttled_silence() {
    let watchdog = Watchdog::default();
    let long_ago = Instant::now() - secs(60);
    watchdog.beats.lock().insert("main".into(), long_ago);
    watchdog.focus("main", true);
    let watched = watchdog.focused_silence(Instant::now()).unwrap();
    assert_eq!(watched.label, "main");
    assert!(watched.silence < secs(1));
}

#[test]
fn an_unfocused_app_has_no_page_to_judge() {
    let watchdog = Watchdog::default();
    watchdog.focus("main", true);
    watchdog.focus("main", false);
    assert!(watchdog.focused_silence(Instant::now()).is_none());
}

#[test]
fn losing_focus_in_one_window_keeps_the_other_watched() {
    let watchdog = Watchdog::default();
    watchdog.focus("w-1", true);
    // macOS can deliver the old window's blur after the new one's focus.
    watchdog.focus("main", false);
    assert_eq!(
        watchdog.focused_silence(Instant::now()).unwrap().label,
        "w-1"
    );
}

#[test]
fn regaining_focus_between_ticks_is_a_new_watch_not_a_recovery() {
    let watchdog = Watchdog::default();
    watchdog.focus("main", true);
    let before = watchdog.focused_silence(Instant::now()).unwrap().focus;
    watchdog.focus("main", false);
    watchdog.focus("main", true);
    let after = watchdog.focused_silence(Instant::now()).unwrap().focus;
    assert_ne!(before, after);
}

#[test]
fn a_long_message_is_clipped_on_a_character_boundary() {
    assert_eq!(clip("日本語", 2), "日本");
    assert_eq!(clip("short", 100), "short");
}

#[test]
fn a_flood_of_page_lines_is_cut_off_and_counted_when_one_fits_again() {
    let mut budget = Budget {
        bytes: PAGE_BYTES_PER_MINUTE,
        since: None,
        dropped: 0,
    };
    let start = Instant::now();
    let line = 1024;
    for _ in 0..128 {
        assert_eq!(budget.take(start, line), (true, 0));
    }
    assert_eq!(budget.take(start, line), (false, 0));
    assert_eq!(budget.take(start, line), (false, 0));
    // A second refills a sixtieth of the allowance: two of these lines.
    assert_eq!(budget.take(start + secs(1), line), (true, 2));
    assert_eq!(budget.take(start + secs(1), line), (true, 0));
    assert_eq!(budget.take(start + secs(1), line), (false, 0));
}

#[test]
fn a_new_minute_never_lets_more_than_one_burst_through() {
    let mut budget = Budget {
        bytes: PAGE_BYTES_PER_MINUTE,
        since: None,
        dropped: 0,
    };
    let start = Instant::now();
    let mut written = 0;
    for tenth in 0..20 {
        let now = start + secs(59) + Duration::from_millis(tenth * 100);
        while budget.take(now, 4096).0 {
            written += 4096;
        }
    }
    assert!(written as f64 <= PAGE_BYTES_PER_MINUTE * (1.0 + 2.0 / 60.0) + 4096.0);
}

#[test]
fn the_longest_message_fits_a_full_allowance() {
    assert!((MAX_MESSAGE_CHARS * 4 + LINE_OVERHEAD) as f64 <= PAGE_BYTES_PER_MINUTE);
}

#[test]
fn a_flood_of_empty_messages_is_still_cut_off() {
    let mut budget = Budget {
        bytes: PAGE_BYTES_PER_MINUTE,
        since: None,
        dropped: 0,
    };
    let start = Instant::now();
    let written = (0..100_000)
        .take_while(|_| budget.take(start, LINE_OVERHEAD).0)
        .count();
    assert_eq!(written, PAGE_BYTES_PER_MINUTE as usize / LINE_OVERHEAD);
}

#[test]
fn a_page_message_cannot_forge_a_record_or_carry_an_escape() {
    let forged = "open failed: x\n[2026-11-09][webview][ERROR] fake\u{1b}]52;c;AA==\u{7}";
    let safe = defang(forged);
    assert!(!safe.contains("\n["));
    assert!(!safe.contains('\u{1b}'));
    assert!(!safe.contains('\u{7}'));
    assert!(safe.contains("\\u{1b}"));
}

#[test]
fn a_stack_trace_keeps_its_lines_and_tabs() {
    assert_eq!(defang("Error\n\tat f"), "Error\n    \tat f");
}

#[test]
fn a_unicode_line_separator_or_bidi_control_is_spelled_out() {
    let safe = defang("x\u{2028}[ERROR] fake\u{202E}gnp.exe");
    assert!(!safe.contains('\u{2028}'));
    assert!(!safe.contains('\u{202E}'));
}

#[test]
fn a_message_full_of_control_characters_stays_within_the_clip() {
    let flood = "\u{1}".repeat(MAX_MESSAGE_CHARS);
    let safe = defang(clip(&flood, MAX_MESSAGE_CHARS));
    assert_eq!(
        clip(&safe, MAX_MESSAGE_CHARS).chars().count(),
        MAX_MESSAGE_CHARS
    );
}
