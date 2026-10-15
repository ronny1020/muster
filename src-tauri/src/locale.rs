//! The languages the OS prefers, for the interface's "Match system" setting.
//!
//! Asked here rather than in the webview because WKWebView does not pass the
//! OS list on: `navigator.languages` holds only the bundle's own localization,
//! which is `en-US` for an app that declares none, whatever the Mac is set to.

/// The OS's preferred languages as BCP 47 tags, most preferred first, or none
/// when the platform reports none.
#[tauri::command]
pub fn system_locales() -> Vec<String> {
    preferred(sys_locale::get_locales())
}

/// Trims each tag and drops the blank ones a platform can report, which name
/// no language.
fn preferred(tags: impl Iterator<Item = String>) -> Vec<String> {
    tags.map(|tag| tag.trim().to_owned())
        .filter(|tag| !tag.is_empty())
        .collect()
}

#[cfg(test)]
#[path = "locale_tests.rs"]
mod tests;
