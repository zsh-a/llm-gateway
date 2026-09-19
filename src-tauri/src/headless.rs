fn main() {
    if let Err(error) = llm_gateway_lib::run_headless() {
        eprintln!("LLM Gateway headless 启动失败: {error:#}");
        std::process::exit(1);
    }
}
