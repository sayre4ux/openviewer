// OS-specific file operations behind one small API. macOS gets race-safe versions built on
// descriptors (a symlink swapped in after a check is never followed). Other targets get a portable
// fallback so the app builds there; it checks before opening but has a small race window.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{create_file, open_for_read, replace_file};

// Also compiled for tests on macOS, so the fallback is exercised before a port needs it.
#[cfg(any(not(target_os = "macos"), test))]
mod portable;
#[cfg(not(target_os = "macos"))]
pub use portable::{create_file, open_for_read, replace_file};

// Printing an exported page to PDF. Windows can do this later with WebView2's PrintToPdf.
#[cfg(target_os = "macos")]
mod macos_pdf;
#[cfg(target_os = "macos")]
pub use macos_pdf::print_to_pdf;

#[cfg(not(target_os = "macos"))]
pub async fn print_to_pdf<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _html: String, _out: std::path::PathBuf) -> Result<(), String> {
  Err("PDF export isn't available on this system yet. Export as HTML and print it from a browser.".into())
}

use std::path::Path;

// `create_file` errors start with this when the name is already taken.
pub const EXISTS: &str = "exists:";

pub(crate) fn path_name(path: &Path) -> String {
  path.file_name().map(|s| s.to_string_lossy().into_owned()).filter(|s| !s.is_empty())
    .unwrap_or_else(|| path.display().to_string())
}

// A file's identity (device, inode) where the platform has one; size and modification time are
// compared too, so the fallback still notices most replacements.
#[cfg(unix)]
pub fn file_id(meta: &std::fs::Metadata) -> (u64, u64) {
  use std::os::unix::fs::MetadataExt;
  (meta.dev(), meta.ino())
}
#[cfg(not(unix))]
pub fn file_id(_meta: &std::fs::Metadata) -> (u64, u64) {
  (0, 0)
}
