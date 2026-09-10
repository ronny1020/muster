use tauri::Manager;

mod editor;
mod image;
mod link;
mod platform;
mod pty;
mod sessions;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_cwd,
            workspace::workspace_info,
            workspace::git_log,
            workspace::git_branches,
            workspace::git_checkout,
            workspace::path_kind,
            workspace::home_dir,
            workspace::create_directory,
            sessions::agent_sessions,
            editor::editors,
            editor::open_in_editor,
            image::read_image,
            link::link_preview,
            platform::platform_info,
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
            if matches!(event, tauri::RunEvent::Exit) {
                handle.state::<pty::Sessions>().end_all();
            }
        });
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
