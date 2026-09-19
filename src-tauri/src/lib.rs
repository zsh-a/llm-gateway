mod config;
mod db;
mod desktop;
mod gateway;

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
        .setup(desktop::setup)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("运行 LLM Gateway Tauri 应用失败");
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
