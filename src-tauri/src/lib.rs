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
mod links;
mod menu;
mod platform;
mod settings;
mod updater;

use documents::{authorize_document, droppable_documents, AuthorizedDocuments};

static WINDOW_ID: AtomicU64 = AtomicU64::new(0);

// Files the OS asks us to open before the first window's frontend is listening (a cold launch via
// Open With, or file arguments). The first window collects them through `frontend_ready`.
#[derive(Default)]
struct Startup { ready: AtomicBool, pending: Mutex<Vec<String>> }

// The document window that was focused last, so menu commands chosen while Settings is in
// front still reach a document.
#[derive(Default)]
struct LastDocument(Mutex<Option<String>>);

// The last focused document window, if it is still open. The lock is released before this returns:
// callers go on to create windows, and `cascade_position` takes the same lock.
fn last_document<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
  let label = app.state::<LastDocument>().0.lock().unwrap().clone();
  label.filter(|label| app.get_webview_window(label).is_some())
}

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
  } else if let Some(label) = last_document(app) {
    let _ = app.emit_to(label, "open-path", path);
  } else {
    let _ = create_document_window(app.clone(), Some(path));
  }
}

#[tauri::command]
fn create_document_window<R: Runtime>(app: tauri::AppHandle<R>, path: Option<String>) -> Result<(), String> {
  match path {
    Some(path) => {
      let target = app.state::<AuthorizedDocuments>().require(Path::new(&path), false)?;
      open_document_window(&app, &target, None)
    }
    None => open_window(&app, "index.html".to_string()),
  }
}

// A window for an authorized document; `anchor` is a heading to scroll to once it loads.
pub(crate) fn open_document_window<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path, anchor: Option<&str>) -> Result<(), String> {
  let mut url = format!("index.html?path={}", encode_query(&path.to_string_lossy()));
  if let Some(anchor) = anchor { url.push_str(&format!("&anchor={}", encode_query(anchor))); }
  open_window(app, url)
}

const WINDOW_SIZE: (f64, f64) = (1100.0, 760.0);
// DECISION: 22 points down and right of the front document window, as AppKit's cascade does.
const CASCADE: f64 = 22.0;

fn open_window<R: Runtime>(app: &tauri::AppHandle<R>, url: String) -> Result<(), String> {
  let label = format!("document-{}", WINDOW_ID.fetch_add(1, Ordering::Relaxed));
  // DECISION: document windows keep WebKit's persistent store (not `incognito`): the outline and word
  // count toggles live in localStorage. WebKit blocks third-party cookies here, but with remote images on
  // a server could still recognize a reader through the HTTP cache; Settings says so.
  let builder = WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into()))
    .title("OpenViewer").inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1).min_inner_size(480.0, 360.0);
  let builder = match cascade_position(app) { Some((x, y)) => builder.position(x, y), None => builder };
  builder.build().map(|_| ()).map_err(|e| e.to_string())
}

// Where a new document window goes so it doesn't hide the one in front: offset from the focused (or
// last focused) document window, past any window already sitting there, back to the screen's top left
// once the window would run off the bottom or right.
fn cascade_position<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<(f64, f64)> {
  let windows = app.webview_windows();
  let documents: Vec<_> = windows.values().filter(|w| w.label() != "preferences").collect();
  let front = documents.iter().find(|w| w.is_focused().unwrap_or(false)).copied()
    .or_else(|| last_document(app).and_then(|label| windows.get(&label)))?;
  let scale = front.scale_factor().ok()?;
  let at = front.outer_position().ok()?.to_logical::<f64>(scale);
  // The new window's frame: its content size plus the title bar the front window has.
  let title_bar = match (front.outer_size(), front.inner_size()) {
    (Ok(outer), Ok(inner)) => (outer.to_logical::<f64>(scale).height - inner.to_logical::<f64>(scale).height).max(0.0),
    _ => 0.0,
  };
  let screen = front.current_monitor().ok().flatten().map(|m| {
    let (p, s) = (m.work_area().position.to_logical::<f64>(scale), m.work_area().size.to_logical::<f64>(scale));
    (p.x, p.y, s.width, s.height)
  });
  // Each window's own scale factor, so windows on another display compare in the same points.
  let taken: Vec<(f64, f64)> = documents.iter()
    .filter_map(|w| Some(w.outer_position().ok()?.to_logical::<f64>(w.scale_factor().ok()?)))
    .map(|p| (p.x, p.y))
    .collect();
  Some(cascade_from((at.x, at.y), (WINDOW_SIZE.0, WINDOW_SIZE.1 + title_bar), screen, &taken))
}

fn cascade_from(front: (f64, f64), frame: (f64, f64), screen: Option<(f64, f64, f64, f64)>, taken: &[(f64, f64)]) -> (f64, f64) {
  let fits = |p: (f64, f64)| screen.map_or(true, |(sx, sy, sw, sh)| p.0 + frame.0 <= sx + sw && p.1 + frame.1 <= sy + sh);
  let free = |p: (f64, f64)| !taken.iter().any(|t| (t.0 - p.0).abs() < 1.0 && (t.1 - p.1).abs() < 1.0);
  let mut p = (front.0 + CASCADE, front.1 + CASCADE);
  // Bounded: with every step taken (a screen too small to cascade on) the last candidate is used.
  for _ in 0..64 {
    if !fits(p) {
      if let Some((sx, sy, _, _)) = screen { p = (sx + CASCADE, sy + CASCADE); }
    }
    if free(p) { break; }
    p = (p.0 + CASCADE, p.1 + CASCADE);
  }
  p
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
    .manage(updater::RuntimeState::default())
    .manage(updater::CloseCoordinator::default())
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
      if updater::is_configured(&app.config().plugins.0) {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        updater::start_daily_checks(app.handle().clone());
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
      if id == "check-for-updates" {
        updater::check_from_menu(app.clone());
        return;
      }
      // Every window closes, or asks to save first; Cancel keeps that document open.
      if id == "quit" {
        let _ = app.emit("quit-request", ());
        return;
      }
      let Some(focused) = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false)) else { return };
      // File commands chosen while Settings is in front go to the last document window;
      // Settings handles everything else itself (Close, Quit, Undo in its search field).
      let for_document = matches!(id, "new" | "open" | "save" | "save-as" | "save-as-utf8" | "export-pdf" | "export-html");
      let target = if focused.label() == "preferences" && for_document {
        last_document(app)
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
      // Settings closed mid-recording: bring the menu's shortcuts back.
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
      links::open_linked_document,
      documents::write_document,
      documents::open_dialog,
      documents::save_dialog,
      images::resolve_image_path,
      images::allow_image_folder,
      images::insert_image,
      images::insert_dropped_image,
      settings::get_settings,
      settings::set_settings,
      updater::update_quit_response,
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
  fn new_windows_cascade_and_wrap() {
    use super::cascade_from;
    let screen = Some((0.0, 25.0, 1920.0, 1055.0));
    let frame = (1100.0, 788.0);
    assert_eq!(cascade_from((410.0, 103.0), frame, screen, &[(410.0, 103.0)]), (432.0, 125.0));
    // A window already there (opened while no window had focus): step past it.
    assert_eq!(cascade_from((410.0, 103.0), frame, screen, &[(410.0, 103.0), (432.0, 125.0)]), (454.0, 147.0));
    // The frame, title bar included, would run off the bottom: back to the top left of the screen.
    assert_eq!(cascade_from((410.0, 280.0), frame, screen, &[]), (22.0, 47.0));
    // Would run off the right.
    assert_eq!(cascade_from((820.0, 103.0), frame, screen, &[]), (22.0, 47.0));
    assert_eq!(cascade_from((0.0, 0.0), frame, None, &[]), (22.0, 22.0));
    // No room to cascade at all: still returns a position, the screen's top left step.
    let tiny = Some((0.0, 0.0, 1100.0, 788.0));
    assert_eq!(cascade_from((0.0, 0.0), frame, tiny, &[]), (22.0, 22.0));
    let crowded: Vec<_> = (1..=70).map(|i| (22.0 * i as f64, 22.0 * i as f64)).collect();
    let p = cascade_from((0.0, 0.0), frame, None, &crowded);
    assert!(p.0.is_finite() && p.1.is_finite());
  }

  // Regression: the last-window lock was held across the `else` that creates a window, and
  // `cascade_position` takes it again, so opening a file with no document window open hung.
  #[test]
  fn opening_a_file_with_no_document_window_returns() {
    use std::{sync::{atomic::Ordering, mpsc}, time::Duration};
    use tauri::Manager;
    let app = tauri::test::mock_builder()
      .manage(super::Startup::default())
      .manage(super::LastDocument::default())
      .manage(crate::documents::AuthorizedDocuments::default())
      .build(tauri::test::mock_context(tauri::test::noop_assets()))
      .unwrap();
    app.state::<super::Startup>().ready.store(true, Ordering::SeqCst);
    *app.state::<super::LastDocument>().0.lock().unwrap() = Some("document-closed".into());
    let dir = std::env::temp_dir().join(format!("openviewer-open-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("note.md");
    std::fs::write(&file, "# note\n").unwrap();
    let handle = app.handle().clone();
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
      super::open_requested(&handle, &file);
      let _ = done.send(());
    });
    let returned = finished.recv_timeout(Duration::from_secs(10)).is_ok();
    let _ = std::fs::remove_dir_all(&dir);
    // A hung thread still holds app state; dropping the app would wait on it and hang the test run.
    if !returned { std::mem::forget(app); }
    assert!(returned, "open_requested did not return: a lock is held while a window is created");
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
    // onCloseRequested in @tauri-apps/api calls destroy() once the handler lets the close go ahead.
    assert!(docs.contains(&serde_json::json!("core:window:allow-destroy")));
    // Windows never broadcast events: a window could otherwise send "menu" commands to the others.
    assert!(!docs.contains(&serde_json::json!("core:event:allow-emit")));
    assert!(!prefs.contains(&serde_json::json!("core:event:allow-emit")));
    assert!(!docs.iter().any(|permission| permission.as_str().is_some_and(|value| value.starts_with("updater:"))));
    assert!(!prefs.iter().any(|permission| permission.as_str().is_some_and(|value| value.starts_with("updater:"))));
    assert!(!prefs.contains(&serde_json::json!("core:window:allow-destroy")));
    for permission in ["allow-read-document", "allow-write-document", "allow-create-document-window", "allow-open-dialog", "allow-save-dialog", "allow-resolve-image-path", "allow-open-linked-document"] {
      assert!(docs.contains(&serde_json::json!(permission)));
      assert!(!prefs.contains(&serde_json::json!(permission)));
    }
    // Only the Settings window changes settings: a document could otherwise turn remote images on.
    assert!(prefs.contains(&serde_json::json!("allow-set-settings")));
    assert!(!docs.contains(&serde_json::json!("allow-set-settings")));
  }
}
