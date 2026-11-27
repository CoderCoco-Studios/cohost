//! The desktop audio capture helper: captures the desktop audio and posts clips to ears.

use cohost_desktop_audio::app;
use cohost_desktop_audio::cli::Options;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let redis = std::env::var("REDIS_URL").ok();
    let token = std::env::var("CONTROL_TOKEN").ok();
    let mut env: Vec<(&str, &str)> = Vec::new();
    if let Some(v) = &redis {
        env.push(("REDIS_URL", v.as_str()));
    }
    if let Some(v) = &token {
        env.push(("CONTROL_TOKEN", v.as_str()));
    }
    let opts = match Options::parse(&refs, &env) {
        Ok(opts) => opts,
        Err(e) => {
            eprintln!("cohost-desktop-audio: {e}");
            std::process::exit(2);
        }
    };
    std::process::exit(app::run(opts));
}
