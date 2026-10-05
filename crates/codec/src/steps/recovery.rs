//! Recovery group: ransomware_partial, repair_tool, mjpeg_no_dht, mpf_ghost.

use super::*;
use crate::coeffs::ColorSpace;
use crate::markers::DHT;
use crate::pixels::resize;

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "ransomware_partial",
            "Partly encrypted (ransomware)",
            "Recovery",
            Layer::Byte,
            false,
            true,
            false,
            "Fast ransomware only scrambles the first part of each file. The header is gone, so the photo won't open, but the body is intact: graft a good header back on and most of the picture returns.",
            vec![p_int("kb", "Scrambled KB", 1, 16384, 64)],
        ),
        info(
            "repair_tool",
            "\"Repair\" tool",
            "Recovery",
            Layer::Coeff,
            false,
            false,
            false,
            "Commercial repair tools guess each strip's average brightness and colour from the one above and patch missing blocks with flat colour. The result opens everywhere, but has stepped colour bands and flat patches.",
            vec![p_float("strength", "How hard it guesses", 0.0, 1.0, 0.05, 1.0)],
        ),
        info(
            "mjpeg_no_dht",
            "Video frame as photo (no tables)",
            "Recovery",
            Layer::Byte,
            true,
            false,
            false,
            "Motion-JPEG video frames leave out the Huffman code book and rely on the standard one. Carved out as a photo, a recovery tool has to insert the standard tables; if the frame really used other tables, it decodes as noise.",
            vec![p_enum("mode", "Carver", &[("insert_std", "Insert standard tables"), ("none", "Leave them out")], "insert_std")],
        ),
        info(
            "mpf_ghost",
            "Recovered a hidden part",
            "Recovery",
            Layer::Pixel,
            true,
            false,
            false,
            "Modern phone JPEGs carry hidden extra images: an HDR gain map, a depth map or a preview. Carved separately you get a grey ghost of the scene instead of the photo. If the file has no hidden part, one is made from the photo.",
            vec![p_enum("kind", "Part", &[("gain_map", "HDR gain map"), ("depth", "Depth map"), ("preview", "Preview")], "gain_map")],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "ransomware_partial" => ransomware(p, input, ctx),
        "repair_tool" => repair_tool(p, input),
        "mjpeg_no_dht" => mjpeg_no_dht(p, input),
        "mpf_ghost" => mpf_ghost(p, input),
        _ => return None,
    })
}

fn ransomware(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let n = (get_i64(p, "kb", 64).clamp(0, 1 << 20) as usize * 1024).min(input.len());
    let mut rng = ctx.rng();
    let mut out = input.to_vec();
    for chunk in out[..n].chunks_mut(4) {
        let k = rng.next_u32().to_le_bytes();
        for (b, kk) in chunk.iter_mut().zip(k) {
            *b ^= kk;
        }
    }
    Ok(out)
}

fn repair_tool(p: &Value, input: &[u8]) -> StepResult {
    let (mut img, mut s) = co_in(input)?;
    let strength = get_f64(p, "strength", 1.0).clamp(0.0, 1.0);
    for c in img.comps.iter_mut() {
        let (bw, hib, wib) = (c.bw, c.hib.min(c.bh), c.wib.min(c.bw));
        // Patch blocks that never got data: flat colour from the block above (or left).
        for by in 0..hib {
            for bx in 0..wib {
                let bi = by * bw + bx;
                if c.seen[bi] == 0 {
                    let src = if by > 0 { Some((by - 1) * bw + bx) } else if bx > 0 { Some(bi - 1) } else { None };
                    let dc = src.map(|s| c.coef[s * 64]).unwrap_or(0);
                    c.coef[bi * 64..bi * 64 + 64].fill(0);
                    c.coef[bi * 64] = dc;
                    c.seen[bi] = 1;
                }
            }
        }
        // Re-estimate each block row's DC level from the row above (median step).
        for by in 1..hib {
            let mut diffs: Vec<i32> = (0..wib).map(|bx| c.coef[(by * bw + bx) * 64] as i32 - c.coef[((by - 1) * bw + bx) * 64] as i32).collect();
            diffs.sort_unstable();
            let med = diffs.get(diffs.len() / 2).copied().unwrap_or(0);
            let thresh = (96 / c.q[0].max(1) as i32).max(2);
            if med.abs() < thresh {
                continue;
            }
            let corr = (med as f64 * strength).round() as i32;
            for bx in 0..bw {
                let i = (by * bw + bx) * 64;
                c.coef[i] = (c.coef[i] as i32 - corr).clamp(-2047, 2047) as i16;
            }
        }
    }
    s.restart_interval = 0;
    Ok(co_out(&img, &s))
}

fn mjpeg_no_dht(p: &Value, input: &[u8]) -> StepResult {
    let stripped = colour_drop(input, |m, _| m == DHT);
    if get_str(p, "mode", "insert_std") == "none" {
        return Ok(stripped);
    }
    Ok(crate::avi::ensure_dht(&stripped))
}

fn colour_drop(input: &[u8], pred: impl Fn(u8, &[u8]) -> bool) -> Vec<u8> {
    super::colour::drop_segments(input, pred)
}

fn gray_jpeg(w: usize, h: usize, v: &[u8], q: i32) -> Vec<u8> {
    let mut s = encoder::EncodeSettings::standard(q, "444");
    s.color = ColorSpace::Gray;
    s.comps.truncate(1);
    s.comps[0].h = 1;
    s.comps[0].v = 1;
    s.qtables.truncate(1);
    let plane = crate::sample::Plane8 { w, h, data: v.to_vec() };
    encoder::encode_planes(&[plane], w, h, &s)
}

fn box_blur(w: usize, h: usize, v: &[u8], r: usize) -> Vec<u8> {
    let mut tmp = vec![0u8; w * h];
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let (a, b) = (x.saturating_sub(r), (x + r).min(w - 1));
            let s: u32 = v[y * w + a..=y * w + b].iter().map(|&p| p as u32).sum();
            tmp[y * w + x] = (s / (b - a + 1) as u32) as u8;
        }
    }
    for y in 0..h {
        let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
        for x in 0..w {
            let s: u32 = (a..=b).map(|yy| tmp[yy * w + x] as u32).sum();
            out[y * w + x] = (s / (b - a + 1) as u32) as u8;
        }
    }
    out
}

fn mpf_ghost(p: &Value, input: &[u8]) -> StepResult {
    // A real secondary image (MPF / gain map) after the main image's EOI?
    let l = walk(input);
    if let Some(eoi) = l.eoi {
        let rest = &input[eoi + 2..];
        if let Some(i) = rest.windows(3).position(|w| w == [0xFF, 0xD8, 0xFF]) {
            return Ok(rest[i..].to_vec());
        }
    }
    let kind = get_str(p, "kind", "gain_map");
    let (img, _) = px_in(input)?;
    let luma = |im: &Rgba| -> Vec<u8> { im.px.chunks(4).map(|c| ((c[0] as u32 * 77 + c[1] as u32 * 150 + c[2] as u32 * 29) >> 8) as u8).collect() };
    match kind {
        "preview" => {
            let small = resize(&img, (img.w / 4).max(8), (img.h / 4).max(8));
            Ok(px_out(&small, &encoder::EncodeSettings::standard(70, "420")))
        }
        "depth" => {
            let small = resize(&img, (img.w / 2).max(8), (img.h / 2).max(8));
            let y = luma(&small);
            let b = box_blur(small.w, small.h, &y, (small.w / 40).max(2));
            let b = box_blur(small.w, small.h, &b, (small.w / 40).max(2));
            let v: Vec<u8> = b.iter().enumerate().map(|(i, &l)| (((255 - l as u32) * 6 + (i / small.w) as u32 * 255 * 4 / small.h as u32) / 10) as u8).collect();
            Ok(gray_jpeg(small.w, small.h, &v, 85))
        }
        _ => {
            let small = resize(&img, (img.w / 4).max(8), (img.h / 4).max(8));
            let y = luma(&small);
            let mean = (y.iter().map(|&v| v as u64).sum::<u64>() / y.len().max(1) as u64) as i32;
            let b = box_blur(small.w, small.h, &y, 1);
            let v: Vec<u8> = b.iter().map(|&l| (128 + (l as i32 - mean) * 2 / 3).clamp(0, 255) as u8).collect();
            Ok(gray_jpeg(small.w, small.h, &v, 85))
        }
    }
}
