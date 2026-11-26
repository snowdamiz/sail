//! Entry point for `sail-boatd`, the headless Sail Boat sidecar daemon.

use anyhow::Result;
use sail_boat::daemon::{self, DaemonConfig};
use std::io::{IsTerminal, Write};

#[tokio::main]
async fn main() -> Result<()> {
    // Log exclusively to stderr so stdout carries one JSON line: the handshake, or why it failed.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    let running = match start().await {
        Ok(running) => running,
        Err(e) => {
            // The parent shows this reason to every client; stderr can also hold Boat's output.
            print_line(&serde_json::json!({ "ready": false, "error": format!("{e:#}") }).to_string())?;
            return Err(e);
        }
    };
    print_line(&serde_json::to_string(&running.handshake)?)?;

    // A parent that keeps stdin open for its own lifetime sets this, so the daemon exits with it
    // even when the parent dies without stopping it.
    let parent_gone = std::env::var_os("SAIL_BOATD_EXIT_ON_STDIN_EOF")
        .is_some()
        .then(|| daemon::closed(std::io::stdin()));
    wait_for_exit(&running, parent_gone).await;
    running.shutdown().await;
    Ok(())
}

async fn start() -> Result<daemon::RunningDaemon> {
    daemon::start(DaemonConfig::from_env()?).await
}

fn print_line(line: &str) -> Result<()> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}")?;
    out.flush()?;
    Ok(())
}

async fn wait_for_exit(running: &daemon::RunningDaemon, parent_gone: Option<tokio::sync::oneshot::Receiver<()>>) {
    let parent_gone = async {
        match parent_gone {
            Some(closed) => {
                let _ = closed.await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = running.wait_for_shutdown() => {}
            _ = tokio::signal::ctrl_c() => {}
            _ = parent_gone => {}
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
            _ = parent_gone => {}
        }
    }
}
