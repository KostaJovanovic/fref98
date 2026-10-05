//! Coefficients -> pixels: inverse DCT, progressive block smoothing, upsampling, colour
//! conversion, decoder personalities and fill modes for undecoded regions.

use crate::coeffs::*;
use crate::color::{cmyk_to_rgb, ycc_to_rgb};
use crate::dct::{idct_islow, idct_islow_simd};
use crate::decoder::{parse, Event, Parsed};
use crate::sample::{upsample, Plane8, UpOpts};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Personality {
    Libjpeg,
    Browser,
    Gdiplus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fill {
    Grey,
    Repeat,
    Black,
    Donor,
}

#[derive(Clone, Debug)]
pub struct DecodeOpts {
    pub personality: Personality,
    pub fill: Fill,
    pub fancy: bool,
    pub max_dim: Option<usize>,
    /// Donor JPEG used by Fill::Donor.
    pub donor: Option<Vec<u8>>,
}

impl Default for DecodeOpts {
    fn default() -> Self {
        DecodeOpts { personality: Personality::Libjpeg, fill: Fill::Grey, fancy: true, max_dim: None, donor: None }
    }
}

impl DecodeOpts {
    pub fn from_json(v: &serde_json::Value) -> Self {
        DecodeOpts {
            personality: match v.get("personality").and_then(|x| x.as_str()) {
                Some("browser") => Personality::Browser,
                Some("gdiplus") => Personality::Gdiplus,
                _ => Personality::Libjpeg,
            },
            fill: match v.get("fill").and_then(|x| x.as_str()) {
                Some("repeat") => Fill::Repeat,
                Some("black") => Fill::Black,
                Some("donor") => Fill::Donor,
                _ => Fill::Grey,
            },
            fancy: v.get("fancy_upsampling").and_then(|x| x.as_bool()).unwrap_or(true),
            max_dim: v.get("max_dim").and_then(|x| x.as_u64()).filter(|&m| m > 0).map(|m| m as usize),
            donor: None,
        }
    }
}

pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    pub events: Vec<Event>,
}

/// Full-resolution component planes after upsampling (before colour conversion).
pub struct Planes {
    pub width: usize,
    pub height: usize,
    pub planes: Vec<Plane8>,
    pub color: ColorSpace,
}

/// Rounded estimate as in jdcoefct.c: ((Q<<7) + num) / (Q<<8), symmetric, optionally clamped to
/// the bits still unknown (Al).
#[inline]
fn predict(num: i64, qk: i64, al: i32) -> i16 {
    let mut pred = ((qk << 7) + num.abs()) / (qk << 8);
    if al > 0 && pred >= (1 << al) {
        pred = (1 << al) - 1;
    }
    (if num < 0 { -pred } else { pred }) as i16
}

/// Block smoothing for incomplete progressive images: estimate missing low-frequency AC
/// coefficients (and, with no AC data at all, the DC itself) from neighbouring DC values.
/// `turbo` = libjpeg-turbo >= 2.1 (5x5 window, 9 coefficients, DC interpolation, kernels
/// measured against libjpeg-turbo 3); otherwise IJG 6b (3x3 window, 5 coefficients, K.8).
const SMOOTH_POS: [usize; 10] = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24];

/// Whether block smoothing applies to this image at all (decided once for every component).
fn smoothing_applies(img: &CoeffImage, parsed: &Parsed, turbo: bool) -> bool {
    if !parsed.meta.progressive || parsed.coef_bits.len() != img.comps.len() {
        return false;
    }
    let ncoef = if turbo { 10 } else { 6 };
    let mut useful = false;
    for (ci, c) in img.comps.iter().enumerate() {
        let cb = &parsed.coef_bits[ci];
        if SMOOTH_POS[..ncoef].iter().any(|&i| c.q[i] == 0) || cb[0] < 0 {
            return false;
        }
        useful |= (1..ncoef).any(|k| cb[k] != 0);
    }
    useful
}

/// The smoothed coefficients of component `ci` (call only when `smoothing_applies`). One component
/// at a time, so a large image never holds a smoothed copy of every plane at once.
fn smooth(img: &CoeffImage, parsed: &Parsed, turbo: bool, ci: usize) -> Vec<i16> {
    const POS: [usize; 10] = SMOOTH_POS;
    {
        let c = &img.comps[ci];
        let cur = parsed.coef_bits[ci];
        // libjpeg-turbo: below the last iMCU row that got real data, the previous scan's state.
        let mut prev = cur;
        for k in 1..10 {
            prev[k] = if parsed.scan_count > 1 { parsed.prev_coef_bits.get(ci).map(|b| b[k]).unwrap_or(-1) } else { -1 };
        }
        let mut data = c.coef.clone();
        let (w, h) = (c.wib.clamp(1, c.bw) as i64, c.hib.clamp(1, c.bh) as i64);
        let q00 = c.q[0] as i64;
        // Neighbour rows (-2..=2) per block row. IJG 6b simply clamps; libjpeg-turbo works per iMCU
        // row: only the last iMCU row clamps, earlier rows may read the decoded padding rows below.
        let v = c.v.max(1);
        let last_imcu = img.mcuy.max(1) - 1;
        let row_sel: Vec<[usize; 5]> = (0..h as usize)
            .map(|y| {
                let hh = h as usize;
                let prev = y.saturating_sub(1);
                let prev2 = if y > 1 { y - 2 } else { prev };
                if !turbo {
                    return [prev2, prev, y, (y + 1).min(hh - 1), (y + 2).min(hh - 1)];
                }
                let (imcu, br) = (y / v, (y % v) as i64);
                let block_rows = if imcu < last_imcu { v as i64 } else { match hh % v { 0 => v as i64, r => r as i64 } };
                let last_row = imcu >= last_imcu;
                let next = if br < block_rows - 1 || !last_row { y + 1 } else { y };
                let next2 = if br < block_rows - 2 || !last_row { y + 2 } else { next };
                [prev2, prev, y, next.min(c.bh - 1), next2.min(c.bh - 1)]
            })
            .collect();
        for by in 0..h {
            let cb = if turbo && (by as usize / v) as i64 > parsed.last_good_imcu { &prev } else { &cur };
            let change_dc = turbo && (1..10).all(|k| cb[k] == -1);
            for bx in 0..w {
                // d(dx, dy): neighbour DC with edge replication; DC01..DC25 = d(-2..2, -2..2).
                let ry = row_sel[by as usize];
                let d = |dx: i64, dy: i64| -> i64 {
                    let x = (bx + dx).clamp(0, w - 1) as usize;
                    let y = ry[(dy + 2) as usize];
                    c.coef[(y * c.bw + x) * 64] as i64
                };
                let bi = (by as usize * c.bw + bx as usize) * 64;
                let blk = &mut data[bi..bi + 64];
                let mut est = |zz: usize, kernel: i64| {
                    let pos = POS[zz];
                    if cb[zz] != 0 && blk[pos] == 0 {
                        blk[pos] = predict(q00 * kernel, c.q[pos] as i64, cb[zz]);
                    }
                };
                if !turbo {
                    est(1, 36 * (d(-1, 0) - d(1, 0)));
                    est(2, 36 * (d(0, -1) - d(0, 1)));
                    est(3, 9 * (d(0, -1) + d(0, 1) - 2 * d(0, 0)));
                    est(4, 5 * (d(-1, -1) - d(1, -1) - d(-1, 1) + d(1, 1)));
                    est(5, 9 * (d(-1, 0) + d(1, 0) - 2 * d(0, 0)));
                    continue;
                }
                // Horizontal "AC01-style" kernels; vertical ones use the transpose.
                let h01 = |d: &dyn Fn(i64, i64) -> i64| -> i64 {
                    if change_dc {
                        -d(-2, -2) - d(-1, -2) + d(1, -2) + d(2, -2) - 3 * d(-2, -1) + 13 * d(-1, -1) - 13 * d(1, -1) + 3 * d(2, -1)
                            - 3 * d(-2, 0)
                            + 38 * d(-1, 0)
                            - 38 * d(1, 0)
                            + 3 * d(2, 0)
                            - 3 * d(-2, 1)
                            + 13 * d(-1, 1)
                            - 13 * d(1, 1)
                            + 3 * d(2, 1)
                            - d(-2, 2)
                            - d(-1, 2)
                            + d(1, 2)
                            + d(2, 2)
                    } else {
                        -7 * d(-2, 0) + 50 * d(-1, 0) - 50 * d(1, 0) + 7 * d(2, 0)
                    }
                };
                let h02 = |d: &dyn Fn(i64, i64) -> i64| -> i64 {
                    if change_dc {
                        2 * d(-1, -1) - 5 * d(0, -1) + 2 * d(1, -1) + d(-2, 0) + 7 * d(-1, 0) - 14 * d(0, 0) + 7 * d(1, 0) + d(2, 0) + 2 * d(-1, 1)
                            - 5 * d(0, 1)
                            + 2 * d(1, 1)
                    } else {
                        -d(-2, 0) + 13 * d(-1, 0) - 24 * d(0, 0) + 13 * d(1, 0) - d(2, 0)
                    }
                };
                let t = |dx: i64, dy: i64| d(dy, dx);
                let n01 = h01(&d);
                let n10 = h01(&t);
                let n02 = h02(&d);
                let n20 = h02(&t);
                let n11 = if change_dc {
                    -d(-2, -2) + d(2, -2) + 9 * d(-1, -1) - 9 * d(1, -1) - 9 * d(-1, 1) + 9 * d(1, 1) + d(-2, 2) - d(2, 2)
                } else {
                    -d(-1, -2) + d(1, -2) - d(-2, -1) + 10 * d(-1, -1) - 10 * d(1, -1) + d(2, -1) + d(-2, 1) - 10 * d(-1, 1) + 10 * d(1, 1)
                        - d(2, 1)
                        + d(-1, 2)
                        - d(1, 2)
                };
                est(1, n01);
                est(2, n10);
                est(3, n20);
                est(4, n11);
                est(5, n02);
                if change_dc {
                    est(6, d(-1, -1) - d(1, -1) + 2 * d(-1, 0) - 2 * d(1, 0) + d(-1, 1) - d(1, 1));
                    est(7, d(-1, -1) - 3 * d(0, -1) + d(1, -1) - d(-1, 1) + 3 * d(0, 1) - d(1, 1));
                    est(8, d(-1, -1) - 3 * d(-1, 0) + d(-1, 1) - d(1, -1) + 3 * d(1, 0) - d(1, 1));
                    est(9, d(-1, -1) + 2 * d(0, -1) + d(1, -1) - d(-1, 1) - 2 * d(0, 1) - d(1, 1));
                    let mut s = 0i64;
                    for dy in -2..=2i64 {
                        for dx in -2..=2i64 {
                            let wgt = match (dx.abs(), dy.abs()) {
                                (0, 0) => 152,
                                (1, 0) | (0, 1) => 42,
                                (1, 1) => 6,
                                (2, 0) | (0, 2) => -8,
                                (2, 1) | (1, 2) => -6,
                                _ => -2,
                            };
                            s += wgt * d(dx, dy);
                        }
                    }
                    blk[0] = predict(q00 * s, q00, 0);
                }
            }
        }
        data
    }
}

/// Inverse DCT of a whole component into a block-padded plane. `simd` selects libjpeg-turbo's
/// x86 SIMD arithmetic (saturating) instead of the portable C code (wrapping range limit).
pub fn idct_comp(c: &Comp, coef: &[i16], simd: bool) -> Plane8 {
    let w = c.bw * 8;
    let h = c.bh * 8;
    let mut p = Plane8::new(w, h, 128);
    for by in 0..c.bh {
        for bx in 0..c.bw {
            let bi = (by * c.bw + bx) * 64;
            let off = by * 8 * w + bx * 8;
            let blk = &coef[bi..bi + 64];
            // Each coefficient moves a pixel by at most |deq|/4, and the C range limit only wraps
            // beyond +-512 around 128, so below a sum of ~2048 both variants agree; only take
            // the slower SIMD emulation for blocks with large coefficients.
            // (u64: 64 coefficients of up to 32767 x 65535 overflow a u32 sum.)
            if simd && blk.iter().zip(c.q.iter()).map(|(&v, &q)| (v as i64 * q as i64).unsigned_abs()).sum::<u64>() > 1900 {
                idct_islow_simd(blk, &c.q, &mut p.data[off..], w);
            } else {
                idct_islow(blk, &c.q, &mut p.data[off..], w);
            }
        }
    }
    p
}

pub fn render_planes(img: &CoeffImage, parsed: &Parsed, opts: &DecodeOpts) -> Planes {
    let turbo = opts.personality != Personality::Gdiplus;
    let smoothing = smoothing_applies(img, parsed, turbo);
    let up = UpOpts { fancy: opts.fancy, fancy_h1v2: turbo };
    let planes = img
        .comps
        .iter()
        .enumerate()
        .map(|(ci, c)| {
            let smoothed = smoothing.then(|| smooth(img, parsed, turbo, ci));
            let coef = smoothed.as_deref().unwrap_or(&c.coef[..]);
            let p = idct_comp(c, coef, turbo);
            let (dw, dh) = c.sample_dims(img);
            if img.comps.len() == 1 {
                upsample(&p, dw.max(img.width), dh.max(img.height), 1, 1, 1, 1, img.width, img.height, up)
            } else {
                upsample(&p, dw, dh, c.h, c.v, img.hmax, img.vmax, img.width, img.height, up)
            }
        })
        .collect();
    Planes { width: img.width, height: img.height, planes, color: img.color }
}

pub fn planes_to_rgba(p: &Planes) -> Vec<u8> {
    let n = p.width * p.height;
    let mut out = vec![255u8; n * 4];
    let pl = &p.planes;
    match (p.color, pl.len()) {
        (ColorSpace::YCbCr, 3) => {
            for i in 0..n {
                let (r, g, b) = ycc_to_rgb(pl[0].data[i], pl[1].data[i], pl[2].data[i]);
                out[i * 4] = r;
                out[i * 4 + 1] = g;
                out[i * 4 + 2] = b;
            }
        }
        (ColorSpace::Rgb, 3) => {
            for i in 0..n {
                out[i * 4] = pl[0].data[i];
                out[i * 4 + 1] = pl[1].data[i];
                out[i * 4 + 2] = pl[2].data[i];
            }
        }
        (ColorSpace::Cmyk, 4) => {
            for i in 0..n {
                let (r, g, b) = cmyk_to_rgb(pl[0].data[i], pl[1].data[i], pl[2].data[i], pl[3].data[i]);
                out[i * 4] = r;
                out[i * 4 + 1] = g;
                out[i * 4 + 2] = b;
            }
        }
        (ColorSpace::Ycck, 4) => {
            for i in 0..n {
                let (r, g, b) = ycc_to_rgb(pl[0].data[i], pl[1].data[i], pl[2].data[i]);
                let (r, g, b) = cmyk_to_rgb(255 - r, 255 - g, 255 - b, pl[3].data[i]);
                out[i * 4] = r;
                out[i * 4 + 1] = g;
                out[i * 4 + 2] = b;
            }
        }
        _ => {
            for i in 0..n {
                let v = pl.first().map(|p| p.data[i]).unwrap_or(128);
                out[i * 4] = v;
                out[i * 4 + 1] = v;
                out[i * 4 + 2] = v;
            }
        }
    }
    out
}

/// MCUs (mcu_grid raster order) whose first component never received data.
pub fn missing_mcus(img: &CoeffImage) -> Vec<bool> {
    let (gx, gy) = img.mcu_grid();
    let mut miss = vec![true; gx * gy];
    if let Some(c) = img.comps.first() {
        for by in 0..c.hib.min(c.bh) {
            for bx in 0..c.wib.min(c.bw) {
                if c.seen[by * c.bw + bx] != 0 {
                    let m = img.mcu_of_block(0, bx, by);
                    if let Some(e) = miss.get_mut(m) {
                        *e = false;
                    }
                }
            }
        }
    }
    miss
}

fn apply_fill(img: &CoeffImage, rgba: &mut [u8], opts: &DecodeOpts, donor: Option<&[u8]>) {
    if opts.fill == Fill::Grey {
        return;
    }
    let miss = missing_mcus(img);
    if !miss.iter().any(|&m| m) {
        return;
    }
    let (gx, _gy) = img.mcu_grid();
    let (mw, mh) = if img.comps.len() == 1 { (8, 8) } else { (8 * img.hmax, 8 * img.vmax) };
    let (w, h) = (img.width, img.height);
    for (m, &missing) in miss.iter().enumerate() {
        if !missing {
            continue;
        }
        let x0 = (m % gx) * mw;
        let y0 = (m / gx) * mh;
        for y in y0..(y0 + mh).min(h) {
            for x in x0..(x0 + mw).min(w) {
                let i = (y * w + x) * 4;
                let px: [u8; 3] = match opts.fill {
                    Fill::Black => [0, 0, 0],
                    Fill::Donor if donor.is_some() => {
                        let d = donor.unwrap();
                        [d[i], d[i + 1], d[i + 2]]
                    }
                    _ => {
                        if y0 == 0 {
                            [128, 128, 128]
                        } else {
                            let j = ((y0 - 1) * w + x) * 4;
                            [rgba[j], rgba[j + 1], rgba[j + 2]]
                        }
                    }
                };
                rgba[i..i + 3].copy_from_slice(&px);
            }
        }
    }
}

/// Box-downscale by an integer factor so the long side fits `max_dim`.
pub fn downscale(w: usize, h: usize, rgba: &[u8], max_dim: usize) -> (usize, usize, Vec<u8>) {
    let f = w.max(h).div_ceil(max_dim.max(1)).max(1);
    if f == 1 {
        return (w, h, rgba.to_vec());
    }
    let (ow, oh) = (w.div_ceil(f), h.div_ceil(f));
    let mut out = vec![255u8; ow * oh * 4];
    for oy in 0..oh {
        for ox in 0..ow {
            let mut s = [0u32; 3];
            let mut n = 0u32;
            for y in oy * f..((oy + 1) * f).min(h) {
                for x in ox * f..((ox + 1) * f).min(w) {
                    let i = (y * w + x) * 4;
                    s[0] += rgba[i] as u32;
                    s[1] += rgba[i + 1] as u32;
                    s[2] += rgba[i + 2] as u32;
                    n += 1;
                }
            }
            let o = (oy * ow + ox) * 4;
            for c in 0..3 {
                out[o + c] = ((s[c] + n / 2) / n.max(1)) as u8;
            }
        }
    }
    (ow, oh, out)
}

/// Forgiving decode to RGBA. Errors only when no frame header can be found at all.
pub fn decode(data: &[u8], opts: &DecodeOpts) -> Result<Decoded, String> {
    let parsed = parse(data, false);
    decode_parsed(parsed, opts)
}

pub fn decode_parsed(parsed: Parsed, opts: &DecodeOpts) -> Result<Decoded, String> {
    let Some(img) = parsed.img.as_ref() else {
        return Err("unreadable".into());
    };
    let planes = render_planes(img, &parsed, opts);
    let mut rgba = planes_to_rgba(&planes);
    let donor_px = if opts.fill == Fill::Donor {
        opts.donor.as_ref().and_then(|d| {
            let dd = decode(d, &DecodeOpts::default()).ok()?;
            Some(resize_nearest(dd.width, dd.height, &dd.rgba, img.width, img.height))
        })
    } else {
        None
    };
    apply_fill(img, &mut rgba, opts, donor_px.as_deref());
    let (mut w, mut h) = (img.width, img.height);
    if let Some(md) = opts.max_dim {
        let (a, b, c) = downscale(w, h, &rgba, md);
        w = a;
        h = b;
        rgba = c;
    }
    Ok(Decoded { width: w, height: h, rgba, events: parsed.events })
}

pub fn resize_nearest(w: usize, h: usize, rgba: &[u8], ow: usize, oh: usize) -> Vec<u8> {
    let mut out = vec![255u8; ow * oh * 4];
    if w == 0 || h == 0 {
        return out;
    }
    for y in 0..oh {
        let sy = y * h / oh.max(1);
        for x in 0..ow {
            let sx = x * w / ow.max(1);
            let s = (sy * w + sx) * 4;
            let d = (y * ow + x) * 4;
            out[d..d + 4].copy_from_slice(&rgba[s..s + 4]);
        }
    }
    out
}
