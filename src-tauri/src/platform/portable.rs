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

use super::{path_name, EXISTS};
use crate::i18n;

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

// The final component is opened without following a link (O_NOFOLLOW, or the reparse point itself on
// Windows), and the check is made on the opened handle, so a link swapped in after a check isn't followed.
pub fn open_for_read(path: &Path) -> Result<fs::File, String> {
  let mut options = OpenOptions::new();
  options.read(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
  }
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
  }
  let file = options.open(path).map_err(|e| {
    #[cfg(unix)]
    if e.raw_os_error() == Some(libc::ELOOP) {
      return i18n::t_with("error.document.symbolicLink", &[("name", &path_name(path))]);
    }
    e.to_string()
  })?;
  let meta = file.metadata().map_err(|e| e.to_string())?;
  if meta.file_type().is_symlink() { return Err(i18n::t_with("error.document.symbolicLink", &[("name", &path_name(path))])); }
  if !meta.is_file() { return Err(i18n::t_with("error.document.notRegular", &[("name", &path_name(path))])); }
  Ok(file)
}

// Fails if `target` exists. The check and the rename are separate steps here (a small race).
pub fn create_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
  if fs::symlink_metadata(target).is_ok() { return Err(format!("{EXISTS}{}", path_name(target))); }
  replace_file(target, bytes)
}

pub fn replace_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
  if let Ok(meta) = fs::symlink_metadata(target) {
    if meta.file_type().is_symlink() || !meta.is_file() {
      return Err(i18n::t_with("error.document.notRegular", &[("name", &path_name(target))]));
    }
  }
  let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
  let name = target.file_name().ok_or_else(|| i18n::t("error.file.invalidPath"))?.to_string_lossy();
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

#[cfg(all(test, unix))]
mod tests {
  use super::*;

  #[test]
  fn reads_regular_files_and_refuses_links() {
    let dir = std::env::temp_dir().join(format!("ov-portable-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("a.md");
    let link = dir.join("b.md");
    replace_file(&file, b"hi").unwrap();
    let _ = fs::remove_file(&link);
    std::os::unix::fs::symlink(&file, &link).unwrap();
    assert!(open_for_read(&file).is_ok());
    assert!(open_for_read(&link).unwrap_err().contains("symbolic link"));
    assert!(open_for_read(&dir).unwrap_err().contains("not a regular file"));
    assert!(create_file(&file, b"x").unwrap_err().starts_with(EXISTS));
    fs::remove_dir_all(&dir).unwrap();
  }
}
