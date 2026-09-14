//! What the two window configurations have to agree on.
//!
//! See AGENTS.md's "Windows has no frame" invariant for why the Windows file
//! restates the whole window rather than only the key it changes.

use serde_json::Value;

/// Keys that ask for something only macOS has: the base file keeps them for
/// that platform — it is Linux's too, which ignores them — while the Windows
/// file must not carry them, so they are exempt from the comparison in one
/// direction and forbidden in the other.
const MACOS_ONLY: &[&str] = &["titleBarStyle", "hiddenTitle"];

/// The sole window both files describe.
///
/// Asserting the count is part of the check, not a formality: the merge
/// replaces the array wholesale, so a second window added to one file alone
/// would be dropped on Windows with every assertion below still passing.
fn window(config: &str) -> serde_json::Map<String, Value> {
    let parsed: Value = serde_json::from_str(config).expect("config is JSON");
    let windows = parsed["app"]["windows"]
        .as_array()
        .expect("app.windows is an array");
    assert_eq!(windows.len(), 1, "these tests describe one window");
    windows[0].as_object().expect("a window object").clone()
}

fn windows_config() -> Value {
    serde_json::from_str(include_str!("../tauri.windows.conf.json")).expect("config is JSON")
}

fn base() -> serde_json::Map<String, Value> {
    window(include_str!("../tauri.conf.json"))
}

fn windows() -> serde_json::Map<String, Value> {
    window(include_str!("../tauri.windows.conf.json"))
}

/// Shortens the trio of doc comments the helpers above would otherwise repeat.
fn keys(value: &Value) -> Vec<&String> {
    value.as_object().expect("an object").keys().collect()
}

#[test]
fn the_windows_window_restates_every_cross_platform_setting() {
    for (key, value) in base() {
        if MACOS_ONLY.contains(&key.as_str()) {
            continue;
        }
        assert_eq!(
            windows().get(&key),
            Some(&value),
            "tauri.windows.conf.json is missing or disagrees about `{key}`",
        );
    }
}

#[test]
fn the_windows_window_adds_nothing_but_the_missing_frame() {
    for key in windows().keys() {
        if key == "decorations" {
            continue;
        }
        assert!(
            base().contains_key(key),
            "`{key}` is set for Windows only, where nothing states what it should be elsewhere",
        );
    }
}

#[test]
fn the_windows_window_carries_none_of_macos_own_keys() {
    for key in MACOS_ONLY {
        assert!(
            !windows().contains_key(*key),
            "`{key}` asks for something only macOS has, so it means nothing here",
        );
    }
}

#[test]
fn the_windows_file_overrides_the_window_and_nothing_else() {
    // Every array in the config merges the same way — `bundle.targets`, the
    // icon list, a security block — so a second key here would replace one
    // silently on Windows alone. The tests above read only the window, which
    // is sound exactly as long as the window is all this file sets.
    let parsed = windows_config();
    let top: Vec<&String> = keys(&parsed)
        .into_iter()
        .filter(|key| *key != "$schema")
        .collect();
    assert_eq!(top, vec!["app"], "only `app` may be overridden for Windows");
    assert_eq!(
        keys(&parsed["app"]),
        vec!["windows"],
        "only `app.windows` may be overridden for Windows",
    );
}

#[test]
fn windows_draws_no_frame_of_its_own() {
    // The tab strip is the titlebar there, and a native caption above it reads
    // as two stacked title bars — see `WindowControls`.
    assert_eq!(windows().get("decorations"), Some(&Value::Bool(false)));
}

#[test]
fn macos_keeps_its_frame_and_hides_only_the_title() {
    // The traffic lights are real, and dropping the frame would lose window
    // snapping and tiling with it.
    let base = base();
    assert_eq!(base.get("decorations"), None);
    assert_eq!(
        base.get("titleBarStyle").and_then(Value::as_str),
        Some("Overlay")
    );
    assert_eq!(base.get("hiddenTitle"), Some(&Value::Bool(true)));
}

#[test]
fn a_directory_argument_is_recognised_and_a_flag_is_not() {
    // `muster ~/proj` while the app is open, as a shell would pass it.
    let here = env!("CARGO_MANIFEST_DIR").to_string();
    let argv = vec!["muster".to_string(), here.clone()];
    assert_eq!(super::first_directory(&argv, "/"), Some(here.clone()));

    // The binary's own path is skipped even though it is inside a directory,
    // and a flag that happens to name one is still a flag.
    assert_eq!(
        super::first_directory(std::slice::from_ref(&here), "/"),
        None
    );
    assert_eq!(
        super::first_directory(&["muster".to_string(), format!("--cwd={here}")], "/"),
        None
    );
}

#[test]
fn a_path_that_is_not_a_directory_is_ignored() {
    // A file is a different gesture, and a missing path is a typo — neither
    // should silently open a tab somewhere unexpected.
    let file = format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
    assert_eq!(
        super::first_directory(&["muster".to_string(), file], "/"),
        None
    );
    assert_eq!(
        super::first_directory(&["muster".to_string(), "/no/such/dir".to_string()], "/"),
        None
    );
}

#[test]
fn the_keyboard_shortcuts_the_app_needs_are_never_swallowed() {
    use tauri_plugin_prevent_default::Flags;
    let prevented = super::prevented_shortcuts();

    // `Shift+Tab`. Blocking it breaks backward keyboard navigation, which is
    // the Level AA bar AGENTS.md sets and what `shared/ui/ContextMenu` needs.
    assert!(!prevented.contains(Flags::FOCUS_MOVE));
    // Right click, which the file tree's own menu is built on — and which is
    // also what makes that menu answer the Menu key and Shift+F10.
    assert!(!prevented.contains(Flags::CONTEXT_MENU));
    // The reason the plugin is here at all: a reload discards every pane's
    // scrollback while the PTYs keep running.
    assert!(prevented.contains(Flags::RELOAD));
    // The app answers this key itself, with its own scrollback search.
    assert!(prevented.contains(Flags::FIND));
}

#[test]
fn devtools_stay_reachable_in_a_debug_build_and_not_in_a_release_one() {
    use tauri_plugin_prevent_default::Flags;
    let prevented = super::prevented_shortcuts();
    assert_eq!(
        prevented.contains(Flags::DEV_TOOLS),
        !cfg!(debug_assertions)
    );
}

#[test]
fn a_relative_argument_resolves_against_the_shell_that_sent_it() {
    // This process is the first instance, whose cwd is launchd's rather than
    // the shell the user typed in — so `muster .` resolved locally would
    // always pass (`.` is a directory) and open the wrong place.
    let here = env!("CARGO_MANIFEST_DIR").to_string();
    let argv = vec!["muster".to_string(), ".".to_string()];
    let resolved = super::first_directory(&argv, &here).expect("a directory");
    assert!(
        resolved.starts_with(&here),
        "{resolved} did not resolve against the sender's cwd"
    );

    // And a relative name below it.
    let argv = vec!["muster".to_string(), "src".to_string()];
    let resolved = super::first_directory(&argv, &here).expect("a directory");
    assert!(resolved.ends_with("src"), "{resolved}");
}

#[test]
fn a_dot_argument_names_the_directory_itself_not_a_dot_inside_it() {
    // `<cwd>/.` is a real directory and passes every check, then titles the tab
    // "." and keys its journal on a spelling nothing else produces.
    let here = env!("CARGO_MANIFEST_DIR").to_string();
    let argv = vec!["muster".to_string(), ".".to_string()];
    assert_eq!(super::first_directory(&argv, &here), Some(here.clone()));

    // And `..` resolves rather than being carried along.
    let argv = vec!["muster".to_string(), "src/..".to_string()];
    assert_eq!(super::first_directory(&argv, &here), Some(here));
}
