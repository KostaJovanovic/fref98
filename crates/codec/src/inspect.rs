//! inspect(): a forgiving structural description of a JPEG for the hex view and inspector.

use crate::decoder::be16;
use crate::markers::{is_sof, name, walk, Segment};
use serde_json::{json, Value};

fn summary(d: &[u8], s: &Segment) -> String {
    let p = s.payload(d);
    let mut out = match s.marker {
        0xD8 => "start of image".to_string(),
        0xD9 => "end of image".to_string(),
        0xD0..=0xD7 => format!("restart marker {}", s.marker - 0xD0),
        0xE0 if p.starts_with(b"JFIF\0") => "JFIF header".to_string(),
        0xE0 if p.starts_with(b"AVI1") => "AVI1 (Motion JPEG frame)".to_string(),
        0xE1 if p.starts_with(b"Exif\0\0") => "Exif metadata".to_string(),
        0xE1 if p.starts_with(b"http://ns.adobe.com/xap") => "XMP metadata".to_string(),
        0xE2 if p.starts_with(b"ICC_PROFILE\0") => "ICC colour profile".to_string(),
        0xE2 if p.starts_with(b"MPF\0") => "Multi-Picture Format index".to_string(),
        0xEE if p.starts_with(b"Adobe") => format!("Adobe, colour transform {}", p.get(11).copied().unwrap_or(0)),
        0xFE => format!("comment: {}", String::from_utf8_lossy(&p[..p.len().min(60)])),
        0xDB => {
            let mut ids = Vec::new();
            let mut i = 0;
            while i < p.len() {
                ids.push((p[i] & 15).to_string());
                i += 1 + if p[i] >> 4 == 0 { 64 } else { 128 };
            }
            format!("quantisation table(s) {}", ids.join(", "))
        }
        0xC4 => {
            let mut ids = Vec::new();
            let mut i = 0;
            while i + 17 <= p.len() {
                let n: usize = p[i + 1..i + 17].iter().map(|&b| b as usize).sum();
                ids.push(format!("{}{}", if p[i] >> 4 == 0 { "DC" } else { "AC" }, p[i] & 15));
                i += 17 + n;
            }
            format!("Huffman table(s) {}", ids.join(", "))
        }
        0xDD => format!("restart every {} MCUs", be16(p, 0)),
        0xDA => {
            let n = p.first().copied().unwrap_or(0) as usize;
            let b = 1 + 2 * n;
            format!(
                "scan of {} component(s), spectral {}..{}, bits {}/{}, {} bytes of data",
                n,
                p.get(b).copied().unwrap_or(0),
                p.get(b + 1).copied().unwrap_or(0),
                p.get(b + 2).map(|x| x >> 4).unwrap_or(0),
                p.get(b + 2).map(|x| x & 15).unwrap_or(0),
                s.scan_end.saturating_sub(s.end)
            )
        }
        m if is_sof(m) => format!("frame {}x{}, {} component(s)", be16(p, 3), be16(p, 1), p.get(5).copied().unwrap_or(0)),
        _ => String::new(),
    };
    if s.truncated {
        out.push_str(" [cut short]");
    }
    out
}

pub fn inspect_value(d: &[u8]) -> Value {
    let l = walk(d);
    let segments: Vec<Value> = l
        .segments
        .iter()
        .map(|s| json!({ "offset": s.offset, "length": s.length, "marker": s.marker, "name": name(s.marker), "summary": summary(d, s) }))
        .collect();
    let mut frame = Value::Null;
    if let Some(sof) = l.sof() {
        let p = sof.payload(d);
        let (h, w) = (be16(p, 1), be16(p, 3));
        let n = p.get(5).copied().unwrap_or(0) as usize;
        let comps: Vec<(u8, usize, usize, u8)> = (0..n.min(4))
            .filter_map(|k| {
                let b = 6 + 3 * k;
                let hv = *p.get(b + 1)?;
                Some((*p.get(b)?, ((hv >> 4) as usize).clamp(1, 4), ((hv & 15) as usize).clamp(1, 4), *p.get(b + 2)?))
            })
            .collect();
        let hmax = comps.iter().map(|c| c.1).max().unwrap_or(1);
        let vmax = comps.iter().map(|c| c.2).max().unwrap_or(1);
        let single = comps.len() == 1;
        let (mw, mh) = if single { (8, 8) } else { (8 * hmax, 8 * vmax) };
        let (mx, my) = (w.div_ceil(mw.max(1)).max(1), h.div_ceil(mh.max(1)).max(1));
        let blocks: Vec<Value> = comps
            .iter()
            .map(|c| {
                let (bw, bh) = if single { (mx, my) } else { (mx * c.1, my * c.2) };
                json!({ "bw": bw, "bh": bh })
            })
            .collect();
        frame = json!({
            "width": w, "height": h,
            "progressive": matches!(sof.marker, 0xC2 | 0xC6 | 0xCA | 0xCE),
            "sof": sof.marker,
            "components": comps.iter().map(|c| json!({ "id": c.0, "h": c.1, "v": c.2, "tq": c.3 })).collect::<Vec<_>>(),
            "mcu_cols": mx, "mcu_rows": my, "mcu_width": mw, "mcu_height": mh,
            "blocks": blocks,
        });
    }
    let restart = l.first(0xDD).map(|s| be16(s.payload(d), 0)).unwrap_or(0);
    let scans: Vec<Value> = l
        .scans()
        .map(|s| {
            // the decoder's own parser, so the view shows the scan the decoder uses
            let h = crate::markers::parse_sos(s.payload(d));
            let comps: Vec<u8> = h.comps.iter().map(|c| c.0).collect();
            json!({ "offset": s.offset, "length": s.scan_end - s.offset, "components": comps, "ss": h.ss, "se": h.se, "ah": h.ah, "al": h.al })
        })
        .collect();
    let qtables: Vec<Value> = l
        .segments
        .iter()
        .filter(|s| s.marker == 0xDB)
        .flat_map(|s| crate::markers::parse_dqt(s.payload(d)))
        .map(|t| json!({ "id": t.id, "values": t.values.to_vec() }))
        .collect();
    let mut v = json!({
        "size": d.len(),
        "segments": segments,
        "restart_interval": restart,
        "scans": scans,
        "qtables": qtables,
        "trailing_bytes": l.trailing,
        "garbage_bytes": l.garbage,
    });
    if !frame.is_null() {
        v["frame"] = frame;
    }
    if let Some(e) = l.eoi {
        v["eoi_offset"] = json!(e);
    }
    if let Some(x) = crate::exif::flat(d) {
        v["exif"] = Value::Object(x);
    }
    v
}

pub fn inspect_json(d: &[u8]) -> String {
    inspect_value(d).to_string()
}
