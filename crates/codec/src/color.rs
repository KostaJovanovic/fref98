//! Colour conversion with libjpeg's integer arithmetic (jccolor.c / jdcolor.c).

const ONE_HALF: i32 = 1 << 15;
const CBCR_OFFSET: i32 = 128 << 16;

/// Colour matrix used when converting RGB to YCbCr for encoding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Matrix {
    Bt601,
    Bt709,
}

/// RGB -> YCbCr, bit-exact with libjpeg's rgb_ycc_convert (BT.601) or an analogous BT.709 variant.
#[inline]
pub fn rgb_to_ycc(r: u8, g: u8, b: u8, m: Matrix) -> (u8, u8, u8) {
    let (r, g, b) = (r as i32, g as i32, b as i32);
    let (ry, gy, by, rcb, gcb, gcr, bcr) = match m {
        Matrix::Bt601 => (19595, 38470, 7471, 11059, 21709, 27439, 5329),
        // Kr = 0.2126, Kb = 0.0722
        Matrix::Bt709 => (13933, 46871, 4732, 7509, 25259, 29763, 3005),
    };
    let y = (ry * r + gy * g + by * b + ONE_HALF) >> 16;
    let cb = (-rcb * r - gcb * g + 32768 * b + CBCR_OFFSET + ONE_HALF - 1) >> 16;
    let cr = (32768 * r - gcr * g - bcr * b + CBCR_OFFSET + ONE_HALF - 1) >> 16;
    (y.clamp(0, 255) as u8, cb.clamp(0, 255) as u8, cr.clamp(0, 255) as u8)
}

/// YCbCr -> RGB, bit-exact with libjpeg's ycc_rgb_convert.
#[inline]
pub fn ycc_to_rgb(y: u8, cb: u8, cr: u8) -> (u8, u8, u8) {
    let y = y as i32;
    let cb = cb as i32 - 128;
    let cr = cr as i32 - 128;
    let r = y + ((91881 * cr + ONE_HALF) >> 16);
    let b = y + ((116130 * cb + ONE_HALF) >> 16);
    let g = y + ((-22554 * cb + ONE_HALF - 46802 * cr) >> 16);
    (r.clamp(0, 255) as u8, g.clamp(0, 255) as u8, b.clamp(0, 255) as u8)
}

/// Adobe-style inverted CMYK to RGB.
#[inline]
pub fn cmyk_to_rgb(c: u8, m: u8, y: u8, k: u8) -> (u8, u8, u8) {
    let f = |v: u8| ((v as u32 * k as u32 + 127) / 255) as u8;
    (f(c), f(m), f(y))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grey_is_neutral() {
        for v in [0u8, 1, 77, 128, 254, 255] {
            let (y, cb, cr) = rgb_to_ycc(v, v, v, Matrix::Bt601);
            assert_eq!((y, cb, cr), (v, 128, 128));
            assert_eq!(ycc_to_rgb(y, cb, cr), (v, v, v));
        }
    }
}
