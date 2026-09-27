// Race-safe file I/O on macOS: opens refuse a final-component symlink and are checked with F_GETPATH;
// replacements go through a verified directory descriptor (openat/renameat) and copy ACLs, extended
// attributes (Finder tags), mode, and group from the file they replace.

use std::{
  ffi::{CStr, CString, OsStr},
  fs::{self, OpenOptions},
  io::Write,
  os::unix::{ffi::OsStrExt, fs::{MetadataExt, OpenOptionsExt}, io::{AsRawFd, FromRawFd, RawFd}},
  path::{Path, PathBuf},
  sync::atomic::{AtomicU64, Ordering},
};

use crate::i18n;

use super::{path_name, EXISTS};

static TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn fd_path(fd: RawFd) -> Result<PathBuf, String> {
  let mut buf = vec![0u8; libc::MAXPATHLEN as usize];
  let rc = unsafe { libc::fcntl(fd, libc::F_GETPATH, buf.as_mut_ptr().cast::<libc::c_char>()) };
  if rc == -1 { return Err(std::io::Error::last_os_error().to_string()); }
  let len = buf.iter().position(|b| *b == 0).ok_or_else(|| i18n::t("error.file.openedPath"))?;
  Ok(PathBuf::from(OsStr::from_bytes(&buf[..len])))
}

// DECISION: `O_NOFOLLOW` only rejects a symlink at the final component, so a `/var` → `/private/var`
// parent still opens. Accept that parent resolution; reject anything whose final name differs.
fn same_opened_file(requested: &Path, opened: &Path) -> bool {
  if opened == requested { return true; }
  let Some(name) = requested.file_name() else { return false };
  if opened.file_name() != Some(name) { return false; }
  let Some(parent) = requested.parent().filter(|p| !p.as_os_str().is_empty()) else { return false };
  fs::canonicalize(parent).ok().is_some_and(|dir| opened == dir.join(name))
}

// Open `path` for reading without following a final-component symlink and without blocking on a
// FIFO, and confirm the descriptor really is that file.
pub fn open_for_read(path: &Path) -> Result<fs::File, String> {
  let file = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(path)
    .map_err(|e| e.to_string())?;
  let opened = fd_path(file.as_raw_fd())?;
  if !same_opened_file(path, &opened) {
    return Err(i18n::t_with("error.file.openedChanged", &[
      ("name", &path_name(path)), ("opened", &opened.display().to_string()), ("expected", &path.display().to_string()),
    ]));
  }
  Ok(file)
}

// ACLs and extended attributes (Finder tags included), copied fd to fd so a swapped symlink is not followed.
fn copy_metadata_fd(from: &fs::File, to: &fs::File) -> Result<(), String> {
  let rc = unsafe { libc::fcopyfile(from.as_raw_fd(), to.as_raw_fd(), std::ptr::null_mut(), libc::COPYFILE_METADATA) };
  if rc == 0 { return Ok(()) }
  let err = std::io::Error::last_os_error();
  // Volumes without ACLs or extended attributes (FAT, some network shares) have none to lose.
  if matches!(err.raw_os_error(), Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)) { return Ok(()) }
  Err(i18n::t_with("error.file.metadataCopy", &[("error", &err.to_string())]))
}

fn open_existing(dirfd: libc::c_int, name: &CStr) -> Result<Option<fs::File>, String> {
  let fd = unsafe { libc::openat(dirfd, name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
  if fd >= 0 { return Ok(Some(unsafe { fs::File::from_raw_fd(fd) })); }
  let err = std::io::Error::last_os_error();
  if err.kind() == std::io::ErrorKind::NotFound { return Ok(None); }
  Err(err.to_string())
}

fn create_temp(dirfd: libc::c_int, name: &OsStr) -> Result<(CString, fs::File), String> {
  loop {
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temp_name = format!(".{}.openviewer-{}-{id}.tmp", name.to_string_lossy(), std::process::id());
    let temp_c = CString::new(temp_name).map_err(|_| i18n::t("error.file.invalidPath"))?;
    // O_CLOEXEC: don't leak the temp fd across exec. O_NOFOLLOW: the name must be the new file, not a link.
    let fd = unsafe {
      libc::openat(dirfd, temp_c.as_ptr(), libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o666 as libc::c_int)
    };
    if fd >= 0 { return Ok((temp_c, unsafe { fs::File::from_raw_fd(fd) })); }
    let err = std::io::Error::last_os_error();
    if err.kind() == std::io::ErrorKind::AlreadyExists { continue; }
    return Err(err.to_string());
  }
}

// Atomically replace (or create) `target` with `bytes`. The final name is never followed; the parent
// directory descriptor is verified with F_GETPATH.
pub fn replace_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
  write_via_temp(target, bytes, false)
}

// Create `target` with `bytes`, failing if anything already exists at that name (RENAME_EXCL), so a
// file created in the meantime is never overwritten.
pub fn create_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
  write_via_temp(target, bytes, true)
}

fn write_via_temp(target: &Path, bytes: &[u8], exclusive: bool) -> Result<(), String> {
  let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("/"));
  let name = target.file_name().ok_or_else(|| i18n::t("error.file.invalidPath"))?;
  let dir = OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(parent).map_err(|e| e.to_string())?;
  let opened_parent = fd_path(dir.as_raw_fd())?;
  if opened_parent != parent {
    return Err(i18n::t_with("error.file.folderChanged", &[
      ("opened", &opened_parent.display().to_string()), ("expected", &parent.display().to_string()),
    ]));
  }
  let dirfd = dir.as_raw_fd();
  let name_c = CString::new(name.as_bytes()).map_err(|_| i18n::t("error.file.invalidPath"))?;
  let existing = if exclusive { None } else { open_existing(dirfd, &name_c)? };
  if let Some(existing) = &existing {
    let meta = existing.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() { return Err(i18n::t_with("error.document.notRegular", &[("name", &path_name(target))])); }
  }
  let (temp_c, mut file) = create_temp(dirfd, name)?;
  let result = (|| {
    if let Some(existing) = &existing {
      let meta = existing.metadata().map_err(|e| e.to_string())?;
      file.set_permissions(meta.permissions()).map_err(|e| e.to_string())?;
    }
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if let Some(existing) = &existing {
      copy_metadata_fd(existing, &file)?;
      let meta = existing.metadata().map_err(|e| e.to_string())?;
      // DECISION: a group we can't set (EPERM) must not fail the save. fcopyfile reports success anyway.
      let _ = unsafe { libc::fchown(file.as_raw_fd(), -1i32 as libc::uid_t, meta.gid()) };
    }
    let rc = if exclusive {
      unsafe { libc::renameatx_np(dirfd, temp_c.as_ptr(), dirfd, name_c.as_ptr(), libc::RENAME_EXCL) }
    } else {
      unsafe { libc::renameat(dirfd, temp_c.as_ptr(), dirfd, name_c.as_ptr()) }
    };
    if rc != 0 {
      let err = std::io::Error::last_os_error();
      if err.kind() == std::io::ErrorKind::AlreadyExists { return Err(format!("{EXISTS}{}", path_name(target))); }
      return Err(err.to_string());
    }
    Ok(())
  })();
  if result.is_err() { let _ = unsafe { libc::unlinkat(dirfd, temp_c.as_ptr(), 0) }; }
  result
}
