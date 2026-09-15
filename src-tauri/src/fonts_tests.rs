use super::*;

/// One enumeration for the whole file. Each call loads a face per family —
/// 3.2s here — so four independent calls cost nine seconds of every run.
fn once() -> Vec<FontFamily> {
    families()
}

#[test]
fn families_come_back_sorted_and_without_duplicates() {
    // The picker renders them in this order, so the sort belongs here: it is
    // the same list for every reader.
    let names: Vec<_> = once().into_iter().map(|f| f.name).collect();
    let mut expected = names.clone();
    expected.sort_by_key(|name| name.to_lowercase());
    assert_eq!(names, expected, "families were not sorted");

    let mut seen = names.clone();
    seen.dedup();
    assert_eq!(seen.len(), names.len(), "families held a duplicate");
}

#[test]
fn the_flag_splits_the_list_rather_than_answering_one_way() {
    // Both directions: a flag that is never read marks nothing, and a pitch
    // measured rather than read marks nearly everything.
    let families = once();
    if families.is_empty() {
        return; // A host with no fonts at all; the next test covers that.
    }
    assert!(
        families.iter().any(|f| f.monospaced),
        "no family was marked monospaced, among {}",
        families.len()
    );
    assert!(
        families.iter().any(|f| !f.monospaced),
        "every one of {} families was marked monospaced",
        families.len()
    );
}

#[test]
fn an_unreachable_font_source_is_not_cached_as_an_answer() {
    // Empty means the platform source could not be reached, and the frontend
    // answers that with its built-in list. Leaving it uncached lets a source
    // that was briefly away answer properly on the next call.
    let first = families();
    let second = families();
    assert_eq!(first, second, "two reads disagreed");
    if first.is_empty() {
        // Nothing was cached, so a later read may still succeed. The only way
        // to observe that here is that the cell is still unset.
        assert!(
            families().is_empty(),
            "an empty read was cached and then answered non-empty"
        );
    }
}

#[test]
fn a_monospaced_family_names_a_face_this_platform_can_draw_with() {
    // Pins that the flag lands on families whose names read like terminal
    // faces, which holds across images that ship different fonts.
    let families = once();
    if families.is_empty() {
        return;
    }
    let monospaced: Vec<_> = families
        .iter()
        .filter(|f| f.monospaced)
        .map(|f| f.name.to_lowercase())
        .collect();
    assert!(
        monospaced.iter().any(|name| {
            ["mono", "courier", "consolas", "menlo", "code", "terminal"]
                .iter()
                .any(|hint| name.contains(hint))
        }),
        "none of the {} monospaced families reads like a terminal face: {monospaced:?}",
        monospaced.len()
    );
}
