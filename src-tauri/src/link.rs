//! The preview a link's hover label shows: the page's title, description and
//! image.
//!
//! Fetched on hover, for any `http` or `https` address, local ones included —
//! the user's call, made knowingly: pointing at a link an agent printed makes
//! a request that page can see, and a printed `localhost` address is fetched
//! like any other. Opening a link never waits on any of this.
//!
//! The image travels back as a `data:` URI, so the webview still fetches
//! nothing itself. The time and size caps are what keep a slow or huge page
//! from leaving the label loading forever or a download held in memory.

use std::{
    io::Read,
    time::{Duration, Instant},
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

/// The whole preview's budget — every redirect, the page and its image
/// share it, so no chain of slow hops leaves the label loading for longer.
const TIMEOUT: Duration = Duration::from_secs(8);
const TOO_SLOW: &str = "the site took too long to send its title";
/// How much of a page is read; the metadata is in its `<head>`.
const MAX_HTML_BYTES: u64 = 512 * 1024;
/// A thumbnail's worth: the label draws it at 80×56, and every cached preview
/// keeps its image in the webview.
const MAX_IMAGE_BYTES: u64 = 1024 * 1024;

/// Runs on the blocking pool: the fetch can take the whole timeout, and on a
/// runtime worker enough concurrent previews would starve every other
/// command, typing included.
#[tauri::command]
pub async fn link_preview(url: String) -> Result<LinkMeta, String> {
    tauri::async_runtime::spawn_blocking(move || preview(url))
        .await
        .map_err(|_| "the preview could not be finished".to_string())?
}

fn preview(url: String) -> Result<LinkMeta, String> {
    if !is_web(&url) {
        return Err("only http and https URLs can be previewed".into());
    }
    let deadline = Instant::now() + TIMEOUT;
    if let Some(question) = stack_exchange_question(&url) {
        return stack_exchange_preview(url, question, deadline);
    }
    let (html, page) = fetch_text(&url, deadline)?;

    let mut meta = parse_meta(&html);
    meta.url = url;
    meta.image_data_url = meta
        .image_data_url
        .as_deref()
        // Relative to the page the redirects ended on, not the link.
        .and_then(|image| absolute_url(&page, image))
        .filter(|image| is_web(image))
        // A missing image is not an error: the label shows without it.
        .and_then(|image| fetch_image(&image, deadline).ok());

    Ok(meta)
}

/// An `http` or `https` URL, the scheme matched in any case as the
/// frontend's `isWebUrl` matches it.
fn is_web(url: &str) -> bool {
    let has = |scheme: &str| {
        url.get(..scheme.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(scheme))
    };
    has("https://") || has("http://")
}

/// Hops a redirect chain is allowed to take before the preview gives up.
const MAX_HOPS: usize = 5;

fn agent(deadline: Instant) -> Result<ureq::Agent, String> {
    let left = deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or(TOO_SLOW)?;
    Ok(ureq::Agent::config_builder()
        .timeout_global(Some(left))
        // Zero means "hand me the 3xx" rather than "error", so the chain is
        // followed here, where its length is bounded and its end is known —
        // a page's relative image is relative to where it ended up.
        .max_redirects(0)
        .build()
        .into())
}

/// A `Location` header resolved against the URL that returned it.
fn redirect_target(response: &ureq::http::Response<ureq::Body>, from: &str) -> Option<String> {
    if !response.status().is_redirection() {
        return None;
    }
    let location = response.headers().get("location")?.to_str().ok()?;
    absolute_url(from, location)
}

/// Fetches `url`, following at most `MAX_HOPS` redirects, and answers the
/// response with the URL it came from.
fn fetch_following_redirects(
    url: &str,
    accept: &str,
    deadline: Instant,
) -> Result<(ureq::http::Response<ureq::Body>, String), String> {
    let mut current = url.to_string();
    // One request for the link itself, then one per redirect.
    for _ in 0..=MAX_HOPS {
        let response = agent(deadline)?
            .get(&current)
            // Some sites serve their og: tags only to something browser-shaped.
            .header(
                "User-Agent",
                "Mozilla/5.0 (compatible; Muster link preview)",
            )
            .header("Accept", accept)
            .call()
            .map_err(describe)?;

        match redirect_target(&response, &current) {
            Some(next) => current = next,
            None => return Ok((response, current)),
        }
    }
    Err(format!("the site redirected more than {MAX_HOPS} times"))
}

/// The reason the label shows when a fetch fails, in a few words that say
/// what was asked for: a page's title and picture, nothing more.
fn describe(error: ureq::Error) -> String {
    match error {
        ureq::Error::StatusCode(403) => "this site does not allow link previews (403)".into(),
        ureq::Error::StatusCode(code) => {
            format!("the site answered {code} when asked for its title")
        }
        ureq::Error::Timeout(_) => TOO_SLOW.into(),
        ureq::Error::HostNotFound => "the site's address could not be found".into(),
        ureq::Error::ConnectionFailed | ureq::Error::Io(_) => {
            "the site could not be reached".into()
        }
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => {
            "the site's secure connection could not be set up".into()
        }
        _ => "the site could not be asked for its title".into(),
    }
}

/// The page's HTML, and the URL it was finally served from.
fn fetch_text(url: &str, deadline: Instant) -> Result<(String, String), String> {
    let (mut response, page) =
        fetch_following_redirects(url, "text/html,application/xhtml+xml", deadline)?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.is_empty() && !content_type.contains("html") {
        return Err(format!("the link is a file, not a page ({content_type})"));
    }
    Ok((read_text(&mut response)?, page))
}

/// Up to `MAX_HTML_BYTES` of a body as text. Lossy, because a page in
/// another encoding, or a cap that lands inside a character, still has its
/// ASCII tags intact.
fn read_text(response: &mut ureq::http::Response<ureq::Body>) -> Result<String, String> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(MAX_HTML_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| "the page stopped arriving partway".to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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

fn fetch_image(url: &str, deadline: Instant) -> Result<String, String> {
    let (mut response, _final_url) = fetch_following_redirects(url, "image/*", deadline)?;
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

/// A Stack Exchange question a URL names: its site's domain and its id.
pub struct Question {
    site: String,
    id: u64,
    /// The id is an answer's, and the question is looked up through it.
    answer: bool,
}

/// Stack Exchange answers every non-browser fetch of a page with a
/// Cloudflare challenge, so its questions are read from the site's own
/// public API instead — the one source of their title that answers.
pub fn stack_exchange_question(url: &str) -> Option<Question> {
    let rest = url.split_once("://")?.1;
    let (host, path) = rest.split_once('/')?;
    let host = host.to_ascii_lowercase();
    // Read off the raw string, so nothing but a plain host name may pass: a
    // `#`, `@` or `?` would put a different host in front of the suffix test.
    let plain = |byte: u8| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
    };
    if !host.bytes().all(plain) {
        return None;
    }
    let site = host.strip_prefix("www.").unwrap_or(&host);
    let parent = site.strip_prefix("meta.").unwrap_or(site);
    let family = matches!(
        parent,
        "stackoverflow.com"
            | "superuser.com"
            | "serverfault.com"
            | "askubuntu.com"
            | "mathoverflow.net"
            | "stackapps.com"
    ) || site.ends_with(".stackoverflow.com")
        || site.ends_with(".stackexchange.com");
    if !family {
        return None;
    }
    let mut parts = path.split(['/', '?', '#']);
    let answer = match parts.next()? {
        "questions" | "q" => false,
        "a" | "answers" => true,
        _ => return None,
    };
    let id = parts.next()?.parse().ok()?;
    Some(Question {
        site: site.to_string(),
        id,
        answer,
    })
}

fn stack_exchange_preview(
    url: String,
    question: Question,
    deadline: Instant,
) -> Result<LinkMeta, String> {
    let api = |route: String| stack_exchange_api(&route, &question.site, deadline);
    let id = if question.answer {
        question_of_answer(&api(format!("answers/{}", question.id))?)
            .ok_or("Stack Exchange has no such answer")?
    } else {
        question.id
    };
    let mut meta = parse_stack_exchange(&api(format!("questions/{id}"))?)
        .ok_or("Stack Exchange has no such question")?;
    meta.image_data_url = fetch_image(&site_icon(&question.site), deadline).ok();
    meta.url = url;
    meta.site_name = Some(question.site);
    Ok(meta)
}

fn stack_exchange_api(route: &str, site: &str, deadline: Instant) -> Result<String, String> {
    let api = format!("https://api.stackexchange.com/2.3/{route}?site={site}");
    let (mut response, _) = fetch_following_redirects(&api, "application/json", deadline)?;
    read_text(&mut response)
}

/// The question an answer belongs to, from the API's answer for it.
pub fn question_of_answer(json: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value.get("items")?.get(0)?.get("question_id")?.as_u64()
}

/// The site's own icon, from the CDN that serves it without a challenge —
/// the askers' avatars sit behind the same one the pages do.
///
/// The CDN files a site under its own name without the network's domain, and
/// a meta site under its parent's name with `meta` appended: `unix.meta.
/// stackexchange.com` is `unixmeta`, `meta.superuser.com` is `superusermeta`.
pub fn site_icon(site: &str) -> String {
    let name = site.trim_end_matches(".com").trim_end_matches(".net");
    let mut parts: Vec<&str> = name.split('.').collect();
    let slug = match parts.as_slice() {
        ["meta", parent] => format!("{parent}meta"),
        _ => {
            if parts.len() > 1 && matches!(parts.last(), Some(&"stackexchange" | &"stackoverflow"))
            {
                parts.pop();
            }
            parts.concat()
        }
    };
    format!("https://cdn.sstatic.net/Sites/{slug}/Img/apple-touch-icon.png")
}

/// Title, and votes, answers and tags as the description, from the API's
/// answer for one question.
pub fn parse_stack_exchange(json: &str) -> Option<LinkMeta> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let item = value.get("items")?.get(0)?;
    let title = decode_entities(item.get("title")?.as_str()?);
    let count = |key: &str| item.get(key).and_then(serde_json::Value::as_i64);
    let tags: Vec<&str> = item
        .get("tags")
        .and_then(serde_json::Value::as_array)
        .map(|tags| tags.iter().filter_map(serde_json::Value::as_str).collect())
        .unwrap_or_default();

    let mut facts = Vec::new();
    if let Some(score) = count("score") {
        facts.push(format!("{score} votes"));
    }
    if let Some(answers) = count("answer_count") {
        facts.push(format!("{answers} answers"));
    }
    if !tags.is_empty() {
        facts.push(tags.join(", "));
    }
    Some(LinkMeta {
        title: Some(title),
        description: (!facts.is_empty()).then(|| facts.join(" · ")),
        ..LinkMeta::default()
    })
}

/// Resolves a page-relative image reference against the page's own URL.
pub fn absolute_url(page: &str, reference: &str) -> Option<String> {
    if is_web(reference) {
        return Some(reference.to_string());
    }
    // Any other scheme — `data:`, `javascript:` — names no page to fetch.
    let scheme = reference.find(':');
    if scheme.is_some_and(|at| !reference[..at].contains(['/', '?', '#'])) {
        return None;
    }
    let page = &page[..page.find('#').unwrap_or(page.len())];
    if reference.starts_with('#') {
        return Some(format!("{page}{reference}"));
    }
    // The page's own query is never part of a directory.
    let page = &page[..page.find('?').unwrap_or(page.len())];
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
    if reference.starts_with('?') {
        return Some(format!("{page}{reference}"));
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

    let mut microdata_image = None;
    for tag in tags(head, "meta") {
        let key = attribute(tag, "property")
            .or_else(|| attribute(tag, "name"))
            .or_else(|| attribute(tag, "itemprop").map(|key| format!("itemprop:{key}")))
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
            // schema.org microdata, which Google's own pages publish instead.
            "itemprop:image" => microdata_image = microdata_image.or(Some(content)),
            _ => {}
        }
    }

    if meta.title.is_none() {
        meta.title = title_text(head);
    }
    meta.image_data_url = meta
        .image_data_url
        .or(microdata_image)
        .or_else(|| linked_image(head));
    meta
}

/// The picture a page names with a `<link>`, best first: one it offers for
/// sharing, then its home-screen icon, then its favicon.
fn linked_image(head: &str) -> Option<String> {
    let links: Vec<(String, String)> = tags(head, "link")
        .filter_map(|tag| {
            let rel = attribute(tag, "rel")?.to_ascii_lowercase();
            let href = decode_entities(&attribute(tag, "href")?);
            (!href.is_empty()).then_some((rel, href))
        })
        .collect();
    let named = |wanted: &[&str]| {
        links
            .iter()
            .find(|(rel, _)| rel.split_whitespace().any(|word| wanted.contains(&word)))
            .map(|(_, href)| href.clone())
    };
    named(&["image_src"])
        .or_else(|| named(&["apple-touch-icon", "apple-touch-icon-precomposed"]))
        .or_else(|| named(&["icon"]))
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

/// Decodes the named entities that appear in titles and descriptions, and
/// every numeric one, in a single pass so `&amp;lt;` stays `&lt;`.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        // Looking only this far keeps a page of bare `&`s linear, and still
        // reaches a numeric entity padded with leading zeros.
        let decoded = rest.as_bytes()[..rest.len().min(32)]
            .iter()
            .position(|byte| *byte == b';')
            .and_then(|end| entity(&rest[1..end]).map(|ch| (ch, end)));
        match decoded {
            Some((ch, end)) => {
                out.push(ch);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.chars()
        .filter_map(displayable)
        .collect::<String>()
        .trim()
        .to_string()
}

/// A character as the label may draw it: a control character becomes a
/// space, and a direction override is dropped, since either lets a page
/// make its title read as something other than what it says.
fn displayable(ch: char) -> Option<char> {
    match ch {
        '\u{200E}'
        | '\u{200F}'
        | '\u{061C}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2066}'..='\u{2069}' => None,
        _ if ch.is_control() => Some(' '),
        _ => Some(ch),
    }
}

/// The character an entity's name (between `&` and `;`) stands for.
fn entity(name: &str) -> Option<char> {
    let code = match name.strip_prefix('#') {
        Some(hex) if hex.starts_with(['x', 'X']) => u32::from_str_radix(&hex[1..], 16).ok()?,
        Some(decimal) => decimal.parse().ok()?,
        None => {
            return match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => None,
            };
        }
    };
    char::from_u32(code)
}

#[cfg(test)]
#[path = "link_tests.rs"]
mod tests;
