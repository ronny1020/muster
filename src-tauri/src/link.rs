//! Preview cards for URLs printed in terminal output.
//!
//! This is the one place Muster reaches the network, so the rules are strict.
//! The fetch happens only when the user clicks a link — never as output
//! scrolls past — because output is written by an agent, and a page fetched
//! automatically would turn any printed URL into a tracking pixel. A private
//! or loopback address is refused outright: a link the user did not choose
//! must not become a probe of their own network.
//!
//! The image travels back as a `data:` URI, so the webview still fetches
//! nothing itself.
//!
//! The address check is not airtight, and the gap is known: it validates the
//! URL that was clicked, and `ureq` then follows redirects without consulting
//! it again.

use std::{
    io::Read,
    net::{IpAddr, ToSocketAddrs},
    time::Duration,
};

use base64::Engine;

/// What a page says about itself.
#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkMeta {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    /// `data:<mime>;base64,…` for the preview image, when the page has one and
    /// it could be fetched.
    pub image_data_url: Option<String>,
}

const TIMEOUT: Duration = Duration::from_secs(8);
/// Caps the response. Note this *rejects* a larger body rather than
/// truncating it, so a page whose HTML exceeds this yields an error even when
/// its `<head>` arrived intact.
const MAX_HTML_BYTES: u64 = 512 * 1024;
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// Runs on the blocking pool, not an async worker.
///
/// `(async)` alone would put this whole body — an 8-second timeout plus a
/// `getaddrinfo` with no timeout at all — on a runtime worker, and enough
/// concurrent previews would starve every other command, typing included.
#[tauri::command]
pub async fn link_preview(url: String) -> Result<LinkMeta, String> {
    tauri::async_runtime::spawn_blocking(move || preview(url))
        .await
        .map_err(|error| error.to_string())?
}

fn preview(url: String) -> Result<LinkMeta, String> {
    let host = public_host(&url)?;
    let html = fetch_text(&url).map_err(|error| format!("could not read {host}: {error}"))?;

    let mut meta = parse_meta(&html);
    meta.url = url.clone();
    meta.image_data_url = meta
        .image_data_url
        .as_deref()
        .and_then(|image| absolute_url(&url, image))
        // A missing image is not an error: the card renders without it.
        .and_then(|image| public_host(&image).ok().map(|_| image))
        .and_then(|image| fetch_image(&image).ok());

    Ok(meta)
}

/// The host of an `http`/`https` URL that resolves to a public address.
///
/// Refusing loopback and private ranges is what keeps a printed link from
/// reaching a router admin page or a cloud metadata endpoint.
fn public_host(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| "only http and https URLs can be previewed".to_string())?;

    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let (name, port) = split_port(host);
    if name.is_empty() {
        return Err("no host in URL".into());
    }

    let addresses = (name, port)
        .to_socket_addrs()
        .map_err(|error| format!("{name} did not resolve: {error}"))?;
    let mut any = false;
    for address in addresses {
        any = true;
        if !is_public(address.ip()) {
            return Err(format!("{name} resolves to a private address"));
        }
    }
    if !any {
        return Err(format!("{name} did not resolve"));
    }
    Ok(name.to_string())
}

/// Splits `host:port`, leaving a bracketed IPv6 literal intact.
fn split_port(host: &str) -> (&str, u16) {
    if let Some(end) = host.strip_prefix('[').and_then(|rest| rest.find(']')) {
        let name = &host[1..=end];
        let port = host[end + 2..]
            .trim_start_matches(':')
            .parse()
            .unwrap_or(443);
        return (name, port);
    }
    match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => {
            (name, port.parse().unwrap_or(443))
        }
        _ => (host, 443),
    }
}

/// Whether an address is out on the internet rather than inside this network.
pub fn is_public(ip: IpAddr) -> bool {
    // `::ffff:127.0.0.1` is loopback wearing a v6 costume: its `is_loopback`
    // is false and it matches neither `fc00::/7` nor `fe80::/10`, yet a
    // dual-stack connect lands on 127.0.0.1. Canonicalising first is what
    // makes the v4 rules below apply to it.
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                // 100.64.0.0/10, carrier NAT — also 169.254 metadata neighbours.
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
                // 192.0.0.0/24 and 198.18.0.0/15, IETF protocol assignments.
                || v4.octets()[0..3] == [192, 0, 0]
                || (v4.octets()[0] == 198 && (18..20).contains(&v4.octets()[1]))
                // Multicast, benchmarking relays and the reserved top block —
                // none of them is a web server, and all were classified public.
                || v4.is_multicast()
                || v4.octets()[0] >= 240
                || v4.octets()[0..3] == [192, 88, 99])
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 unique-local and fe80::/10 link-local.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.is_multicast()
                // 2002::/16 6to4 and 2001::/32 Teredo both tunnel to v4.
                || v6.segments()[0] == 0x2002
                || (v6.segments()[0] == 0x2001 && v6.segments()[1] == 0))
        }
    }
}

/// Hops a redirect chain is allowed to take before the preview gives up.
const MAX_HOPS: usize = 5;

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        // Zero means "hand me the 3xx" rather than "error": ureq follows a
        // `Location` with no address policy of its own, so following has to
        // happen here, where each hop can be checked.
        .max_redirects(0)
        .build()
        .into()
}

/// A `Location` header resolved against the URL that returned it.
fn redirect_target(response: &ureq::http::Response<ureq::Body>, from: &str) -> Option<String> {
    if !response.status().is_redirection() {
        return None;
    }
    let location = response.headers().get("location")?.to_str().ok()?;
    absolute_url(from, location)
}

/// Fetches `url`, validating the address of **every** hop.
///
/// Validating only the first would be no protection at all: a page on a public
/// host can answer `302 Location: http://169.254.169.254/…` and the fetch
/// would follow it straight onto the loopback or metadata address the check
/// exists to refuse.
fn fetch_following_redirects(
    url: &str,
    accept: &str,
) -> Result<(ureq::http::Response<ureq::Body>, String), String> {
    let mut current = url.to_string();
    for _ in 0..MAX_HOPS {
        public_host(&current)?;
        let response = agent()
            .get(&current)
            // Some sites serve their og: tags only to something browser-shaped.
            .header(
                "User-Agent",
                "Mozilla/5.0 (compatible; Muster link preview)",
            )
            .header("Accept", accept)
            .call()
            .map_err(|error| error.to_string())?;

        match redirect_target(&response, &current) {
            Some(next) => current = next,
            None => return Ok((response, current)),
        }
    }
    Err(format!("{url} redirected more than {MAX_HOPS} times"))
}

fn fetch_text(url: &str) -> Result<String, String> {
    let mut response = agent()
        .get(url)
        // Some sites serve their og: tags only to something browser-shaped.
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; Muster link preview)",
        )
        .header("Accept", "text/html,application/xhtml+xml")
        .call()
        .map_err(|error| error.to_string())?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.is_empty() && !content_type.contains("html") {
        return Err(format!("not a web page ({content_type})"));
    }

    // Truncate rather than refuse: `limit()` errors on a larger body, which
    // threw away pages whose `<head>` had already arrived in full.
    let mut html = String::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_HTML_BYTES)
        .read_to_string(&mut html)
        .map_err(|error| error.to_string())?;
    Ok(html)
}

/// Media types a preview image may claim.
///
/// An allowlist, not a prefix test: the value is interpolated into a `data:`
/// URI, and a header of `image/png,<svg onload=…>` would end the media type at
/// the comma and make the rest of it the payload.
const IMAGE_MIMES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/svg+xml",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

fn fetch_image(url: &str) -> Result<String, String> {
    let (mut response, _final_url) = fetch_following_redirects(url, "image/*")?;
    let declared = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mime = IMAGE_MIMES
        .iter()
        .find(|allowed| **allowed == declared)
        .ok_or_else(|| format!("not a previewable image type ({declared})"))?;

    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_IMAGE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Resolves a page-relative image reference against the page's own URL.
pub fn absolute_url(page: &str, reference: &str) -> Option<String> {
    if reference.starts_with("http://") || reference.starts_with("https://") {
        return Some(reference.to_string());
    }
    let scheme_end = page.find("://")? + 3;
    let origin_end = page[scheme_end..]
        .find('/')
        .map(|index| scheme_end + index)
        .unwrap_or(page.len());

    if reference.starts_with("//") {
        return Some(format!("{}:{reference}", &page[..scheme_end - 3]));
    }
    if reference.starts_with('/') {
        return Some(format!("{}{reference}", &page[..origin_end]));
    }
    // With no path at all (`https://example.com`) the origin *is* the
    // directory, so a relative reference hangs off its root.
    let directory = match page.rfind('/').filter(|at| *at >= origin_end) {
        Some(at) => page[..at + 1].to_string(),
        None => format!("{}/", &page[..origin_end]),
    };
    Some(format!("{directory}{reference}"))
}

/// Reads the metadata a page publishes about itself: Open Graph first, then
/// Twitter's equivalents, then the plain `<title>` and description.
///
/// Hand-parsed rather than run through an HTML library: only `<meta>` and
/// `<title>` matter here, and a real parser would be a large dependency for
/// two tags.
pub fn parse_meta(html: &str) -> LinkMeta {
    let mut meta = LinkMeta::default();
    // Case-insensitive, or `</HEAD>` lets the body's tags override the head's.
    let lower = html.to_ascii_lowercase();
    let head = lower
        .find("</head>")
        .map(|end| &html[..end])
        .unwrap_or(html);

    for tag in tags(head, "meta") {
        let key = attribute(tag, "property")
            .or_else(|| attribute(tag, "name"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let Some(content) = attribute(tag, "content").as_deref().map(decode_entities) else {
            continue;
        };
        if content.is_empty() {
            continue;
        }

        // First writer wins for og:, so a later twitter: tag cannot override it.
        match key.as_str() {
            "og:title" => meta.title = Some(content),
            "twitter:title" => meta.title = meta.title.or(Some(content)),
            "og:description" => meta.description = Some(content),
            "description" | "twitter:description" => {
                meta.description = meta.description.or(Some(content))
            }
            "og:site_name" => meta.site_name = Some(content),
            "og:image" | "og:image:secure_url" | "og:image:url" => {
                meta.image_data_url = Some(content)
            }
            "twitter:image" => meta.image_data_url = meta.image_data_url.or(Some(content)),
            _ => {}
        }
    }

    if meta.title.is_none() {
        meta.title = title_text(head);
    }
    meta
}

/// The text inside `<title>…</title>`. Separate from [`tags`], which yields a
/// tag's attributes — a title's value is its content, not an attribute.
fn title_text(head: &str) -> Option<String> {
    let lower = head.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let after = open + lower[open..].find('>')? + 1;
    let close = lower[after..].find("</title>")? + after;
    Some(decode_entities(&head[after..close])).filter(|text| !text.is_empty())
}

/// The text of each `<name …>` tag in `html`, opening bracket excluded.
fn tags<'a>(html: &'a str, name: &'a str) -> impl Iterator<Item = &'a str> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    std::iter::from_fn(move || {
        loop {
            let at = lower[from..].find(&format!("<{name}"))? + from;
            let after = at + name.len() + 1;
            // `<metadata>` must not match `<meta>`.
            let boundary = lower[after..].chars().next()?;
            let end = lower[at..].find('>').map(|index| at + index)?;
            from = end + 1;
            if boundary.is_whitespace() || boundary == '>' || boundary == '/' {
                return Some(&html[after..end]);
            }
        }
    })
}

/// The value of `key` in an attribute list, quoted with either kind.
fn attribute(tag: &str, key: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    loop {
        let at = lower[from..].find(key)? + from;
        // Only whitespace or the tag's own start separates attributes. Treating
        // a quote as a boundary let a key inside a *value* win, so
        // `alt="content=stolen"` was read as the content.
        let before_is_boundary = at == 0
            || lower[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        let rest = lower[at + key.len()..].trim_start();
        from = at + key.len();
        if !before_is_boundary || !rest.starts_with('=') {
            continue;
        }

        let value = tag[at + key.len()..]
            .trim_start()
            .trim_start_matches('=')
            .trim_start();
        let quote = value.chars().next()?;
        return if quote == '"' || quote == '\'' {
            value[1..].find(quote).map(|end| value[1..=end].to_string())
        } else {
            Some(
                value
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches('/')
                    .to_string(),
            )
        };
    }
}

/// The handful of entities that actually appear in `content` attributes.
fn decode_entities(text: &str) -> String {
    // `&amp;` goes last: decoding it first turns `&amp;lt;` into `&lt;` and
    // then into `<`, which is one decode too many.
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
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
        let meta =
            parse_meta(r#"<head><metadata property="og:title" content="no"></metadata></head>"#);
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
        let meta = parse_meta(
            r#"<head><meta property="og:title" content="&amp;lt;script&amp;gt;"></head>"#,
        );
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
}
