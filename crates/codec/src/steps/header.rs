//! Header group: cbcr_swap, header_graft, sof_dims, huffman_swap.

use super::*;
use crate::markers::{is_sof, segment, APP1, DHT, SOS};

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "cbcr_swap",
            "Swap the colour channels",
            "Header",
            Layer::Byte,
            false,
            false,
            false,
            "Two bytes in the header that name the colour channels are swapped. The blue-difference data is now treated as red-difference and back, so blues turn orange and reds turn teal.",
            vec![],
        ),
        info(
            "header_graft",
            "Header from another photo",
            "Header",
            Layer::Byte,
            false,
            false,
            true,
            "Recovery tools rebuild headless files by gluing on a header from a good photo. The body is then decoded with the donor's tables and size: odd contrast, and if the sizes differ, rows wrap around with a slanted seam.",
            vec![
                p_photo("photo", "Header donor").hint("Automatic picks a photo with the same size and tables (same camera)"),
                p_int("skip", "Start body later (bytes)", 0, 1 << 26, 0).hint("Starting mid-stream gives the whole-image pastel casts"),
                p_bool("keep_exif", "Keep donor's Exif", false).expert(),
                p_bool("neutralise_markers", "Neutralise stray markers", true)
                    .expert()
                    .hint("Like header-graft recovery scripts: turn stray 0xFF markers in the body into harmless bytes so decoding doesn't stop"),
            ],
        ),
        info(
            "sof_dims",
            "Wrong image size",
            "Header",
            Layer::Byte,
            false,
            false,
            false,
            "The header claims a different width or height. The data is still laid out row by row, so each row starts a little off from the last and the picture leans into a diagonal skew.",
            vec![
                p_int("width", "Width (0 = keep)", 0, 16384, 0).expert(),
                p_int("height", "Height (0 = keep)", 0, 16384, 0).expert(),
                p_int("width_delta", "Width change (pixels)", -256, 256, 16).hint("Negative = narrower, positive = wider; used when Width is 0"),
                p_int("height_delta", "Height change", -2048, 2048, 0).expert(),
            ],
        ),
        info(
            "huffman_swap",
            "Wrong Huffman tables",
            "Header",
            Layer::Byte,
            true,
            false,
            true,
            "The code book that turns bits back into numbers is replaced. With a different book almost every code is misread, so the picture dissolves into noisy blocks after the first few rows.",
            vec![p_enum("source", "Tables from", &[("photo", "Another photo"), ("standard", "Standard tables")], "photo"), p_photo("photo", "Donor")],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "cbcr_swap" => cbcr_swap(input),
        "header_graft" => header_graft(p, input, ctx),
        "sof_dims" => sof_dims(p, input),
        "huffman_swap" => huffman_swap(p, input, ctx),
        _ => return None,
    })
}

fn cbcr_swap(input: &[u8]) -> StepResult {
    let l = walk(input);
    let sof = l.sof().ok_or("no frame header found")?;
    let base = sof.offset + 4 + 6;
    let mut out = input.to_vec();
    if out.get(5 + sof.offset + 4).copied().unwrap_or(0) < 3 || base + 6 >= out.len() {
        return Err("this image has no colour channels to swap".into());
    }
    out.swap(base + 3, base + 6);
    Ok(out)
}

/// Header bytes of `d` up to and including its first SOS segment (optionally without Exif).
pub(crate) fn header_of(d: &[u8], keep_exif: bool) -> Option<(Vec<u8>, usize)> {
    let l = walk(d);
    let sos = l.first(SOS)?;
    let mut h = vec![0xFF, 0xD8];
    for s in &l.segments {
        if s.marker == 0xD8 || (s.marker == APP1 && !keep_exif) {
            continue;
        }
        h.extend_from_slice(&d[s.offset..s.offset + s.length]);
        if s.offset == sos.offset {
            break;
        }
    }
    Some((h, sos.end))
}

/// A start-of-scan segment at `i` whose length matches its component count (1..4).
fn plausible_sos(d: &[u8], i: usize) -> bool {
    if i + 5 > d.len() || d[i] != 0xFF || d[i + 1] != SOS {
        return false;
    }
    let len = crate::decoder::be16(d, i + 2);
    let ns = d[i + 4] as usize;
    (1..=4).contains(&ns) && len == 6 + 2 * ns && i + 2 + len <= d.len()
}

/// Where the entropy-coded body of `d` starts. A readable header (frame + plausible SOS) gives the
/// end of its first SOS; a destroyed header (ransomware, overwritten cluster) falls back to the
/// last plausible SOS anywhere in the file, and finally to 0 (the caller neutralises markers then).
/// The input's own header is intact: it starts with SOI and has a frame header before a plausible
/// first SOS. Returns the end of that SOS.
pub(crate) fn own_body_start(d: &[u8]) -> Option<usize> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let l = walk(d);
    let (sof, sos) = (l.sof()?, l.first(SOS)?);
    (sof.offset < sos.offset && plausible_sos(d, sos.offset)).then_some(sos.end)
}

pub(crate) fn body_start_of(d: &[u8]) -> usize {
    own_body_start(d)
        .or_else(|| (0..d.len().saturating_sub(5)).rev().find(|&i| plausible_sos(d, i)).map(|i| i + 2 + crate::decoder::be16(d, i + 2)))
        .unwrap_or(0)
}

fn header_graft(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let donor = pick_matching_photo(p, "photo", input, ctx)?;
    let (out_hdr, _) = header_of(donor, get_bool(p, "keep_exif", false)).ok_or("the donor photo has no usable header")?;
    let skip = get_i64(p, "skip", 0).max(0) as usize;
    // With an intact header, `skip` counts from the start of the body. With a destroyed one
    // (ransomware, overwritten first cluster) it counts from byte 0 of the file, since anything
    // header-shaped in there is a coincidence; with no skip, start after the last plausible SOS.
    let body_start = match own_body_start(input) {
        Some(s) => s,
        None if skip > 0 => 0,
        None => body_start_of(input),
    };
    let start = (body_start + skip).min(input.len());
    let mut body = input[start..].to_vec();
    if get_bool(p, "neutralise_markers", true) {
        // Restart markers only belong in a scan whose header asks for them (DRI). Without one, any
        // FF D0..D7 is a stray that stops libjpeg for the rest of the file. With one, those before
        // the photo's own start-of-scan (left over in a destroyed header's Exif or thumbnail) are.
        let restarts = walk(&out_hdr).first(0xDD).map(|s| crate::decoder::be16(s.payload(&out_hdr), 0) > 0).unwrap_or(false);
        let stray_until = if !restarts {
            body.len()
        } else if own_body_start(input).is_none() {
            (0..body.len().saturating_sub(5)).rev().find(|&i| plausible_sos(&body, i)).unwrap_or(0)
        } else {
            0
        };
        for i in 0..stray_until.min(body.len().saturating_sub(1)) {
            if body[i] == 0xFF && (0xD0..=0xD7).contains(&body[i + 1]) {
                body[i] = 0xFE;
            }
        }
        crate::markers::neutralise_markers(&mut body);
    }
    let mut out = out_hdr;
    out.extend_from_slice(&body);
    Ok(out)
}

fn sof_dims(p: &Value, input: &[u8]) -> StepResult {
    let l = walk(input);
    let sof = l.segments.iter().find(|s| is_sof(s.marker)).ok_or("no frame header found")?;
    let at = sof.offset + 4;
    if at + 5 > input.len() {
        return Err("frame header is cut short".into());
    }
    let h0 = crate::decoder::be16(input, at + 1) as i64;
    let w0 = crate::decoder::be16(input, at + 3) as i64;
    let mut w = get_i64(p, "width", 0);
    let mut h = get_i64(p, "height", 0);
    if w <= 0 {
        w = w0 + get_i64(p, "width_delta", 16);
    }
    if h <= 0 {
        h = h0 + get_i64(p, "height_delta", 0);
    }
    let (w, h) = (w.clamp(1, 65535) as u16, h.clamp(1, 65535) as u16);
    let mut out = input.to_vec();
    out[at + 1..at + 3].copy_from_slice(&h.to_be_bytes());
    out[at + 3..at + 5].copy_from_slice(&w.to_be_bytes());
    Ok(out)
}

fn huffman_swap(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let tables: Vec<u8> = if get_str(p, "source", "photo") == "standard" {
        Vec::new()
    } else {
        let donor = pick_photo(p, "photo", ctx)?;
        let l = walk(donor);
        l.segments.iter().filter(|s| s.marker == DHT).flat_map(|s| donor[s.offset..s.offset + s.length].to_vec()).collect()
    };
    let l = walk(input);
    let first_sos = l.first(SOS).map(|s| s.offset).ok_or("no image data found")?;
    let mut out = Vec::with_capacity(input.len());
    let mut pos = 0;
    for s in l.segments.iter().filter(|s| s.marker == DHT && s.offset < first_sos) {
        out.extend_from_slice(&input[pos..s.offset]);
        pos = s.offset + s.length;
    }
    out.extend_from_slice(&input[pos..first_sos]);
    if tables.is_empty() {
        let mut p = Vec::new();
        for (tc, chroma) in [(0x00u8, false), (0x10, false), (0x01, true), (0x11, true)] {
            p.push(tc);
            let spec = if tc & 0x10 != 0 { crate::huffman::HuffSpec::std_ac(chroma) } else { crate::huffman::HuffSpec::std_dc(chroma) };
            spec.write(&mut p);
        }
        out.extend(segment(DHT, &p));
    } else {
        out.extend(tables);
    }
    out.extend_from_slice(&input[first_sos..]);
    Ok(out)
}
