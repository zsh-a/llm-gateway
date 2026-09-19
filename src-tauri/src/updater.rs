//! Desktop-only updates. The backend owns downloads and installation so closing
//! the webview never cancels a task or bypasses the gateway's drain barrier.
use crate::desktop;
use crate::service::GatewayService;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{Mutex as AsyncMutex, watch};

const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Draining,
    Stopping,
    Installing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub last_checked: Option<u64>,
    pub error: Option<String>,
}

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    bytes: Option<Arc<Vec<u8>>>,
}

pub struct UpdateManager {
    status: watch::Sender<UpdateStatus>,
    pending: Mutex<PendingUpdate>,
    operation: AsyncMutex<()>,
    cancel: watch::Sender<bool>,
}

impl UpdateManager {
    fn new(version: String) -> Self {
        Self {
            status: watch::channel(UpdateStatus {
                phase: UpdatePhase::Idle,
                current_version: version,
                version: None,
                notes: None,
                downloaded_bytes: 0,
                total_bytes: None,
                last_checked: None,
                error: None,
            })
            .0,
            pending: Mutex::new(PendingUpdate::default()),
            operation: AsyncMutex::new(()),
            cancel: watch::channel(false).0,
        }
    }

    pub fn snapshot(&self) -> UpdateStatus {
        self.status.borrow().clone()
    }

    fn phase(&self, phase: UpdatePhase, error: Option<String>) {
        self.status.send_modify(|status| {
            status.phase = phase;
            status.error = error;
        });
    }

    pub fn cancel(&self) -> Result<(), String> {
        // Serialize cancellation with the transition to Installing.
        let mut accepted = false;
        self.status.send_modify(|status| {
            if matches!(
                status.phase,
                UpdatePhase::Downloading | UpdatePhase::Draining
            ) {
                self.cancel.send_replace(true);
                accepted = true;
            }
        });
        if accepted {
            Ok(())
        } else {
            Err("当前更新操作无法取消".into())
        }
    }

    async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "正在处理更新，请稍候")?;
        if app.state::<Arc<GatewayService>>().is_exiting() {
            return Err("应用正在退出".into());
        }
        // Keep a verified download available until the user installs or exits.
        if self.snapshot().phase == UpdatePhase::Ready {
            return Ok(());
        }
        let previous = self.snapshot().phase;
        self.phase(UpdatePhase::Checking, None);
        let result = async {
            let updater = app
                .updater_builder()
                // The default Windows hook destroys windows/trays *before*
                // launching the installer, making launch failures unrecoverable.
                // We already drain the gateway; OS process exit frees resources.
                .on_before_exit(|| {})
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|error| error.to_string())?;
            updater.check().await.map_err(|error| error.to_string())
        }
        .await;
        match result {
            Ok(update) => {
                self.status.send_modify(|status| {
                    status.phase = if update.is_some() {
                        UpdatePhase::Available
                    } else {
                        UpdatePhase::UpToDate
                    };
                    status.version = update.as_ref().map(|value| value.version.clone());
                    status.notes = update.as_ref().and_then(|value| value.body.clone());
                    status.downloaded_bytes = 0;
                    status.total_bytes = None;
                    status.last_checked = Some(now_ms());
                    status.error = None;
                });
                *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = PendingUpdate {
                    update,
                    bytes: None,
                };
                Ok(())
            }
            Err(error) => {
                let message = format!("检查更新失败，请检查网络后重试：{error}");
                self.phase(previous, Some(message.clone()));
                Err(message)
            }
        }
    }

    async fn download(&self) -> Result<(), String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "正在处理更新，请稍候")?;
        if self.snapshot().phase != UpdatePhase::Available {
            return Err("请先检查并选择可用更新".into());
        }
        let mut update = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .update
            .clone()
            .ok_or("没有可下载的更新")?;
        // Checking should be quick, while a package download may take longer.
        update.timeout = Some(Duration::from_secs(15 * 60));
        self.cancel.send_replace(false);
        let mut cancel = self.cancel.subscribe();
        self.status.send_modify(|status| {
            status.phase = UpdatePhase::Downloading;
            status.error = None;
            status.downloaded_bytes = 0;
            status.total_bytes = None;
        });
        let result = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => None,
            result = update.download(|chunk, total| {
                self.status.send_modify(|status| {
                    status.downloaded_bytes = status.downloaded_bytes.saturating_add(chunk as u64);
                    status.total_bytes = total;
                });
            }, || {}) => Some(result),
        };
        match result {
            Some(Ok(bytes)) => {
                self.pending.lock().unwrap_or_else(|e| e.into_inner()).bytes =
                    Some(Arc::new(bytes));
                self.phase(UpdatePhase::Ready, None);
                Ok(())
            }
            Some(Err(error)) => {
                let message = format!("下载或签名验证失败，当前版本可继续使用：{error}");
                self.phase(UpdatePhase::Available, Some(message.clone()));
                Err(message)
            }
            None => {
                self.phase(UpdatePhase::Available, None);
                Ok(())
            }
        }
    }

    async fn install<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "正在处理更新，请稍候")?;
        if self.snapshot().phase != UpdatePhase::Ready {
            return Err("更新包尚未下载并验证完成".into());
        }
        let (update, bytes) = {
            let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            (
                pending.update.clone().ok_or("没有可安装的更新")?,
                pending.bytes.clone().ok_or("请先下载更新")?,
            )
        };
        let service = app.state::<Arc<GatewayService>>();
        let mut session = service.begin_update()?;
        self.cancel.send_replace(false);
        let mut cancel = self.cancel.subscribe();
        self.phase(UpdatePhase::Draining, None);
        if !session
            .drain(&mut cancel, || {
                let mut proceed = false;
                self.status.send_modify(|status| {
                    if !*self.cancel.borrow() {
                        status.phase = UpdatePhase::Stopping;
                        proceed = true;
                    }
                });
                proceed
            })
            .await
        {
            let result = session.restore().await;
            self.phase(UpdatePhase::Ready, result.as_ref().err().cloned());
            return result;
        }

        // The exit gate prevents normal quit/restart racing the installer. A
        // cancellation which arrived before this transition wins.
        let mut reserved = false;
        self.status.send_modify(|status| {
            if !*cancel.borrow() && desktop::reserve_update_install(app) {
                status.phase = UpdatePhase::Installing;
                reserved = true;
            }
        });
        if !reserved {
            let result = session.restore().await;
            self.phase(UpdatePhase::Ready, result.as_ref().err().cloned());
            return result;
        }

        let runtime_dir = app
            .state::<crate::gateway::AppState>()
            .config
            .runtime_dir
            .clone();
        let result = async {
            save_restart_state(&runtime_dir, &update.version, session.was_running())?;
            tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice()))
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result.map_err(|error| error.to_string()))
        }
        .await;
        match result {
            Ok(()) => {
                // Windows exits inside install(); macOS reaches this branch.
                desktop::restart_after_update(app);
                Ok(())
            }
            Err(error) => {
                let _ = std::fs::remove_file(runtime_dir.join(RESTART_STATE_FILE));
                desktop::release_update_install(app);
                let recovery = session.restore().await;
                let mut message = format!("安装更新失败：{error}");
                if let Err(error) = recovery {
                    message.push_str(&format!("。恢复网关失败，请手动启动服务：{error}"));
                }
                self.phase(UpdatePhase::Ready, Some(message.clone()));
                Err(message)
            }
        }
    }
}

const RESTART_STATE_FILE: &str = "update-restart.json";

#[derive(Serialize, Deserialize)]
struct RestartState {
    version: String,
    running: bool,
}

fn save_restart_state(directory: &Path, version: &str, running: bool) -> Result<(), String> {
    let path = directory.join(RESTART_STATE_FILE);
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(&RestartState {
        version: version.into(),
        running,
    })
    .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes)
        .and_then(|_| std::fs::rename(&temporary, &path))
        .map_err(|error| format!("无法保存更新后的服务状态：{error}"))
}

/// Consume only a marker for this exact newly installed version. An old app
/// launched after a failed installer must not pretend the update succeeded.
pub fn take_restart_state(directory: &Path, version: &str) -> Option<bool> {
    let path = directory.join(RESTART_STATE_FILE);
    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let state: RestartState = serde_json::from_slice(&bytes).ok()?;
    (state.version == version).then_some(state.running)
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    let _ = receiver.wait_for(|cancel| *cancel).await;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let manager = Arc::new(UpdateManager::new(app.package_info().version.to_string()));
    app.manage(manager.clone());
    let mut changes = manager.status.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while changes.changed().await.is_ok() {
            let status = changes.borrow_and_update().clone();
            let _ = handle.emit("app-update-status", status);
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    // Dev builds must never replace an installed application.
    if !cfg!(debug_assertions) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            loop {
                let result = if matches!(
                    manager.snapshot().phase,
                    UpdatePhase::Idle | UpdatePhase::UpToDate | UpdatePhase::Available
                ) {
                    manager.check(&handle).await
                } else {
                    Ok(())
                };
                tokio::time::sleep(if result.is_err() {
                    RETRY_INTERVAL
                } else {
                    CHECK_INTERVAL
                })
                .await;
            }
        });
    }
}

pub fn check_from_tray<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let manager = handle.state::<Arc<UpdateManager>>();
        let _ = manager.check(&handle).await;
    });
}

#[tauri::command]
pub fn get_update_status(manager: State<'_, Arc<UpdateManager>>) -> UpdateStatus {
    manager.snapshot()
}

// Spawn owned tasks: canceling an IPC call or destroying the window must never
// drop the service reservation halfway through an update.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn(async move { app.state::<Arc<UpdateManager>>().check(&app).await })
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn(async move { app.state::<Arc<UpdateManager>>().download().await })
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("开发模式不安装更新，请使用已安装的正式版测试升级".into());
    }
    tauri::async_runtime::spawn(
        async move { app.state::<Arc<UpdateManager>>().install(&app).await },
    )
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_update(manager: State<'_, Arc<UpdateManager>>) -> Result<(), String> {
    manager.cancel()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_version_restores_service_state_exactly_once() {
        let directory = tempfile::tempdir().unwrap();
        for running in [true, false] {
            save_restart_state(directory.path(), "1.2.3", running).unwrap();
            assert_eq!(take_restart_state(directory.path(), "1.2.3"), Some(running));
            assert_eq!(take_restart_state(directory.path(), "1.2.3"), None);
        }
    }

    #[test]
    fn failed_install_and_corrupt_markers_do_not_change_old_version_startup() {
        let directory = tempfile::tempdir().unwrap();
        save_restart_state(directory.path(), "1.2.4", false).unwrap();
        assert_eq!(take_restart_state(directory.path(), "1.2.3"), None);
        assert_eq!(take_restart_state(directory.path(), "1.2.4"), None);
        std::fs::write(directory.path().join(RESTART_STATE_FILE), "invalid").unwrap();
        assert_eq!(take_restart_state(directory.path(), "1.2.3"), None);
    }
}
