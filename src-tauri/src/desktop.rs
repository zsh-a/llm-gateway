use crate::config::{Config, ServiceSettings};
use crate::gateway::{AppState, RemoteSyncPullResult, RemoteSyncSettings, RemoteSyncStatus, serve};
use std::error::Error;
use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State};
use tracing::{error, info};

const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/tray.png");

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
    app.request_restart();
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

pub fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn Error>> {
    let config = Config::from_env();
    let state = AppState::new(config).map_err(|error| Box::<dyn Error>::from(error.to_string()))?;
    let server_state = state.clone();
    app.manage(state);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(server_state).await {
            error!(%error, "Axum 网关退出");
        }
    });

    let open = MenuItem::with_id(app, "open", "打开控制台", true, None::<&str>)?;
    let api = MenuItem::with_id(app, "api", "复制 API 地址", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &api, &quit])?;
    TrayIconBuilder::new()
        .icon(TRAY_ICON)
        .icon_as_template(true)
        .menu(&menu)
        .tooltip("LLM Gateway")
        .on_menu_event(handle_menu_event)
        .build(app)?;
    info!("Tauri 托盘已启动");
    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        "api" => {
            let address = format!("http://{}", app.state::<AppState>().config.bind_address());
            if let Ok(mut clipboard) = arboard::Clipboard::new() {
                let _ = clipboard.set_text(address.clone());
            }
            let _ = app.emit("gateway-api-address", address);
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
