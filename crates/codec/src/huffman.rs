//! Huffman tables: specs as stored in DHT, encoder lookups, libjpeg-style decoder tables and
//! libjpeg's optimal table generator (jpeg_gen_optimal_table).

use crate::tables::*;

/// A Huffman table as stored in a DHT segment. `bits[i]` = number of codes of length i+1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HuffSpec {
    pub bits: [u8; 16],
    pub vals: Vec<u8>,
}

impl HuffSpec {
    pub fn new(bits: &[u8; 16], vals: &[u8]) -> Self {
        HuffSpec { bits: *bits, vals: vals.to_vec() }
    }
    pub fn std_dc(chroma: bool) -> Self {
        if chroma {
            Self::new(&STD_DC_CHROMA_BITS, &STD_DC_CHROMA_VALS)
        } else {
            Self::new(&STD_DC_LUMA_BITS, &STD_DC_LUMA_VALS)
        }
    }
    pub fn std_ac(chroma: bool) -> Self {
        if chroma {
            Self::new(&STD_AC_CHROMA_BITS, &STD_AC_CHROMA_VALS)
        } else {
            Self::new(&STD_AC_LUMA_BITS, &STD_AC_LUMA_VALS)
        }
    }
    pub fn is_standard(&self) -> bool {
        *self == Self::std_dc(false) || *self == Self::std_dc(true) || *self == Self::std_ac(false) || *self == Self::std_ac(true)
    }

    /// Canonical code assignment: (symbol, code, length) in table order. Codes that overflow their
    /// length (corrupt tables) are still produced; callers mask as needed.
    fn codes(&self) -> Vec<(u8, u32, u8)> {
        let mut out = Vec::with_capacity(self.vals.len());
        let mut code: u32 = 0;
        let mut p = 0usize;
        for l in 1..=16u8 {
            for _ in 0..self.bits[l as usize - 1] {
                if p >= self.vals.len() {
                    return out;
                }
                out.push((self.vals[p], code, l));
                code = code.wrapping_add(1);
                p += 1;
            }
            code <<= 1;
        }
        out
    }

    /// Serialise as DHT payload body (without class/id byte).
    pub fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.bits);
        out.extend_from_slice(&self.vals);
    }

    /// True when every symbol with a non-zero count has a code in this table.
    pub fn covers(&self, freq: &[u32; 257]) -> bool {
        let mut has = [false; 256];
        for &(s, _, _) in &self.codes() {
            has[s as usize] = true;
        }
        (0..256).all(|s| freq[s] == 0 || has[s])
    }

    /// libjpeg's jpeg_gen_optimal_table: optimal code lengths limited to 16 bits, with the
    /// all-ones code reserved.
    pub fn optimal(freq_in: &[u32; 257]) -> Self {
        let mut freq = [0i64; 257];
        let mut any = false;
        for i in 0..256 {
            freq[i] = freq_in[i] as i64;
            any |= freq[i] > 0;
        }
        if !any {
            freq[0] = 1;
        }
        freq[256] = 1;
        let mut codesize = [0usize; 257];
        let mut others = [-1i32; 257];
        loop {
            let mut c1: i32 = -1;
            let mut v = i64::MAX;
            for i in 0..257 {
                if freq[i] != 0 && freq[i] <= v {
                    v = freq[i];
                    c1 = i as i32;
                }
            }
            let mut c2: i32 = -1;
            v = i64::MAX;
            for i in 0..257 {
                if freq[i] != 0 && freq[i] <= v && i as i32 != c1 {
                    v = freq[i];
                    c2 = i as i32;
                }
            }
            if c2 < 0 {
                break;
            }
            let (mut a, mut b) = (c1 as usize, c2 as usize);
            freq[a] += freq[b];
            freq[b] = 0;
            codesize[a] += 1;
            while others[a] >= 0 {
                a = others[a] as usize;
                codesize[a] += 1;
            }
            others[a] = b as i32;
            codesize[b] += 1;
            while others[b] >= 0 {
                b = others[b] as usize;
                codesize[b] += 1;
            }
        }
        let mut bits = [0i64; 65];
        for i in 0..257 {
            if codesize[i] > 0 {
                bits[codesize[i].min(64)] += 1;
            }
        }
        let mut i = 64;
        while i > 16 {
            while bits[i] > 0 {
                let mut j = i - 2;
                while j > 0 && bits[j] == 0 {
                    j -= 1;
                }
                bits[i] -= 2;
                bits[i - 1] += 1;
                bits[j + 1] += 2;
                bits[j] -= 1;
            }
            i -= 1;
        }
        while i > 0 && bits[i] == 0 {
            i -= 1;
        }
        bits[i] -= 1; // remove the reserved pseudo-symbol
        let mut out_bits = [0u8; 16];
        for l in 1..=16 {
            out_bits[l - 1] = bits[l].clamp(0, 255) as u8;
        }
        let mut vals = Vec::new();
        for l in 1..=64 {
            for (s, &cs) in codesize.iter().enumerate().take(256) {
                if cs == l {
                    vals.push(s as u8);
                }
            }
        }
        let total: usize = out_bits.iter().map(|&b| b as usize).sum();
        vals.truncate(total);
        HuffSpec { bits: out_bits, vals }
    }
}

/// Encoder lookup: code and size per symbol (size 0 = symbol absent).
#[derive(Clone)]
pub struct EncTable {
    pub code: [u32; 256],
    pub size: [u8; 256],
}

impl EncTable {
    pub fn new(spec: &HuffSpec) -> Self {
        let mut t = EncTable { code: [0; 256], size: [0; 256] };
        for (s, c, l) in spec.codes() {
            if t.size[s as usize] == 0 {
                t.code[s as usize] = c & ((1u32 << l) - 1);
                t.size[s as usize] = l;
            }
        }
        t
    }
}

pub const LOOKAHEAD: u32 = 9;

/// Decoder table in the shape of libjpeg's d_derived_tbl.
#[derive(Clone)]
pub struct DecTable {
    /// (length << 8) | symbol for codes up to LOOKAHEAD bits; 0 means "use the slow path".
    pub look: Vec<u16>,
    pub maxcode: [i32; 18],
    pub valoffset: [i32; 18],
    pub vals: [u8; 256],
}

impl DecTable {
    pub fn new(spec: &HuffSpec) -> Self {
        let mut vals = [0u8; 256];
        for (i, &v) in spec.vals.iter().take(256).enumerate() {
            vals[i] = v;
        }
        let codes = spec.codes();
        let mut maxcode = [-1i32; 18];
        let mut valoffset = [0i32; 18];
        let mut p = 0usize;
        for l in 1..=16usize {
            let n = codes.iter().filter(|c| c.2 as usize == l).count();
            if n > 0 {
                valoffset[l] = p as i32 - codes[p].1 as i32;
                p += n;
                maxcode[l] = codes[p - 1].1 as i32;
            }
        }
        maxcode[17] = 0xFFFFF;
        let mut look = vec![0u16; 1 << LOOKAHEAD];
        for &(s, c, l) in &codes {
            let l = l as u32;
            if l > LOOKAHEAD {
                break;
            }
            let shift = LOOKAHEAD - l;
            let base = (c as usize) << shift;
            for k in 0..(1usize << shift) {
                if let Some(e) = look.get_mut(base + k) {
                    *e = ((l as u16) << 8) | s as u16;
                }
            }
        }
        DecTable { look, maxcode, valoffset, vals }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optimal_roundtrip_lengths() {
        let mut f = [0u32; 257];
        for i in 0..200 {
            f[i] = (i as u32 * 37) % 101 + 1;
        }
        let s = HuffSpec::optimal(&f);
        assert_eq!(s.vals.len(), 200);
        assert!(s.covers(&f));
        let total: u32 = s.bits.iter().map(|&b| b as u32).sum();
        assert_eq!(total, 200);
    }
}
