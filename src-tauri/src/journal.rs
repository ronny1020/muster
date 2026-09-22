//! A verbatim record of what each session printed, kept after its process ends.
//!
//! A terminal's scrollback dies with the window, and the agent CLIs' own
//! transcripts are a different artifact, kept behind each CLI's own picker. A
//! record here says a conversation happened in this directory, how much it
//! printed and when — and, through the sidecar beside it, which agent and
//! which conversation, so it can be reopened. Nothing currently displays a
//! record's contents; `journal_read` exists and has no caller.
//!
//! What that implies is the reason every read and write here is bounded: the
//! file holds whatever the agent printed, secrets included. Recording is a
//! setting, each session is capped, and a sweep drops old files on startup.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use tauri::{AppHandle, Manager};

/// How much of one session is kept. Past this the older half is dropped, so an
/// agent that prints for hours costs a bounded amount of disk and the tail —
/// the part anyone reads — is what survives.
const MAX_SESSION_BYTES: u64 = 4 * 1024 * 1024;

/// How much of a journal one read returns — the **tail**, not the whole file.
///
/// Deliberately well under `MAX_SESSION_BYTES`: whatever eventually displays a
/// record has to parse every byte of it on the thread that draws the window.
/// Nothing displays one today — `journal_read` has no caller — so this bounds
/// a reader that does not exist yet rather than one that does.
const MAX_READ_BYTES: u64 = 512 * 1024;

/// An open journal for one tab, written from that tab's reader thread.
pub struct Journal {
    /// This record's own name, which the sidecar beside it must share.
    name: String,
    path: PathBuf,
    file: File,
    written: u64,
    /// Set when the handle no longer names the record — see `trim`. A journal
    /// that cannot write must stop, not write somewhere nobody can read.
    detached: bool,
}

impl Journal {
    /// Opens the journal for a tab, or `None` when there is nowhere to write —
    /// which is not an error: a session records or it does not, and either way
    /// it runs.
    pub fn open(app: &AppHandle, cwd: &str, id: &str) -> Option<Self> {
        let dir = root(app)?.join(key(cwd));
        fs::create_dir_all(&dir).ok()?;
        let name = record_name(id)?;
        let path = dir.join(format!("{name}.log"));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        Some(Journal {
            name,
            path,
            file,
            written,
            detached: false,
        })
    }

    /// This record's name, for the sidecar that has to sit beside it.
    ///
    /// Handed out rather than recomputed: `record_name` stamps the moment it is
    /// called, so calling it twice yields two names and the sidecar is written
    /// where no reader looks.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Appends one chunk of output. Failures are silent on purpose: a full disk
    /// must not take the session down with it.
    pub fn write(&mut self, bytes: &[u8]) {
        // A detached handle points at an inode the trim already unlinked, so
        // every byte would be written where nothing can read it. Stopping at
        // the tail is the honest outcome; pretending to record is not.
        if self.detached || self.file.write_all(bytes).is_err() {
            return;
        }
        self.written += bytes.len() as u64;
        if self.written > MAX_SESSION_BYTES {
            self.trim();
        }
    }

    /// Drops the older half, keeping the tail.
    ///
    /// Rewriting rather than rotating: a rotation doubles what a tab costs on
    /// disk, and the half being discarded is the half nobody asked for.
    ///
    /// Through a sibling file and a rename, never by truncating in place. The
    /// condition this runs closest to is a full disk — which `write` documents
    /// as survivable — and truncating first means a failed tail write leaves
    /// the record empty rather than halved, with `written` still over the cap
    /// so every later chunk retries the same destruction.
    fn trim(&mut self) {
        let keep = MAX_SESSION_BYTES / 2;
        let staged = self.path.with_extension("log.trimming");
        let trimmed = tail_bytes(&self.path, keep)
            .and_then(|tail| {
                File::create(&staged)?.write_all(&tail)?;
                fs::rename(&staged, &self.path)?;
                Ok(tail.len() as u64)
            })
            .and_then(|len| {
                let file = OpenOptions::new().append(true).open(&self.path)?;
                Ok((file, len))
            });
        match trimmed {
            Ok((file, len)) => {
                self.file = file;
                self.written = len;
            }
            Err(_) => {
                let _ = fs::remove_file(&staged);
                // The file's real length, never zero: zeroing the counter
                // throws away the only record of how big it is, so the next
                // trim is another whole cap away and a directory that stays
                // unwritable grows the log by a cap every cycle — unbounded,
                // which is the one thing this is here to prevent.
                self.written = fs::metadata(&self.path)
                    .map(|meta| meta.len())
                    .unwrap_or(self.written);
                // The rename may already have unlinked what the handle names.
                // If the record is not there, nothing more can reach it.
                self.detached = !self.path.exists();
            }
        }
    }
}

/// What a record remembers about the session that wrote it, beside the bytes.
///
/// Kept in a sibling file rather than in the log: the log is an opaque byte
/// stream, and a reader needs to know which agent and which conversation it
/// belongs to before it can offer to reopen it. Its name must match the
/// record's — see `remember`.
#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JournalMeta {
    /// Which agent wrote it, so the panel can offer that agent's own resume.
    pub agent_id: String,
    /// The agent's own id for the conversation, where it publishes one. This
    /// is what can reopen *that* conversation; our own file name is the tab.
    pub session_id: String,
}

/// One recorded session, as the panel lists it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub bytes: u64,
    /// Seconds since the epoch, from the file's own mtime — the moment the
    /// session last printed anything, which is as close to "when it ended" as
    /// a record with no heartbeat can get.
    pub ended_at: u64,
    pub agent_id: String,
    pub session_id: String,
}

/// Every conversation id this tab's records published, newest first.
///
/// A list rather than the newest one, because a published id is not a promise
/// that a transcript exists: measured across this machine's records, 111 of
/// 172 ids named no file on disk — a session ended soon enough after start
/// that the id was registered before the CLI wrote anything. Taking only the
/// newest would then answer nothing for a tab whose earlier run is readable.
///
/// Our record is keyed on the **tab**, which outlives any one session, so the
/// id the CLI published is the only thing that names the conversation — see
/// the session-record seam in AGENTS.md. Read from the sidecar rather than
/// tracked in memory because a tab that was restored, or moved between
/// windows, never told this process anything.
pub fn session_ids_for(app: &AppHandle, cwd: &str, tab_id: &str) -> Vec<String> {
    let Some(stem) = file_stem(tab_id) else {
        return Vec::new();
    };
    sessions_in(app, cwd)
        .into_iter()
        .filter(|entry| entry.id.starts_with(&stem))
        // Checked again on the way out, not only on the way in: the value is
        // another program's, it arrives from a file anyone can edit, and the
        // caller joins it into a path.
        .filter(|entry| crate::sessions::is_session_id(&entry.session_id))
        .map(|entry| entry.session_id)
        .collect()
}

/// The published id a record may hand to the panel's Resume button, or empty.
///
/// Checked on the way **out**, not only where it was written: the sidecar is a
/// plain file in the user's own data directory, so an agent can write one
/// itself and never pass `published_session_id` at all. This is the value that
/// becomes `--resume <id>` in a real argv, which is why an unusable one is
/// blanked rather than carried — a row with no id draws no button, the state a
/// record that never published one is already in.
fn resumable_id(published: String) -> String {
    if crate::sessions::is_session_id(&published) {
        published
    } else {
        String::new()
    }
}

/// Every recorded session for a directory, newest first.
#[tauri::command]
pub async fn journal_sessions(app: AppHandle, cwd: String) -> Vec<JournalEntry> {
    tauri::async_runtime::spawn_blocking(move || sessions_in(&app, &cwd))
        .await
        .unwrap_or_default()
}

fn sessions_in(app: &AppHandle, cwd: &str) -> Vec<JournalEntry> {
    let Some(dir) = root(app).map(|root| root.join(key(cwd))) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut found: Vec<JournalEntry> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()? != "log" {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let id = path.file_stem()?.to_string_lossy().into_owned();
            let about = read_meta(&dir, &id);
            Some(JournalEntry {
                bytes: meta.len(),
                ended_at: seconds_since_epoch(meta.modified().ok()?),
                agent_id: about.agent_id,
                session_id: resumable_id(about.session_id),
                id,
            })
        })
        .collect();
    found.sort_by_key(|entry| std::cmp::Reverse(entry.ended_at));
    found
}

/// The tail of one recorded session, as the bytes it printed.
///
/// Lossy on purpose: trimming can land mid-character, and a replaced character
/// is a better answer than refusing to show the session.
#[tauri::command]
pub async fn journal_read(app: AppHandle, cwd: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stem = file_stem(&id).ok_or_else(|| format!("not a session id: {id}"))?;
        let path = root(&app)
            .ok_or("no data directory")?
            .join(key(&cwd))
            .join(format!("{stem}.log"));
        let bytes = tail_bytes(&path, MAX_READ_BYTES).map_err(|error| error.to_string())?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Deletes every journal older than `days`, and any directory left empty.
///
/// Called by the frontend at startup because the retention period is a user
/// setting, and settings live in `localStorage` where only the webview can
/// read them — which is also the only place that knows which tabs are running,
/// hence `live`.
#[tauri::command]
pub async fn journal_sweep(app: AppHandle, days: u32, live: Vec<String>) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some(root) = root(&app) {
            sweep(
                &root,
                Duration::from_secs(u64::from(days) * 24 * 60 * 60),
                &live,
            );
        }
    })
    .await;
}

/// `live` names the tabs whose journals are open right now, and they are never
/// deleted whatever their age.
///
/// Without that, an agent idle longer than the retention period — waiting
/// overnight on a question — has its record unlinked by the next sweep, which
/// on Unix succeeds against an open handle: the session keeps appending to an
/// inode with no name, so the rest of it is recorded nowhere and never listed
/// again. Editing the retention setting is enough to trigger it.
fn sweep(root: &Path, keep_for: Duration, live: &[String]) {
    let Ok(dirs) = fs::read_dir(root) else {
        return;
    };
    let cutoff = SystemTime::now() - keep_for;
    for dir in dirs.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            // `live` carries tab ids and a record is `<tab>-<started at>`, so
            // this is a prefix test. Comparing whole strings never matched,
            // which left the guard below dead and deleted running sessions'
            // records out from under their own open handles.
            let open = path.file_stem().is_some_and(|stem| {
                let stem = stem.to_string_lossy();
                live.iter()
                    .any(|id| *stem == **id || stem.starts_with(&format!("{id}-")))
            });
            if open {
                continue;
            }
            // A sidecar's own age means nothing: it is written once at spawn
            // while the log beside it keeps being appended, so judging it on
            // its mtime deletes the agent and conversation of a session that
            // is still well inside its retention. It goes when its log does.
            if path.extension().is_some_and(|ext| ext == "meta") {
                if !path.with_extension("log").exists() {
                    let _ = fs::remove_file(path);
                }
                continue;
            }
            let stale = file
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(|modified| modified < cutoff);
            if stale {
                let _ = fs::remove_file(&path);
                let _ = fs::remove_file(path.with_extension("meta"));
            }
        }
        // Only succeeds once the directory is empty, which is the condition
        // wanted — no directory listing is consulted to decide it.
        let _ = fs::remove_dir(dir.path());
    }
}

fn root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("journal"))
}

/// Remembers which agent and conversation a tab's record belongs to.
///
/// Merged rather than replaced: the agent is known at spawn and the session id
/// arrives later, once the CLI has published it.
pub fn remember(app: &AppHandle, cwd: &str, record: &str, about: JournalMeta) {
    let Some(dir) = root(app).map(|root| root.join(key(cwd))) else {
        return;
    };
    // The record's own name, from `Journal::name` — never a tab id. A record is
    // `<tab>-<started at>`, so a sidecar named after the tab alone is one no
    // reader ever looks up and the next sweep deletes as an orphan.
    let Some(stem) = file_stem(record) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut merged = read_meta(&dir, &stem);
    if !about.agent_id.is_empty() {
        merged.agent_id = about.agent_id;
    }
    if !about.session_id.is_empty() {
        merged.session_id = about.session_id;
    }
    if let Ok(text) = serde_json::to_string(&merged) {
        let _ = fs::write(dir.join(format!("{stem}.meta")), text);
    }
}

/// What is known about one record, or nothing — an older record has no sibling,
/// and a record whose sibling is unreadable is still a record.
fn read_meta(dir: &Path, stem: &str) -> JournalMeta {
    fs::read_to_string(dir.join(format!("{stem}.meta")))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// A directory's own folder name under the journal root.
///
/// `normalize_key` alone is not enough here, for two reasons `sessions.rs` does
/// not have: it only *matches* an agent's own directory names, while this
/// decides where bytes are stored. Flattening every separator makes `/a/b` and
/// `/a-b` one folder, so one project's records would be listed under another's
/// name; and a path longer than `NAME_MAX` produces a directory nobody can
/// create, so recording fails with the setting still switched on. The digest
/// makes the name injective and the truncation keeps it creatable.
fn key(cwd: &str) -> String {
    let expanded = crate::workspace::expand_home(cwd);
    let flattened = crate::sessions::normalize_key(&expanded);
    // Lowercased for the same reason the digest is: the readable half must not
    // reintroduce the distinction the digest just dropped.
    let readable: String = flattened.to_lowercase().chars().take(80).collect();
    let stem = readable.trim_end_matches('-');
    // Digested from one spelling, not the raw string: the launcher, the recents
    // list and a folder picker disagree about trailing and doubled separators,
    // and the same directory must not get two folders because of it.
    let digest = digest_of(&one_spelling(&expanded));
    if stem.is_empty() {
        format!("root-{digest}")
    } else {
        format!("{stem}-{digest}")
    }
}

/// One directory, one string: separator runs collapsed, trailing ones dropped
/// and case folded, so `/a/b`, `/a//b`, `/a/b/` and `/A/B` agree while `/a/b`
/// and `/a-b` still differ.
///
/// Folding case costs a shared folder for two directories on Linux that differ
/// only by it — the same cost a digest collision carries, and already
/// documented as acceptable. Not folding it costs the feature outright on
/// macOS and Windows, where the launcher's typed path and the folder picker's
/// canonicalised one routinely differ in case and would key two folders for
/// one directory.
fn one_spelling(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut last_was_separator = false;
    for c in path.chars() {
        let separator = c == '/' || c == '\\';
        if separator && last_was_separator {
            continue;
        }
        out.push(if separator { '/' } else { c });
        last_was_separator = separator;
    }
    let trimmed = out.trim_end_matches('/');
    // A path that was only separators is the root, which is a real directory.
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_lowercase()
    }
}

/// A short, stable hash of a path, so two directories that flatten alike still
/// get their own folder. Not a security boundary — `file_stem` and `key` are
/// what confine these paths — just an identity.
fn digest_of(value: &str) -> String {
    // FNV-1a: a few lines, no dependency, and collisions here cost a shared
    // folder rather than anything reachable.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// One run's own record name: the tab, then when it started.
///
/// Per run rather than per tab, and that is the difference between a truthful
/// list and a misleading one. A tab id survives a relaunch — that is what makes
/// restore work — so naming records after it alone appends every successive
/// session in a tab into one file, and the sidecar beside it can hold only the
/// newest conversation's id. The older conversation's bytes would still be
/// there with no way back into it, under a row calling itself one session.
fn record_name(tab_id: &str) -> Option<String> {
    let stem = file_stem(tab_id)?;
    let started = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    Some(format!("{stem}-{started}"))
}

/// A tab id reduced to a filename, or `None` when it is not one.
///
/// Tab ids are minted by `crypto.randomUUID`, so anything carrying a separator
/// or a dot did not come from there and must not reach a path — this is the
/// only thing between a command argument and the filesystem.
fn file_stem(id: &str) -> Option<String> {
    let safe = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    safe.then(|| id.to_string())
}

/// The last `limit` bytes of a file, or all of it when it is smaller.
fn tail_bytes(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len > limit {
        file.seek(SeekFrom::Start(len - limit))?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub fn seconds_since_epoch(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod tests;
