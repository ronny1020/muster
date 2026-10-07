use super::*;

const PAGE: &str = r#"<!doctype html><html><head>
  <title>Fallback &amp; Title</title>
  <meta name="description" content="plain description">
  <meta property="og:title" content="Open Graph Title">
  <meta property="og:description" content="A &quot;quoted&quot; summary">
  <meta property="og:site_name" content="Example">
  <meta property="og:image" content="/card.png" />
  <meta name="twitter:title" content="Twitter Title">
</head><body><meta property="og:title" content="body tag ignored"></body></html>"#;

#[test]
fn open_graph_wins_over_twitter_and_over_title() {
    let meta = parse_meta(PAGE);
    assert_eq!(meta.title.as_deref(), Some("Open Graph Title"));
    assert_eq!(meta.site_name.as_deref(), Some("Example"));
}

#[test]
fn decodes_entities_in_content() {
    let meta = parse_meta(PAGE);
    assert_eq!(meta.description.as_deref(), Some(r#"A "quoted" summary"#));
}

#[test]
fn falls_back_to_the_title_tag() {
    let meta = parse_meta("<head><title>Fallback &amp; Title</title></head>");
    assert_eq!(meta.title.as_deref(), Some("Fallback & Title"));
}

#[test]
fn falls_back_to_twitter_when_open_graph_is_absent() {
    let meta = parse_meta(
        r#"<head><meta name="twitter:title" content="T"><meta name="twitter:description" content="D"></head>"#,
    );
    assert_eq!(meta.title.as_deref(), Some("T"));
    assert_eq!(meta.description.as_deref(), Some("D"));
}

#[test]
fn ignores_tags_after_the_head() {
    // The body tag in PAGE must not override the head's og:title.
    assert_eq!(parse_meta(PAGE).title.as_deref(), Some("Open Graph Title"));
}

#[test]
fn reads_single_quoted_and_unquoted_attributes() {
    let meta = parse_meta("<head><meta property='og:title' content='Single'></head>");
    assert_eq!(meta.title.as_deref(), Some("Single"));
}

#[test]
fn a_page_with_no_metadata_yields_nothing_rather_than_erroring() {
    let meta = parse_meta("<html><body>hi</body></html>");
    assert_eq!(meta, LinkMeta::default());
}

#[test]
fn an_empty_content_is_not_a_title() {
    let meta = parse_meta(r#"<head><meta property="og:title" content=""></head>"#);
    assert_eq!(meta.title, None);
}

#[test]
fn does_not_confuse_a_longer_tag_name_for_meta() {
    let meta = parse_meta(r#"<head><metadata property="og:title" content="no"></metadata></head>"#);
    assert_eq!(meta.title, None);
}

#[test]
fn an_uppercase_head_still_ends_the_head() {
    let meta = parse_meta(
        "<HEAD><meta property=\"og:title\" content=\"good\"></HEAD>\
         <body><meta property=\"og:title\" content=\"evil\"></body>",
    );
    assert_eq!(meta.title.as_deref(), Some("good"));
}

#[test]
fn a_key_inside_a_quoted_value_is_not_an_attribute() {
    let meta = parse_meta(
        r#"<head><meta alt="content=stolen" property="og:title" content="real"></head>"#,
    );
    assert_eq!(meta.title.as_deref(), Some("real"));
}

#[test]
fn an_escaped_entity_is_decoded_once() {
    let meta =
        parse_meta(r#"<head><meta property="og:title" content="&amp;lt;script&amp;gt;"></head>"#);
    assert_eq!(meta.title.as_deref(), Some("&lt;script&gt;"));
}

#[test]
fn resolves_a_relative_image_against_a_page_with_no_path() {
    assert_eq!(
        absolute_url("https://example.com", "card.png").as_deref(),
        Some("https://example.com/card.png"),
    );
}

#[test]
fn a_redirect_target_is_resolved_against_the_url_that_sent_it() {
    assert_eq!(
        absolute_url("https://example.com/a/b", "/next/").as_deref(),
        Some("https://example.com/next/"),
    );
}

#[test]
fn only_an_allowlisted_media_type_can_become_a_data_uri() {
    // A header of `image/png,<svg …>` would otherwise end the media type at
    // the comma and make the rest of it the payload.
    for declared in [
        "image/png,<svg onload=alert(1)>",
        "image/svg+xml,<svg/>",
        "text/html",
        "image/",
        "",
    ] {
        assert!(
            !IMAGE_MIMES.contains(&declared),
            "{declared:?} must not be accepted",
        );
    }
    assert!(IMAGE_MIMES.contains(&"image/png"));
}

#[test]
fn resolves_a_root_relative_image() {
    assert_eq!(
        absolute_url("https://example.com/a/b?x=1", "/card.png").as_deref(),
        Some("https://example.com/card.png"),
    );
}

#[test]
fn resolves_a_document_relative_image() {
    assert_eq!(
        absolute_url("https://example.com/a/b.html", "card.png").as_deref(),
        Some("https://example.com/a/card.png"),
    );
}

#[test]
fn resolves_a_scheme_relative_image() {
    assert_eq!(
        absolute_url("https://example.com/a", "//cdn.example.com/c.png").as_deref(),
        Some("https://cdn.example.com/c.png"),
    );
}

#[test]
fn leaves_an_absolute_image_alone() {
    assert_eq!(
        absolute_url("https://example.com/a", "https://cdn.io/c.png").as_deref(),
        Some("https://cdn.io/c.png"),
    );
}

#[test]
fn refuses_a_scheme_that_is_not_http() {
    for url in [
        "file:///etc/passwd",
        "ftp://example.com",
        "javascript:alert(1)",
        "/tmp/x",
    ] {
        assert!(preview(url.into()).is_err(), "{url} should be refused");
    }
}

#[test]
fn a_stack_exchange_question_is_recognised_on_every_site_of_the_family() {
    for (url, site, id) in [
        (
            "https://stackoverflow.com/questions/11227809/why-is-it-faster",
            "stackoverflow.com",
            11227809,
        ),
        ("https://www.superuser.com/q/42", "superuser.com", 42),
        (
            "https://unix.stackexchange.com/questions/7?tab=votes",
            "unix.stackexchange.com",
            7,
        ),
        (
            "https://ru.stackoverflow.com/questions/9#answer",
            "ru.stackoverflow.com",
            9,
        ),
    ] {
        let question = stack_exchange_question(url).expect(url);
        assert_eq!((question.site.as_str(), question.id), (site, id), "{url}");
    }
}

#[test]
fn only_a_question_page_goes_to_the_stack_exchange_api() {
    for url in [
        "https://stackoverflow.com/users/87234/someone",
        "https://stackoverflow.com/questions/tagged/rust",
        "https://stackoverflow.com/",
        "https://notstackoverflow.com/questions/1",
        "https://stackoverflow.com.evil.example/questions/1",
        "https://evil.example#.stackoverflow.com/questions/1",
        "https://evil.example?.stackexchange.com/questions/1",
        "https://user@unix.stackexchange.com/questions/1",
        "https://a&site=b.stackexchange.com/questions/1",
    ] {
        assert!(stack_exchange_question(url).is_none(), "{url}");
    }
}

#[test]
fn a_stack_exchange_answer_becomes_a_title_and_its_facts() {
    let meta = parse_stack_exchange(
        r#"{"items":[{"title":"Why is a &quot;sorted&quot; array faster?","score":27546,"answer_count":25,"tags":["java","c++"]}]}"#,
    )
    .unwrap();
    assert_eq!(
        meta.title.as_deref(),
        Some("Why is a \"sorted\" array faster?")
    );
    assert_eq!(
        meta.description.as_deref(),
        Some("27546 votes · 25 answers · java, c++"),
    );
}

#[test]
fn a_question_the_api_does_not_return_is_no_preview() {
    assert!(parse_stack_exchange(r#"{"items":[]}"#).is_none());
    assert!(parse_stack_exchange("not json").is_none());
}

#[test]
fn a_microdata_image_is_used_when_open_graph_names_none() {
    let meta = parse_meta(
        r#"<head><meta content="/images/g.png" itemprop="image"><title>Google</title></head>"#,
    );
    assert_eq!(meta.image_data_url.as_deref(), Some("/images/g.png"));
}

#[test]
fn open_graph_still_wins_over_a_microdata_image_written_first() {
    let meta = parse_meta(
        r#"<head><meta itemprop="image" content="/micro.png"><meta property="og:image" content="/og.png"></head>"#,
    );
    assert_eq!(meta.image_data_url.as_deref(), Some("/og.png"));
}

#[test]
fn a_page_with_no_image_meta_falls_back_to_its_icon() {
    let meta = parse_meta(
        r#"<head><link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/touch.png"></head>"#,
    );
    assert_eq!(meta.image_data_url.as_deref(), Some("/touch.png"));
    let shortcut = parse_meta(r#"<head><link rel="shortcut icon" href="/f.ico"></head>"#);
    assert_eq!(shortcut.image_data_url.as_deref(), Some("/f.ico"));
}

#[test]
fn numeric_entities_are_decoded_and_a_bare_ampersand_is_kept() {
    assert_eq!(
        decode_entities("World&#x2019;s &#8212; Q&amp;A &amp;lt; R&D &bogus;"),
        "World\u{2019}s \u{2014} Q&A &lt; R&D &bogus;",
    );
}

#[test]
fn a_stack_exchange_site_is_drawn_with_its_own_icon() {
    for (site, slug) in [
        ("stackoverflow.com", "stackoverflow"),
        ("unix.stackexchange.com", "unix"),
        ("mathoverflow.net", "mathoverflow"),
        ("ru.stackoverflow.com", "ru"),
        ("meta.stackoverflow.com", "stackoverflowmeta"),
        ("unix.meta.stackexchange.com", "unixmeta"),
        ("meta.stackexchange.com", "stackexchangemeta"),
        ("meta.superuser.com", "superusermeta"),
        ("meta.mathoverflow.net", "mathoverflowmeta"),
        ("ru.meta.stackoverflow.com", "rumeta"),
        ("superuser.com", "superuser"),
    ] {
        assert_eq!(
            site_icon(site),
            format!("https://cdn.sstatic.net/Sites/{slug}/Img/apple-touch-icon.png"),
        );
    }
}

#[test]
fn an_answer_link_is_previewed_through_its_question() {
    let answer = stack_exchange_question("https://stackoverflow.com/a/11227902/1").unwrap();
    assert!(answer.answer);
    let question = stack_exchange_question("https://stackoverflow.com/q/11227809").unwrap();
    assert!(!question.answer);
    assert_eq!(
        question_of_answer(r#"{"items":[{"answer_id":11227902,"question_id":11227809}]}"#),
        Some(11227809),
    );
    assert_eq!(question_of_answer(r#"{"items":[]}"#), None);
}

#[test]
fn a_page_query_is_not_a_directory() {
    assert_eq!(
        absolute_url("https://x.com/a?next=/b/c", "card.png").as_deref(),
        Some("https://x.com/card.png"),
    );
    assert_eq!(
        absolute_url("https://x.com/list/page?p=1", "?p=2").as_deref(),
        Some("https://x.com/list/page?p=2"),
    );
}

#[test]
fn a_scheme_in_capitals_is_still_the_web() {
    assert!(is_web("HTTPS://Example.com/"));
    assert!(is_web("Http://example.com"));
    assert!(!is_web("ftp://example.com"));
    assert!(!is_web("h"));
}

#[test]
fn a_page_of_bare_ampersands_decodes_to_itself() {
    let text = "&".repeat(100_000);
    assert_eq!(decode_entities(&text), text);
}

#[test]
fn a_fragment_keeps_the_page_query_and_a_data_image_is_not_a_page() {
    assert_eq!(
        absolute_url("https://a.com/x/y?q=1#old", "#top").as_deref(),
        Some("https://a.com/x/y?q=1#top"),
    );
    assert_eq!(
        absolute_url("https://a.com/x", "data:image/png;base64,AA"),
        None
    );
    assert_eq!(absolute_url("https://a.com/x", "javascript:alert(1)"), None);
    assert_eq!(
        absolute_url("https://a.com/x/", "img.png?v=a:b").as_deref(),
        Some("https://a.com/x/img.png?v=a:b"),
    );
}

#[test]
fn a_zero_padded_numeric_entity_still_decodes() {
    assert_eq!(decode_entities("&#x00000041;&#0000000039;"), "A'");
}

#[test]
fn a_title_cannot_reorder_itself_or_carry_control_characters() {
    assert_eq!(decode_entities("Safe &#x202E;txt.exe"), "Safe txt.exe");
    assert_eq!(decode_entities("a\u{2066}b\u{200F}c"), "abc");
    assert_eq!(decode_entities("line&#10;break&#0;end"), "line break end");
}
