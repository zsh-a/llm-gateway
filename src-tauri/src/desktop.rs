use crate::config::{Config, ServiceSettings};
use crate::gateway::{AppState, RemoteSyncPullResult, RemoteSyncSettings, RemoteSyncStatus};
use crate::service::{GatewayService, ServicePhase, ServiceStatus};
use std::error::Error;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State};
use tracing::{info, warn};

const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/tray.png");
const TRAY_ID: &str = "gateway";

#[derive(Default)]
struct ExitGate {
    requested: AtomicBool,
    ready: AtomicBool,
}

struct TrayItems<R: Runtime> {
    status: MenuItem<R>,
    detail: MenuItem<R>,
    copy: MenuItem<R>,
    toggle: MenuItem<R>,
    restart: MenuItem<R>,
    quit: MenuItem<R>,
    force: MenuItem<R>,
    clipboard: Mutex<Option<arboard::Clipboard>>,
    copy_revision: AtomicU64,
}

#[tauri::command]
pub fn get_service_settings(state: State<'_, AppState>) -> ServiceSettings {
    state.config.service_settings()
}

#[tauri::command]
pub fn save_service_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: ServiceSettings,
) -> Result<(), String> {
    state
        .config
        .save_service_settings(&settings)
        .map_err(|error| error.to_string())?;
    begin_exit(&app, true);
    Ok(())
}

#[tauri::command]
pub async fn remote_sync_status(
    state: State<'_, AppState>,
    settings: RemoteSyncSettings,
) -> Result<RemoteSyncStatus, String> {
    state
        .inner()
        .remote_sync_status(settings)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn remote_sync_pull(
    state: State<'_, AppState>,
    settings: RemoteSyncSettings,
    passphrase: String,
    force: bool,
) -> Result<RemoteSyncPullResult, String> {
    state
        .inner()
        .remote_sync_pull(settings, passphrase, force)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_service_status(service: State<'_, Arc<GatewayService>>) -> ServiceStatus {
    service.snapshot()
}

#[tauri::command]
pub async fn control_service(
    service: State<'_, Arc<GatewayService>>,
    action: String,
) -> Result<(), String> {
    service.control(&action).await
}

#[tauri::command]
pub fn force_quit(app: AppHandle) -> Result<(), String> {
    force_exit(&app)
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>, settings: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        if settings {
            // Fixed, internal navigation only. No untrusted text enters eval.
            window.eval("window.location.hash = '#settings'")?;
        }
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

fn report_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    warn!(%message, "桌面操作失败");
    let _ = app.emit(
        "desktop-notice",
        serde_json::json!({ "message": message, "tone": "error" }),
    );
}

pub fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn Error>> {
    let state = AppState::new(Config::from_env())?;
    let service = Arc::new(GatewayService::new(state.clone()));
    app.manage(state);
    app.manage(service.clone());
    app.manage(ExitGate::default());

    let status = MenuItem::with_id(app, "status", "服务：启动中…", false, None::<&str>)?;
    let detail = MenuItem::with_id(
        app,
        "detail",
        service.snapshot().base_url,
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open", "打开控制台", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "复制 OpenAI Base URL", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "停止服务", false, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", false, None::<&str>)?;
    let force = MenuItem::with_id(app, "force", "强制退出（中断请求）", false, None::<&str>)?;
    let controls = Submenu::with_items(app, "服务操作", true, &[&toggle, &restart, &force])?;
    let quit = MenuItem::with_id(app, "quit", "退出 LLM Gateway", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &detail,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &copy,
            &settings,
            &controls,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(TrayItems {
        status,
        detail,
        copy,
        toggle,
        restart,
        quit,
        force,
        clipboard: Mutex::new(None),
        copy_revision: AtomicU64::new(0),
    });
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(TRAY_ICON)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("LLM Gateway · 启动中")
        .on_menu_event(handle_menu_event);
    #[cfg(target_os = "windows")]
    let builder = builder
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = show_main(tray.app_handle(), false) {
                    report_error(tray.app_handle(), &error.to_string());
                }
            }
        });
    builder.build(app)?;

    let handle = app.handle().clone();
    let mut status_events = service.subscribe();
    let mut activity_events = service.subscribe_activity();
    let observed = service.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                result = status_events.changed() => if result.is_err() { break; },
                result = activity_events.changed() => if result.is_err() { break; },
            }
            let status = observed.snapshot();
            let app = handle.clone();
            if let Err(error) = handle.run_on_main_thread(move || {
                if let Err(error) = update_tray(&app, &status) {
                    warn!(%error, "更新托盘失败");
                }
                let _ = app.emit("gateway-service-status", &status);
                if status.phase == ServicePhase::Failed {
                    if let Err(error) = show_main(&app, true) {
                        report_error(&app, &error.to_string());
                    }
                }
            }) {
                warn!(%error, "调度托盘更新失败");
            }
            // Coalesce bursts; never redraw a native menu for every streamed token.
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        if let Err(error) = service.control("start").await {
            warn!(%error, "启动网关失败");
        }
    });
    if !std::env::args().any(|arg| arg == "--background") {
        show_main(app.handle(), false)?;
    }
    info!("Tauri 托盘已启动");
    Ok(())
}

fn update_tray<R: Runtime>(app: &AppHandle<R>, status: &ServiceStatus) -> tauri::Result<()> {
    let items = app.state::<TrayItems<R>>();
    let exiting = app.state::<ExitGate>().requested.load(Ordering::Acquire);
    let label = match status.phase {
        ServicePhase::Starting => "启动中",
        ServicePhase::Running => "运行中",
        ServicePhase::Stopping => "停止中",
        ServicePhase::Stopped => "已停止",
        ServicePhase::Failed => "启动或运行失败",
    };
    let text = format!("服务：{label} · {} 个请求进行中", status.active_requests);
    items.status.set_text(&text)?;
    let detail = status.error.as_deref().unwrap_or(&status.base_url);
    items
        .detail
        .set_text(detail.chars().take(100).collect::<String>())?;
    items.detail.set_enabled(status.error.is_some())?;
    let idle = matches!(
        status.phase,
        ServicePhase::Running | ServicePhase::Stopped | ServicePhase::Failed
    ) && !exiting;
    items
        .toggle
        .set_text(if status.phase == ServicePhase::Running {
            "停止服务"
        } else {
            "启动服务"
        })?;
    items.toggle.set_enabled(idle)?;
    items
        .restart
        .set_enabled(status.phase == ServicePhase::Running && !exiting)?;
    items.force.set_enabled(status.can_force_exit)?;
    items.quit.set_text(if exiting {
        "正在等待请求结束…"
    } else {
        "退出 LLM Gateway"
    })?;
    items.quit.set_enabled(!exiting)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(format!(
            "LLM Gateway · {label}\n{}\n{} 个请求进行中{}",
            status.base_url,
            status.active_requests,
            if status.can_force_exit {
                "\n等待时间较长，可在服务操作中强制退出"
            } else {
                ""
            }
        )))?;
    }
    Ok(())
}

pub fn begin_exit<R: Runtime>(app: &AppHandle<R>, restart: bool) {
    let gate = app.state::<ExitGate>();
    if gate.requested.swap(true, Ordering::AcqRel) {
        return;
    }
    let service = app.state::<Arc<GatewayService>>().inner().clone();
    let _ = update_tray(app, &service.snapshot());
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        service.shutdown().await;
        handle
            .state::<ExitGate>()
            .ready
            .store(true, Ordering::Release);
        if restart {
            handle.request_restart();
        } else {
            handle.exit(0);
        }
    });
}

fn force_exit<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if !app.state::<Arc<GatewayService>>().snapshot().can_force_exit {
        return Err("尚未到达强制退出等待时间".into());
    }
    warn!("用户选择强制退出，未完成请求将被中断");
    app.state::<ExitGate>().ready.store(true, Ordering::Release);
    app.exit(0);
    Ok(())
}

pub fn handle_run_event<R: Runtime>(app: &AppHandle<R>, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !app.state::<ExitGate>().ready.load(Ordering::Acquire) {
                api.prevent_exit();
                begin_exit(app, false);
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_main(app, false) {
                report_error(app, &error.to_string());
            }
        }
        _ => {}
    }
}

fn copy_address<R: Runtime>(app: &AppHandle<R>) {
    let items = app.state::<TrayItems<R>>();
    let address = format!(
        "{}/v1",
        app.state::<Arc<GatewayService>>().snapshot().base_url
    );
    let result = (|| -> Result<(), String> {
        let mut clipboard = items.clipboard.lock().map_err(|_| "剪贴板不可用")?;
        if clipboard.is_none() {
            *clipboard = Some(arboard::Clipboard::new().map_err(|error| error.to_string())?);
        }
        clipboard
            .as_mut()
            .ok_or("剪贴板不可用")?
            .set_text(address)
            .map_err(|error| error.to_string())
    })();
    let revision = items.copy_revision.fetch_add(1, Ordering::AcqRel) + 1;
    match result {
        Ok(()) => {
            let _ = items.copy.set_text("已复制 Base URL");
        }
        Err(error) => {
            let _ = items.copy.set_text("复制失败，点击重试");
            report_error(app, &format!("复制地址失败：{error}"));
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let items = app.state::<TrayItems<R>>();
            if items.copy_revision.load(Ordering::Acquire) == revision {
                let _ = items.copy.set_text("复制 OpenAI Base URL");
            }
        });
    });
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        "open" | "settings" | "detail" => {
            if let Err(error) = show_main(app, event.id().as_ref() != "open") {
                report_error(app, &error.to_string());
            }
        }
        "copy" => copy_address(app),
        "quit" => begin_exit(app, false),
        "force" => {
            if let Err(error) = force_exit(app) {
                report_error(app, &error);
            }
        }
        "toggle" | "restart" => {
            let service = app.state::<Arc<GatewayService>>().inner().clone();
            let action = if event.id().as_ref() == "restart" {
                "restart"
            } else if service.snapshot().phase == ServicePhase::Running {
                "stop"
            } else {
                "start"
            };
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = service.control(action).await {
                    report_error(&handle, &error);
                }
            });
        }
        _ => {}
    }
}
