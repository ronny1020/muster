use tauri::{Emitter, Manager};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod attach;
mod editor;
mod fonts;
mod image;
mod journal;
mod link;
mod platform;
mod pty;
mod review;
mod sessions;
mod store;
mod workspace;

#[cfg(test)]
#[path = "config_tests.rs"]
mod config_tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // First, as the plugin's own docs require: a second launch has to be
        // turned away before anything else in this chain has run. It matters
        // more here than in most apps — two instances would each restore the
        // same tab list, each spawn its own PTYs for them, and each record and
        // sweep the same per-directory journal folders.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            // The gesture was "open Muster", so answer it: an unfocused or
            // minimised window that merely exists is indistinguishable from
            // the app having ignored the launch.
            let _ = window.unminimize();
            let _ = window.set_focus();
            // `muster ~/proj` from a shell, with the app already open. The
            // argv is the user's own — they typed it — so unlike a URL scheme
            // this needs no trust decision; it still only ever produces a
            // pre-filled launcher, never a spawned session.
            if let Some(dir) = first_directory(&argv, &cwd) {
                let _ = app.emit("muster://open-directory", dir);
            }
        }));

    // Lets an MCP client read this webview's DOM and run JavaScript in it —
    // the only way to inspect a Tauri webview, which has no remote debugging
    // port. Behind a feature and `debug_assertions` both, because the socket
    // it opens is arbitrary code execution for anything running as the user.
    // Registered after single-instance, never before it: that plugin has to
    // turn a second launch away before anything else in the chain has run.
    #[cfg(all(feature = "mcp", debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new("muster".to_string())
                .start_socket_server(true)
                .socket_path("/tmp/muster-mcp.sock".into()),
        ));
    }

    builder
        // Size and position across restarts. Without it every launch reopens
        // at the config's 1180x760, wherever the window was left.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Deliberately not `all()`. DECORATIONS would let a saved
                // state fight `tauri.windows.conf.json`, which turns the frame
                // off on purpose; VISIBLE could restore a window hidden, which
                // on a single-window app leaves no way to get it back.
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        // The webview's own browser shortcuts, turned off. `Ctrl+R` or `F5`
        // reaching WebView2 reloads the page, which remounts every pane and
        // throws away all of xterm's scrollback — while the PTYs carry on in
        // Rust, so the sessions survive and the record of them does not. That
        // is the one thing this app exists to keep.
        .plugin(prevent_default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::Sessions::default())
        .manage(store::Store::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_reattach,
            pty::pty_cwd,
            store::state_read,
            store::state_write,
            workspace::workspace_info,
            fonts::font_families,
            workspace::git_log,
            workspace::git_branches,
            workspace::git_checkout,
            workspace::path_kind,
            review::git_changes,
            review::git_file_diff,
            review::read_text_file,
            review::list_directory,
            workspace::home_dir,
            workspace::create_directory,
            sessions::agent_sessions,
            journal::journal_sessions,
            journal::journal_read,
            journal::journal_sweep,
            attach::attach_text,
            attach::attach_sweep,
            editor::editors,
            editor::open_in_editor,
            image::read_image,
            link::link_preview,
            platform::platform_info,
            platform::drop_paths,
        ])
        .on_window_event(|window, event| match event {
            // Quitting over a mid-turn agent throws away work that cannot be
            // recovered, so it is worth one question.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let live = window.state::<pty::Sessions>().live();
                if live == 0 {
                    return;
                }
                api.prevent_close();
                let window = window.clone();
                confirm_quit(window, live);
            }
            // The frontend is never unmounted on quit, so this is the only
            // chance to reach the agents' own process groups.
            tauri::WindowEvent::Destroyed => {
                window.state::<pty::Sessions>().end_all();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // `Cmd+Q`, and the app menu's Quit, reach tao as `terminate:` — which
        // emits only `LoopDestroyed`, so no window ever sees `CloseRequested`
        // or `Destroyed`. This is the one place cleanup runs on every quit
        // gesture rather than only on the close button.
        .run(|handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                reopen_window(handle);
                return;
            }
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<pty::Sessions>().end_all();
                // Saved here rather than left to the plugin's own window
                // hooks, for the reason the cleanup above is here: `Cmd+Q` and
                // the app menu's Quit emit only `LoopDestroyed`, so a window
                // never sees `CloseRequested` or `Destroyed` — and the most
                // common quit gesture on macOS would silently save nothing.
                let _ = handle.save_window_state(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                );
            }
        });
}

/// The shortcut-swallowing plugin, with the native Windows path actually
/// switched on.
///
/// `with_flags` alone leaves `PlatformOptions` at its default, so the
/// `platform-windows` feature compiles in and then does nothing: the injected
/// page listener is all that remains, and page-level `preventDefault` does not
/// reliably stop WebView2's own `F5`. `browser_accelerator_keys(false)` is what
/// reaches `SetAreBrowserAcceleratorKeysEnabled`, which is the whole reason
/// this plugin is here at all.
fn prevent_default<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_prevent_default::Builder::new().with_flags(prevented_shortcuts());
    #[cfg(windows)]
    let builder = builder.platform(
        tauri_plugin_prevent_default::PlatformOptions::new().browser_accelerator_keys(false),
    );
    builder.build()
}

/// Which webview shortcuts to swallow.
///
/// Deliberately not `Flags::debug()`, which is everything: two of its flags
/// would break promises this app makes elsewhere.
///
/// `FOCUS_MOVE` is `Shift+Tab`, and blocking it breaks backward keyboard
/// navigation — against the Level AA bar in AGENTS.md, and against
/// `shared/ui/ContextMenu`, which exists to be reachable from the keyboard.
/// `CONTEXT_MENU` is the right click the file tree's own menu is built on, and
/// AGENTS.md notes that hanging it off `onContextMenu` is what also makes it
/// answer the Menu key and `Shift+F10` — so it is not a 2.1.1 failure. Taking
/// the native menu away risks taking that with it.
///
/// `DEV_TOOLS` is left alone in a debug build for the obvious reason.
fn prevented_shortcuts() -> tauri_plugin_prevent_default::Flags {
    use tauri_plugin_prevent_default::Flags;

    // `FIND` is included on purpose: the app has its own scrollback search on
    // the same key, and the webview's find bar must not answer first.
    let base = Flags::RELOAD
        | Flags::FIND
        | Flags::PRINT
        | Flags::OPEN
        | Flags::SOURCE
        | Flags::DOWNLOADS
        | Flags::CARET_BROWSING;
    if cfg!(debug_assertions) {
        base
    } else {
        base | Flags::DEV_TOOLS
    }
}

/// The first argument naming a directory that exists, expanded and made
/// absolute against the directory the *second* launch was run from.
///
/// That base is load-bearing: this process is the first instance, whose own cwd
/// is launchd's or the desktop session's, not the shell the user typed in. So
/// `muster .` would resolve `.` against the app's directory — and `.` is always
/// a directory, so it passes every check and silently opens the wrong place.
///
/// Only a directory: a file would be a different gesture — "open this in an
/// editor" — and this app's unit of work is a folder a session runs in.
fn first_directory(argv: &[String], cwd: &str) -> Option<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| {
            let expanded = workspace::expand_home(arg);
            let path = std::path::Path::new(&expanded);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                std::path::Path::new(cwd).join(path)
            }
        })
        .map(without_dot_segments)
        .find(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
}

/// A path with its `.` and `..` segments resolved away, without touching the
/// filesystem.
///
/// `muster .` otherwise yields `<cwd>/.`, which is a real directory and passes
/// every check — and then titles the tab "." and keys its journal folder on a
/// spelling `one_spelling` does not collapse, so the drawer reads a different
/// folder from the same directory opened any other way.
fn without_dot_segments(path: std::path::PathBuf) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Brings the main window back when the Dock icon is clicked.
///
/// The case that reaches here is a **minimized** window: closing the last one
/// exits the app, so there is no window-less state to rebuild from.
///
/// `unminimize` is the call that does the restoring, and the order matters:
/// tao's `set_focus` is a documented no-op while a window is miniaturized and
/// `show` is `makeKeyAndOrderFront`, which does not deminiaturize either, so
/// either one alone leaves the Dock click doing nothing — macOS has already
/// suppressed its own deminiaturize, the delegate having answered
/// `has_visible_windows: false`. The two that follow are not redundant: a
/// window can also be hidden or merely unfocused, and they are what answers
/// the click then.
#[cfg(target_os = "macos")]
fn reopen_window(handle: &tauri::AppHandle) {
    let Some(window) = handle.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Asks before closing over running sessions, then closes for real.
///
/// The dialog is shown from a callback rather than awaited: blocking inside the
/// window-event handler deadlocks the event loop that has to draw the dialog.
fn confirm_quit(window: tauri::Window, live: usize) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let plural = if live == 1 { "session" } else { "sessions" };
    window
        .dialog()
        .message(format!(
            "{live} {plural} still running. Quitting ends them and anything they started."
        ))
        .title("Quit Muster?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |quit| {
            if quit {
                let _ = window.destroy();
            }
        });
}
