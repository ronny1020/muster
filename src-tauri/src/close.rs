//! The question asked before closing over running sessions.
//!
//! The dialog is native, so it still answers when a webview has hung — the
//! moment a user most wants to quit. Its words come from the webview, which
//! owns the catalogs, and are handed over whenever the language changes.

use std::sync::Mutex;

use tauri::State;

/// The dialog's words in the interface language. Each body is a template whose
/// `{{count}}` is the number of running sessions.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseWords {
    pub quit_title: String,
    pub close_title: String,
    pub quit: String,
    pub close: String,
    pub cancel: String,
    pub quit_body_one: String,
    pub quit_body_other: String,
    pub close_body_one: String,
    pub close_body_other: String,
}

/// The American catalog's words, which hold until a language change sends
/// others. `the_built_in_words_are_the_american_catalogs` keeps the two equal.
impl Default for CloseWords {
    fn default() -> Self {
        Self {
            quit_title: "Quit Muster?".into(),
            close_title: "Close this window?".into(),
            quit: "Quit".into(),
            close: "Close".into(),
            cancel: "Cancel".into(),
            quit_body_one: "{{count}} session still running. Quitting ends it and anything it started.".into(),
            quit_body_other: "{{count}} sessions still running. Quitting ends them and anything they started.".into(),
            close_body_one: "{{count}} session still running. Closing the window ends it and anything it started.".into(),
            close_body_other: "{{count}} sessions still running. Closing the window ends them and anything they started.".into(),
        }
    }
}

#[derive(Default)]
pub struct Words(Mutex<CloseWords>);

#[tauri::command]
pub fn close_words(words: CloseWords, held: State<'_, Words>) {
    *held
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = words;
}

/// The dialog's text, filled in.
#[derive(Debug, PartialEq)]
pub struct Prompt {
    pub title: String,
    pub body: String,
    pub action: String,
    pub cancel: String,
}

/// Picks the words for one close. The last window's close quits the app, so it
/// says so; any other ends only the sessions it shows.
///
/// Two plural forms cover every language the app carries — English has one
/// and other, Chinese and Japanese only other, sent twice. A language with
/// more forms would need them here.
pub fn prompt(words: &CloseWords, live: usize, last: bool) -> Prompt {
    let (title, action, one, other) = if last {
        (
            &words.quit_title,
            &words.quit,
            &words.quit_body_one,
            &words.quit_body_other,
        )
    } else {
        (
            &words.close_title,
            &words.close,
            &words.close_body_one,
            &words.close_body_other,
        )
    };
    let body = if live == 1 { one } else { other };
    Prompt {
        title: title.clone(),
        body: body.replace("{{count}}", &live.to_string()),
        action: action.clone(),
        cancel: words.cancel.clone(),
    }
}

/// Asks before closing over running sessions, then closes for real.
///
/// The dialog is shown from a callback rather than awaited: blocking inside the
/// window-event handler deadlocks the event loop that has to draw the dialog.
pub fn confirm(window: tauri::Window, words: &CloseWords, live: usize, last: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let Prompt {
        title,
        body,
        action,
        cancel,
    } = prompt(words, live, last);
    window
        .dialog()
        .message(body)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(action, cancel))
        .show(move |quit| {
            if quit {
                let _ = window.destroy();
            }
        });
}

/// The words in force now.
pub fn current(held: &Words) -> CloseWords {
    held.0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[cfg(test)]
#[path = "close_tests.rs"]
mod tests;
