//! File Refragmenter codec: a real baseline/progressive JPEG encoder, a forgiving decoder, and every
//! pixel/coefficient/byte-level damage step. Owned by the codec work stream.

pub mod arith;
pub mod avi;
pub mod bits;
pub mod coeffs;
pub mod color;
pub mod dct;
pub mod decoder;
pub mod encoder;
pub mod exif;
pub mod gif;
pub mod huffman;
pub mod inspect;
pub mod markers;
pub mod pixels;
pub mod profiles;
pub mod render;
pub mod sample;
pub mod step;
pub mod steps;
pub mod tables;

pub use step::{Layer, StepCtx, StepInfo, StepResult};

/// Simple RGBA image used by other crates.
#[derive(Clone, Debug)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Forgiving decode with the default personality (libjpeg) and grey fill.
pub fn decode_rgba(input: &[u8]) -> Result<Image, String> {
    let d = render::decode(input, &render::DecodeOpts::default())?;
    Ok(Image { width: d.width as u32, height: d.height as u32, rgba: d.rgba })
}

/// Baseline encode with standard tables at a libjpeg quality and subsampling.
pub fn encode_rgba(img: &Image, quality: u8, subsampling: &str) -> Vec<u8> {
    let s = encoder::EncodeSettings::standard(quality as i32, subsampling);
    encoder::encode_rgba(img.width as usize, img.height as usize, &img.rgba, &s)
}

/// Encode reusing the tables/subsampling/progression of `like` (fallback: q75 4:2:0).
pub fn encode_like(img: &Image, like: &[u8]) -> Vec<u8> {
    let s = encoder::EncodeSettings::like(like).unwrap_or_else(|| encoder::EncodeSettings::standard(75, "420"));
    encoder::encode_rgba(img.width as usize, img.height as usize, &img.rgba, &s)
}

/// Add or replace the EXIF APP1 so that IFD1 carries `thumb_jpeg` as the embedded thumbnail.
/// The file comes back unchanged when the thumbnail doesn't fit in the 64 KB Exif block.
pub fn with_exif_thumbnail(jpeg: &[u8], thumb_jpeg: &[u8]) -> Vec<u8> {
    exif::with_thumbnail(jpeg, thumb_jpeg).unwrap_or_else(|_| jpeg.to_vec())
}

/// Codec step catalog (all steps implemented in this crate).
pub fn catalog() -> Vec<StepInfo> {
    steps::catalog()
}

/// Run a codec step. Returns None when `id` is not a codec step (the dispatcher then tries the card crate).
pub fn apply_step(id: &str, params: &serde_json::Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    steps::apply(id, params, input, ctx)
}
