//! Card-level damage applied to a single photo's bytes, plus the full "pass through a card" round trip.

use crate::card::{CameraKind, Card};
use crate::carve;
use crate::fs::Fs;
use crate::jpeg;
use refragmenter_codec::step::*;
use serde_json::{json, Value};

fn body_start(d: &[u8], protect: bool) -> usize {
    if !protect {
        return 0;
    }
    jpeg::scan_start(d).unwrap_or(d.len().min(624)).min(d.len())
}

fn pool_body<'a>(ctx: &StepCtx<'a>, p: &Value) -> Result<&'a [u8], String> {
    let idx = get_i64(p, "photo", -1);
    let d = ctx
        .pool_photo(if idx < 0 { 0 } else { idx })
        .ok_or("This step needs another photo in My Pictures.")?;
    let s = jpeg::scan_start(d).unwrap_or(0);
    // A donor that ends right after its header has no picture data to lend (and an empty body would
    // make the steps that repeat it loop forever).
    let body = d.get(s..).filter(|b| !b.is_empty()).ok_or("The other photo has no picture data after its header.")?;
    Ok(body)
}

fn region(p: &Value, s: usize, len: usize) -> (usize, usize) {
    let a = get_f64(p, "start", 0.0).clamp(0.0, 100.0);
    let b = get_f64(p, "end", 100.0).clamp(0.0, 100.0);
    let span = len - s;
    let lo = s + (span as f64 * a.min(b) / 100.0) as usize;
    let hi = s + (span as f64 * a.max(b) / 100.0) as usize;
    (lo, hi.max(lo))
}

pub fn catalog() -> Vec<StepInfo> {
    let cluster = || p_int("cluster_kb", "Cluster size (KB)", 1, 128, 8).expert().hint("8 KB like a 512 MB camera card");
    let protect = || p_bool("protect_header", "Keep the header intact", true).expert();
    vec![
        StepInfo {
            id: "pass_through_card",
            label: "Pass through a dying SD card",
            group: "Card",
            layer: Layer::Card,
            expert: false,
            random: true,
            uses_pool: true,
            simulated: false,
            help: "Your photo is written to a virtual memory card next to other photos, something bad happens to the card, and a recovery tool digs it back out. Whatever the tool finds is what you get, glued-in neighbours and all.",
            params: vec![
                p_enum(
                    "scenario",
                    "What happened",
                    &[
                        ("junk_overwrite", "Deleted, then a PC wrote over it"),
                        ("fragmented", "Deleted while fragmented"),
                        ("burst", "Burst shot (files interleaved)"),
                        ("pc_reformat", "Reformatted on a PC"),
                        ("power_loss", "Battery died while saving"),
                        ("flash_failure", "Flash memory failing"),
                        ("fat32_undelete", "Undeleted from a big FAT32 card"),
                    ],
                    "junk_overwrite",
                ),
                p_enum(
                    "tool",
                    "Recovery tool",
                    &[
                        ("graft", "PhotoRec + rebuild orphans"),
                        ("photorec", "PhotoRec (carving)"),
                        ("recuva", "Undelete (Recuva-style)"),
                        ("fat", "Just open the card"),
                    ],
                    "graft",
                ),
                p_int("severity", "How bad?", 1, 10, 5),
                p_int("neighbours", "Neighbour photos", 1, 8, 3).expert(),
                cluster(),
            ],
        },
        StepInfo {
            id: "interleave",
            label: "Interleaved with another file",
            group: "Card",
            layer: Layer::Card,
            expert: false,
            random: false,
            uses_pool: true,
            simulated: false,
            help: "Two files were written at the same time, so the card stored them in alternating chunks. Reading one straight through picks up slices of the other: bands that switch between two photos.",
            params: vec![
                p_photo("photo", "Other file"),
                p_int("period", "Chunk length (clusters)", 1, 16, 2),
                p_float("start", "Starts at (%)", 0.0, 100.0, 1.0, 20.0),
                cluster(),
            ],
        },
        StepInfo {
            id: "cross_link",
            label: "Cross-linked clusters",
            group: "Card",
            layer: Layer::Card,
            expert: false,
            random: false,
            uses_pool: true,
            simulated: false,
            help: "After a crash the file table pointed this photo's chain into the middle of another photo. From that point on you're looking at someone else's picture, decoded with the wrong running colour values.",
            params: vec![p_photo("photo", "Other photo"), p_float("at", "Jumps at (%)", 0.0, 100.0, 1.0, 55.0), cluster()],
        },
        StepInfo {
            id: "stutter_read",
            label: "Stuttering card reader",
            group: "Card",
            layer: Layer::Card,
            expert: false,
            random: true,
            uses_pool: false,
            simulated: false,
            help: "A worn-out reader returned the same chunk twice. The decoder plays that piece again, so a band repeats and everything after it shifts and changes colour.",
            params: vec![p_int("count", "Repeats", 1, 32, 2), cluster(), protect()],
        },
        StepInfo {
            id: "dropped_sectors",
            label: "Dropped sectors",
            group: "Card",
            layer: Layer::Card,
            expert: true,
            random: true,
            uses_pool: false,
            simulated: false,
            help: "A bad reader skipped some 512-byte sectors. Each missing sector makes the rest of the picture slide sideways and drift in colour, many small times.",
            params: vec![p_int("count", "Sectors lost", 1, 256, 6), protect()],
        },
        StepInfo {
            id: "tool_fill_pattern",
            label: "Recovery tool fill pattern",
            group: "Card",
            layer: Layer::Card,
            expert: true,
            random: true,
            uses_pool: false,
            simulated: false,
            help: "Imaging tools can't read bad sectors, so they write a filler instead: zeros, 0xFF, or literally the text BAD SECTOR. The decoder dutifully turns that text into image.",
            params: vec![
                p_enum(
                    "tool",
                    "Filler",
                    &[("text", "\"BAD SECTOR\" text"), ("zeros", "Zeros (ddrescue)"), ("ff", "0xFF"), ("deadbeef", "DEADBEEF")],
                    "text",
                ),
                p_int("count", "Bad areas", 1, 64, 3),
                p_int("sectors", "Sectors each", 1, 64, 8),
                protect(),
            ],
        },
        StepInfo {
            id: "chipoff_xor",
            label: "Chip-off dump (not descrambled)",
            group: "Card",
            layer: Layer::Card,
            expert: true,
            random: true,
            uses_pool: false,
            simulated: false,
            help: "The memory chip was read directly, but the card's controller had scrambled every page with an XOR pattern that nobody removed. The result is noise with a rhythm to it.",
            params: vec![
                p_int("key_len", "Key length (bytes)", 1, 4096, 512),
                p_int("page_kb", "Page size (KB)", 2, 16, 4),
                p_float("strength", "Pages affected (%)", 0.0, 100.0, 1.0, 30.0),
                p_float("start", "Starts at (%)", 0.0, 100.0, 1.0, 40.0),
                p_bool("shuffle", "Pages out of order", false),
                protect(),
            ],
        },
        StepInfo {
            id: "flash_fault",
            label: "Flash memory fault",
            group: "Card",
            layer: Layer::Card,
            expert: false,
            random: true,
            uses_pool: false,
            simulated: false,
            help: "Flash memory fails a whole page at a time. Erased pages read as 0xFF, which the decoder treats as the end of the data for that stretch; bursts turn into noise, stuck bits poison every byte.",
            params: vec![
                p_enum(
                    "mode",
                    "Fault",
                    &[("erased", "Erased pages (0xFF)"), ("burst", "Burst errors"), ("stuck_bit", "Stuck bit"), ("zero", "Zeroed pages")],
                    "erased",
                ),
                p_int("count", "Pages", 1, 64, 2),
                p_int("page_kb", "Page size (KB)", 2, 16, 8).expert(),
                protect(),
            ],
        },
        StepInfo {
            id: "recuva_contiguous",
            label: "Undeleted as if contiguous",
            group: "Card",
            layer: Layer::Card,
            expert: false,
            random: false,
            uses_pool: true,
            simulated: false,
            help: "Undelete tools only know where a deleted file started and how long it was, so they assume it was stored in one piece. It wasn't: after the first fragment you get whatever photo was sitting next to it.",
            params: vec![p_photo("photo", "Neighbouring photo"), p_float("fragment_at", "First fragment ends at (%)", 1.0, 99.0, 1.0, 45.0), cluster()],
        },
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    let cb = (get_i64(p, "cluster_kb", 8).clamp(1, 128) as usize) * 1024;
    let protect = get_bool(p, "protect_header", true);
    let r = match id {
        "pass_through_card" => pass_through(p, input, ctx),
        "interleave" => (|| {
            let other = pool_body(ctx, p)?;
            let s = body_start(input, true);
            let (at, _) = region(&json!({"start": get_f64(p, "start", 20.0)}), s, input.len());
            let at = s + ((at - s) / cb) * cb;
            let period = get_i64(p, "period", 2).clamp(1, 16) as usize * cb;
            let mut out = input[..at].to_vec();
            let (mut a, mut b) = (at, 0usize);
            while a < input.len() {
                let e = (a + period).min(input.len());
                out.extend_from_slice(&input[a..e]);
                a = e;
                if a >= input.len() {
                    break;
                }
                let be = (b + period).min(other.len());
                out.extend_from_slice(&other[b..be]);
                b = if be >= other.len() { 0 } else { be };
            }
            Ok(out)
        })(),
        "cross_link" => (|| {
            let other = pool_body(ctx, p)?;
            let s = body_start(input, true);
            let frac = get_f64(p, "at", 55.0).clamp(0.0, 100.0) / 100.0;
            let at = s + (((input.len() - s) as f64 * frac) as usize / cb) * cb;
            let ob = ((other.len() as f64 * frac) as usize / cb) * cb;
            let mut out = input[..at.min(input.len())].to_vec();
            out.extend_from_slice(&other[ob.min(other.len())..]);
            Ok(out)
        })(),
        "stutter_read" => {
            let mut rng = ctx.rng();
            let s = body_start(input, protect);
            let mut out = input.to_vec();
            for _ in 0..get_i64(p, "count", 2).clamp(1, 32) {
                let n = (out.len().saturating_sub(s)) / cb;
                if n < 2 {
                    break;
                }
                let k = s + rng.below(n as u32) as usize * cb;
                let piece = out[k..(k + cb).min(out.len())].to_vec();
                out.splice(k..k, piece);
            }
            Ok(out)
        }
        "dropped_sectors" => {
            let mut rng = ctx.rng();
            let s = body_start(input, protect);
            let mut out = input.to_vec();
            for _ in 0..get_i64(p, "count", 6).clamp(1, 256) {
                let n = out.len().saturating_sub(s) / 512;
                if n < 2 {
                    break;
                }
                let k = s + rng.below(n as u32) as usize * 512;
                out.drain(k..(k + 512).min(out.len()));
            }
            Ok(out)
        }
        "tool_fill_pattern" => {
            let mut rng = ctx.rng();
            let s = body_start(input, protect);
            let mut out = input.to_vec();
            let pat: Vec<u8> = match get_str(p, "tool", "text") {
                "zeros" => vec![0],
                "ff" => vec![0xFF],
                "deadbeef" => vec![0xDE, 0xAD, 0xBE, 0xEF],
                _ => b"BAD SECTOR ".to_vec(),
            };
            let len = get_i64(p, "sectors", 8).clamp(1, 64) as usize * 512;
            for _ in 0..get_i64(p, "count", 3).clamp(1, 64) {
                let n = out.len().saturating_sub(s) / 512;
                if n < 1 {
                    break;
                }
                let k = s + rng.below(n as u32) as usize * 512;
                let e = (k + len).min(out.len());
                for (i, b) in out[k..e].iter_mut().enumerate() {
                    *b = pat[i % pat.len()];
                }
            }
            Ok(out)
        }
        "chipoff_xor" => {
            let mut rng = ctx.rng();
            let s0 = body_start(input, protect);
            let s = region(&json!({"start": get_f64(p, "start", 40.0)}), s0, input.len()).0;
            let page = get_i64(p, "page_kb", 4).clamp(2, 16) as usize * 1024;
            let key_len = get_i64(p, "key_len", 512).clamp(1, 4096) as usize;
            let mut key_rng = Pcg32::new(0x5C4A_3B1E ^ ctx.seed as u64, 7);
            let key: Vec<u8> = (0..key_len).map(|_| key_rng.next_u32() as u8).collect();
            let strength = get_f64(p, "strength", 30.0).clamp(0.0, 100.0) / 100.0;
            let mut out = input.to_vec();
            let mut pages: Vec<(usize, usize)> = Vec::new();
            let mut k = s;
            while k < out.len() {
                let e = (k + page).min(out.len());
                pages.push((k, e));
                k = e;
            }
            for &(a, e) in &pages {
                if rng.chance(strength) {
                    for (i, b) in out[a..e].iter_mut().enumerate() {
                        *b ^= key[i % key_len];
                    }
                }
            }
            if get_bool(p, "shuffle", false) && pages.len() > 2 {
                let snapshot = out.clone();
                // Swap neighbouring full pages within blocks of 4 (wrong wear-levelling map).
                for blk in (0..pages.len().saturating_sub(1)).step_by(4) {
                    if rng.chance(strength.max(0.2)) && pages[blk + 1].1 - pages[blk + 1].0 == page && pages[blk].1 - pages[blk].0 == page
                    {
                        let (a0, _) = pages[blk];
                        let (b0, _) = pages[blk + 1];
                        out[a0..a0 + page].copy_from_slice(&snapshot[b0..b0 + page]);
                        out[b0..b0 + page].copy_from_slice(&snapshot[a0..a0 + page]);
                    }
                }
            }
            Ok(out)
        }
        "flash_fault" => {
            let mut rng = ctx.rng();
            let s = body_start(input, protect);
            let page = get_i64(p, "page_kb", 8).clamp(2, 16) as usize * 1024;
            let mut out = input.to_vec();
            let mode = get_str(p, "mode", "erased");
            for _ in 0..get_i64(p, "count", 2).clamp(1, 64) {
                let n = out.len().saturating_sub(s) / page;
                if n < 1 {
                    break;
                }
                let k = s + rng.below(n as u32 + 1) as usize * page;
                let e = (k + page).min(out.len());
                if k >= e {
                    continue;
                }
                match mode {
                    "burst" => {
                        let blen = (rng.below(page as u32 / 4) as usize + 64).min(e - k);
                        let at = k + rng.below((e - k - blen + 1) as u32) as usize;
                        for b in out[at..at + blen].iter_mut() {
                            *b = rng.next_u32() as u8;
                        }
                    }
                    "stuck_bit" => {
                        let bit = 1u8 << rng.below(8);
                        for b in out[k..e].iter_mut() {
                            *b |= bit;
                        }
                    }
                    "zero" => out[k..e].fill(0),
                    _ => out[k..e].fill(0xFF),
                }
            }
            Ok(out)
        }
        "recuva_contiguous" => (|| {
            let other = pool_body(ctx, p)?;
            let s = body_start(input, true);
            let frac = get_f64(p, "fragment_at", 45.0).clamp(1.0, 99.0) / 100.0;
            let at = s + (((input.len() - s) as f64 * frac) as usize / cb) * cb;
            let at = at.min(input.len());
            let need = input.len() - at;
            let mut out = input[..at].to_vec();
            // The neighbour's data from somewhere in its middle (its header cluster sits earlier on the card).
            let ob = (other.len() / 3 / cb) * cb;
            let mut k = ob;
            while out.len() < at + need {
                let e = (k + (at + need - out.len())).min(other.len());
                out.extend_from_slice(&other[k..e]);
                k = if e >= other.len() { 0 } else { e };
            }
            Ok(out)
        })(),
        _ => return None,
    };
    Some(r)
}

/// Story presets for the single-photo card round trip. Photo 0 is the edited photo.
fn story(scenario: &str, severity: i64, neighbours: usize, photo_len: usize, cluster_kb: u64) -> (Fs, Vec<usize>, Vec<Value>) {
    let n = neighbours;
    let sev = severity.clamp(1, 10);
    // Order of photos as they'll be shot (indices into [target, pool...]).
    let mut order: Vec<usize> = Vec::new();
    let mut events: Vec<Value>;
    let mut fs = Fs::Fat16;
    match scenario {
        "fragmented" => {
            order.extend(1..=n.min(2).max(1));
            order.push(0);
            order.extend((n.min(2) + 1)..=n);
            events = vec![
                json!({"type":"shoot","count": n.min(2).max(1)}),
                json!({"type":"delete","which":"first","count":1}),
                json!({"type":"power_cycle"}),
                json!({"type":"shoot","count": 1 + n.saturating_sub(2)}),
                json!({"type":"delete","which":"all"}),
            ];
            if sev >= 3 {
                // A PC later writes into the first free gap, i.e. over the start of the photo.
                events.push(json!({"type":"os_junk","target_frac": (sev - 2) as f64 / 8.0 * 0.45}));
            }
        }
        "burst" => {
            // The photo is the second of the burst, so carving it runs through the others' chunks.
            order.push(1);
            order.push(0);
            order.extend(2..=n.clamp(1, 3));
            let clusters = photo_len.div_ceil(cluster_kb as usize * 1024).max(2);
            let period = ((clusters as f64 * (11 - sev) as f64 / 12.0).round() as i64).clamp(1, 64);
            events = vec![
                json!({"type":"burst","count": 1 + n.clamp(1,3), "period": period}),
                json!({"type":"delete","which":"all"}),
            ];
        }
        "pc_reformat" => {
            // Two older photos sit before this one; the PC's new file system and its junk reach
            // further into the card the worse it gets.
            order.extend(1..=n.min(2));
            order.push(0);
            order.extend(3..=n);
            events = vec![
                json!({"type":"shoot","count": n + 1}),
                json!({"type":"reformat_pc","fs":"fat32","cluster_kb": if sev > 5 { 4 } else { 2 }}),
                json!({"type":"os_junk","target_frac": (sev - 1) as f64 / 9.0 * 0.5}),
            ];
        }
        "power_loss" => {
            order.extend(1..=n);
            order.push(0);
            events = vec![
                json!({"type":"shoot","count": n}),
                json!({"type":"power_loss","at": 1.0 - sev as f64 / 11.0, "mode":"size_zero"}),
                json!({"type":"shoot","count": 1}),
            ];
        }
        "flash_failure" => {
            order.push(0);
            order.extend(1..=n);
            events = vec![
                json!({"type":"shoot","count": n + 1}),
                json!({"type":"flash_fault","mode":"burst","count": sev * 2, "page_kb": 16}),
            ];
            if sev >= 4 {
                // Whole erased pages (0xFF) stop the decoder: only when it's bad.
                events.push(json!({"type":"flash_fault","mode":"erased","count": sev / 4, "page_kb": 16}));
            }
        }
        "fat32_undelete" => {
            // A and B are shot, A deleted; after a power cycle the edited photo fills A's gap and
            // continues past B. Undelete assumes it was contiguous and reads B's data instead.
            fs = Fs::Fat32;
            order.extend([1, 2.min(n.max(1))]);
            order.push(0);
            order.extend(3..=n);
            events = vec![
                json!({"type":"advance","percent": 30}),
                json!({"type":"shoot","count": 2}),
                json!({"type":"delete","which":"first","count":1}),
                json!({"type":"power_cycle"}),
                json!({"type":"shoot","count": 1 + n.saturating_sub(2)}),
                json!({"type":"delete","which":"all","clear_high": false}),
                json!({"type":"shoot","count": (sev as usize / 5)}),
            ];
        }
        _ => {
            // junk_overwrite: the edited photo is first on the card; a PC then fills the lowest free
            // clusters. How much is overwritten scales with the photo: severity 1..10 = 5%..60% of
            // its clusters (at least one), so small photos are damaged, not wiped.
            order.push(0);
            order.extend(1..=n);
            let clusters = photo_len.div_ceil(cluster_kb as usize * 1024).max(1);
            let frac = 0.05 + (sev - 1) as f64 / 9.0 * 0.55;
            let lost = ((clusters as f64 * frac).round() as usize).clamp(1, clusters);
            events = vec![
                json!({"type":"shoot","count": n + 1}),
                json!({"type":"delete","which":"all"}),
                json!({"type":"os_junk","kb": lost as u64 * cluster_kb, "exact": true}),
            ];
        }
    }
    (fs, order, events)
}

fn pass_through(p: &Value, input: &[u8], ctx: &StepCtx) -> StepResult {
    let scenario = get_str(p, "scenario", "junk_overwrite");
    let tool = get_str(p, "tool", "graft");
    let severity = get_i64(p, "severity", 5);
    let neighbours = get_i64(p, "neighbours", 3).clamp(1, 8) as usize;
    let mut cands: Vec<Vec<u8>> = vec![input.to_vec()];
    for i in 0..neighbours {
        match ctx.pool_photo(i as i64) {
            Some(d) if !ctx.pool.is_empty() && i < ctx.pool.len() => cands.push(d.to_vec()),
            _ => cands.push(input.to_vec()),
        }
    }
    let ckb = get_i64(p, "cluster_kb", 8).clamp(1, 128) as u64;
    let (fs, order, events) = story(scenario, severity, neighbours, input.len(), ckb);
    let photos: Vec<Vec<u8>> = order.iter().map(|&i| cands[i.min(cands.len() - 1)].clone()).collect();
    let target_pos = order.iter().position(|&i| i == 0).unwrap_or(0);
    let total: usize = photos.iter().map(|d| d.len()).sum();
    let size_mb = match fs {
        // Big enough that start clusters need more than 16 bits (sparse, so it costs nothing).
        Fs::Fat32 => (((total * 3) >> 20) as u64 + 40).max(1536),
        _ => (((total * 3) >> 20) as u64 + 8).max(16),
    };
    // A second-hand card: free space still holds old photo data, so reading past a file's end
    // gives other pictures rather than blank (grey) space.
    let mut events = events;
    events.insert(0, json!({"type":"used_card","kb": (total * 3 / 1024).max(64)}));
    let mut card = Card::new(fs, size_mb, Some(ckb), CameraKind::Canon2004, photos, ctx.seed);
    // Run the story event by event, remembering where the photo's bytes physically sit (byte
    // ranges, one per cluster): a PC reformat renumbers clusters, the bytes stay put.
    let mut ranges: Vec<(u64, u64)> = Vec::new();
    let mut frozen = false;
    for e in &events {
        let ty = get_str(e, "type", "");
        if matches!(ty, "reformat_pc" | "quick_format") {
            frozen = true;
        }
        let ev = match e.get("target_frac").and_then(|v| v.as_f64()) {
            // Junk that reaches `target_frac` of the way into the photo (from the first free cluster).
            Some(f) if ty == "os_junk" => {
                let gap = ranges.first().map(|r| r.0.saturating_sub(card.vol.cluster_offset(2)) / 1024).unwrap_or(0);
                let kb = gap.saturating_sub(4) + (input.len() as f64 / 1024.0 * f.clamp(0.0, 1.0)) as u64;
                json!({"type":"os_junk","kb": kb.max(1), "exact": true})
            }
            _ => e.clone(),
        };
        card.run_events(std::slice::from_ref(&ev));
        if !frozen {
            if let Some(f) = card.photo_file(target_pos) {
                let cb = card.vol.cluster_bytes;
                ranges = f.clusters.iter().map(|&c| (card.vol.cluster_offset(c), card.vol.cluster_offset(c) + cb)).collect();
            }
        }
    }
    if ranges.is_empty() {
        return Ok(input.to_vec());
    }
    let mut wanted = std::collections::BTreeSet::new();
    for &(a, b) in &ranges {
        if let (Some(x), Some(y)) = (carve::cluster_at(&card, a), carve::cluster_at(&card, b - 1)) {
            wanted.extend(x..=y);
        }
    }
    let first = carve::cluster_at(&card, ranges[0].0);
    let pick = |rec: &[carve::Recovered]| -> Option<carve::Recovered> {
        rec.iter()
            .filter(|r| r.data.len() > 2 && r.data[0] == 0xFF && r.data[1] == 0xD8)
            .map(|r| {
                let hit = r.source_clusters.iter().filter(|c| wanted.contains(c)).count();
                // The file that starts at the photo's header wins, unless a rebuilt piece holds more of it.
                let starts = r.source_clusters.first().is_some_and(|c| Some(*c) == first);
                let bonus = if starts && tool != "graft" { 1_000_000 } else if starts { 1 } else { 0 };
                // A neighbour that merely shares a boundary cluster is not this photo.
                let enough = starts || hit * 4 >= wanted.len().max(1);
                (if enough { hit + bonus } else { 0 }, r)
            })
            .filter(|(h, _)| *h > 0)
            .max_by_key(|(h, _)| *h)
            .map(|(_, r)| r.clone())
    };
    let opts = json!({"min_kb": 32, "piece_kb": 24});
    // The card's copy of the photo (the camera may have added Exif) is what the clusters hold.
    let own = card.photos.get(target_pos).map(|v| &v[..]).unwrap_or(input);
    // If the chosen tool finds nothing viewable of this photo, a person would try the rebuild next.
    // Files the chosen tool returns as they are for undelete / plain reads (those follow the file
    // system's sizes); carvers and every by-hand rebuild glue on the following clusters.
    let own_pick = pick(&carve::carve(&card, tool, &opts));
    let mut out = match own_pick {
        Some(r) if matches!(tool, "graft" | "photorec") => read_on(&card, r, own),
        Some(r) => r.data,
        None => match if tool == "graft" { None } else { pick(&carve::carve(&card, "graft", &opts)) } {
            Some(r) => read_on(&card, r, own),
            None => read_on(&card, last_ditch(&card, &ranges, own), own),
        },
    };
    // A carve that never met an end marker can run on through old data for megabytes; the
    // decoder only ever uses about one photo's worth.
    if !out.ends_with(&[0xFF, 0xD9]) && out.len() > own.len() * 2 {
        out.truncate(own.len() * 2);
    }
    Ok(out)
}

/// Carvers that stop short (next file's header, junk) leave the bottom of the picture empty.
/// Rebuilding by hand, the clusters that follow on the card are glued on until the body is as
/// long as the photo's was: the rest of the picture turns into whatever photo lay next to it
/// (header bytes skipped, markers neutralised) instead of a grey slab. Stops at blank space.
fn read_on(card: &Card, r: carve::Recovered, own: &[u8]) -> Vec<u8> {
    let mut data = r.data;
    let Some(s) = jpeg::scan_start(&data) else { return data };
    let want = own.len().saturating_sub(jpeg::scan_start(own).unwrap_or(0));
    let have = data.len().saturating_sub(s);
    let cb = card.vol.cluster_bytes;
    if have + cb as usize / 2 >= want {
        return data;
    }
    let Some(&last) = r.source_clusters.last() else { return data };
    if data.ends_with(&[0xFF, 0xD9]) {
        data.truncate(data.len() - 2);
    }
    let mut extra = Vec::new();
    let mut c = last + 1;
    while c <= card.vol.last_cluster() && have + extra.len() < want {
        let off = card.vol.cluster_offset(c);
        if card.img.is_blank_range(off, cb) {
            break;
        }
        let cl = card.img.read_vec(off, cb as usize);
        let from = if jpeg::known_header(&cl) { jpeg::scan_start(&cl).unwrap_or(cl.len()) } else { 0 };
        extra.extend_from_slice(&cl[from.min(cl.len())..]);
        c += 1;
    }
    extra.truncate(want - have);
    // Neutralise across the seam too.
    let seam = data.len().saturating_sub(2);
    data.extend_from_slice(&extra);
    jpeg::neutralise_markers(&mut data[seam..]);
    data.extend_from_slice(&[0xFF, 0xD9]);
    data
}

/// Wrap last_ditch's bytes as a recovered file for read_on.
fn last_ditch(card: &Card, ranges: &[(u64, u64)], input: &[u8]) -> carve::Recovered {
    let data = last_ditch_bytes(card, ranges, input);
    let last = ranges.last().and_then(|&(_, b)| carve::cluster_at(card, b - 1));
    carve::Recovered { name: "manual.jpg".into(), size: data.len(), source_clusters: last.into_iter().collect(), note: "manual rebuild".into(), data }
}

/// Nothing recognisable was carved: a manual rebuild. A valid header (the photo's own, Exif
/// dropped) followed by what the card still holds of the photo's body, read where its clusters
/// were, from after its SOS, skipping leading clusters that were overwritten, markers neutralised.
/// Never junk or header bytes in front of the header.
fn last_ditch_bytes(card: &Card, ranges: &[(u64, u64)], input: &[u8]) -> Vec<u8> {
    let cb = card.vol.cluster_bytes as usize;
    let Some(sos_end) = jpeg::scan_start(input) else { return input.to_vec() };
    let mut hdr = jpeg::header(input, true).unwrap_or_else(|| input[..sos_end].to_vec());
    let mut raw = Vec::with_capacity(input.len() + cb);
    for &(a, b) in ranges {
        raw.extend(card.img.read_vec(a, (b - a) as usize));
    }
    // Ranges are in the cluster size of the card when the photo was written.
    let cb = ranges.first().map(|&(a, b)| (b - a) as usize).unwrap_or(cb);
    raw.truncate(input.len());
    // First cluster whose bytes still match the photo (the rest of the chain was not overwritten).
    let survive = (0..raw.len().div_ceil(cb))
        .find(|&k| {
            let (a, b) = (k * cb, ((k + 1) * cb).min(raw.len()));
            b > sos_end && raw[a..b] == input[a..b]
        })
        .map(|k| (k * cb).max(sos_end))
        .unwrap_or(sos_end)
        .min(raw.len());
    let mut body = raw[survive..].to_vec();
    jpeg::neutralise_markers(&mut body);
    hdr.extend_from_slice(&body);
    if !hdr.ends_with(&[0xFF, 0xD9]) {
        hdr.extend_from_slice(&[0xFF, 0xD9]);
    }
    hdr
}
