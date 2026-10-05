//! Chroma down- and upsampling, matching libjpeg's jcsample.c and libjpeg-turbo's jdsample.c
//! (including "fancy" triangle filters for h2v1, h2v2 and h1v2).

/// An 8-bit sample plane.
#[derive(Clone, Debug)]
pub struct Plane8 {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

impl Plane8 {
    pub fn new(w: usize, h: usize, fill: u8) -> Self {
        Plane8 { w, h, data: vec![fill; w * h] }
    }
    #[inline]
    pub fn at(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.w + x]
    }
    /// Copy with edge replication into a larger plane.
    pub fn extend(&self, w: usize, h: usize) -> Plane8 {
        let mut out = Plane8::new(w, h, 0);
        if self.w == 0 || self.h == 0 {
            return out;
        }
        for y in 0..h {
            let sy = y.min(self.h - 1);
            let src = &self.data[sy * self.w..sy * self.w + self.w];
            let dst = &mut out.data[y * w..y * w + w];
            let n = self.w.min(w);
            dst[..n].copy_from_slice(&src[..n]);
            let last = src[self.w - 1];
            for v in dst[n..].iter_mut() {
                *v = last;
            }
        }
        out
    }
}

/// Downsample a full-resolution plane by integer factors (hf, vf) with libjpeg's rounding.
pub fn downsample(src: &Plane8, hf: usize, vf: usize) -> Plane8 {
    let hf = hf.max(1);
    let vf = vf.max(1);
    if hf == 1 && vf == 1 {
        return src.clone();
    }
    let ow = src.w / hf;
    let oh = src.h / vf;
    let mut out = Plane8::new(ow, oh, 0);
    for oy in 0..oh {
        let mut bias: u32 = if hf == 2 && vf == 2 { 1 } else { 0 };
        for ox in 0..ow {
            let v = if hf == 2 && vf == 1 {
                let r = &src.data[oy * src.w + ox * 2..];
                let v = (r[0] as u32 + r[1] as u32 + bias) >> 1;
                bias ^= 1;
                v
            } else if hf == 2 && vf == 2 {
                let r0 = &src.data[oy * 2 * src.w + ox * 2..];
                let r1 = &src.data[(oy * 2 + 1) * src.w + ox * 2..];
                let v = (r0[0] as u32 + r0[1] as u32 + r1[0] as u32 + r1[1] as u32 + bias) >> 2;
                bias ^= 3;
                v
            } else {
                let n = (hf * vf) as u32;
                let mut s = 0u32;
                for dy in 0..vf {
                    for dx in 0..hf {
                        s += src.data[(oy * vf + dy) * src.w + ox * hf + dx] as u32;
                    }
                }
                (s + n / 2) / n
            };
            out.data[oy * ow + ox] = v as u8;
        }
    }
    out
}

/// Upsampling method choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UpOpts {
    pub fancy: bool,
    /// libjpeg-turbo >= 2.1 has a fancy h1v2 filter; IJG 6b (GDI+ era) replicates.
    pub fancy_h1v2: bool,
}

/// Upsample a decoded component plane to `out_w` x `out_h`.
/// `src` is the block-padded plane; `dw`/`dh` the component's real (downsampled) size.
#[allow(clippy::too_many_arguments)]
pub fn upsample(src: &Plane8, dw: usize, dh: usize, h: usize, v: usize, hmax: usize, vmax: usize, out_w: usize, out_h: usize, o: UpOpts) -> Plane8 {
    let mut out = Plane8::new(out_w, out_h, 128);
    if src.w == 0 || src.h == 0 || dw == 0 || dh == 0 {
        return out;
    }
    let dw = dw.min(src.w);
    let dh = dh.min(src.h);
    let integral = h > 0 && v > 0 && hmax % h == 0 && vmax % v == 0;
    let hx = if integral { hmax / h } else { 0 };
    let vx = if integral { vmax / v } else { 0 };
    let row = |y: usize| &src.data[y * src.w..y * src.w + src.w];
    if integral && hx == 1 && vx == 1 {
        for y in 0..out_h {
            let s = row(y.min(src.h - 1));
            let n = out_w.min(src.w);
            out.data[y * out_w..y * out_w + n].copy_from_slice(&s[..n]);
        }
        return out;
    }
    let mut tmp = vec![0u8; dw * 2 + 2];
    if integral && hx == 2 && vx == 1 && o.fancy && dw > 2 {
        for y in 0..out_h {
            h2v1_fancy(row(y.min(src.h - 1)), dw, &mut tmp);
            let n = out_w.min(tmp.len());
            out.data[y * out_w..y * out_w + n].copy_from_slice(&tmp[..n]);
        }
        return out;
    }
    if integral && hx == 2 && vx == 2 && o.fancy && dw > 2 {
        for y in 0..out_h {
            let r = (y / 2).min(dh - 1);
            let near = row(r);
            let far = if y % 2 == 0 { row(r.saturating_sub(1)) } else { row((r + 1).min(dh - 1)) };
            h2v2_fancy(near, far, dw, y % 2 == 1, &mut tmp);
            let n = out_w.min(tmp.len());
            out.data[y * out_w..y * out_w + n].copy_from_slice(&tmp[..n]);
        }
        return out;
    }
    if integral && hx == 1 && vx == 2 && o.fancy && o.fancy_h1v2 {
        for y in 0..out_h {
            let r = (y / 2).min(dh - 1);
            let near = row(r);
            let (far, bias) = if y % 2 == 0 { (row(r.saturating_sub(1)), 1) } else { (row((r + 1).min(dh - 1)), 2) };
            let n = out_w.min(src.w);
            for x in 0..n {
                out.data[y * out_w + x] = ((near[x] as u32 * 3 + far[x] as u32 + bias) >> 2) as u8;
            }
        }
        return out;
    }
    // Replication (int_upsample) or nearest for non-integral ratios.
    for y in 0..out_h {
        let sy = if integral { y / vx } else { y * v / vmax.max(1) };
        let s = row(sy.min(src.h - 1));
        let d = &mut out.data[y * out_w..y * out_w + out_w];
        for (x, px) in d.iter_mut().enumerate() {
            let sx = if integral { x / hx } else { x * h / hmax.max(1) };
            *px = s[sx.min(src.w - 1)];
        }
    }
    out
}

fn h2v1_fancy(inp: &[u8], dw: usize, out: &mut [u8]) {
    let g = |i: usize| inp[i] as u32;
    out[0] = inp[0];
    out[1] = ((g(0) * 3 + g(1) + 2) >> 2) as u8;
    for c in 1..dw - 1 {
        let v = g(c) * 3;
        out[c * 2] = ((v + g(c - 1) + 1) >> 2) as u8;
        out[c * 2 + 1] = ((v + g(c + 1) + 2) >> 2) as u8;
    }
    let l = dw - 1;
    out[l * 2] = ((g(l) * 3 + g(l - 1) + 1) >> 2) as u8;
    out[l * 2 + 1] = inp[l];
}

fn h2v2_fancy(near: &[u8], far: &[u8], dw: usize, _below: bool, out: &mut [u8]) {
    let sum = |i: usize| near[i] as u32 * 3 + far[i] as u32;
    let mut this = sum(0);
    let mut next = sum(1);
    out[0] = ((this * 4 + 8) >> 4) as u8;
    out[1] = ((this * 3 + next + 7) >> 4) as u8;
    let mut last = this;
    this = next;
    for c in 1..dw - 1 {
        next = sum(c + 1);
        out[c * 2] = ((this * 3 + last + 8) >> 4) as u8;
        out[c * 2 + 1] = ((this * 3 + next + 7) >> 4) as u8;
        last = this;
        this = next;
    }
    let l = dw - 1;
    out[l * 2] = ((this * 3 + last + 8) >> 4) as u8;
    out[l * 2 + 1] = ((this * 4 + 7) >> 4) as u8;
}
