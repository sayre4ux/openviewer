// Links between documents: ⌘-clicking `[notes](other.md)` opens other.md in a new window. The target
// comes from the document, which is untrusted, so it gets the same boundary as the document's images
// (its git repository, or its own folder) and must be a Markdown or text file. Nothing else a link
// names is ever opened: a link to `run.command` or an app must not start it.

use std::{fs, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager, Runtime};

use crate::{
  documents::{has_extension, AuthorizedDocuments, DOCUMENT_EXTENSIONS},
  images::{home_dir, image_root, percent_decode},
};

// Same limit as opening a document.
const DOCUMENT_LIMIT: u64 = 64 * 1024 * 1024;

pub fn linked_document(document: &Path, target: &str, home: Option<&Path>) -> Result<PathBuf, String> {
  let mut raw = target.trim();
  if let Some(inner) = raw.strip_prefix('<').and_then(|t| t.strip_suffix('>')) { raw = inner; }
  let decoded = percent_decode(raw);
  let has_scheme = decoded.split_once(':').is_some_and(|(scheme, _)| {
    scheme.len() > 1 && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
  });
  if decoded.is_empty() || has_scheme || decoded.starts_with('~') {
    return Err("That link isn't a document next to this one.".into());
  }
  let document = fs::canonicalize(document).map_err(|e| e.to_string())?;
  let folder = document.parent().ok_or("Invalid document path")?;
  let candidate = if Path::new(&decoded).is_absolute() { PathBuf::from(&decoded) } else { folder.join(&decoded) };
  let linked = fs::canonicalize(&candidate).map_err(|_| format!("{} doesn't exist.", display_name(&candidate)))?;
  if !has_extension(&linked, DOCUMENT_EXTENSIONS) {
    return Err("Only Markdown and text documents open from a link.".into());
  }
  let root = image_root(&document, home).ok_or("Invalid document path")?;
  // A document saved directly in the home folder or at the disk root reaches only its own folder.
  let broad = Some(root.as_path()) == home || root.parent().is_none();
  let inside = if broad { linked.parent() == Some(root.as_path()) } else { linked.starts_with(&root) };
  if !inside {
    return Err(format!("{} is outside this document's folder or repository, so it doesn't open from a link.", display_name(&linked)));
  }
  let meta = fs::metadata(&linked).map_err(|e| e.to_string())?;
  if !meta.is_file() || meta.len() > DOCUMENT_LIMIT {
    return Err(format!("{} can't be opened.", display_name(&linked)));
  }
  Ok(linked)
}

fn display_name(path: &Path) -> String {
  path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "The linked document".into())
}

#[tauri::command]
pub fn open_linked_document<R: Runtime>(app: AppHandle<R>, document_path: String, target: String, anchor: Option<String>) -> Result<(), String> {
  let authorized = app.state::<AuthorizedDocuments>();
  let document = authorized.require(Path::new(&document_path), false)?;
  let linked = linked_document(&document, &target, home_dir().as_deref())?;
  // `linked` is canonical and checked; authorizing it re-resolves it and refuses if that changed.
  let linked = authorized.authorize_exact(&linked)?;
  let anchor = anchor.filter(|a| !a.is_empty() && a.len() <= 512);
  crate::open_document_window(&app, &linked, anchor.as_deref())
}

#[cfg(test)]
mod tests {
  use super::linked_document;
  use std::fs;

  fn tree() -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!("openviewer-links-{}-{:?}", std::process::id(), std::thread::current().id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(base.join("notes/sub")).unwrap();
    fs::create_dir_all(base.join("outside")).unwrap();
    for (path, text) in [("notes/a.md", "a"), ("notes/sub/b.md", "b"), ("notes/my notes.md", "c"), ("notes/run.command", "x"), ("outside/c.md", "c")] {
      fs::write(base.join(path), text).unwrap();
    }
    fs::canonicalize(base).unwrap()
  }

  #[test]
  fn links_open_only_documents_inside_the_boundary() {
    let base = tree();
    let doc = base.join("notes/a.md");
    assert_eq!(linked_document(&doc, "sub/b.md", None).unwrap(), base.join("notes/sub/b.md"));
    assert_eq!(linked_document(&doc, "./sub/../a.md", None).unwrap(), base.join("notes/a.md"));
    assert_eq!(linked_document(&doc, "my%20notes.md", None).unwrap(), base.join("notes/my notes.md"));
    assert_eq!(linked_document(&doc, "<my notes.md>", None).unwrap(), base.join("notes/my notes.md"));
    // Outside the folder (no repository here), another type, a URL, a missing file, a folder.
    assert!(linked_document(&doc, "../outside/c.md", None).is_err());
    assert!(linked_document(&doc, &base.join("outside/c.md").to_string_lossy(), None).is_err());
    assert!(linked_document(&doc, "run.command", None).is_err());
    assert!(linked_document(&doc, "file:///etc/hosts.md", None).is_err());
    assert!(linked_document(&doc, "missing.md", None).is_err());
    assert!(linked_document(&doc, "sub", None).is_err());
    assert!(linked_document(&doc, "~/secret.md", None).is_err());
    let _ = fs::remove_dir_all(&base);
  }

  #[cfg(unix)]
  #[test]
  fn a_path_swapped_for_a_symlink_after_the_check_is_not_authorized() {
    use crate::documents::AuthorizedDocuments;
    let base = tree();
    let checked = linked_document(&base.join("notes/a.md"), "sub/b.md", None).unwrap();
    // The race: after the check, the checked file is replaced by a link to a file outside.
    fs::remove_file(&checked).unwrap();
    std::os::unix::fs::symlink(base.join("outside/c.md"), &checked).unwrap();
    let authorized = AuthorizedDocuments::default();
    assert!(authorized.authorize_exact(&checked).is_err());
    assert!(authorized.0.lock().unwrap().is_empty());
    let _ = fs::remove_dir_all(&base);
  }

  #[cfg(unix)]
  #[test]
  fn a_symlink_out_of_the_folder_does_not_open() {
    let base = tree();
    std::os::unix::fs::symlink(base.join("outside/c.md"), base.join("notes/link.md")).unwrap();
    assert!(linked_document(&base.join("notes/a.md"), "link.md", None).is_err());
    let _ = fs::remove_dir_all(&base);
  }
}
