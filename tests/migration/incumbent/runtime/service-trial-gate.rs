use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::process::Command;

fn main() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let first = args.next();
    let published = env::current_exe()?.with_file_name("t3.published");
    let mut command = Command::new(published);
    command.args(first.iter()).args(args);

    if first.as_deref().is_some_and(|argument| argument == "serve") {
        let context = env::var("T3_SERVICE_LAUNCHER_CONTEXT")
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        fs::write("/probe/trial-context.pending", context)?;
        fs::rename("/probe/trial-context.pending", "/probe/trial-context.json")?;

        let mut signal = [0];
        File::open("/tmp/sail-trial-release")?.read_exact(&mut signal)?;
        if signal != *b"x" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid trial release signal",
            ));
        }
        command.env("T3CODE_HOST", "192.0.2.1");
    }

    Err(command.exec())
}
