// Portable fallback for targets without the macOS descriptor APIs (e.g. a future Windows build).
// The same checks happen by path, so there is a small window between check and use.
// DECISION: good enough to build and run elsewhere; a platform module of its own should replace it
// before shipping on that platform (Windows: ReplaceFileW keeps ACLs and alternate streams).

use std::{
  fs::{self, OpenOptions},
  io::Write,
  path::Path,
  sync::atomic::{AtomicU64, Ordering},
};

use super::path_name;

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

pub fn open_for_read(path: &Path) -> Result<fs::File, String> {
  let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
  if meta.file_type().is_symlink() { return Err(format!("{} is a symbolic link and will not be followed", path_name(path))); }
  if !meta.is_file() { return Err(format!("{} is not a regular file", path_name(path))); }
  fs::File::open(path).map_err(|e| e.to_string())
}

pub fn replace_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
  if let Ok(meta) = fs::symlink_metadata(target) {
    if meta.file_type().is_symlink() || !meta.is_file() {
      return Err(format!("{} is not a regular file", path_name(target)));
    }
  }
  let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
  let name = target.file_name().ok_or_else(|| "Invalid file path".to_string())?.to_string_lossy();
  let permissions = fs::metadata(target).ok().map(|m| m.permissions());
  let (temp, mut file) = loop {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{name}.openviewer-{}-{id}.tmp", std::process::id()));
    match OpenOptions::new().write(true).create_new(true).open(&temp) {
      Ok(file) => break (temp, file),
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(e) => return Err(e.to_string()),
    }
  };
  let result = (|| {
    if let Some(p) = permissions { file.set_permissions(p).map_err(|e| e.to_string())?; }
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temp, target).map_err(|e| e.to_string())
  })();
  if result.is_err() { let _ = fs::remove_file(&temp); }
  result
}
