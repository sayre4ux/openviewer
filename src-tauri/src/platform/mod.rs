// OS-specific file operations behind one small API. macOS gets race-safe versions built on
// descriptors (a symlink swapped in after a check is never followed). Other targets get a portable
// fallback so the app builds there; it checks before opening but has a small race window.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{open_for_read, replace_file};

#[cfg(not(target_os = "macos"))]
mod portable;
#[cfg(not(target_os = "macos"))]
pub use portable::{open_for_read, replace_file};

use std::path::Path;

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
