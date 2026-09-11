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
fn an_ipv4_mapped_ipv6_address_is_not_public() {
    // A dual-stack connect to these lands on the v4 address, so the v6
    // rules alone let loopback and the metadata endpoint through.
    for mapped in [
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "::ffff:10.0.0.1",
        "::ffff:192.168.1.1",
    ] {
        assert!(
            !is_public(mapped.parse().unwrap()),
            "{mapped} must not count as public",
        );
    }
}

#[test]
fn multicast_and_reserved_addresses_are_not_public() {
    for reserved in ["224.0.0.1", "239.1.2.3", "240.0.0.1", "255.255.255.254"] {
        assert!(
            !is_public(reserved.parse().unwrap()),
            "{reserved} must not count as public",
        );
    }
}

#[test]
fn a_real_public_address_is_still_allowed() {
    // The guard has to stay useful, not just strict.
    assert!(is_public("93.184.216.34".parse().unwrap()));
    assert!(is_public("2606:2800:220:1::".parse().unwrap()));
}

#[test]
fn a_redirect_target_is_resolved_against_the_url_that_sent_it() {
    // The hop has to become an absolute URL before it can be validated.
    assert_eq!(
        absolute_url("https://example.com/a/b", "/latest/meta-data/").as_deref(),
        Some("https://example.com/latest/meta-data/"),
    );
    assert_eq!(
        absolute_url("https://example.com/a/b", "http://169.254.169.254/x").as_deref(),
        Some("http://169.254.169.254/x"),
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
        assert!(public_host(url).is_err(), "{url} should be refused");
    }
}

#[test]
fn refuses_loopback_and_private_addresses() {
    for url in [
        "http://127.0.0.1/",
        "http://localhost:1420/",
        "http://10.0.0.5/",
        "http://192.168.1.1/admin",
        "http://172.16.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
    ] {
        assert!(public_host(url).is_err(), "{url} should be refused");
    }
}

#[test]
fn classifies_addresses() {
    assert!(is_public("93.184.216.34".parse().unwrap()));
    assert!(is_public("2606:2800:220:1::".parse().unwrap()));
    assert!(!is_public("127.0.0.1".parse().unwrap()));
    assert!(!is_public("169.254.169.254".parse().unwrap()));
    assert!(!is_public("100.100.0.1".parse().unwrap()));
    assert!(!is_public("fd00::1".parse().unwrap()));
    assert!(!is_public("fe80::1".parse().unwrap()));
}

#[test]
fn splits_a_port_but_keeps_an_ipv6_literal_whole() {
    assert_eq!(split_port("example.com"), ("example.com", 443));
    assert_eq!(split_port("example.com:8080"), ("example.com", 8080));
    assert_eq!(split_port("[::1]:9000"), ("::1", 9000));
    assert_eq!(split_port("[::1]"), ("::1", 443));
}
