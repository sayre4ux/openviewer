use std::{
  ffi::CString,
  fs::{self, OpenOptions},
  io::{Read, Write},
  os::unix::{ffi::OsStrExt, fs::{MetadataExt, OpenOptionsExt}},
  path::Path,
  sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex},
};
use tauri::{webview::WebviewWindowBuilder, Emitter, Manager, Runtime};

mod menu;

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

// Files macOS asks us to open before the first window's frontend is listening (cold launch
// via Open With or double-click). The first window collects them through `frontend_ready`.
#[derive(Default)]
struct Startup { ready: AtomicBool, pending: Mutex<Vec<String>> }

// The document window that was focused last, so menu commands chosen while Preferences is in
// front still reach a document.
#[derive(Default)]
struct LastDocument(Mutex<Option<String>>);

#[tauri::command]
fn frontend_ready(startup: tauri::State<Startup>) -> Vec<String> {
  startup.ready.store(true, Ordering::SeqCst);
  std::mem::take(&mut *startup.pending.lock().unwrap())
}

#[derive(serde::Serialize, Debug)]
struct Document { text: String, bom: bool }

// A document is a text file. Anything larger is refused before it is read into memory.
const OPEN_LIMIT: u64 = 64 * 1024 * 1024;

fn path_name(path: &Path) -> String {
  path.file_name().map(|s| s.to_string_lossy().into_owned()).filter(|s| !s.is_empty())
    .unwrap_or_else(|| path.display().to_string())
}

fn too_large(path: &Path, len: u64) -> String {
  // DECISION: the dialog says MB and means mebibytes, rounded up, so the 64 MiB limit reads as 64 MB.
  let mb = len.div_ceil(1024 * 1024);
  format!("{} is too large to open ({mb} MB; the limit is 64 MB)", path_name(path))
}

fn c_path(path: &Path) -> Result<CString, String> {
  CString::new(path.as_os_str().as_bytes()).map_err(|_| "Invalid file path".to_string())
}

// ACLs and extended attributes (Finder tags included). Mode bits are also applied separately.
fn copy_metadata(from: &Path, to: &Path) -> Result<(), String> {
  let from = c_path(from)?;
  let to = c_path(to)?;
  let rc = unsafe { libc::copyfile(from.as_ptr(), to.as_ptr(), std::ptr::null_mut(), libc::COPYFILE_METADATA) };
  if rc == 0 { return Ok(()) }
  let err = std::io::Error::last_os_error();
  // Volumes without ACLs or extended attributes (FAT, some network shares) have none to lose.
  if matches!(err.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)) { return Ok(()) }
  Err(format!("couldn't copy file metadata: {err}"))
}

#[tauri::command]
fn read_document(path: String) -> Result<Document, String> {
  let path = Path::new(&path);
  // O_NONBLOCK: opening a FIFO would otherwise wait forever for a writer.
  let file = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path).map_err(|e| e.to_string())?;
  let meta = file.metadata().map_err(|e| e.to_string())?;
  let name = path_name(path);
  if meta.is_dir() { return Err(format!("{name} is a directory")); }
  if !meta.is_file() { return Err(format!("{name} is not a regular file")); }
  if meta.len() > OPEN_LIMIT { return Err(too_large(path, meta.len())); }
  let mut bytes = Vec::new();
  file.take(OPEN_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
  if bytes.len() as u64 > OPEN_LIMIT { return Err(too_large(path, bytes.len() as u64)); }
  let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
  if bom { bytes.drain(..3); }
  let text = String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8".to_string())?;
  Ok(Document { text, bom })
}

#[tauri::command]
fn write_document(path: String, text: String, bom: bool) -> Result<(), String> {
  let requested = Path::new(&path);
  // Renaming onto a symlink replaces the link with a regular file. Resolve first and
  // replace the file the link points at, so the link itself stays a link.
  let target = match fs::symlink_metadata(requested) {
    Ok(_) => fs::canonicalize(requested).map_err(|e| e.to_string())?,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => requested.to_path_buf(),
    Err(e) => return Err(e.to_string()),
  };
  let parent = target.parent().unwrap_or_else(|| Path::new("."));
  let name = target.file_name().ok_or_else(|| "Invalid file path".to_string())?.to_string_lossy();
  let existed = fs::metadata(&target).ok();
  let permissions = existed.as_ref().map(|m| m.permissions());
  let mut temp_path;
  let mut file;
  loop {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    temp_path = parent.join(format!(".{name}.openviewer-{}-{id}.tmp", std::process::id()));
    match OpenOptions::new().write(true).create_new(true).open(&temp_path) {
      Ok(f) => { file = f; break; }
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(e) => return Err(e.to_string()),
    }
  }
  let result = (|| {
    if let Some(perms) = &permissions { file.set_permissions(perms.clone()).map_err(|e| e.to_string())?; }
    if bom { file.write_all(&[0xef, 0xbb, 0xbf]).map_err(|e| e.to_string())?; }
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if let Some(meta) = &existed {
      copy_metadata(&target, &temp_path)?;
      // DECISION: a group we can't set (EPERM) must not fail the save. copyfile reports success anyway.
      let _ = std::os::unix::fs::chown(&temp_path, None, Some(meta.gid()));
    }
    fs::rename(&temp_path, &target).map_err(|e| e.to_string())
  })();
  if result.is_err() { let _ = fs::remove_file(&temp_path); }
  result
}

#[tauri::command]
fn create_document_window<R: Runtime>(app: tauri::AppHandle<R>, path: Option<String>) -> Result<(), String> {
  let url = match path {
    Some(path) => format!("index.html?path={}", encode_query(&path)),
    None => "index.html".to_string(),
  };
  open_window(&app, url)
}

fn open_window<R: Runtime>(app: &tauri::AppHandle<R>, url: String) -> Result<(), String> {
  let label = format!("document-{}", TEMP_ID.fetch_add(1, Ordering::Relaxed));
  WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
    .title("OpenViewer").inner_size(1100.0, 760.0).min_inner_size(480.0, 360.0)
    .build().map(|_| ()).map_err(|e| e.to_string())
}

fn encode_query(value: &str) -> String {
  value.bytes().map(|b| match b {
    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
    _ => format!("%{b:02X}"),
  }).collect()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewChecks { source: bool, outline: bool, focus: bool, typewriter: bool, word_count: bool }

// The menu bar is shared by every window; the focused window reports its modes here.
#[tauri::command]
fn sync_view_menu<R: Runtime>(app: tauri::AppHandle<R>, window: tauri::Window<R>, checks: ViewChecks) -> Result<(), String> {
  // Checked here, not in the frontend: a request can arrive after focus has moved on.
  if !window.is_focused().unwrap_or(false) { return Ok(()) }
  let Some(menu) = app.menu() else { return Ok(()) };
  let wanted = [
    ("source-mode", checks.source),
    ("outline", checks.outline),
    ("focus-mode", checks.focus),
    ("typewriter-mode", checks.typewriter),
    ("word-count", checks.word_count),
  ];
  // Remembered so a menu rebuild (new shortcuts) keeps the checkmarks.
  *app.state::<menu::Keybindings>().checks.lock().unwrap() = wanted.iter().map(|(id, on)| (id.to_string(), *on)).collect();
  for entry in menu.items().map_err(|e| e.to_string())? {
    let Some(submenu) = entry.as_submenu() else { continue };
    for (id, on) in wanted {
      if let Some(item) = submenu.get(id).and_then(|i| i.as_check_menuitem().cloned()) {
        item.set_checked(on).map_err(|e| e.to_string())?;
      }
    }
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Startup::default())
    .manage(menu::Keybindings::default())
    .manage(LastDocument::default())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
      }
      menu::load(app.handle())?;
      Ok(())
    })
    .on_menu_event(|app, event| {
      if event.id().as_ref() == "preferences" {
        menu::open_preferences(app);
        return;
      }
      let id = event.id().as_ref();
      let Some(focused) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) else { return };
      // File commands chosen while Preferences is in front go to the last document window;
      // Preferences handles everything else itself (Close, Quit, Undo in its search field).
      let for_document = matches!(id, "new" | "open" | "save" | "save-as");
      let target = if focused.label() == "preferences" && for_document {
        app.state::<LastDocument>().0.lock().unwrap().clone().filter(|label| app.get_webview_window(label).is_some())
      } else {
        Some(focused.label().to_string())
      };
      match target {
        Some(label) => { let _ = app.emit_to(label.as_str(), "menu", id); }
        None if id == "new" => { let _ = create_document_window(app.clone(), None); }
        None if id == "open" => { let _ = open_window(app, "index.html?action=open".into()); }
        None => {}
      }
    })
    .on_window_event(|window, event| match event {
      tauri::WindowEvent::Focused(true) => {
        if window.label() != "preferences" {
          *window.app_handle().state::<LastDocument>().0.lock().unwrap() = Some(window.label().to_string());
        }
        menu::reload_if_changed(window.app_handle());
      }
      // Preferences closed mid-recording: bring the menu's shortcuts back.
      tauri::WindowEvent::Destroyed if window.label() == "preferences" => {
        let _ = menu::suspend_shortcuts(window.app_handle().clone(), false);
      }
      _ => {}
    })
    .invoke_handler(tauri::generate_handler![
      read_document,
      write_document,
      create_document_window,
      frontend_ready,
      sync_view_menu,
      menu::get_keybindings,
      menu::set_keybindings,
      menu::open_keybindings_file,
      menu::suspend_shortcuts
    ])
    .build(tauri::generate_context!())
    .expect("error while building OpenViewer")
    .run(|app, event| {
      #[cfg(target_os = "macos")]
      if let tauri::RunEvent::Opened { urls } = event {
        for url in urls {
          if let Ok(path) = url.to_file_path() {
            let path = path.to_string_lossy().into_owned();
            let startup = app.state::<Startup>();
            if !startup.ready.load(Ordering::SeqCst) {
              startup.pending.lock().unwrap().push(path);
            } else if let Some(window) = app.webview_windows().values().find(|w| w.is_focused().unwrap_or(false)) {
              let _ = app.emit_to(window.label(), "open-path", path);
            } else {
              let _ = create_document_window(app.clone(), Some(path));
            }
          }
        }
      }
    });
}

#[cfg(test)]
mod tests {
  use super::*;
  fn path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("openviewer-{label}-{}-{}", std::process::id(), TEMP_ID.fetch_add(1, Ordering::Relaxed)))
  }
  #[test]
  fn bom_round_trip() {
    let p = path("bom"); write_document(p.to_string_lossy().into_owned(), "hello".into(), true).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"\xef\xbb\xbfhello");
    assert_eq!(read_document(p.to_string_lossy().into_owned()).unwrap().text, "hello");
    let _ = fs::remove_file(p);
  }
  #[test]
  fn crlf_bytes_are_untouched() {
    let p = path("crlf"); fs::write(&p, b"a\r\nb\r\n").unwrap();
    let doc = read_document(p.to_string_lossy().into_owned()).unwrap();
    write_document(p.to_string_lossy().into_owned(), doc.text, doc.bom).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"a\r\nb\r\n");
    let _ = fs::remove_file(p);
  }
  #[test]
  fn atomic_write_replaces_existing_file() {
    let p = path("replace"); fs::write(&p, b"old").unwrap();
    write_document(p.to_string_lossy().into_owned(), "new".into(), false).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"new");
    let _ = fs::remove_file(p);
  }
  #[test]
  fn save_through_symlink_updates_the_target() {
    let dir = path("symlink");
    fs::create_dir(&dir).unwrap();
    let real = dir.join("real.md");
    let link = dir.join("link.md");
    fs::write(&real, b"old").unwrap();
    std::os::unix::fs::symlink("real.md", &link).unwrap();
    write_document(link.to_string_lossy().into_owned(), "new".into(), false).unwrap();
    assert_eq!(fs::read(&real).unwrap(), b"new");
    assert_eq!(fs::read(&link).unwrap(), b"new");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_link(&link).unwrap(), std::path::Path::new("real.md"));
    let _ = fs::remove_dir_all(dir);
  }
  #[test]
  fn save_keeps_xattrs_and_mode() {
    use std::os::unix::fs::PermissionsExt;
    let p = path("xattr");
    fs::write(&p, b"old").unwrap();
    let mut perms = fs::metadata(&p).unwrap().permissions();
    perms.set_mode(0o640);
    fs::set_permissions(&p, perms).unwrap();
    let name = std::ffi::CString::new("com.openviewer.test").unwrap();
    let value = b"kept";
    let c_path = c_path(&p).unwrap();
    let rc = unsafe { libc::setxattr(c_path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
    assert_eq!(rc, 0, "{}", std::io::Error::last_os_error());
    write_document(p.to_string_lossy().into_owned(), "new".into(), false).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"new");
    assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o640);
    let mut buf = [0u8; 8];
    let n = unsafe { libc::getxattr(c_path.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, 0) };
    assert!(n >= 0, "{}", std::io::Error::last_os_error());
    assert_eq!(&buf[..n as usize], value);
    let _ = fs::remove_file(p);
  }
  #[test]
  fn refuses_oversized_regular_file() {
    let p = path("big");
    fs::File::create(&p).unwrap().set_len(65 * 1024 * 1024).unwrap();
    let err = read_document(p.to_string_lossy().into_owned()).unwrap_err();
    assert!(err.contains("too large to open"), "{err}");
    assert!(err.contains("65 MB"), "{err}");
    assert!(err.contains("64 MB"), "{err}");
    let _ = fs::remove_file(p);
  }
  #[test]
  fn refuses_device_without_reading_it() {
    let started = std::time::Instant::now();
    let err = read_document("/dev/zero".into()).unwrap_err();
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "slow refusal: {err}");
    assert!(err.contains("not a regular file"), "{err}");
  }
  #[test]
  fn refuses_directory() {
    let dir = path("dir");
    fs::create_dir(&dir).unwrap();
    let err = read_document(dir.to_string_lossy().into_owned()).unwrap_err();
    assert!(err.to_lowercase().contains("directory"), "{err}");
    let _ = fs::remove_dir(dir);
  }
}
