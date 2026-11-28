use std::{fs, io::Write, path::Path};

use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};

use super::{Boot, Evidence, Run, SavedState, StateHome, one_artifact};

use crate::evidence::process_terminal;

fn rows(boot: &Boot, state: &SavedState) -> Result<Vec<String>> {
    let host = &boot.platform;
    let descriptor = &boot.start.descriptor;
    let session = &boot.pair["browserSession"];
    let mut rows = vec![
        "Sail CLI lifecycle".to_owned(),
        format!(
            "{} / {} ({}) / {} home",
            host.os_version,
            host.arch,
            host.execution,
            boot.home_mode.label()
        ),
        format!("Boot {}", boot.boot_id),
        format!(
            "$ t3 --version  {}",
            boot.version["stdout"]
                .as_str()
                .context("missing CLI stdout")?
        ),
        format!(
            "$ t3 serve  Ready. Protocol {}, database migration {}.",
            descriptor["orchestrationProtocolVersion"], descriptor["databaseMigration"]
        ),
        format!(
            "$ t3 pair  {}, HTTP {}, reuse {}",
            session["cookieCheck"]["scopes"][0]
                .as_str()
                .context("missing CLI pairing scope")?,
            session["status"],
            session["reuseStatus"]
        ),
    ];
    if let StateHome::Copied { thread_read, .. } = &state.home {
        rows.push(format!(
            "$ t3 thread show  {}, {} messages",
            thread_read["threadTitle"]
                .as_str()
                .context("missing saved thread title")?,
            thread_read["messageCount"]
        ));
    }
    rows.push(format!(
        "Ctrl-C: exit {}. Closed listener {}, removed record {}.",
        boot.stop["exitCode"], boot.stop["listenerRefused"], boot.stop["runtimeRecordRemoved"]
    ));
    Ok(rows)
}

fn encode(
    boot: &Boot,
    state: &SavedState,
    transcript_sha: &str,
    state_sha: &str,
) -> Result<Vec<u8>> {
    process_terminal::encode(
        &rows(boot, state)?,
        &[
            ("SailBoot", &boot.boot_id),
            ("SailTranscriptSha256", transcript_sha),
            ("SailStateSha256", state_sha),
        ],
    )
}

pub(crate) fn render_cli_terminal(directory: &Path) -> Result<()> {
    let transcript = fs::read(directory.join("process.json"))?;
    let state_bytes = fs::read(directory.join("state.json"))?;
    let boot: Boot = serde_json::from_slice(&transcript)?;
    let state: SavedState = serde_json::from_slice(&state_bytes)?;
    ensure!(
        state.boot_id == boot.boot_id,
        "CLI process and state belong to different boots"
    );
    let bytes = encode(
        &boot,
        &state,
        &format!("{:x}", Sha256::digest(transcript)),
        &format!("{:x}", Sha256::digest(state_bytes)),
    )?;
    fs::File::create_new(directory.join("terminal.png"))?.write_all(&bytes)?;
    Ok(())
}

pub(super) fn verify_image(
    evidence: &Evidence,
    run: &Run,
    boot: &Boot,
    saved: &SavedState,
) -> Result<()> {
    let transcript = one_artifact(&run.artifacts, "process-transcript")?;
    let state = one_artifact(&run.artifacts, "state-receipt")?;
    let image = one_artifact(&run.artifacts, "terminal-screenshot")?;
    let expected = encode(boot, saved, &transcript.sha256, &state.sha256)?;
    let actual = fs::read(evidence.resolve(&image.path)?)?;
    ensure!(
        actual == expected,
        "terminal PNG does not match the encoded CLI receipts"
    );
    Ok(())
}
