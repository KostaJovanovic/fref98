//! Integer RGBA helpers shared by steps: resizing, shifting, cropping.

/// RGBA image buffer.
#[derive(Clone, Debug)]
pub struct Rgba {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

impl Rgba {
    pub fn new(w: usize, h: usize) -> Self {
        Rgba { w, h, px: vec![255; w * h * 4] }
    }
    #[inline]
    pub fn get(&self, x: usize, y: usize) -> [u8; 4] {
        let i = (y * self.w + x) * 4;
        [self.px[i], self.px[i + 1], self.px[i + 2], self.px[i + 3]]
    }
    #[inline]
    pub fn set(&mut self, x: usize, y: usize, c: [u8; 3]) {
        let i = (y * self.w + x) * 4;
        self.px[i..i + 3].copy_from_slice(&c);
    }
    /// Clamped sample.
    #[inline]
    pub fn at(&self, x: i64, y: i64) -> [u8; 4] {
        let x = x.clamp(0, self.w as i64 - 1) as usize;
        let y = y.clamp(0, self.h as i64 - 1) as usize;
        self.get(x, y)
    }
}

/// Area-average (downscale) / bilinear (upscale) resize in fixed point. Deterministic.
pub fn resize(src: &Rgba, ow: usize, oh: usize) -> Rgba {
    let ow = ow.max(1);
    let oh = oh.max(1);
    if ow == src.w && oh == src.h {
        return src.clone();
    }
    let mut out = Rgba::new(ow, oh);
    if src.w == 0 || src.h == 0 {
        return out;
    }
    if ow <= src.w && oh <= src.h {
        // Box filter over the source footprint, 8-bit fixed point weights.
        for oy in 0..oh {
            let y0 = oy * src.h * 256 / oh;
            let y1 = ((oy + 1) * src.h * 256 / oh).max(y0 + 1);
            for ox in 0..ow {
                let x0 = ox * src.w * 256 / ow;
                let x1 = ((ox + 1) * src.w * 256 / ow).max(x0 + 1);
                let mut acc = [0u64; 3];
                let mut wsum = 0u64;
                let mut sy = y0 / 256;
                while sy * 256 < y1 && sy < src.h {
                    let wy = (y1.min((sy + 1) * 256) - y0.max(sy * 256)) as u64;
                    let mut sx = x0 / 256;
                    while sx * 256 < x1 && sx < src.w {
                        let wx = (x1.min((sx + 1) * 256) - x0.max(sx * 256)) as u64;
                        let wgt = wx * wy;
                        let p = src.get(sx, sy);
                        for c in 0..3 {
                            acc[c] += p[c] as u64 * wgt;
                        }
                        wsum += wgt;
                        sx += 1;
                    }
                    sy += 1;
                }
                let wsum = wsum.max(1);
                out.set(ox, oy, [((acc[0] + wsum / 2) / wsum) as u8, ((acc[1] + wsum / 2) / wsum) as u8, ((acc[2] + wsum / 2) / wsum) as u8]);
            }
        }
    } else {
        for oy in 0..oh {
            let fy = ((oy as i64 * 2 + 1) * src.h as i64 * 128 / oh as i64 - 128).max(0);
            let (y, ty) = (fy / 256, fy % 256);
            for ox in 0..ow {
                let fx = ((ox as i64 * 2 + 1) * src.w as i64 * 128 / ow as i64 - 128).max(0);
                let (x, tx) = (fx / 256, fx % 256);
                let a = src.at(x, y);
                let b = src.at(x + 1, y);
                let c = src.at(x, y + 1);
                let d = src.at(x + 1, y + 1);
                let mut px = [0u8; 3];
                for k in 0..3 {
                    let top = a[k] as i64 * (256 - tx) + b[k] as i64 * tx;
                    let bot = c[k] as i64 * (256 - tx) + d[k] as i64 * tx;
                    px[k] = ((top * (256 - ty) + bot * ty + 32768) >> 16) as u8;
                }
                out.set(ox, oy, px);
            }
        }
    }
    out
}

/// Fit inside a (max_w, max_h) box, keeping aspect; never upscales.
pub fn fit_dims(w: usize, h: usize, max_w: usize, max_h: usize) -> (usize, usize) {
    if w <= max_w && h <= max_h {
        return (w, h);
    }
    // scale = min(max_w / w, max_h / h)
    let (nw, nh) = if max_w * h <= max_h * w { (max_w, (h * max_w + w / 2) / w) } else { ((w * max_h + h / 2) / h, max_h) };
    (nw.max(1), nh.max(1))
}

/// Fit the long side to `max_long`.
pub fn fit_long(w: usize, h: usize, max_long: usize) -> (usize, usize) {
    fit_dims(w, h, max_long, max_long)
}

/// Translate by (dx, dy) with edge replication.
pub fn shift(src: &Rgba, dx: i64, dy: i64) -> Rgba {
    let mut out = Rgba::new(src.w, src.h);
    for y in 0..src.h {
        for x in 0..src.w {
            let p = src.at(x as i64 - dx, y as i64 - dy);
            out.set(x, y, [p[0], p[1], p[2]]);
        }
    }
    out
}

pub fn crop(src: &Rgba, x0: usize, y0: usize, w: usize, h: usize) -> Rgba {
    let x0 = x0.min(src.w.saturating_sub(1));
    let y0 = y0.min(src.h.saturating_sub(1));
    let w = w.min(src.w - x0).max(1);
    let h = h.min(src.h - y0).max(1);
    let mut out = Rgba::new(w, h);
    for y in 0..h {
        let s = ((y0 + y) * src.w + x0) * 4;
        out.px[y * w * 4..(y + 1) * w * 4].copy_from_slice(&src.px[s..s + w * 4]);
    }
    out
}
