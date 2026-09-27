// App settings other than shortcuts, in `settings.json` next to `keybindings.json`. Unknown or invalid
// values fall back to the defaults, so a hand edit can't break the app.

use std::{fs, io::Read, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{documents::write_regular_file, i18n, platform};

const SETTINGS_LIMIT: u64 = 64 * 1024;

// Where pasted and dropped images are copied, relative to the document:
// "assets" (a shared folder), "{name}.assets" (one folder per document), or "." (next to it).
pub const IMAGE_FOLDERS: &[&str] = &["assets", "{name}.assets", "."];
const LANGUAGES: &[&str] = &["system", "en", "zh-Hant", "zh-Hans", "ja"];

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
  #[serde(default = "default_image_folder")]
  pub image_folder: String,
  // Images from the internet. Off unless the user turns it on in Settings: loading one tells its
  // server who opened the document, from where, and when.
  #[serde(default)]
  pub remote_images: bool,
  // Mermaid diagrams. On unless the user turns them off: rendering leaks nothing (it runs in a
  // sandboxed frame with no network, and the result is an image), so the switch exists for the day a
  // Mermaid flaw has no fix. Changing the default is this one line.
  #[serde(default = "yes")]
  pub diagrams: bool,
  #[serde(default = "default_language")]
  pub language: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
  #[serde(flatten)]
  pub settings: Settings,
  pub resolved_language: String,
}

fn default_image_folder() -> String {
  "assets".into()
}

fn yes() -> bool {
  true
}

fn default_language() -> String {
  "system".into()
}

impl Default for Settings {
  fn default() -> Self {
    Settings { image_folder: default_image_folder(), remote_images: false, diagrams: yes(), language: default_language() }
  }
}

impl Settings {
  fn sanitized(mut self) -> Self {
    if !IMAGE_FOLDERS.contains(&self.image_folder.as_str()) { self.image_folder = default_image_folder(); }
    if !LANGUAGES.contains(&self.language.as_str()) { self.language = default_language(); }
    self
  }
}

fn locale_language(locale: &str) -> Option<&'static str> {
  let locale = locale.replace('_', "-").to_ascii_lowercase();
  let parts: Vec<&str> = locale.split('-').collect();
  if parts.first() != Some(&"zh") {
    return match parts.first().copied() {
      Some("en") => Some("en"),
      Some("ja") => Some("ja"),
      _ => None,
    };
  }
  let script = parts.iter().skip(1).find(|part| part.len() == 4).copied();
  let region = parts.iter().skip(1).find(|part| part.len() == 2 || part.len() == 3).copied();
  match (script, region) {
    (Some("hant"), _) | (_, Some("hk" | "tw" | "mo")) => Some("zh-Hant"),
    (Some("hans"), _) | (_, Some("cn" | "sg")) | (_, None) => Some("zh-Hans"),
    _ => None,
  }
}

#[cfg(target_os = "macos")]
fn preferred_languages() -> Vec<String> {
  use objc2_foundation::NSLocale;

  let values = NSLocale::preferredLanguages();
  (0..values.count()).map(|index| values.objectAtIndex(index).to_string()).collect()
}

#[cfg(not(target_os = "macos"))]
fn preferred_languages() -> Vec<String> {
  ["LC_ALL", "LC_MESSAGES", "LANG"].into_iter().filter_map(|key| std::env::var(key).ok())
    .map(|locale| locale.split('.').next().unwrap_or(&locale).to_string()).collect()
}

pub fn resolve_language(setting: &str) -> String {
  if LANGUAGES.contains(&setting) && setting != "system" { return setting.to_string(); }
  preferred_languages().iter().find_map(|locale| locale_language(locale)).unwrap_or("en").to_string()
}

fn payload(settings: Settings) -> SettingsPayload {
  SettingsPayload { resolved_language: resolve_language(&settings.language), settings }
}

#[derive(Default)]
pub struct SettingsState(pub Mutex<Settings>);

fn file_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("settings.json"))
}

fn read(path: &Path) -> Settings {
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
  let resolved = resolve_language(&app.state::<SettingsState>().0.lock().unwrap().language);
  i18n::set_language(&resolved);
}

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> SettingsPayload {
  payload(state.0.lock().unwrap().clone())
}

#[tauri::command]
pub fn set_settings<R: Runtime>(app: AppHandle<R>, settings: Settings) -> Result<SettingsPayload, String> {
  let clean = settings.sanitized();
  let path = file_path(&app)?;
  if let Some(dir) = path.parent() { fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
  let text = serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())? + "\n";
  write_regular_file(&path, text.as_bytes())?;
  let language_changed = {
    let state = app.state::<SettingsState>();
    let mut current = state.0.lock().unwrap();
    let changed = current.language != clean.language;
    *current = clean.clone();
    changed
  };
  let resolved = resolve_language(&clean.language);
  i18n::set_language(&resolved);
  if language_changed { crate::menu::refresh_localized(&app); }
  else { let _ = crate::menu::rebuild(&app); }
  let result = payload(clean);
  let _ = app.emit("settings-changed", result.clone());
  Ok(result)
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
    assert_eq!(s.language, "system");
  }

  #[test]
  fn remote_images_default_off() {
    assert!(!Settings::default().remote_images);
    let s: Settings = serde_json::from_str(r#"{"imageFolder":"."}"#).unwrap();
    assert!(!s.remote_images);
    let s: Settings = serde_json::from_str(r#"{"remoteImages":true}"#).unwrap();
    assert!(s.sanitized().remote_images);
    assert!(serde_json::from_str::<Settings>(r#"{"remoteImages":"yes"}"#).is_err());
  }

  #[test]
  fn diagrams_default_on() {
    assert!(Settings::default().diagrams);
    let s: Settings = serde_json::from_str(r#"{"imageFolder":"."}"#).unwrap();
    assert!(s.diagrams);
    let s: Settings = serde_json::from_str(r#"{"diagrams":false}"#).unwrap();
    assert!(!s.sanitized().diagrams);
    assert!(serde_json::from_str::<Settings>(r#"{"diagrams":"no"}"#).is_err());
    let text = serde_json::to_string(&Settings::default()).unwrap();
    assert!(text.contains(r#""diagrams":true"#), "{text}");
  }

  #[test]
  fn language_setting_is_validated_and_resolved() {
    let s: Settings = serde_json::from_str(r#"{"language":"fr"}"#).unwrap();
    assert_eq!(s.sanitized().language, "system");
    assert_eq!(locale_language("zh-HK"), Some("zh-Hant"));
    assert_eq!(locale_language("zh-TW"), Some("zh-Hant"));
    assert_eq!(locale_language("zh-MO"), Some("zh-Hant"));
    assert_eq!(locale_language("zh-Hant-HK"), Some("zh-Hant"));
    assert_eq!(locale_language("zh-CN"), Some("zh-Hans"));
    assert_eq!(locale_language("zh-SG"), Some("zh-Hans"));
    assert_eq!(locale_language("zh-Hans-SG"), Some("zh-Hans"));
    assert_eq!(locale_language("zh"), Some("zh-Hans"));
    assert_eq!(locale_language("ja-JP"), Some("ja"));
    assert_eq!(locale_language("fr-FR"), None);
    assert_eq!(resolve_language("zh-Hans"), "zh-Hans");
    let payload = serde_json::to_value(payload(Settings { language: "ja".into(), ..Settings::default() })).unwrap();
    assert_eq!(payload["language"], "ja");
    assert_eq!(payload["resolvedLanguage"], "ja");
  }
}
