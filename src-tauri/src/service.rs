//! Desktop service lifecycle, independent of tray and webview availability.
use crate::gateway::{AppState, serve_listener};
use futures_util::FutureExt;
use serde::Serialize;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, watch};
use tokio::task::JoinHandle;
use tracing::{error, info};

const DRAIN_WARNING_AFTER: Duration = Duration::from_secs(15);

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServicePhase {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub phase: ServicePhase,
    pub base_url: String,
    pub active_requests: usize,
    pub error: Option<String>,
    pub can_force_exit: bool,
}

struct RunningService {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

pub struct GatewayService {
    state: AppState,
    running: Mutex<Option<RunningService>>,
    status: watch::Sender<ServiceStatus>,
    exiting: AtomicBool,
    drain_warning_after: Duration,
}

impl GatewayService {
    pub fn new(state: AppState) -> Self {
        state.activity.set_accepting(false);
        let status = ServiceStatus {
            phase: ServicePhase::Stopped,
            base_url: state.config.service_settings().base_url(),
            active_requests: 0,
            error: None,
            can_force_exit: false,
        };
        Self {
            state,
            running: Mutex::new(None),
            status: watch::channel(status).0,
            exiting: AtomicBool::new(false),
            drain_warning_after: DRAIN_WARNING_AFTER,
        }
    }

    pub fn snapshot(&self) -> ServiceStatus {
        let mut status = self.status.borrow().clone();
        status.active_requests = self.state.activity.count();
        status
    }

    pub fn subscribe(&self) -> watch::Receiver<ServiceStatus> {
        self.status.subscribe()
    }

    pub fn subscribe_activity(&self) -> watch::Receiver<usize> {
        self.state.activity.subscribe()
    }

    fn update(&self, phase: ServicePhase, error: Option<String>) {
        self.status.send_modify(|status| {
            status.phase = phase;
            status.error = error;
            status.can_force_exit = false;
        });
    }

    async fn start_locked(&self, running: &mut Option<RunningService>) -> Result<(), String> {
        if self.exiting.load(Ordering::Acquire) {
            return Err("应用正在退出".into());
        }
        if running
            .as_ref()
            .is_some_and(|server| !server.task.is_finished())
        {
            return if self.snapshot().phase == ServicePhase::Stopping {
                Err("服务仍在等待请求结束，请稍后再启动".into())
            } else {
                Ok(())
            };
        }
        // Reap the previous completed task before starting a replacement.
        if let Some(previous) = running.take() {
            let _ = previous.task.await;
        }
        self.update(ServicePhase::Starting, None);
        let address = self.state.config.bind_address();
        let listener = match TcpListener::bind(&address).await {
            Ok(listener) => listener,
            Err(error) => {
                let message = format!("无法监听 {address}：{error}");
                self.update(ServicePhase::Failed, Some(message.clone()));
                return Err(message);
            }
        };
        let mut settings = self.state.config.service_settings();
        if self.exiting.load(Ordering::Acquire) {
            self.update(ServicePhase::Stopped, None);
            return Err("应用正在退出".into());
        }
        if let Ok(address) = listener.local_addr() {
            settings.port = address.port();
        }
        self.status
            .send_modify(|status| status.base_url = settings.base_url());
        let (shutdown, mut receiver) = watch::channel(false);
        let state = self.state.clone();
        let status = self.status.clone();
        state.activity.set_accepting(true);
        self.update(ServicePhase::Running, None);
        let task = tokio::spawn(async move {
            let result = AssertUnwindSafe(serve_listener(state.clone(), listener, async move {
                let _ = receiver.wait_for(|stop| *stop).await;
            }))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("网关任务异常终止")));
            state.activity.set_accepting(false);
            status.send_modify(|status| {
                status.can_force_exit = false;
                match &result {
                    Ok(()) => status.phase = ServicePhase::Stopped,
                    Err(error) => {
                        status.phase = ServicePhase::Failed;
                        status.error = Some(format!("网关服务异常退出：{error}"));
                    }
                }
            });
            if let Err(error) = result {
                error!(%error, "网关服务异常退出");
            }
        });
        *running = Some(RunningService { shutdown, task });
        info!(%address, "网关服务已启动");
        Ok(())
    }

    async fn stop_locked(&self, running: &mut Option<RunningService>) {
        let Some(server) = running.as_mut() else {
            self.update(ServicePhase::Stopped, None);
            return;
        };
        self.state.activity.set_accepting(false);
        self.update(ServicePhase::Stopping, None);
        server.shutdown.send_replace(true);
        let result = match tokio::time::timeout(self.drain_warning_after, &mut server.task).await {
            Ok(result) => result,
            Err(_) => {
                // Never silently kill a stream. The UI now offers an explicit force-exit action.
                self.status
                    .send_modify(|status| status.can_force_exit = true);
                (&mut server.task).await
            }
        };
        if let Err(error) = result {
            self.update(ServicePhase::Failed, Some(format!("网关任务异常：{error}")));
        } else if self.snapshot().phase != ServicePhase::Failed {
            self.update(ServicePhase::Stopped, None);
        }
        *running = None;
    }

    pub async fn control(&self, action: &str) -> Result<(), String> {
        if self.exiting.load(Ordering::Acquire) {
            return Err("应用正在退出".into());
        }
        let mut running = self
            .running
            .try_lock()
            .map_err(|_| "服务正在处理上一项操作")?;
        match action {
            "start" => self.start_locked(&mut running).await,
            "stop" => {
                self.stop_locked(&mut running).await;
                Ok(())
            }
            "restart" => {
                self.stop_locked(&mut running).await;
                self.start_locked(&mut running).await
            }
            _ => Err("未知的服务操作".into()),
        }
    }

    pub async fn shutdown(&self) {
        self.exiting.store(true, Ordering::Release);
        self.state.activity.close();
        let mut running = self.running.lock().await;
        self.stop_locked(&mut running).await;
    }
}
