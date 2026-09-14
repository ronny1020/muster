//! Oversized pasted text, written to a file the agent can read.
//!
//! A paste reaches a TUI as keystrokes, so a two-thousand-line log arrives as
//! two thousand lines of input for the agent's own editor to reflow and
//! re-tokenise — and the agent CLIs answer by collapsing it to a placeholder
//! held in memory, which nothing can then open. Handing over a path instead
//! turns the same gesture into something the agent reads with a file tool.
//!
//! Two placement traps decided where these files go. The system temp directory
//! is reaped by the OS, sometimes before the agent gets to the path it was
//! just given; inside the repository they would dirty git status and appear in
//! the review panel as changes the agent did not make. So they live beside the
//! session journal, under the app's own data directory, and expire the same
//! way.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use tauri::{AppHandle, Manager};

/// The largest paste that becomes a file.
///
/// Well above any plausible paste, and deliberately so: the caller's fallback
/// when this refuses is to paste the text as keystrokes, which is exactly what
/// the feature exists to avoid — so a limit low enough to be reached would
/// invert the whole thing at the top end, giving the worst behaviour to the
/// biggest paste. It is a guard against something absurd reaching `fs::write`,
/// not a policy. Note the frontend counts UTF-16 units and this counts bytes,
/// so the two are only on the same scale for ASCII — another reason for the
/// gap between them to be large.
const MAX_ATTACH_BYTES: usize = 128 * 1024 * 1024;

/// Writes pasted text to a file and answers with its absolute path.
#[tauri::command]
pub async fn attach_text(app: AppHandle, text: String) -> Result<String, String> {
    if text.len() > MAX_ATTACH_BYTES {
        return Err(format!(
            "too large to attach: {} bytes, limit {MAX_ATTACH_BYTES}",
            text.len()
        ));
    }
    tauri::async_runtime::spawn_blocking(move || write_attachment(&app, &text))
        .await
        .map_err(|error| error.to_string())?
}

fn write_attachment(app: &AppHandle, text: &str) -> Result<String, String> {
    let dir = root(app).ok_or("no data directory")?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(attachment_name(SystemTime::now(), text));
    fs::write(&path, text).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Deletes attachments older than `days`, on the journal's retention setting.
#[tauri::command]
pub async fn attach_sweep(app: AppHandle, days: u32) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some(root) = root(&app) {
            sweep(&root, Duration::from_secs(u64::from(days) * 24 * 60 * 60));
        }
    })
    .await;
}

fn sweep(dir: &Path, keep_for: Duration) {
    let Ok(files) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now() - keep_for;
    for file in files.flatten() {
        let stale = file
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified < cutoff);
        if stale {
            let _ = fs::remove_file(file.path());
        }
    }
}

fn root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("attachments"))
}

/// A filename carrying when it was pasted and roughly what it is.
///
/// The extension is what decides whether an agent's file tool and the review
/// panel treat the contents as code or as prose, so a paste that looks like a
/// unified diff is named as one.
fn attachment_name(now: SystemTime, text: &str) -> String {
    let stamp = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    format!("paste-{stamp}.{}", extension_for(text))
}

fn extension_for(text: &str) -> &'static str {
    let head = text.trim_start();
    if head.starts_with("diff --git") || head.starts_with("--- ") {
        return "patch";
    }
    if head.starts_with('{') || head.starts_with('[') {
        return "json";
    }
    "txt"
}

#[cfg(test)]
#[path = "attach_tests.rs"]
mod tests;
