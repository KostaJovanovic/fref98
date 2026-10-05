//! Forgiving JPEG parser + entropy decoder (baseline/extended sequential and progressive Huffman).
//! Produces quantised coefficients plus an event log. Corrupt-data behaviour follows
//! libjpeg-turbo: when data runs out or a marker shows up, the rest of the MCU is decoded from
//! zero bits and following MCUs are left at zero (grey) until the next restart marker; DC
//! predictors carry their accumulated values; restart resync follows jpeg_resync_to_restart.

use crate::arith::{ArithDecoder, Conditioning, AC_BINS, DC_BINS};
use crate::bits::{BitReader, Hit};
use crate::coeffs::*;
use crate::huffman::{DecTable, HuffSpec};
use crate::markers::{is_rst, name as marker_name};
use crate::tables::NATURAL_ORDER;
use serde::Serialize;

pub const MAX_DIM: usize = 16384;
pub const MAX_PIXELS: usize = 80_000_000;
const MAX_EVENTS: usize = 1000;

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    pub kind: &'static str,
    /// MCU index within the scan (for single-component scans: block index of that component),
    /// -1 for header-level events.
    pub mcu: i64,
    /// File offset the event refers to.
    pub byte: i64,
    pub detail: String,
    /// Scan number (0-based) the event happened in, -1 outside scans.
    pub scan: i64,
    /// Component (0-based) for single-component scans, -1 otherwise.
    pub comp: i64,
    /// Top-left pixel of the MCU / block, -1 when not tied to a position.
    pub x: i64,
    pub y: i64,
}

/// Geometry of the scan being decoded, used to place events on the picture.
#[derive(Clone, Copy, Default)]
struct EvCtx {
    active: bool,
    scan: i64,
    comp: i64,
    per_row: usize,
    cell_w: usize,
    cell_h: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanSpec {
    /// Component indices (into the frame's component list).
    pub comps: Vec<usize>,
    pub td: Vec<usize>,
    pub ta: Vec<usize>,
    pub ss: u8,
    pub se: u8,
    pub ah: u8,
    pub al: u8,
}

#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub restart_interval: usize,
    pub progressive: bool,
    pub arithmetic: bool,
    pub precision: u8,
    pub sof_marker: u8,
    /// Huffman specs per component (DC, AC) as used by the first scan containing it.
    pub comp_huff: Vec<(Option<HuffSpec>, Option<HuffSpec>)>,
    pub qtables: [Option<[u16; 64]>; 4],
    pub adobe: Option<u8>,
    pub jfif: bool,
    /// APPn / COM segments before the frame (marker, payload).
    pub segments: Vec<(u8, Vec<u8>)>,
    pub scans: Vec<ScanSpec>,
    pub eoi: Option<usize>,
    /// Huffman tables were missing and replaced by the standard ones.
    pub huff_repaired: bool,
}

#[derive(Default)]
pub struct Parsed {
    pub img: Option<CoeffImage>,
    pub meta: Meta,
    pub events: Vec<Event>,
    /// Bit offset where each MCU (mcu_grid raster order) starts in the first full scan.
    pub mcu_bits: Vec<u32>,
    /// Bits spent per block (per component), from the first scan containing the component.
    pub block_bits: Vec<Vec<u32>>,
    /// libjpeg coef_bits per component: -1 = never received, else current Al.
    pub coef_bits: Vec<[i32; 64]>,
    /// coef_bits as they were before the latest scan touching each component (libjpeg-turbo).
    pub prev_coef_bits: Vec<[i32; 64]>,
    /// Progressive scans seen (libjpeg input_scan_number).
    pub scan_count: usize,
    /// Last iMCU row decoded with real data (libjpeg-turbo last_good_iMCU_row).
    pub last_good_imcu: i64,
    ev_ctx: EvCtx,
}

impl Parsed {
    pub fn event(&mut self, kind: &'static str, mcu: i64, byte: i64, detail: String) {
        if self.events.len() < MAX_EVENTS {
            let c = self.ev_ctx;
            let (scan, comp) = if c.active { (c.scan, c.comp) } else { (-1, -1) };
            let (x, y) = if c.active && mcu >= 0 && c.per_row > 0 {
                let m = mcu as usize;
                (((m % c.per_row) * c.cell_w) as i64, ((m / c.per_row) * c.cell_h) as i64)
            } else {
                (-1, -1)
            };
            self.events.push(Event { kind, mcu, byte, detail, scan, comp, x, y });
        }
    }
}

#[inline(always)]
fn extend(v: u32, s: u32) -> i32 {
    if s == 0 {
        0
    } else if v < (1u32 << (s - 1)) {
        v as i32 - (1i32 << s) + 1
    } else {
        v as i32
    }
}

#[inline(always)]
fn huff(r: &mut BitReader, t: &DecTable, bad: &mut u32) -> u8 {
    let p = r.peek(16);
    let e = t.look[(p >> 7) as usize];
    if e != 0 {
        r.skip((e >> 8) as u32);
        return e as u8;
    }
    for l in 10..=16u32 {
        let code = (p >> (16 - l)) as i32;
        if code <= t.maxcode[l as usize] {
            r.skip(l);
            return t.vals[((code + t.valoffset[l as usize]) & 0xFF) as usize];
        }
    }
    // libjpeg consumes 17 bits (the l = 17 sentinel). The 17th bit may need a refill: only
    // invent a zero bit if the data has really run out.
    r.skip(16);
    let _ = r.get(1);
    *bad += 1;
    0
}

#[doc(hidden)]
pub fn huff_for_test(r: &mut BitReader, t: &DecTable, bad: &mut u32) -> u8 {
    huff(r, t, bad)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Sequential,
    DcFirst,
    DcRefine,
    AcFirst,
    AcRefine,
}

struct Tables {
    dc: [Option<(HuffSpec, DecTable)>; 4],
    ac: [Option<(HuffSpec, DecTable)>; 4],
}

pub fn be16(d: &[u8], i: usize) -> usize {
    match (d.get(i), d.get(i + 1)) {
        (Some(&a), Some(&b)) => ((a as usize) << 8) | b as usize,
        _ => 0,
    }
}

struct Dec<'a> {
    d: &'a [u8],
    out: Parsed,
    t: Tables,
    sos_seen: bool,
    scans_done: usize,
    latched: Vec<bool>,
    track_bits: bool,
    mcu_map_done: bool,
    bits_done: Vec<bool>,
    stop: bool,
    /// Arithmetic-coding conditioning (DAC).
    cond: Conditioning,
}

/// Parse and entropy-decode. Never panics; `img` is None only when no frame header was found.
/// Offset to restart header reading from when the normal walk found no frame: the first plausible
/// SOF0/1/2 (8-bit, sane size, 1/3/4 components, matching length; the largest one, so an embedded
/// Exif thumbnail loses to the main image), backed up to the quantisation tables that precede it.
fn find_header_start(d: &[u8]) -> Option<usize> {
    let sof = (2..d.len().saturating_sub(10))
        .filter(|&i| {
            if d[i] != 0xFF || !matches!(d[i + 1], 0xC0..=0xC2) {
                return false;
            }
            let len = be16(d, i + 2);
            let n = d[i + 9] as usize;
            matches!(n, 1 | 3 | 4) && len == 8 + 3 * n && d[i + 4] == 8 && be16(d, i + 5) > 0 && be16(d, i + 7) > 0
        })
        .max_by_key(|&i| (be16(d, i + 5) * be16(d, i + 7), std::cmp::Reverse(i)))?;
    let window = sof.saturating_sub(4096);
    let dqt = (window..sof).find(|&i| {
        d[i] == 0xFF && d[i + 1] == 0xDB && {
            let len = be16(d, i + 2);
            len >= 67 && (len - 2) % 65 == 0 && i + 2 + len <= sof + 2
        }
    });
    Some(dqt.unwrap_or(sof))
}

pub fn parse(d: &[u8], track_bits: bool) -> Parsed {
    let mut dec = Dec {
        d,
        out: Parsed::default(),
        t: Tables { dc: [None, None, None, None], ac: [None, None, None, None] },
        sos_seen: false,
        scans_done: 0,
        latched: Vec::new(),
        track_bits,
        mcu_map_done: false,
        bits_done: Vec::new(),
        stop: false,
        cond: Conditioning::default(),
    };
    dec.run();
    dec.out
}

impl<'a> Dec<'a> {
    fn ev(&mut self, kind: &'static str, mcu: i64, byte: usize, detail: String) {
        self.out.event(kind, mcu, byte as i64, detail);
    }

    fn run(&mut self) {
        let d = self.d;
        let pos;
        if d.len() >= 2 && d[0] == 0xFF && d[1] == 0xD8 {
            pos = 2;
        } else if let Some(i) = d.windows(2).position(|w| w == [0xFF, 0xD8]) {
            self.ev("header_repaired", -1, 0, format!("{} bytes of garbage before the start-of-image marker were skipped", i));
            pos = i + 2;
        } else {
            self.ev("header_repaired", -1, 0, "no start-of-image marker; reading markers anyway".into());
            pos = 0;
        }
        self.read_markers(pos);
        if self.out.img.is_none() && !self.stop {
            // A wrong segment length (e.g. bytes inserted into Exif) can make the walk swallow the real
            // headers. Last resort: look for a plausible frame header and re-read from its tables.
            if let Some(start) = find_header_start(d) {
                self.ev("header_repaired", -1, start, "frame header found by searching the file; reading the headers from there".into());
                self.read_markers(start);
            }
        }
        self.finish();
    }

    fn read_markers(&mut self, start_pos: usize) {
        let d = self.d;
        let mut pos = start_pos;
        let mut guard = 0usize;
        while !self.stop && pos < d.len() {
            guard += 1;
            if guard > 1_000_000 {
                break;
            }
            // Skip garbage to the next marker.
            let start = pos;
            while pos < d.len() && d[pos] != 0xFF {
                pos += 1;
            }
            while pos + 1 < d.len() && d[pos] == 0xFF && d[pos + 1] == 0xFF {
                pos += 1;
            }
            if pos + 1 >= d.len() {
                if pos > start && self.try_headless_scan(start) {
                    continue;
                }
                break;
            }
            let m = d[pos + 1];
            if m == 0 {
                // Stuffed zero outside a scan: entropy data without SOS?
                if self.try_headless_scan(start) {
                    pos = self.d.len();
                    continue;
                }
                pos += 2;
                continue;
            }
            if pos > start && pos - start > 64 && self.try_headless_scan(start) {
                continue;
            }
            let at = pos;
            pos += 2;
            match m {
                0xD8 => {
                    if self.out.img.is_some() {
                        self.ev("header_repaired", -1, at, "extra start-of-image marker ignored".into());
                    }
                }
                0xD9 => {
                    if !self.sos_seen && at + 2 < d.len() {
                        // Usually the tail of an embedded thumbnail seen through a misaligned
                        // header; keep looking for the real image.
                        self.ev("header_repaired", -1, at, "stray end-of-image marker in the header ignored".into());
                        continue;
                    }
                    self.out.meta.eoi = Some(at);
                    if !self.sos_seen {
                        self.ev("eoi_early", -1, at, "end-of-image marker before any image data".into());
                    }
                    break;
                }
                0xD0..=0xD7 | 0x01 => {}
                _ if !crate::markers::is_known(m) => {
                    // Not a marker any decoder knows: treat as garbage and keep scanning.
                    pos = at + 1;
                }
                _ => {
                    let len = be16(d, pos);
                    if pos + 2 > d.len() {
                        self.ev("truncated", -1, at, format!("file ends inside the {} header", marker_name(m)));
                        break;
                    }
                    let len = if len < 2 {
                        self.ev("header_repaired", -1, at, format!("{} has an impossible length {}", marker_name(m), len));
                        2
                    } else {
                        len
                    };
                    let end = pos + len;
                    if end > d.len() {
                        self.ev("truncated", -1, at, format!("{} segment runs past the end of the file", marker_name(m)));
                    }
                    let end = end.min(d.len());
                    let payload = &d[pos + 2..end];
                    match m {
                        0xC4 => self.read_dht(payload, at),
                        0xDB => self.read_dqt(payload, at),
                        0xDD => self.out.meta.restart_interval = be16(payload, 0),
                        0xCC => {
                            if !self.cond.read_dac(payload) {
                                self.ev("header_repaired", -1, at, "arithmetic conditioning table (DAC) out of range; entry ignored".into());
                            }
                        }
                        0xC0..=0xCF if m != 0xC4 && m != 0xC8 && m != 0xCC => self.read_sof(m, payload, at),
                        0xDA => {
                            pos = self.read_sos(payload, at, end);
                            continue;
                        }
                        0xE0..=0xEF | 0xFE => self.read_app(m, payload),
                        _ => {}
                    }
                    pos = end;
                }
            }
        }
    }

    fn finish(&mut self) {
        let d = self.d;
        if self.out.img.is_none() {
            // No frame header at all: fall back to the size recorded in Exif (grey image).
            let dims = self.out.meta.segments.iter().filter(|(m, _)| *m == 0xE1).find_map(|(_, p)| crate::exif::dims(p));
            if let Some((w, h)) = dims {
                self.ev("header_repaired", -1, 0, format!("no frame header; using the {}x{} size recorded in Exif", w, h));
                let mut sof = vec![8, (h >> 8) as u8, h as u8, (w >> 8) as u8, w as u8, 3];
                sof.extend_from_slice(&[1, 0x21, 0, 2, 0x11, 1, 3, 0x11, 1]);
                self.read_sof(0xC0, &sof, 0);
            }
        }
        if !self.sos_seen && self.out.img.is_some() {
            self.ev("truncated", 0, d.len(), "no image data found after the header".into());
            self.mark_all_unseen();
        }
        if let Some(img) = &mut self.out.img {
            // libjpeg default_decompress_parms: JFIF wins over Adobe; then component ids.
            let meta = &self.out.meta;
            let ids: Vec<u8> = img.comps.iter().map(|c| c.id).collect();
            img.color = match ids.len() {
                1 => ColorSpace::Gray,
                3 if meta.jfif => ColorSpace::YCbCr,
                3 => match meta.adobe {
                    Some(0) => ColorSpace::Rgb,
                    Some(_) => ColorSpace::YCbCr,
                    None if ids == [b'R', b'G', b'B'] => ColorSpace::Rgb,
                    None => ColorSpace::YCbCr,
                },
                4 if meta.adobe == Some(2) => ColorSpace::Ycck,
                4 => ColorSpace::Cmyk,
                _ => ColorSpace::Gray,
            };
            for (ci, c) in img.comps.iter_mut().enumerate() {
                if !self.latched.get(ci).copied().unwrap_or(false) {
                    if let Some(q) = self.out.meta.qtables.get(c.tq).copied().flatten() {
                        c.q = q;
                    }
                }
            }
        }
    }

    fn mark_all_unseen(&mut self) {
        let n = self.out.img.as_ref().map(|i| { let (a, b) = i.mcu_grid(); a * b }).unwrap_or(0);
        if self.out.mcu_bits.len() != n {
            self.out.mcu_bits = vec![u32::MAX; n];
        }
    }

    /// Scan data without an SOS header (header lost): decode with a default scan if a frame exists.
    fn try_headless_scan(&mut self, start: usize) -> bool {
        if self.sos_seen || self.out.img.is_none() || self.stop {
            return false;
        }
        let ncomp = self.out.img.as_ref().map(|i| i.comps.len()).unwrap_or(0);
        if ncomp == 0 || ncomp > 4 {
            return false;
        }
        self.ev("header_repaired", -1, start, "image data without a start-of-scan header; assuming one scan of all components".into());
        let scan = ScanSpec {
            comps: (0..ncomp).collect(),
            td: (0..ncomp).map(|i| (i > 0) as usize).collect(),
            ta: (0..ncomp).map(|i| (i > 0) as usize).collect(),
            ss: 0,
            se: 63,
            ah: 0,
            al: 0,
        };
        self.sos_seen = true;
        let prog = self.out.meta.progressive;
        self.out.meta.progressive = false;
        self.decode_scan(&scan, start);
        self.out.meta.progressive = prog;
        self.stop = true;
        true
    }

    fn read_app(&mut self, m: u8, p: &[u8]) {
        if m == 0xEE && p.len() >= 12 && &p[0..5] == b"Adobe" {
            self.out.meta.adobe = Some(p[11]);
        }
        if m == 0xE0 && p.len() >= 5 && &p[0..5] == b"JFIF\0" {
            self.out.meta.jfif = true;
        }
        if !self.sos_seen && self.out.meta.segments.len() < 64 {
            self.out.meta.segments.push((m, p.to_vec()));
        }
    }

    fn read_dqt(&mut self, p: &[u8], at: usize) {
        let mut i = 0;
        while i < p.len() {
            let pq = p[i] >> 4;
            let tq = (p[i] & 15) as usize;
            i += 1;
            let n = if pq == 0 { 64 } else { 128 };
            if i + n > p.len() {
                self.ev("header_repaired", -1, at, "quantisation table is cut short; missing values set to 1".into());
            }
            let mut z = [1u16; 64];
            for (k, zk) in z.iter_mut().enumerate() {
                let v = if pq == 0 { p.get(i + k).map(|&b| b as u16) } else { Some(be16(p, i + 2 * k) as u16).filter(|_| i + 2 * k + 1 < p.len()) };
                if let Some(v) = v {
                    *zk = v;
                }
            }
            i += n;
            if tq > 3 {
                self.ev("header_repaired", -1, at, format!("quantisation table id {} out of range", tq));
                continue;
            }
            let mut nat = [0u16; 64];
            for k in 0..64 {
                nat[NATURAL_ORDER[k]] = z[k];
            }
            self.out.meta.qtables[tq] = Some(nat);
        }
    }

    fn read_dht(&mut self, p: &[u8], at: usize) {
        let mut i = 0;
        while i < p.len() {
            let tc = p[i] >> 4;
            let th = (p[i] & 15) as usize;
            i += 1;
            let mut bits = [0u8; 16];
            for (k, b) in bits.iter_mut().enumerate() {
                *b = p.get(i + k).copied().unwrap_or(0);
            }
            i += 16;
            let mut total: usize = 0;
            for b in bits.iter_mut() {
                if total + *b as usize > 256 {
                    *b = (256 - total) as u8;
                }
                total += *b as usize;
            }
            let avail = p.len().saturating_sub(i).min(total);
            if avail < total {
                self.ev("header_repaired", -1, at, "Huffman table is cut short".into());
            }
            let mut vals = p[i.min(p.len())..i.min(p.len()) + avail].to_vec();
            vals.resize(total, 0);
            i += total;
            if th > 3 || tc > 1 {
                self.ev("bad_huffman", -1, at, format!("Huffman table class {} id {} out of range", tc, th));
                continue;
            }
            let spec = HuffSpec { bits, vals };
            let dt = DecTable::new(&spec);
            if tc == 0 {
                self.t.dc[th] = Some((spec, dt));
            } else {
                self.t.ac[th] = Some((spec, dt));
            }
        }
    }

    fn read_sof(&mut self, m: u8, p: &[u8], at: usize) {
        if self.out.img.is_some() {
            if self.scans_done > 0 {
                self.ev("bad_marker", -1, at, "a second image header follows; stopping here".into());
                self.stop = true;
            } else {
                self.ev("header_repaired", -1, at, "duplicate frame header ignored".into());
            }
            return;
        }
        let precision = p.first().copied().unwrap_or(8);
        let mut height = be16(p, 1);
        let mut width = be16(p, 3);
        let nf = p.get(5).copied().unwrap_or(0) as usize;
        let mut specs = Vec::new();
        for k in 0..nf.min(4) {
            let b = 6 + 3 * k;
            if b >= p.len() {
                self.ev("header_repaired", -1, at, "frame header is cut short; missing components dropped".into());
                break;
            }
            let id = p.get(b).copied().unwrap_or(k as u8 + 1);
            let hv = p.get(b + 1).copied().unwrap_or(0x11);
            let tq = p.get(b + 2).copied().unwrap_or(0) as usize;
            let (mut h, mut v) = ((hv >> 4) as usize, (hv & 15) as usize);
            if !(1..=4).contains(&h) || !(1..=4).contains(&v) {
                self.ev("header_repaired", -1, at, format!("component {} has invalid sampling {}x{}", id, h, v));
                h = h.clamp(1, 4);
                v = v.clamp(1, 4);
            }
            specs.push(CompSpec { id, h, v, tq: if tq > 3 { 0 } else { tq } });
        }
        if nf > 4 {
            self.ev("header_repaired", -1, at, format!("{} components; only the first 4 are used", nf));
        }
        if specs.is_empty() {
            self.ev("header_repaired", -1, at, "frame header has no components; assuming greyscale".into());
            specs.push(CompSpec { id: 1, h: 1, v: 1, tq: 0 });
        }
        if width == 0 {
            self.ev("header_repaired", -1, at, "frame width is zero; guessing 640".into());
            width = 640;
        }
        if height == 0 {
            height = (width * 3 / 4).max(8);
            self.ev("header_repaired", -1, at, format!("frame height is zero; guessing {}", height));
        }
        if width > MAX_DIM || height > MAX_DIM {
            self.ev("header_repaired", -1, at, format!("{}x{} is too large; clamped", width, height));
            width = width.min(MAX_DIM);
            height = height.min(MAX_DIM);
        }
        if width * height > MAX_PIXELS {
            height = (MAX_PIXELS / width).max(1);
            self.ev("header_repaired", -1, at, format!("image clamped to {}x{}", width, height));
        }
        if precision != 8 {
            self.ev("unsupported", -1, at, format!("{}-bit samples decoded as 8-bit", precision));
        }
        if m >= 0xC9 && !matches!(m, 0xCB | 0xCF) {
            self.ev("arithmetic", -1, at, "arithmetic-coded image (SOF9/10): many viewers and browsers cannot open it".into());
        }
        if matches!(m, 0xC3 | 0xC7 | 0xCB | 0xCF) {
            self.ev("unsupported", -1, at, "lossless JPEG is not supported; image data left grey".into());
        }
        let meta = &mut self.out.meta;
        meta.precision = precision;
        meta.sof_marker = m;
        meta.progressive = matches!(m, 0xC2 | 0xC6 | 0xCA | 0xCE);
        meta.arithmetic = m >= 0xC9;
        let img = CoeffImage::new(width, height, &specs, ColorSpace::YCbCr);
        let n = img.comps.len();
        self.latched = vec![false; n];
        self.bits_done = vec![false; n];
        self.out.coef_bits = vec![[-1; 64]; n];
        self.out.prev_coef_bits = vec![[0; 64]; n];
        self.out.meta.comp_huff = vec![(None, None); n];
        if self.track_bits {
            self.out.block_bits = img.comps.iter().map(|c| vec![0u32; c.bw * c.bh]).collect();
        }
        let (gx, gy) = img.mcu_grid();
        self.out.mcu_bits = vec![u32::MAX; gx * gy];
        self.out.img = Some(img);
    }

    /// Returns the position to continue marker parsing from.
    fn read_sos(&mut self, p: &[u8], at: usize, end: usize) -> usize {
        self.sos_seen = true;
        let Some(img) = self.out.img.as_ref() else {
            self.ev("header_repaired", -1, at, "start of scan before any frame header; skipped".into());
            return crate::markers::scan_data_end(self.d, end);
        };
        let ncomp = img.comps.len();
        let ids: Vec<u8> = img.comps.iter().map(|c| c.id).collect();
        let ns = p.first().copied().unwrap_or(0) as usize;
        let mut scan = ScanSpec::default();
        for k in 0..ns.min(4) {
            let cs = p.get(1 + 2 * k).copied().unwrap_or(0);
            let t = p.get(2 + 2 * k).copied().unwrap_or(0);
            let idx = match ids.iter().position(|&c| c == cs) {
                Some(i) => i,
                None => {
                    let guess = if ns == ncomp { k } else { k.min(ncomp - 1) };
                    self.out.event("header_repaired", -1, at as i64, format!("scan names unknown component {}; using component #{}", cs, guess + 1));
                    guess
                }
            };
            if scan.comps.contains(&idx) {
                continue;
            }
            scan.comps.push(idx);
            scan.td.push(((t >> 4) as usize).min(3));
            scan.ta.push(((t & 15) as usize).min(3));
        }
        let b = 1 + 2 * ns;
        scan.ss = p.get(b).copied().unwrap_or(0);
        scan.se = p.get(b + 1).copied().unwrap_or(63);
        let a = p.get(b + 2).copied().unwrap_or(0);
        scan.ah = a >> 4;
        scan.al = a & 15;
        if scan.comps.is_empty() {
            self.ev("header_repaired", -1, at, "scan header lists no components; assuming all".into());
            scan.comps = (0..ncomp).collect();
            scan.td = (0..ncomp).map(|i| (i > 0) as usize).collect();
            scan.ta = scan.td.clone();
        }
        self.decode_scan(&scan, end)
    }

    fn table(&mut self, ac: bool, id: usize, at: usize) -> (HuffSpec, DecTable) {
        let slot = if ac { &self.t.ac[id] } else { &self.t.dc[id] };
        if let Some(t) = slot {
            return t.clone();
        }
        let spec = if ac { HuffSpec::std_ac(id > 0) } else { HuffSpec::std_dc(id > 0) };
        self.out.meta.huff_repaired = true;
        self.ev(
            "header_repaired",
            -1,
            at,
            format!("missing {} Huffman table {}; using the standard one", if ac { "AC" } else { "DC" }, id),
        );
        let dt = DecTable::new(&spec);
        if ac {
            self.t.ac[id] = Some((spec.clone(), dt.clone()));
        } else {
            self.t.dc[id] = Some((spec.clone(), dt.clone()));
        }
        (spec, dt)
    }

    fn decode_scan(&mut self, scan: &ScanSpec, data_start: usize) -> usize {
        let d = self.d;
        let Some(mut img) = self.out.img.take() else {
            return data_start;
        };
        let meta_prog = self.out.meta.progressive;
        let ri = self.out.meta.restart_interval;
        self.out.meta.scans.push(scan.clone());

        // Latch quantisation tables (libjpeg latch_quant_tables).
        for &ci in &scan.comps {
            if !self.latched[ci] {
                self.latched[ci] = true;
                match self.out.meta.qtables[img.comps[ci].tq] {
                    Some(q) => img.comps[ci].q = q,
                    None => {
                        self.out.event("header_repaired", -1, data_start as i64, format!("missing quantisation table {}; using a standard one", img.comps[ci].tq));
                        let q = default_q(img.comps[ci].tq);
                        self.out.meta.qtables[img.comps[ci].tq] = Some(q);
                        img.comps[ci].q = q;
                    }
                }
            }
        }

        let arith = self.out.meta.arithmetic;
        if matches!(self.out.meta.sof_marker, 0xC3 | 0xC7 | 0xCB | 0xCF) {
            self.out.img = Some(img);
            self.scans_done += 1;
            return crate::markers::scan_data_end(d, data_start);
        }

        // Progression checks (jdphuff start_pass).
        let (dc_first, dc_refine, ac_first, ac_refine);
        if meta_prog {
            let is_dc = scan.ss == 0;
            let mut bad = false;
            if is_dc {
                bad |= scan.se != 0;
            } else {
                bad |= scan.ss > scan.se || scan.se > 63 || scan.comps.len() != 1;
            }
            if scan.ah != 0 && scan.al + 1 != scan.ah {
                bad = true;
            }
            bad |= scan.al > 13;
            if bad {
                self.out.event(
                    "bad_marker",
                    -1,
                    data_start as i64,
                    format!("invalid progressive scan (Ss={} Se={} Ah={} Al={}); skipped", scan.ss, scan.se, scan.ah, scan.al),
                );
                self.out.img = Some(img);
                return crate::markers::scan_data_end(d, data_start);
            }
            self.out.scan_count += 1;
            for &ci in &scan.comps {
                if !is_dc && self.out.coef_bits[ci][0] < 0 {
                    self.out.event("bogus_progression", -1, data_start as i64, format!("detail scan for component {} arrives before its DC scan", ci + 1));
                }
                let first = self.out.scan_count == 1;
                for k in (scan.ss as usize).min(1)..=(scan.se as usize).clamp(9, 63) {
                    self.out.prev_coef_bits[ci][k] = if first { 0 } else { self.out.coef_bits[ci][k] };
                }
                for k in scan.ss as usize..=(scan.se as usize).min(63) {
                    self.out.coef_bits[ci][k] = scan.al as i32;
                }
            }
            dc_first = is_dc && scan.ah == 0;
            dc_refine = is_dc && scan.ah != 0;
            ac_first = !is_dc && scan.ah == 0;
            ac_refine = !is_dc && scan.ah != 0;
        } else {
            for &ci in &scan.comps {
                self.out.coef_bits[ci] = [0; 64];
            }
            dc_first = false;
            dc_refine = false;
            ac_first = false;
            ac_refine = false;
        }
        let sequential = !meta_prog;

        // Tables.
        let mut dct = Vec::new();
        let mut act = Vec::new();
        for (k, &ci) in scan.comps.iter().enumerate() {
            let need_dc = !arith && (sequential || dc_first);
            let need_ac = !arith && (sequential || ac_first || ac_refine);
            let dcs = if need_dc { Some(self.table(false, scan.td[k], data_start)) } else { None };
            let acs = if need_ac { Some(self.table(true, scan.ta[k], data_start)) } else { None };
            let ch = &mut self.out.meta.comp_huff[ci];
            if ch.0.is_none() {
                if let Some((s, _)) = &dcs {
                    ch.0 = Some(s.clone());
                }
            }
            if ch.1.is_none() {
                if let Some((s, _)) = &acs {
                    ch.1 = Some(s.clone());
                }
            }
            dct.push(dcs.map(|x| x.1));
            act.push(acs.map(|x| x.1));
        }

        let interleaved = scan.comps.len() > 1;
        let (mx, my) = if interleaved {
            (img.mcux, img.mcuy)
        } else {
            let c = &img.comps[scan.comps[0]];
            (c.wib, c.hib)
        };
        let total = mx * my;
        let (gx, gy) = img.mcu_grid();
        let record_map = !self.mcu_map_done && total == gx * gy && (interleaved || img.comps.len() == 1);
        if record_map {
            self.mcu_map_done = true;
        }
        let track: Vec<bool> = scan.comps.iter().map(|&ci| self.track_bits && !self.bits_done[ci]).collect();
        for &ci in &scan.comps {
            self.bits_done[ci] = true;
        }
        // Event placement for this scan.
        self.out.ev_ctx = if interleaved {
            EvCtx { active: true, scan: self.scans_done as i64, comp: -1, per_row: mx, cell_w: 8 * img.hmax, cell_h: 8 * img.vmax }
        } else {
            let c = &img.comps[scan.comps[0]];
            EvCtx { active: true, scan: self.scans_done as i64, comp: scan.comps[0] as i64, per_row: mx, cell_w: 8 * img.hmax / c.h, cell_h: 8 * img.vmax / c.v }
        };

        if arith {
            let mode = if sequential {
                Mode::Sequential
            } else if dc_first {
                Mode::DcFirst
            } else if dc_refine {
                Mode::DcRefine
            } else if ac_first {
                Mode::AcFirst
            } else {
                Mode::AcRefine
            };
            let cont = self.arith_scan(&mut img, scan, data_start, mode, record_map, &track);
            self.finish_scan(img, scan, sequential, cont);
            return cont;
        }

        let mut r = BitReader::new(d, data_start);
        let mut last_dc = [0i32; 4];
        let mut eobrun: u32 = 0;
        let mut restarts_to_go = ri;
        let mut next_rst: u8 = 0;
        let mut bad = 0u32;
        let mut bad_seen = 0u32;
        let mut was_insufficient = false;
        let mut filling = false;
        let mut dc_jumps = 0;
        let p1: i32 = 1 << scan.al;
        let m1: i32 = -1 << scan.al;

        for mcu in 0..total {
            if ri > 0 {
                if restarts_to_go == 0 {
                    self.process_restart(&mut r, &mut next_rst, mcu);
                    last_dc = [0; 4];
                    eobrun = 0;
                    restarts_to_go = ri;
                    if !r.insufficient {
                        was_insufficient = false;
                        if filling {
                            filling = false;
                            let at = r.pos;
                            self.out.event(
                                "resync",
                                mcu as i64,
                                at as i64,
                                format!("picture data resumes after restart marker RST{}; the gap before it stays {}", (next_rst + 7) & 7, if sequential { "grey" } else { "unrefined" }),
                            );
                        }
                    }
                }
                restarts_to_go -= 1;
            }
            let mux = mcu % mx;
            let muy = mcu / mx;
            if r.insufficient {
                if !filling {
                    filling = true;
                    let detail = if sequential || dc_first {
                        "no more data for this stretch: blocks from here are left empty (grey)"
                    } else {
                        "no more data for this stretch: blocks from here keep only what earlier scans gave them (blurry, blocky)"
                    };
                    self.out.event("fill", mcu as i64, r.byte_offset() as i64, detail.into());
                }
                if sequential {
                    // libjpeg zeroes the MCU buffer; blocks stay empty.
                    for (k, &ci) in scan.comps.iter().enumerate() {
                        let _ = k;
                        let c = &mut img.comps[ci];
                        let (bh_, bv_) = if interleaved { (c.h, c.v) } else { (1, 1) };
                        for by in 0..bv_ {
                            for bx in 0..bh_ {
                                let (x, y) = if interleaved { (mux * c.h + bx, muy * c.v + by) } else { (mux, muy) };
                                if x < c.bw && y < c.bh {
                                    c.block_mut(x, y).fill(0);
                                }
                            }
                        }
                    }
                }
                continue;
            }
            self.out.last_good_imcu = if interleaved { muy as i64 } else { (muy / img.comps[scan.comps[0]].v.max(1)) as i64 };
            if record_map {
                if let Some(e) = self.out.mcu_bits.get_mut(mcu) {
                    *e = r.bit_offset().min(u32::MAX as u64 - 1) as u32;
                }
            }
            for (k, &ci) in scan.comps.iter().enumerate() {
                let c = &mut img.comps[ci];
                let (bh_, bv_) = if interleaved { (c.h, c.v) } else { (1, 1) };
                let q0 = c.q[0] as i32;
                for by in 0..bv_ {
                    for bx in 0..bh_ {
                        let (x, y) = if interleaved { (mux * c.h + bx, muy * c.v + by) } else { (mux, muy) };
                        if x >= c.bw || y >= c.bh {
                            continue;
                        }
                        let bi = y * c.bw + x;
                        let before = if track[k] { r.bit_offset() } else { 0 };
                        let blk = &mut c.coef[bi * 64..bi * 64 + 64];
                        c.seen[bi] = 1;
                        if sequential {
                            blk.fill(0);
                            let dt = dct[k].as_ref().unwrap();
                            let at = act[k].as_ref().unwrap();
                            let s = (huff(&mut r, dt, &mut bad) as u32).min(16);
                            let diff = if s > 0 { extend(r.get(s), s) } else { 0 };
                            last_dc[k] = last_dc[k].wrapping_add(diff);
                            blk[0] = last_dc[k] as i16;
                            if diff.wrapping_mul(q0).unsigned_abs() > 1600 && dc_jumps < 20 {
                                dc_jumps += 1;
                                let step = diff.wrapping_mul(q0) / 8;
                                self.out.event("dc_jump", mcu as i64, r.byte_offset() as i64, format!("component {} level jumps by {}", ci + 1, step));
                            }
                            let mut kk = 1usize;
                            while kk < 64 {
                                let rs = huff(&mut r, at, &mut bad) as u32;
                                let run = (rs >> 4) as usize;
                                let s = rs & 15;
                                if s != 0 {
                                    kk += run;
                                    let v = extend(r.get(s), s);
                                    blk[NATURAL_ORDER[kk]] = v as i16;
                                } else {
                                    if run != 15 {
                                        break;
                                    }
                                    kk += 15;
                                }
                                kk += 1;
                            }
                        } else if dc_first {
                            let dt = dct[k].as_ref().unwrap();
                            let s = (huff(&mut r, dt, &mut bad) as u32).min(16);
                            let diff = if s > 0 { extend(r.get(s), s) } else { 0 };
                            last_dc[k] = last_dc[k].wrapping_add(diff);
                            blk[0] = last_dc[k].wrapping_shl(scan.al as u32) as i16;
                            let jump = diff.wrapping_shl(scan.al as u32).wrapping_mul(q0);
                            if jump.unsigned_abs() > 1600 && dc_jumps < 20 {
                                dc_jumps += 1;
                                self.out.event("dc_jump", mcu as i64, r.byte_offset() as i64, format!("component {} level jumps by {}", ci + 1, jump / 8));
                            }
                        } else if dc_refine {
                            if r.get(1) != 0 {
                                blk[0] |= p1 as i16;
                            }
                        } else if ac_first {
                            if eobrun > 0 {
                                eobrun -= 1;
                            } else {
                                let at = act[k].as_ref().unwrap();
                                let mut kk = scan.ss as usize;
                                let se = scan.se as usize;
                                while kk <= se {
                                    let rs = huff(&mut r, at, &mut bad) as u32;
                                    let run = rs >> 4;
                                    let s = rs & 15;
                                    if s != 0 {
                                        kk += run as usize;
                                        let v = extend(r.get(s), s);
                                        blk[NATURAL_ORDER[kk.min(79)]] = v.wrapping_shl(scan.al as u32) as i16;
                                    } else if run == 15 {
                                        kk += 15;
                                    } else {
                                        eobrun = 1 << run;
                                        if run > 0 {
                                            eobrun += r.get(run);
                                        }
                                        eobrun -= 1;
                                        break;
                                    }
                                    kk += 1;
                                }
                            }
                        } else if ac_refine {
                            let at = act[k].as_ref().unwrap();
                            ac_refine_block(&mut r, at, blk, scan.ss as usize, scan.se as usize, p1, m1, &mut eobrun, &mut bad);
                        }
                        if track[k] {
                            let after = r.bit_offset();
                            if let Some(bb) = self.out.block_bits.get_mut(ci).and_then(|v| v.get_mut(bi)) {
                                *bb = after.saturating_sub(before) as u32;
                            }
                        }
                    }
                }
            }
            if r.insufficient && !was_insufficient {
                was_insufficient = true;
                let (kind, detail) = match r.marker {
                    None => ("truncated", "the file ends here; the decoder invents zero bits".to_string()),
                    Some(Hit { code: 0xD9, .. }) => ("eoi_early", "end-of-image marker arrives before the image is complete".to_string()),
                    Some(Hit { code, .. }) if is_rst(code) => ("bad_marker", format!("restart marker RST{} arrives too early (data lost)", code - 0xD0)),
                    Some(Hit { code, .. }) => ("bad_marker", format!("unexpected marker FF{:02X} inside the image data", code)),
                };
                let byte = r.marker.map(|h| h.at).unwrap_or(r.byte_offset());
                self.out.event(kind, mcu as i64, byte as i64, detail);
            }
            if bad > bad_seen {
                if bad_seen == 0 {
                    self.out.event(
                        "bad_huffman",
                        mcu as i64,
                        r.byte_offset() as i64,
                        "first bit pattern that is not in the Huffman table: decoded as zero, the rest of this stretch is guesswork".into(),
                    );
                }
                bad_seen = bad;
            }
        }
        if bad > 0 {
            self.out.event("bad_huffman", -1, data_start as i64, format!("{} invalid Huffman codes in this scan (decoded as zero)", bad));
        }
        let cont = self.scan_continue(&r, total);
        self.finish_scan(img, scan, sequential, cont);
        cont
    }

    /// Where marker parsing continues after a scan's entropy-coded data.
    fn scan_continue(&mut self, r: &BitReader, total: usize) -> usize {
        match r.marker {
            Some(h) => h.at,
            None => {
                let p = r.pos;
                let e = crate::markers::scan_data_end(self.d, p);
                let extra = e.saturating_sub(p);
                if extra > 16 && !r.eof {
                    self.out.event("extra_data", total as i64, p as i64, format!("{} bytes of image data left over after the last block", extra));
                }
                e
            }
        }
    }

    fn finish_scan(&mut self, img: CoeffImage, scan: &ScanSpec, sequential: bool, cont: usize) {
        self.scans_done += 1;
        self.out.ev_ctx.active = false;
        let all_comps = scan.comps.len() == img.comps.len();
        self.out.img = Some(img);
        if sequential && all_comps {
            // Single-scan sequential image is complete; libjpeg reads no further image data.
            self.stop = true;
            if let Some(e) = find_eoi(self.d, cont) {
                self.out.meta.eoi = Some(e);
            }
        }
    }

    /// Arithmetic-coded scan (jdarith.c). Unlike Huffman data, running into a marker is legal:
    /// the decoder is fed zeros, so a cut-off file keeps "decoding" plausible-looking values
    /// instead of going grey. A decoding error (ct = -1) skips the rest of the restart interval.
    #[allow(clippy::too_many_arguments)]
    fn arith_scan(&mut self, img: &mut CoeffImage, scan: &ScanSpec, data_start: usize, mode: Mode, record_map: bool, track: &[bool]) -> usize {
        let d = self.d;
        let ri = self.out.meta.restart_interval;
        let interleaved = scan.comps.len() > 1;
        let (mx, my) = if interleaved {
            (img.mcux, img.mcuy)
        } else {
            let c = &img.comps[scan.comps[0]];
            (c.wib, c.hib)
        };
        let total = mx * my;
        let cond = self.cond;
        let mut r = BitReader::new(d, data_start);
        let mut ad = ArithDecoder::new();
        let mut dcs = [[0u8; DC_BINS]; 4];
        let mut acs = [[0u8; AC_BINS]; 4];
        let mut last_dc = [0i32; 4];
        let mut ctx = [0usize; 4];
        let mut restarts_to_go = ri;
        let mut next_rst = 0u8;
        let mut zero_from: Option<usize> = None;
        let mut fail_logged = false;
        let mut dc_jumps = 0;
        let resets_dc = matches!(mode, Mode::Sequential | Mode::DcFirst);
        let resets_ac = matches!(mode, Mode::Sequential | Mode::AcFirst | Mode::AcRefine);
        for mcu in 0..total {
            if ri > 0 {
                if restarts_to_go == 0 {
                    self.arith_gap(&r, zero_from.take(), false, next_rst);
                    self.process_restart(&mut r, &mut next_rst, mcu);
                    for k in 0..scan.comps.len() {
                        if resets_dc {
                            dcs[scan.td[k].min(3)] = [0; DC_BINS];
                            last_dc[k] = 0;
                            ctx[k] = 0;
                        }
                        if resets_ac {
                            acs[scan.ta[k].min(3)] = [0; AC_BINS];
                        }
                    }
                    ad.reset();
                    restarts_to_go = ri;
                }
                restarts_to_go -= 1;
            }
            let (mux, muy) = (mcu % mx, mcu / mx);
            // jdarith never raises insufficient_data, so every iMCU row counts as "good".
            self.out.last_good_imcu = if interleaved { muy as i64 } else { (muy / img.comps[scan.comps[0]].v.max(1)) as i64 };
            if record_map {
                if let Some(e) = self.out.mcu_bits.get_mut(mcu) {
                    *e = r.bit_offset().min(u32::MAX as u64 - 1) as u32;
                }
            }
            for (k, &ci) in scan.comps.iter().enumerate() {
                let c = &mut img.comps[ci];
                let (nh, nv) = if interleaved { (c.h, c.v) } else { (1, 1) };
                let (td, ta) = (scan.td[k].min(3), scan.ta[k].min(3));
                let q0 = c.q[0] as i32;
                for by in 0..nv {
                    for bx in 0..nh {
                        let (x, y) = if interleaved { (mux * c.h + bx, muy * c.v + by) } else { (mux, muy) };
                        if x >= c.bw || y >= c.bh {
                            continue;
                        }
                        let bi = y * c.bw + x;
                        let blk = &mut c.coef[bi * 64..bi * 64 + 64];
                        if mode == Mode::Sequential {
                            // libjpeg zeroes the MCU buffer before decoding it.
                            blk.fill(0);
                        }
                        if ad.failed() && mode != Mode::DcRefine {
                            continue;
                        }
                        let before = if track[k] { r.bit_offset() } else { 0 };
                        c.seen[bi] = 1;
                        match mode {
                            Mode::Sequential | Mode::DcFirst => {
                                let Some(diff) = ad.dc_diff(&mut r, &mut dcs[td], &mut ctx[k], cond.dc_l[td], cond.dc_u[td]) else { continue };
                                last_dc[k] = (last_dc[k].wrapping_add(diff)) & 0xFFFF;
                                if mode == Mode::Sequential {
                                    blk[0] = last_dc[k] as u16 as i16;
                                    ad.ac_sequential(&mut r, &mut acs[ta], blk, cond.ac_k[ta]);
                                } else {
                                    blk[0] = (last_dc[k] << scan.al) as u16 as i16;
                                }
                                let jump = diff.wrapping_shl(scan.al as u32).wrapping_mul(q0);
                                if jump.unsigned_abs() > 1600 && dc_jumps < 20 {
                                    dc_jumps += 1;
                                    self.out.event("dc_jump", mcu as i64, r.byte_offset() as i64, format!("component {} level jumps by {}", ci + 1, jump / 8));
                                }
                            }
                            Mode::DcRefine => ad.dc_refine(&mut r, blk, scan.al),
                            Mode::AcFirst => ad.ac_first(&mut r, &mut acs[ta], blk, scan.ss as usize, scan.se as usize, scan.al, cond.ac_k[ta]),
                            Mode::AcRefine => ad.ac_refine(&mut r, &mut acs[ta], blk, scan.ss as usize, scan.se as usize, scan.al),
                        }
                        if track[k] {
                            let after = r.bit_offset();
                            if let Some(bb) = self.out.block_bits.get_mut(ci).and_then(|v| v.get_mut(bi)) {
                                *bb = after.saturating_sub(before) as u32;
                            }
                        }
                    }
                }
            }
            if r.insufficient && zero_from.is_none() {
                zero_from = Some(mcu);
            }
            if ad.failed() && !fail_logged {
                fail_logged = true;
                self.out.event(
                    "bad_code",
                    mcu as i64,
                    r.byte_offset() as i64,
                    "the arithmetic decoder produced an impossible value: the rest of this stretch is skipped".into(),
                );
            }
        }
        self.arith_gap(&r, zero_from, true, next_rst);
        self.scan_continue(&r, total)
    }

    /// Report why an arithmetic decoder had to be fed zeros. Reading a little past the end of a
    /// restart interval is normal (the encoder drops trailing zero bytes); a missing file end, an
    /// early EOI or a stray marker is not.
    fn arith_gap(&mut self, r: &BitReader, zero_from: Option<usize>, scan_end: bool, next_rst: u8) {
        let Some(mcu) = zero_from else { return };
        let (kind, detail, byte) = match r.marker {
            None if r.eof => ("truncated", "the file ends here; the arithmetic decoder carries on with invented zero bits".to_string(), r.data_len()),
            None => return,
            Some(h) if h.code == 0xD9 && !scan_end => ("eoi_early", "end-of-image marker arrives before the image is complete".to_string(), h.at),
            Some(h) if is_rst(h.code) && !scan_end && h.code == 0xD0 + next_rst => return,
            Some(h) if is_rst(h.code) && !scan_end => ("bad_marker", format!("restart marker RST{} arrives out of turn (data lost)", h.code - 0xD0), h.at),
            Some(_) if scan_end => return,
            Some(h) => ("bad_marker", format!("unexpected marker FF{:02X} inside the image data", h.code), h.at),
        };
        self.out.event(kind, mcu as i64, byte as i64, detail);
    }

    fn process_restart(&mut self, r: &mut BitReader, next_rst: &mut u8, mcu: usize) {
        r.discard_bits();
        let before = r.pos;
        let had_marker = r.marker.is_some();
        let h = r.next_marker();
        if !had_marker && h.at > before + 1 {
            self.out.event("resync", mcu as i64, before as i64, format!("skipped {} bytes looking for restart marker RST{}", h.at - before, next_rst));
        }
        let want = 0xD0 + *next_rst;
        if h.code == want {
            r.consume_marker();
        } else {
            self.out.event(
                "rst_missing",
                mcu as i64,
                h.at as i64,
                format!("expected RST{}, found {}", next_rst, describe_marker(h.code)),
            );
            let desired = *next_rst as i32;
            let mut guard = 0;
            loop {
                guard += 1;
                let Some(hm) = r.marker else { break };
                let m = hm.code;
                let action = if m < 0xC0 {
                    2
                } else if !is_rst(m) {
                    3
                } else {
                    let n = (m - 0xD0) as i32;
                    if n == (desired + 1) & 7 || n == (desired + 2) & 7 {
                        3
                    } else if n == (desired - 1) & 7 || n == (desired - 2) & 7 {
                        2
                    } else {
                        1
                    }
                };
                if guard > 100_000 {
                    break;
                }
                match action {
                    1 => {
                        r.consume_marker();
                        self.out.event("resync", mcu as i64, hm.at as i64, format!("accepted {} as the expected restart", describe_marker(m)));
                        break;
                    }
                    2 => {
                        r.consume_marker();
                        let n = r.next_marker();
                        if n.code == 0xD9 && n.at >= r.data_len() {
                            break;
                        }
                    }
                    _ => {
                        self.out.event("resync", mcu as i64, hm.at as i64, format!("left {} for later; this stretch stays empty", describe_marker(m)));
                        break;
                    }
                }
            }
        }
        *next_rst = (*next_rst + 1) & 7;
        if r.marker.is_none() {
            r.insufficient = false;
        }
    }
}

fn describe_marker(m: u8) -> String {
    if is_rst(m) {
        format!("RST{}", m - 0xD0)
    } else {
        format!("{} (FF{:02X})", marker_name(m), m)
    }
}

fn find_eoi(d: &[u8], from: usize) -> Option<usize> {
    let mut p = from;
    while p + 1 < d.len() {
        if d[p] == 0xFF && d[p + 1] == 0xD9 {
            return Some(p);
        }
        p += 1;
    }
    None
}

#[allow(clippy::too_many_arguments)]
#[inline]
fn ac_refine_block(r: &mut BitReader, t: &DecTable, blk: &mut [i16], ss: usize, se: usize, p1: i32, m1: i32, eobrun: &mut u32, bad: &mut u32) {
    let mut k = ss;
    let refine = |r: &mut BitReader, c: &mut i16| {
        if r.get(1) != 0 && (*c as i32 & p1) == 0 {
            if *c >= 0 {
                *c = (*c as i32).wrapping_add(p1) as i16;
            } else {
                *c = (*c as i32).wrapping_add(m1) as i16;
            }
        }
    };
    if *eobrun == 0 {
        while k <= se {
            let rs = huff(r, t, bad) as u32;
            let mut run = (rs >> 4) as i32;
            let mut s = (rs & 15) as i32;
            if s != 0 {
                s = if r.get(1) != 0 { p1 } else { m1 };
            } else if run != 15 {
                *eobrun = 1 << run;
                if run > 0 {
                    *eobrun += r.get(run as u32);
                }
                break;
            }
            loop {
                let pos = NATURAL_ORDER[k.min(79)];
                if blk[pos] != 0 {
                    refine(r, &mut blk[pos]);
                } else {
                    run -= 1;
                    if run < 0 {
                        break;
                    }
                }
                k += 1;
                if k > se {
                    break;
                }
            }
            if s != 0 {
                let pos = NATURAL_ORDER[k.min(79)];
                blk[pos] = s as i16;
            }
            k += 1;
        }
    }
    if *eobrun > 0 {
        while k <= se {
            let pos = NATURAL_ORDER[k];
            if blk[pos] != 0 {
                refine(r, &mut blk[pos]);
            }
            k += 1;
        }
        *eobrun -= 1;
    }
}

#[cfg(test)]
mod tests {
    use crate::encoder::{encode_rgba, EncodeSettings};

    #[test]
    fn frame_found_when_a_bad_length_swallows_the_headers() {
        let (w, h) = (64usize, 48usize);
        let rgba: Vec<u8> = (0..w * h * 4).map(|i| (i * 7 % 251) as u8).collect();
        let clean = encode_rgba(w, h, &rgba, &EncodeSettings::standard(80, "420"));
        // APP1 whose declared length stops 6 bytes short; its tail holds FF EE, which then reads as
        // an APP14 marker with a huge length covering the real tables, frame and scan.
        let mut app = vec![0xFF, 0xE1, 0x00, 0x08, b'E', b'x', b'i', b'f', 0, 0];
        app.extend_from_slice(&[1, 2, 0xFF, 0xEE, 0xF0, 0x00]);
        let mut bad = clean[..2].to_vec();
        bad.extend_from_slice(&app);
        bad.extend_from_slice(&clean[2..]);
        let d = crate::render::decode(&bad, &crate::render::DecodeOpts::default()).expect("should recover the frame");
        assert_eq!((d.width, d.height), (w, h));
        assert!(d.events.iter().any(|e| e.detail.contains("found by searching")));
    }
}
