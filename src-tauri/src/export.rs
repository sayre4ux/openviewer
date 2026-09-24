// Export. The document window renders the Markdown to one standalone HTML page (sanitized, with local
// images embedded); Rust writes that page where the user chose, as HTML or printed to PDF. A target is
// usable once, and only if the user picked it in `export_dialog`.

use std::{
  collections::HashSet,
  fs,
  io::Read,
  path::{Path, PathBuf},
  sync::Mutex,
};
use tauri::{Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::documents::{has_extension, write_regular_file, AuthorizedDocuments};
use crate::images::{self, ImageGrants};
use crate::platform;

// An export page holds every embedded image, so it can be large, but not unbounded.
const EXPORT_LIMIT: usize = 512 * 1024 * 1024;

#[derive(Default)]
pub struct ExportTargets(Mutex<HashSet<PathBuf>>);

fn extension_for(format: &str) -> Result<&'static str, String> {
  match format {
    "pdf" => Ok("pdf"),
    "html" => Ok("html"),
    _ => Err(format!("Unknown export format {format}")),
  }
}

// The target the user picked, with the format's extension, in a folder that exists.
fn export_target(selected: &Path, ext: &str) -> Result<PathBuf, String> {
  let name = selected.file_name().ok_or("Invalid file name")?.to_string_lossy().into_owned();
  let name = if has_extension(Path::new(&name), &[ext]) || (ext == "html" && has_extension(Path::new(&name), &["htm"])) {
    name
  } else {
    format!("{name}.{ext}")
  };
  let parent = selected.parent().filter(|p| !p.as_os_str().is_empty()).ok_or("Invalid file path")?;
  Ok(fs::canonicalize(parent).map_err(|e| e.to_string())?.join(name))
}

impl ExportTargets {
  fn take(&self, path: &str, ext: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let ok = has_extension(&path, &[ext]) || (ext == "html" && has_extension(&path, &["htm"]));
    if ok && self.0.lock().unwrap().remove(&path) { Ok(path) } else { Err("Choose where to export in the Export dialog.".into()) }
  }
}

#[tauri::command]
pub async fn export_dialog<R: Runtime>(app: tauri::AppHandle<R>, format: String, default_path: String) -> Result<Option<String>, String> {
  let ext = extension_for(&format)?;
  let default = Path::new(&default_path);
  let stem = default.file_stem().and_then(|s| s.to_str()).filter(|s| !s.is_empty()).unwrap_or("Untitled");
  let label = if ext == "pdf" { "PDF" } else { "HTML" };
  let mut dialog = app.dialog().file().add_filter(label, &[ext]).set_file_name(format!("{stem}.{ext}"));
  if let Some(dir) = default.parent().filter(|p| !p.as_os_str().is_empty() && p.is_dir()) { dialog = dialog.set_directory(dir); }
  let Some(selected) = dialog.blocking_save_file() else { return Ok(None) };
  let target = export_target(&selected.into_path().map_err(|e| e.to_string())?, ext)?;
  app.state::<ExportTargets>().0.lock().unwrap().insert(target.clone());
  Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn export_html(targets: tauri::State<'_, ExportTargets>, path: String, html: String) -> Result<(), String> {
  let target = targets.take(&path, "html")?;
  if html.len() > EXPORT_LIMIT { return Err("The export is too large.".into()); }
  write_regular_file(&target, html.as_bytes())
}

#[tauri::command]
pub async fn export_pdf<R: Runtime>(app: tauri::AppHandle<R>, path: String, html: String) -> Result<(), String> {
  let target = app.state::<ExportTargets>().take(&path, "pdf")?;
  if html.len() > EXPORT_LIMIT { return Err("The export is too large.".into()); }
  write_regular_file(&target, &render_pdf(&app, html).await?)
}

// AppKit writes the PDF by path, so it goes to a fresh private folder first; the result is then
// written to the user's target the same way documents are saved (atomic, no symlink followed).
pub async fn render_pdf<R: Runtime>(app: &tauri::AppHandle<R>, html: String) -> Result<Vec<u8>, String> {
  let dir = private_temp_dir()?;
  let out = dir.join("export.pdf");
  let result = platform::print_to_pdf(app, html, out.clone()).await.and_then(|()| {
    let mut bytes = Vec::new();
    platform::open_for_read(&out)?.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.starts_with(b"%PDF") { Ok(bytes) } else { Err("The PDF couldn't be created.".into()) }
  });
  let _ = fs::remove_dir_all(&dir);
  result
}

fn private_temp_dir() -> Result<PathBuf, String> {
  let mut raw = [0u8; 8];
  getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
  let name: String = raw.iter().map(|b| format!("{b:02x}")).collect();
  let dir = std::env::temp_dir().join(format!("openviewer-export-{name}"));
  let mut builder = fs::DirBuilder::new();
  #[cfg(unix)]
  std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
  builder.create(&dir).map_err(|e| e.to_string())?; // fails if it exists, so it's ours
  Ok(dir)
}

// A local image's bytes for embedding in an export, under the same rules as showing it.
#[tauri::command]
pub fn export_image(
  document_path: String,
  source: String,
  authorized: tauri::State<AuthorizedDocuments>,
  grants: tauri::State<ImageGrants>,
) -> Result<tauri::ipc::Response, String> {
  let document = authorized.require(Path::new(&document_path), false)?;
  images::image_bytes(&grants, &document, Path::new(&source)).map(tauri::ipc::Response::new).ok_or_else(|| "blocked".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn targets_are_used_once_with_the_right_extension() {
    let dir = fs::canonicalize(std::env::temp_dir()).unwrap();
    let pdf = export_target(&dir.join("notes"), "pdf").unwrap();
    assert_eq!(pdf, dir.join("notes.pdf"));
    assert_eq!(export_target(&dir.join("page.HTM"), "html").unwrap(), dir.join("page.HTM"));
    let targets = ExportTargets::default();
    targets.0.lock().unwrap().insert(pdf.clone());
    let path = pdf.to_string_lossy().into_owned();
    assert!(targets.take(&path, "html").is_err());
    assert_eq!(targets.take(&path, "pdf").unwrap(), pdf);
    assert!(targets.take(&path, "pdf").is_err());
    assert!(targets.take(&dir.join("other.pdf").to_string_lossy(), "pdf").is_err());
  }

  #[test]
  fn temp_dirs_are_private_and_fresh() {
    let a = private_temp_dir().unwrap();
    let b = private_temp_dir().unwrap();
    assert_ne!(a, b);
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o700);
    }
    fs::remove_dir_all(a).unwrap();
    fs::remove_dir_all(b).unwrap();
  }
}
