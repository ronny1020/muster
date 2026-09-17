use super::*;

/// A store file of its own, removed with the test. `state_read` and
/// `state_write` are thin wrappers around `load_from` and `save_to`, and an
/// `AppHandle` cannot be built in a unit test — so those two are what the
/// contract is pinned on.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("muster-store-{name}"));
        let _ = fs::remove_dir_all(&dir);
        Self(dir.join("state.json"))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Some(dir) = self.0.parent() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

fn entry(key: &str, value: &str) -> BTreeMap<String, String> {
    BTreeMap::from([(key.to_string(), value.to_string())])
}

#[test]
fn what_is_saved_is_what_loads() {
    let scratch = Scratch::new("round-trip");
    let entries = entry("muster.deck", r#"{"tabs":[]}"#);
    assert!(save_to(&scratch.0, &entries).is_some());
    assert_eq!(load_from(&scratch.0), entries);
}

#[test]
fn a_value_holding_quotes_and_newlines_survives() {
    let scratch = Scratch::new("quotes");
    let entries = entry(
        "muster.settings",
        "{\"fontFamily\":\"\\\"Operator Mono\\\", monospace\"}\n",
    );
    assert!(save_to(&scratch.0, &entries).is_some());
    assert_eq!(load_from(&scratch.0), entries);
}

#[test]
fn saving_creates_the_directory_it_needs() {
    // The app data directory does not exist before the first write.
    let scratch = Scratch::new("mkdir");
    assert!(!scratch.0.parent().unwrap().exists());
    assert!(save_to(&scratch.0, &entry("k", "v")).is_some());
    assert!(scratch.0.exists());
}

#[test]
fn a_file_that_is_not_json_reads_as_empty_rather_than_failing() {
    // What a torn or hand-edited file looks like. Losing the tabs is bad;
    // refusing to start is worse.
    let scratch = Scratch::new("torn");
    fs::create_dir_all(scratch.0.parent().unwrap()).unwrap();
    fs::write(&scratch.0, "{ not json").unwrap();
    assert!(load_from(&scratch.0).is_empty());
}

#[test]
fn a_store_that_is_not_there_yet_reads_as_empty() {
    let scratch = Scratch::new("absent");
    assert!(load_from(&scratch.0).is_empty());
}

#[test]
fn the_temporary_file_does_not_survive_the_write() {
    // The rename is what makes a write atomic: the temp file is moved onto the
    // real one rather than copied beside it.
    let scratch = Scratch::new("atomic");
    assert!(save_to(&scratch.0, &entry("k", "v")).is_some());
    assert!(!scratch.0.with_extension("json.tmp").exists());
}

#[test]
fn a_second_save_replaces_the_first() {
    let scratch = Scratch::new("replace");
    assert!(save_to(&scratch.0, &entry("k", "one")).is_some());
    assert!(save_to(&scratch.0, &entry("k", "two")).is_some());
    assert_eq!(load_from(&scratch.0), entry("k", "two"));
}
