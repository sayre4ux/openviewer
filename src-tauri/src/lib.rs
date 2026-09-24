// OpenViewer's Tauri shell: windows, the menu, and the commands the editor calls. Documents and
// images live in their own modules; OS-specific file operations are in `platform`.

use std::{
  path::Path,
  sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex},
};
use tauri::{webview::WebviewWindowBuilder, Emitter, Manager, Runtime};

mod documents;
mod export;
mod images;
mod menu;
mod platform;
mod settings;

use documents::{authorize_document, droppable_documents, AuthorizedDocuments};

static WINDOW_ID: AtomicU64 = AtomicU64::new(0);

// Files the OS asks us to open before the first window's frontend is listening (a cold launch via
// Open With, or file arguments). The first window collects them through `frontend_ready`.
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

// A file the OS asked us to open: into the focused (or last) document window, or a new one.
fn open_requested<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path) {
  let Ok(path) = authorize_document(app, path, false) else { return };
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
  let label = format!("document-{}", WINDOW_ID.fetch_add(1, Ordering::Relaxed));
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
    .manage(images::ImageGrants::default())
    .manage(images::DroppedImages::default())
    .manage(settings::SettingsState::default())
    .manage(export::ExportTargets::default())
    // Local images are served from our own scheme, never from a directory scope. The file is read on
    // a worker thread: WebKit calls scheme handlers on the main thread.
    .register_asynchronous_uri_scheme_protocol(images::SCHEME, |ctx, request, responder| {
      let app = ctx.app_handle().clone();
      tauri::async_runtime::spawn_blocking(move || {
        responder.respond(images::respond(&app.state::<images::ImageGrants>(), &request));
      });
    })
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
      }
      menu::load(app.handle())?;
      settings::load(app.handle());
      // Windows and Linux pass files to open as arguments; macOS sends RunEvent::Opened instead.
      #[cfg(not(target_os = "macos"))]
      for arg in std::env::args_os().skip(1) {
        let path = std::path::PathBuf::from(arg);
        if path.is_file() { open_requested(app.handle(), &path); }
      }
      // Development only: OPENVIEWER_PDF_SELFTEST="page.html:out.pdf" prints a page to PDF and quits,
      // so the native print path can be checked without clicking through the app.
      #[cfg(debug_assertions)]
      if let Some((input, output)) = std::env::var("OPENVIEWER_PDF_SELFTEST").ok().and_then(|v| v.split_once(':').map(|(a, b)| (a.to_owned(), b.to_owned()))) {
        let app = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let result = match std::fs::read_to_string(&input) {
            Ok(html) => export::render_pdf(&app, html).await.and_then(|pdf| std::fs::write(&output, pdf).map_err(|e| e.to_string())),
            Err(e) => Err(e.to_string()),
          };
          eprintln!("pdf selftest: {result:?}");
          app.exit(if result.is_ok() { 0 } else { 1 });
        });
      }
      Ok(())
    })
    .on_menu_event(|app, event| {
      if event.id().as_ref() == "preferences" {
        menu::open_preferences(app);
        return;
      }
      let id = event.id().as_ref();
      // Every window closes, or asks to save first; Cancel keeps that document open.
      if id == "quit" {
        let _ = app.emit("quit-request", ());
        return;
      }
      let Some(focused) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) else { return };
      // File commands chosen while Preferences is in front go to the last document window;
      // Preferences handles everything else itself (Close, Quit, Undo in its search field).
      let for_document = matches!(id, "new" | "open" | "save" | "save-as" | "save-as-utf8" | "export-pdf" | "export-html");
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
      tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) if window.label() != "preferences" => {
        let app = window.app_handle();
        let allowed: Vec<_> = droppable_documents(paths).into_iter().filter_map(|p| authorize_document(app, p, false).ok()).collect();
        if !allowed.is_empty() { let _ = app.emit_to(window.label(), "authorized-drop", allowed); }
        // Dropped images are copied next to the document (insert_dropped_image), once each.
        let images = images::droppable_images(paths);
        if !images.is_empty() {
          app.state::<images::DroppedImages>().0.lock().unwrap().extend(images.iter().map(|p| (p.clone(), window.label().to_string())));
          let (x, y) = match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { position, .. }) => (position.x, position.y),
            _ => (0.0, 0.0),
          };
          let paths: Vec<String> = images.iter().map(|p| p.to_string_lossy().into_owned()).collect();
          let _ = app.emit_to(window.label(), "dropped-images", serde_json::json!({ "paths": paths, "x": x, "y": y }));
        }
      }
      _ => {}
    })
    .invoke_handler(tauri::generate_handler![
      documents::read_document,
      documents::write_document,
      documents::open_dialog,
      documents::save_dialog,
      images::resolve_image_path,
      images::allow_image_folder,
      images::insert_image,
      images::insert_dropped_image,
      settings::get_settings,
      settings::set_settings,
      export::export_dialog,
      export::export_html,
      export::export_pdf,
      export::export_image,
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
          if let Ok(path) = url.to_file_path() { open_requested(app, &path); }
        }
      }
    });
}

#[cfg(test)]
mod tests {
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
    // onCloseRequested in @tauri-apps/api calls destroy() once the handler lets the close go ahead.
    assert!(docs.contains(&serde_json::json!("core:window:allow-destroy")));
    // Windows never broadcast events: a window could otherwise send "menu" commands to the others.
    assert!(!docs.contains(&serde_json::json!("core:event:allow-emit")));
    assert!(!prefs.contains(&serde_json::json!("core:event:allow-emit")));
    assert!(!prefs.contains(&serde_json::json!("core:window:allow-destroy")));
    for permission in ["allow-read-document", "allow-write-document", "allow-create-document-window", "allow-open-dialog", "allow-save-dialog", "allow-resolve-image-path"] {
      assert!(docs.contains(&serde_json::json!(permission)));
      assert!(!prefs.contains(&serde_json::json!(permission)));
    }
  }
}
