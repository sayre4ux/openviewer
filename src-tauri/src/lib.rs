use std::{
  collections::HashSet,
  ffi::{CStr, CString, OsStr},
  fs::{self, OpenOptions},
  io::{Read, Write},
  os::unix::{ffi::OsStrExt, fs::{MetadataExt, OpenOptionsExt}, io::{AsRawFd, FromRawFd}},
  path::{Path, PathBuf},
  sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex},
};
use tauri::{webview::WebviewWindowBuilder, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

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

#[derive(Default)]
struct AuthorizedDocuments(Mutex<HashSet<PathBuf>>);

fn canonical_document(path: &Path, allow_new: bool) -> Result<PathBuf, String> {
  if !path.is_absolute() { return Err("Document path must be absolute".into()); }
  let canonical = match fs::canonicalize(path) {
    Ok(path) => path,
    Err(e) if allow_new && e.kind() == std::io::ErrorKind::NotFound => {
      if fs::symlink_metadata(path).is_ok() { return Err(e.to_string()); }
      let parent = path.parent().ok_or_else(|| "Invalid file path".to_string())?;
      let name = path.file_name().ok_or_else(|| "Invalid file path".to_string())?;
      fs::canonicalize(parent).map_err(|e| e.to_string())?.join(name)
    }
    Err(e) => return Err(e.to_string()),
  };
  if canonical.exists() && !canonical.is_file() {
    return Err(format!("{} is not a regular file", path_name(path)));
  }
  Ok(canonical)
}

impl AuthorizedDocuments {
  fn authorize(&self, path: &Path, allow_new: bool) -> Result<PathBuf, String> {
    let canonical = canonical_document(path, allow_new)?;
    self.0.lock().unwrap().insert(canonical.clone());
    Ok(canonical)
  }

  fn require(&self, path: &Path, allow_new: bool) -> Result<PathBuf, String> {
    let canonical = canonical_document(path, allow_new)?;
    if !self.0.lock().unwrap().contains(&canonical) {
      return Err("Document path was not chosen by the user".into());
    }
    Ok(canonical)
  }
}

fn authorize_document<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path, allow_new: bool) -> Result<String, String> {
  let canonical = app.state::<AuthorizedDocuments>().authorize(path, allow_new)?;
  canonical.to_str().map(str::to_owned).ok_or_else(|| "Document path is not valid UTF-8".to_string())
}

const DOCUMENT_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "txt"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "tif", "tiff"];
// The asset protocol reads an image to the end, so a huge file next to a note would exhaust memory.
const IMAGE_LIMIT: u64 = 32 * 1024 * 1024;

fn has_extension(path: &Path, list: &[&str]) -> bool {
  path.extension().and_then(|e| e.to_str()).is_some_and(|e| list.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

// Where a document's images may come from: its git repository (the nearest folder above it with a
// `.git` entry), so `docs/page.md` can show `../images/x.png`; otherwise the document's own folder.
// DECISION: a repository at the home folder or the disk root (a dotfiles repo) doesn't count, since it
// would open every file in the home folder to any Markdown file under it.
fn image_root(document: &Path, home: Option<&Path>) -> Option<PathBuf> {
  let folder = document.parent()?;
  let repo = folder.ancestors().find(|dir| dir.join(".git").exists());
  Some(match repo {
    Some(root) if root.parent().is_some() && Some(root) != home => root.to_path_buf(),
    _ => folder.to_path_buf(),
  })
}

// A local image the document may show: inside its image root after resolving symlinks, a regular file,
// an image type, and not too large.
fn scoped_image_path(document: &Path, source: &Path, home: Option<&Path>) -> Option<PathBuf> {
  let document = fs::canonicalize(document).ok()?;
  let root = image_root(&document, home)?;
  let candidate = if source.is_absolute() { source.to_path_buf() } else { document.parent()?.join(source) };
  let image = fs::canonicalize(candidate).ok()?;
  let meta = fs::metadata(&image).ok()?;
  let ok = image.starts_with(&root) && meta.is_file() && meta.len() <= IMAGE_LIMIT && has_extension(&image, IMAGE_EXTENSIONS);
  ok.then_some(image)
}

// The asset protocol starts with nothing allowed; each image a document shows is allowed on its own.
#[tauri::command]
fn resolve_image_path<R: Runtime>(
  app: tauri::AppHandle<R>,
  document_path: String,
  source: String,
  authorized: tauri::State<AuthorizedDocuments>,
) -> Option<String> {
  let document = authorized.require(Path::new(&document_path), false).ok()?;
  let home = std::env::var_os("HOME").map(PathBuf::from).and_then(|h| fs::canonicalize(h).ok());
  let image = scoped_image_path(&document, Path::new(&source), home.as_deref())?;
  app.asset_protocol_scope().allow_file(&image).ok()?;
  image.to_str().map(str::to_owned)
}

// Dropped files that may be opened as documents: a document extension and a regular file.
fn droppable_documents(paths: &[PathBuf]) -> Vec<&PathBuf> {
  paths.iter().filter(|p| has_extension(p, DOCUMENT_EXTENSIONS) && fs::metadata(p).is_ok_and(|m| m.is_file())).collect()
}

// Async so Tauri runs these off the main thread: a blocking dialog on the main thread hangs macOS.
#[tauri::command]
async fn open_dialog<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Option<String>, String> {
  let selected = app.dialog().file().add_filter("Markdown and text", &["md", "markdown", "mdown", "txt"])
    .blocking_pick_file();
  selected.map(|p| authorize_document(&app, &p.into_path().map_err(|e| e.to_string())?, false)).transpose()
}

#[tauri::command]
async fn save_dialog<R: Runtime>(app: tauri::AppHandle<R>, default_path: String) -> Result<Option<String>, String> {
  let default = Path::new(&default_path);
  let name = default.file_name().and_then(|s| s.to_str()).unwrap_or("Untitled.md");
  let mut dialog = app.dialog().file().add_filter("Markdown and text", &["md", "markdown", "mdown", "txt"])
    .set_file_name(name);
  if let Some(dir) = default.parent().filter(|p| !p.as_os_str().is_empty() && p.is_dir()) { dialog = dialog.set_directory(dir); }
  let selected = dialog.blocking_save_file();
  selected.map(|p| authorize_document(&app, &p.into_path().map_err(|e| e.to_string())?, true)).transpose()
}

#[tauri::command]
fn frontend_ready(startup: tauri::State<Startup>) -> Vec<String> {
  startup.ready.store(true, Ordering::SeqCst);
  std::mem::take(&mut *startup.pending.lock().unwrap())
}

#[derive(serde::Serialize, Debug)]
struct Document { text: String, bom: bool, path: String }

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

#[cfg(test)]
fn c_path(path: &Path) -> Result<CString, String> {
  CString::new(path.as_os_str().as_bytes()).map_err(|_| "Invalid file path".to_string())
}

fn fd_path(fd: std::os::unix::io::RawFd) -> Result<PathBuf, String> {
  let mut buf = vec![0u8; libc::MAXPATHLEN as usize];
  let rc = unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr().cast::<libc::c_char>()) };
  if rc == -1 { return Err(std::io::Error::last_os_error().to_string()); }
  let len = buf.iter().position(|b| *b == 0).ok_or_else(|| "couldn't read the opened path".to_string())?;
  Ok(PathBuf::from(OsStr::from_bytes(&buf[..len])))
}

// DECISION: `O_NOFOLLOW` only rejects a symlink at the final component, so a `/var` → `/private/var`
// parent still opens. Accept that parent resolution; reject anything whose final name differs.
fn same_opened_file(requested: &Path, opened: &Path) -> bool {
  if opened == requested { return true; }
  let Some(name) = requested.file_name() else { return false };
  if opened.file_name() != Some(name) { return false; }
  let Some(parent) = requested.parent().filter(|p| !p.as_os_str().is_empty()) else { return false };
  fs::canonicalize(parent).ok().is_some_and(|dir| opened == dir.join(name))
}

// ACLs and extended attributes (Finder tags included), copied fd to fd so a swapped symlink is not followed.
fn copy_metadata_fd(from: &fs::File, to: &fs::File) -> Result<(), String> {
  let rc = unsafe { libc::fcopyfile(from.as_raw_fd(), to.as_raw_fd(), std::ptr::null_mut(), libc::COPYFILE_METADATA) };
  if rc == 0 { return Ok(()) }
  let err = std::io::Error::last_os_error();
  // Volumes without ACLs or extended attributes (FAT, some network shares) have none to lose.
  if matches!(err.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)) { return Ok(()) }
  Err(format!("couldn't copy file metadata: {err}"))
}

fn open_existing(dirfd: libc::c_int, name: &CStr) -> Result<Option<fs::File>, String> {
  let fd = unsafe { libc::openat(dirfd, name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
  if fd >= 0 { return Ok(Some(unsafe { fs::File::from_raw_fd(fd) })); }
  let err = std::io::Error::last_os_error();
  if err.kind() == std::io::ErrorKind::NotFound { return Ok(None); }
  Err(err.to_string())
}

fn create_temp(dirfd: libc::c_int, name: &OsStr) -> Result<(CString, fs::File), String> {
  loop {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temp_name = format!(".{}.openviewer-{}-{id}.tmp", name.to_string_lossy(), std::process::id());
    let temp_c = CString::new(temp_name).map_err(|_| "Invalid file path".to_string())?;
    // O_CLOEXEC: don't leak the temp fd across exec. O_NOFOLLOW: the name must be the new file, not a link.
    let fd = unsafe {
      libc::openat(
        dirfd,
        temp_c.as_ptr(),
        libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o666 as libc::c_int,
      )
    };
    if fd >= 0 { return Ok((temp_c, unsafe { fs::File::from_raw_fd(fd) })); }
    let err = std::io::Error::last_os_error();
    if err.kind() == std::io::ErrorKind::AlreadyExists { continue; }
    return Err(err.to_string());
  }
}

#[tauri::command]
fn read_document(path: String, authorized: tauri::State<AuthorizedDocuments>) -> Result<Document, String> {
  read_authorized_document(&authorized, Path::new(&path))
}

fn read_authorized_document(authorized: &AuthorizedDocuments, path: &Path) -> Result<Document, String> {
  let target = authorized.require(path, false)?;
  read_document_file(&target)
}

fn read_document_file(path: &Path) -> Result<Document, String> {
  // O_NONBLOCK: opening a FIFO would otherwise wait forever for a writer.
  // O_NOFOLLOW: a symlink swapped in after authorization must not be read.
  let file = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(path).map_err(|e| e.to_string())?;
  let opened = fd_path(file.as_raw_fd())?;
  if !same_opened_file(path, &opened) {
    return Err(format!("document changed while opening (opened {}, expected {})", opened.display(), path.display()));
  }
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
  Ok(Document { text, bom, path: path.to_string_lossy().into_owned() })
}

#[tauri::command]
fn write_document(path: String, text: String, bom: bool, authorized: tauri::State<AuthorizedDocuments>) -> Result<(), String> {
  write_authorized_document(&authorized, Path::new(&path), text, bom)
}

fn write_authorized_document(authorized: &AuthorizedDocuments, path: &Path, text: String, bom: bool) -> Result<(), String> {
  let target = authorized.require(path, true)?;
  write_document_file(&target, text, bom)
}

#[cfg(test)]
fn write_document_trusted(path: &Path, text: String, bom: bool) -> Result<(), String> {
  let target = canonical_document(path, true)?;
  write_document_file(&target, text, bom)
}

// Does not resolve `path`'s final component. Keybindings use this so a symlink is not overwritten.
pub(crate) fn write_regular_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
  match fs::symlink_metadata(path) {
    Ok(meta) if meta.file_type().is_symlink() => {
      return Err(format!("{} is a symbolic link and will not be followed", path_name(path)));
    }
    Ok(meta) if !meta.is_file() => return Err(format!("{} is not a regular file", path_name(path))),
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
    _ => {}
  }
  let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).ok_or_else(|| "Invalid file path".to_string())?;
  let name = path.file_name().ok_or_else(|| "Invalid file path".to_string())?;
  let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
  write_bytes_atomic(&parent.join(name), bytes)
}

fn write_document_file(target: &Path, text: String, bom: bool) -> Result<(), String> {
  let mut bytes = Vec::with_capacity(text.len() + if bom { 3 } else { 0 });
  if bom { bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]); }
  bytes.extend_from_slice(text.as_bytes());
  write_bytes_atomic(target, &bytes)
}

fn write_bytes_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
  // The authorized target is canonical, so replacing it keeps a symlink the user chose intact.
  // The directory fd is checked with F_GETPATH, and the final name is never followed.
  let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("/"));
  let name = target.file_name().ok_or_else(|| "Invalid file path".to_string())?;
  let dir = OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(parent).map_err(|e| e.to_string())?;
  let opened_parent = fd_path(dir.as_raw_fd())?;
  if opened_parent != parent {
    return Err(format!("document directory changed while opening (opened {}, expected {})", opened_parent.display(), parent.display()));
  }
  let dirfd = dir.as_raw_fd();
  let name_c = CString::new(name.as_bytes()).map_err(|_| "Invalid file path".to_string())?;
  let existing = open_existing(dirfd, &name_c)?;
  if let Some(existing) = &existing {
    let meta = existing.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() { return Err(format!("{} is not a regular file", path_name(target))); }
  }
  let (temp_c, mut file) = create_temp(dirfd, name)?;
  let result = (|| {
    if let Some(existing) = &existing {
      let meta = existing.metadata().map_err(|e| e.to_string())?;
      file.set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
    }
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if let Some(existing) = &existing {
      copy_metadata_fd(existing, &file)?;
      let meta = existing.metadata().map_err(|e| e.to_string())?;
      // DECISION: a group we can't set (EPERM) must not fail the save. fcopyfile reports success anyway.
      let _ = unsafe { libc::fchown(file.as_raw_fd(), -1i32 as libc::uid_t, meta.gid()) };
    }
    let rc = unsafe { libc::renameat(dirfd, temp_c.as_ptr(), dirfd, name_c.as_ptr()) };
    if rc != 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(())
  })();
  if result.is_err() { let _ = unsafe { libc::unlinkat(dirfd, temp_c.as_ptr(), 0) }; }
  result
}

#[tauri::command]
fn create_document_window<R: Runtime>(app: tauri::AppHandle<R>, path: Option<String>) -> Result<(), String> {
  let url = match path {
    Some(path) => {
      let target = app.state::<AuthorizedDocuments>().require(Path::new(&path), false)?;
      format!("index.html?path={}", encode_query(&target.to_string_lossy()))
    }
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
    .manage(AuthorizedDocuments::default())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
      }
      menu::load(app.handle())?;
      app.asset_protocol_scope().forbid_directory("/dev", true)?;
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
      tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
        let app = window.app_handle();
        // Tauri adds every dropped file and folder to the asset scope. Take that back: documents are read
        // through read_document, and images are allowed one at a time by resolve_image_path.
        // DECISION: dropping a folder forbids it for this session, even if a document inside it is open.
        let scope = app.asset_protocol_scope();
        for path in paths {
          let _ = if path.is_dir() { scope.forbid_directory(path, true) } else { scope.forbid_file(path) };
        }
        if window.label() != "preferences" {
          let allowed: Vec<_> = droppable_documents(paths).into_iter().filter_map(|p| authorize_document(app, p, false).ok()).collect();
          if !allowed.is_empty() { let _ = app.emit_to(window.label(), "authorized-drop", allowed); }
        }
      }
      _ => {}
    })
    .invoke_handler(tauri::generate_handler![
      read_document,
      write_document,
      open_dialog,
      save_dialog,
      resolve_image_path,
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
            let Ok(path) = authorize_document(app, &path, false) else { continue };
            let startup = app.state::<Startup>();
            if !startup.ready.load(Ordering::SeqCst) {
              startup.pending.lock().unwrap().push(path);
            } else if let Some(window) = app.webview_windows().values().find(|w| w.label() != "preferences" && w.is_focused().unwrap_or(false)) {
              let _ = app.emit_to(window.label(), "open-path", path);
            } else if let Some(label) = app.state::<LastDocument>().0.lock().unwrap().clone().filter(|label| app.get_webview_window(label).is_some()) {
              let _ = app.emit_to(label, "open-path", path);
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
    let p = path("bom"); write_document_trusted(&p, "hello".into(), true).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"\xef\xbb\xbfhello");
    assert_eq!(read_document_file(&p).unwrap().text, "hello");
    let _ = fs::remove_file(p);
  }
  #[test]
  fn crlf_bytes_are_untouched() {
    let p = path("crlf"); fs::write(&p, b"a\r\nb\r\n").unwrap();
    let doc = read_document_file(&p).unwrap();
    write_document_trusted(&p, doc.text, doc.bom).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"a\r\nb\r\n");
    let _ = fs::remove_file(p);
  }
  #[test]
  fn atomic_write_replaces_existing_file() {
    let p = path("replace"); fs::write(&p, b"old").unwrap();
    write_document_trusted(&p, "new".into(), false).unwrap();
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
    write_document_trusted(&link, "new".into(), false).unwrap();
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
    write_document_trusted(&p, "new".into(), false).unwrap();
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
    let err = read_document_file(&p).unwrap_err();
    assert!(err.contains("too large to open"), "{err}");
    assert!(err.contains("65 MB"), "{err}");
    assert!(err.contains("64 MB"), "{err}");
    let _ = fs::remove_file(p);
  }
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
    let err = read_document_file(&dir).unwrap_err();
    assert!(err.to_lowercase().contains("directory"), "{err}");
    let _ = fs::remove_dir(dir);
  }

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
    assert!(write_authorized_document(&paths, &chosen, "bad".into(), false).is_err());
    assert_eq!(fs::read_to_string(&chosen).unwrap(), "chosen");
    paths.authorize(&chosen, false).unwrap();
    assert_eq!(read_authorized_document(&paths, &chosen).unwrap().text, "chosen");
    write_authorized_document(&paths, &chosen, "saved".into(), false).unwrap();
    assert_eq!(fs::read_to_string(&chosen).unwrap(), "saved");
    assert!(read_authorized_document(&paths, &link).is_err());
    assert!(write_authorized_document(&paths, &link, "bad".into(), false).is_err());
    assert_eq!(fs::read_to_string(&private).unwrap(), "private");
    let new_file = dir.join("new.md");
    paths.authorize(&new_file, true).unwrap();
    write_authorized_document(&paths, &new_file, "new".into(), false).unwrap();
    assert_eq!(read_authorized_document(&paths, &new_file).unwrap().text, "new");
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn images_stay_in_the_canonical_document_folder() {
    let dir = path("images");
    let folder = dir.join("document");
    fs::create_dir_all(&folder).unwrap();
    let doc = folder.join("page.md");
    let local = folder.join("local.png");
    let outside = dir.join("outside.png");
    let link = folder.join("link.png");
    fs::write(&doc, "").unwrap();
    fs::write(&local, "local").unwrap();
    fs::write(&outside, "outside").unwrap();
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let canonical_local = fs::canonicalize(&local).unwrap();
    assert_eq!(scoped_image_path(&doc, Path::new("local.png"), None), Some(canonical_local.clone()));
    assert_eq!(scoped_image_path(&doc, &local, None), Some(canonical_local));
    assert_eq!(scoped_image_path(&doc, Path::new("../outside.png"), None), None);
    assert_eq!(scoped_image_path(&doc, &outside, None), None);
    assert_eq!(scoped_image_path(&doc, Path::new("link.png"), None), None);
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn images_may_come_from_the_documents_repository() {
    let dir = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("openviewer-repo-{}-{}", std::process::id(), TEMP_ID.fetch_add(1, Ordering::Relaxed)));
    let repo = dir.join("project");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(repo.join("docs")).unwrap();
    fs::create_dir_all(repo.join("images")).unwrap();
    let doc = repo.join("docs/page.md");
    fs::write(&doc, "").unwrap();
    fs::write(repo.join("images/x.png"), "png").unwrap();
    fs::write(repo.join("images/notes.txt"), "text").unwrap();
    fs::write(dir.join("secret.png"), "secret").unwrap();
    std::os::unix::fs::symlink(dir.join("secret.png"), repo.join("images/escape.png")).unwrap();
    fs::File::create(repo.join("images/huge.png")).unwrap().set_len(IMAGE_LIMIT + 1).unwrap();
    assert_eq!(scoped_image_path(&doc, Path::new("../images/x.png"), None), Some(repo.join("images/x.png")));
    assert_eq!(scoped_image_path(&doc, Path::new("../../secret.png"), None), None); // above the repository
    assert_eq!(scoped_image_path(&doc, &dir.join("secret.png"), None), None); // absolute, outside
    assert_eq!(scoped_image_path(&doc, Path::new("../images/escape.png"), None), None); // symlink out
    assert_eq!(scoped_image_path(&doc, Path::new("../images/notes.txt"), None), None); // not an image
    assert_eq!(scoped_image_path(&doc, Path::new("../images/huge.png"), None), None); // over the limit
    // A repository at the home folder is ignored: only the document's own folder counts.
    assert_eq!(scoped_image_path(&doc, Path::new("../images/x.png"), Some(&repo)), None);
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn only_regular_document_files_are_accepted_from_a_drop() {
    let dir = path("drop");
    fs::create_dir_all(dir.join("folder.md")).unwrap();
    for name in ["note.md", "Read.MARKDOWN", "photo.png", "key"] { fs::write(dir.join(name), "").unwrap(); }
    let paths: Vec<PathBuf> = ["note.md", "Read.MARKDOWN", "photo.png", "key", "folder.md", "missing.md"].iter().map(|n| dir.join(n)).collect();
    let accepted: Vec<_> = droppable_documents(&paths).into_iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(accepted, ["note.md", "Read.MARKDOWN"]);
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn swapped_symlink_is_not_followed_on_read_or_write() {
    // require() hands back a canonical path; read and write open it again. A symlink dropped in
    // between must fail closed and leave the link target untouched.
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
    assert!(write_authorized_document(&paths, &canonical, "pwned".into(), false).is_err());
    assert!(read_document_file(&canonical).is_err());
    assert!(write_document_file(&canonical, "pwned".into(), false).is_err());
    assert_eq!(fs::read_to_string(&other).unwrap(), "other");
    assert!(fs::symlink_metadata(&canonical).unwrap().file_type().is_symlink());
    let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
      .map(|e| e.file_name().to_string_lossy().into_owned())
      .filter(|n| n.contains("openviewer-")).collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn write_regular_file_does_not_follow_a_symlink() {
    let dir = path("reglink");
    fs::create_dir(&dir).unwrap();
    let secret = dir.join("secret.md");
    let link = dir.join("link.md");
    fs::write(&secret, b"secret").unwrap();
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    let err = write_regular_file(&link, b"pwned").unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    assert_eq!(fs::read(&secret).unwrap(), b"secret");
    assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    let plain = dir.join("plain.md");
    write_regular_file(&plain, b"ok").unwrap();
    assert_eq!(fs::read(&plain).unwrap(), b"ok");
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn document_dialog_permission_is_message_only() {
    let document: serde_json::Value = serde_json::from_str(include_str!("../capabilities/documents.json")).unwrap();
    let docs = document["permissions"].as_array().unwrap();
    assert!(docs.contains(&serde_json::json!("dialog:allow-message")));
    for permission in ["dialog:default", "dialog:allow-open", "dialog:allow-save", "dialog:allow-ask", "dialog:allow-confirm"] {
      assert!(!docs.contains(&serde_json::json!(permission)), "{permission}");
    }
  }

  #[test]
  fn preferences_capability_cannot_use_document_commands() {
    let document: serde_json::Value = serde_json::from_str(include_str!("../capabilities/documents.json")).unwrap();
    let preferences: serde_json::Value = serde_json::from_str(include_str!("../capabilities/preferences.json")).unwrap();
    assert_eq!(document["windows"], serde_json::json!(["main", "document-*"]));
    assert_eq!(preferences["windows"], serde_json::json!(["preferences"]));
    let docs = document["permissions"].as_array().unwrap();
    let prefs = preferences["permissions"].as_array().unwrap();
    assert!(docs.contains(&serde_json::json!("core:window:allow-destroy")));
    assert!(!prefs.contains(&serde_json::json!("core:window:allow-destroy")));
    for permission in ["allow-read-document", "allow-write-document", "allow-create-document-window", "allow-open-dialog", "allow-save-dialog", "allow-resolve-image-path"] {
      assert!(docs.contains(&serde_json::json!(permission)));
      assert!(!prefs.contains(&serde_json::json!(permission)));
    }
  }
}
