//! JPEG encoder: RGB -> YCbCr planes -> downsampling -> islow FDCT -> quantisation, and a
//! coefficient writer for baseline/extended sequential and progressive (spectral selection +
//! successive approximation) Huffman JPEG with optional restart intervals.

use crate::bits::BitWriter;
use crate::coeffs::*;
use crate::color::{rgb_to_ycc, Matrix};
use crate::dct::{fdct_islow, quantize};
use crate::decoder::{parse, ScanSpec};
use crate::huffman::{EncTable, HuffSpec};
use crate::markers::{segment, APP0, APP14};
use crate::sample::{downsample, Plane8};
use crate::tables::{scaled_table, NATURAL_ORDER, STD_CHROMA_Q, STD_LUMA_Q};

#[derive(Clone, Debug, PartialEq)]
pub enum HuffMode {
    /// Annex K tables (falls back to optimal tables if a symbol is missing).
    Standard,
    /// Two-pass optimal tables.
    Optimize,
    /// Given (DC, AC) tables per component (fallback as above).
    Fixed(Vec<(HuffSpec, HuffSpec)>),
}

#[derive(Clone, Debug)]
pub struct EncodeSettings {
    pub comps: Vec<CompSpec>,
    /// Quantisation table per component (natural order).
    pub qtables: Vec<[u16; 64]>,
    pub color: ColorSpace,
    pub matrix: Matrix,
    pub huffman: HuffMode,
    pub progressive: bool,
    /// Custom progressive script (None = libjpeg's default).
    pub scans: Option<Vec<ScanSpec>>,
    pub restart_interval: usize,
    /// APPn / COM segments written after SOI.
    pub segments: Vec<(u8, Vec<u8>)>,
    pub jfif: bool,
}

pub fn sampling_factors(sub: &str) -> (usize, usize) {
    match sub {
        "444" => (1, 1),
        "422" => (2, 1),
        "411" => (4, 1),
        "440" => (1, 2),
        _ => (2, 2),
    }
}

impl EncodeSettings {
    /// libjpeg-style settings for a quality and subsampling ("444", "422", "420", "411", "440").
    pub fn standard(quality: i32, sub: &str) -> Self {
        let (h, v) = sampling_factors(sub);
        let lq = scaled_table(&STD_LUMA_Q, quality);
        let cq = scaled_table(&STD_CHROMA_Q, quality);
        EncodeSettings {
            comps: vec![
                CompSpec { id: 1, h, v, tq: 0 },
                CompSpec { id: 2, h: 1, v: 1, tq: 1 },
                CompSpec { id: 3, h: 1, v: 1, tq: 1 },
            ],
            qtables: vec![lq, cq, cq],
            color: ColorSpace::YCbCr,
            matrix: Matrix::Bt601,
            huffman: HuffMode::Standard,
            progressive: false,
            scans: None,
            restart_interval: 0,
            segments: Vec::new(),
            jfif: true,
        }
    }

    pub fn subsampling_name(&self) -> &'static str {
        if self.comps.len() < 3 {
            return "444";
        }
        let (h0, v0) = (self.comps[0].h, self.comps[0].v);
        let (h1, v1) = (self.comps[1].h.max(1), self.comps[1].v.max(1));
        match (h0 / h1, v0 / v1) {
            (1, 1) => "444",
            (2, 1) => "422",
            (2, 2) => "420",
            (4, 1) => "411",
            (1, 2) => "440",
            _ => "420",
        }
    }

    pub fn set_subsampling(&mut self, sub: &str) {
        let (h, v) = sampling_factors(sub);
        if let Some(c) = self.comps.first_mut() {
            c.h = h;
            c.v = v;
        }
        for c in self.comps.iter_mut().skip(1) {
            c.h = 1;
            c.v = 1;
        }
    }

    /// Standard (IJG) tables for quality `q`; whatever tables there were are replaced.
    pub fn set_quality(&mut self, q: i32) {
        for (i, c) in self.comps.iter().enumerate() {
            if let Some(t) = self.qtables.get_mut(i) {
                *t = scaled_table(if c.tq == 0 { &STD_LUMA_Q } else { &STD_CHROMA_Q }, q);
            }
        }
    }

    /// Keeps the tables' own shape (a camera's measured tables) and scales them from the quality they
    /// stand for to `to`, the way libjpeg scales its tables between qualities.
    pub fn rescale_quality(&mut self, from: i32, to: i32) {
        if from == to {
            return;
        }
        let (a, b) = (crate::tables::quality_scale(to).max(1) as i64, crate::tables::quality_scale(from).max(1) as i64);
        for t in self.qtables.iter_mut() {
            for v in t.iter_mut() {
                *v = ((*v as i64 * a + b / 2) / b).clamp(1, 255) as u16;
            }
        }
    }

    /// Copy everything a re-encode needs from an existing (possibly damaged) JPEG.
    pub fn like(data: &[u8]) -> Option<Self> {
        Self::from_parsed(&parse(data, false))
    }

    pub fn from_parsed(p: &crate::decoder::Parsed) -> Option<Self> {
        let img = p.img.as_ref()?;
        let mut comps = img.specs();
        let mut qtables: Vec<[u16; 64]> = img.comps.iter().map(|c| c.q).collect();
        let mut color = img.color;
        if matches!(color, ColorSpace::Cmyk | ColorSpace::Ycck) || comps.len() == 2 || comps.len() > 4 {
            comps.truncate(3);
            qtables.truncate(3);
            color = if comps.len() == 3 { ColorSpace::YCbCr } else { ColorSpace::Gray };
            if comps.len() == 2 {
                comps.truncate(1);
                qtables.truncate(1);
            }
        }
        let all_std = p.meta.comp_huff.iter().all(|(d, a)| d.as_ref().is_none_or(|s| s.is_standard()) && a.as_ref().is_none_or(|s| s.is_standard()));
        let huffman = if p.meta.progressive {
            HuffMode::Optimize
        } else if all_std {
            HuffMode::Standard
        } else {
            let fixed: Vec<(HuffSpec, HuffSpec)> = (0..comps.len())
                .map(|i| {
                    let (d, a) = p.meta.comp_huff.get(i).cloned().unwrap_or((None, None));
                    (d.unwrap_or_else(|| HuffSpec::std_dc(i > 0)), a.unwrap_or_else(|| HuffSpec::std_ac(i > 0)))
                })
                .collect();
            HuffMode::Fixed(fixed)
        };
        let segments = p.meta.segments.iter().filter(|(m, _)| *m != APP0).cloned().collect();
        Some(EncodeSettings {
            comps,
            qtables,
            color,
            matrix: Matrix::Bt601,
            huffman,
            progressive: p.meta.progressive,
            scans: None,
            restart_interval: p.meta.restart_interval,
            segments,
            jfif: p.meta.jfif || !p.meta.segments.iter().any(|(m, _)| *m == APP14),
        })
    }
}

/// RGBA -> full-resolution component planes in the settings' colour space.
pub fn rgba_to_planes(w: usize, h: usize, rgba: &[u8], color: ColorSpace, matrix: Matrix) -> Vec<Plane8> {
    let n = w * h;
    let px = |i: usize| -> (u8, u8, u8) {
        match rgba.get(i * 4..i * 4 + 3) {
            Some(s) => (s[0], s[1], s[2]),
            None => (128, 128, 128),
        }
    };
    match color {
        ColorSpace::Gray => {
            let mut p = Plane8::new(w, h, 0);
            for i in 0..n {
                let (r, g, b) = px(i);
                p.data[i] = rgb_to_ycc(r, g, b, matrix).0;
            }
            vec![p]
        }
        ColorSpace::Rgb => {
            let mut ps = vec![Plane8::new(w, h, 0), Plane8::new(w, h, 0), Plane8::new(w, h, 0)];
            for i in 0..n {
                let (r, g, b) = px(i);
                ps[0].data[i] = r;
                ps[1].data[i] = g;
                ps[2].data[i] = b;
            }
            ps
        }
        _ => {
            let mut ps = vec![Plane8::new(w, h, 0), Plane8::new(w, h, 0), Plane8::new(w, h, 0)];
            for i in 0..n {
                let (r, g, b) = px(i);
                let (y, cb, cr) = rgb_to_ycc(r, g, b, matrix);
                ps[0].data[i] = y;
                ps[1].data[i] = cb;
                ps[2].data[i] = cr;
            }
            ps
        }
    }
}

/// Full-resolution planes -> quantised coefficients (libjpeg edge extension and dummy blocks).
pub fn planes_to_coeffs(planes: &[Plane8], w: usize, h: usize, specs: &[CompSpec], qtables: &[[u16; 64]], color: ColorSpace) -> CoeffImage {
    let mut img = CoeffImage::new(w, h, specs, color);
    let (ew, eh) = (img.mcux * img.hmax * 8, img.mcuy * img.vmax * 8);
    let (hmax, vmax) = (img.hmax, img.vmax);
    let single = img.comps.len() == 1;
    for (ci, c) in img.comps.iter_mut().enumerate() {
        let src = planes.get(ci).or(planes.first());
        let ext = match src {
            Some(p) => p.extend(ew, eh),
            None => Plane8::new(ew, eh, 128),
        };
        let ds = if hmax % c.h == 0 && vmax % c.v == 0 {
            downsample(&ext, hmax / c.h, vmax / c.v)
        } else {
            let (ow, oh) = (ew * c.h / hmax, eh * c.v / vmax);
            let mut o = Plane8::new(ow, oh, 0);
            for y in 0..oh {
                for x in 0..ow {
                    o.data[y * ow + x] = ext.at((x * hmax / c.h).min(ew - 1), (y * vmax / c.v).min(eh - 1));
                }
            }
            o
        };
        c.q = qtables.get(ci).copied().unwrap_or_else(|| default_q(c.tq));
        let mut buf = [0i32; 64];
        for by in 0..c.hib {
            for bx in 0..c.wib {
                for y in 0..8 {
                    let row = (by * 8 + y).min(ds.h.saturating_sub(1));
                    for x in 0..8 {
                        let col = (bx * 8 + x).min(ds.w.saturating_sub(1));
                        buf[y * 8 + x] = ds.data.get(row * ds.w + col).copied().unwrap_or(128) as i32 - 128;
                    }
                }
                fdct_islow(&mut buf);
                let bi = (by * c.bw + bx) * 64;
                for k in 0..64 {
                    c.coef[bi + k] = quantize(buf[k], c.q[k]);
                }
                c.seen[by * c.bw + bx] = 1;
            }
        }
        if single {
            continue;
        }
        // Dummy blocks (jccoefct.c): right edge copies the previous block's DC, bottom rows copy
        // the DC of the last block in the previous block row of the same MCU.
        for by in 0..c.bh {
            for bx in 0..c.bw {
                if bx < c.wib && by < c.hib {
                    continue;
                }
                let dc = if by < c.hib {
                    c.coef[(by * c.bw + bx - 1) * 64]
                } else {
                    let mx = (bx / c.h) * c.h + c.h - 1;
                    if by == 0 {
                        0
                    } else {
                        c.coef[((by - 1) * c.bw + mx) * 64]
                    }
                };
                c.coef[(by * c.bw + bx) * 64] = dc;
            }
        }
    }
    img
}

// ---------------------------------------------------------------------------------------------
// Entropy coding

trait Sink {
    fn sym(&mut self, t: usize, s: u8);
    fn bits(&mut self, v: u32, n: u32);
    fn restart(&mut self, n: u8);
}

struct Counter {
    freq: Vec<[u32; 257]>,
}
impl Sink for Counter {
    #[inline]
    fn sym(&mut self, t: usize, s: u8) {
        self.freq[t][s as usize] += 1;
    }
    #[inline]
    fn bits(&mut self, _v: u32, _n: u32) {}
    fn restart(&mut self, _n: u8) {}
}

struct Emitter {
    w: BitWriter,
    enc: Vec<EncTable>,
}
impl Sink for Emitter {
    #[inline]
    fn sym(&mut self, t: usize, s: u8) {
        let e = &self.enc[t];
        self.w.put(e.code[s as usize], e.size[s as usize] as u32);
    }
    #[inline]
    fn bits(&mut self, v: u32, n: u32) {
        self.w.put(v, n);
    }
    fn restart(&mut self, n: u8) {
        self.w.flush();
        self.w.out.push(0xFF);
        self.w.out.push(0xD0 + (n & 7));
    }
}

#[inline]
fn magnitude(v: i32) -> (u32, u32) {
    let v = v.clamp(-32767, 32767);
    let a = v.unsigned_abs();
    let nb = 32 - a.leading_zeros();
    let bits = if v < 0 { (v - 1) as u32 & ((1u32 << nb) - 1) } else { v as u32 };
    (nb, bits)
}

/// Table slots: DC tables at 0..4, AC tables at 4..8.
struct ScanTables {
    dc: Vec<usize>,
    ac: Vec<usize>,
}

struct Prog {
    eobrun: u32,
    be: Vec<u8>,
}

fn emit_eobrun<S: Sink>(s: &mut S, st: &mut Prog, act: usize) {
    if st.eobrun > 0 {
        let nb = 31 - st.eobrun.leading_zeros();
        s.sym(act, (nb.min(14) << 4) as u8);
        if nb > 0 {
            s.bits(st.eobrun, nb);
        }
        st.eobrun = 0;
        for &b in &st.be {
            s.bits(b as u32, 1);
        }
        st.be.clear();
    }
}

fn encode_scan<S: Sink>(img: &CoeffImage, scan: &ScanSpec, progressive: bool, ri: usize, t: &ScanTables, s: &mut S) {
    let interleaved = scan.comps.len() > 1;
    let (mx, my) = if interleaved {
        (img.mcux, img.mcuy)
    } else {
        let c = &img.comps[scan.comps[0]];
        (c.wib, c.hib)
    };
    let mut last = [0i16; 4];
    let mut st = Prog { eobrun: 0, be: Vec::new() };
    let mut next_rst = 0u8;
    let is_dc = scan.ss == 0;
    let al = scan.al as u32;
    let total = mx * my;
    for mcu in 0..total {
        if ri > 0 && mcu > 0 && mcu % ri == 0 {
            if progressive {
                emit_eobrun(s, &mut st, t.ac.first().copied().unwrap_or(4));
            }
            s.restart(next_rst);
            next_rst = (next_rst + 1) & 7;
            last = [0; 4];
        }
        let (mux, muy) = (mcu % mx, mcu / mx);
        for (k, &ci) in scan.comps.iter().enumerate() {
            let c = &img.comps[ci];
            let (nh, nv) = if interleaved { (c.h, c.v) } else { (1, 1) };
            for by in 0..nv {
                for bx in 0..nh {
                    let (x, y) = if interleaved { (mux * c.h + bx, muy * c.v + by) } else { (mux, muy) };
                    let blk = if x < c.bw && y < c.bh { c.block(x, y) } else { &[0i16; 64][..] };
                    let (dct, act) = (t.dc[k], t.ac[k]);
                    if !progressive {
                        let diff = blk[0].wrapping_sub(last[k]) as i32;
                        last[k] = blk[0];
                        let (nb, bits) = magnitude(diff);
                        s.sym(dct, nb as u8);
                        s.bits(bits, nb);
                        let mut run = 0u32;
                        for kk in 1..64 {
                            let v = blk[NATURAL_ORDER[kk]] as i32;
                            if v == 0 {
                                run += 1;
                                continue;
                            }
                            while run > 15 {
                                s.sym(act, 0xF0);
                                run -= 16;
                            }
                            let (nb, bits) = magnitude(v);
                            s.sym(act, ((run << 4) | nb) as u8);
                            s.bits(bits, nb);
                            run = 0;
                        }
                        if run > 0 {
                            s.sym(act, 0);
                        }
                    } else if is_dc && scan.ah == 0 {
                        let v = blk[0] >> al;
                        let diff = v.wrapping_sub(last[k]) as i32;
                        last[k] = v;
                        let (nb, bits) = magnitude(diff);
                        s.sym(dct, nb as u8);
                        s.bits(bits, nb);
                    } else if is_dc {
                        s.bits(((blk[0] >> al) & 1) as u32, 1);
                    } else if scan.ah == 0 {
                        let mut run = 0u32;
                        for kk in scan.ss as usize..=scan.se as usize {
                            let v = blk[NATURAL_ORDER[kk]] as i32;
                            if v == 0 {
                                run += 1;
                                continue;
                            }
                            let (mag, neg) = if v < 0 { ((-v) >> al, true) } else { (v >> al, false) };
                            if mag == 0 {
                                run += 1;
                                continue;
                            }
                            emit_eobrun(s, &mut st, act);
                            while run > 15 {
                                s.sym(act, 0xF0);
                                run -= 16;
                            }
                            let mag = mag.min(32767) as u32;
                            let nb = 32 - mag.leading_zeros();
                            let bits = if neg { !mag & ((1u32 << nb) - 1) } else { mag };
                            s.sym(act, ((run << 4) | nb) as u8);
                            s.bits(bits, nb);
                            run = 0;
                        }
                        if run > 0 {
                            st.eobrun += 1;
                            if st.eobrun == 0x7FFF {
                                emit_eobrun(s, &mut st, act);
                            }
                        }
                    } else {
                        ac_refine(s, &mut st, blk, scan.ss as usize, scan.se as usize, al, act);
                    }
                }
            }
        }
    }
    if progressive {
        emit_eobrun(s, &mut st, t.ac.first().copied().unwrap_or(4));
    }
}

fn ac_refine<S: Sink>(s: &mut S, st: &mut Prog, blk: &[i16], ss: usize, se: usize, al: u32, act: usize) {
    let mut absv = [0u32; 64];
    let mut eob = 0usize;
    for k in ss..=se {
        let v = (blk[NATURAL_ORDER[k]] as i32).unsigned_abs() >> al;
        absv[k] = v;
        if v == 1 {
            eob = k;
        }
    }
    let mut r = 0u32;
    let mut br: Vec<u8> = Vec::new();
    for k in ss..=se {
        let t = absv[k];
        if t == 0 {
            r += 1;
            continue;
        }
        while r > 15 && k <= eob {
            emit_eobrun(s, st, act);
            s.sym(act, 0xF0);
            r -= 16;
            for &b in &br {
                s.bits(b as u32, 1);
            }
            br.clear();
        }
        if t > 1 {
            br.push((t & 1) as u8);
            continue;
        }
        emit_eobrun(s, st, act);
        s.sym(act, ((r << 4) + 1) as u8);
        s.bits(if blk[NATURAL_ORDER[k]] < 0 { 0 } else { 1 }, 1);
        for &b in &br {
            s.bits(b as u32, 1);
        }
        br.clear();
        r = 0;
    }
    if r > 0 || !br.is_empty() {
        st.eobrun += 1;
        st.be.extend_from_slice(&br);
        if st.eobrun == 0x7FFF || st.be.len() > 1000 - 64 + 1 {
            emit_eobrun(s, st, act);
        }
    }
}

/// libjpeg's jpeg_simple_progression script.
pub fn default_script(img: &CoeffImage) -> Vec<ScanSpec> {
    let n = img.comps.len();
    let blocks: usize = img.comps.iter().map(|c| c.h * c.v).sum();
    let one = |c: usize, ss: u8, se: u8, ah: u8, al: u8| ScanSpec { comps: vec![c], td: vec![(c > 0) as usize], ta: vec![(c > 0) as usize], ss, se, ah, al };
    let dc = |ah: u8, al: u8| -> Vec<ScanSpec> {
        if n <= 4 && (blocks <= 10 || n == 1) {
            vec![ScanSpec {
                comps: (0..n).collect(),
                td: (0..n).map(|c| (c > 0) as usize).collect(),
                ta: (0..n).map(|c| (c > 0) as usize).collect(),
                ss: 0,
                se: 0,
                ah,
                al,
            }]
        } else {
            (0..n).map(|c| one(c, 0, 0, ah, al)).collect()
        }
    };
    let mut s = Vec::new();
    if n == 3 && img.color == ColorSpace::YCbCr {
        s.extend(dc(0, 1));
        s.push(one(0, 1, 5, 0, 2));
        s.push(one(2, 1, 63, 0, 1));
        s.push(one(1, 1, 63, 0, 1));
        s.push(one(0, 6, 63, 0, 2));
        s.push(one(0, 1, 63, 2, 1));
        s.extend(dc(1, 0));
        s.push(one(2, 1, 63, 1, 0));
        s.push(one(1, 1, 63, 1, 0));
        s.push(one(0, 1, 63, 1, 0));
    } else {
        s.extend(dc(0, 1));
        for c in 0..n {
            s.push(one(c, 1, 5, 0, 2));
        }
        for c in 0..n {
            s.push(one(c, 6, 63, 0, 2));
        }
        for c in 0..n {
            s.push(one(c, 1, 63, 2, 1));
        }
        s.extend(dc(1, 0));
        for c in 0..n {
            s.push(one(c, 1, 63, 1, 0));
        }
    }
    s
}

fn dht_payload(tables: &[(u8, &HuffSpec)]) -> Vec<u8> {
    let mut p = Vec::new();
    for (tc_th, spec) in tables {
        p.push(*tc_th);
        spec.write(&mut p);
    }
    p
}

/// SOI .. SOF (+ DRI) for these coefficients, plus the scan script. `arith` selects SOF9/SOF10.
fn header(img: &CoeffImage, s: &EncodeSettings, arith: bool) -> (Vec<u8>, Vec<ScanSpec>) {
    let n = img.comps.len();
    let mut out = vec![0xFF, 0xD8];
    let has_app0 = s.segments.iter().any(|(m, _)| *m == APP0);
    if s.jfif && !has_app0 && matches!(img.color, ColorSpace::YCbCr | ColorSpace::Gray) {
        out.extend(segment(APP0, b"JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00"));
    }
    for (m, p) in &s.segments {
        out.extend(segment(*m, p));
    }
    let has_adobe = s.segments.iter().any(|(m, p)| *m == APP14 && p.starts_with(b"Adobe"));
    if !has_adobe && img.color == ColorSpace::Rgb {
        out.extend(segment(APP14, b"Adobe\x00\x64\x00\x00\x00\x00\x00"));
    }

    // Quantisation tables: one id per distinct table, preferring each component's tq.
    let mut ids: Vec<Option<[u16; 64]>> = vec![None; 4];
    let mut comp_tq = vec![0usize; n];
    for (i, c) in img.comps.iter().enumerate() {
        let want = c.tq.min(3);
        let slot = if ids[want].is_none() || ids[want] == Some(c.q) {
            want
        } else if let Some(j) = ids.iter().position(|t| *t == Some(c.q)) {
            j
        } else {
            ids.iter().position(|t| t.is_none()).unwrap_or(want)
        };
        ids[slot] = Some(c.q);
        comp_tq[i] = slot;
    }
    let wide_q = ids.iter().flatten().any(|t| t.iter().any(|&v| v > 255));
    let mut dqt = Vec::new();
    for (id, t) in ids.iter().enumerate() {
        if let Some(t) = t {
            let pq = t.iter().any(|&v| v > 255) as u8;
            dqt.push((pq << 4) | id as u8);
            for k in 0..64 {
                let v = t[NATURAL_ORDER[k]];
                if pq == 1 {
                    dqt.push((v >> 8) as u8);
                }
                dqt.push(v as u8);
            }
        }
    }
    out.extend(segment(0xDB, &dqt));

    // Huffman table slot per component: 0 for the first, 1 for the rest.
    let slot_of = |ci: usize| -> usize { (ci > 0) as usize };
    let scans: Vec<ScanSpec> = if s.progressive {
        s.scans.clone().unwrap_or_else(|| default_script(img))
    } else {
        let blocks: usize = img.comps.iter().map(|c| c.h * c.v).sum();
        if blocks <= 10 || n == 1 {
            vec![ScanSpec { comps: (0..n).collect(), td: (0..n).map(slot_of).collect(), ta: (0..n).map(slot_of).collect(), ss: 0, se: 63, ah: 0, al: 0 }]
        } else {
            (0..n).map(|c| ScanSpec { comps: vec![c], td: vec![slot_of(c)], ta: vec![slot_of(c)], ss: 0, se: 63, ah: 0, al: 0 }).collect()
        }
    };

    let sof = match (arith, s.progressive) {
        (true, true) => 0xCA,
        (true, false) => 0xC9,
        (false, true) => 0xC2,
        (false, false) if wide_q => 0xC1,
        _ => 0xC0,
    };
    let mut sofp = vec![8, (img.height >> 8) as u8, img.height as u8, (img.width >> 8) as u8, img.width as u8, n as u8];
    for (i, c) in img.comps.iter().enumerate() {
        sofp.extend_from_slice(&[c.id, ((c.h as u8) << 4) | c.v as u8, comp_tq[i] as u8]);
    }
    out.extend(segment(sof, &sofp));
    if s.restart_interval > 0 {
        let r = s.restart_interval.min(65535);
        out.extend(segment(0xDD, &[(r >> 8) as u8, r as u8]));
    }
    (out, scans)
}

/// Write a complete JPEG from coefficients.
pub fn write(img: &CoeffImage, s: &EncodeSettings) -> Vec<u8> {
    let (out, scans) = header(img, s, false);
    let preferred = |ci: usize, ac: bool| -> Option<HuffSpec> {
        match &s.huffman {
            HuffMode::Optimize => None,
            HuffMode::Standard => Some(if ac { HuffSpec::std_ac(ci > 0) } else { HuffSpec::std_dc(ci > 0) }),
            HuffMode::Fixed(v) => {
                let e = v.get(ci).or(v.last())?;
                Some(if ac { e.1.clone() } else { e.0.clone() })
            }
        }
    };

    // Annex K tables have codes for every DC size <= 11 and AC run/size with size <= 10, so the
    // statistics pass can be skipped when every coefficient is within the baseline range.
    let std_ok = !s.progressive
        && s.huffman == HuffMode::Standard
        && img.comps.iter().all(|c| c.coef.iter().all(|&v| (-1023..=1023).contains(&v)));
    let mut w = BitWriter::with(out);
    for scan in &scans {
        let t = ScanTables { dc: scan.td.iter().map(|&x| x.min(3)).collect(), ac: scan.ta.iter().map(|&x| 4 + x.min(3)).collect() };
        let mut cnt = Counter { freq: vec![[0u32; 257]; 8] };
        if !std_ok {
            encode_scan(img, scan, s.progressive, s.restart_interval, &t, &mut cnt);
        }
        let mut specs: Vec<Option<HuffSpec>> = vec![None; 8];
        let mut used = [false; 8];
        for (k, &ci) in scan.comps.iter().enumerate() {
            let is_dc = scan.ss == 0;
            let need_dc = !s.progressive || (is_dc && scan.ah == 0);
            let need_ac = !s.progressive || !is_dc;
            if need_dc {
                used[t.dc[k]] = true;
                if specs[t.dc[k]].is_none() {
                    specs[t.dc[k]] = preferred(ci, false).filter(|p| !s.progressive && p.covers(&cnt.freq[t.dc[k]]));
                }
            }
            if need_ac {
                used[t.ac[k]] = true;
                if specs[t.ac[k]].is_none() {
                    specs[t.ac[k]] = preferred(ci, true).filter(|p| !s.progressive && p.covers(&cnt.freq[t.ac[k]]));
                }
            }
        }
        for i in 0..8 {
            if used[i] && specs[i].is_none() {
                specs[i] = Some(HuffSpec::optimal(&cnt.freq[i]));
            }
        }
        let list: Vec<(u8, &HuffSpec)> =
            (0..8).filter(|&i| used[i]).map(|i| ((if i >= 4 { 0x10 } else { 0 }) | (i % 4) as u8, specs[i].as_ref().unwrap())).collect();
        if !list.is_empty() {
            w.out.extend(segment(0xC4, &dht_payload(&list)));
        }
        let mut sos = vec![scan.comps.len() as u8];
        for (k, &ci) in scan.comps.iter().enumerate() {
            sos.push(img.comps[ci].id);
            sos.push(((t.dc[k] as u8) << 4) | (t.ac[k] - 4) as u8);
        }
        sos.extend_from_slice(&[scan.ss, scan.se, (scan.ah << 4) | scan.al]);
        w.out.extend(segment(0xDA, &sos));
        let enc: Vec<EncTable> = (0..8).map(|i| specs[i].as_ref().map(EncTable::new).unwrap_or(EncTable { code: [0; 256], size: [0; 256] })).collect();
        let mut em = Emitter { w, enc };
        encode_scan(img, scan, s.progressive, s.restart_interval, &t, &mut em);
        em.w.flush();
        w = em.w;
    }
    let mut out = w.out;
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

/// Write a complete arithmetic-coded JPEG (SOF9 sequential / SOF10 progressive, default
/// conditioning, no DAC). Same headers and scan script as `write`; Huffman settings are ignored.
pub fn write_arith(img: &CoeffImage, s: &EncodeSettings) -> Vec<u8> {
    use crate::arith::{ArithEncoder, Conditioning, AC_BINS, DC_BINS};
    let (mut out, scans) = header(img, s, true);
    let cond = Conditioning::default();
    for scan in &scans {
        let mut sos = vec![scan.comps.len() as u8];
        for (k, &ci) in scan.comps.iter().enumerate() {
            sos.push(img.comps[ci].id);
            sos.push(((scan.td[k].min(3) as u8) << 4) | scan.ta[k].min(3) as u8);
        }
        sos.extend_from_slice(&[scan.ss, scan.se, (scan.ah << 4) | scan.al]);
        out.extend(segment(0xDA, &sos));
        let interleaved = scan.comps.len() > 1;
        let (mx, my) = if interleaved {
            (img.mcux, img.mcuy)
        } else {
            let c = &img.comps[scan.comps[0]];
            (c.wib, c.hib)
        };
        let prog = s.progressive;
        let (is_dc, first) = (scan.ss == 0, scan.ah == 0);
        let mut e = ArithEncoder::new(std::mem::take(&mut out));
        let mut dcs = [[0u8; DC_BINS]; 4];
        let mut acs = [[0u8; AC_BINS]; 4];
        let mut last = [0i32; 4];
        let mut ctx = [0usize; 4];
        let ri = s.restart_interval;
        let mut next_rst = 0u8;
        for mcu in 0..mx * my {
            if ri > 0 && mcu > 0 && mcu % ri == 0 {
                e.finish();
                e.out.extend_from_slice(&[0xFF, 0xD0 + next_rst]);
                next_rst = (next_rst + 1) & 7;
                for k in 0..scan.comps.len() {
                    if !prog || (is_dc && first) {
                        dcs[scan.td[k].min(3)] = [0; DC_BINS];
                        last[k] = 0;
                        ctx[k] = 0;
                    }
                    if !prog || scan.se != 0 {
                        acs[scan.ta[k].min(3)] = [0; AC_BINS];
                    }
                }
            }
            let (mux, muy) = (mcu % mx, mcu / mx);
            for (k, &ci) in scan.comps.iter().enumerate() {
                let c = &img.comps[ci];
                let (nh, nv) = if interleaved { (c.h, c.v) } else { (1, 1) };
                let (td, ta) = (scan.td[k].min(3), scan.ta[k].min(3));
                for by in 0..nv {
                    for bx in 0..nh {
                        let (x, y) = if interleaved { (mux * c.h + bx, muy * c.v + by) } else { (mux, muy) };
                        let blk = if x < c.bw && y < c.bh { c.block(x, y) } else { &[0i16; 64][..] };
                        if !prog || (is_dc && first) {
                            let dc = if prog { (blk[0] as i32) >> scan.al } else { blk[0] as i32 };
                            let diff = dc - last[k];
                            last[k] = dc;
                            e.dc_diff(&mut dcs[td], &mut ctx[k], diff, cond.dc_l[td], cond.dc_u[td]);
                            if !prog {
                                e.ac_sequential(&mut acs[ta], blk, cond.ac_k[ta]);
                            }
                        } else if is_dc {
                            e.dc_refine(blk, scan.al);
                        } else if first {
                            e.ac_first(&mut acs[ta], blk, scan.ss as usize, scan.se as usize, scan.al, cond.ac_k[ta]);
                        } else {
                            e.ac_refine(&mut acs[ta], blk, scan.ss as usize, scan.se as usize, scan.ah, scan.al);
                        }
                    }
                }
            }
        }
        e.finish();
        out = e.out;
    }
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

/// Encode RGBA pixels with the given settings.
pub fn encode_rgba(w: usize, h: usize, rgba: &[u8], s: &EncodeSettings) -> Vec<u8> {
    let planes = rgba_to_planes(w, h, rgba, s.color, s.matrix);
    encode_planes(&planes, w, h, s)
}

/// Encode already-converted full-resolution planes (component order as in settings).
pub fn encode_planes(planes: &[Plane8], w: usize, h: usize, s: &EncodeSettings) -> Vec<u8> {
    let w = w.clamp(1, 65535);
    let h = h.clamp(1, 65535);
    let mut comps = s.comps.clone();
    let want = match s.color {
        ColorSpace::Gray => 1,
        _ => 3,
    };
    while comps.len() < want {
        let i = comps.len();
        comps.push(CompSpec { id: i as u8 + 1, h: 1, v: 1, tq: 1 });
    }
    comps.truncate(want);
    let mut q = s.qtables.clone();
    while q.len() < comps.len() {
        q.push(q.last().copied().unwrap_or_else(|| default_q(1)));
    }
    let img = planes_to_coeffs(planes, w, h, &comps, &q, s.color);
    write(&img, s)
}
