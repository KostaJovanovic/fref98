//! Animated GIF writer: fixed 256-colour palette (6x7x6 cube + greys) with 4x4 Bayer dithering
//! (fits the app's retro look) and a plain LZW coder.

const BAYER4: [i32; 16] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

fn palette() -> Vec<[u8; 3]> {
    let mut p = Vec::with_capacity(256);
    for r in 0..6u32 {
        for g in 0..7u32 {
            for b in 0..6u32 {
                p.push([(r * 255 / 5) as u8, (g * 255 / 6) as u8, (b * 255 / 5) as u8]);
            }
        }
    }
    for i in 0..4u32 {
        p.push([(i * 51 + 42) as u8; 3]);
    }
    p
}

#[inline]
fn quant(v: u8, levels: i32, t: i32) -> i32 {
    // t in 0..16; spread the threshold across one quantisation step.
    let step = 255 * 16 / (levels - 1);
    let x = v as i32 * 16 + (t - 8) * step / 16;
    ((x * (levels - 1) + 255 * 8) / (255 * 16)).clamp(0, levels - 1)
}

fn index_frame(w: usize, h: usize, rgba: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let (r, g, b) = match rgba.get(i..i + 3) {
                Some(p) => (p[0], p[1], p[2]),
                None => (0, 0, 0),
            };
            let t = BAYER4[(y & 3) * 4 + (x & 3)];
            let (qr, qg, qb) = (quant(r, 6, t), quant(g, 7, t), quant(b, 6, t));
            out[y * w + x] = (qr * 42 + qg * 6 + qb) as u8;
        }
    }
    out
}

struct BitOut {
    out: Vec<u8>,
    acc: u32,
    n: u32,
}
impl BitOut {
    fn put(&mut self, code: u32, size: u32) {
        self.acc |= code << self.n;
        self.n += size;
        while self.n >= 8 {
            self.out.push(self.acc as u8);
            self.acc >>= 8;
            self.n -= 8;
        }
    }
    fn finish(mut self) -> Vec<u8> {
        if self.n > 0 {
            self.out.push(self.acc as u8);
        }
        self.out
    }
}

fn lzw(data: &[u8]) -> Vec<u8> {
    const MIN: u32 = 8;
    let clear = 1u32 << MIN;
    let eoi = clear + 1;
    let mut table = vec![0u16; 4096 * 256];
    let mut next = eoi + 1;
    let mut size = MIN + 1;
    let mut bo = BitOut { out: Vec::new(), acc: 0, n: 0 };
    bo.put(clear, size);
    let mut it = data.iter();
    let Some(&first) = it.next() else {
        bo.put(eoi, size);
        return bo.finish();
    };
    let mut cur = first as u32;
    for &b in it {
        let key = (cur as usize) * 256 + b as usize;
        let hit = table[key];
        if hit != 0 {
            cur = hit as u32;
            continue;
        }
        bo.put(cur, size);
        if next < 4096 {
            table[key] = next as u16;
            if next == (1 << size) && size < 12 {
                size += 1;
            }
            next += 1;
        } else {
            bo.put(clear, size);
            table.iter_mut().for_each(|e| *e = 0);
            next = eoi + 1;
            size = MIN + 1;
        }
        cur = b as u32;
    }
    bo.put(cur, size);
    bo.put(eoi, size);
    bo.finish()
}

/// Encode RGBA frames as a looping animated GIF. `delay_cs` is the frame delay in 1/100 s.
pub fn encode(w: usize, h: usize, frames: &[Vec<u8>], delay_cs: u16) -> Vec<u8> {
    let w = w.clamp(1, 65535);
    let h = h.clamp(1, 65535);
    let mut o = Vec::new();
    o.extend_from_slice(b"GIF89a");
    o.extend_from_slice(&(w as u16).to_le_bytes());
    o.extend_from_slice(&(h as u16).to_le_bytes());
    o.extend_from_slice(&[0xF7, 0, 0]);
    let pal = palette();
    for c in &pal {
        o.extend_from_slice(c);
    }
    o.extend_from_slice(&[0x21, 0xFF, 0x0B]);
    o.extend_from_slice(b"NETSCAPE2.0");
    o.extend_from_slice(&[3, 1, 0, 0, 0]);
    for f in frames {
        o.extend_from_slice(&[0x21, 0xF9, 4, 0x04]);
        o.extend_from_slice(&delay_cs.to_le_bytes());
        o.extend_from_slice(&[0, 0]);
        o.push(0x2C);
        o.extend_from_slice(&[0, 0, 0, 0]);
        o.extend_from_slice(&(w as u16).to_le_bytes());
        o.extend_from_slice(&(h as u16).to_le_bytes());
        o.push(0);
        o.push(8);
        let data = lzw(&index_frame(w, h, f));
        for chunk in data.chunks(255) {
            o.push(chunk.len() as u8);
            o.extend_from_slice(chunk);
        }
        o.push(0);
    }
    o.push(0x3B);
    o
}
