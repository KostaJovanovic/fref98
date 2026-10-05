//! Every codec step: catalog entries (with Foldy's help text) and implementations. Each group
//! module exposes `infos()` and `apply()`; helpers here do the decode / re-encode plumbing.

use crate::coeffs::CoeffImage;
use crate::decoder::parse;
use crate::encoder::{self, EncodeSettings};
use crate::markers::walk;
use crate::pixels::Rgba;
use crate::profiles;
use crate::render;
use crate::step::*;
use serde_json::Value;

mod bytes;
mod chroma;
mod colour;
mod displace;
mod generation;
mod header;
mod metadata;
mod progressive;
mod quantise;
mod recovery;
mod sensor;
mod transfer;

type Apply = fn(&str, &Value, &[u8], &StepCtx) -> Option<StepResult>;
type Infos = fn() -> Vec<StepInfo>;

const GROUPS: [(Infos, Apply); 12] = [
    (quantise::infos, quantise::apply),
    (colour::infos, colour::apply),
    (chroma::infos, chroma::apply),
    (generation::infos, generation::apply),
    (progressive::infos, progressive::apply),
    (bytes::infos, bytes::apply),
    (header::infos, header::apply),
    (transfer::infos, transfer::apply),
    (recovery::infos, recovery::apply),
    (displace::infos, displace::apply),
    (metadata::infos, metadata::apply),
    (sensor::infos, sensor::apply),
];

pub fn catalog() -> Vec<StepInfo> {
    GROUPS.iter().flat_map(|(i, _)| i()).collect()
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    GROUPS.iter().find_map(|(_, a)| a(id, p, input, ctx))
}

/// StepInfo builder.
#[allow(clippy::too_many_arguments)]
pub(crate) fn info(
    id: &'static str,
    label: &'static str,
    group: &'static str,
    layer: Layer,
    expert: bool,
    random: bool,
    uses_pool: bool,
    help: &'static str,
    params: Vec<ParamInfo>,
) -> StepInfo {
    StepInfo { id, label, group, layer, expert, random, uses_pool, simulated: group == "Sensor", help, params }
}

pub(crate) fn p_text(id: &'static str, label: &'static str, def: &str) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Text, default: Value::from(def), expert: false, hint: "" }
}
pub(crate) fn p_table(id: &'static str, label: &'static str) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Table, default: Value::Null, expert: true, hint: "" }
}
pub(crate) fn p_mask(id: &'static str, label: &'static str) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Mask, default: Value::Null, expert: false, hint: "" }
}
pub(crate) const COMPONENTS: &[(&str, &str)] = &[("0", "Y (brightness)"), ("1", "Cb (blue-yellow)"), ("2", "Cr (red-green)")];

pub(crate) fn unreadable() -> String {
    "this image is too damaged to read its pixels".into()
}

/// Encoder settings that reproduce the input (or the default profile for unreadable headers).
pub(crate) fn settings_of(input: &[u8]) -> EncodeSettings {
    EncodeSettings::like(input).unwrap_or_else(|| profiles::get(profiles::DEFAULT_PROFILE).unwrap().settings)
}

/// Forgiving decode to RGBA plus the settings to re-encode with.
pub(crate) fn px_in(input: &[u8]) -> Result<(Rgba, EncodeSettings), String> {
    let parsed = parse(input, false);
    let s = EncodeSettings::from_parsed(&parsed).unwrap_or_else(|| profiles::get(profiles::DEFAULT_PROFILE).unwrap().settings);
    let d = render::decode_parsed(parsed, &render::DecodeOpts::default()).map_err(|_| unreadable())?;
    Ok((Rgba { w: d.width, h: d.height, px: d.rgba }, s))
}

pub(crate) fn px_out(img: &Rgba, s: &EncodeSettings) -> Vec<u8> {
    encoder::encode_rgba(img.w, img.h, &img.px, s)
}

/// Coefficients (forgiving parse) plus settings for lossless re-entropy-coding.
pub(crate) fn co_in(input: &[u8]) -> Result<(CoeffImage, EncodeSettings), String> {
    let p = parse(input, false);
    let s = EncodeSettings::from_parsed(&p).unwrap_or_else(|| profiles::get(profiles::DEFAULT_PROFILE).unwrap().settings);
    let img = p.img.ok_or_else(unreadable)?;
    Ok((img, s))
}

pub(crate) fn co_out(img: &CoeffImage, s: &EncodeSettings) -> Vec<u8> {
    encoder::write(img, s)
}

/// Entropy-coded data range: from the end of the first SOS header to the last scan's end
/// (or a guess when the file has no SOS).
pub(crate) fn scan_range(input: &[u8]) -> (usize, usize) {
    let l = walk(input);
    match l.all_scan_data() {
        Some((a, b)) if b > a => (a, b),
        Some((a, _)) => (a, input.len()),
        None => {
            let after = l.segments.iter().filter(|s| s.marker != 0xD9).map(|s| s.offset + s.length).max().unwrap_or(0);
            (after.min(input.len()), input.len())
        }
    }
}

/// A sub-range of the scan data given start/end percentages (0..100).
pub(crate) fn region(input: &[u8], p: &Value) -> (usize, usize) {
    let (a, b) = scan_range(input);
    let s = get_f64(p, "start", 0.0).clamp(0.0, 100.0);
    let e = get_f64(p, "end", 100.0).clamp(0.0, 100.0);
    let (s, e) = if s <= e { (s, e) } else { (e, s) };
    let n = (b - a) as f64;
    let ra = a + (n * s / 100.0) as usize;
    let rb = a + (n * e / 100.0) as usize;
    (ra.min(b), rb.clamp(ra.min(b), b))
}

pub(crate) fn pick_photo<'a>(p: &Value, key: &str, ctx: &StepCtx<'a>) -> Result<&'a [u8], String> {
    let idx = get_i64(p, key, -1);
    let idx = if idx < 0 { 0 } else { idx };
    ctx.pool_photo(idx).ok_or_else(|| "this step needs another photo in the pool".to_string())
}

/// (SOF payload, all DQT payloads, all DHT payloads) before the first scan: frame size + sampling
/// and the tables. Two photos with equal signatures came out of the same camera mode.
pub(crate) fn table_sig(d: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let l = walk(d);
    let sos = l.first(crate::markers::SOS).map(|s| s.offset).unwrap_or(d.len());
    let sof = l.sof().filter(|s| s.offset < sos)?.payload(d).to_vec();
    let cat = |m: u8| -> Vec<u8> { l.segments.iter().filter(|s| s.marker == m && s.offset < sos).flat_map(|s| s.payload(d).to_vec()).collect() };
    Some((sof, cat(crate::markers::DQT), cat(crate::markers::DHT)))
}

/// Like `pick_photo`, but "-1 = next photo" prefers a pool photo whose frame size AND
/// quantisation/Huffman tables match `input` (then tables only, then size only), so a graft
/// behaves like one between two shots from the same camera. Falls back to the next photo.
pub(crate) fn pick_matching_photo<'a>(p: &Value, key: &str, input: &[u8], ctx: &StepCtx<'a>) -> Result<&'a [u8], String> {
    if get_i64(p, key, -1) >= 0 {
        return pick_photo(p, key, ctx);
    }
    if let Some((sof, dqt, dht)) = table_sig(input) {
        let mut best: Option<(u32, usize)> = None;
        for (i, ph) in ctx.pool.iter().enumerate() {
            let Some((s2, q2, h2)) = table_sig(ph) else { continue };
            let tables = q2 == dqt && h2 == dht;
            let score = if tables && s2 == sof { 3 } else if tables { 2 } else if s2 == sof { 1 } else { 0 };
            if score > 0 && best.is_none_or(|(b, _)| score > b) {
                best = Some((score, i));
            }
        }
        if let Some((_, i)) = best {
            return Ok(&ctx.pool[i]);
        }
    }
    pick_photo(p, key, ctx)
}

pub(crate) fn component(p: &Value, key: &str, def: usize) -> usize {
    match p.get(key) {
        Some(Value::String(s)) => s.parse().unwrap_or(def),
        Some(v) => v.as_u64().map(|x| x as usize).unwrap_or(def),
        None => def,
    }
}

/// Make sure the input carries restart markers; returns bytes with DRI (one MCU row if absent).
pub(crate) fn with_restarts(input: &[u8]) -> Result<Vec<u8>, String> {
    let l = walk(input);
    if l.first(0xDD).map(|s| crate::decoder::be16(s.payload(input), 0) > 0).unwrap_or(false) {
        return Ok(input.to_vec());
    }
    let (img, mut s) = co_in(input)?;
    s.restart_interval = img.mcu_grid().0.max(1);
    Ok(co_out(&img, &s))
}

/// Re-entropy-code as progressive (libjpeg's default script) unless it already is.
pub(crate) fn as_progressive(input: &[u8]) -> Result<Vec<u8>, String> {
    let l = walk(input);
    if l.sof().map(|s| s.marker == 0xC2).unwrap_or(false) {
        return Ok(input.to_vec());
    }
    let (img, mut s) = co_in(input)?;
    s.progressive = true;
    s.scans = None;
    s.huffman = encoder::HuffMode::Optimize;
    Ok(co_out(&img, &s))
}

#[cfg(test)]
mod tests;
