// #region main
#[tokio::main]
async fn main() {
    let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let stop = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    if let Err(err) = cohost_example_bus::run(&url, "cohost", stop, std::io::stdout()).await {
        eprintln!("rust-example: {err}");
        std::process::exit(1);
    }
}
// #endregion main
