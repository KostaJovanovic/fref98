//! Displace: the "recovered from a card" look. A carver glued the photo's body on at the wrong
//! place, so every block lands a few places early (the picture wraps sideways with a vertical
//! seam), stale data from an old file sits on top, later lost clusters add more seams, and the run
//! may cross into another photo's fragment. The MCUs lost at the start are missing at the end.
//!
//! The splice is done block by block on the coefficients (so the seam lands exactly where asked
//! and the tables never have to match), with the same DC predictor carry-over a decoder would see
//! at each cut, then re-encoded and really cut short.

use super::*;
use crate::coeffs::CoeffImage;
use crate::markers::{neutralise_markers, SOS};

pub fn infos() -> Vec<StepInfo> {
    vec![info(
        "displace",
        "Displaced (bad recovery)",
        "Recovery",
        Layer::Byte,
        false,
        true,
        true,
        "A recovery tool glued the photo's data on a little too late, so every block lands a few places early: the picture wraps sideways around a seam. Each cut also throws off the colour, stale data from an old file shows as a noisy strip on top, and the run can end in another photo. The blocks lost at the start are missing at the bottom.",
        vec![
            p_int("shifts", "Shifts", 1, 4, 2).hint("How many cuts: the first one at the top, the rest lower down"),
            p_float("lost_kb", "Data lost at the start (KB)", -16.0, 64.0, 0.5, 8.0).hint("Negative = extra stale data instead"),
            p_float("seam_x", "Where the first seam is", 0.0, 1.0, 0.01, 0.6).hint("0 = left edge, 1 = right edge"),
            p_float("first_row", "Later shifts from", 0.0, 0.9, 0.05, 0.0).expert().hint("0 = spread them automatically"),
            p_float("top_garbage_kb", "Stale data on top (KB)", 0.0, 8.0, 0.25, 2.0),
            p_float("foreign_from", "Other photo from", 0.0, 1.0, 0.05, 1.0).hint("Where the run crosses into another photo; 1 = never"),
            p_photo("foreign_photo", "Other photo"),
            p_bool("natural_cast", "Colour shift at each cut", true).expert(),
            p_bool("neutralise_markers", "Neutralise stray markers", true).expert().hint("In the stale data, so it never stops the decode early"),
            p_bool("drop_orientation", "Lose the Exif (orientation)", true).expert(),
        ],
    )]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    match id {
        "displace" => Some(displace(p, input, ctx)),
        _ => None,
    }
}

/// Blocks of MCU `m` (mcu_grid raster order) in decode order: (component, bx, by).
fn blocks_of(img: &CoeffImage, m: usize) -> Vec<(usize, usize, usize)> {
    if img.comps.len() == 1 {
        let c = &img.comps[0];
        return vec![(0, m % c.wib, m / c.wib)];
    }
    let (mx, my) = (m % img.mcux, m / img.mcux);
    let mut v = Vec::new();
    for (ci, c) in img.comps.iter().enumerate() {
        for j in 0..c.v {
            for i in 0..c.h {
                v.push((ci, mx * c.h + i, my * c.v + j));
            }
        }
    }
    v
}

fn mcu_count(img: &CoeffImage) -> usize {
    let (gx, gy) = img.mcu_grid();
    gx * gy
}

fn same_layout(a: &CoeffImage, b: &CoeffImage) -> bool {
    a.comps.len() == b.comps.len() && a.comps.iter().zip(&b.comps).all(|(x, y)| x.h == y.h && x.v == y.v)
}

/// DC of each component's last block in MCU `m - 1`: what the decoder's predictor holds when the
/// data for MCU `m` starts (0 at the very start).
fn src_pred(img: &CoeffImage, m: usize) -> Vec<i32> {
    let mut pred = vec![0; img.comps.len()];
    if m > 0 {
        for (ci, bx, by) in blocks_of(img, m - 1) {
            pred[ci] = img.comps[ci].block(bx, by)[0] as i32;
        }
    }
    pred
}

/// Writes the output MCU by MCU, keeping the DC carry-over a decoder sees across each cut.
struct Splicer {
    out: CoeffImage,
    n: usize,
    p: usize,
    pred: Vec<i32>,
    natural_cast: bool,
}

impl Splicer {
    /// Copies source MCUs `from..` until `until` output MCUs are written or the source runs out.
    fn run(&mut self, src: &CoeffImage, from: usize, until: usize) -> usize {
        let sn = mcu_count(src);
        let offset: Vec<i32> = if !self.natural_cast {
            vec![0; self.pred.len()]
        } else {
            self.pred.iter().zip(src_pred(src, from)).map(|(o, s)| o - s).collect()
        };
        let mut m = from;
        while self.p < until.min(self.n) && m < sn {
            let dst = blocks_of(&self.out, self.p);
            for ((ci, sx, sy), (_, dx, dy)) in blocks_of(src, m).into_iter().zip(dst) {
                let b = src.comps[ci].block(sx, sy);
                let mut blk = [0i16; 64];
                blk.copy_from_slice(b);
                blk[0] = (blk[0] as i32 + offset[ci]).clamp(-2047, 2047) as i16;
                self.pred[ci] = blk[0] as i32;
                let c = &mut self.out.comps[ci];
                c.block_mut(dx, dy).copy_from_slice(&blk);
                c.seen[dy * c.bw + dx] = 1;
            }
            self.p += 1;
            m += 1;
        }
        m
    }
}

/// Stale bytes for the top strip: a stretch of scan data from a pool photo (an old file's
/// leftovers), or from the photo itself when the pool is empty.
fn stale_bytes(input: &[u8], ctx: &StepCtx, len: usize, rng: &mut Pcg32) -> Vec<u8> {
    let src = if ctx.pool.is_empty() { input } else { ctx.pool[rng.below(ctx.pool.len() as u32) as usize].as_slice() };
    let (a, b) = scan_range(src);
    let data = if b > a + 64 { &src[a..b] } else { src };
    let mut out = Vec::with_capacity(len);
    let mut at = rng.below(data.len().max(1) as u32) as usize;
    while out.len() < len && !data.is_empty() {
        let take = (len - out.len()).min(data.len() - at);
        out.extend_from_slice(&data[at..at + take]);
        at = 0;
    }
    out
}

/// Decodes `stale` as if it were this photo's scan data; returns the coefficients and how many
/// MCUs began within the first `kb` KB of it.
fn decode_stale(header: &[u8], stale: &[u8], kb: f64) -> Option<(CoeffImage, usize, usize)> {
    let mut fake = header.to_vec();
    let start = fake.len();
    fake.extend_from_slice(stale);
    fake.extend_from_slice(&[0xFF, 0xD9]);
    let parsed = parse(&fake, false);
    let limit = ((start as f64 + kb * 1024.0) * 8.0) as u64;
    let bits = &parsed.mcu_bits;
    let decoded = bits.iter().take_while(|&&b| b != u32::MAX).count().saturating_sub(1);
    let within = bits.iter().take(decoded).filter(|&&b| (b as u64) < limit).count();
    Some((parsed.img?, within, decoded))
}

fn displace(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let mut rng = ctx.rng();
    let (img, mut s) = co_in(input)?;
    s.progressive = false;
    s.scans = None;
    s.restart_interval = 0;
    if get_bool(p, "drop_orientation", true) {
        s.segments.retain(|(m, _)| *m != 0xE1);
    }
    let (gx, gy) = img.mcu_grid();
    let n = gx * gy;
    let clean = co_out(&img, &s);
    let (sos_end, scan_end) = scan_range(&clean);
    let bits_per_mcu = ((scan_end - sos_end) as f64 * 8.0 / n as f64).max(1.0);
    let kb_to_mcus = |kb: f64| (kb * 1024.0 * 8.0 / bits_per_mcu).round() as i64;

    let shifts = get_i64(p, "shifts", 2).clamp(1, 4) as usize;
    let lost_kb = get_f64(p, "lost_kb", 8.0).clamp(-16.0, 64.0);
    let seam_col = (get_f64(p, "seam_x", 0.6).clamp(0.0, 1.0) * gx as f64).round() as i64 % gx as i64;
    let first_row = get_f64(p, "first_row", 0.0).clamp(0.0, 0.9);
    let garbage_kb = get_f64(p, "top_garbage_kb", 2.0).clamp(0.0, 8.0);
    let foreign_from = get_f64(p, "foreign_from", 1.0).clamp(0.0, 1.0);
    let natural_cast = get_bool(p, "natural_cast", true);

    // Stale data on top (plus extra when data was gained instead of lost).
    let gained_kb = (-lost_kb).max(0.0);
    let header = clean[..walk(&clean).first(SOS).map(|x| x.end).ok_or_else(unreadable)?].to_vec();
    let mut stale = stale_bytes(input, ctx, ((garbage_kb + gained_kb + 4.0) * 1024.0) as usize, &mut rng);
    if get_bool(p, "neutralise_markers", true) {
        neutralise_markers(&mut stale);
    }
    let (garbage, g, g_avail) = if garbage_kb + gained_kb > 0.0 {
        decode_stale(&header, &stale, garbage_kb).ok_or_else(unreadable)?
    } else {
        (img.clone(), 0, 0)
    };
    let g = g.min(n / 3);

    // First cut. Output index = source index + d, so every source row starts at column d mod gx:
    // pick the d nearest the lost/gained amount that puts that seam at `seam_col`.
    let gx_i = gx as i64;
    let d0 = g as i64 - kb_to_mcus(lost_kb);
    let mut delta = (seam_col - d0).rem_euclid(gx_i);
    if delta > gx_i / 2 {
        delta -= gx_i;
    }
    let d = d0 + delta;
    let (extra, k) = if d >= g as i64 { ((d - g as i64) as usize, 0) } else { (0, (g as i64 - d) as usize) };
    let extra = extra.min(g_avail.saturating_sub(g)).min(n / 3);
    let k = k.min(n - 1);

    let mut out = img.clone();
    for c in &mut out.comps {
        c.coef.iter_mut().for_each(|x| *x = 0);
        c.seen.iter_mut().for_each(|x| *x = 0);
    }
    let mut sp = Splicer { out, n, p: 0, pred: vec![0; img.comps.len()], natural_cast };
    if g + extra > 0 {
        sp.run(&garbage, 0, g + extra);
    }

    // Where the later cuts and the foreign photo start (output MCU index).
    let foreign_at = (foreign_from < 1.0).then(|| ((foreign_from * gy as f64) as usize * gx + rng.below(gx as u32) as usize).max(sp.p + gx));
    let lo = if first_row > 0.0 { first_row } else { 0.3 };
    let hi = foreign_at.map(|f| f as f64 / n as f64).unwrap_or(0.95).max(lo + 0.05);
    let step = (hi - lo) / (shifts.max(2) - 1) as f64;
    let mut cuts: Vec<usize> = (1..shifts)
        .map(|i| {
            let f = lo + step * (i as f64 - 1.0) + rng.unit() * step * 0.6;
            ((f * gy as f64) as usize * gx + rng.below(gx as u32) as usize).max(sp.p + 1).min(n - 1)
        })
        .collect();
    cuts.sort_unstable();

    let own_end = foreign_at.unwrap_or(n);
    let mut m = k;
    for &cut in cuts.iter().filter(|&&c| c < own_end) {
        m = sp.run(&img, m, cut);
        // A lost cluster: skip some source data; the seam jumps by however many MCUs that was.
        m += kb_to_mcus(2.0 + rng.unit() * (6.0 + lost_kb.abs() / 2.0)).max(1) as usize;
        if m >= n {
            break;
        }
    }
    if m < n {
        sp.run(&img, m, own_end);
    }

    if let Some(at) = foreign_at {
        let fp = pick_photo(p, "foreign_photo", ctx)?;
        let (mut fi, _) = co_in(fp)?;
        if !same_layout(&fi, &img) {
            let (rgba, _) = px_in(fp)?;
            fi = co_in(&encoder::encode_rgba(rgba.w, rgba.h, &rgba.px, &s))?.0;
        }
        let fnn = mcu_count(&fi);
        let need = n - sp.p.min(at);
        let kf = ((0.2 + rng.unit() * 0.4) * fnn as f64) as usize;
        let kf = kf.min(fnn.saturating_sub(need));
        sp.p = sp.p.min(at);
        sp.run(&fi, kf, n);
    }

    let filled = sp.p;
    let mut bytes = co_out(&sp.out, &s);
    if filled < n {
        // The data really runs out here: cut the file at that MCU.
        let bits = parse(&bytes, false).mcu_bits;
        if let Some(&b) = bits.get(filled).filter(|&&b| b != u32::MAX) {
            bytes.truncate((b / 8) as usize);
            bytes.extend_from_slice(&[0xFF, 0xD9]);
        }
    }
    Ok(bytes)
}
