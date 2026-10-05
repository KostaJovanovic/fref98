//! Transfer group: ftp_ascii, seven_bit, base64_damage, interrupted_download, mms_recompress.

use super::*;
use crate::pixels::{fit_long, resize};

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "ftp_ascii",
            "FTP in text mode",
            "Transfer",
            Layer::Byte,
            false,
            true,
            false,
            "Old FTP programs in text mode 'fixed' line endings inside the file, adding or removing a byte wherever a 0x0A or 0x0D appeared. Each change knocks the decoder out of step, so the picture shatters into shifted, discoloured bands.",
            vec![
                p_enum("direction", "Conversion", &[("lf_to_crlf", "Unix to Windows (adds bytes)"), ("crlf_to_lf", "Windows to Unix (removes bytes)")], "lf_to_crlf"),
                p_float("portion", "Part sent in text mode", 0.02, 1.0, 0.01, 1.0)
                    .hint("1 = the whole file; less = only one stretch of the image data (placed by the dice) got converted"),
            ],
        ),
        info(
            "seven_bit",
            "7-bit mail gateway",
            "Transfer",
            Layer::Byte,
            true,
            false,
            false,
            "Some old mail systems only carried 7-bit text and cleared the top bit of every byte. From that point on the codes make no sense, so the picture breaks down into noise and grey.",
            vec![p_float("start", "From (% of image data)", 0.0, 100.0, 0.5, 30.0).hint("Headers before this stay intact")],
        ),
        info(
            "base64_damage",
            "Broken e-mail attachment",
            "Transfer",
            Layer::Byte,
            false,
            true,
            false,
            "Attachments travel as base64 text lines. Lose or garble one line and 57 bytes vanish or change, so everything after is shifted: a seam with shifted, recoloured rows below.",
            vec![p_int("lines", "Damaged lines", 1, 100, 2), p_enum("mode", "Damage", &[("drop", "Line lost"), ("garble", "Line garbled")], "drop")],
        ),
        info(
            "interrupted_download",
            "Interrupted download",
            "Transfer",
            Layer::Byte,
            false,
            false,
            false,
            "The connection dropped before the file finished. A normal JPEG ends in a grey slab; a progressive one is complete but blurry, because the detail passes never arrived.",
            vec![
                p_float("percent", "Downloaded (%)", 0.0, 100.0, 0.5, 70.0),
                p_bool("progressive", "Server sent a progressive JPEG", true),
            ],
        ),
        info(
            "mms_recompress",
            "Sent by MMS",
            "Transfer",
            Layer::Pixel,
            false,
            false,
            false,
            "Picture messages had a tiny size limit, so the phone shrank the photo and squeezed it with harsher and harsher quality until it fit. That's the smeary, blocky MMS look.",
            vec![p_int("size_kb", "Size limit (KB)", 5, 600, 30)],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "ftp_ascii" => ftp_ascii(p, input, ctx),
        "seven_bit" => seven_bit(p, input),
        "base64_damage" => base64_damage(p, input, ctx),
        "interrupted_download" => interrupted_download(p, input),
        "mms_recompress" => mms_recompress(p, input),
        _ => return None,
    })
}

/// Byte range [lo, hi) converted by ftp_ascii: the whole file at portion 1, else a contiguous
/// stretch of `portion` of the image data placed by the seed.
fn ftp_range(input: &[u8], portion: f64, ctx: &StepCtx) -> (usize, usize) {
    if portion >= 1.0 {
        return (0, input.len());
    }
    let (a, b) = scan_range(input);
    let n = b.saturating_sub(a);
    if n == 0 {
        return (0, input.len());
    }
    let len = ((n as f64 * portion).round() as usize).clamp(1, n);
    let start = a + ctx.rng().below((n - len + 1) as u32) as usize;
    (start, start + len)
}

fn ftp_ascii(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let portion = get_f64(p, "portion", 1.0).clamp(0.02, 1.0);
    let (lo, hi) = ftp_range(input, portion, ctx);
    let mut out = Vec::with_capacity(input.len() + input.len() / 128);
    out.extend_from_slice(&input[..lo]);
    if get_str(p, "direction", "lf_to_crlf") == "crlf_to_lf" {
        let mut i = lo;
        while i < hi {
            if input[i] == 0x0D && input.get(i + 1) == Some(&0x0A) {
                i += 1;
                continue;
            }
            out.push(input[i]);
            i += 1;
        }
    } else {
        for i in lo..hi {
            let b = input[i];
            if b == 0x0A && (i == 0 || input[i - 1] != 0x0D) {
                out.push(0x0D);
            }
            out.push(b);
        }
    }
    out.extend_from_slice(&input[hi..]);
    Ok(out)
}

fn seven_bit(p: &Value, input: &[u8]) -> StepResult {
    let (a, b) = scan_range(input);
    let from = a + ((b - a) as f64 * get_f64(p, "start", 30.0).clamp(0.0, 100.0) / 100.0) as usize;
    let mut out = input.to_vec();
    for v in out[from.min(input.len())..].iter_mut() {
        *v &= 0x7F;
    }
    Ok(out)
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(d: &[u8]) -> Vec<u8> {
    let mut o = Vec::with_capacity(d.len() * 4 / 3 + 4);
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        o.push(B64[(n >> 18) as usize & 63]);
        o.push(B64[(n >> 12) as usize & 63]);
        o.push(if c.len() > 1 { B64[(n >> 6) as usize & 63] } else { b'=' });
        o.push(if c.len() > 2 { B64[n as usize & 63] } else { b'=' });
    }
    o
}

/// Lenient decoder: skips anything that isn't a base64 character, like most mail clients.
fn b64_decode(s: &[u8]) -> Vec<u8> {
    let mut o = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut n = 0;
    for &c in s {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        acc = (acc << 6) | v as u32;
        n += 1;
        if n == 4 {
            o.extend_from_slice(&[(acc >> 16) as u8, (acc >> 8) as u8, acc as u8]);
            acc = 0;
            n = 0;
        }
    }
    if n == 3 {
        o.extend_from_slice(&[(acc >> 10) as u8, (acc >> 2) as u8]);
    } else if n == 2 {
        o.push((acc >> 4) as u8);
    }
    o
}

fn base64_damage(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let enc = b64_encode(input);
    let mut lines: Vec<Vec<u8>> = enc.chunks(76).map(|c| c.to_vec()).collect();
    let (scan_start, _) = scan_range(input);
    let first = (scan_start * 4 / 3) / 76 + 1;
    if first >= lines.len() {
        return Err("the file is too small to damage a line".into());
    }
    let n = get_i64(p, "lines", 2).clamp(1, 10_000) as usize;
    let drop = get_str(p, "mode", "drop") == "drop";
    let mut rng = ctx.rng();
    let mut picks: Vec<usize> = (0..n).map(|_| first + rng.below((lines.len() - first) as u32) as usize).collect();
    picks.sort_unstable();
    picks.dedup();
    for &i in picks.iter().rev() {
        if drop {
            lines.remove(i);
        } else {
            let l = &mut lines[i];
            let k = 1 + rng.below(8) as usize;
            for _ in 0..k {
                let j = rng.below(l.len() as u32) as usize;
                l[j] = B64[rng.below(64) as usize];
            }
        }
    }
    Ok(b64_decode(&lines.concat()))
}

fn interrupted_download(p: &Value, input: &[u8]) -> StepResult {
    let d = if get_bool(p, "progressive", true) { as_progressive(input)? } else { input.to_vec() };
    let n = (d.len() as f64 * get_f64(p, "percent", 70.0).clamp(0.0, 100.0) / 100.0) as usize;
    Ok(d[..n.min(d.len())].to_vec())
}

fn mms_recompress(p: &Value, input: &[u8]) -> StepResult {
    let limit = get_i64(p, "size_kb", 30).clamp(1, 100_000) as usize * 1024;
    let (img, _) = px_in(input)?;
    let (w, h) = fit_long(img.w, img.h, 640);
    let mut img = resize(&img, w, h);
    loop {
        let (mut lo, mut hi) = (5, 90);
        let mut best: Option<Vec<u8>> = None;
        while lo <= hi {
            let q = (lo + hi) / 2;
            let s = encoder::EncodeSettings::standard(q, "420");
            let out = px_out(&img, &s);
            if out.len() <= limit {
                best = Some(out);
                lo = q + 1;
            } else {
                hi = q - 1;
            }
        }
        if let Some(b) = best {
            return Ok(b);
        }
        if img.w <= 64 || img.h <= 64 {
            return Ok(px_out(&img, &encoder::EncodeSettings::standard(5, "420")));
        }
        img = resize(&img, img.w * 3 / 4, img.h * 3 / 4);
    }
}
