//! Motion-JPEG AVI (RIFF AVI / AVI1 frames): writer, forgiving reader, and DHT insertion for
//! frames that rely on the standard tables (as MJPEG frames do).

use crate::huffman::HuffSpec;
use crate::markers::{segment, walk};

fn le32(v: u32) -> [u8; 4] {
    v.to_le_bytes()
}

fn chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(data.len() + 9);
    v.extend_from_slice(id);
    v.extend_from_slice(&le32(data.len() as u32));
    v.extend_from_slice(data);
    if data.len() % 2 == 1 {
        v.push(0);
    }
    v
}

fn list(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut d = kind.to_vec();
    d.extend_from_slice(body);
    chunk(b"LIST", &d)
}

pub fn write(frames: &[Vec<u8>], w: u32, h: u32, fps: u32) -> Vec<u8> {
    let fps = fps.clamp(1, 240);
    // as stored: the index and the buffer sizes must count the AVI1 APP0 added to a frame
    let frames: Vec<Vec<u8>> = frames.iter().map(|f| with_avi1(f)).collect();
    let n = frames.len() as u32;
    let maxf = frames.iter().map(|f| f.len()).max().unwrap_or(0) as u32;
    let mut avih = Vec::new();
    for v in [1_000_000 / fps, maxf * fps, 0, 0x10, n, 0, 1, maxf, w, h, 0, 0, 0, 0] {
        avih.extend_from_slice(&le32(v));
    }
    let mut strh = Vec::new();
    strh.extend_from_slice(b"vidsMJPG");
    for v in [0u32, 0, 0, 1, fps, 0, n, maxf, 0xFFFF_FFFF, 0] {
        strh.extend_from_slice(&le32(v));
    }
    strh.extend_from_slice(&[0, 0, 0, 0, (w & 0xFF) as u8, (w >> 8) as u8, (h & 0xFF) as u8, (h >> 8) as u8]);
    let mut strf = Vec::new();
    strf.extend_from_slice(&le32(40));
    strf.extend_from_slice(&le32(w));
    strf.extend_from_slice(&le32(h));
    strf.extend_from_slice(&[1, 0, 24, 0]);
    strf.extend_from_slice(b"MJPG");
    strf.extend_from_slice(&le32(w * h * 3));
    for _ in 0..4 {
        strf.extend_from_slice(&le32(0));
    }
    let strl = list(b"strl", &[chunk(b"strh", &strh), chunk(b"strf", &strf)].concat());
    let hdrl = list(b"hdrl", &[chunk(b"avih", &avih), strl].concat());
    let mut movi = Vec::new();
    let mut idx = Vec::new();
    for f in &frames {
        let off = movi.len() as u32 + 4;
        idx.extend_from_slice(b"00dc");
        idx.extend_from_slice(&le32(0x10));
        idx.extend_from_slice(&le32(off));
        idx.extend_from_slice(&le32(f.len() as u32));
        movi.extend(chunk(b"00dc", f));
    }
    let body = [b"AVI ".to_vec(), hdrl, list(b"movi", &movi), chunk(b"idx1", &idx)].concat();
    chunk(b"RIFF", &body)
}

/// Mark a JPEG as an AVI1 frame (APP0 "AVI1") if it has no APP0 yet.
fn with_avi1(f: &[u8]) -> Vec<u8> {
    if f.len() < 4 || f[0] != 0xFF || f[1] != 0xD8 || (f[2] == 0xFF && f[3] == 0xE0) {
        return f.to_vec();
    }
    let mut out = f[..2].to_vec();
    out.extend(segment(0xE0, b"AVI1\0\0\0\0\0\0\0\0"));
    out.extend_from_slice(&f[2..]);
    out
}

pub struct AviInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// (offset, length) of each JPEG frame.
    pub frames: Vec<(usize, usize)>,
}

fn rd32(d: &[u8], o: usize) -> Option<u32> {
    d.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Forgiving reader: walks RIFF chunks; if that finds no frames (damaged/recovered files), it
/// falls back to scanning for SOI..EOI pairs.
pub fn read(d: &[u8]) -> AviInfo {
    let mut info = AviInfo { width: 0, height: 0, fps: 0.0, frames: Vec::new() };
    // Chunks are contiguous, so a linear walk that steps *into* LIST/RIFF bodies visits them all.
    let mut p = 12usize;
    let mut guard = 0;
    {
        while p + 8 <= d.len() {
            guard += 1;
            if guard > 2_000_000 {
                break;
            }
            let id = &d[p..p + 4];
            let size = rd32(d, p + 4).unwrap_or(0) as usize;
            let body = p + 8;
            let body_end = body.saturating_add(size).min(d.len());
            if id == b"LIST" || id == b"RIFF" {
                p = body + 4;
                continue;
            }
            match id {
                b"avih" => {
                    let us = rd32(d, body).unwrap_or(0);
                    if us > 0 {
                        info.fps = 1_000_000.0 / us as f64;
                    }
                    info.width = rd32(d, body + 32).unwrap_or(0);
                    info.height = rd32(d, body + 36).unwrap_or(0);
                }
                b"strh" if d.get(body..body + 4) == Some(b"vids") => {
                    let scale = rd32(d, body + 20).unwrap_or(0);
                    let rate = rd32(d, body + 24).unwrap_or(0);
                    if scale > 0 && rate > 0 {
                        info.fps = rate as f64 / scale as f64;
                    }
                }
                _ => {
                    if id.len() == 4 && (&id[2..4] == b"dc" || &id[2..4] == b"db") && size > 0 && d.get(body) == Some(&0xFF) {
                        info.frames.push((body, body_end - body));
                    }
                }
            }
            p = body_end + (size & 1);
        }
    }
    info.frames.sort();
    if info.frames.is_empty() {
        let mut p = 0;
        while p + 1 < d.len() {
            if d[p] == 0xFF && d[p + 1] == 0xD8 {
                let mut q = p + 2;
                while q + 1 < d.len() && !(d[q] == 0xFF && d[q + 1] == 0xD9) {
                    q += 1;
                }
                let e = (q + 2).min(d.len());
                info.frames.push((p, e - p));
                p = e;
            } else {
                p += 1;
            }
        }
    }
    if info.fps <= 0.0 {
        info.fps = 15.0;
    }
    info
}

/// Insert the standard Annex K Huffman tables before the first SOS if the frame has no DHT.
pub fn ensure_dht(f: &[u8]) -> Vec<u8> {
    let l = walk(f);
    if l.segments.iter().any(|s| s.marker == 0xC4) {
        return f.to_vec();
    }
    let Some(sos) = l.first(0xDA) else { return f.to_vec() };
    let mut p = Vec::new();
    for (tc, chroma) in [(0x00u8, false), (0x10, false), (0x01, true), (0x11, true)] {
        p.push(tc);
        let spec = if tc & 0x10 != 0 { HuffSpec::std_ac(chroma) } else { HuffSpec::std_dc(chroma) };
        spec.write(&mut p);
    }
    let mut out = f[..sos.offset].to_vec();
    out.extend(segment(0xC4, &p));
    out.extend_from_slice(&f[sos.offset..]);
    out
}

pub fn frame(d: &[u8], index: usize) -> Option<Vec<u8>> {
    let info = read(d);
    let &(o, l) = info.frames.get(index)?;
    Some(ensure_dht(&d[o..o + l]))
}
