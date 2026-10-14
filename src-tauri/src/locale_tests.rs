use super::*;

#[test]
fn the_os_order_is_kept() {
    let tags = ["en-TW", "zh-Hant-TW", "ja-TW"].map(String::from);
    assert_eq!(
        preferred(tags.into_iter()),
        ["en-TW", "zh-Hant-TW", "ja-TW"]
    );
}

#[test]
fn a_blank_tag_is_dropped_and_a_padded_one_trimmed() {
    let tags = ["", "  ", " ja-JP "].map(String::from);
    assert_eq!(preferred(tags.into_iter()), ["ja-JP"]);
}
