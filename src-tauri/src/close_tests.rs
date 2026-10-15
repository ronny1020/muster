use super::*;

#[test]
fn the_last_window_asks_to_quit_and_counts_every_session() {
    let asked = prompt(&CloseWords::default(), 3, true);
    assert_eq!(asked.title, "Quit Muster?");
    assert_eq!(asked.action, "Quit");
    assert_eq!(
        asked.body,
        "3 sessions still running. Quitting ends them and anything they started."
    );
}

#[test]
fn one_session_reads_in_the_singular() {
    let asked = prompt(&CloseWords::default(), 1, false);
    assert_eq!(asked.title, "Close this window?");
    assert_eq!(
        asked.body,
        "1 session still running. Closing the window ends it and anything it started."
    );
}

#[test]
fn the_words_the_webview_sent_are_the_ones_shown() {
    let words = CloseWords {
        quit_title: "要結束 Muster 嗎？".into(),
        quit: "結束".into(),
        cancel: "取消".into(),
        quit_body_one: "仍有 {{count}} 個工作階段在執行。".into(),
        quit_body_other: "仍有 {{count}} 個工作階段在執行。".into(),
        ..CloseWords::default()
    };
    let asked = prompt(&words, 2, true);
    assert_eq!(asked.title, "要結束 Muster 嗎？");
    assert_eq!(asked.body, "仍有 2 個工作階段在執行。");
    assert_eq!(
        (asked.action.as_str(), asked.cancel.as_str()),
        ("結束", "取消")
    );
}

#[test]
fn the_webviews_words_arrive_in_camel_case() {
    let sent = r#"{"quitTitle":"a","closeTitle":"b","quit":"c","close":"d","cancel":"e",
        "quitBodyOne":"f","quitBodyOther":"g","closeBodyOne":"h","closeBodyOther":"i"}"#;
    let words: CloseWords = serde_json::from_str(sent).expect("parses");
    assert_eq!(words.close_body_other, "i");
}

#[test]
fn the_built_in_words_are_the_american_catalogs() {
    let catalog: serde_json::Value = serde_json::from_str(include_str!(
        "../../src/shared/i18n/locales/en-US/chrome.json"
    ))
    .expect("catalog parses");
    let dialog = &catalog["closeDialog"];
    let text = |key: &str| dialog[key].as_str().unwrap_or_default().to_string();
    let words = CloseWords::default();
    assert_eq!(words.quit_title, text("quitTitle"));
    assert_eq!(words.close_title, text("closeTitle"));
    assert_eq!(words.quit, text("quit"));
    assert_eq!(words.close, text("close"));
    assert_eq!(words.cancel, text("cancel"));
    assert_eq!(words.quit_body_one, text("quitBody_one"));
    assert_eq!(words.quit_body_other, text("quitBody_other"));
    assert_eq!(words.close_body_one, text("closeBody_one"));
    assert_eq!(words.close_body_other, text("closeBody_other"));
}
