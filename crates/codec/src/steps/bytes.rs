//! Bytes group: truncate, bitflip, byte_delete, byte_insert, fake_marker, dc_offset,
//! restart_markers, rst_strip_loss, zero_run, byte_swap16, splice.

use super::*;
use crate::markers::is_rst;

fn p_start(def: f64) -> ParamInfo {
    p_float("start", "Region start (%)", 0.0, 100.0, 0.5, def).expert().hint("Where in the image data damage may begin")
}
fn p_end(def: f64) -> ParamInfo {
    p_float("end", "Region end (%)", 0.0, 100.0, 0.5, def).expert()
}

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "truncate",
            "Cut the file short",
            "Bytes",
            Layer::Byte,
            false,
            false,
            false,
            "The file just stops. The decoder has nothing left to read, so every block after that point becomes plain grey. That's the flat grey slab you see in recovered photos.",
            vec![
                p_float("percent", "Keep (%)", 0.0, 100.0, 0.1, 60.0),
                p_int("byte", "Keep exactly (bytes)", -1, 1 << 30, -1).expert().hint("-1 = use the percentage"),
            ],
        ),
        info(
            "bitflip",
            "Flip random bits",
            "Bytes",
            Layer::Byte,
            false,
            true,
            false,
            "Single bits in the compressed data flip, like on a failing card. The decoder misreads one code and then everything after it is decoded out of step: a streak of garbage and a colour shift until it recovers.",
            vec![
                p_float("rate", "Flips per 100 KB", 0.1, 200.0, 0.1, 3.0)
                    .hint("Bit flips per 100 KB of image data (1 = one flip in a 100 KB photo); at least one flip always happens"),
                p_start(0.0),
                p_end(100.0),
            ],
        ),
        info(
            "byte_delete",
            "Delete bytes",
            "Bytes",
            Layer::Byte,
            false,
            true,
            false,
            "A few bytes vanish. Everything after slides up, so the rest of the picture shifts sideways and the brightness and colour drift.",
            vec![p_int("count", "How many places", 1, 1000, 1), p_int("length", "Bytes each", 1, 1 << 20, 1).expert(), p_start(20.0), p_end(80.0)],
        ),
        info(
            "byte_insert",
            "Insert bytes",
            "Bytes",
            Layer::Byte,
            false,
            true,
            false,
            "Extra bytes are slipped into the data. The decoder reads them as if they were picture, then carries on out of step: shifted rows and a colour jump.",
            vec![
                p_int("count", "How many places", 1, MAX_PLACES as i64, 1),
                p_int("length", "Bytes each", 1, MAX_INSERT as i64, 4).expert(),
                p_start(20.0),
                p_end(80.0),
                p_text("hex", "Bytes to insert (hex)", "").expert().hint("Empty = random bytes"),
            ],
        ),
        info(
            "fake_marker",
            "Inject markers",
            "Bytes",
            Layer::Byte,
            true,
            true,
            false,
            "A marker is a 0xFF byte followed by a command. Dropped into the picture data, it makes the decoder think the data has ended, so the rest turns grey (or, for restart markers, jumps).",
            vec![
                p_enum("marker", "Marker", &[("eoi", "End of image"), ("rst", "Restart (RSTn)"), ("sos", "Start of scan"), ("soi", "Start of image"), ("dht", "Huffman table"), ("random", "Random")], "rst"),
                p_int("count", "How many", 1, 100, 1),
                p_start(10.0),
                p_end(90.0),
            ],
        ),
        info(
            "dc_offset",
            "Tint from here on",
            "Bytes",
            Layer::Coeff,
            false,
            false,
            false,
            "Each block stores its average as a difference from the block before. Damage one difference and every following block inherits the error, so the picture takes on a tint from that point on (until the next restart marker).",
            vec![
                p_enum("component", "Channel", COMPONENTS, "2"),
                p_int("amount", "Amount", -255, 255, 60).hint("Brightness/colour levels added"),
                p_float("at", "Starting at (%)", 0.0, 100.0, 0.5, 50.0),
            ],
        ),
        info(
            "restart_markers",
            "Restart markers",
            "Bytes",
            Layer::Coeff,
            true,
            false,
            false,
            "Restart markers are checkpoints in the data. With them, damage is fenced into horizontal strips; without them, one error ruins everything below it.",
            vec![p_int("interval", "Every N blocks (MCUs)", -1, 4096, -1).hint("-1 = one row, 0 = none")],
        ),
        info(
            "rst_strip_loss",
            "Lose restart strips",
            "Bytes",
            Layer::Byte,
            true,
            true,
            false,
            "Whole stretches between restart markers go missing. A decoder that checks marker numbers leaves grey gaps; one that doesn't simply pulls the later strips up, so the picture comes out shorter with grey at the bottom.",
            vec![
                p_int("count", "Strips lost", 1, 100, 3),
                p_enum("behaviour", "Decoder behaviour", &[("collapse", "Strips slide up"), ("gaps", "Grey gaps (by marker number)")], "collapse"),
            ],
        ),
        info(
            "zero_run",
            "Zeroed runs",
            "Bytes",
            Layer::Byte,
            false,
            true,
            false,
            "Runs of bytes are wiped to zero, as when a card or rescue tool fills unreadable areas. Zeros decode as the same tiny value over and over, giving smeared, repeating flat blocks.",
            vec![p_int("count", "Runs", 1, 100, 3), p_int("length", "Bytes per run", 1, 1 << 20, 4096), p_start(0.0), p_end(100.0)],
        ),
        info(
            "byte_swap16",
            "Byte-swapped dump",
            "Bytes",
            Layer::Byte,
            true,
            false,
            false,
            "Every pair of bytes is swapped, as in a dump read with the wrong 16-bit byte order. The data stops making sense almost immediately, so the image breaks into noise and grey.",
            vec![p_start(50.0), p_end(100.0)],
        ),
        info(
            "splice",
            "Splice in another photo",
            "Bytes",
            Layer::Byte,
            false,
            true,
            true,
            "Card-sized chunks of another photo's data end up inside this one, as when a recovery tool grabs the wrong clusters. The decoder happily decodes them, so a band of the other scene appears with wrong colours.",
            vec![
                p_photo("photo", "Other photo"),
                p_float("at", "Where (%)", 0.0, 100.0, 0.5, 50.0),
                p_int("clusters", "Clusters", 1, 256, 4),
                p_enum("cluster_kb", "Cluster size", &[("4", "4 KB"), ("8", "8 KB"), ("16", "16 KB"), ("32", "32 KB")], "8").expert(),
                p_enum("mode", "Mode", &[("replace", "Overwrite"), ("insert", "Insert")], "replace"),
            ],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "truncate" => truncate(p, input),
        "bitflip" => bitflip(p, input, ctx),
        "byte_delete" => byte_delete(p, input, ctx),
        "byte_insert" => byte_insert(p, input, ctx),
        "fake_marker" => fake_marker(p, input, ctx),
        "dc_offset" => dc_offset(p, input),
        "restart_markers" => restart_markers(p, input),
        "rst_strip_loss" => rst_strip_loss(p, input, ctx),
        "zero_run" => zero_run(p, input, ctx),
        "byte_swap16" => byte_swap16(p, input),
        "splice" => splice(p, input, ctx),
        _ => return None,
    })
}

fn truncate(p: &Value, input: &[u8]) -> StepResult {
    let b = get_i64(p, "byte", -1);
    let n = if b >= 0 { b as usize } else { (input.len() as f64 * get_f64(p, "percent", 60.0).clamp(0.0, 100.0) / 100.0) as usize };
    Ok(input[..n.min(input.len())].to_vec())
}

/// Sorted random positions in [a, b).
fn positions(rng: &mut Pcg32, a: usize, b: usize, n: usize) -> Vec<usize> {
    if b <= a {
        return Vec::new();
    }
    let mut v: Vec<usize> = (0..n).map(|_| a + (rng.next_u32() as usize % (b - a))).collect();
    v.sort_unstable();
    v
}

fn bitflip(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let (a, b) = region(input, p);
    // Unit: flips per 100 KB (102 400 bytes) of the chosen scan-data region.
    let rate = get_f64(p, "rate", 3.0).clamp(0.0, 100_000.0);
    let mut rng = ctx.rng();
    let expect = (b - a) as f64 * rate / 102_400.0;
    let mut n = expect.floor() as usize;
    if rng.unit() < expect - expect.floor() {
        n += 1;
    }
    if rate > 0.0 && n == 0 {
        n = 1;
    }
    let mut out = input.to_vec();
    for pos in positions(&mut rng, a, b, n.min(10_000_000)) {
        out[pos] ^= 1 << rng.below(8);
    }
    Ok(out)
}

/// The catalog ranges, enforced here too: recipes and links are imported without the UI's clamps.
const MAX_PLACES: usize = 1000;
const MAX_DELETE: usize = 1 << 20;
/// 1000 places x 64 KB = 64 MB at most; a megabyte per place could ask for a 1 GB file.
const MAX_INSERT: usize = 1 << 16;

fn byte_delete(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let (a, b) = region(input, p);
    let count = get_i64(p, "count", 1).clamp(1, MAX_PLACES as i64) as usize;
    let len = get_i64(p, "length", 1).clamp(1, MAX_DELETE as i64) as usize;
    let mut rng = ctx.rng();
    let mut out = input.to_vec();
    for pos in positions(&mut rng, a, b, count).into_iter().rev() {
        let e = (pos + len).min(out.len());
        out.drain(pos..e);
    }
    Ok(out)
}

fn parse_hex(s: &str) -> Vec<u8> {
    let h: Vec<u8> = s.bytes().filter(|c| c.is_ascii_hexdigit()).collect();
    h.chunks(2)
        .filter(|c| c.len() == 2)
        .filter_map(|c| u8::from_str_radix(std::str::from_utf8(c).ok()?, 16).ok())
        .collect()
}

fn byte_insert(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let (a, b) = region(input, p);
    let count = get_i64(p, "count", 1).clamp(1, MAX_PLACES as i64) as usize;
    let len = get_i64(p, "length", 4).clamp(1, MAX_INSERT as i64) as usize;
    let mut hex = parse_hex(get_str(p, "hex", ""));
    hex.truncate(MAX_INSERT);
    let mut rng = ctx.rng();
    let pos = positions(&mut rng, a, b, count);
    // The bytes are drawn last place first (the order the old splice-per-place loop used, so
    // recipes keep their output), then the file is put together in one forward pass.
    let mut chunks: Vec<Vec<u8>> = vec![Vec::new(); pos.len()];
    for i in (0..pos.len()).rev() {
        chunks[i] = if hex.is_empty() { (0..len).map(|_| rng.next_u32() as u8).collect() } else { hex.clone() };
    }
    let mut out = Vec::with_capacity(input.len() + chunks.iter().map(Vec::len).sum::<usize>());
    let mut at = 0;
    for (&p, bytes) in pos.iter().zip(&chunks) {
        out.extend_from_slice(&input[at..p]);
        out.extend_from_slice(bytes);
        at = p;
    }
    out.extend_from_slice(&input[at..]);
    Ok(out)
}

fn fake_marker(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let (a, b) = region(input, p);
    let count = get_i64(p, "count", 1).clamp(1, 10_000) as usize;
    let kind = get_str(p, "marker", "rst");
    let mut rng = ctx.rng();
    let mut out = input.to_vec();
    for pos in positions(&mut rng, a, b, count).into_iter().rev() {
        let code = match kind {
            "eoi" => 0xD9,
            "sos" => 0xDA,
            "soi" => 0xD8,
            "dht" => 0xC4,
            "random" => 0x01 + (rng.next_u32() % 0xFE) as u8,
            _ => 0xD0 + rng.below(8) as u8,
        };
        out.splice(pos..pos, [0xFF, code]);
    }
    Ok(out)
}

fn dc_offset(p: &Value, input: &[u8]) -> StepResult {
    let (mut img, s) = co_in(input)?;
    let ci = component(p, "component", 2);
    if ci >= img.comps.len() {
        return Err("this image has no such channel".into());
    }
    let amount = get_i64(p, "amount", 60).clamp(-4096, 4096);
    let at = get_f64(p, "at", 50.0).clamp(0.0, 100.0);
    let (gx, gy) = img.mcu_grid();
    let total = gx * gy;
    let start = ((total as f64 * at / 100.0) as usize).min(total.saturating_sub(1));
    let ri = s.restart_interval;
    let end = if ri > 0 { (start / ri + 1) * ri } else { total };
    let blocks: Vec<(usize, usize, usize)> = {
        let c = &img.comps[ci];
        (0..c.bh).flat_map(|by| (0..c.bw).map(move |bx| (bx, by))).map(|(bx, by)| (bx, by, img.mcu_of_block(ci, bx, by))).collect()
    };
    let c = &mut img.comps[ci];
    let delta = ((amount * 8) as f64 / c.q[0].max(1) as f64).round() as i32;
    for (bx, by, m) in blocks {
        {
            if m >= start && m < end {
                let i = (by * c.bw + bx) * 64;
                c.coef[i] = (c.coef[i] as i32 + delta).clamp(-32767, 32767) as i16;
            }
        }
    }
    Ok(co_out(&img, &s))
}

fn restart_markers(p: &Value, input: &[u8]) -> StepResult {
    let (img, mut s) = co_in(input)?;
    let iv = get_i64(p, "interval", -1);
    s.restart_interval = if iv < 0 { img.mcu_grid().0.max(1) } else { iv.min(65535) as usize };
    Ok(co_out(&img, &s))
}

/// (start, end) of every restart interval's bytes in the first scan, each including its
/// terminating RST marker.
fn intervals(d: &[u8]) -> Vec<(usize, usize)> {
    let (a, b) = walk(d).first_scan_data().unwrap_or((0, 0));
    let mut v = Vec::new();
    let mut start = a;
    let mut i = a;
    while i + 1 < b.min(d.len()) {
        if d[i] == 0xFF && is_rst(d[i + 1]) {
            v.push((start, i + 2));
            start = i + 2;
            i += 2;
        } else {
            i += 1;
        }
    }
    v
}

fn rst_strip_loss(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let d = with_restarts(input)?;
    let iv = intervals(&d);
    if iv.len() < 2 {
        return Err("not enough restart strips to lose".into());
    }
    let count = (get_i64(p, "count", 3).clamp(1, 10_000) as usize).min(iv.len() - 1);
    let collapse = get_str(p, "behaviour", "collapse") != "gaps";
    let mut rng = ctx.rng();
    let mut idx: Vec<usize> = (1..iv.len()).collect();
    for i in (1..idx.len()).rev() {
        let j = rng.below(i as u32 + 1) as usize;
        idx.swap(i, j);
    }
    let mut lost: Vec<usize> = idx.into_iter().take(count).collect();
    lost.sort_unstable();
    let mut out = Vec::with_capacity(d.len());
    let mut pos = 0;
    for &k in &lost {
        let (s, e) = iv[k];
        out.extend_from_slice(&d[pos..s]);
        pos = e;
    }
    out.extend_from_slice(&d[pos..]);
    if collapse {
        // Renumber the restart markers so the decoder cannot notice anything is missing.
        let (a, _) = walk(&out).first_scan_data().unwrap_or((0, 0));
        let b = crate::markers::scan_data_end(&out, a);
        let mut n = 0u8;
        let mut i = a;
        while i + 1 < b {
            if out[i] == 0xFF && is_rst(out[i + 1]) {
                out[i + 1] = 0xD0 + (n & 7);
                n = n.wrapping_add(1);
                i += 2;
            } else {
                i += 1;
            }
        }
    }
    Ok(out)
}

fn zero_run(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let (a, b) = region(input, p);
    // Catalog ranges: 10 000 runs of 64 MB were tens of GB of writes.
    let count = get_i64(p, "count", 3).clamp(1, 100) as usize;
    let len = get_i64(p, "length", 4096).clamp(1, 1 << 20) as usize;
    let mut rng = ctx.rng();
    let mut out = input.to_vec();
    for pos in positions(&mut rng, a, b, count) {
        let e = (pos + len).min(b);
        out[pos..e].fill(0);
    }
    Ok(out)
}

fn byte_swap16(p: &Value, input: &[u8]) -> StepResult {
    let pp = serde_json::json!({ "start": get_f64(p, "start", 50.0), "end": get_f64(p, "end", 100.0) });
    let (a, b) = region(input, &pp);
    let mut out = input.to_vec();
    let mut i = a;
    while i + 1 < b {
        out.swap(i, i + 1);
        i += 2;
    }
    Ok(out)
}

fn splice(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let donor = pick_photo(p, "photo", ctx)?;
    let ckb = match p.get("cluster_kb") {
        Some(Value::String(s)) => s.parse().unwrap_or(8),
        Some(v) => v.as_i64().unwrap_or(8),
        None => 8,
    }
    .clamp(1, 64) as usize;
    let cl = ckb * 1024;
    // Catalog range (an imported recipe could otherwise ask for 4096 x 1 MB = 4 GB).
    let n = get_i64(p, "clusters", 4).clamp(1, 256) as usize;
    let at = get_f64(p, "at", 50.0).clamp(0.0, 100.0);
    let insert = get_str(p, "mode", "replace") == "insert";
    let mut rng = ctx.rng();
    let (da, db) = scan_range(donor);
    let want = n * cl;
    let chunk: Vec<u8> = if db > da {
        let avail = db - da;
        let start = if avail > want { da + (rng.next_u32() as usize % (avail - want + 1)) / cl * cl } else { da };
        let mut c = donor[start..(start + want).min(db)].to_vec();
        while c.len() < want && !c.is_empty() {
            let more = c.clone();
            c.extend_from_slice(&more[..(want - c.len()).min(more.len())]);
        }
        c
    } else {
        return Err("the other photo has no image data".into());
    };
    let (a, b) = scan_range(input);
    let target = a + ((b - a) as f64 * at / 100.0) as usize;
    let pos = ((target / cl) * cl).clamp(a, b);
    let mut out = input.to_vec();
    if insert {
        out.splice(pos..pos, chunk);
    } else {
        let e = (pos + chunk.len()).min(out.len());
        out.splice(pos..e, chunk);
    }
    Ok(out)
}
