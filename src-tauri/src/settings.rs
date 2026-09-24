// App settings other than shortcuts, in `settings.json` next to `keybindings.json`. Unknown or invalid
// values fall back to the defaults, so a hand edit can't break the app.

use std::{fs, io::Read, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{documents::write_regular_file, platform};

const SETTINGS_LIMIT: u64 = 64 * 1024;

// Where pasted and dropped images are copied, relative to the document:
// "assets" (a shared folder), "{name}.assets" (one folder per document), or "." (next to it).
pub const IMAGE_FOLDERS: &[&str] = &["assets", "{name}.assets", "."];

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
  #[serde(default = "default_image_folder")]
  pub image_folder: String,
}

fn default_image_folder() -> String {
  "assets".into()
}

impl Default for Settings {
  fn default() -> Self {
    Settings { image_folder: default_image_folder() }
  }
}

impl Settings {
  fn sanitized(mut self) -> Self {
    if !IMAGE_FOLDERS.contains(&self.image_folder.as_str()) { self.image_folder = default_image_folder(); }
    self
  }
}

#[derive(Default)]
pub struct SettingsState(pub Mutex<Settings>);

fn file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

fn read(path: &PathBuf) -> Settings {
  let Ok(file) = platform::open_for_read(path) else { return Settings::default() };
  let mut buf = Vec::new();
  if file.take(SETTINGS_LIMIT + 1).read_to_end(&mut buf).is_err() || buf.len() as u64 > SETTINGS_LIMIT {
    return Settings::default();
  }
  serde_json::from_slice::<Settings>(&buf).map(Settings::sanitized).unwrap_or_default()
}

pub fn load<R: Runtime>(app: &AppHandle<R>) {
  if let Ok(path) = file_path(app) {
    *app.state::<SettingsState>().0.lock().unwrap() = read(&path);
  }
}

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> Settings {
  state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings<R: Runtime>(app: AppHandle<R>, settings: Settings) -> Result<Settings, String> {
  let clean = settings.sanitized();
  let path = file_path(&app)?;
  if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
  let text = serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())? + "\n";
  write_regular_file(&path, text.as_bytes())?;
  *app.state::<SettingsState>().0.lock().unwrap() = clean.clone();
  let _ = app.emit("settings-changed", clean.clone());
  Ok(clean)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn invalid_values_fall_back() {
    let s: Settings = serde_json::from_str(r#"{"imageFolder":"../../etc"}"#).unwrap();
    assert_eq!(s.sanitized().image_folder, "assets");
    let s: Settings = serde_json::from_str(r#"{"imageFolder":"{name}.assets","extra":1}"#).unwrap();
    assert_eq!(s.sanitized().image_folder, "{name}.assets");
    let s: Settings = serde_json::from_str("{}").unwrap();
    assert_eq!(s.image_folder, "assets");
  }
}
