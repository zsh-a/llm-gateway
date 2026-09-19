mod config;
mod db;
mod gateway;

use config::Config;
use gateway::{AppState, serve};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tracing::{error, info};

const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/tray.png");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let config = Config::from_env();
            let state = AppState::new(config.clone())
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
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
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "api" => {
                        let config = Config::from_env();
                        let address = format!("http://{}:{}", config.bind_host, config.port);
                        if let Ok(mut clipboard) = arboard::Clipboard::new() {
                            let _ = clipboard.set_text(address.clone());
                        }
                        let _ = app.emit("gateway-api-address", address);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            info!("Tauri 托盘已启动");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("运行 LLM Gateway Tauri 应用失败");
}
