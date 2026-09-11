use super::*;

#[test]
fn recognises_the_common_image_extensions() {
    assert_eq!(mime_for("/tmp/shot.png"), Some("image/png"));
    assert_eq!(mime_for("/tmp/photo.jpg"), Some("image/jpeg"));
    assert_eq!(mime_for("/tmp/photo.jpeg"), Some("image/jpeg"));
    assert_eq!(mime_for("diagram.svg"), Some("image/svg+xml"));
}

#[test]
fn an_extension_is_matched_whatever_its_case() {
    assert_eq!(mime_for("/tmp/SHOT.PNG"), Some("image/png"));
    assert_eq!(mime_for("/tmp/Photo.JpEg"), Some("image/jpeg"));
}

#[test]
fn refuses_anything_that_is_not_an_image() {
    for path in [
        "/etc/passwd",
        "notes.txt",
        "run.sh",
        "archive.tar.gz",
        "noext",
    ] {
        assert_eq!(mime_for(path), None, "{path} should not be previewable");
    }
}

#[test]
fn a_dotfile_is_not_mistaken_for_an_extension() {
    // `Path::extension` returns None for a leading-dot name with no suffix.
    assert_eq!(mime_for("/home/ada/.png"), None);
    assert_eq!(mime_for(".gitignore"), None);
}

#[test]
fn refuses_a_non_image_before_touching_the_filesystem() {
    // The path does not exist; the extension check must reject it anyway.
    let error = read_unconfined("/definitely/not/here.txt".into()).unwrap_err();
    assert!(error.contains("not a previewable image"), "{error}");
}

#[test]
fn reports_a_missing_file_rather_than_panicking() {
    let error = read_unconfined("/definitely/not/here.png".into()).unwrap_err();
    assert!(!error.contains("not a previewable image"), "{error}");
}

#[test]
fn refuses_a_directory_that_merely_looks_like_an_image() {
    let dir = std::env::temp_dir().join("muster-preview-test.png");
    std::fs::create_dir_all(&dir).expect("mkdir");
    let error = read_unconfined(dir.to_string_lossy().into()).unwrap_err();
    let _ = std::fs::remove_dir(&dir);
    assert!(error.contains("not a file"), "{error}");
}

// `std::os::unix::fs::symlink` does not exist on Windows, and a test module
// is compiled there too.
#[cfg(unix)]
#[test]
fn refuses_a_symlink_however_it_is_named() {
    let dir = std::env::temp_dir().join(format!("muster-symlink-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let secret = dir.join("secret");
    std::fs::write(&secret, b"private").expect("write");
    let link = dir.join("diagram.png");
    std::os::unix::fs::symlink(&secret, &link).expect("symlink");

    let error = read_unconfined(link.to_string_lossy().into()).unwrap_err();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(error.contains("symlink"), "{error}");
}

#[test]
fn encodes_a_real_file_as_a_data_uri() {
    // The smallest valid PNG: an 8-bit 1x1 image.
    const PIXEL: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89,
    ];
    let path = std::env::temp_dir().join("muster-preview-test-pixel.png");
    std::fs::write(&path, PIXEL).expect("write");

    let preview = read_unconfined(path.to_string_lossy().into()).expect("read");
    let _ = std::fs::remove_file(&path);

    assert!(preview.data_url.starts_with("data:image/png;base64,"));
    assert_eq!(preview.bytes, PIXEL.len());
    assert!(
        preview.data_url.len() > PIXEL.len(),
        "base64 expands the payload"
    );
}

#[test]
fn an_image_outside_the_folder_that_asked_for_it_is_refused() {
    // A document renders every image it names with no click, and a committed
    // symlink can point a folder anywhere — so the check has to be the
    // filesystem's, not the spelling of the path.
    let root = std::env::temp_dir().join(format!(
        "muster-within-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let inside = root.join("docs");
    let elsewhere = root.join("private");
    std::fs::create_dir_all(&inside).expect("mkdir");
    std::fs::create_dir_all(&elsewhere).expect("mkdir");
    let ours = inside.join("shot.png");
    let theirs = elsewhere.join("shot.png");
    std::fs::write(&ours, [0x89, 0x50]).expect("write");
    std::fs::write(&theirs, [0x89, 0x50]).expect("write");

    let allowed = read(
        ours.to_string_lossy().into_owned(),
        Some(inside.to_string_lossy().into_owned()),
    );
    let refused = read(
        theirs.to_string_lossy().into_owned(),
        Some(inside.to_string_lossy().into_owned()),
    );
    // A path spelled as if it were inside, but climbing out, is the real case.
    let climbing = read(
        inside
            .join("../private/shot.png")
            .to_string_lossy()
            .into_owned(),
        Some(inside.to_string_lossy().into_owned()),
    );
    let _ = std::fs::remove_dir_all(&root);

    assert!(allowed.is_ok(), "{allowed:?}");
    assert!(refused.is_err());
    assert!(climbing.is_err());
}
