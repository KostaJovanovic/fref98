//! Forgiving marker/segment walker. Tolerates garbage between segments, truncated segments,
//! repeated SOI and trailing data. Used by inspect() and by byte-level steps.

pub const SOI: u8 = 0xD8;
pub const EOI: u8 = 0xD9;
pub const SOS: u8 = 0xDA;
pub const DQT: u8 = 0xDB;
pub const DHT: u8 = 0xC4;
pub const DRI: u8 = 0xDD;
pub const APP0: u8 = 0xE0;
pub const APP1: u8 = 0xE1;
pub const APP2: u8 = 0xE2;
pub const APP14: u8 = 0xEE;
pub const COM: u8 = 0xFE;

pub fn is_rst(m: u8) -> bool {
    (0xD0..=0xD7).contains(&m)
}

/// Markers without a length field.
pub fn standalone(m: u8) -> bool {
    m == SOI || m == EOI || is_rst(m) || m == 0x01
}

/// Marker codes a decoder knows; anything else after 0xFF is treated as garbage.
pub fn is_known(m: u8) -> bool {
    matches!(m, 0x01 | 0xC0..=0xCF | 0xD0..=0xDF | 0xE0..=0xEF | 0xFE)
}

pub fn is_sof(m: u8) -> bool {
    matches!(m, 0xC0..=0xCF) && m != DHT && m != 0xC8 && m != 0xCC
}

pub fn name(m: u8) -> &'static str {
    match m {
        0xC0 => "SOF0",
        0xC1 => "SOF1",
        0xC2 => "SOF2",
        0xC3 => "SOF3",
        0xC5 => "SOF5",
        0xC6 => "SOF6",
        0xC7 => "SOF7",
        0xC9 => "SOF9",
        0xCA => "SOF10",
        0xCB => "SOF11",
        0xCD => "SOF13",
        0xCE => "SOF14",
        0xCF => "SOF15",
        0xC4 => "DHT",
        0xCC => "DAC",
        0xD0..=0xD7 => "RST",
        0xD8 => "SOI",
        0xD9 => "EOI",
        0xDA => "SOS",
        0xDB => "DQT",
        0xDC => "DNL",
        0xDD => "DRI",
        0xDE => "DHP",
        0xDF => "EXP",
        0xE0 => "APP0",
        0xE1 => "APP1",
        0xE2 => "APP2",
        0xE3 => "APP3",
        0xE4 => "APP4",
        0xE5 => "APP5",
        0xE6 => "APP6",
        0xE7 => "APP7",
        0xE8 => "APP8",
        0xE9 => "APP9",
        0xEA => "APP10",
        0xEB => "APP11",
        0xEC => "APP12",
        0xED => "APP13",
        0xEE => "APP14",
        0xEF => "APP15",
        0xFE => "COM",
        0x01 => "TEM",
        _ => "unknown",
    }
}

#[derive(Clone, Debug)]
pub struct Segment {
    /// Offset of the 0xFF.
    pub offset: usize,
    pub marker: u8,
    /// Total bytes including FF xx and the length field (clamped to the file).
    pub length: usize,
    /// Payload range (after the length field).
    pub start: usize,
    pub end: usize,
    /// Declared length ran past the end of the file.
    pub truncated: bool,
    /// For SOS: end of the entropy-coded data that follows (next non-RST marker or EOF).
    pub scan_end: usize,
}

impl Segment {
    pub fn payload<'a>(&self, d: &'a [u8]) -> &'a [u8] {
        &d[self.start.min(d.len())..self.end.min(d.len())]
    }
}

#[derive(Clone, Debug, Default)]
pub struct Layout {
    pub segments: Vec<Segment>,
    pub eoi: Option<usize>,
    pub trailing: usize,
    /// Bytes skipped as garbage between segments.
    pub garbage: usize,
}

impl Layout {
    pub fn first(&self, m: u8) -> Option<&Segment> {
        self.segments.iter().find(|s| s.marker == m)
    }
    pub fn sof(&self) -> Option<&Segment> {
        self.segments.iter().find(|s| is_sof(s.marker))
    }
    pub fn scans(&self) -> impl Iterator<Item = &Segment> {
        self.segments.iter().filter(|s| s.marker == SOS)
    }
    /// (start, end) of the first scan's entropy-coded data.
    pub fn first_scan_data(&self) -> Option<(usize, usize)> {
        self.first(SOS).map(|s| (s.end, s.scan_end))
    }
    /// (start, end) covering all scan data from the first SOS payload end to the last scan end.
    pub fn all_scan_data(&self) -> Option<(usize, usize)> {
        let first = self.first(SOS)?;
        let last = self.scans().last()?;
        Some((first.end, last.scan_end.max(first.end)))
    }
}

/// End of entropy-coded data starting at `p`: the first marker that is not RSTn or a stuffed 0.
pub fn scan_data_end(d: &[u8], mut p: usize) -> usize {
    while p + 1 < d.len() {
        if d[p] == 0xFF {
            let n = d[p + 1];
            if n == 0 || is_rst(n) || n == 0xFF {
                p += if n == 0xFF { 1 } else { 2 };
                continue;
            }
            return p;
        }
        p += 1;
    }
    d.len()
}

/// One table of a DQT segment, as the decoder uses it.
#[derive(Clone, Debug, PartialEq)]
pub struct QTable {
    /// Table slot (Tq); values above 3 are kept so callers can report them.
    pub id: u8,
    /// 0 = 8-bit entries, 1 = 16-bit.
    pub precision: u8,
    /// Natural (row-major) order. Entries missing from a cut-short table are 1.
    pub values: [u16; 64],
    /// The segment ended inside this table.
    pub short: bool,
}

/// Every table in a DQT payload (the one parser for the decoder and inspect()).
pub fn parse_dqt(p: &[u8]) -> Vec<QTable> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < p.len() {
        let precision = p[i] >> 4;
        let id = p[i] & 15;
        i += 1;
        let n = if precision == 0 { 64 } else { 128 };
        let mut z = [1u16; 64];
        for (k, zk) in z.iter_mut().enumerate() {
            let v = if precision == 0 { p.get(i + k).map(|&b| b as u16) } else { p.get(i + 2 * k..i + 2 * k + 2).map(|b| ((b[0] as u16) << 8) | b[1] as u16) };
            if let Some(v) = v {
                *zk = v;
            }
        }
        out.push(QTable { id, precision, values: crate::tables::zigzag_to_natural(&z), short: i + n > p.len() });
        i += n;
    }
    out
}

/// A start-of-scan header.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScanHeader {
    /// (component id, Td/Ta table byte) for the first min(Ns, 4) components; bytes past the end of a cut-short
    /// payload read as 0 (what the decoder then repairs).
    pub comps: Vec<(u8, u8)>,
    /// Ns as written (the spectral fields follow 1 + 2·Ns bytes in).
    pub ns: usize,
    pub ss: u8,
    /// End of the spectral band; 63 when the payload stops before it (a baseline scan).
    pub se: u8,
    pub ah: u8,
    pub al: u8,
}

/// The one SOS parser for the decoder and inspect().
pub fn parse_sos(p: &[u8]) -> ScanHeader {
    let ns = p.first().copied().unwrap_or(0) as usize;
    let comps = (0..ns.min(4)).map(|k| (p.get(1 + 2 * k).copied().unwrap_or(0), p.get(2 + 2 * k).copied().unwrap_or(0))).collect();
    let b = 1 + 2 * ns;
    let a = p.get(b + 2).copied().unwrap_or(0);
    ScanHeader { comps, ns, ss: p.get(b).copied().unwrap_or(0), se: p.get(b + 1).copied().unwrap_or(63), ah: a >> 4, al: a & 15 }
}

/// Walk all segments. Never fails; garbage is skipped until the next plausible marker. 0xFF fill bytes before
/// a marker (FF FF D8) are legal padding, not garbage.
pub fn walk(d: &[u8]) -> Layout {
    let mut l = Layout::default();
    let mut p = 0usize;
    while p + 1 < d.len() {
        if d[p] == 0xFF && d[p + 1] == 0xFF {
            p += 1;
            continue;
        }
        if d[p] != 0xFF || !is_known(d[p + 1]) {
            l.garbage += 1;
            p += 1;
            continue;
        }
        let m = d[p + 1];
        if standalone(m) {
            l.segments.push(Segment { offset: p, marker: m, length: 2, start: p + 2, end: p + 2, truncated: false, scan_end: p + 2 });
            p += 2;
            if m == EOI {
                l.eoi = Some(p - 2);
                l.trailing = d.len() - p;
                break;
            }
            continue;
        }
        let len = if p + 3 < d.len() { ((d[p + 2] as usize) << 8) | d[p + 3] as usize } else { 2 };
        let len = len.max(2);
        let end = p + 2 + len;
        let truncated = end > d.len();
        let end = end.min(d.len());
        let mut seg = Segment { offset: p, marker: m, length: end - p, start: (p + 4).min(d.len()), end, truncated, scan_end: end };
        if m == SOS {
            seg.scan_end = scan_data_end(d, end);
            p = seg.scan_end;
        } else {
            p = end;
        }
        l.segments.push(seg);
    }
    if l.eoi.is_none() {
        l.trailing = 0;
    }
    l
}

/// the header-graft script's trick: neutralise markers that can't appear in entropy data (bit-flip damage,
/// grafted headers, ciphertext) by turning their 0xFF into 0xFE, so the decoder keeps going
/// instead of greying out the rest. Stuffed zeros and RSTn are kept; the last 3 bytes are left
/// alone so a closing EOI survives. Shared by the codec and card crates.
pub fn neutralise_markers(body: &mut [u8]) {
    let n = body.len();
    for q in 0..n.saturating_sub(3) {
        if body[q] == 0xFF {
            let nx = body[q + 1];
            if !(nx == 0 || is_rst(nx)) {
                body[q] = 0xFE;
            }
        }
    }
}

/// True if `d[from..to]` holds no marker other than stuffed zeros, RSTn and a final EOI.
pub fn scan_is_clean(d: &[u8], from: usize, to: usize) -> bool {
    let to = to.min(d.len());
    (from..to.saturating_sub(1)).all(|i| d[i] != 0xFF || d[i + 1] == 0 || is_rst(d[i + 1]) || (d[i + 1] == EOI && i + 2 >= to))
}

/// Build a segment with a length field.
pub fn segment(m: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(payload.len() + 4);
    let len = (payload.len() + 2).min(0xFFFF);
    v.extend_from_slice(&[0xFF, m, (len >> 8) as u8, len as u8]);
    v.extend_from_slice(&payload[..len - 2]);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    // Audit B9 (08-9): one DQT/SOS parser, with the decoder's defaults (missing table values 1, Se 63)
    #[test]
    fn short_dqt_and_sos_use_the_decoder_defaults() {
        let mut p = vec![0x01];
        p.extend(1..=10u8); // table 1, only 10 of its 64 zigzag values
        let t = parse_dqt(&p);
        assert_eq!(t.len(), 1);
        assert!(t[0].short);
        assert_eq!(t[0].id, 1);
        assert_eq!(t[0].values[0], 1);
        assert_eq!(t[0].values[1], 2); // zigzag 1 -> natural 1
        assert_eq!(t[0].values[8], 3); // zigzag 2 -> natural 8
        assert_eq!(t[0].values[63], 1);
        let s = parse_sos(&[1, 1, 0x00]);
        assert_eq!((s.ns, s.comps.clone(), s.ss, s.se), (1, vec![(1, 0)], 0, 63));
        let s = parse_sos(&[3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0x21]);
        assert_eq!((s.comps.len(), s.ss, s.se, s.ah, s.al), (3, 0, 63, 2, 1));
    }

    #[test]
    fn ff_fill_bytes_are_not_garbage() {
        let d = [0xFF, 0xD8, 0xFF, 0xFF, 0xFF, 0xFE, 0x00, 0x03, 1, 0xFF, 0xD9];
        let l = walk(&d);
        assert_eq!(l.garbage, 0);
        assert_eq!(l.segments.iter().map(|s| s.marker).collect::<Vec<_>>(), vec![SOI, COM, EOI]);
    }

    #[test]
    fn walk_garbage() {
        let d = [0x00, 0x12, 0xFF, 0xD8, 0xFF, 0xFE, 0x00, 0x04, 1, 2, 0xFF, 0xD9, 9, 9];
        let l = walk(&d);
        assert_eq!(l.segments.len(), 3);
        assert_eq!(l.eoi, Some(10));
        assert_eq!(l.trailing, 2);
    }
}
