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
  app.dialog()
    .message(message)
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
  // DECISION: Resolve all unsaved prompts before downloading, and leave windows open until install succeeds.
  let (request_id, receiver, expected_count) = request_close_approval(&app).await?;
  let approval_result = wait_for_approvals(receiver, expected_count).await;
  app.state::<CloseCoordinator>().0.lock().unwrap().remove(&request_id);
  if !approval_result? {
    return Ok(());
  }

  update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
  // app.restart() closes the windows after all prompts have approved and the update is installed.
  app.restart();
}

async fn request_close_approval<R: Runtime>(app: &AppHandle<R>) -> Result<(String, Receiver<Approval>, usize), String> {
  let expected: HashSet<String> = app.webview_windows().keys().cloned().collect();
  let expected_count = expected.len();
  let request_id = format!("update-{}", UPDATE_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
  let (sender, receiver) = mpsc::channel();
  if !expected.is_empty() {
    app.state::<CloseCoordinator>().0.lock().unwrap().insert(request_id.clone(), PendingClose {
      expected,
      responded: HashSet::new(),
      sender,
    });
  }
  if let Err(error) = app.emit("quit-request", request_id.clone()) {
    app.state::<CloseCoordinator>().0.lock().unwrap().remove(&request_id);
    return Err(error.to_string());
  }
  Ok((request_id, receiver, expected_count))
}

async fn wait_for_approvals(receiver: Receiver<Approval>, expected_count: usize) -> Result<bool, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let deadline = Instant::now() + CLOSE_RESPONSE_TIMEOUT;
    let mut seen = HashSet::new();
    let mut all_accepted = true;
    while seen.len() < expected_count {
      let remaining = deadline.saturating_duration_since(Instant::now());
      if remaining.is_zero() {
        return Err(i18n::t("updater.notEveryWindow"));
      }
      match receiver.recv_timeout(remaining) {
        Ok(approval) => {
          if seen.insert(approval.label) { all_accepted &= approval.accepted; }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => return Err(i18n::t("updater.notEveryWindow")),
        Err(mpsc::RecvTimeoutError::Disconnected) => return Err(i18n::t("updater.interrupted")),
      }
    }
    Ok(all_accepted)
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
  app.dialog().message(message).title(i18n::t("updater.title")).kind(kind)
    .buttons(MessageDialogButtons::Ok).show(|_| {});
}

#[cfg(test)]
mod tests {
  use super::*;

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
