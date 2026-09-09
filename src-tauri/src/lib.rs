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
            workspace::home_dir,
            workspace::create_directory,
            sessions::agent_sessions,
            editor::editors,
            editor::open_in_editor,
            image::read_image,
            link::link_preview,
            platform::platform_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
