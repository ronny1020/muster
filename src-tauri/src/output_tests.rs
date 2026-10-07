use std::cell::RefCell;
use std::rc::Rc;

use super::{Output, Sink, BACKLOG_BYTES};

#[derive(Clone, Default)]
struct Recorder(Rc<RefCell<Vec<u8>>>);

impl Sink for Recorder {
    fn deliver(&self, bytes: Vec<u8>) -> bool {
        self.0.borrow_mut().extend(bytes);
        true
    }
}

#[test]
fn an_adopting_window_gets_exactly_what_the_old_one_had_not_shown() {
    let old = Recorder::default();
    let mut output = Output::new(old.clone(), "main");
    output.send(b"hello ");
    output.send(b"world");

    // The old window's screen shows the first six bytes.
    let new = Recorder::default();
    assert_eq!(output.redirect(new.clone(), "w-1", 6), 6);
    output.send(b"!");

    assert_eq!(*new.0.borrow(), b"world!");
    assert_eq!(*old.0.borrow(), b"hello world");
}

#[test]
fn a_window_that_has_shown_everything_is_replayed_nothing() {
    let mut output = Output::new(Recorder::default(), "main");
    output.send(b"abc");
    let new = Recorder::default();
    assert_eq!(output.redirect(new.clone(), "w-1", 3), 3);
    assert!(new.0.borrow().is_empty());
}

#[test]
fn an_offset_past_the_end_is_clamped_rather_than_trusted() {
    let mut output = Output::new(Recorder::default(), "main");
    output.send(b"abc");
    assert_eq!(output.redirect(Recorder::default(), "w-1", 99), 3);
}

#[test]
fn an_offset_older_than_the_backlog_replays_what_is_left() {
    let mut output = Output::new(Recorder::default(), "main");
    output.send(&vec![b'a'; BACKLOG_BYTES]);
    output.send(b"tail");

    let new = Recorder::default();
    let start = output.redirect(new.clone(), "w-1", 0);
    assert_eq!(start, 4);
    assert_eq!(new.0.borrow().len(), BACKLOG_BYTES);
    assert!(new.0.borrow().ends_with(b"tail"));
}

/// A window that can go away, counting what reached it after it went.
#[derive(Clone, Default)]
struct Closable {
    gone: Rc<RefCell<bool>>,
    after: Rc<RefCell<usize>>,
    got: Rc<RefCell<Vec<u8>>>,
}

impl Sink for Closable {
    fn deliver(&self, bytes: Vec<u8>) -> bool {
        if *self.gone.borrow() {
            *self.after.borrow_mut() += 1;
            return false;
        }
        self.got.borrow_mut().extend(bytes);
        true
    }
}

#[test]
fn a_window_that_has_gone_is_let_go_and_the_next_one_gets_the_gap() {
    let old = Closable::default();
    let mut output = Output::new(old.clone(), "main");
    output.send(b"seen ");
    *old.gone.borrow_mut() = true;
    output.send(b"one ");
    output.send(b"two");
    assert_eq!(
        *old.after.borrow(),
        1,
        "nothing is sent after the first failure"
    );

    let next = Closable::default();
    output.redirect(next.clone(), "w-1", 5);
    assert_eq!(*next.got.borrow(), b"one two");
}

#[test]
fn a_closed_windows_channel_is_let_go_though_it_never_fails() {
    // A channel to a destroyed window answers Ok; only the window's own
    // closing can tell the stream to stop feeding it.
    let old = Recorder::default();
    let mut output = Output::new(old.clone(), "main");
    output.send(b"a");
    output.park("w-other");
    output.send(b"b");
    output.park("main");
    output.send(b"c");
    assert_eq!(*old.0.borrow(), b"ab");

    let next = Recorder::default();
    output.redirect(next.clone(), "w-1", 2);
    assert_eq!(*next.0.borrow(), b"c");
}
