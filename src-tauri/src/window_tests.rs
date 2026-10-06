use super::{is_window_label, new_label};

#[test]
fn a_new_label_is_one_the_capability_grants() {
    assert!(is_window_label(&new_label()));
}

#[test]
fn two_new_labels_differ() {
    assert_ne!(new_label(), new_label());
}

#[test]
fn only_generated_labels_count_as_windows() {
    assert!(!is_window_label("main"));
    assert!(!is_window_label("w-"));
    assert!(!is_window_label("w-../x"));
    assert!(!is_window_label("settings"));
}

use super::{drop_target, DropTarget, Placed, Rect};

/// A window at `left` on a desktop, 1000x800 desktop pixels, its strip along
/// the top 40 CSS pixels.
fn window(label: &str, left: f64, scale: f64, recency: u64) -> Placed {
    Placed {
        label: label.to_string(),
        origin: (left, 100.0),
        scale,
        frame: (left, 100.0, left + 1000.0, 900.0),
        strip: Some(Rect {
            left: 0.0,
            top: 0.0,
            width: 1000.0 / scale,
            height: 40.0,
        }),
        recency,
    }
}

#[test]
fn a_drop_on_another_windows_strip_merges_at_that_point() {
    let windows = [window("main", 0.0, 1.0, 1), window("w-2", 2000.0, 2.0, 0)];
    assert_eq!(
        drop_target((2300.0, 150.0), "main", &windows, false),
        DropTarget::Strip {
            label: "w-2".to_string(),
            x: 150.0,
        },
        "x is in the target's own CSS pixels, at its own scale"
    );
}

#[test]
fn a_drop_just_off_the_strip_still_counts_and_further_off_does_not() {
    let windows = [window("main", 0.0, 1.0, 1), window("w-2", 2000.0, 1.0, 0)];
    // The strip ends 40px down; the margin is 12.
    assert!(matches!(
        drop_target((2100.0, 150.0), "main", &windows, false),
        DropTarget::Strip { .. }
    ));
    assert_eq!(
        drop_target((2100.0, 160.0), "main", &windows, false),
        DropTarget::Outside
    );
}

#[test]
fn a_drop_over_its_own_window_is_told_apart_from_open_desktop() {
    let windows = [window("main", 0.0, 1.0, 1)];
    assert_eq!(
        drop_target((500.0, 500.0), "main", &windows, false),
        DropTarget::Source
    );
    assert_eq!(
        drop_target((500.0, 120.0), "main", &windows, false),
        DropTarget::Source
    );
}

#[test]
fn a_drop_on_open_desktop_wants_a_window() {
    let windows = [window("main", 0.0, 1.0, 1), window("w-2", 2000.0, 1.0, 0)];
    assert_eq!(
        drop_target((1500.0, 500.0), "main", &windows, false),
        DropTarget::Outside
    );
}

#[test]
fn overlapping_strips_go_to_the_most_recently_focused_window() {
    let windows = [
        window("main", 0.0, 1.0, 3),
        window("w-2", 1500.0, 1.0, 1),
        window("w-3", 1500.0, 1.0, 2),
    ];
    assert_eq!(
        drop_target((1600.0, 120.0), "main", &windows, false),
        DropTarget::Strip {
            label: "w-3".to_string(),
            x: 100.0,
        }
    );
}

#[test]
fn a_strip_behind_the_dragging_window_cannot_take_the_drop() {
    // w-2's strip runs under main's body; main is in front while dragging.
    let windows = [window("main", 0.0, 1.0, 2), window("w-2", 500.0, 1.0, 1)];
    assert_eq!(
        drop_target((700.0, 120.0), "main", &windows, false),
        DropTarget::Source
    );
}

#[test]
fn a_window_carried_by_its_lone_tab_does_not_count_as_under_the_cursor() {
    let windows = [window("main", 0.0, 1.0, 2), window("w-2", 500.0, 1.0, 1)];
    assert!(matches!(
        drop_target((700.0, 120.0), "main", &windows, true),
        DropTarget::Strip { .. }
    ));
}
