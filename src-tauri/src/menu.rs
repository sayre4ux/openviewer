// The native menu, built from the shared command list (src/shared/commands.json) plus the user's
// shortcut overrides in `keybindings.json` in the app's config folder. The frontend's Preferences
// window edits the overrides; editing the file by hand works too and is picked up when a window
// regains focus.

use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex, time::SystemTime};
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

const RESERVED: &[&str] = &[
  "Cmd+Q", "Cmd+H", "Cmd+Alt+H", "Cmd+M", "Cmd+C", "Cmd+V", "Cmd+X", "Cmd+A", "Cmd+,", "Cmd+Tab", "Cmd+Space", "Cmd+`",
];

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
    k if k.starts_with('F') && k[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => k,
    _ => return None,
  };
  out.push(named);
  Some(out.join("+"))
}

fn usable(shortcut: &str) -> bool {
  let parts: Vec<&str> = shortcut.split('+').collect();
  let key = parts.last().copied().unwrap_or("");
  let fkey = key.starts_with('F') && key.len() > 1 && key[1..].chars().all(|c| c.is_ascii_digit());
  fkey || parts.contains(&"Cmd") || parts.contains(&"Ctrl")
}

// Keep only known commands with well-formed, usable, unreserved shortcuts ("" = no shortcut).
pub fn sanitize(raw: &serde_json::Value) -> HashMap<String, String> {
  let ids: Vec<String> = commands().into_iter().map(|c| c.id).collect();
  let mut out = HashMap::new();
  if let Some(map) = raw.as_object() {
    for (id, value) in map {
      let Some(v) = value.as_str() else { continue };
      if !ids.contains(id) { continue }
      if v.is_empty() || (to_accelerator(v).is_some() && usable(v) && !RESERVED.contains(&v)) {
        out.insert(id.clone(), v.to_string());
      }
    }
  }
  out
}

#[derive(Default)]
pub struct Keybindings {
  overrides: Mutex<HashMap<String, String>>,
  modified: Mutex<Option<SystemTime>>,
}

fn file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("keybindings.json"))
}

fn read_file(path: &PathBuf) -> HashMap<String, String> {
  fs::read_to_string(path)
    .ok()
    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    .map(|v| sanitize(&v))
    .unwrap_or_default()
}

fn mtime(path: &PathBuf) -> Option<SystemTime> {
  fs::metadata(path).and_then(|m| m.modified()).ok()
}

// Rebuild the menu with the current shortcuts and tell every window, so their editor keymaps match.
fn apply<R: Runtime>(app: &AppHandle<R>, overrides: HashMap<String, String>) -> Result<(), String> {
  *app.state::<Keybindings>().overrides.lock().unwrap() = overrides.clone();
  app.set_menu(build(app, &overrides, false).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  app.emit("keybindings-changed", overrides).map_err(|e| e.to_string())
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
  let path = file_path(app).ok();
  let overrides = path.as_ref().map(read_file).unwrap_or_default();
  *app.state::<Keybindings>().modified.lock().unwrap() = path.as_ref().and_then(mtime);
  *app.state::<Keybindings>().overrides.lock().unwrap() = overrides.clone();
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
  let now = mtime(&path);
  let state = app.state::<Keybindings>();
  let mut seen = state.modified.lock().unwrap();
  if *seen == now { return }
  *seen = now;
  drop(seen);
  let _ = apply(app, read_file(&path));
}

#[tauri::command]
pub fn get_keybindings<R: Runtime>(app: AppHandle<R>) -> HashMap<String, String> {
  app.state::<Keybindings>().overrides.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_keybindings<R: Runtime>(app: AppHandle<R>, overrides: serde_json::Value) -> Result<(), String> {
  let clean = sanitize(&overrides);
  let path = file_path(&app)?;
  if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
  let sorted: std::collections::BTreeMap<_, _> = clean.iter().collect(); // stable order for diffs
  let text = serde_json::to_string_pretty(&sorted).map_err(|e| e.to_string())? + "\n";
  crate::write_document(path.to_string_lossy().into_owned(), text, false)?;
  *app.state::<Keybindings>().modified.lock().unwrap() = mtime(&path);
  apply(&app, clean)
}

#[tauri::command]
pub fn open_keybindings_file<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
  use tauri_plugin_opener::OpenerExt;
  let path = file_path(&app)?;
  if !path.exists() {
    if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    crate::write_document(path.to_string_lossy().into_owned(), "{\n}\n".into(), false)?;
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
      let b = CheckMenuItemBuilder::with_id(&def.id, &def.label).checked(false);
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
    let clean = sanitize(&raw);
    assert_eq!(clean.get("bold").map(String::as_str), Some("Cmd+Shift+B"));
    assert_eq!(clean.get("italic").map(String::as_str), Some(""));
    assert!(!clean.contains_key("save")); // reserved
    assert!(!clean.contains_key("nope")); // unknown command
    assert!(!clean.contains_key("code")); // Option alone types characters
    assert!(!clean.contains_key("outline")); // not a string
  }

  #[test]
  fn registry_defaults_are_valid() {
    for def in commands() {
      assert!(def.key.is_empty() || to_accelerator(&def.key).is_some(), "{} has bad default {}", def.id, def.key);
    }
  }
}
