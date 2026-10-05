//! Entropy-coded segment I/O: a bit writer with 0xFF byte stuffing and a libjpeg-faithful bit
//! reader (stops at markers, then feeds zero bits and raises `insufficient`, like jdhuff.c).

/// MSB-first bit writer with JPEG byte stuffing.
pub struct BitWriter {
    pub out: Vec<u8>,
    acc: u64,
    n: u32,
}

impl Default for BitWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl BitWriter {
    pub fn new() -> Self {
        BitWriter { out: Vec::new(), acc: 0, n: 0 }
    }
    pub fn with(out: Vec<u8>) -> Self {
        BitWriter { out, acc: 0, n: 0 }
    }
    #[inline]
    pub fn put(&mut self, code: u32, size: u32) {
        if size == 0 {
            return;
        }
        let code = (code as u64) & ((1u64 << size) - 1);
        self.acc = (self.acc << size) | code;
        self.n += size;
        while self.n >= 8 {
            let b = (self.acc >> (self.n - 8)) as u8;
            self.out.push(b);
            if b == 0xFF {
                self.out.push(0);
            }
            self.n -= 8;
        }
        self.acc &= (1u64 << self.n) - 1;
    }
    /// Pad with 1-bits to a byte boundary (libjpeg flush_bits).
    pub fn flush(&mut self) {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.put((1 << pad) - 1, pad);
        }
    }
    /// Bit position of the next bit to be written (counting stuffed bytes).
    pub fn bit_pos(&self) -> u64 {
        self.out.len() as u64 * 8 + self.n as u64
    }
    pub fn marker(&mut self, m: u8) {
        self.flush();
        self.out.push(0xFF);
        self.out.push(m);
    }
}

/// Marker found in the entropy-coded data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub code: u8,
    /// Offset of the first 0xFF of the marker.
    pub at: usize,
    /// Offset just after the marker code byte.
    pub after: usize,
}

pub struct BitReader<'a> {
    data: &'a [u8],
    /// Next byte to load.
    pub pos: usize,
    buf: u64,
    bits: u32,
    ring: [u32; 8],
    loaded: u32,
    /// Marker that stopped the reader (libjpeg's unread_marker).
    pub marker: Option<Hit>,
    pub eof: bool,
    /// Zero bits were invented because data ran out (libjpeg's insufficient_data).
    pub insufficient: bool,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8], pos: usize) -> Self {
        BitReader { data, pos: pos.min(data.len()), buf: 0, bits: 0, ring: [0; 8], loaded: 0, marker: None, eof: false, insufficient: false }
    }

    #[inline]
    fn push(&mut self, b: u8, at: usize) {
        self.buf = (self.buf << 8) | b as u64;
        self.bits += 8;
        self.ring[(self.loaded & 7) as usize] = at as u32;
        self.loaded = self.loaded.wrapping_add(1);
    }

    #[inline]
    fn fill(&mut self) {
        while self.bits <= 56 {
            if self.marker.is_some() || self.eof {
                return;
            }
            let p = self.pos;
            let Some(&b) = self.data.get(p) else {
                self.eof = true;
                return;
            };
            if b != 0xFF {
                self.push(b, p);
                self.pos = p + 1;
                continue;
            }
            let mut q = p + 1;
            while q < self.data.len() && self.data[q] == 0xFF {
                q += 1;
            }
            match self.data.get(q) {
                None => {
                    self.eof = true;
                    return;
                }
                Some(0) => {
                    self.push(0xFF, p);
                    self.pos = q + 1;
                }
                Some(&c) => {
                    self.marker = Some(Hit { code: c, at: p, after: q + 1 });
                    return;
                }
            }
        }
    }

    /// Look at the next `n` (<= 32) bits; past the end of data the missing bits read as zero.
    #[inline]
    pub fn peek(&mut self, n: u32) -> u32 {
        if self.bits < n {
            self.fill();
            if self.bits < n {
                return ((self.buf << (n - self.bits)) & ((1u64 << n) - 1)) as u32;
            }
        }
        ((self.buf >> (self.bits - n)) & ((1u64 << n) - 1)) as u32
    }

    /// Consume `n` bits. Consuming invented zero bits raises `insufficient`.
    #[inline]
    pub fn skip(&mut self, n: u32) {
        if n > self.bits {
            self.insufficient = true;
            self.bits = 0;
        } else {
            self.bits -= n;
        }
    }

    #[inline]
    pub fn get(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        let v = self.peek(n);
        self.skip(n);
        v
    }

    /// Absolute bit offset (in the file) of the next unread bit.
    pub fn bit_offset(&self) -> u64 {
        if self.bits == 0 {
            return self.pos as u64 * 8;
        }
        let j = (self.bits - 1) / 8;
        let idx = (self.loaded.wrapping_sub(1).wrapping_sub(j) & 7) as usize;
        self.ring[idx] as u64 * 8 + (7 - (self.bits - 1) % 8) as u64
    }

    /// Byte offset of the next unread bit.
    pub fn byte_offset(&self) -> usize {
        (self.bit_offset() / 8) as usize
    }

    /// Throw away buffered bits (libjpeg process_restart).
    pub fn discard_bits(&mut self) {
        self.bits = 0;
        self.buf = 0;
    }

    /// libjpeg next_marker: if no marker is pending, skip forward (discarding data) to the next one.
    /// End of data acts like a fake EOI.
    pub fn next_marker(&mut self) -> Hit {
        if let Some(h) = self.marker {
            return h;
        }
        let d = self.data;
        let mut p = self.pos;
        loop {
            while p < d.len() && d[p] != 0xFF {
                p += 1;
            }
            if p >= d.len() {
                let h = Hit { code: 0xD9, at: d.len(), after: d.len() };
                self.eof = true;
                self.pos = d.len();
                self.marker = Some(h);
                return h;
            }
            let start = p;
            while p < d.len() && d[p] == 0xFF {
                p += 1;
            }
            match d.get(p) {
                None => continue,
                Some(0) => {
                    p += 1;
                    continue;
                }
                Some(&c) => {
                    let h = Hit { code: c, at: start, after: p + 1 };
                    self.pos = start;
                    self.marker = Some(h);
                    return h;
                }
            }
        }
    }

    /// Swallow the pending marker and continue reading after it.
    pub fn consume_marker(&mut self) {
        if let Some(h) = self.marker.take() {
            self.pos = h.after;
        }
    }

    /// Real (not invented) bits still buffered.
    pub fn bits_buffered(&self) -> u32 {
        self.bits
    }

    pub fn data_len(&self) -> usize {
        self.data.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stuffing_roundtrip() {
        let mut w = BitWriter::new();
        w.put(0xFF, 8);
        w.put(0x5, 3);
        w.put(0x1FFF, 13);
        w.flush();
        assert_eq!(w.out[0..2], [0xFF, 0x00]);
        let mut r = BitReader::new(&w.out, 0);
        assert_eq!(r.get(8), 0xFF);
        assert_eq!(r.get(3), 5);
        assert_eq!(r.get(13), 0x1FFF);
        assert!(!r.insufficient);
    }
    #[test]
    fn marker_stops_and_zero_fills() {
        let data = [0xAB, 0xFF, 0xD9];
        let mut r = BitReader::new(&data, 0);
        assert_eq!(r.get(8), 0xAB);
        assert_eq!(r.get(8), 0);
        assert!(r.insufficient);
        assert_eq!(r.marker.map(|h| h.code), Some(0xD9));
    }
}
