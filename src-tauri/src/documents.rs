// Documents: which files a window may read and write (only ones the user chose), and reading and
// writing them byte-faithfully, including text in encodings other than UTF-8.

use std::{
  collections::HashSet,
  fs,
  io::Read,
  path::{Path, PathBuf},
  sync::Mutex,
};
use tauri::{Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::{i18n, platform::{self, path_name}};

pub const DOCUMENT_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "txt"];
// A document is a text file. Anything larger is refused before it is read into memory.
const OPEN_LIMIT: u64 = 64 * 1024 * 1024;

pub fn has_extension(path: &Path, list: &[&str]) -> bool {
  path.extension().and_then(|e| e.to_str()).is_some_and(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

// ---------- Which files a window may touch ----------

#[derive(Default)]
pub struct AuthorizedDocuments(pub Mutex<HashSet<PathBuf>>);

pub fn canonical_document(path: &Path, allow_new: bool) -> Result<PathBuf, String> {
  if !path.is_absolute() { return Err(i18n::t("error.document.absolute")); }
  let canonical = match fs::canonicalize(path) {
    Ok(path) => path,
    Err(e) if allow_new && e.kind() == std::io::ErrorKind::NotFound => {
      if fs::symlink_metadata(path).is_ok() { return Err(e.to_string()); }
      let parent = path.parent().ok_or_else(|| i18n::t("error.file.invalidPath"))?;
      let name = path.file_name().ok_or_else(|| i18n::t("error.file.invalidPath"))?;
      fs::canonicalize(parent).map_err(|e| e.to_string())?.join(name)
    }
    Err(e) => return Err(e.to_string()),
  };
  if canonical.exists() && !canonical.is_file() {
    return Err(i18n::t_with("error.document.notRegular", &[("name", &path_name(path))]));
  }
  Ok(canonical)
}

impl AuthorizedDocuments {
  pub fn authorize(&self, path: &Path, allow_new: bool) -> Result<PathBuf, String> {
    let canonical = canonical_document(path, allow_new)?;
    self.0.lock().unwrap().insert(canonical.clone());
    Ok(canonical)
  }

  // Authorize a path that has already been checked, only if it still resolves to itself: a symlink
  // swapped in after the check makes it resolve elsewhere, and then nothing is authorized.
  pub fn authorize_exact(&self, checked: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_document(checked, false)?;
    if canonical != checked {
      return Err(i18n::t_with("error.document.changed", &[("name", &path_name(checked))]));
    }
    self.0.lock().unwrap().insert(canonical.clone());
    Ok(canonical)
  }

  pub fn require(&self, path: &Path, allow_new: bool) -> Result<PathBuf, String> {
    let canonical = canonical_document(path, allow_new)?;
    if !self.0.lock().unwrap().contains(&canonical) {
      return Err(i18n::t("error.document.userChoice"));
    }
    Ok(canonical)
  }
}

pub fn authorize_document<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path, allow_new: bool) -> Result<String, String> {
  let canonical = app.state::<AuthorizedDocuments>().authorize(path, allow_new)?;
  canonical.to_str().map(str::to_owned).ok_or_else(|| i18n::t("error.file.invalidPath"))
}

// Dropped files that may be opened as documents: a regular file whose dropped name and resolved
// target both have a document extension, so a `notes.md` symlink to `~/.ssh/id_rsa` isn't authorized.
pub fn droppable_documents(paths: &[PathBuf]) -> Vec<&PathBuf> {
  paths.iter().filter(|p| {
    has_extension(p, DOCUMENT_EXTENSIONS)
      && fs::canonicalize(p).is_ok_and(|t| has_extension(&t, DOCUMENT_EXTENSIONS) && t.is_file())
  }).collect()
}

// Async so Tauri runs these off the main thread: a blocking dialog on the main thread hangs macOS.
#[tauri::command]
pub async fn open_dialog<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Option<String>, String> {
  let selected = app.dialog().file().add_filter(&i18n::t("dialog.fileFilter"), DOCUMENT_EXTENSIONS).blocking_pick_file();
  selected.map(|p| authorize_document(&app, &p.into_path().map_err(|e| e.to_string())?, false)).transpose()
}

#[tauri::command]
pub async fn save_dialog<R: Runtime>(app: tauri::AppHandle<R>, default_path: String) -> Result<Option<String>, String> {
  let default = Path::new(&default_path);
  let fallback = format!("{}.md", i18n::t("app.untitled"));
  let name = default.file_name().and_then(|s| s.to_str()).unwrap_or(&fallback);
  let mut dialog = app.dialog().file().add_filter(&i18n::t("dialog.fileFilter"), DOCUMENT_EXTENSIONS).set_file_name(name);
  if let Some(dir) = default.parent().filter(|p| !p.as_os_str().is_empty() && p.is_dir()) { dialog = dialog.set_directory(dir); }
  let selected = dialog.blocking_save_file();
  selected.map(|p| authorize_document(&app, &p.into_path().map_err(|e| e.to_string())?, true)).transpose()
}

// ---------- Text encodings ----------

// How a document's bytes become text and back. `encoding` is the WHATWG name ("UTF-8", "UTF-16LE",
// "Big5", "GBK", "Shift_JIS", ...). `exact` is false when re-encoding the decoded text would not
// reproduce the original bytes, so the frontend can say so before a save changes them.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Decoded {
  pub text: String,
  pub bom: bool,
  pub encoding: String,
  pub exact: bool,
}

// The frontend recognizes this prefix and offers to save as UTF-8 instead.
#[cfg(test)]
pub const UNMAPPABLE: &str = "unmappable:";

pub fn decode(bytes: &[u8], name: &str) -> Result<Decoded, String> {
  if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
    let (text, had_errors) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
    if had_errors { return Err(i18n::t_with("error.document.invalidEncoding", &[("name", name), ("encoding", encoding.name())])); }
    return Ok(Decoded { text: text.into_owned(), bom: true, encoding: encoding.name().into(), exact: true });
  }
  // DECISION: without a BOM, a NUL byte means a binary file (an image, a PDF), not text. UTF-16 without
  // a BOM is refused too: it's rare, and guessing it wrong turns a binary file into garbage text.
  if bytes.contains(&0) { return Err(i18n::t_with("error.document.binary", &[("name", name)])); }
  if let Ok(text) = std::str::from_utf8(bytes) {
    return Ok(Decoded { text: text.to_owned(), bom: false, encoding: "UTF-8".into(), exact: true });
  }
  let mut detector = chardetng::EncodingDetector::new();
  detector.feed(bytes, true);
  let encoding = detector.guess(None, true);
  let (text, had_errors) = encoding.decode_without_bom_handling(bytes);
  if had_errors { return Err(i18n::t_with("error.document.invalidUtf8", &[("name", name), ("encoding", encoding.name())])); }
  let text = text.into_owned();
  let exact = encode(&text, false, encoding.name()).is_ok_and(|b| b == bytes);
  Ok(Decoded { text, bom: false, encoding: encoding.name().into(), exact })
}

pub fn encode(text: &str, bom: bool, encoding: &str) -> Result<Vec<u8>, String> {
  let utf16 = |big: bool| {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    if bom { out.extend_from_slice(if big { &[0xfe, 0xff] } else { &[0xff, 0xfe] }); }
    for unit in text.encode_utf16() {
      out.extend_from_slice(&if big { unit.to_be_bytes() } else { unit.to_le_bytes() });
    }
    out
  };
  match encoding {
    "UTF-8" => {
      let mut out = Vec::with_capacity(text.len() + 3);
      if bom { out.extend_from_slice(&[0xef, 0xbb, 0xbf]); }
      out.extend_from_slice(text.as_bytes());
      Ok(out)
    }
    "UTF-16LE" => Ok(utf16(false)),
    "UTF-16BE" => Ok(utf16(true)),
    label => {
      let enc = encoding_rs::Encoding::for_label(label.as_bytes()).ok_or_else(|| i18n::t_with("error.document.unknownEncoding", &[("encoding", label)]))?;
      let (bytes, _, unmappable) = enc.encode(text);
      if unmappable { return Err(i18n::t_with("error.document.unmappable", &[("encoding", label)])); }
      Ok(bytes.into_owned())
    }
  }
}

// ---------- Reading and writing ----------

#[derive(serde::Serialize, Debug)]
pub struct Document {
  pub text: String,
  pub bom: bool,
  pub encoding: String,
  pub exact: bool,
  pub path: String,
}

fn too_large(path: &Path, len: u64) -> String {
  // DECISION: the dialog says MB and means mebibytes, rounded up, so the 64 MiB limit reads as 64 MB.
  let mb = len.div_ceil(1024 * 1024);
  i18n::t_with("error.document.tooLarge", &[("name", &path_name(path)), ("size", &mb.to_string())])
}

pub fn read_document_file(path: &Path) -> Result<Document, String> {
  let file = platform::open_for_read(path)?;
  let meta = file.metadata().map_err(|e| e.to_string())?;
  let name = path_name(path);
  if meta.is_dir() { return Err(i18n::t_with("error.document.directory", &[("name", &name)])); }
  if !meta.is_file() { return Err(i18n::t_with("error.document.notRegular", &[("name", &name)])); }
  if meta.len() > OPEN_LIMIT { return Err(too_large(path, meta.len())); }
  let mut bytes = Vec::new();
  file.take(OPEN_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
  if bytes.len() as u64 > OPEN_LIMIT { return Err(too_large(path, bytes.len() as u64)); }
  let d = decode(&bytes, &name)?;
  Ok(Document { text: d.text, bom: d.bom, encoding: d.encoding, exact: d.exact, path: path.to_string_lossy().into_owned() })
}

pub fn read_authorized_document(authorized: &AuthorizedDocuments, path: &Path) -> Result<Document, String> {
  let target = authorized.require(path, false)?;
  read_document_file(&target)
}

pub fn write_document_file(target: &Path, text: &str, bom: bool, encoding: &str) -> Result<(), String> {
  platform::replace_file(target, &encode(text, bom, encoding)?)
}

pub fn write_authorized_document(authorized: &AuthorizedDocuments, path: &Path, text: &str, bom: bool, encoding: &str) -> Result<(), String> {
  let target = authorized.require(path, true)?;
  write_document_file(&target, text, bom, encoding)
}

// Does not resolve `path`'s final component. Keybindings use this so a symlink is not overwritten.
pub fn write_regular_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
  match fs::symlink_metadata(path) {
    Ok(meta) if meta.file_type().is_symlink() => {
      return Err(i18n::t_with("error.document.symbolicLink", &[("name", &path_name(path))]));
    }
    Ok(meta) if !meta.is_file() => return Err(i18n::t_with("error.document.notRegular", &[("name", &path_name(path))])),
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
    _ => {}
  }
  let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).ok_or_else(|| i18n::t("error.file.invalidPath"))?;
  let name = path.file_name().ok_or_else(|| i18n::t("error.file.invalidPath"))?;
  let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
  platform::replace_file(&parent.join(name), bytes)
}

#[tauri::command]
pub fn read_document(path: String, authorized: tauri::State<AuthorizedDocuments>) -> Result<Document, String> {
  read_authorized_document(&authorized, Path::new(&path))
}

#[tauri::command]
pub fn write_document(
  path: String,
  text: String,
  bom: bool,
  encoding: Option<String>,
  authorized: tauri::State<AuthorizedDocuments>,
) -> Result<(), String> {
  write_authorized_document(&authorized, Path::new(&path), &text, bom, encoding.as_deref().unwrap_or("UTF-8"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn round_trip(bytes: &[u8]) -> Decoded {
    let d = decode(bytes, "test").unwrap();
    assert_eq!(encode(&d.text, d.bom, &d.encoding).unwrap(), bytes, "{} did not round-trip", d.encoding);
    d
  }

  #[test]
  fn utf8_and_boms() {
    assert_eq!(round_trip("# 標題\n".as_bytes()).encoding, "UTF-8");
    let d = round_trip(b"\xef\xbb\xbfhi");
    assert!(d.bom && d.encoding == "UTF-8" && d.text == "hi");
    let le: Vec<u8> = [0xff, 0xfe].into_iter().chain("# 標題\r\n".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
    let d = round_trip(&le);
    assert_eq!((d.encoding.as_str(), d.text.as_str()), ("UTF-16LE", "# 標題\r\n"));
    let be: Vec<u8> = [0xfe, 0xff].into_iter().chain("x".encode_utf16().flat_map(|u| u.to_be_bytes())).collect();
    assert_eq!(round_trip(&be).encoding, "UTF-16BE");
  }

  #[test]
  fn legacy_encodings_are_detected_and_round_trip() {
    let samples: &[(&str, &str)] = &[
      ("Big5", "# 會議記錄\n\n今天我們討論了新的設計方案，大家都同意這個方向是正確的。下一次會議在星期五舉行。\n"),
      ("GBK", "# 会议记录\n\n今天我们讨论了新的设计方案，大家都同意这个方向是正确的。下一次会议在星期五举行。\n"),
      ("Shift_JIS", "# 会議の記録\n\n今日は新しいデザインについて話し合いました。次の会議は金曜日に行われます。\n"),
      ("EUC-KR", "# 회의 기록\n\n오늘 우리는 새로운 디자인에 대해 논의했습니다. 다음 회의는 금요일에 열립니다.\n"),
      ("windows-1252", "# Café notes\n\nThe menu had crème brûlée and a naïve façade.\n"),
    ];
    for (label, text) in samples {
      let enc = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap();
      let (bytes, _, _) = enc.encode(text);
      let d = round_trip(&bytes);
      assert_eq!(d.encoding, enc.name(), "detected {} for {label}", d.encoding);
      assert_eq!(&d.text, text);
      assert!(d.exact);
    }
  }

  #[test]
  fn unmappable_characters_are_reported() {
    let err = encode("中文 and emoji 😀", false, "Big5").unwrap_err();
    assert!(err.starts_with(UNMAPPABLE), "{err}");
    assert!(encode("中文", false, "Big5").is_ok());
  }

  // ---------- File I/O ----------

  use std::sync::atomic::{AtomicU64, Ordering};
  static N: AtomicU64 = AtomicU64::new(0);
  fn path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("openviewer-{label}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)))
  }
  // The app always writes the canonical path (via AuthorizedDocuments::require); tests do the same.
  fn write_trusted_as(path: &Path, text: &str, bom: bool, encoding: &str) -> Result<(), String> {
    write_document_file(&canonical_document(path, true)?, text, bom, encoding)
  }
  fn write_trusted(path: &Path, text: &str, bom: bool) -> Result<(), String> {
    write_trusted_as(path, text, bom, "UTF-8")
  }

  #[test]
  fn bom_and_crlf_round_trip() {
    let p = path("bom");
    write_trusted(&p, "hello", true).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"\xef\xbb\xbfhello");
    assert_eq!(read_document_file(&p).unwrap().text, "hello");
    fs::write(&p, b"a\r\nb\r\n").unwrap();
    let doc = read_document_file(&p).unwrap();
    write_trusted_as(&p, &doc.text, doc.bom, &doc.encoding).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"a\r\nb\r\n");
    let _ = fs::remove_file(p);
  }

  #[test]
  fn legacy_encoded_file_saves_in_its_encoding() {
    let p = path("big5");
    let (bytes, _, _) = encoding_rs::BIG5.encode("# 會議記錄\n\n今天我們討論了新的設計方案，大家都同意這個方向是正確的。\n");
    fs::write(&p, &bytes).unwrap();
    let doc = read_document_file(&p).unwrap();
    assert_eq!(doc.encoding, "Big5");
    write_trusted_as(&p, &(doc.text.clone() + "新增一行。\n"), doc.bom, &doc.encoding).unwrap();
    let saved = fs::read(&p).unwrap();
    assert!(saved.starts_with(&bytes));
    assert_eq!(encoding_rs::BIG5.decode(&saved).0, doc.text + "新增一行。\n");
    let _ = fs::remove_file(p);
  }

  #[test]
  fn refuses_oversized_regular_file() {
    let p = path("big");
    fs::File::create(&p).unwrap().set_len(65 * 1024 * 1024).unwrap();
    let err = read_document_file(&p).unwrap_err();
    assert!(err.contains("too large to open") && err.contains("65 MB") && err.contains("64 MB"), "{err}");
    let _ = fs::remove_file(p);
  }

  #[cfg(unix)]
  #[test]
  fn refuses_device_without_reading_it() {
    let started = std::time::Instant::now();
    let err = read_document_file(Path::new("/dev/zero")).unwrap_err();
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "slow refusal: {err}");
    assert!(err.contains("not a regular file"), "{err}");
  }

  #[test]
  fn refuses_directory() {
    let dir = path("dir");
    fs::create_dir(&dir).unwrap();
    assert!(read_document_file(&dir).unwrap_err().to_lowercase().contains("directory"));
    let _ = fs::remove_dir(dir);
  }

  #[cfg(unix)]
  #[test]
  fn save_through_symlink_updates_the_target() {
    let dir = path("symlink");
    fs::create_dir(&dir).unwrap();
    let real = dir.join("real.md");
    let link = dir.join("link.md");
    fs::write(&real, b"old").unwrap();
    std::os::unix::fs::symlink("real.md", &link).unwrap();
    write_trusted(&link, "new", false).unwrap();
    assert_eq!(fs::read(&real).unwrap(), b"new");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    let _ = fs::remove_dir_all(dir);
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn save_keeps_xattrs_and_mode() {
    use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt};
    let p = path("xattr");
    fs::write(&p, b"old").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
    let c_path = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
    let name = std::ffi::CString::new("com.openviewer.test").unwrap();
    let value = b"kept";
    assert_eq!(unsafe { libc::setxattr(c_path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) }, 0);
    write_trusted(&p, "new", false).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"new");
    assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o640);
    let mut buf = [0u8; 8];
    let n = unsafe { libc::getxattr(c_path.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0) };
    assert_eq!(&buf[..n as usize], value);
    let _ = fs::remove_file(p);
  }

  #[cfg(unix)]
  #[test]
  fn document_paths_require_user_authorization() {
    let dir = path("authorized");
    fs::create_dir(&dir).unwrap();
    let chosen = dir.join("chosen.md");
    let private = dir.join("private.md");
    let link = dir.join("link.md");
    fs::write(&chosen, "chosen").unwrap();
    fs::write(&private, "private").unwrap();
    std::os::unix::fs::symlink(&private, &link).unwrap();
    let paths = AuthorizedDocuments::default();
    assert!(read_authorized_document(&paths, &chosen).is_err());
    assert!(write_authorized_document(&paths, &chosen, "bad", false, "UTF-8").is_err());
    paths.authorize(&chosen, false).unwrap();
    assert_eq!(read_authorized_document(&paths, &chosen).unwrap().text, "chosen");
    write_authorized_document(&paths, &chosen, "saved", false, "UTF-8").unwrap();
    assert_eq!(fs::read_to_string(&chosen).unwrap(), "saved");
    assert!(read_authorized_document(&paths, &link).is_err());
    assert!(write_authorized_document(&paths, &link, "bad", false, "UTF-8").is_err());
    assert_eq!(fs::read_to_string(&private).unwrap(), "private");
    let new_file = dir.join("new.md");
    paths.authorize(&new_file, true).unwrap();
    write_authorized_document(&paths, &new_file, "new", false, "UTF-8").unwrap();
    assert_eq!(read_authorized_document(&paths, &new_file).unwrap().text, "new");
    let _ = fs::remove_dir_all(dir);
  }

  #[cfg(unix)]
  #[test]
  fn swapped_symlink_is_not_followed_on_read_or_write() {
    let dir = path("swap");
    fs::create_dir(&dir).unwrap();
    let chosen = dir.join("chosen.md");
    let other = dir.join("other.md");
    fs::write(&chosen, "chosen").unwrap();
    fs::write(&other, "other").unwrap();
    let canonical = fs::canonicalize(&chosen).unwrap();
    let paths = AuthorizedDocuments::default();
    paths.authorize(&canonical, false).unwrap();
    fs::remove_file(&canonical).unwrap();
    std::os::unix::fs::symlink(&other, &canonical).unwrap();
    assert!(read_authorized_document(&paths, &canonical).is_err());
    assert!(write_authorized_document(&paths, &canonical, "pwned", false, "UTF-8").is_err());
    assert!(read_document_file(&canonical).is_err());
    assert!(write_document_file(&canonical, "pwned", false, "UTF-8").is_err());
    assert_eq!(fs::read_to_string(&other).unwrap(), "other");
    let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
      .map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains("openviewer-")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = fs::remove_dir_all(dir);
  }

  #[cfg(unix)]
  #[test]
  fn write_regular_file_does_not_follow_a_symlink() {
    let dir = path("reglink");
    fs::create_dir(&dir).unwrap();
    let secret = dir.join("secret.md");
    let link = dir.join("link.md");
    fs::write(&secret, b"secret").unwrap();
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    assert!(write_regular_file(&link, b"pwned").unwrap_err().contains("symbolic link"));
    assert_eq!(fs::read(&secret).unwrap(), b"secret");
    let plain = dir.join("plain.md");
    write_regular_file(&plain, b"ok").unwrap();
    assert_eq!(fs::read(&plain).unwrap(), b"ok");
    let _ = fs::remove_dir_all(dir);
  }

  #[cfg(unix)]
  #[test]
  fn only_regular_document_files_are_accepted_from_a_drop() {
    let dir = path("drop");
    fs::create_dir_all(dir.join("folder.md")).unwrap();
    for name in ["note.md", "Read.MARKDOWN", "photo.png", "key"] { fs::write(dir.join(name), "").unwrap(); }
    std::os::unix::fs::symlink(dir.join("key"), dir.join("disguised.md")).unwrap();
    let paths: Vec<PathBuf> = ["note.md", "Read.MARKDOWN", "photo.png", "key", "folder.md", "missing.md", "disguised.md"].iter().map(|n| dir.join(n)).collect();
    let accepted: Vec<_> = droppable_documents(&paths).into_iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(accepted, ["note.md", "Read.MARKDOWN"]);
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn binary_files_are_refused() {
    let err = decode(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\xff\xfe", "pic.md").unwrap_err();
    assert!(err.contains("binary"), "{err}");
    // Valid UTF-8 with NULs, and UTF-16 without a BOM, are not text either.
    assert!(decode(b"abc\x00def", "data.md").unwrap_err().contains("binary"));
    assert!(decode(b"h\x00i\x00", "le.md").unwrap_err().contains("binary"));
  }
}
