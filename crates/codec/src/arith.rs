//! Arithmetic entropy coding (ITU-T T.81 Annex D, F.1.4/F.2.4 and G.1.3/G.2.3): the QM-coder
//! used by SOF9/SOF10 JPEGs. The decoder follows libjpeg-turbo's jdarith.c bit for bit
//! (statistics bins, conditioning, error handling); the encoder follows jcarith.c and exists so
//! the decoder can be tested and so expert tools can write such files.

use crate::bits::BitReader;
use crate::tables::NATURAL_ORDER;

/// Table D.2 packed as libjpeg's jaricom.c: Qe << 16 | Next_MPS << 8 | Switch << 7 | Next_LPS.
/// Entry 113 is the fixed 0.5 estimate used for signs and DC refinement bits.
const fn v(qe: u32, nlps: u32, nmps: u32, sw: u32) -> u32 {
    (qe << 16) | (nmps << 8) | (sw << 7) | nlps
}

pub const ARITAB: [u32; 114] = [
    v(0x5a1d, 1, 1, 1),
    v(0x2586, 14, 2, 0),
    v(0x1114, 16, 3, 0),
    v(0x080b, 18, 4, 0),
    v(0x03d8, 20, 5, 0),
    v(0x01da, 23, 6, 0),
    v(0x00e5, 25, 7, 0),
    v(0x006f, 28, 8, 0),
    v(0x0036, 30, 9, 0),
    v(0x001a, 33, 10, 0),
    v(0x000d, 35, 11, 0),
    v(0x0006, 9, 12, 0),
    v(0x0003, 10, 13, 0),
    v(0x0001, 12, 13, 0),
    v(0x5a7f, 15, 15, 1),
    v(0x3f25, 36, 16, 0),
    v(0x2cf2, 38, 17, 0),
    v(0x207c, 39, 18, 0),
    v(0x17b9, 40, 19, 0),
    v(0x1182, 42, 20, 0),
    v(0x0cef, 43, 21, 0),
    v(0x09a1, 45, 22, 0),
    v(0x072f, 46, 23, 0),
    v(0x055c, 48, 24, 0),
    v(0x0406, 49, 25, 0),
    v(0x0303, 51, 26, 0),
    v(0x0240, 52, 27, 0),
    v(0x01b1, 54, 28, 0),
    v(0x0144, 56, 29, 0),
    v(0x00f5, 57, 30, 0),
    v(0x00b7, 59, 31, 0),
    v(0x008a, 60, 32, 0),
    v(0x0068, 62, 33, 0),
    v(0x004e, 63, 34, 0),
    v(0x003b, 32, 35, 0),
    v(0x002c, 33, 9, 0),
    v(0x5ae1, 37, 37, 1),
    v(0x484c, 64, 38, 0),
    v(0x3a0d, 65, 39, 0),
    v(0x2ef1, 67, 40, 0),
    v(0x261f, 68, 41, 0),
    v(0x1f33, 69, 42, 0),
    v(0x19a8, 70, 43, 0),
    v(0x1518, 72, 44, 0),
    v(0x1177, 73, 45, 0),
    v(0x0e74, 74, 46, 0),
    v(0x0bfb, 75, 47, 0),
    v(0x09f8, 77, 48, 0),
    v(0x0861, 78, 49, 0),
    v(0x0706, 79, 50, 0),
    v(0x05cd, 48, 51, 0),
    v(0x04de, 50, 52, 0),
    v(0x040f, 50, 53, 0),
    v(0x0363, 51, 54, 0),
    v(0x02d4, 52, 55, 0),
    v(0x025c, 53, 56, 0),
    v(0x01f8, 54, 57, 0),
    v(0x01a4, 55, 58, 0),
    v(0x0160, 56, 59, 0),
    v(0x0125, 57, 60, 0),
    v(0x00f6, 58, 61, 0),
    v(0x00cb, 59, 62, 0),
    v(0x00ab, 61, 63, 0),
    v(0x008f, 61, 32, 0),
    v(0x5b12, 65, 65, 1),
    v(0x4d04, 80, 66, 0),
    v(0x412c, 81, 67, 0),
    v(0x37d8, 82, 68, 0),
    v(0x2fe8, 83, 69, 0),
    v(0x293c, 84, 70, 0),
    v(0x2379, 86, 71, 0),
    v(0x1edf, 87, 72, 0),
    v(0x1aa9, 87, 73, 0),
    v(0x174e, 72, 74, 0),
    v(0x1424, 72, 75, 0),
    v(0x119c, 74, 76, 0),
    v(0x0f6b, 74, 77, 0),
    v(0x0d51, 75, 78, 0),
    v(0x0bb6, 77, 79, 0),
    v(0x0a40, 77, 48, 0),
    v(0x5832, 80, 81, 1),
    v(0x4d1c, 88, 82, 0),
    v(0x438e, 89, 83, 0),
    v(0x3bdd, 90, 84, 0),
    v(0x34ee, 91, 85, 0),
    v(0x2eae, 92, 86, 0),
    v(0x299a, 93, 87, 0),
    v(0x2516, 86, 71, 0),
    v(0x5570, 88, 89, 1),
    v(0x4ca9, 95, 90, 0),
    v(0x44d9, 96, 91, 0),
    v(0x3e22, 97, 92, 0),
    v(0x3824, 99, 93, 0),
    v(0x32b4, 99, 94, 0),
    v(0x2e17, 93, 86, 0),
    v(0x56a8, 95, 96, 1),
    v(0x4f46, 101, 97, 0),
    v(0x47e5, 102, 98, 0),
    v(0x41cf, 103, 99, 0),
    v(0x3c3d, 104, 100, 0),
    v(0x375e, 99, 93, 0),
    v(0x5231, 105, 102, 0),
    v(0x4c0f, 106, 103, 0),
    v(0x4639, 107, 104, 0),
    v(0x415e, 103, 99, 0),
    v(0x5627, 105, 106, 1),
    v(0x50e7, 108, 107, 0),
    v(0x4b85, 109, 103, 0),
    v(0x5597, 110, 109, 0),
    v(0x504f, 111, 107, 0),
    v(0x5a10, 110, 111, 1),
    v(0x5522, 112, 109, 0),
    v(0x59eb, 112, 111, 1),
    v(0x5a1d, 113, 113, 0),
];

pub const DC_BINS: usize = 64;
pub const AC_BINS: usize = 256;
const FIXED: u8 = 113;

/// Conditioning parameters from DAC (defaults L=0, U=1, Kx=5 per table).
#[derive(Clone, Copy, Debug)]
pub struct Conditioning {
    pub dc_l: [u8; 16],
    pub dc_u: [u8; 16],
    pub ac_k: [u8; 16],
}

impl Default for Conditioning {
    fn default() -> Self {
        Conditioning { dc_l: [0; 16], dc_u: [1; 16], ac_k: [5; 16] }
    }
}

impl Conditioning {
    /// Read a DAC segment payload. Returns false if something was out of range (skipped).
    pub fn read_dac(&mut self, p: &[u8]) -> bool {
        let mut ok = true;
        for pair in p.chunks_exact(2) {
            let (index, val) = (pair[0] as usize, pair[1]);
            if index >= 32 {
                ok = false;
            } else if index >= 16 {
                self.ac_k[index - 16] = val;
            } else {
                let (l, u) = (val & 15, val >> 4);
                if l > u {
                    ok = false;
                } else {
                    self.dc_l[index] = l;
                    self.dc_u[index] = u;
                }
            }
        }
        ok
    }
}

/// QM decoder state (jdarith.c arith_entropy_decoder). `ct == -1` marks a decoding error: the rest
/// of the restart interval is skipped.
pub struct ArithDecoder {
    c: i64,
    a: i64,
    ct: i32,
    fixed: u8,
}

impl Default for ArithDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl ArithDecoder {
    pub fn new() -> Self {
        ArithDecoder { c: 0, a: 0, ct: -16, fixed: FIXED }
    }
    pub fn reset(&mut self) {
        self.c = 0;
        self.a = 0;
        self.ct = -16;
    }
    pub fn failed(&self) -> bool {
        self.ct == -1
    }
    fn fail(&mut self) {
        self.ct = -1;
    }

    /// Decode one binary decision with statistics bin `st` (D.2.4-D.2.6). Bytes come from the
    /// shared bit reader, which hands out zeros once a marker or the end of the file is reached
    /// (libjpeg's "stuff zero data" convention, legal in arithmetic coding).
    #[inline]
    pub fn decode(&mut self, r: &mut BitReader, st: &mut u8) -> u32 {
        while self.a < 0x8000 {
            self.ct -= 1;
            if self.ct < 0 {
                let data = r.get(8) as i64;
                self.c = (self.c << 8) | data;
                self.ct += 8;
                if self.ct < 0 {
                    self.ct += 1;
                    if self.ct == 0 {
                        self.a = 0x8000;
                    }
                }
            }
            self.a <<= 1;
        }
        let sv = *st as u32;
        let packed = ARITAB[(sv & 0x7F) as usize];
        let nl = (packed & 0xFF) as u8;
        let nm = ((packed >> 8) & 0xFF) as u8;
        let qe = (packed >> 16) as i64;
        let mut sv = sv;
        let mut temp = self.a - qe;
        self.a = temp;
        temp <<= self.ct;
        if self.c >= temp {
            self.c -= temp;
            if self.a < qe {
                self.a = qe;
                *st = ((sv & 0x80) as u8) ^ nm;
            } else {
                self.a = qe;
                *st = ((sv & 0x80) as u8) ^ nl;
                sv ^= 0x80;
            }
        } else if self.a < 0x8000 {
            if self.a < qe {
                *st = ((sv & 0x80) as u8) ^ nl;
                sv ^= 0x80;
            } else {
                *st = ((sv & 0x80) as u8) ^ nm;
            }
        }
        sv >> 7
    }

    #[inline]
    fn decode_fixed(&mut self, r: &mut BitReader) -> u32 {
        let mut f = self.fixed;
        let b = self.decode(r, &mut f);
        self.fixed = f;
        b
    }

    /// DC difference (F.2.4.1 / Figures F.19-F.24). None = magnitude overflow (decoder failed).
    pub fn dc_diff(&mut self, r: &mut BitReader, st: &mut [u8; DC_BINS], ctx: &mut usize, l: u8, u: u8) -> Option<i32> {
        let s0 = *ctx;
        if self.decode(r, &mut st[s0]) == 0 {
            *ctx = 0;
            return Some(0);
        }
        let sign = self.decode(r, &mut st[s0 + 1]) as usize;
        let mut sti = s0 + 2 + sign;
        let mut m = self.decode(r, &mut st[sti]) as i32;
        if m != 0 {
            sti = 20;
            while self.decode(r, &mut st[sti]) != 0 {
                m <<= 1;
                if m == 0x8000 {
                    self.fail();
                    return None;
                }
                sti += 1;
            }
        }
        *ctx = if m < ((1i32 << l.min(15)) >> 1) {
            0
        } else if m > ((1i32 << u.min(15)) >> 1) {
            12 + sign * 4
        } else {
            4 + sign * 4
        };
        let mut v = m;
        sti += 14;
        loop {
            m >>= 1;
            if m == 0 {
                break;
            }
            if self.decode(r, &mut st[sti]) != 0 {
                v |= m;
            }
        }
        v += 1;
        Some(if sign != 0 { -v } else { v })
    }

    /// Sign + magnitude of a nonzero AC coefficient; `sti` points at the coefficient's bin triple.
    fn ac_value(&mut self, r: &mut BitReader, st: &mut [u8; AC_BINS], mut sti: usize, k: usize, kx: u8) -> Option<i32> {
        let sign = self.decode_fixed(r);
        sti += 2;
        let mut m = self.decode(r, &mut st[sti]) as i32;
        if m != 0 && self.decode(r, &mut st[sti]) != 0 {
            m <<= 1;
            sti = if k <= kx as usize { 189 } else { 217 };
            while self.decode(r, &mut st[sti]) != 0 {
                m <<= 1;
                if m == 0x8000 {
                    self.fail();
                    return None;
                }
                sti += 1;
            }
        }
        let mut v = m;
        sti += 14;
        loop {
            m >>= 1;
            if m == 0 {
                break;
            }
            if self.decode(r, &mut st[sti]) != 0 {
                v |= m;
            }
        }
        v += 1;
        Some(if sign != 0 { -v } else { v })
    }

    /// Sequential AC coefficients 1..63 of one block (F.2.4.2). Block must be zeroed by the caller.
    pub fn ac_sequential(&mut self, r: &mut BitReader, st: &mut [u8; AC_BINS], blk: &mut [i16], kx: u8) {
        let mut k = 0usize;
        loop {
            let mut sti = 3 * k;
            if self.decode(r, &mut st[sti]) != 0 {
                break;
            }
            loop {
                k += 1;
                if self.decode(r, &mut st[sti + 1]) != 0 {
                    break;
                }
                sti += 3;
                if k >= 63 {
                    self.fail();
                    return;
                }
            }
            let Some(v) = self.ac_value(r, st, sti, k, kx) else { return };
            blk[NATURAL_ORDER[k]] = v as i16;
            if k >= 63 {
                break;
            }
        }
    }

    /// Progressive first AC pass (G.2.3, decode_mcu_AC_first).
    #[allow(clippy::too_many_arguments)]
    pub fn ac_first(&mut self, r: &mut BitReader, st: &mut [u8; AC_BINS], blk: &mut [i16], ss: usize, se: usize, al: u8, kx: u8) {
        let mut k = ss.max(1);
        while k <= se {
            let mut sti = 3 * (k - 1);
            if self.decode(r, &mut st[sti]) != 0 {
                break;
            }
            while self.decode(r, &mut st[sti + 1]) == 0 {
                sti += 3;
                k += 1;
                if k > se {
                    self.fail();
                    return;
                }
            }
            let Some(v) = self.ac_value(r, st, sti, k, kx) else { return };
            blk[NATURAL_ORDER[k]] = ((v as u32) << al) as i16;
            k += 1;
        }
    }

    /// DC refinement bit (decode_mcu_DC_refine).
    pub fn dc_refine(&mut self, r: &mut BitReader, blk: &mut [i16], al: u8) {
        if self.decode_fixed(r) != 0 {
            blk[0] |= (1i32 << al) as i16;
        }
    }

    /// Progressive AC refinement (decode_mcu_AC_refine).
    pub fn ac_refine(&mut self, r: &mut BitReader, st: &mut [u8; AC_BINS], blk: &mut [i16], ss: usize, se: usize, al: u8) {
        let p1: i32 = 1 << al;
        let m1: i32 = -1 << al;
        let mut kex = se;
        while kex > 0 && blk[NATURAL_ORDER[kex]] == 0 {
            kex -= 1;
        }
        let mut k = ss.max(1);
        while k <= se {
            let mut sti = 3 * (k - 1);
            if k > kex && self.decode(r, &mut st[sti]) != 0 {
                break;
            }
            loop {
                let pos = NATURAL_ORDER[k];
                if blk[pos] != 0 {
                    if self.decode(r, &mut st[sti + 2]) != 0 {
                        let c = blk[pos] as i32;
                        blk[pos] = (if c < 0 { c + m1 } else { c + p1 }) as i16;
                    }
                    break;
                }
                if self.decode(r, &mut st[sti + 1]) != 0 {
                    blk[pos] = (if self.decode_fixed(r) != 0 { m1 } else { p1 }) as i16;
                    break;
                }
                sti += 3;
                k += 1;
                if k > se {
                    self.fail();
                    return;
                }
            }
            k += 1;
        }
    }
}

/// QM encoder (jcarith.c), writing stuffed bytes to `out`.
pub struct ArithEncoder {
    c: i64,
    a: i64,
    sc: i64,
    zc: i64,
    ct: i32,
    buffer: i32,
    fixed: u8,
    pub out: Vec<u8>,
}

impl ArithEncoder {
    pub fn new(out: Vec<u8>) -> Self {
        ArithEncoder { c: 0, a: 0x10000, sc: 0, zc: 0, ct: 11, buffer: -1, fixed: FIXED, out }
    }

    fn reset(&mut self) {
        self.c = 0;
        self.a = 0x10000;
        self.sc = 0;
        self.zc = 0;
        self.ct = 11;
        self.buffer = -1;
    }

    fn emit_zeros(&mut self) {
        while self.zc > 0 {
            self.out.push(0);
            self.zc -= 1;
        }
    }

    fn emit_stacked_ff(&mut self) {
        if self.sc > 0 {
            self.emit_zeros();
            while self.sc > 0 {
                self.out.push(0xFF);
                self.out.push(0);
                self.sc -= 1;
            }
        }
    }

    pub fn encode(&mut self, st: &mut u8, val: u32) {
        let sv = *st as u32;
        let packed = ARITAB[(sv & 0x7F) as usize];
        let nl = (packed & 0xFF) as u8;
        let nm = ((packed >> 8) & 0xFF) as u8;
        let qe = (packed >> 16) as i64;
        self.a -= qe;
        if val != sv >> 7 {
            if self.a >= qe {
                self.c += self.a;
                self.a = qe;
            }
            *st = ((sv & 0x80) as u8) ^ nl;
        } else {
            if self.a >= 0x8000 {
                return;
            }
            if self.a < qe {
                self.c += self.a;
                self.a = qe;
            }
            *st = ((sv & 0x80) as u8) ^ nm;
        }
        loop {
            self.a <<= 1;
            self.c <<= 1;
            self.ct -= 1;
            if self.ct == 0 {
                let temp = self.c >> 19;
                if temp > 0xFF {
                    if self.buffer >= 0 {
                        self.emit_zeros();
                        let b = (self.buffer + 1) as u8;
                        self.out.push(b);
                        if b == 0xFF {
                            self.out.push(0);
                        }
                    }
                    self.zc += self.sc;
                    self.sc = 0;
                    self.buffer = (temp & 0xFF) as i32;
                } else if temp == 0xFF {
                    self.sc += 1;
                } else {
                    if self.buffer == 0 {
                        self.zc += 1;
                    } else if self.buffer >= 0 {
                        self.emit_zeros();
                        self.out.push(self.buffer as u8);
                    }
                    self.emit_stacked_ff();
                    self.buffer = (temp & 0xFF) as i32;
                }
                self.c &= 0x7FFFF;
                self.ct += 8;
            }
            if self.a >= 0x8000 {
                break;
            }
        }
    }

    fn encode_fixed(&mut self, val: u32) {
        let mut f = self.fixed;
        self.encode(&mut f, val);
        self.fixed = f;
    }

    /// Terminate the code stream (D.1.8, jcarith.c finish_pass) and reset for the next segment.
    pub fn finish(&mut self) {
        let temp = (self.a - 1 + self.c) & 0xFFFF_0000;
        self.c = if temp < self.c { temp + 0x8000 } else { temp };
        self.c <<= self.ct;
        if self.c & 0xF800_0000 != 0 {
            if self.buffer >= 0 {
                self.emit_zeros();
                let b = (self.buffer + 1) as u8;
                self.out.push(b);
                if b == 0xFF {
                    self.out.push(0);
                }
            }
            self.zc += self.sc;
            self.sc = 0;
        } else {
            if self.buffer == 0 {
                self.zc += 1;
            } else if self.buffer >= 0 {
                self.emit_zeros();
                self.out.push(self.buffer as u8);
            }
            self.emit_stacked_ff();
        }
        if self.c & 0x7FF_F800 != 0 {
            self.emit_zeros();
            let b = ((self.c >> 19) & 0xFF) as u8;
            self.out.push(b);
            if b == 0xFF {
                self.out.push(0);
            }
            if self.c & 0x7_F800 != 0 {
                let b = ((self.c >> 11) & 0xFF) as u8;
                self.out.push(b);
                if b == 0xFF {
                    self.out.push(0);
                }
            }
        }
        self.reset();
    }

    fn magnitude(&mut self, st: &mut [u8], mut sti: usize, v: i32, big_bin: usize, dc: bool) {
        // v = |value| - 1 (>= 0). Figures F.8/F.9.
        let mut m = 0i32;
        if v != 0 {
            self.encode(&mut st[sti], 1);
            m = 1;
            let mut v2 = v >> 1;
            if dc {
                sti = 20;
                while v2 != 0 {
                    self.encode(&mut st[sti], 1);
                    m <<= 1;
                    sti += 1;
                    v2 >>= 1;
                }
            } else if v2 != 0 {
                self.encode(&mut st[sti], 1);
                m <<= 1;
                sti = big_bin;
                v2 >>= 1;
                while v2 != 0 {
                    self.encode(&mut st[sti], 1);
                    m <<= 1;
                    sti += 1;
                    v2 >>= 1;
                }
            }
        }
        self.encode(&mut st[sti], 0);
        sti += 14;
        loop {
            m >>= 1;
            if m == 0 {
                break;
            }
            self.encode(&mut st[sti], ((m & v) != 0) as u32);
        }
    }

    /// DC difference (Figure F.4); updates the conditioning context.
    pub fn dc_diff(&mut self, st: &mut [u8; DC_BINS], ctx: &mut usize, diff: i32, l: u8, u: u8) {
        let s0 = *ctx;
        if diff == 0 {
            self.encode(&mut st[s0], 0);
            *ctx = 0;
            return;
        }
        self.encode(&mut st[s0], 1);
        let (sign, mag) = if diff > 0 { (0usize, diff) } else { (1usize, -diff) };
        self.encode(&mut st[s0 + 1], sign as u32);
        let v = mag - 1;
        // Magnitude category for the context decision.
        let m = if v == 0 { 0 } else { 1i32 << (31 - (v as u32).leading_zeros()) };
        self.magnitude(&mut st[..], s0 + 2 + sign, v, 0, true);
        *ctx = if m < ((1i32 << l.min(15)) >> 1) {
            0
        } else if m > ((1i32 << u.min(15)) >> 1) {
            12 + sign * 4
        } else {
            4 + sign * 4
        };
    }

    fn ac_coef(&mut self, st: &mut [u8; AC_BINS], sti: usize, k: usize, v: i32, kx: u8) {
        self.encode_fixed((v < 0) as u32);
        let big = if k <= kx as usize { 189 } else { 217 };
        self.magnitude(&mut st[..], sti + 2, v.abs() - 1, big, false);
    }

    /// Sequential AC 1..63 (Figure F.5).
    pub fn ac_sequential(&mut self, st: &mut [u8; AC_BINS], blk: &[i16], kx: u8) {
        let mut ke = 63;
        while ke > 0 && blk[NATURAL_ORDER[ke]] == 0 {
            ke -= 1;
        }
        let mut k = 1;
        while k <= ke {
            let mut sti = 3 * (k - 1);
            self.encode(&mut st[sti], 0);
            while blk[NATURAL_ORDER[k]] == 0 {
                self.encode(&mut st[sti + 1], 0);
                sti += 3;
                k += 1;
            }
            self.encode(&mut st[sti + 1], 1);
            self.ac_coef(st, sti, k, blk[NATURAL_ORDER[k]] as i32, kx);
            k += 1;
        }
        if k <= 63 {
            self.encode(&mut st[3 * (k - 1)], 1);
        }
    }

    /// Progressive first AC pass with point transform `al`.
    #[allow(clippy::too_many_arguments)]
    pub fn ac_first(&mut self, st: &mut [u8; AC_BINS], blk: &[i16], ss: usize, se: usize, al: u8, kx: u8) {
        let pt = |x: i16| -> i32 {
            let x = x as i32;
            if x >= 0 {
                x >> al
            } else {
                -((-x) >> al)
            }
        };
        let mut ke = se;
        while ke > 0 && pt(blk[NATURAL_ORDER[ke]]) == 0 {
            ke -= 1;
        }
        let mut k = ss.max(1);
        while k <= ke {
            let mut sti = 3 * (k - 1);
            self.encode(&mut st[sti], 0);
            while pt(blk[NATURAL_ORDER[k]]) == 0 {
                self.encode(&mut st[sti + 1], 0);
                sti += 3;
                k += 1;
            }
            self.encode(&mut st[sti + 1], 1);
            self.ac_coef(st, sti, k, pt(blk[NATURAL_ORDER[k]]), kx);
            k += 1;
        }
        if k <= se {
            self.encode(&mut st[3 * (k - 1)], 1);
        }
    }

    pub fn dc_refine(&mut self, blk: &[i16], al: u8) {
        self.encode_fixed(((blk[0] as i32 >> al) & 1) as u32);
    }

    /// Progressive AC refinement (Figure G.10).
    pub fn ac_refine(&mut self, st: &mut [u8; AC_BINS], blk: &[i16], ss: usize, se: usize, ah: u8, al: u8) {
        let a = |x: i16, s: u8| -> i32 { (x as i32).abs() >> s };
        let mut ke = se;
        while ke > 0 && a(blk[NATURAL_ORDER[ke]], al) == 0 {
            ke -= 1;
        }
        let mut kex = ke;
        while kex > 0 && a(blk[NATURAL_ORDER[kex]], ah) == 0 {
            kex -= 1;
        }
        let mut k = ss.max(1);
        while k <= ke {
            let mut sti = 3 * (k - 1);
            if k > kex {
                self.encode(&mut st[sti], 0);
            }
            loop {
                let x = blk[NATURAL_ORDER[k]];
                let v = a(x, al);
                if v != 0 {
                    if v >> 1 != 0 {
                        self.encode(&mut st[sti + 2], (v & 1) as u32);
                    } else {
                        self.encode(&mut st[sti + 1], 1);
                        self.encode_fixed((x < 0) as u32);
                    }
                    break;
                }
                self.encode(&mut st[sti + 1], 0);
                sti += 3;
                k += 1;
            }
            k += 1;
        }
        if k <= se {
            self.encode(&mut st[3 * (k - 1)], 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::decoder::parse;
    use crate::encoder::{encode_rgba, write_arith, EncodeSettings};
    use crate::step::Pcg32;

    fn test_jpeg(sub: &str) -> Vec<u8> {
        let (w, h) = (83usize, 61usize);
        let mut rng = Pcg32::new(5, 1);
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                rgba[i] = (x * 3) as u8 ^ (rng.next_u32() as u8 & 15);
                rgba[i + 1] = (y * 4) as u8;
                rgba[i + 2] = ((x + y) * 2) as u8 ^ (rng.next_u32() as u8 & 63);
            }
        }
        encode_rgba(w, h, &rgba, &EncodeSettings::standard(90, sub))
    }

    #[test]
    fn arithmetic_roundtrip_is_lossless() {
        for sub in ["420", "444", "422"] {
            let src = test_jpeg(sub);
            let p = parse(&src, false);
            let img = p.img.as_ref().unwrap();
            for (prog, ri) in [(false, 0), (false, 3), (true, 0), (true, 7)] {
                let mut s = EncodeSettings::from_parsed(&p).unwrap();
                s.progressive = prog;
                s.restart_interval = ri;
                let a = write_arith(img, &s);
                let q = parse(&a, false);
                assert!(q.meta.arithmetic);
                assert!(q.events.iter().all(|e| e.kind == "arithmetic"), "{sub} {prog} {ri}: {:?}", q.events);
                let back = q.img.unwrap();
                for (c0, c1) in img.comps.iter().zip(&back.comps) {
                    for by in 0..c0.hib {
                        for bx in 0..c0.wib {
                            assert_eq!(c0.block(bx, by), c1.block(bx, by), "{sub} prog={prog} ri={ri} block {bx},{by}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn damaged_arithmetic_never_panics() {
        let src = test_jpeg("420");
        let p = parse(&src, false);
        let mut s = EncodeSettings::from_parsed(&p).unwrap();
        s.restart_interval = 4;
        let a = write_arith(p.img.as_ref().unwrap(), &s);
        let mut rng = Pcg32::new(9, 2);
        for _ in 0..200 {
            let mut d = a.clone();
            for _ in 0..3 {
                let i = 200 + rng.below((d.len() - 200) as u32) as usize;
                d[i] ^= 1 << rng.below(8);
            }
            d.truncate(200 + rng.below((d.len() - 200) as u32) as usize);
            let _ = crate::render::decode(&d, &crate::render::DecodeOpts::default()).unwrap();
        }
    }
}
