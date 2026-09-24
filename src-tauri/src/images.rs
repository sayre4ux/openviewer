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

// ---------- Pasting and dropping images into a document ----------

// Image files the user dropped on a window, each usable once by `insert_dropped_image`.
#[derive(Default)]
pub struct DroppedImages(pub Mutex<HashSet<PathBuf>>);

pub fn droppable_images(paths: &[PathBuf]) -> Vec<PathBuf> {
  paths.iter().filter_map(|p| fs::canonicalize(p).ok()).filter(|p| is_image_file(p)).collect()
}

#[derive(serde::Serialize, Debug)]
pub struct InsertedImage {
  pub markdown: String,
}

// The folder images go in for a document, from the "imageFolder" setting.
fn target_folder(document: &Path, setting: &str) -> Option<PathBuf> {
  let dir = document.parent()?;
  Some(match setting {
    "{name}.assets" => dir.join(format!("{}.assets", document.file_stem()?.to_string_lossy())),
    "." => dir.to_path_buf(),
    _ => dir.join("assets"),
  })
}

// Make sure the image folder is a real folder directly inside the document's folder, creating it if
// needed; a symlink or a file in its place is refused.
fn ensure_folder(folder: &Path, document_dir: &Path) -> Result<PathBuf, String> {
  match fs::symlink_metadata(folder) {
    Ok(meta) if meta.file_type().is_symlink() => return Err(format!("{} is a symbolic link; images won't be saved there", path_name(folder))),
    Ok(meta) if !meta.is_dir() => return Err(format!("{} exists and isn't a folder", path_name(folder))),
    Ok(_) => {}
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir(folder).map_err(|e| e.to_string())?,
    Err(e) => return Err(e.to_string()),
  }
  let canonical = fs::canonicalize(folder).map_err(|e| e.to_string())?;
  let expected = if folder == document_dir { document_dir.to_path_buf() } else { document_dir.join(folder.file_name().unwrap_or_default()) };
  if canonical != expected { return Err(format!("{} isn't inside the document's folder", path_name(folder))); }
  Ok(canonical)
}

// A safe file name from a hint: no separators, control characters, or leading dots; short.
fn file_name_from(hint: &str) -> Option<(String, String)> {
  let base = hint.rsplit(['/', '\\']).next()?.trim();
  let (stem, ext) = base.rsplit_once('.')?;
  let ext = ext.to_ascii_lowercase();
  if !IMAGE_EXTENSIONS.contains(&ext.as_str()) { return None; }
  let stem: String = stem.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
  let stem = stem.trim().trim_start_matches('.').chars().take(100).collect::<String>();
  Some((if stem.is_empty() { "image".into() } else { stem }, ext))
}

// Store image bytes for a document and return the stored file. Reuses an identical file already in the
// folder; otherwise picks a free name (`name.png`, `name-1.png`, ...) without overwriting anything.
fn store_image(document: &Path, setting: &str, name_hint: &str, bytes: &[u8]) -> Result<PathBuf, String> {
  if bytes.is_empty() { return Err("The image is empty.".into()); }
  if bytes.len() as u64 > IMAGE_LIMIT { return Err("The image is larger than 32 MB.".into()); }
  let (stem, ext) = file_name_from(name_hint).ok_or("That file type isn't a supported image.")?;
  let document_dir = document.parent().ok_or("Invalid document path")?;
  let folder = ensure_folder(&target_folder(document, setting).ok_or("Invalid document path")?, document_dir)?;
  if let Ok(entries) = fs::read_dir(&folder) {
    for entry in entries.flatten().take(5000) {
      let path = entry.path();
      let same_size = entry.metadata().is_ok_and(|m| m.is_file() && m.len() == bytes.len() as u64);
      if same_size && has_extension(&path, &[ext.as_str()]) && fs::read(&path).is_ok_and(|b| b == bytes) {
        return Ok(path);
      }
    }
  }
  for n in 0..1000 {
    let name = if n == 0 { format!("{stem}.{ext}") } else { format!("{stem}-{n}.{ext}") };
    let target = folder.join(&name);
    match platform::create_file(&target, bytes) {
      Ok(()) => return Ok(target),
      Err(e) if e.starts_with(platform::EXISTS) => continue,
      Err(e) => return Err(e),
    }
  }
  Err("Couldn't find a free file name for the image.".into())
}

// The Markdown for an image: a path relative to the document, `/`-separated, with characters that
// would end or break a link destination percent-encoded (spaces, parentheses, <, >, #, ?, %).
fn markdown_for(document: &Path, image: &Path) -> Option<String> {
  let relative = image.strip_prefix(document.parent()?).ok()?;
  let encoded: Vec<String> = relative.components().map(|c| {
    c.as_os_str().to_string_lossy().chars().map(|ch| match ch {
      ' ' => "%20".into(), '(' => "%28".into(), ')' => "%29".into(), '<' => "%3C".into(), '>' => "%3E".into(),
      '#' => "%23".into(), '?' => "%3F".into(), '%' => "%25".into(), c => c.to_string(),
    }).collect()
  }).collect();
  let alt: String = image.file_stem()?.to_string_lossy().chars().filter(|c| !matches!(c, '[' | ']' | '\\')).collect();
  Some(format!("![{alt}]({})", encoded.join("/")))
}

fn insert(
  authorized: &AuthorizedDocuments,
  settings: &crate::settings::SettingsState,
  document_path: &str,
  name_hint: &str,
  bytes: &[u8],
) -> Result<InsertedImage, String> {
  let document = authorized.require(Path::new(document_path), false)?;
  let setting = settings.0.lock().unwrap().image_folder.clone();
  let stored = store_image(&document, &setting, name_hint, bytes)?;
  Ok(InsertedImage { markdown: markdown_for(&document, &stored).ok_or("Couldn't link the image")? })
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let hex = |b: u8| (b as char).to_digit(16);
      if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
        out.push((h * 16 + l) as u8);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

// Pasted image bytes arrive as the raw request body; the document path and a file name hint arrive
// percent-encoded in headers (header values must be ASCII).
#[tauri::command]
pub async fn insert_image(
  request: tauri::ipc::Request<'_>,
  authorized: tauri::State<'_, AuthorizedDocuments>,
  settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<InsertedImage, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected image bytes".into()) };
  let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(percent_decode);
  let document = header("x-document").ok_or("Missing document")?;
  let name = header("x-name").unwrap_or_else(|| "image.png".into());
  insert(&authorized, &settings, &document, &name, bytes)
}

// A file the user dropped on this window. Each drop allows each file once.
#[tauri::command]
pub async fn insert_dropped_image(
  document_path: String,
  source: String,
  authorized: tauri::State<'_, AuthorizedDocuments>,
  settings: tauri::State<'_, crate::settings::SettingsState>,
  dropped: tauri::State<'_, DroppedImages>,
) -> Result<InsertedImage, String> {
  let source = fs::canonicalize(&source).map_err(|e| e.to_string())?;
  if !dropped.0.lock().unwrap().remove(&source) { return Err("That image wasn't dropped on this window.".into()); }
  let file = platform::open_for_read(&source)?;
  let mut bytes = Vec::new();
  file.take(IMAGE_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
  insert(&authorized, &settings, &document_path, &source.file_name().unwrap_or_default().to_string_lossy(), &bytes)
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

  #[test]
  fn stored_images_go_in_assets_and_are_linked_relatively() {
    let d = dir("store");
    let doc = d.join("My Notes.md");
    fs::write(&doc, "").unwrap();
    let png = b"\x89PNG fake";
    let first = store_image(&doc, "assets", "image-20260924-120000.png", png).unwrap();
    assert_eq!(first, d.join("assets/image-20260924-120000.png"));
    assert_eq!(markdown_for(&doc, &first).unwrap(), "![image-20260924-120000](assets/image-20260924-120000.png)");
    // The same bytes again reuse the file; different bytes under the same name get a new name.
    assert_eq!(store_image(&doc, "assets", "other name.png", png).unwrap(), first);
    let second = store_image(&doc, "assets", "image-20260924-120000.png", b"different").unwrap();
    assert_eq!(second, d.join("assets/image-20260924-120000-1.png"));
    // Per-document folders and awkward names.
    let per_doc = store_image(&doc, "{name}.assets", "a (1) #x.jpg", b"jpeg").unwrap();
    assert_eq!(per_doc, d.join("My Notes.assets/a (1) #x.jpg"));
    assert_eq!(markdown_for(&doc, &per_doc).unwrap(), "![a (1) #x](My%20Notes.assets/a%20%281%29%20%23x.jpg)");
    // Names can't escape or hide; types must be images.
    let sneaky = store_image(&doc, "assets", "../../.evil.png", b"x").unwrap();
    assert_eq!(sneaky.parent().unwrap(), d.join("assets"));
    assert!(!sneaky.file_name().unwrap().to_string_lossy().starts_with('.'));
    assert!(store_image(&doc, "assets", "run.sh", b"x").is_err());
    assert!(store_image(&doc, "assets", "big.png", &vec![0u8; (IMAGE_LIMIT + 1) as usize]).is_err());
    let _ = fs::remove_dir_all(d);
  }

  #[cfg(unix)]
  #[test]
  fn a_symlinked_assets_folder_is_refused() {
    let d = dir("symassets");
    let elsewhere = dir("elsewhere");
    let doc = d.join("page.md");
    fs::write(&doc, "").unwrap();
    std::os::unix::fs::symlink(&elsewhere, d.join("assets")).unwrap();
    assert!(store_image(&doc, "assets", "a.png", b"png").unwrap_err().contains("symbolic link"));
    assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    let _ = fs::remove_dir_all(d);
    let _ = fs::remove_dir_all(elsewhere);
  }

  #[test]
  fn percent_decoding_of_headers() {
    assert_eq!(percent_decode("%2FUsers%2Fme%2F%E6%9C%83%E8%AD%B0.md"), "/Users/me/會議.md");
    assert_eq!(percent_decode("100%"), "100%");
    assert_eq!(percent_decode("%zz"), "%zz");
  }
}
