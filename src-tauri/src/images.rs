// Local images. A document may show an image only after Rust checks it: inside the document's git
// repository (or its folder), or inside a folder the user allowed for that document; a regular image
// file; at most 32 MB. An allowed image gets a random token, and the page loads it from our own
// `ovimg:` scheme. The handler serves the token only while the file is still the one that was checked
// (same identity, size, and modification time), so a file swapped in later is never read.

use std::{
  collections::{HashMap, HashSet},
  fs,
  io::Read,
  path::{Path, PathBuf},
  sync::Mutex,
  time::SystemTime,
};
use tauri::{
  http::{header, Request, Response, StatusCode},
  Manager, Runtime,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::documents::{has_extension, AuthorizedDocuments};
use crate::platform::{self, path_name};

pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic", "heif", "bmp", "ico", "tif", "tiff"];
pub const IMAGE_LIMIT: u64 = 32 * 1024 * 1024;
pub const SCHEME: &str = "ovimg";

// ---------- Where a document's images may come from ----------

// Its git repository (the nearest folder above it that is a real repository), so `docs/page.md` can
// show `../images/x.png`; otherwise the document's own folder.
// DECISION: a repository at the home folder or the disk root (a dotfiles repo) doesn't count, since it
// would open every file in the home folder to any Markdown file under it.
pub fn image_root(document: &Path, home: Option<&Path>) -> Option<PathBuf> {
  let folder = document.parent()?;
  let repo = folder.ancestors().find(|dir| is_git_repository(dir));
  Some(match repo {
    Some(root) if root.parent().is_some() && Some(root) != home => root.to_path_buf(),
    _ => folder.to_path_buf(),
  })
}

// A real repository: a `.git` folder whose HEAD looks like git's (a `ref:` line or a commit hash), or a
// `.git` file whose `gitdir:` points at such a folder (worktrees, submodules). A stray `.git` entry, e.g.
// from an extracted archive, doesn't widen the image root.
fn is_git_repository(dir: &Path) -> bool {
  let git = dir.join(".git");
  match fs::symlink_metadata(&git) {
    Ok(meta) if meta.is_dir() => is_git_dir(&git),
    Ok(meta) if meta.is_file() && meta.len() < 4096 => fs::read_to_string(&git).ok()
      .and_then(|t| t.strip_prefix("gitdir:").map(|p| p.trim().to_owned()))
      .is_some_and(|p| is_git_dir(&dir.join(p))),
    _ => false,
  }
}

fn is_git_dir(git: &Path) -> bool {
  let head = git.join("HEAD");
  let looks_like_head = |t: &str| {
    let t = t.trim();
    t.starts_with("ref: refs/") || ((t.len() == 40 || t.len() == 64) && t.chars().all(|c| c.is_ascii_hexdigit()))
  };
  fs::metadata(&head).is_ok_and(|m| m.is_file() && m.len() < 1024)
    && fs::read_to_string(&head).is_ok_and(|t| looks_like_head(&t))
    && git.join("objects").is_dir()
}

fn is_image_file(image: &Path) -> bool {
  fs::metadata(image).is_ok_and(|m| m.is_file() && m.len() <= IMAGE_LIMIT) && has_extension(image, IMAGE_EXTENSIONS)
}

// A local image inside the document's image root, after resolving symlinks. When that root is the home
// folder or the disk root (a note saved directly there), only images in that same folder count.
pub fn scoped_image_path(document: &Path, source: &Path, home: Option<&Path>) -> Option<PathBuf> {
  let document = fs::canonicalize(document).ok()?;
  let root = image_root(&document, home)?;
  let image = canonical_image(&document, source)?;
  let broad = Some(root.as_path()) == home || root.parent().is_none();
  let inside = if broad { image.parent() == Some(root.as_path()) } else { image.starts_with(&root) };
  (inside && is_image_file(&image)).then_some(image)
}

fn canonical_image(document: &Path, source: &Path) -> Option<PathBuf> {
  let candidate = if source.is_absolute() { source.to_path_buf() } else { document.parent()?.join(source) };
  fs::canonicalize(candidate).ok()
}

pub fn home_dir() -> Option<PathBuf> {
  let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
  fs::canonicalize(PathBuf::from(home)).ok()
}

// ---------- Tokens and folder grants ----------

#[derive(Clone, PartialEq, Debug)]
struct Identity { id: (u64, u64), size: u64, modified: Option<SystemTime> }

fn identity(meta: &fs::Metadata) -> Identity {
  Identity { id: platform::file_id(meta), size: meta.len(), modified: meta.modified().ok() }
}

struct Grant { path: PathBuf, identity: Identity }

#[derive(Default)]
pub struct ImageGrants {
  tokens: Mutex<HashMap<String, Grant>>,
  issued: Mutex<HashMap<PathBuf, String>>,
  // Folders the user allowed for a document (canonical document → folders), for this session.
  folders: Mutex<HashMap<PathBuf, HashSet<PathBuf>>>,
}

impl ImageGrants {
  // One token per file version: re-renders reuse it, a changed file gets a new one (and the old one
  // stops working because the identity no longer matches).
  fn token_for(&self, image: &Path) -> Option<String> {
    let identity = identity(&fs::metadata(image).ok()?);
    let mut issued = self.issued.lock().unwrap();
    let mut tokens = self.tokens.lock().unwrap();
    if let Some(token) = issued.get(image) {
      if tokens.get(token).is_some_and(|g| g.identity == identity) { return Some(token.clone()); }
      tokens.remove(token);
    }
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).ok()?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    tokens.insert(token.clone(), Grant { path: image.to_path_buf(), identity });
    issued.insert(image.to_path_buf(), token.clone());
    Some(token)
  }

  fn allowed_folder(&self, document: &Path, image: &Path) -> bool {
    self.folders.lock().unwrap().get(document).is_some_and(|dirs| dirs.iter().any(|d| image.starts_with(d)))
  }

  fn allow_folder(&self, document: &Path, folder: &Path) {
    self.folders.lock().unwrap().entry(document.to_path_buf()).or_default().insert(folder.to_path_buf());
  }

  // The bytes and content type for a token, if the file is still the one that was checked.
  fn serve(&self, token: &str) -> Option<(Vec<u8>, &'static str)> {
    let (path, expected) = {
      let tokens = self.tokens.lock().unwrap();
      let grant = tokens.get(token)?;
      (grant.path.clone(), grant.identity.clone())
    };
    let file = platform::open_for_read(&path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || identity(&meta) != expected || meta.len() > IMAGE_LIMIT { return None; }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(meta.len() + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 == meta.len()).then(|| (bytes, content_type(&path)))
  }
}

fn content_type(path: &Path) -> &'static str {
  match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
    Some("png") => "image/png",
    Some("jpg" | "jpeg") => "image/jpeg",
    Some("gif") => "image/gif",
    Some("webp") => "image/webp",
    Some("svg") => "image/svg+xml",
    Some("avif") => "image/avif",
    Some("heic") => "image/heic",
    Some("heif") => "image/heif",
    Some("bmp") => "image/bmp",
    Some("ico") => "image/x-icon",
    Some("tif" | "tiff") => "image/tiff",
    _ => "application/octet-stream",
  }
}

// The URL a webview uses for a custom scheme differs by platform.
fn scheme_url(token: &str) -> String {
  if cfg!(windows) { format!("http://{SCHEME}.localhost/{token}") } else { format!("{SCHEME}://localhost/{token}") }
}

pub fn respond(grants: &ImageGrants, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
  let token = request.uri().path().trim_start_matches('/');
  let not_found = || Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
  let Some((bytes, mime)) = grants.serve(token) else { return not_found() };
  Response::builder()
    .header(header::CONTENT_TYPE, mime)
    .header(header::CACHE_CONTROL, "no-store")
    .header("X-Content-Type-Options", "nosniff")
    // An SVG shown through <img> can't run script anyway; this keeps it inert if opened directly.
    .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'")
    .body(bytes)
    .unwrap_or_else(|_| not_found())
}

// ---------- Commands ----------

#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Resolution {
  Ok { url: String },
  // `folder`: the image exists but is outside what the document may show; the user can allow it.
  Blocked { folder: Option<String> },
}

fn resolve(grants: &ImageGrants, document: &Path, source: &Path, home: Option<&Path>) -> Resolution {
  let allowed = scoped_image_path(document, source, home).or_else(|| {
    let image = canonical_image(document, source)?;
    (grants.allowed_folder(document, &image) && is_image_file(&image)).then_some(image)
  });
  if let Some(image) = allowed {
    if let Some(token) = grants.token_for(&image) { return Resolution::Ok { url: scheme_url(&token) }; }
  }
  let folder = canonical_image(document, source)
    .filter(|image| is_image_file(image))
    .and_then(|image| grantable_folder(&image, home))
    .map(|f| f.to_string_lossy().into_owned());
  Resolution::Blocked { folder }
}

// The folder a user may allow for an image: its own folder, but never the home folder or a disk root.
fn grantable_folder(image: &Path, home: Option<&Path>) -> Option<PathBuf> {
  let folder = image.parent()?;
  (folder.parent().is_some() && Some(folder) != home).then(|| folder.to_path_buf())
}

#[tauri::command]
pub fn resolve_image_path(
  document_path: String,
  source: String,
  authorized: tauri::State<AuthorizedDocuments>,
  grants: tauri::State<ImageGrants>,
) -> Resolution {
  let Ok(document) = authorized.require(Path::new(&document_path), false) else { return Resolution::Blocked { folder: None } };
  resolve(&grants, &document, Path::new(&source), home_dir().as_deref())
}

// "Show images from <folder>?" Asked in a native dialog, so a page can't grant itself access.
#[tauri::command]
pub async fn allow_image_folder<R: Runtime>(app: tauri::AppHandle<R>, document_path: String, source: String) -> Result<bool, String> {
  let document = app.state::<AuthorizedDocuments>().require(Path::new(&document_path), false)?;
  let image = canonical_image(&document, Path::new(&source)).filter(|i| is_image_file(i)).ok_or("That image can't be found.")?;
  let folder = grantable_folder(&image, home_dir().as_deref()).ok_or("Images directly in the home folder can't be allowed.")?;
  let yes = app.dialog()
    .message(format!("“{}” wants to show images from “{}”. Allow it for this document until OpenViewer quits?", path_name(&document), folder.display()))
    .title("Show Images from Another Folder")
    .kind(MessageDialogKind::Warning)
    .buttons(MessageDialogButtons::OkCancelCustom("Show Images".into(), "Cancel".into()))
    .blocking_show();
  if yes { app.state::<ImageGrants>().allow_folder(&document, &folder); }
  Ok(yes)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU64, Ordering};

  static N: AtomicU64 = AtomicU64::new(0);
  fn dir(label: &str) -> PathBuf {
    let d = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("openviewer-img-{label}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir_all(&d).unwrap();
    d
  }
  fn token(r: &Resolution) -> String {
    match r { Resolution::Ok { url } => url.rsplit('/').next().unwrap().to_owned(), _ => panic!("blocked: {r:?}") }
  }

  #[test]
  fn images_stay_in_the_document_folder() {
    let d = dir("folder");
    fs::create_dir_all(d.join("doc")).unwrap();
    let doc = d.join("doc/page.md");
    fs::write(&doc, "").unwrap();
    fs::write(d.join("doc/local.png"), "local").unwrap();
    fs::write(d.join("outside.png"), "outside").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(d.join("outside.png"), d.join("doc/link.png")).unwrap();
    assert!(scoped_image_path(&doc, Path::new("local.png"), None).is_some());
    assert!(scoped_image_path(&doc, Path::new("../outside.png"), None).is_none());
    assert!(scoped_image_path(&doc, &d.join("outside.png"), None).is_none());
    #[cfg(unix)]
    assert!(scoped_image_path(&doc, Path::new("link.png"), None).is_none());
    let _ = fs::remove_dir_all(d);
  }

  #[test]
  fn repositories_widen_the_root_only_when_real() {
    let d = dir("repo");
    let repo = d.join("project");
    fs::create_dir_all(repo.join(".git/objects")).unwrap();
    fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    fs::create_dir_all(repo.join("docs")).unwrap();
    fs::create_dir_all(repo.join("images")).unwrap();
    let doc = repo.join("docs/page.md");
    fs::write(&doc, "").unwrap();
    fs::write(repo.join("images/x.png"), "png").unwrap();
    fs::write(repo.join("images/notes.txt"), "text").unwrap();
    fs::File::create(repo.join("images/huge.png")).unwrap().set_len(IMAGE_LIMIT + 1).unwrap();
    assert!(scoped_image_path(&doc, Path::new("../images/x.png"), None).is_some());
    assert!(scoped_image_path(&doc, Path::new("../images/notes.txt"), None).is_none());
    assert!(scoped_image_path(&doc, Path::new("../images/huge.png"), None).is_none());
    assert!(scoped_image_path(&doc, Path::new("../images/x.png"), Some(&repo)).is_none()); // repo at "home"
    let stray = d.join("stray");
    fs::create_dir_all(stray.join(".git/objects")).unwrap();
    fs::write(stray.join(".git/HEAD"), "anything").unwrap();
    fs::create_dir_all(stray.join("sub")).unwrap();
    fs::write(stray.join("sub/page.md"), "").unwrap();
    fs::write(stray.join("pic.png"), "png").unwrap();
    assert!(scoped_image_path(&stray.join("sub/page.md"), Path::new("../pic.png"), None).is_none());
    let _ = fs::remove_dir_all(d);
  }

  #[test]
  fn a_note_in_the_home_folder_sees_only_that_folder() {
    let home = dir("home");
    fs::create_dir_all(home.join("Library/Photos")).unwrap();
    fs::write(home.join("note.md"), "").unwrap();
    fs::write(home.join("here.png"), "png").unwrap();
    fs::write(home.join("Library/Photos/private.png"), "png").unwrap();
    let note = home.join("note.md");
    assert!(scoped_image_path(&note, Path::new("here.png"), Some(&home)).is_some());
    assert!(scoped_image_path(&note, Path::new("Library/Photos/private.png"), Some(&home)).is_none());
    let _ = fs::remove_dir_all(home);
  }

  #[test]
  fn tokens_serve_only_the_checked_file() {
    let d = dir("tokens");
    let doc = d.join("page.md");
    fs::write(&doc, "").unwrap();
    fs::write(d.join("a.png"), "first").unwrap();
    let grants = ImageGrants::default();
    let r1 = resolve(&grants, &doc, Path::new("a.png"), None);
    let t1 = token(&r1);
    assert_eq!(token(&resolve(&grants, &doc, Path::new("a.png"), None)), t1, "re-render reuses the token");
    assert_eq!(grants.serve(&t1).unwrap(), (b"first".to_vec(), "image/png"));
    // Replace the file (new inode, new size): the old token stops working, a new resolve issues a new one.
    fs::remove_file(d.join("a.png")).unwrap();
    fs::write(d.join("a.png"), "second, longer").unwrap();
    assert!(grants.serve(&t1).is_none());
    let t2 = token(&resolve(&grants, &doc, Path::new("a.png"), None));
    assert_ne!(t1, t2);
    assert_eq!(grants.serve(&t2).unwrap().0, b"second, longer".to_vec());
    assert!(grants.serve("not-a-token").is_none());
    let _ = fs::remove_dir_all(d);
  }

  #[test]
  fn folder_grants_are_per_document_and_never_the_home_folder() {
    let d = dir("grant");
    let home = d.join("home");
    fs::create_dir_all(home.join("Pictures/trip")).unwrap();
    fs::create_dir_all(home.join("notes")).unwrap();
    let doc = home.join("notes/page.md");
    let other = home.join("notes/other.md");
    fs::write(&doc, "").unwrap();
    fs::write(&other, "").unwrap();
    fs::write(home.join("Pictures/trip/a.png"), "png").unwrap();
    fs::write(home.join("root.png"), "png").unwrap();
    let grants = ImageGrants::default();
    let src = home.join("Pictures/trip/a.png");
    match resolve(&grants, &doc, &src, Some(&home)) {
      Resolution::Blocked { folder } => assert_eq!(folder.as_deref(), Some(home.join("Pictures/trip").to_str().unwrap())),
      r => panic!("{r:?}"),
    }
    grants.allow_folder(&doc, &home.join("Pictures/trip"));
    assert!(matches!(resolve(&grants, &doc, &src, Some(&home)), Resolution::Ok { .. }));
    assert!(matches!(resolve(&grants, &other, &src, Some(&home)), Resolution::Blocked { .. }), "grant is per document");
    assert_eq!(grantable_folder(&home.join("root.png"), Some(&home)), None);
    let _ = fs::remove_dir_all(d);
  }
}
