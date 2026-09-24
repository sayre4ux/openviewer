// PDF export on macOS. The exported page is loaded into an offscreen WKWebView that isn't part of the
// app: no IPC, JavaScript off, a non-persistent data store. AppKit then prints it to a PDF file.
// Everything here runs on the main thread; a helper thread only nudges it until the job ends.

use std::{
  cell::RefCell,
  collections::HashMap,
  ffi::c_void,
  path::PathBuf,
  sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
  },
  time::{Duration, Instant},
};

use objc2::{define_class, msg_send, rc::Retained, runtime::{Bool, NSObject}, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
  NSBackingStoreType, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow,
  NSWindowStyleMask,
};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration, WKWebsiteDataStore};
use tauri::{AppHandle, Runtime};

// Remote images get this long to load before the page is printed without them.
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);
// A4 in points; the print operation paginates to the user's default paper size.
const PAGE: NSSize = NSSize { width: 595.0, height: 842.0 };

type Done = mpsc::Sender<Result<(), String>>;

struct Job {
  webview: Retained<WKWebView>,
  window: Retained<NSWindow>,
  out: PathBuf,
  done: Done,
  alive: Arc<AtomicBool>,
  started: Instant,
  printing: Option<Retained<PrintDelegate>>,
}

thread_local! {
  static JOBS: RefCell<HashMap<u64, Job>> = RefCell::default();
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static COMPLETED: Mutex<Vec<(u64, Result<(), String>)>> = Mutex::new(Vec::new());

pub struct DelegateIvars {
  id: u64,
}

define_class!(
  // SAFETY: NSObject has no subclassing requirements, and PrintDelegate doesn't implement Drop.
  #[unsafe(super(NSObject))]
  #[name = "OpenViewerPrintDelegate"]
  #[ivars = DelegateIvars]
  struct PrintDelegate;

  impl PrintDelegate {
    #[unsafe(method(printOperationDidRun:success:contextInfo:))]
    fn did_run(&self, _operation: &NSPrintOperation, success: Bool, _context: *mut c_void) {
      // WebKit calls this on its printing thread; the next tick on the main thread picks it up.
      let result = if success.as_bool() { Ok(()) } else { Err("The PDF couldn't be created.".into()) };
      COMPLETED.lock().unwrap().push((self.ivars().id, result));
    }
  }

  unsafe impl NSObjectProtocol for PrintDelegate {}
);

impl PrintDelegate {
  fn new(id: u64) -> Retained<Self> {
    let this = Self::alloc().set_ivars(DelegateIvars { id });
    unsafe { msg_send![super(this), init] }
  }
}

// Prints `html` to a PDF at `out` (a path in a private temporary folder).
pub async fn print_to_pdf<R: Runtime>(app: &AppHandle<R>, html: String, out: PathBuf) -> Result<(), String> {
  let (tx, rx) = mpsc::channel();
  let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  let alive = Arc::new(AtomicBool::new(true));
  {
    let (tx, alive) = (tx.clone(), alive.clone());
    app.run_on_main_thread(move || {
      if let Err(e) = begin(id, &html, out, tx.clone(), alive.clone()) {
        alive.store(false, Ordering::SeqCst);
        let _ = tx.send(Err(e));
      }
    }).map_err(|e| e.to_string())?;
  }
  let nudger = app.clone();
  std::thread::spawn(move || {
    while alive.load(Ordering::SeqCst) {
      std::thread::sleep(Duration::from_millis(100));
      if nudger.run_on_main_thread(move || tick(id)).is_err() { break }
    }
  });
  tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(LOAD_TIMEOUT + PRINT_TIMEOUT + Duration::from_secs(10)))
    .await
    .map_err(|e| e.to_string())?
    .map_err(|_| "The PDF export timed out.".to_string())?
}

fn begin(id: u64, html: &str, out: PathBuf, done: Done, alive: Arc<AtomicBool>) -> Result<(), String> {
  let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
  let frame = NSRect::new(NSPoint::new(0.0, 0.0), PAGE);
  unsafe {
    let config = WKWebViewConfiguration::new(mtm);
    config.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
    let prefs = config.defaultWebpagePreferences();
    prefs.setAllowsContentJavaScript(false);
    config.setDefaultWebpagePreferences(Some(&prefs));
    let webview = WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config);
    let window = NSWindow::initWithContentRect_styleMask_backing_defer(
      NSWindow::alloc(mtm), frame, NSWindowStyleMask::Borderless, NSBackingStoreType::Buffered, false,
    );
    window.setReleasedWhenClosed(false);
    window.setContentView(Some(&webview));
    webview.loadHTMLString_baseURL(&NSString::from_str(html), None);
    JOBS.with_borrow_mut(|jobs| {
      jobs.insert(id, Job { webview, window, out, done, alive, started: Instant::now(), printing: None });
    });
  }
  Ok(())
}

fn tick(id: u64) {
  if MainThreadMarker::new().is_none() { return }
  let completed = {
    let mut completed = COMPLETED.lock().unwrap();
    completed.iter().position(|(done, _)| *done == id).map(|i| completed.remove(i).1)
  };
  if let Some(result) = completed { return finish(id, result) }
  // What to do is decided under the borrow; printing happens outside it, because AppKit may call the
  // delegate (and so `finish`) before `runOperationModalForWindow` returns.
  let ready = JOBS.with_borrow(|jobs| {
    let job = jobs.get(&id)?;
    let elapsed = job.started.elapsed();
    if job.printing.is_some() {
      return (elapsed > PRINT_TIMEOUT).then_some(Err(()));
    }
    // DECISION: print once loading ends (images included), or after LOAD_TIMEOUT without the stragglers.
    let loading = unsafe { job.webview.isLoading() };
    if (loading && elapsed < LOAD_TIMEOUT) || elapsed < Duration::from_millis(300) { return None }
    Some(Ok((job.webview.clone(), job.window.clone(), job.out.clone())))
  });
  match ready {
    None => {}
    Some(Err(())) => finish(id, Err("The PDF export timed out.".into())),
    Some(Ok((webview, window, out))) => {
      let delegate = PrintDelegate::new(id);
      JOBS.with_borrow_mut(|jobs| {
        if let Some(job) = jobs.get_mut(&id) {
          job.printing = Some(delegate.clone());
          job.started = Instant::now();
        }
      });
          print(&webview, &window, &out, &delegate);
        }
  }
}

fn print(webview: &WKWebView, window: &NSWindow, out: &std::path::Path, delegate: &PrintDelegate) {
  let url = NSURL::fileURLWithPath(&NSString::from_str(&out.to_string_lossy()));
  unsafe {
    let info = NSPrintInfo::initWithDictionary(NSPrintInfo::alloc(), &NSPrintInfo::sharedPrintInfo().dictionary());
    info.setJobDisposition(NSPrintSaveJob);
    info.dictionary().insert(NSPrintJobSavingURL, &*url);
    info.setTopMargin(54.0);
    info.setBottomMargin(54.0);
    info.setLeftMargin(54.0);
    info.setRightMargin(54.0);
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    let operation = webview.printOperationWithPrintInfo(&info);
    operation.setShowsPrintPanel(false);
    operation.setShowsProgressPanel(false);
    // WebKit's printing view has no size of its own; without one the pages come out blank.
    if let Some(view) = operation.view() { view.setFrame(webview.frame()); }
    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
      window, Some(delegate), Some(sel!(printOperationDidRun:success:contextInfo:)), std::ptr::null_mut(),
    );
  }
}

fn finish(id: u64, result: Result<(), String>) {
  let Some(job) = JOBS.with_borrow_mut(|jobs| jobs.remove(&id)) else { return };
  job.alive.store(false, Ordering::SeqCst);
  job.window.close();
  let _ = job.done.send(result);
}
