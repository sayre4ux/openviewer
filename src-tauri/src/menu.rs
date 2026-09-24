// The native menu, built from the shared command list (src/shared/commands.json) plus the user's
// shortcut overrides in `keybindings.json` in the app's config folder. The frontend's Preferences
// window edits the overrides; editing the file by hand works too and is picked up when a window
// regains focus.

use std::{
  collections::HashMap,
  fs,
  io::Read,
  path::{Path, PathBuf},
  sync::Mutex,
  time::SystemTime,
};
use tauri::{
  menu::{CheckMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder},
  webview::WebviewWindowBuilder,
  AppHandle, Emitter, Manager, Runtime,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandDef {
  id: String,
  label: String,
  menu: String,
  key: String,
  #[serde(default)]
  check: bool,
  #[serde(default)]
  separator_before: bool,
  #[serde(default)]
  after_clipboard: bool,
}

fn commands() -> Vec<CommandDef> {
  serde_json::from_str(include_str!("../../src/shared/commands.json")).expect("valid commands.json")
}

fn reserved() -> HashMap<String, String> {
  serde_json::from_str(include_str!("../../src/shared/reserved.json")).expect("valid reserved.json")
}

// Canonical shortcut ("Cmd+Shift+L") → Tauri accelerator ("CmdOrCtrl+Shift+L"). None if malformed.
pub fn to_accelerator(shortcut: &str) -> Option<String> {
  let mut parts: Vec<&str> = shortcut.split('+').collect();
  let key = parts.pop()?;
  let mut out = Vec::new();
  for m in parts {
    out.push(match m {
      "Cmd" => "CmdOrCtrl",
      "Ctrl" => "Ctrl",
      "Alt" => "Alt",
      "Shift" => "Shift",
      _ => return None,
    });
  }
  let named = match key {
    "/" => "Slash", "," => "Comma", "." => "Period", ";" => "Semicolon", "'" => "Quote",
    "[" => "BracketLeft", "]" => "BracketRight", "\\" => "Backslash", "-" => "Minus", "=" => "Equal",
    "`" => "Backquote", "Up" => "ArrowUp", "Down" => "ArrowDown", "Left" => "ArrowLeft", "Right" => "ArrowRight",
    "Enter" | "Tab" | "Space" | "Backspace" | "Delete" | "Home" | "End" | "PageUp" | "PageDown" => key,
    k if k.len() == 1 && k.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) => k,
    k if is_fkey(k) => k,
    _ => return None,
  };
  out.push(named);
  Some(out.join("+"))
}

// "Shift+Cmd+K" → "Cmd+Shift+K": modifiers in the canonical order, so equal shortcuts compare equal.
pub fn canonical(shortcut: &str) -> String {
  if shortcut.is_empty() { return String::new() }
  let mut parts: Vec<&str> = shortcut.split('+').collect();
  let key = parts.pop().unwrap_or("");
  let mut out: Vec<&str> = ["Cmd", "Ctrl", "Alt", "Shift"].into_iter().filter(|m| parts.contains(m)).collect();
  out.extend(parts.iter().filter(|p| !["Cmd", "Ctrl", "Alt", "Shift"].contains(p))); // unknown: left for to_accelerator to reject
  out.push(key);
  out.join("+")
}

// F1–F24, the range macOS menus accept (the frontend recorder uses the same range).
fn is_fkey(k: &str) -> bool {
  k.len() > 1 && k.starts_with('F') && !k[1..].starts_with('0') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))
}

fn usable(shortcut: &str) -> bool {
  let parts: Vec<&str> = shortcut.split('+').collect();
  is_fkey(parts.last().copied().unwrap_or("")) || parts.contains(&"Cmd") || parts.contains(&"Ctrl")
}

// Keep only known commands with well-formed, usable, unreserved shortcuts ("" = no shortcut).
// Returns the clean overrides and a note for each entry that was dropped.
pub fn sanitize(raw: &serde_json::Value) -> (HashMap<String, String>, Vec<String>) {
  let defs = commands();
  let reserved = reserved();
  let mut out = HashMap::new();
  let mut notes = Vec::new();
  let Some(map) = raw.as_object() else {
    return (out, vec!["keybindings.json must be a JSON object".into()]);
  };
  for (id, value) in map {
    let Some(v) = value.as_str() else {
      notes.push(format!("{id}: the shortcut must be a string"));
      continue;
    };
    let v = &canonical(v);
    if !defs.iter().any(|d| &d.id == id) {
      notes.push(format!("{id}: unknown command"));
    } else if !v.is_empty() && to_accelerator(v).is_none() {
      notes.push(format!("{id}: \"{v}\" is not a shortcut"));
    } else if !v.is_empty() && !usable(v) {
      notes.push(format!("{id}: \"{v}\" needs Cmd or Ctrl"));
    } else if let Some(owner) = reserved.get(v) {
      notes.push(format!("{id}: \"{v}\" is reserved for {owner}"));
    } else {
      out.insert(id.clone(), v.to_string());
    }
  }
  // Two commands can't share a key: a later command's duplicate override is dropped.
  let mut seen = std::collections::HashSet::new();
  for def in &defs {
    let mut key = out.get(&def.id).cloned().unwrap_or_else(|| def.key.clone());
    if !key.is_empty() && seen.contains(&key) {
      if out.remove(&def.id).is_some() {
        notes.push(format!("{}: \"{key}\" is already used by another command", def.id));
      }
      key = def.key.clone();
      if !key.is_empty() && seen.contains(&key) {
        out.insert(def.id.clone(), String::new());
        key = String::new();
      }
    }
    if !key.is_empty() { seen.insert(key); }
  }
  (out, notes)
}

#[derive(Default)]
pub struct Keybindings {
  overrides: Mutex<HashMap<String, String>>,
  modified: Mutex<Option<SystemTime>>,
  // Problems with keybindings.json (bad JSON or dropped entries), shown in Preferences.
  problems: Mutex<Vec<String>>,
  // View checkmarks from the focused document window, kept across menu rebuilds.
  pub checks: Mutex<HashMap<String, bool>>,
}

#[derive(serde::Serialize, Clone)]
pub struct KeybindingState {
  overrides: HashMap<String, String>,
  problems: Vec<String>,
}

fn file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("keybindings.json"))
}

const KEYBINDINGS_LIMIT: u64 = 1024 * 1024;

fn backup_path(path: &Path) -> PathBuf {
  path.with_extension("json.bak")
}

// A symlink, or anything that isn't a regular file, is refused. Following it could replace a document.
fn ensure_plain_file(path: &Path, label: &str) -> Result<(), String> {
  match fs::symlink_metadata(path) {
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("{label} can't be used: {e}")),
    Ok(meta) if meta.file_type().is_symlink() => Err(format!("{label} is a symbolic link and will not be followed")),
    Ok(meta) if !meta.file_type().is_file() => Err(format!("{label} is not a regular file")),
    Ok(_) => Ok(()),
  }
}

fn guard_keybindings(path: &Path) -> Result<(), String> {
  ensure_plain_file(path, "keybindings.json")?;
  ensure_plain_file(&backup_path(path), "keybindings.json.bak")
}

// Ok(None): no file yet. Err: unreadable, too large, or not valid JSON (the caller keeps its last good settings).
fn read_file(path: &Path) -> Result<Option<(HashMap<String, String>, Vec<String>)>, String> {
  ensure_plain_file(path, "keybindings.json")?;
  let meta = match fs::symlink_metadata(path) {
    Ok(meta) => meta,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("keybindings.json can't be read: {e}")),
  };
  if meta.len() > KEYBINDINGS_LIMIT {
    return Err("keybindings.json is too large (the limit is 1 MB)".into());
  }
  // The plain-file check above can lose a race with a swapped symlink; open_for_read can't.
  let file = crate::platform::open_for_read(path).map_err(|e| format!("keybindings.json can't be read: {e}"))?;
  let mut buf = Vec::new();
  file.take(KEYBINDINGS_LIMIT + 1).read_to_end(&mut buf).map_err(|e| format!("keybindings.json can't be read: {e}"))?;
  if buf.len() as u64 > KEYBINDINGS_LIMIT {
    return Err("keybindings.json is too large (the limit is 1 MB)".into());
  }
  let text = String::from_utf8(buf).map_err(|_| "keybindings.json can't be read: invalid UTF-8".to_string())?;
  let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("keybindings.json isn't valid JSON: {e}"))?;
  Ok(Some(sanitize(&value)))
}

fn state_of<R: Runtime>(app: &AppHandle<R>) -> KeybindingState {
  let k = app.state::<Keybindings>();
  let overrides = k.overrides.lock().unwrap().clone();
  let problems = k.problems.lock().unwrap().clone();
  KeybindingState { overrides, problems }
}

fn mtime(path: &Path) -> Option<SystemTime> {
  // symlink_metadata: a keybindings path that is a link must not stat the file it points at.
  fs::symlink_metadata(path).and_then(|m| m.modified()).ok()
}

// Take in what's on disk: good settings replace the current ones; a broken file leaves the current
// (last good) settings in place and is reported. Then rebuild the menu and tell every window.
fn take_file<R: Runtime>(app: &AppHandle<R>, path: &PathBuf) {
  let k = app.state::<Keybindings>();
  *k.modified.lock().unwrap() = mtime(path);
  match read_file(path) {
    Ok(found) => {
      let (overrides, problems) = found.unwrap_or_default();
      *k.overrides.lock().unwrap() = overrides;
      *k.problems.lock().unwrap() = problems;
    }
    Err(problem) => *k.problems.lock().unwrap() = vec![problem],
  }
}

fn publish<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
  let state = state_of(app);
  app.set_menu(build(app, &state.overrides, false).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  app.emit("keybindings-changed", state).map_err(|e| e.to_string())
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
  if let Ok(path) = file_path(app) { take_file(app, &path); }
  let overrides = app.state::<Keybindings>().overrides.lock().unwrap().clone();
  app.set_menu(build(app, &overrides, false)?)?;
  Ok(())
}

// While Preferences records a shortcut, menu accelerators would swallow the key press.
#[tauri::command]
pub fn suspend_shortcuts<R: Runtime>(app: AppHandle<R>, suspended: bool) -> Result<(), String> {
  let overrides = app.state::<Keybindings>().overrides.lock().unwrap().clone();
  app.set_menu(build(&app, &overrides, suspended).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  Ok(())
}

// A hand edit of keybindings.json takes effect when any window regains focus.
pub fn reload_if_changed<R: Runtime>(app: &AppHandle<R>) {
  let Ok(path) = file_path(app) else { return };
  if *app.state::<Keybindings>().modified.lock().unwrap() == mtime(&path) { return }
  take_file(app, &path);
  let _ = publish(app);
}

#[tauri::command]
pub fn get_keybindings<R: Runtime>(app: AppHandle<R>) -> KeybindingState {
  state_of(&app)
}

fn backup_keybindings(src: &Path, dest: &Path) -> Result<(), String> {
  let file = crate::platform::open_for_read(src).map_err(|e| format!("couldn't back up keybindings.json: {e}"))?;
  let mut buf = Vec::new();
  // Never copy more than the limit, even if the file grew after the size check.
  file.take(KEYBINDINGS_LIMIT + 1).read_to_end(&mut buf).map_err(|e| format!("couldn't back up keybindings.json: {e}"))?;
  if buf.len() as u64 > KEYBINDINGS_LIMIT {
    return Err("keybindings.json is too large (the limit is 1 MB). Move the file aside before saving shortcuts".into());
  }
  crate::documents::write_regular_file(dest, &buf).map_err(|e| format!("couldn't back up keybindings.json: {e}"))
}

// A hand-edited file that doesn't parse is kept beside the new one, unless copying it would
// follow a symlink or exceed the size limit.
fn save_keybindings_file(path: &Path, clean: &HashMap<String, String>) -> Result<(), String> {
  if let Some(dir) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  guard_keybindings(path)?;
  if let Err(err) = read_file(path) {
    if err.contains("too large") {
      return Err(format!("{err}. Move the file aside before saving shortcuts"));
    }
    backup_keybindings(path, &backup_path(path))?;
  }
  let sorted: std::collections::BTreeMap<_, _> = clean.iter().collect(); // stable order for diffs
  let text = serde_json::to_string_pretty(&sorted).map_err(|e| e.to_string())? + "\n";
  crate::documents::write_regular_file(path, text.as_bytes())
}

fn ensure_keybindings_present(path: &Path) -> Result<bool, String> {
  guard_keybindings(path)?;
  if matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
    if let Some(dir) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
      fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::documents::write_regular_file(path, b"{\n}\n")?;
    return Ok(true);
  }
  Ok(false)
}

#[tauri::command]
pub fn set_keybindings<R: Runtime>(app: AppHandle<R>, overrides: serde_json::Value) -> Result<(), String> {
  let (clean, _) = sanitize(&overrides);
  let path = file_path(&app)?;
  save_keybindings_file(&path, &clean)?;
  let k = app.state::<Keybindings>();
  *k.modified.lock().unwrap() = mtime(&path);
  *k.overrides.lock().unwrap() = clean;
  k.problems.lock().unwrap().clear();
  drop(k);
  publish(&app)
}

#[tauri::command]
pub fn open_keybindings_file<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
  use tauri_plugin_opener::OpenerExt;
  let path = file_path(&app)?;
  if ensure_keybindings_present(&path)? {
    *app.state::<Keybindings>().modified.lock().unwrap() = mtime(&path);
  }
  app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

pub fn open_preferences<R: Runtime>(app: &AppHandle<R>) {
  if let Some(window) = app.get_webview_window("preferences") {
    let _ = window.set_focus();
    return;
  }
  let _ = WebviewWindowBuilder::new(app, "preferences", tauri::WebviewUrl::App("preferences.html".into()))
    .title("Preferences")
    .inner_size(640.0, 620.0)
    .min_inner_size(520.0, 420.0)
    .build();
}

// `suspended`: no custom shortcuts, so the Preferences recorder receives every key press.
fn build<R: Runtime>(app: &AppHandle<R>, overrides: &HashMap<String, String>, suspended: bool) -> tauri::Result<Menu<R>> {
  let defs = commands();
  let accel = |def: &CommandDef| -> Option<String> {
    if suspended { return None }
    let key = overrides.get(&def.id).cloned().unwrap_or_else(|| def.key.clone());
    to_accelerator(&key)
  };
  let item = |def: &CommandDef| -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    let key = accel(def);
    Ok(if def.check {
      let on = app.state::<Keybindings>().checks.lock().unwrap().get(&def.id).copied().unwrap_or(false);
      let b = CheckMenuItemBuilder::with_id(&def.id, &def.label).checked(on);
      Box::new(match key { Some(k) => b.accelerator(k).build(app)?, None => b.build(app)? })
    } else {
      let b = MenuItemBuilder::with_id(&def.id, &def.label);
      Box::new(match key { Some(k) => b.accelerator(k).build(app)?, None => b.build(app)? })
    })
  };
  let submenu = |name: &str| -> tauri::Result<Submenu<R>> {
    let mut sub = SubmenuBuilder::new(app, name);
    let mut first = true;
    for def in defs.iter().filter(|d| d.menu == name) {
      if name == "Edit" && def.after_clipboard {
        sub = sub.separator().cut().copy().paste().select_all();
      }
      if def.separator_before && !first { sub = sub.separator(); }
      first = false;
      sub = sub.item(&*item(def)?);
    }
    sub.build()
  };

  let app_menu = SubmenuBuilder::new(app, "OpenViewer")
    .about(Some(tauri::menu::AboutMetadata { name: Some("OpenViewer".into()), ..Default::default() }))
    .separator()
    .item(&MenuItemBuilder::with_id("preferences", "Preferences…").accelerator("CmdOrCtrl+Comma").build(app)?)
    .separator()
    .hide().hide_others().show_all().separator()
    .item(&MenuItemBuilder::with_id("quit", "Quit OpenViewer").accelerator("CmdOrCtrl+Q").build(app)?)
    .build()?;
  let window = SubmenuBuilder::new(app, "Window")
    .item(&PredefinedMenuItem::minimize(app, None)?)
    .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
    .build()?;
  let menus = [
    app_menu,
    submenu("File")?,
    submenu("Edit")?,
    submenu("Format")?,
    submenu("Paragraph")?,
    submenu("View")?,
    window,
  ];
  let refs: Vec<&dyn IsMenuItem<R>> = menus.iter().map(|m| m as &dyn IsMenuItem<R>).collect();
  Menu::with_items(app, &refs)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accelerators() {
    assert_eq!(to_accelerator("Cmd+Shift+L").as_deref(), Some("CmdOrCtrl+Shift+L"));
    assert_eq!(to_accelerator("Cmd+/").as_deref(), Some("CmdOrCtrl+Slash"));
    assert_eq!(to_accelerator("F8").as_deref(), Some("F8"));
    assert_eq!(to_accelerator("Cmd+Alt+T").as_deref(), Some("CmdOrCtrl+Alt+T"));
    assert_eq!(to_accelerator("Hyper+K"), None);
    assert_eq!(to_accelerator("Cmd+ö"), None);
  }

  #[test]
  fn sanitize_drops_bad_entries() {
    let raw = serde_json::json!({
      "bold": "Cmd+Shift+B", "italic": "", "save": "Cmd+Q", "nope": "Cmd+K", "code": "Alt+E", "outline": 5
    });
    let (clean, notes) = sanitize(&raw);
    assert_eq!(notes.len(), 4);
    assert_eq!(clean.get("bold").map(String::as_str), Some("Cmd+Shift+B"));
    assert_eq!(clean.get("italic").map(String::as_str), Some(""));
    assert!(!clean.contains_key("save")); // reserved
    assert!(!clean.contains_key("nope")); // unknown command
    assert!(!clean.contains_key("code")); // Option alone types characters
    assert!(!clean.contains_key("outline")); // not a string
  }

  #[test]
  fn duplicate_overrides_are_dropped() {
    let (clean, notes) = sanitize(&serde_json::json!({ "bold": "Cmd+K", "italic": "Cmd+K", "code": "Cmd+S" }));
    assert_eq!(clean.get("bold").map(String::as_str), Some("Cmd+K"));
    assert!(!clean.contains_key("italic")); // falls back to its default, Cmd+I
    assert!(!clean.contains_key("code")); // Cmd+S belongs to Save, which comes first
    assert_eq!(notes.len(), 2);
  }

  #[test]
  fn modifier_order_is_normalized() {
    let (clean, notes) = sanitize(&serde_json::json!({ "bold": "Shift+Cmd+K", "italic": "Cmd+Shift+K" }));
    assert_eq!(clean.get("bold").map(String::as_str), Some("Cmd+Shift+K"));
    assert!(!clean.contains_key("italic"));
    assert_eq!(notes.len(), 1);
  }

  #[test]
  fn function_key_range() {
    assert!(to_accelerator("F24").is_some());
    assert!(to_accelerator("F25").is_none());
    assert!(to_accelerator("F0").is_none());
    assert!(to_accelerator("F01").is_none());
  }

  #[test]
  fn registry_defaults_are_valid() {
    for def in commands() {
      assert!(def.key.is_empty() || to_accelerator(&def.key).is_some(), "{} has bad default {}", def.id, def.key);
    }
  }

  fn temp_bindings(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
      "openviewer-keys-{label}-{}-{}",
      std::process::id(),
      SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ))
  }

  #[test]
  fn oversized_keybindings_are_refused() {
    let path = temp_bindings("big");
    fs::File::create(&path).unwrap().set_len(KEYBINDINGS_LIMIT + 1).unwrap();
    let err = read_file(&path).unwrap_err();
    assert!(err.starts_with("keybindings.json is too large"), "{err}");
    let _ = fs::remove_file(path);
  }

  #[test]
  fn small_keybindings_still_parse() {
    let path = temp_bindings("small");
    fs::write(&path, b"{}\n").unwrap();
    let (clean, notes) = read_file(&path).unwrap().unwrap();
    assert!(clean.is_empty());
    assert!(notes.is_empty());
    let _ = fs::remove_file(path);
  }

  fn bindings_dir(label: &str) -> PathBuf {
    let dir = temp_bindings(label);
    fs::create_dir(&dir).unwrap();
    dir
  }

  #[cfg(unix)]
  #[test]
  fn keybindings_symlink_is_not_followed() {
    let dir = bindings_dir("link");
    let path = dir.join("keybindings.json");
    let secret = dir.join("secret.md");
    fs::write(&secret, b"secret document").unwrap();
    std::os::unix::fs::symlink(&secret, &path).unwrap();
    let err = read_file(&path).unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    let err = save_keybindings_file(&path, &HashMap::new()).unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    let err = ensure_keybindings_present(&path).unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    assert_eq!(fs::read(&secret).unwrap(), b"secret document");
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
    let _ = fs::remove_dir_all(dir);
  }

  #[cfg(unix)]
  #[test]
  fn keybindings_backup_symlink_is_not_followed() {
    let dir = bindings_dir("baklink");
    let path = dir.join("keybindings.json");
    let secret = dir.join("secret.md");
    fs::write(&path, b"{not json").unwrap();
    fs::write(&secret, b"secret document").unwrap();
    std::os::unix::fs::symlink(&secret, backup_path(&path)).unwrap();
    let err = save_keybindings_file(&path, &HashMap::new()).unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    let err = ensure_keybindings_present(&path).unwrap_err();
    assert!(err.contains("symbolic link"), "{err}");
    assert_eq!(fs::read(&secret).unwrap(), b"secret document");
    assert_eq!(fs::read(&path).unwrap(), b"{not json");
    assert!(fs::symlink_metadata(&backup_path(&path)).unwrap().file_type().is_symlink());
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn keybindings_directory_is_refused() {
    let dir = bindings_dir("notfile");
    let path = dir.join("keybindings.json");
    fs::create_dir(&path).unwrap();
    let err = read_file(&path).unwrap_err();
    assert!(err.contains("not a regular file"), "{err}");
    let err = save_keybindings_file(&path, &HashMap::new()).unwrap_err();
    assert!(err.contains("not a regular file"), "{err}");
    let err = ensure_keybindings_present(&path).unwrap_err();
    assert!(err.contains("not a regular file"), "{err}");
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn oversized_broken_keybindings_are_not_backed_up() {
    let dir = bindings_dir("huge");
    let path = dir.join("keybindings.json");
    fs::write(&path, b"{not json").unwrap();
    fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(KEYBINDINGS_LIMIT + 1).unwrap();
    let err = save_keybindings_file(&path, &HashMap::new()).unwrap_err();
    assert!(err.contains("too large"), "{err}");
    assert!(err.contains("Move the file aside"), "{err}");
    assert!(!backup_path(&path).exists());
    assert!(fs::read(&path).unwrap().starts_with(b"{not json"));
    assert!(fs::metadata(&path).unwrap().len() > KEYBINDINGS_LIMIT);
    let bak = dir.join("aside.json");
    let err = backup_keybindings(&path, &bak).unwrap_err();
    assert!(err.contains("too large"), "{err}");
    assert!(err.contains("Move the file aside"), "{err}");
    assert!(!bak.exists());
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn broken_keybindings_are_backed_up_within_the_limit() {
    let dir = bindings_dir("broken");
    let path = dir.join("keybindings.json");
    fs::write(&path, b"{not json").unwrap();
    save_keybindings_file(&path, &HashMap::new()).unwrap();
    let bak = backup_path(&path);
    assert_eq!(fs::read(&bak).unwrap(), b"{not json");
    assert!(fs::metadata(&bak).unwrap().len() <= KEYBINDINGS_LIMIT);
    assert!(serde_json::from_str::<serde_json::Value>(&fs::read_to_string(&path).unwrap()).is_ok());
    assert!(!fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
    let _ = fs::remove_dir_all(dir);
  }
}
