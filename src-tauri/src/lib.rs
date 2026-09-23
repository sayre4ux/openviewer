use std::{fs::{self, OpenOptions}, io::Write, path::Path, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex}};
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

#[derive(serde::Serialize)]
struct Document { text: String, bom: bool }

#[tauri::command]
fn read_document(path: String) -> Result<Document, String> {
  let bytes = fs::read(path).map_err(|e| e.to_string())?;
  let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
  let body = if bom { &bytes[3..] } else { &bytes[..] };
  let text = String::from_utf8(body.to_vec()).map_err(|_| "File is not valid UTF-8".to_string())?;
  Ok(Document { text, bom })
}

#[tauri::command]
fn write_document(path: String, text: String, bom: bool) -> Result<(), String> {
  let target = Path::new(&path);
  let parent = target.parent().unwrap_or_else(|| Path::new("."));
  let name = target.file_name().ok_or_else(|| "Invalid file path".to_string())?.to_string_lossy();
  let permissions = fs::metadata(target).ok().map(|m| m.permissions());
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
    if let Some(perms) = permissions { file.set_permissions(perms).map_err(|e| e.to_string())?; }
    if bom { file.write_all(&[0xef, 0xbb, 0xbf]).map_err(|e| e.to_string())?; }
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp_path, target).map_err(|e| e.to_string())
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
    .plugin(tauri_plugin_fs::init())
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
}
