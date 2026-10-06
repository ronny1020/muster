//! Where a session's output goes, and enough of what already went to hand the
//! session to another window without a gap.

use std::collections::VecDeque;

use tauri::ipc::{Channel, InvokeResponseBody};

/// How much recent output a session keeps for a window that adopts it.
///
/// It only has to cover the moment between the old window snapshotting its
/// screen and the new one attaching — the snapshot carries everything older —
/// so it is sized for a burst of agent output, not for history.
const BACKLOG_BYTES: usize = 512 * 1024;

/// Somewhere output can be delivered: a window's channel, or a test's vec.
pub trait Sink {
    /// `false` once nothing is listening any more.
    fn deliver(&self, bytes: Vec<u8>) -> bool;
}

impl Sink for Channel<InvokeResponseBody> {
    fn deliver(&self, bytes: Vec<u8>) -> bool {
        self.send(InvokeResponseBody::Raw(bytes)).is_ok()
    }
}

/// A session's output stream, numbered by byte.
///
/// The count is what makes a move exact: the old window says how many bytes
/// its screen already shows, and `redirect` sends the new one everything after
/// that — under the same lock the reader thread sends under, so no chunk can
/// fall between the swap and the replay, or arrive twice.
pub struct Output<S> {
    /// `None` once the window behind it has gone. A channel to a destroyed
    /// window still answers `Ok`, and queues every larger chunk for a fetch
    /// that never comes — so it is let go when that window closes
    /// (`park`), or when a delivery does fail, and the backlog carries the
    /// gap until a window attaches.
    sink: Option<S>,
    /// The label of the window whose channel `sink` is.
    owner: String,
    sent: u64,
    backlog: VecDeque<u8>,
}

impl<S: Sink> Output<S> {
    pub fn new(sink: S, owner: &str) -> Self {
        Self {
            sink: Some(sink),
            owner: owner.to_string(),
            sent: 0,
            backlog: VecDeque::new(),
        }
    }

    /// Records a chunk, then delivers it. Recorded first, so a chunk whose
    /// window has gone is still there for the window that adopts the session.
    pub fn send(&mut self, bytes: &[u8]) {
        self.sent += bytes.len() as u64;
        self.backlog.extend(bytes);
        let excess = self.backlog.len().saturating_sub(BACKLOG_BYTES);
        self.backlog.drain(..excess);
        if let Some(sink) = &self.sink {
            if !sink.deliver(bytes.to_vec()) {
                self.sink = None;
            }
        }
    }

    /// Points the stream at `sink` and replays what was sent after byte
    /// `from`, answering the offset the replay actually starts at — later than
    /// `from` when the backlog no longer reaches back that far.
    pub fn redirect(&mut self, sink: S, owner: &str, from: u64) -> u64 {
        self.owner = owner.to_string();
        let oldest = self.sent - self.backlog.len() as u64;
        let start = from.clamp(oldest, self.sent);
        let skip = (start - oldest) as usize;
        let replay: Vec<u8> = self.backlog.iter().skip(skip).copied().collect();
        let alive = replay.is_empty() || sink.deliver(replay);
        self.sink = alive.then_some(sink);
        start
    }

    /// Lets go of the channel if window `closed` owns it.
    pub fn park(&mut self, closed: &str) {
        if self.owner == closed {
            self.sink = None;
        }
    }
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
