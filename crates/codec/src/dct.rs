//! libjpeg "islow" integer DCTs (jfdctint.c / jidctint.c), reproduced bit-exactly, including the
//! post-IDCT range-limit table that wraps huge values (visible on corrupt data).

const CONST_BITS: i32 = 13;
const PASS1_BITS: i32 = 2;
const FIX_0_298631336: i32 = 2446;
const FIX_0_390180644: i32 = 3196;
const FIX_0_541196100: i32 = 4433;
const FIX_0_765366865: i32 = 6270;
const FIX_0_899976223: i32 = 7373;
const FIX_1_175875602: i32 = 9633;
const FIX_1_501321110: i32 = 12299;
const FIX_1_847759065: i32 = 15137;
const FIX_1_961570560: i32 = 16069;
const FIX_2_053119869: i32 = 16819;
const FIX_2_562915447: i32 = 20995;
const FIX_3_072711026: i32 = 25172;

#[inline(always)]
fn descale(x: i32, n: i32) -> i32 {
    x.wrapping_add(1 << (n - 1)) >> n
}

#[inline(always)]
fn m(a: i32, b: i32) -> i32 {
    a.wrapping_mul(b)
}

/// Forward DCT on level-shifted samples (sample - 128). Output is scaled by 8 like libjpeg.
pub fn fdct_islow(data: &mut [i32; 64]) {
    for r in 0..8 {
        let d = &mut data[r * 8..r * 8 + 8];
        let tmp0 = d[0] + d[7];
        let tmp7 = d[0] - d[7];
        let tmp1 = d[1] + d[6];
        let tmp6 = d[1] - d[6];
        let tmp2 = d[2] + d[5];
        let tmp5 = d[2] - d[5];
        let tmp3 = d[3] + d[4];
        let tmp4 = d[3] - d[4];
        let tmp10 = tmp0 + tmp3;
        let tmp13 = tmp0 - tmp3;
        let tmp11 = tmp1 + tmp2;
        let tmp12 = tmp1 - tmp2;
        d[0] = (tmp10 + tmp11) << PASS1_BITS;
        d[4] = (tmp10 - tmp11) << PASS1_BITS;
        let z1 = m(tmp12 + tmp13, FIX_0_541196100);
        d[2] = descale(z1 + m(tmp13, FIX_0_765366865), CONST_BITS - PASS1_BITS);
        d[6] = descale(z1 + m(tmp12, -FIX_1_847759065), CONST_BITS - PASS1_BITS);
        let z1 = tmp4 + tmp7;
        let z2 = tmp5 + tmp6;
        let z3 = tmp4 + tmp6;
        let z4 = tmp5 + tmp7;
        let z5 = m(z3 + z4, FIX_1_175875602);
        let tmp4 = m(tmp4, FIX_0_298631336);
        let tmp5 = m(tmp5, FIX_2_053119869);
        let tmp6 = m(tmp6, FIX_3_072711026);
        let tmp7 = m(tmp7, FIX_1_501321110);
        let z1 = m(z1, -FIX_0_899976223);
        let z2 = m(z2, -FIX_2_562915447);
        let z3 = m(z3, -FIX_1_961570560) + z5;
        let z4 = m(z4, -FIX_0_390180644) + z5;
        d[7] = descale(tmp4 + z1 + z3, CONST_BITS - PASS1_BITS);
        d[5] = descale(tmp5 + z2 + z4, CONST_BITS - PASS1_BITS);
        d[3] = descale(tmp6 + z2 + z3, CONST_BITS - PASS1_BITS);
        d[1] = descale(tmp7 + z1 + z4, CONST_BITS - PASS1_BITS);
    }
    for c in 0..8 {
        let g = |i: usize| data[c + 8 * i];
        let tmp0 = g(0) + g(7);
        let tmp7 = g(0) - g(7);
        let tmp1 = g(1) + g(6);
        let tmp6 = g(1) - g(6);
        let tmp2 = g(2) + g(5);
        let tmp5 = g(2) - g(5);
        let tmp3 = g(3) + g(4);
        let tmp4 = g(3) - g(4);
        let tmp10 = tmp0 + tmp3;
        let tmp13 = tmp0 - tmp3;
        let tmp11 = tmp1 + tmp2;
        let tmp12 = tmp1 - tmp2;
        let mut o = [0i32; 8];
        o[0] = descale(tmp10 + tmp11, PASS1_BITS);
        o[4] = descale(tmp10 - tmp11, PASS1_BITS);
        let z1 = m(tmp12 + tmp13, FIX_0_541196100);
        o[2] = descale(z1 + m(tmp13, FIX_0_765366865), CONST_BITS + PASS1_BITS);
        o[6] = descale(z1 + m(tmp12, -FIX_1_847759065), CONST_BITS + PASS1_BITS);
        let z1 = tmp4 + tmp7;
        let z2 = tmp5 + tmp6;
        let z3 = tmp4 + tmp6;
        let z4 = tmp5 + tmp7;
        let z5 = m(z3 + z4, FIX_1_175875602);
        let tmp4 = m(tmp4, FIX_0_298631336);
        let tmp5 = m(tmp5, FIX_2_053119869);
        let tmp6 = m(tmp6, FIX_3_072711026);
        let tmp7 = m(tmp7, FIX_1_501321110);
        let z1 = m(z1, -FIX_0_899976223);
        let z2 = m(z2, -FIX_2_562915447);
        let z3 = m(z3, -FIX_1_961570560) + z5;
        let z4 = m(z4, -FIX_0_390180644) + z5;
        o[7] = descale(tmp4 + z1 + z3, CONST_BITS + PASS1_BITS);
        o[5] = descale(tmp5 + z2 + z4, CONST_BITS + PASS1_BITS);
        o[3] = descale(tmp6 + z2 + z3, CONST_BITS + PASS1_BITS);
        o[1] = descale(tmp7 + z1 + z4, CONST_BITS + PASS1_BITS);
        for i in 0..8 {
            data[c + 8 * i] = o[i];
        }
    }
}

/// Quantise FDCT output (scaled by 8) with libjpeg's rounding: round-half-away of x / (8q).
#[inline]
pub fn quantize(v: i32, q: u16) -> i16 {
    let d = (q as i32).max(1) * 8;
    let r = if v < 0 { -((-v + (d >> 1)) / d) } else { (v + (d >> 1)) / d };
    r.clamp(-32767, 32767) as i16
}

/// libjpeg post-IDCT range limit: take the low 10 bits as a signed value, add 128, clamp.
#[inline(always)]
fn range_limit(x: i32) -> u8 {
    let v = x & 1023;
    let v = if v >= 512 { v - 1024 } else { v };
    (v + 128).clamp(0, 255) as u8
}

/// Inverse DCT of one block of quantised coefficients (natural order) with its quant table,
/// writing 8x8 samples into `out` at `stride`.
pub fn idct_islow(coef: &[i16], q: &[u16; 64], out: &mut [u8], stride: usize) {
    let mut ws = [0i32; 64];
    for c in 0..8 {
        let dq = |i: usize| (coef[c + 8 * i] as i32).wrapping_mul(q[c + 8 * i] as i16 as i32);
        if coef[c + 8] == 0
            && coef[c + 16] == 0
            && coef[c + 24] == 0
            && coef[c + 32] == 0
            && coef[c + 40] == 0
            && coef[c + 48] == 0
            && coef[c + 56] == 0
        {
            let dc = dq(0).wrapping_shl(PASS1_BITS as u32);
            for i in 0..8 {
                ws[c + 8 * i] = dc;
            }
            continue;
        }
        let z2 = dq(2);
        let z3 = dq(6);
        let z1 = m(z2.wrapping_add(z3), FIX_0_541196100);
        let tmp2 = z1.wrapping_add(m(z3, -FIX_1_847759065));
        let tmp3 = z1.wrapping_add(m(z2, FIX_0_765366865));
        let z2 = dq(0);
        let z3 = dq(4);
        let tmp0 = z2.wrapping_add(z3).wrapping_shl(CONST_BITS as u32);
        let tmp1 = z2.wrapping_sub(z3).wrapping_shl(CONST_BITS as u32);
        let tmp10 = tmp0.wrapping_add(tmp3);
        let tmp13 = tmp0.wrapping_sub(tmp3);
        let tmp11 = tmp1.wrapping_add(tmp2);
        let tmp12 = tmp1.wrapping_sub(tmp2);
        let (o0, o1, o2, o3) = idct_odd(dq(7), dq(5), dq(3), dq(1));
        let sh = CONST_BITS - PASS1_BITS;
        ws[c] = descale(tmp10.wrapping_add(o3), sh);
        ws[c + 56] = descale(tmp10.wrapping_sub(o3), sh);
        ws[c + 8] = descale(tmp11.wrapping_add(o2), sh);
        ws[c + 48] = descale(tmp11.wrapping_sub(o2), sh);
        ws[c + 16] = descale(tmp12.wrapping_add(o1), sh);
        ws[c + 40] = descale(tmp12.wrapping_sub(o1), sh);
        ws[c + 24] = descale(tmp13.wrapping_add(o0), sh);
        ws[c + 32] = descale(tmp13.wrapping_sub(o0), sh);
    }
    let sh = CONST_BITS + PASS1_BITS + 3;
    for r in 0..8 {
        let w = &ws[r * 8..r * 8 + 8];
        let o = &mut out[r * stride..r * stride + 8];
        if w[1] == 0 && w[2] == 0 && w[3] == 0 && w[4] == 0 && w[5] == 0 && w[6] == 0 && w[7] == 0 {
            let v = range_limit(descale(w[0], PASS1_BITS + 3));
            o.fill(v);
            continue;
        }
        let z2 = w[2];
        let z3 = w[6];
        let z1 = m(z2.wrapping_add(z3), FIX_0_541196100);
        let tmp2 = z1.wrapping_add(m(z3, -FIX_1_847759065));
        let tmp3 = z1.wrapping_add(m(z2, FIX_0_765366865));
        let tmp0 = w[0].wrapping_add(w[4]).wrapping_shl(CONST_BITS as u32);
        let tmp1 = w[0].wrapping_sub(w[4]).wrapping_shl(CONST_BITS as u32);
        let tmp10 = tmp0.wrapping_add(tmp3);
        let tmp13 = tmp0.wrapping_sub(tmp3);
        let tmp11 = tmp1.wrapping_add(tmp2);
        let tmp12 = tmp1.wrapping_sub(tmp2);
        let (o0, o1, o2, o3) = idct_odd(w[7], w[5], w[3], w[1]);
        o[0] = range_limit(descale(tmp10.wrapping_add(o3), sh));
        o[7] = range_limit(descale(tmp10.wrapping_sub(o3), sh));
        o[1] = range_limit(descale(tmp11.wrapping_add(o2), sh));
        o[6] = range_limit(descale(tmp11.wrapping_sub(o2), sh));
        o[2] = range_limit(descale(tmp12.wrapping_add(o1), sh));
        o[5] = range_limit(descale(tmp12.wrapping_sub(o1), sh));
        o[3] = range_limit(descale(tmp13.wrapping_add(o0), sh));
        o[4] = range_limit(descale(tmp13.wrapping_sub(o0), sh));
    }
}

#[inline(always)]
fn w16(x: i32) -> i32 {
    x as i16 as i32
}

#[inline(always)]
fn sat16(x: i32) -> i32 {
    x.clamp(-32768, 32767)
}

/// One 1-D islow pass as libjpeg-turbo's SIMD code computes it: 16-bit lane adds for
/// in0±in4, in7+in3 and in5+in1 (wrapping), 32-bit products, saturating 16-bit outputs.
#[inline(always)]
fn simd_pass(i: [i32; 8], shift: i32) -> [i32; 8] {
    let a = w16(i[0] + i[4]);
    let b = w16(i[0] + w16(-i[4]));
    let tmp0 = a << CONST_BITS;
    let tmp1 = b << CONST_BITS;
    let tmp3 = m(i[2], FIX_0_541196100 + FIX_0_765366865).wrapping_add(m(i[6], FIX_0_541196100));
    let tmp2 = m(i[2], FIX_0_541196100).wrapping_add(m(i[6], FIX_0_541196100 - FIX_1_847759065));
    let tmp10 = tmp0.wrapping_add(tmp3);
    let tmp13 = tmp0.wrapping_sub(tmp3);
    let tmp11 = tmp1.wrapping_add(tmp2);
    let tmp12 = tmp1.wrapping_sub(tmp2);
    let z3 = w16(i[7] + i[3]);
    let z4 = w16(i[5] + i[1]);
    let z3p = m(z3, FIX_1_175875602 - FIX_1_961570560).wrapping_add(m(z4, FIX_1_175875602));
    let z4p = m(z3, FIX_1_175875602).wrapping_add(m(z4, FIX_1_175875602 - FIX_0_390180644));
    let o0 = m(i[7], FIX_0_298631336 - FIX_0_899976223).wrapping_add(m(i[1], -FIX_0_899976223)).wrapping_add(z3p);
    let o1 = m(i[5], FIX_2_053119869 - FIX_2_562915447).wrapping_add(m(i[3], -FIX_2_562915447)).wrapping_add(z4p);
    let o2 = m(i[5], -FIX_2_562915447).wrapping_add(m(i[3], FIX_3_072711026 - FIX_2_562915447)).wrapping_add(z3p);
    let o3 = m(i[7], -FIX_0_899976223).wrapping_add(m(i[1], FIX_1_501321110 - FIX_0_899976223)).wrapping_add(z4p);
    let d = |x: i32| sat16(descale(x, shift));
    [
        d(tmp10.wrapping_add(o3)),
        d(tmp11.wrapping_add(o2)),
        d(tmp12.wrapping_add(o1)),
        d(tmp13.wrapping_add(o0)),
        d(tmp13.wrapping_sub(o0)),
        d(tmp12.wrapping_sub(o1)),
        d(tmp11.wrapping_sub(o2)),
        d(tmp10.wrapping_sub(o3)),
    ]
}

/// islow IDCT as libjpeg-turbo's x86 SIMD path computes it (what Pillow and Chromium on x86
/// actually run). Identical to `idct_islow` for valid data; differs (saturates instead of
/// wrapping) on the huge coefficients that corrupt streams produce.
pub fn idct_islow_simd(coef: &[i16], q: &[u16; 64], out: &mut [u8], stride: usize) {
    let mut dq = [0i32; 64];
    for k in 0..64 {
        dq[k] = w16((coef[k] as i32).wrapping_mul(q[k] as i32));
    }
    let mut ws = [0i32; 64];
    if coef[8..].iter().all(|&c| c == 0) {
        for c in 0..8 {
            let v = w16(dq[c] << PASS1_BITS);
            for r in 0..8 {
                ws[r * 8 + c] = v;
            }
        }
    } else {
        for c in 0..8 {
            let col = [dq[c], dq[c + 8], dq[c + 16], dq[c + 24], dq[c + 32], dq[c + 40], dq[c + 48], dq[c + 56]];
            let o = simd_pass(col, CONST_BITS - PASS1_BITS);
            for r in 0..8 {
                ws[r * 8 + c] = o[r];
            }
        }
    }
    for r in 0..8 {
        let row = [ws[r * 8], ws[r * 8 + 1], ws[r * 8 + 2], ws[r * 8 + 3], ws[r * 8 + 4], ws[r * 8 + 5], ws[r * 8 + 6], ws[r * 8 + 7]];
        let o = simd_pass(row, CONST_BITS + PASS1_BITS + 3);
        let dst = &mut out[r * stride..r * stride + 8];
        for x in 0..8 {
            dst[x] = (o[x].clamp(-128, 127) + 128) as u8;
        }
    }
}

#[inline(always)]
fn idct_odd(t0: i32, t1: i32, t2: i32, t3: i32) -> (i32, i32, i32, i32) {
    let z1 = t0.wrapping_add(t3);
    let z2 = t1.wrapping_add(t2);
    let z3 = t0.wrapping_add(t2);
    let z4 = t1.wrapping_add(t3);
    let z5 = m(z3.wrapping_add(z4), FIX_1_175875602);
    let t0 = m(t0, FIX_0_298631336);
    let t1 = m(t1, FIX_2_053119869);
    let t2 = m(t2, FIX_3_072711026);
    let t3 = m(t3, FIX_1_501321110);
    let z1 = m(z1, -FIX_0_899976223);
    let z2 = m(z2, -FIX_2_562915447);
    let z3 = m(z3, -FIX_1_961570560).wrapping_add(z5);
    let z4 = m(z4, -FIX_0_390180644).wrapping_add(z5);
    (
        t0.wrapping_add(z1).wrapping_add(z3),
        t1.wrapping_add(z2).wrapping_add(z4),
        t2.wrapping_add(z2).wrapping_add(z3),
        t3.wrapping_add(z1).wrapping_add(z4),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flat_block_roundtrip() {
        let mut d = [0i32; 64];
        for v in d.iter_mut() {
            *v = 200 - 128;
        }
        fdct_islow(&mut d);
        let q = [1u16; 64];
        let mut c = [0i16; 64];
        for i in 0..64 {
            c[i] = quantize(d[i], q[i]);
        }
        let mut out = [0u8; 64];
        idct_islow(&c, &q, &mut out, 8);
        assert!(out.iter().all(|&v| v == 200));
    }
    #[test]
    fn range_limit_wraps() {
        assert_eq!(range_limit(0), 128);
        assert_eq!(range_limit(200), 255);
        assert_eq!(range_limit(-200), 0);
        assert_eq!(range_limit(1100), 204);
    }
}
