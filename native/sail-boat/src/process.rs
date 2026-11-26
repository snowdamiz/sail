//! Child processes. On Windows Sail is a windowed app, so each console program the sidecar
//! runs (boat, the `t3` launcher, PowerShell) would open a console window of its own; they start
//! without one.

use std::ffi::OsStr;
use tokio::process::Command;

/// A command for `program`, run without a console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    // The server holds the daemon's stdin open as its liveness signal; a child reading it would wait.
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}
