//! The helper's run, in order: pick the source, open the capture, register (only once the device
//! is open), run the capture loop, then stop with the exit code of EARS-SRC-022.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::backend::{current_platform, list_sources, new_capture};
use crate::cli::Options;
use crate::deliver::Deliverer;
use crate::lifecycle::stop;
use crate::post::HttpSender;
use crate::redis_registry::BusRegistry;
use crate::registration::{Registrar, RegistrationConfig, detail_for};
use crate::session::{Outcome, run_capture};
use crate::source::select_source;

/// The registration is rewritten every 5 s (CONN-DESK-004).
const INTERVAL_MS: u64 = 5_000;
/// Exit status for a source that cannot be chosen or a device that cannot be opened.
const EXIT_USAGE: i32 = 2;
const EXIT_FAILURE: i32 = 1;

fn log(line: &str) {
    eprintln!("cohost-desktop-audio: {line}");
}

/// Runs the helper with `opts` and returns its exit status.
pub fn run(opts: Options) -> i32 {
    for warning in &opts.warnings {
        log(&format!("warning: {warning}"));
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log(&format!("could not start the runtime: {e}"));
            return EXIT_FAILURE;
        }
    };
    runtime.block_on(run_async(opts))
}

async fn wait_for_stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match (
            signal(SignalKind::interrupt()),
            signal(SignalKind::terminate()),
        ) {
            (Ok(mut int), Ok(mut term)) => {
                tokio::select! {
                    _ = int.recv() => {}
                    _ = term.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn run_async(opts: Options) -> i32 {
    let platform = current_platform();
    let sources = match tokio::task::spawn_blocking(list_sources).await {
        Ok(Ok(sources)) => sources,
        Ok(Err(e)) => {
            log(&e);
            return EXIT_FAILURE;
        }
        Err(_) => {
            log("could not list the capture sources");
            return EXIT_FAILURE;
        }
    };
    let choice = match select_source(platform, opts.device.as_deref(), &sources) {
        Ok(choice) => choice,
        Err(e) => {
            log(&e.to_string());
            return EXIT_USAGE;
        }
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let flag = stop_flag.clone();
        tokio::spawn(async move {
            wait_for_stop_signal().await;
            flag.store(true, Ordering::SeqCst);
        });
    }

    let started_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let instance = format!("{}-{started_ms}", std::process::id());
    let registry = BusRegistry::connect(&opts.redis_url, &opts.prefix);
    let sender = Arc::new(HttpSender {
        url: opts.url.clone(),
        token: opts.token.clone(),
    });
    let clip = opts.clip;
    let session_choice = choice.clone();
    let session_stop = stop_flag.clone();

    // The capture is not Send: it is created, opened and read on this blocking thread.
    let joined = tokio::task::spawn_blocking(
        move || -> Result<(Outcome, Deliverer<HttpSender>, Registrar<BusRegistry>), String> {
            let mut capture = new_capture()?;
            let format = capture
                .open(&session_choice)
                .map_err(|e| format!("could not open the capture device: {e}"))?;
            // Registration starts only now: the first registration is written with the device open.
            let cfg = RegistrationConfig::new(
                INTERVAL_MS,
                env!("CARGO_PKG_VERSION"),
                &instance,
                &detail_for(&session_choice),
                started_ms,
            );
            let registrar = Registrar::start(Arc::new(registry), cfg);
            let displaced = registrar.displaced_flag();
            let deliverer = Deliverer::start(sender, |line| log(&line));
            let outcome = run_capture(
                capture.as_mut(),
                &session_choice,
                format,
                clip,
                &deliverer,
                &session_stop,
                &move || displaced.load(Ordering::SeqCst),
                &|line| log(&line),
            );
            Ok((outcome, deliverer, registrar))
        },
    )
    .await;

    let (outcome, deliverer, registrar) = match joined {
        Ok(Ok(parts)) => parts,
        Ok(Err(e)) => {
            log(&e);
            return EXIT_FAILURE;
        }
        Err(_) => {
            log("the capture thread failed");
            return EXIT_FAILURE;
        }
    };
    if let Some(message) = &outcome.message {
        log(message);
    }
    let stopped = stop(deliverer, registrar, outcome.held, outcome.reason).await;
    if let Some(e) = &stopped.delete_error {
        log(e);
    }
    log(&format!(
        "stopped: {} clip(s) dropped undelivered",
        stopped.report.dropped
    ));
    stopped.exit_code
}
