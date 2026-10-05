//! Minimal JPEG structure helpers for carving (marker walking only; decoding lives in the codec crate).

/// Offset just past the first scan header (SOS segment), i.e. where entropy-coded data starts.
pub fn scan_start(d: &[u8]) -> Option<usize> {
    let mut i = 2;
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    while i + 4 <= d.len() {
        if d[i] != 0xFF {
            return None;
        }
        let m = d[i + 1];
        if m == 0xFF {
            i += 1;
            continue;
        }
        let len = u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
        if m == 0xDA {
            return Some((i + 2 + len).min(d.len()));
        }
        i += 2 + len;
    }
    None
}

/// Header bytes from SOI up to and including the first SOS, optionally dropping APPn (EXIF etc.).
pub fn header(d: &[u8], drop_app: bool) -> Option<Vec<u8>> {
    let end = scan_start(d)?;
    let mut out = vec![0xFF, 0xD8];
    let mut i = 2;
    while i + 4 <= end {
        let m = d[i + 1];
        if m == 0xFF {
            i += 1;
            continue;
        }
        let len = u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
        let seg_end = (i + 2 + len).min(end);
        if !(drop_app && (0xE0..=0xEF).contains(&m) && m != 0xEE) {
            out.extend_from_slice(&d[i..seg_end]);
        }
        i = seg_end;
    }
    Some(out)
}

/// Find the end (offset after EOI) of a JPEG starting at `d[0]`, following markers through progressive scans.
/// Returns None if no EOI within `max` bytes.
pub fn find_end(d: &[u8], max: usize) -> Option<usize> {
    let lim = d.len().min(max);
    let mut i = 2;
    if lim < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    loop {
        // Marker segments.
        while i + 4 <= lim && d[i] == 0xFF {
            let m = d[i + 1];
            if m == 0xFF {
                i += 1;
                continue;
            }
            if m == 0xD9 {
                return Some(i + 2);
            }
            let len = u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
            i += 2 + len;
            if m == 0xDA {
                break;
            }
        }
        // Entropy-coded data.
        let mut found = false;
        while i + 1 < lim {
            if d[i] == 0xFF {
                let n = d[i + 1];
                if n == 0x00 || (0xD0..=0xD7).contains(&n) || n == 0xFF {
                    i += if n == 0xFF { 1 } else { 2 };
                    continue;
                }
                if n == 0xD9 {
                    return Some(i + 2);
                }
                found = true;
                break;
            }
            i += 1;
        }
        if !found || i + 4 > lim {
            return None;
        }
    }
}

/// True if a cluster looks like the start of a known file type (carvers stop a file there).
pub fn known_header(c: &[u8]) -> bool {
    c.len() >= 4
        && ((c[0] == 0xFF && c[1] == 0xD8 && c[2] == 0xFF)
            || &c[0..4] == b"RIFF"
            || (c[0] == 0xD0 && c[1] == 0xCF && c[2] == 0x11 && c[3] == 0xE0)
            || &c[0..4] == b"\x00\x05\x16\x07")
}

/// Classify a cluster's bytes the way the header-graft script's cluster map did.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Empty,
    Header,
    JpegBody,
    Other,
}

pub fn classify(c: &[u8]) -> Kind {
    if c.iter().all(|&b| b == 0) || c.iter().all(|&b| b == 0xFF) {
        return Kind::Empty;
    }
    if known_header(c) {
        return Kind::Header;
    }
    // JPEG entropy data: every 0xFF is followed by 0x00, RSTn or EOI; byte histogram roughly flat.
    let mut bad = 0;
    let mut ff = 0;
    for w in c.windows(2) {
        if w[0] == 0xFF {
            ff += 1;
            if !(w[1] == 0x00 || (0xD0..=0xD7).contains(&w[1]) || w[1] == 0xD9 || w[1] == 0xFF) {
                bad += 1;
            }
        }
    }
    let zeros = c.iter().filter(|&&b| b == 0).count();
    if bad <= 2 && ff > 0 && zeros < c.len() / 4 {
        Kind::JpegBody
    } else {
        Kind::Other
    }
}

/// EXIF thumbnail (IFD1 JPEGInterchangeFormat) inside the file, as (offset, length).
pub fn exif_thumbnail(d: &[u8]) -> Option<(usize, usize)> {
    let mut i = 2;
    while i + 4 <= d.len() && d[i] == 0xFF {
        let m = d[i + 1];
        let len = u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
        if m == 0xDA {
            return None;
        }
        if m == 0xE1 && d.len() >= i + 10 && &d[i + 4..i + 10] == b"Exif\0\0" {
            let t = i + 10;
            let tiff = d.get(t..(i + 2 + len).min(d.len()))?;
            let le = tiff.get(0..2)? == b"II";
            let r16 = |o: usize| -> Option<usize> {
                let b = tiff.get(o..o + 2)?;
                Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) } as usize)
            };
            let r32 = |o: usize| -> Option<usize> {
                let b = tiff.get(o..o + 4)?;
                Some(if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } as usize)
            };
            let ifd0 = r32(4)?;
            let n0 = r16(ifd0)?;
            let ifd1 = r32(ifd0 + 2 + n0 * 12)?;
            if ifd1 == 0 {
                return None;
            }
            let n1 = r16(ifd1)?;
            let (mut off, mut ln) = (None, None);
            for k in 0..n1 {
                let e = ifd1 + 2 + k * 12;
                match r16(e)? {
                    0x0201 => off = r32(e + 8),
                    0x0202 => ln = r32(e + 8),
                    _ => {}
                }
            }
            let (o, l) = (off?, ln?);
            if t + o + l <= d.len() {
                return Some((t + o, l));
            }
            return None;
        }
        i += 2 + len;
    }
    None
}

/// Remove DHT segments (MJPEG frames rely on the standard tables).
pub fn strip_dht(d: &[u8]) -> Vec<u8> {
    let Some(end) = scan_start(d) else { return d.to_vec() };
    let mut out = vec![0xFF, 0xD8];
    let mut i = 2;
    while i + 4 <= end {
        let len = u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
        let seg_end = (i + 2 + len).min(end);
        if d[i + 1] != 0xC4 {
            out.extend_from_slice(&d[i..seg_end]);
        }
        i = seg_end;
    }
    out.extend_from_slice(&d[end..]);
    out
}

/// the header-graft script's trick (one implementation, shared with the codec's header graft).
pub use refragmenter_codec::markers::neutralise_markers;
