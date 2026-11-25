//! Entry point for `sail-boatd`, the headless Sail Boat sidecar daemon.

use anyhow::Result;
use sail_boat::daemon::{self, DaemonConfig};
use std::io::Write;

#[tokio::main]
async fn main() -> Result<()> {
    // Log exclusively to stderr so stdout only ever emits the JSON readiness handshake.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    let config = DaemonConfig::from_env()?;
    let running = daemon::start(config).await?;

    let line = serde_json::to_string(&running.handshake)?;
    {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{line}")?;
        out.flush()?;
    }

    wait_for_exit(&running).await;
    running.shutdown().await;
    Ok(())
}

async fn wait_for_exit(running: &daemon::RunningDaemon) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = running.wait_for_shutdown() => {}
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(ref mut s) = sigterm {
                    s.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = running.wait_for_shutdown() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
}
