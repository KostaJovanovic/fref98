//! Quantise group: requantize, qtable_decode_swap, coeff_kill, coeff_paint.

use super::*;
use crate::markers::{segment, DQT};
use crate::tables::{scaled_table, NATURAL_ORDER, STD_CHROMA_Q, STD_LUMA_Q};

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "requantize",
            "Re-save at quality",
            "Quantise",
            Layer::Pixel,
            false,
            false,
            false,
            "The photo is saved again with coarser rounding of its 8x8 frequency blocks. Fine detail gets rounded away, so you see blocky squares and ringing around edges.",
            vec![
                p_int("quality", "Quality", 1, 100, 25).hint("Lower = harsher rounding, bigger blocks"),
                p_table("luma_table", "Brightness table").hint("Custom 8x8 table for Y (overrides quality)"),
                p_table("chroma_table", "Colour table").hint("Custom 8x8 table for Cb/Cr (overrides quality)"),
                p_bool("swap_tables", "Swap brightness/colour tables", false).expert().hint("Brightness gets the coarse colour table and vice versa"),
            ],
        ),
        info(
            "qtable_decode_swap",
            "Wrong decoding tables",
            "Quantise",
            Layer::Byte,
            true,
            false,
            false,
            "Only the quantisation tables in the header are changed; the image data stays the same. The decoder multiplies every frequency by the wrong numbers, so contrast, texture and colour go strange.",
            vec![
                p_enum("mode", "Mode", &[("scale", "Scale tables"), ("swap", "Swap Y/C tables"), ("table", "Replace with quality tables")], "scale"),
                p_float("factor", "Scale factor", 0.1, 8.0, 0.1, 2.0).hint("Mode 'scale': multiply every entry"),
                p_int("quality", "Table quality", 1, 100, 10).expert().hint("Mode 'table': which libjpeg quality's tables to write"),
            ],
        ),
        info(
            "coeff_kill",
            "Kill frequencies",
            "Quantise",
            Layer::Coeff,
            true,
            false,
            false,
            "Chosen frequencies in every 8x8 block are set to zero. Kill the high ones and blocks go soft and flat; kill the low ones and only ghostly edges remain.",
            vec![
                p_int("from", "From (zigzag)", 0, 63, 10).hint("0 = DC (average), 63 = finest detail"),
                p_int("to", "To (zigzag)", 0, 63, 63),
                p_enum("component", "Channel", &[("all", "All"), ("0", "Y (brightness)"), ("1", "Cb (blue-yellow)"), ("2", "Cr (red-green)")], "all"),
            ],
        ),
        info(
            "coeff_paint",
            "Paint coefficients",
            "Quantise",
            Layer::Coeff,
            false,
            false,
            false,
            "Inside the painted area the stored frequencies of each 8x8 block are zeroed, boosted or rounded harder. That is why the effect snaps to a grid of little squares.",
            vec![
                p_mask("mask", "Painted area").hint("Empty = whole image"),
                p_enum("mode", "Mode", &[("zero", "Smear (zero detail)"), ("boost", "Exaggerate"), ("harsh", "Harsher rounding")], "zero"),
                p_float("strength", "Strength", 0.0, 1.0, 0.05, 0.7),
            ],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    let _ = ctx;
    Some(match id {
        "requantize" => requantize(p, input),
        "qtable_decode_swap" => qtable_decode_swap(p, input),
        "coeff_kill" => coeff_kill(p, input),
        "coeff_paint" => coeff_paint(p, input),
        _ => return None,
    })
}

pub(crate) fn table_param(p: &Value, key: &str) -> Option<[u16; 64]> {
    let a = p.get(key)?.as_array()?;
    if a.len() != 64 {
        return None;
    }
    let mut t = [1u16; 64];
    for (i, v) in a.iter().enumerate() {
        t[i] = v.as_f64().unwrap_or(1.0).clamp(1.0, 255.0) as u16;
    }
    Some(t)
}

fn requantize(p: &Value, input: &[u8]) -> StepResult {
    let (img, mut s) = px_in(input)?;
    let q = get_i64(p, "quality", 25).clamp(1, 100) as i32;
    let mut lq = scaled_table(&STD_LUMA_Q, q);
    let mut cq = scaled_table(&STD_CHROMA_Q, q);
    if let Some(t) = table_param(p, "luma_table") {
        lq = t;
    }
    if let Some(t) = table_param(p, "chroma_table") {
        cq = t;
    }
    if get_bool(p, "swap_tables", false) {
        std::mem::swap(&mut lq, &mut cq);
    }
    s.qtables = s.comps.iter().enumerate().map(|(i, _)| if i == 0 { lq } else { cq }).collect();
    Ok(px_out(&img, &s))
}

fn qtable_decode_swap(p: &Value, input: &[u8]) -> StepResult {
    let l = walk(input);
    let mode = get_str(p, "mode", "scale");
    let factor = get_f64(p, "factor", 2.0).clamp(0.01, 100.0);
    let quality = get_i64(p, "quality", 10).clamp(1, 100) as i32;
    let dqts: Vec<_> = l.segments.iter().filter(|s| s.marker == DQT).cloned().collect();
    if dqts.is_empty() {
        return Err("no quantisation tables found".into());
    }
    // Collect all tables (zigzag order) by id.
    let mut tables: Vec<(u8, u8, [u16; 64])> = Vec::new();
    for s in &dqts {
        let d = s.payload(input);
        let mut i = 0;
        while i < d.len() {
            let pq = d[i] >> 4;
            let id = d[i] & 15;
            i += 1;
            let mut z = [1u16; 64];
            for (k, zk) in z.iter_mut().enumerate() {
                *zk = if pq == 0 { d.get(i + k).copied().unwrap_or(1) as u16 } else { d.get(i + 2 * k..i + 2 * k + 2).map(|b| ((b[0] as u16) << 8) | b[1] as u16).unwrap_or(1) };
            }
            i += if pq == 0 { 64 } else { 128 };
            tables.push((pq, id, z));
        }
    }
    match mode {
        "swap" => {
            let a = tables.iter().position(|t| t.1 == 0);
            let b = tables.iter().position(|t| t.1 == 1);
            if let (Some(a), Some(b)) = (a, b) {
                let (ta, tb) = (tables[a].2, tables[b].2);
                tables[a].2 = tb;
                tables[b].2 = ta;
            }
        }
        "table" => {
            for t in tables.iter_mut() {
                let nat = scaled_table(if t.1 == 0 { &STD_LUMA_Q } else { &STD_CHROMA_Q }, quality);
                for k in 0..64 {
                    t.2[k] = nat[NATURAL_ORDER[k]];
                }
            }
        }
        _ => {
            for t in tables.iter_mut() {
                let max = if t.0 == 0 { 255.0 } else { 65535.0 };
                for v in t.2.iter_mut() {
                    *v = (*v as f64 * factor).round().clamp(1.0, max) as u16;
                }
            }
        }
    }
    // Rewrite: first DQT segment carries all tables, later DQT segments are dropped.
    let mut payload = Vec::new();
    for (pq, id, z) in &tables {
        payload.push((pq << 4) | id);
        for &v in z {
            if *pq != 0 {
                payload.push((v >> 8) as u8);
            }
            payload.push(v as u8);
        }
    }
    let mut out = Vec::with_capacity(input.len());
    let mut pos = 0;
    for (k, s) in dqts.iter().enumerate() {
        out.extend_from_slice(&input[pos..s.offset]);
        if k == 0 {
            out.extend(segment(DQT, &payload));
        }
        pos = s.offset + s.length;
    }
    out.extend_from_slice(&input[pos..]);
    Ok(out)
}

fn comp_filter(p: &Value, n: usize) -> Vec<usize> {
    match p.get("component") {
        None => (0..n).collect(),
        Some(Value::String(s)) if s == "all" => (0..n).collect(),
        _ => {
            let c = component(p, "component", 0);
            if c < n {
                vec![c]
            } else {
                Vec::new()
            }
        }
    }
}

fn coeff_kill(p: &Value, input: &[u8]) -> StepResult {
    let (mut img, s) = co_in(input)?;
    let a = get_i64(p, "from", 10).clamp(0, 63) as usize;
    let b = get_i64(p, "to", 63).clamp(0, 63) as usize;
    let (a, b) = (a.min(b), a.max(b));
    for ci in comp_filter(p, img.comps.len()) {
        let c = &mut img.comps[ci];
        for blk in c.coef.chunks_mut(64) {
            for k in a..=b {
                blk[NATURAL_ORDER[k]] = 0;
            }
        }
    }
    Ok(co_out(&img, &s))
}

/// Mask value (0..255) for an MCU, scaling the mask grid to the image's MCU grid.
pub(crate) fn mask_at(mask: Option<&Value>, gx: usize, gy: usize, mx: usize, my: usize) -> u32 {
    let Some(m) = mask.filter(|m| !m.is_null()) else { return 255 };
    let w = m.get("w").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let h = m.get("h").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let Some(data) = m.get("data").and_then(|v| v.as_array()) else { return 255 };
    if w == 0 || h == 0 || data.len() < w * h {
        return 255;
    }
    let x = mx * w / gx.max(1);
    let y = my * h / gy.max(1);
    data[y.min(h - 1) * w + x.min(w - 1)].as_u64().unwrap_or(0).min(255) as u32
}

fn coeff_paint(p: &Value, input: &[u8]) -> StepResult {
    let (mut img, s) = co_in(input)?;
    let mode = get_str(p, "mode", "zero").to_string();
    let strength = get_f64(p, "strength", 0.7).clamp(0.0, 1.0);
    let (gx, gy) = img.mcu_grid();
    let mask = p.get("mask");
    let n = img.comps.len();
    for ci in 0..n {
        let (bw, bh) = (img.comps[ci].bw, img.comps[ci].bh);
        for by in 0..bh {
            for bx in 0..bw {
                let m = img.mcu_of_block(ci, bx, by);
                let mv = mask_at(mask, gx, gy, m % gx, m / gx);
                if mv == 0 {
                    continue;
                }
                let w = strength * mv as f64 / 255.0;
                let blk = img.comps[ci].block_mut(bx, by);
                match mode.as_str() {
                    "boost" => {
                        let f = 1.0 + 3.0 * w;
                        for v in blk[1..].iter_mut() {
                            *v = (*v as f64 * f).round().clamp(-32767.0, 32767.0) as i16;
                        }
                    }
                    "harsh" => {
                        let f = 1.0 + 15.0 * w;
                        for v in blk[1..].iter_mut() {
                            *v = ((*v as f64 / f).round() * f).round().clamp(-32767.0, 32767.0) as i16;
                        }
                    }
                    _ => {
                        let keep = (64.0 - 63.0 * w).round().clamp(1.0, 64.0) as usize;
                        for k in keep..64 {
                            blk[NATURAL_ORDER[k]] = 0;
                        }
                    }
                }
            }
        }
    }
    Ok(co_out(&img, &s))
}
