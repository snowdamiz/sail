use anyhow::{Context, Result, ensure};
use font8x8::{BASIC_FONTS, UnicodeFonts};

const WIDTH: usize = 1024;
const HEIGHT: usize = 318;

pub(super) fn encode(rows: &[String], chunks: &[(&str, &str)]) -> Result<Vec<u8>> {
    let mut pixels = vec![0; WIDTH * HEIGHT * 3];
    for pixel in pixels.as_chunks_mut::<3>().0 {
        *pixel = [21, 27, 35];
    }
    for (line, row) in rows.iter().enumerate() {
        ensure!(
            row.is_ascii() && row.len() * 16 + 48 <= WIDTH && line * 34 + 42 <= HEIGHT,
            "terminal line exceeds image bounds"
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
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, WIDTH as u32, HEIGHT as u32);
    encoder.set_color(png::ColorType::Rgb);
    for &(key, value) in chunks {
        encoder.add_text_chunk(key.to_owned(), value.to_owned())?;
    }
    let mut writer = encoder.write_header()?;
    writer.write_image_data(&pixels)?;
    writer.finish()?;
    Ok(bytes)
}
