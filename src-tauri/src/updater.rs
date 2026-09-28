use std::{
  collections::{HashMap, HashSet},
  sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{self, Receiver, Sender},
    Mutex,
  },
  time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_updater::UpdaterExt;

use crate::i18n;

const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(20);
const DAILY_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
// DECISION: Let a delayed or unattended close prompt hold installation for up to five minutes.
const CLOSE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const RESEND_INTERVAL: Duration = Duration::from_secs(1);
static UPDATE_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct RuntimeState {
  checking: AtomicBool,
  installing: AtomicBool,
}

struct Approval {
  label: String,
  accepted: bool,
}

struct PendingClose {
  expected: HashSet<String>,
  responded: HashSet<String>,
  sender: Sender<Approval>,
}

#[derive(Default)]
pub struct CloseCoordinator(Mutex<HashMap<String, PendingClose>>);

pub fn is_configured(plugins: &HashMap<String, serde_json::Value>) -> bool {
  plugins.contains_key("updater")
}

fn time_until_check(last_check: Option<Instant>, now: Instant) -> Duration {
  match last_check {
    None => STARTUP_CHECK_DELAY,
    Some(last) => DAILY_CHECK_INTERVAL.saturating_sub(now.saturating_duration_since(last)),
  }
}

pub fn start_daily_checks<R: Runtime>(app: AppHandle<R>) {
  tauri::async_runtime::spawn(async move {
    let mut last_check = None;
    loop {
      // DECISION: The first check is 20 seconds after startup; future automatic checks are 24 hours apart.
      tokio::time::sleep(time_until_check(last_check, Instant::now())).await;
      last_check = Some(Instant::now());
      check_for_updates(app.clone(), false).await;
    }
  });
}

pub fn check_from_menu<R: Runtime>(app: AppHandle<R>) {
  if !is_configured(&app.config().plugins.0) {
    // DECISION: Keep this menu item available in development builds and explain why it cannot check.
    show_message(&app, &i18n::t("updater.notConfigured"), MessageDialogKind::Info);
    return;
  }
  tauri::async_runtime::spawn(check_for_updates(app, true));
}

async fn check_for_updates<R: Runtime>(app: AppHandle<R>, report_no_update: bool) {
  let state = app.state::<RuntimeState>();
  if state.checking.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
    if report_no_update {
      show_message(&app, &i18n::t("updater.inProgress"), MessageDialogKind::Info);
    }
    return;
  }

  let result = async {
    let updater = app.updater().map_err(|error| error.to_string())?;
    // Keep Tauri's default SemVer comparison so newer beta identifiers sort in release order.
    updater.check().await.map_err(|error| error.to_string())
  }.await;
  app.state::<RuntimeState>().checking.store(false, Ordering::Release);

  match result {
    Ok(Some(update)) => prompt_to_install(app, update),
    Ok(None) if report_no_update => show_message(&app, &i18n::t("updater.current"), MessageDialogKind::Info),
    Ok(None) => {}
    Err(error) if report_no_update => show_message(&app, &i18n::t_with("updater.checkFailed", &[("error", &error)]), MessageDialogKind::Error),
    Err(error) => log::info!("automatic update check failed: {error}"),
  }
}

fn prompt_to_install<R: Runtime>(app: AppHandle<R>, update: tauri_plugin_updater::Update) {
  let notes = update.body.as_deref().filter(|body| !body.trim().is_empty())
    .map(str::to_owned).unwrap_or_else(|| i18n::t("updater.noNotes"));
  let version = update.version.to_string();
  let message = i18n::t_with("updater.available", &[("version", &version), ("notes", &notes)]);
  let app_for_dialog = app.clone();
  with_parent(&app, app.dialog().message(message))
    .title(i18n::t("updater.availableTitle"))
    .kind(MessageDialogKind::Info)
    .buttons(MessageDialogButtons::OkCancelCustom(i18n::t("updater.install"), i18n::t("updater.later")))
    .show_with_result(move |result| {
      if result == MessageDialogResult::Custom(i18n::t("updater.install")) {
        let app = app_for_dialog;
        tauri::async_runtime::spawn(async move {
          if app.state::<RuntimeState>().installing.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return;
          }
          let outcome = install_and_relaunch(app.clone(), update).await;
          app.state::<RuntimeState>().installing.store(false, Ordering::Release);
          if let Err(error) = outcome {
            show_message(&app, &i18n::t_with("updater.installFailed", &[("error", &error)]), MessageDialogKind::Error);
          }
        });
      }
    });
}

async fn install_and_relaunch<R: Runtime>(app: AppHandle<R>, update: tauri_plugin_updater::Update) -> Result<(), String> {
  // Windows stay usable during the download; nobody is asked anything until the update is here.
  let bytes = update.download(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
  let mut approved = HashSet::new();
  if let Err(error) = approve_every_window(&app, &mut approved).await {
    let _ = app.emit("update-cancelled", ());
    return error.map_or(Ok(()), Err);
  }
  if let Err(error) = update.install(&bytes) {
    let _ = app.emit("update-cancelled", ());
    return Err(error.to_string());
  }
  // A window opened while installing hasn't been asked yet. The app on disk is already the new one,
  // so declining here only postpones the relaunch.
  match approve_every_window(&app, &mut approved).await {
    Ok(()) => app.restart(),
    // Declined or unanswered, the outcome is the same: the new version starts next time.
    Err(_) => {
      let _ = app.emit("update-cancelled", ());
      show_message(&app, &i18n::t("updater.installedLater"), MessageDialogKind::Info);
      Ok(())
    }
  }
}

// Asks every window not yet in `approved`, round after round, until a round finds no new window. A
// window that approves locks its editor (see shell.ts) until the relaunch or `update-cancelled`, so
// nothing typed after its answer can be lost. Err(None): a window declined; Err(Some): no answer.
async fn approve_every_window<R: Runtime>(app: &AppHandle<R>, approved: &mut HashSet<String>) -> Result<(), Option<String>> {
  loop {
    let pending: HashSet<String> = app.webview_windows().into_keys().filter(|label| !approved.contains(label)).collect();
    if pending.is_empty() {
      return Ok(());
    }
    let (request_id, receiver) = request_close_approval(app, &pending).map_err(Some)?;
    let result = wait_for_approvals(app.clone(), request_id.clone(), receiver, pending.clone()).await;
    app.state::<CloseCoordinator>().0.lock().unwrap().remove(&request_id);
    match result {
      Ok(true) => approved.extend(pending),
      Ok(false) => return Err(None),
      Err(error) => return Err(Some(error)),
    }
  }
}

fn request_close_approval<R: Runtime>(app: &AppHandle<R>, windows: &HashSet<String>) -> Result<(String, Receiver<Approval>), String> {
  let request_id = format!("update-{}", UPDATE_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
  let (sender, receiver) = mpsc::channel();
  app.state::<CloseCoordinator>().0.lock().unwrap().insert(request_id.clone(), PendingClose {
    expected: windows.clone(),
    responded: HashSet::new(),
    sender,
  });
  // Only the windows in this round: one that already answered "Don't Save" must not be asked again.
  for label in windows {
    if let Err(error) = app.emit_to(label.as_str(), "quit-request", request_id.clone()) {
      app.state::<CloseCoordinator>().0.lock().unwrap().remove(&request_id);
      return Err(error.to_string());
    }
  }
  Ok((request_id, receiver))
}

// Once a second, a window that has closed stops being waited for, and the windows that haven't answered
// are asked again: one still loading has no listener yet, and an event sent before it listens is lost
// (shell.ts ignores a repeat of a question it is already answering). The first Cancel ends the round.
async fn wait_for_approvals<R: Runtime>(app: AppHandle<R>, request_id: String, receiver: Receiver<Approval>, mut waiting: HashSet<String>) -> Result<bool, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let deadline = Instant::now() + CLOSE_RESPONSE_TIMEOUT;
    while !waiting.is_empty() {
      let remaining = deadline.saturating_duration_since(Instant::now());
      if remaining.is_zero() {
        return Err(i18n::t("updater.notEveryWindow"));
      }
      match receiver.recv_timeout(remaining.min(RESEND_INTERVAL)) {
        Ok(approval) if !approval.accepted => return Ok(false),
        Ok(approval) => { waiting.remove(&approval.label); }
        Err(mpsc::RecvTimeoutError::Timeout) => {
          let open = app.webview_windows();
          waiting.retain(|label| open.contains_key(label));
          for label in &waiting {
            let _ = app.emit_to(label.as_str(), "quit-request", request_id.clone());
          }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => return Err(i18n::t("updater.interrupted")),
      }
    }
    Ok(true)
  }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn update_quit_response<R: Runtime>(
  window: tauri::Window<R>,
  coordinator: State<'_, CloseCoordinator>,
  request_id: String,
  accepted: bool,
) -> Result<(), String> {
  let mut pending = coordinator.0.lock().unwrap();
  let request = pending.get_mut(&request_id).ok_or_else(|| i18n::t("updater.requestInactive"))?;
  let label = window.label().to_string();
  if !request.expected.contains(&label) {
    return Err(i18n::t("updater.notExpected"));
  }
  if !request.responded.insert(label.clone()) {
    return Err(i18n::t("updater.alreadyResponded"));
  }
  request.sender.send(Approval { label, accepted }).map_err(|error| error.to_string())?;
  Ok(())
}

fn show_message<R: Runtime>(app: &AppHandle<R>, message: &str, kind: MessageDialogKind) {
  with_parent(app, app.dialog().message(message)).title(i18n::t("updater.title")).kind(kind)
    .buttons(MessageDialogButtons::Ok).show(|_| {});
}

// Without a parent, the dialog plugin (rfd) shows a system alert drawn by UserNotificationCenter: it
// floats over other apps, and it outlives the app, so quitting with one open leaves it on screen with
// buttons that do nothing (hand test: they piled up). On a document window (the focused one, else a
// visible one) it is a sheet there, and it goes when the window does.
fn with_parent<R: Runtime>(app: &AppHandle<R>, dialog: tauri_plugin_dialog::MessageDialogBuilder<R>) -> tauri_plugin_dialog::MessageDialogBuilder<R> {
  let windows = app.webview_windows();
  let document = |label: &str| label == "main" || label.starts_with("document-");
  let parent = windows.iter().find(|(label, w)| document(label) && w.is_focused().unwrap_or(false))
    .or_else(|| windows.iter().find(|(label, w)| document(label) && w.is_visible().unwrap_or(false)))
    .map(|(_, w)| w.clone());
  match parent {
    Some(window) => dialog.parent(&window),
    None => dialog,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn app_with_windows(labels: &[&str]) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
      .manage(CloseCoordinator::default())
      .build(tauri::test::mock_context(tauri::test::noop_assets()))
      .unwrap();
    for label in labels {
      tauri::WebviewWindowBuilder::new(&app, *label, tauri::WebviewUrl::default()).build().unwrap();
    }
    app
  }

  // Stands in for the windows: answers `count` requests as they appear, recording who was asked.
  // `before` runs once, when the first request is seen and before it is answered.
  fn answer<R: Runtime>(app: AppHandle<R>, accepted: bool, count: usize, before: impl FnOnce(&AppHandle<R>) + Send + 'static) -> std::thread::JoinHandle<Vec<Vec<String>>> {
    std::thread::spawn(move || {
      let mut rounds: Vec<Vec<String>> = Vec::new();
      let mut before = Some(before);
      let mut answered = HashSet::new();
      let deadline = Instant::now() + Duration::from_secs(10);
      while rounds.len() < count && Instant::now() < deadline {
        let request = {
          let coordinator = app.state::<CloseCoordinator>();
          let pending = coordinator.0.lock().unwrap();
          pending.iter().find(|(id, _)| !answered.contains(*id))
            .map(|(id, request)| (id.clone(), request.expected.clone(), request.sender.clone()))
        };
        let Some((id, expected, sender)) = request else {
          std::thread::sleep(Duration::from_millis(5));
          continue;
        };
        if let Some(hook) = before.take() { hook(&app); }
        let mut labels: Vec<String> = expected.into_iter().collect();
        labels.sort();
        for label in &labels { let _ = sender.send(Approval { label: label.clone(), accepted }); }
        rounds.push(labels);
        answered.insert(id);
      }
      rounds
    })
  }

  #[test]
  fn asks_windows_opened_during_a_round_before_relaunching() {
    let app = app_with_windows(&["document-1", "document-2"]);
    let responder = answer(app.handle().clone(), true, 2, |app| {
      tauri::WebviewWindowBuilder::new(app, "document-3", tauri::WebviewUrl::default()).build().unwrap();
    });
    let mut approved = HashSet::new();
    let result = tauri::async_runtime::block_on(approve_every_window(app.handle(), &mut approved));
    assert!(result.is_ok());
    let rounds = responder.join().unwrap();
    // The second round asks only the new window: the others may already have said "Don't Save".
    assert_eq!(rounds, vec![vec!["document-1".to_string(), "document-2".to_string()], vec!["document-3".to_string()]]);
    assert_eq!(approved.len(), 3);
    assert!(app.state::<CloseCoordinator>().0.lock().unwrap().is_empty());
  }

  // Answers as `answer_for` says (None: never), once per window, for the first request only.
  fn answer_each<R: Runtime>(app: AppHandle<R>, answer_for: impl Fn(&str) -> Option<bool> + Send + 'static, after_first: impl FnOnce(&AppHandle<R>) + Send + 'static) {
    std::thread::spawn(move || {
      let deadline = Instant::now() + Duration::from_secs(10);
      let request = loop {
        if Instant::now() > deadline { return; }
        let found = {
          let coordinator = app.state::<CloseCoordinator>();
          let pending = coordinator.0.lock().unwrap();
          pending.values().next().map(|request| (request.expected.clone(), request.sender.clone()))
        };
        if let Some(found) = found { break found; }
        std::thread::sleep(Duration::from_millis(5));
      };
      let (expected, sender) = request;
      let mut labels: Vec<String> = expected.into_iter().collect();
      labels.sort();
      for label in labels {
        if let Some(accepted) = answer_for(&label) { let _ = sender.send(Approval { label, accepted }); }
      }
      after_first(&app);
    });
  }

  #[test]
  fn the_first_cancel_ends_the_round_without_waiting_for_the_rest() {
    let app = app_with_windows(&["document-1", "document-2"]);
    answer_each(app.handle().clone(), |label| (label == "document-1").then_some(false), |_| {});
    let started = Instant::now();
    let result = tauri::async_runtime::block_on(approve_every_window(app.handle(), &mut HashSet::new()));
    assert!(matches!(result, Err(None)));
    assert!(started.elapsed() < Duration::from_secs(5), "waited for the window that never answered");
  }

  // A window still loading misses the first ask (an event sent before its listener exists is lost), so
  // the question goes again every second until it answers. (A window that closes is dropped from the
  // wait on the same tick; the mock runtime keeps destroyed windows listed, so that part isn't tested.)
  #[test]
  fn a_window_that_has_not_answered_is_asked_again() {
    use tauri::Listener;
    let app = app_with_windows(&["document-1"]);
    let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = asked.clone();
    app.listen_any("quit-request", move |_| { counter.fetch_add(1, Ordering::SeqCst); });
    let handle = app.handle().clone();
    let seen = asked.clone();
    std::thread::spawn(move || {
      let deadline = Instant::now() + Duration::from_secs(10);
      while seen.load(Ordering::SeqCst) < 3 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
      let coordinator = handle.state::<CloseCoordinator>();
      let pending = coordinator.0.lock().unwrap();
      if let Some(request) = pending.values().next() {
        let _ = request.sender.send(Approval { label: "document-1".into(), accepted: true });
      }
    });
    let result = tauri::async_runtime::block_on(approve_every_window(app.handle(), &mut HashSet::new()));
    assert!(result.is_ok(), "{result:?}");
    assert!(asked.load(Ordering::SeqCst) >= 3, "asked {} times", asked.load(Ordering::SeqCst));
  }

  #[test]
  fn a_declined_round_stops_without_asking_again() {
    let app = app_with_windows(&["document-1"]);
    let responder = answer(app.handle().clone(), false, 1, |_| {});
    let mut approved = HashSet::new();
    let result = tauri::async_runtime::block_on(approve_every_window(app.handle(), &mut approved));
    assert!(matches!(result, Err(None)));
    assert_eq!(responder.join().unwrap(), vec![vec!["document-1".to_string()]]);
    assert!(approved.is_empty());
  }

  #[test]
  fn detects_release_updater_configuration_only() {
    let mut plugins = HashMap::new();
    assert!(!is_configured(&plugins));
    plugins.insert("dialog".into(), serde_json::json!({}));
    assert!(!is_configured(&plugins));
    plugins.insert("updater".into(), serde_json::json!({
      "pubkey": "test-public-key",
      "endpoints": ["https://example.invalid/latest.json"]
    }));
    assert!(is_configured(&plugins));
  }

  #[test]
  fn schedules_the_first_check_after_startup_and_then_daily() {
    let now = Instant::now();
    assert_eq!(time_until_check(None, now), Duration::from_secs(20));
    assert_eq!(time_until_check(Some(now), now), Duration::from_secs(24 * 60 * 60));
    assert_eq!(time_until_check(Some(now), now + Duration::from_secs(30)), Duration::from_secs(24 * 60 * 60 - 30));
    assert_eq!(time_until_check(Some(now), now + DAILY_CHECK_INTERVAL), Duration::ZERO);
  }
}
