//! Child processes. On Windows Sail is a windowed app, so each console program the sidecar
//! runs (boat, the `t3` launcher, PowerShell) would open a console window of its own; they start
//! without one.

use std::ffi::OsStr;
use tokio::process::Command;

/// A command for `program`, run without a console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}
