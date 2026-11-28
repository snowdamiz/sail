use std::{
    fs,
    io::{BufWriter, Cursor},
    path::Path,
};

use anyhow::{Context, Result, ensure};
use font8x8::{BASIC_FONTS, UnicodeFonts};
use sha2::{Digest, Sha256};

use super::{Boot, Evidence, Run, SavedState, StateHome, one_artifact};

const WIDTH: usize = 1024;
const HEIGHT: usize = 318;

fn render(boot: &Boot, state: &SavedState) -> Result<Vec<u8>> {
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
    let mut pixels = vec![0; WIDTH * HEIGHT * 3];
    for pixel in pixels.as_chunks_mut::<3>().0 {
        *pixel = [21, 27, 35];
    }
    for (line, row) in rows.iter().enumerate() {
        ensure!(
            row.is_ascii() && row.len() * 16 + 48 <= WIDTH,
            "CLI terminal line exceeds image width"
        );
        for (column, character) in row.chars().enumerate() {
            let glyph = BASIC_FONTS
                .get(character)
                .context("unsupported CLI terminal character")?;
            for (y, bits) in glyph.into_iter().enumerate() {
                for x in 0..8 {
                    if bits & (1 << x) != 0 {
                        let left = 24 + (column * 8 + x) * 2;
                        let top = 24 + line * 34 + y * 2;
                        let offset = (top * WIDTH + left) * 3;
                        let below = offset + WIDTH * 3;
                        let ink = [220, 229, 237, 220, 229, 237];
                        pixels[offset..offset + 6].copy_from_slice(&ink);
                        pixels[below..below + 6].copy_from_slice(&ink);
                    }
                }
            }
        }
    }
    Ok(pixels)
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
    let pixels = render(&boot, &state)?;
    let file = fs::File::create_new(directory.join("terminal.png"))?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), WIDTH as u32, HEIGHT as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.add_text_chunk("SailBoot".to_owned(), boot.boot_id)?;
    encoder.add_text_chunk(
        "SailTranscriptSha256".to_owned(),
        format!("{:x}", Sha256::digest(transcript)),
    )?;
    encoder.add_text_chunk(
        "SailStateSha256".to_owned(),
        format!("{:x}", Sha256::digest(state_bytes)),
    )?;
    let mut writer = encoder.write_header()?;
    writer.write_image_data(&pixels)?;
    writer.finish()?;
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
    let mut decoder =
        png::Decoder::new(Cursor::new(fs::read(evidence.resolve(&image.path)?)?)).read_info()?;
    let info = decoder.info();
    ensure!(
        info.width == WIDTH as u32
            && info.height == HEIGHT as u32
            && info.color_type == png::ColorType::Rgb
            && info.bit_depth == png::BitDepth::Eight
            && info.animation_control.is_none(),
        "unexpected CLI terminal image geometry"
    );
    for (key, expected) in [
        ("SailBoot", boot.boot_id.as_str()),
        ("SailTranscriptSha256", transcript.sha256.as_str()),
        ("SailStateSha256", state.sha256.as_str()),
    ] {
        let mut values = info
            .uncompressed_latin1_text
            .iter()
            .filter(|value| value.keyword == key);
        ensure!(
            values.next().is_some_and(|value| value.text == expected) && values.next().is_none(),
            "terminal image is not bound to the CLI receipts"
        );
    }
    let mut pixels = vec![0; WIDTH * HEIGHT * 3];
    decoder.next_frame(&mut pixels)?;
    decoder.finish()?;
    ensure!(
        pixels == render(boot, saved)?,
        "terminal image does not render the CLI receipts"
    );
    Ok(())
}
