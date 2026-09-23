// The native menu, built from the shared command list (src/shared/commands.json) plus the user's
// shortcut overrides in `keybindings.json` in the app's config folder. The frontend's Preferences
// window edits the overrides; editing the file by hand works too and is picked up when a window
// regains focus.

use std::{collections::HashMap, fs, io::Read, path::PathBuf, sync::Mutex, time::SystemTime};
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

// Ok(None): no file yet. Err: unreadable, too large, or not valid JSON (the caller keeps its last good settings).
fn read_file(path: &PathBuf) -> Result<Option<(HashMap<String, String>, Vec<String>)>, String> {
  let meta = match fs::metadata(path) {
    Ok(meta) => meta,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("keybindings.json can't be read: {e}")),
  };
  if meta.len() > KEYBINDINGS_LIMIT {
    return Err("keybindings.json is too large (the limit is 1 MB)".into());
  }
  let file = fs::File::open(path).map_err(|e| format!("keybindings.json can't be read: {e}"))?;
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

fn mtime(path: &PathBuf) -> Option<SystemTime> {
  fs::metadata(path).and_then(|m| m.modified()).ok()
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

#[tauri::command]
pub fn set_keybindings<R: Runtime>(app: AppHandle<R>, overrides: serde_json::Value) -> Result<(), String> {
  let (clean, _) = sanitize(&overrides);
  let path = file_path(&app)?;
  if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
  // A hand-edited file that doesn't parse is kept next to the new one rather than lost.
  if matches!(read_file(&path), Err(_)) {
    fs::copy(&path, path.with_extension("json.bak")).map_err(|e| format!("couldn't back up keybindings.json: {e}"))?;
  }
  let sorted: std::collections::BTreeMap<_, _> = clean.iter().collect(); // stable order for diffs
  let text = serde_json::to_string_pretty(&sorted).map_err(|e| e.to_string())? + "\n";
  crate::write_document_trusted(&path, text, false)?;
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
  if !path.exists() {
    if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    crate::write_document_trusted(&path, "{\n}\n".into(), false)?;
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
}
