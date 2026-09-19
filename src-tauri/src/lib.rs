mod config;
mod db;
mod desktop;
mod gateway;
mod service;
mod updater;

use crate::config::Config;
use crate::gateway::{AppState, serve};
use tokio::runtime::Builder;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if headless_requested() {
        if let Err(error) = run_headless() {
            eprintln!("LLM Gateway headless 启动失败: {error:#}");
            std::process::exit(1);
        }
        return;
    }

    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Err(error) = desktop::show_main(app, false) {
                tracing::warn!(%error, "唤醒已有窗口失败");
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            desktop::get_service_settings,
            desktop::save_service_settings,
            desktop::get_service_status,
            desktop::control_service,
            desktop::force_quit,
            desktop::remote_sync_status,
            desktop::remote_sync_pull,
            updater::get_update_status,
            updater::check_for_updates,
            updater::download_update,
            updater::install_update,
            updater::cancel_update
        ])
        .setup(desktop::setup)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        tracing::warn!(%error, "隐藏窗口失败");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("创建 LLM Gateway Tauri 应用失败")
        .run(desktop::handle_run_event);
}

pub fn run_headless() -> anyhow::Result<()> {
    init_tracing();
    let state = AppState::new(Config::from_env())?;
    let runtime = Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(serve(state))
}

fn headless_requested() -> bool {
    std::env::args()
        .skip(1)
        .any(|argument| argument == "--headless")
        || std::env::var("HEADLESS").ok().is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .try_init();
}
