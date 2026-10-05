//! Recovery of photos that only survive in some other container: thumbnails, thumbnail caches,
//! tiled HEIC grids and camera RAW files.

use crate::jpeg;
use refragmenter_codec::step::*;
use refragmenter_codec::{decode_rgba, encode_like, encode_rgba, Image};
use serde_json::Value;

pub(crate) fn resize_box(src: &Image, w: u32, h: u32) -> Image {
    let (w, h) = (w.max(1), h.max(1));
    let mut out = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        let y0 = (y as u64 * src.height as u64 / h as u64) as u32;
        let y1 = (((y + 1) as u64 * src.height as u64).div_ceil(h as u64) as u32).max(y0 + 1).min(src.height);
        for x in 0..w {
            let x0 = (x as u64 * src.width as u64 / w as u64) as u32;
            let x1 = (((x + 1) as u64 * src.width as u64).div_ceil(w as u64) as u32).max(x0 + 1).min(src.width);
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * src.width + sx) * 4) as usize;
                    for c in 0..4 {
                        acc[c] += src.rgba[i + c] as u32;
                    }
                    n += 1;
                }
            }
            let o = ((y * w + x) * 4) as usize;
            for c in 0..4 {
                out[o + c] = (acc[c] / n.max(1)) as u8;
            }
        }
    }
    Image { width: w, height: h, rgba: out }
}

fn resize_up(src: &Image, w: u32, h: u32, smooth: bool) -> Image {
    let mut out = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let o = ((y * w + x) * 4) as usize;
            if !smooth {
                let sx = (x as u64 * src.width as u64 / w as u64) as u32;
                let sy = (y as u64 * src.height as u64 / h as u64) as u32;
                let i = ((sy * src.width + sx) * 4) as usize;
                out[o..o + 4].copy_from_slice(&src.rgba[i..i + 4]);
            } else {
                // Bilinear in 8.8 fixed point (deterministic).
                let fx = ((x as i64 * 2 + 1) * src.width as i64 * 128 / w as i64 - 128).max(0);
                let fy = ((y as i64 * 2 + 1) * src.height as i64 * 128 / h as i64 - 128).max(0);
                let (x0, y0) = ((fx >> 8) as u32, (fy >> 8) as u32);
                let (ax, ay) = ((fx & 255) as u32, (fy & 255) as u32);
                let x1 = (x0 + 1).min(src.width - 1);
                let y1 = (y0 + 1).min(src.height - 1);
                let x0 = x0.min(src.width - 1);
                let y0 = y0.min(src.height - 1);
                let px = |xx: u32, yy: u32, c: usize| src.rgba[((yy * src.width + xx) * 4) as usize + c] as u32;
                for c in 0..4 {
                    let top = px(x0, y0, c) * (256 - ax) + px(x1, y0, c) * ax;
                    let bot = px(x0, y1, c) * (256 - ax) + px(x1, y1, c) * ax;
                    out[o + c] = ((top * (256 - ay) + bot * ay + 32768) >> 16) as u8;
                }
            }
        }
    }
    Image { width: w, height: h, rgba: out }
}

/// Fit inside a box keeping aspect; optionally pad to the full box with a colour.
fn fit(src: &Image, bw: u32, bh: u32, pad: Option<[u8; 3]>, crop_square: bool) -> Image {
    if crop_square {
        let s = src.width.min(src.height);
        let (ox, oy) = ((src.width - s) / 2, (src.height - s) / 2);
        let mut sq = vec![0u8; (s * s * 4) as usize];
        for y in 0..s {
            let a = (((y + oy) * src.width + ox) * 4) as usize;
            sq[(y * s * 4) as usize..((y + 1) * s * 4) as usize].copy_from_slice(&src.rgba[a..a + (s * 4) as usize]);
        }
        return resize_box(&Image { width: s, height: s, rgba: sq }, bw, bh);
    }
    crate::thumbs::fit_box(src, bw, bh, pad)
}

fn blow_up(input: &[u8], small: &Image, orig: &Image, p: &Value) -> Vec<u8> {
    match get_str(p, "upscale", "nearest") {
        "none" => encode_rgba(small, 85, "420"),
        mode => {
            let big = resize_up(small, orig.width, orig.height, mode == "smooth");
            encode_like(&big, input)
        }
    }
}

fn upscale_param() -> ParamInfo {
    p_enum(
        "upscale",
        "Blow it back up",
        &[("nearest", "Chunky pixels"), ("smooth", "Smooth (blurry)"), ("none", "Keep it tiny")],
        "nearest",
    )
}

pub fn catalog() -> Vec<StepInfo> {
    let info = |id, label, expert, help, params| StepInfo {
        id,
        label,
        group: "Formats",
        layer: Layer::Card,
        expert,
        random: false,
        uses_pool: false,
        simulated: false,
        help,
        params,
    };
    let mut v = vec![
        info(
            "thumbnail_only",
            "Only the thumbnail survived",
            false,
            "The big photo is gone, but the tiny 160×120 preview the camera tucked inside the file survived. Blown back up to full size, every pixel becomes a chunky block.",
            vec![upscale_param()],
        ),
        info(
            "thumbcache",
            "Recovered from a thumbnail cache",
            false,
            "Windows, Android and iPhones keep little preview copies of every photo they've shown. Sometimes that cache is all that's left: small, recompressed, sometimes cropped or padded with black bars.",
            vec![
                p_enum(
                    "kind",
                    "Cache",
                    &[
                        ("thumbs_db", "Windows XP Thumbs.db (96 px)"),
                        ("thumbcache", "Windows thumbcache (256 px)"),
                        ("android", "Android .thumbnails (512 px)"),
                        ("ios", "iPhone square thumbnail (120 px)"),
                    ],
                    "thumbs_db",
                ),
                upscale_param(),
            ],
        ),
        info(
            "heic_tiles",
            "Tiled HEIC, partly recovered",
            false,
            "iPhone photos are stored as a grid of 512×512 tiles, each compressed separately. Recover only some of them and the missing tiles come back as flat squares.",
            vec![
                p_enum("mode", "Which tiles are lost", &[("truncated", "Everything after a point"), ("scattered", "Random tiles")], "truncated"),
                p_float("lost", "Tiles lost (%)", 0.0, 100.0, 1.0, 35.0),
                p_enum("fill", "Missing tiles show as", &[("grey", "Grey"), ("black", "Black"), ("shuffle", "Wrong tiles")], "grey"),
                p_int("tile", "Tile size", 64, 1024, 512).expert(),
            ],
        ),
        info(
            "raw_preview",
            "RAW file: only the preview",
            false,
            "A RAW file carries a ready-made JPEG preview so cameras can show it quickly. Recovery tools often only get that preview: smaller, softer and squeezed harder than a real photo.",
            vec![
                p_enum(
                    "kind",
                    "Preview",
                    &[("full", "Full-size preview (low quality)"), ("medium", "Medium preview (1/4)"), ("thumb", "160×120 thumbnail")],
                    "medium",
                ),
                upscale_param(),
            ],
        ),
        info(
            "raw_as_jpeg",
            "RAW sensor data read as a JPEG",
            true,
            "Canon RAW data is compressed with lossless JPEG, so carvers find a JPEG marker and grab it. Decoded as an ordinary photo, the sensor's checkerboard of red, green and blue becomes stripy, coloured garbage.",
            vec![p_int("bits", "Sensor bits", 10, 14, 12).expert()],
        ),
    ];
    // these two use the seed (scattered/shuffled tiles, the sensor noise), so the UI shows their dice
    for s in v.iter_mut() {
        s.random = matches!(s.id, "heic_tiles" | "raw_as_jpeg");
    }
    v
}

pub fn apply(id: &str, p: &Value, input: &[u8], ctx: &StepCtx) -> Option<StepResult> {
    let r = match id {
        "thumbnail_only" => (|| {
            let orig = decode_rgba(input)?;
            let small = match jpeg::exif_thumbnail(input).and_then(|(o, l)| decode_rgba(&input[o..o + l]).ok()) {
                Some(t) => t,
                None => {
                    let t = fit(&orig, 160, 120, Some([0, 0, 0]), false);
                    decode_rgba(&encode_rgba(&t, 75, "422"))?
                }
            };
            Ok(blow_up(input, &small, &orig, p))
        })(),
        "thumbcache" => (|| {
            let orig = decode_rgba(input)?;
            let (t, q, ss) = match get_str(p, "kind", "thumbs_db") {
                "thumbcache" => (fit(&orig, 256, 256, None, false), 90, "420"),
                "android" => (fit(&orig, 512, 384, None, false), 85, "420"),
                "ios" => (fit(&orig, 120, 120, None, true), 70, "420"),
                _ => (fit(&orig, 96, 96, Some([255, 255, 255]), false), 75, "420"),
            };
            let small = decode_rgba(&encode_rgba(&t, q, ss))?;
            Ok(blow_up(input, &small, &orig, p))
        })(),
        "heic_tiles" => (|| {
            let mut img = decode_rgba(input)?;
            let ts = get_i64(p, "tile", 512).clamp(64, 1024) as u32;
            let (tx, ty) = (img.width.div_ceil(ts), img.height.div_ceil(ts));
            let n = (tx * ty) as usize;
            let lost_n = ((n as f64) * get_f64(p, "lost", 35.0).clamp(0.0, 100.0) / 100.0).round() as usize;
            let mut rng = ctx.rng();
            let mut order: Vec<usize> = (0..n).collect();
            let lost: Vec<usize> = if get_str(p, "mode", "truncated") == "scattered" {
                for i in (1..n).rev() {
                    order.swap(i, rng.below(i as u32 + 1) as usize);
                }
                order[..lost_n].to_vec()
            } else {
                (n - lost_n..n).collect()
            };
            let src = img.rgba.clone();
            let fill = get_str(p, "fill", "grey");
            for &t in &lost {
                let (cx, cy) = ((t as u32 % tx) * ts, (t as u32 / tx) * ts);
                let donor = rng.below(n as u32);
                let (dx, dy) = ((donor % tx) * ts, (donor / tx) * ts);
                for y in cy..(cy + ts).min(img.height) {
                    for x in cx..(cx + ts).min(img.width) {
                        let o = ((y * img.width + x) * 4) as usize;
                        match fill {
                            "black" => img.rgba[o..o + 3].fill(0),
                            "shuffle" => {
                                let sx = (dx + x - cx).min(img.width - 1);
                                let sy = (dy + y - cy).min(img.height - 1);
                                let s = ((sy * img.width + sx) * 4) as usize;
                                img.rgba[o..o + 3].copy_from_slice(&src[s..s + 3]);
                            }
                            _ => img.rgba[o..o + 3].fill(128),
                        }
                    }
                }
            }
            Ok(encode_like(&img, input))
        })(),
        "raw_preview" => (|| {
            let orig = decode_rgba(input)?;
            let (small, q, ss) = match get_str(p, "kind", "medium") {
                "full" => (orig.clone(), 55, "422"),
                "thumb" => (fit(&orig, 160, 120, Some([0, 0, 0]), false), 70, "422"),
                _ => (resize_box(&orig, orig.width / 2, orig.height / 2), 70, "422"),
            };
            let small = decode_rgba(&encode_rgba(&small, q, ss))?;
            if small.width == orig.width && get_str(p, "upscale", "nearest") != "none" {
                return Ok(encode_like(&small, input));
            }
            Ok(blow_up(input, &small, &orig, p))
        })(),
        "raw_as_jpeg" => (|| {
            let orig = decode_rgba(input)?;
            let bits = get_i64(p, "bits", 12).clamp(10, 14) as u32;
            Ok(raw_as_jpeg(input, &orig, bits, ctx.seed))
        })(),
        _ => return None,
    };
    Some(r)
}

struct BitWriter {
    out: Vec<u8>,
    acc: u32,
    n: u32,
}

impl BitWriter {
    fn put(&mut self, v: u32, bits: u32) {
        for k in (0..bits).rev() {
            self.acc = (self.acc << 1) | ((v >> k) & 1);
            self.n += 1;
            if self.n == 8 {
                let b = self.acc as u8;
                self.out.push(b);
                if b == 0xFF {
                    self.out.push(0);
                }
                self.acc = 0;
                self.n = 0;
            }
        }
    }
    fn flush(&mut self) {
        if self.n > 0 {
            self.put(0x7F, 8 - self.n);
        }
    }
}

/// Bayer-mosaic the image, encode it as Canon-style lossless JPEG (SOF3, predictor 1, two interleaved
/// components of half width), then hand the entropy data to a baseline header from the original photo,
/// the way a carver splices a RAW's image data onto a JPEG header.
fn raw_as_jpeg(input: &[u8], img: &Image, bits: u32, seed: u32) -> Vec<u8> {
    let (w, h) = (img.width & !1, img.height & !1);
    let mut rng = Pcg32::new(seed as u64, 99);
    let maxv = (1u32 << bits) - 1;
    // Sensor values (linear-ish), RGGB.
    let sensor = |x: u32, y: u32, rng: &mut Pcg32| -> i32 {
        let i = ((y * img.width + x) * 4) as usize;
        let c = match (y & 1, x & 1) {
            (0, 0) => 0,
            (1, 1) => 2,
            _ => 1,
        };
        let v = img.rgba[i + c] as u32;
        let lin = (v * v * maxv) / (255 * 255);
        (lin + 128 + rng.below(16)).min(maxv) as i32
    };
    // Huffman table for categories 0..=16 (fixed lengths, canonical codes).
    let lens: [u8; 17] = [3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    let mut codes = [0u16; 17];
    let mut code = 0u16;
    for len in 1..=16u8 {
        for s in 0..17 {
            if lens[s] == len {
                codes[s] = code;
                code += 1;
            }
        }
        code <<= 1;
    }
    let mut bw = BitWriter { out: Vec::new(), acc: 0, n: 0 };
    // Predictor 1 per colour plane: left neighbour of the same Bayer colour (x-2); row starts use the
    // value above.
    let mut row_start: [i32; 2] = [1 << (bits - 1); 2];
    for y in 0..h {
        let mut left = [0i32; 2];
        for x in 0..w {
            let v = sensor(x, y, &mut rng);
            let k = (x & 1) as usize;
            let pred = if x < 2 { row_start[k] } else { left[k] };
            if x < 2 {
                row_start[k] = v;
            }
            left[k] = v;
            let d = v - pred;
            let ssss = if d == 0 { 0 } else { 32 - d.unsigned_abs().leading_zeros() };
            bw.put(codes[ssss as usize] as u32, lens[ssss as usize] as u32);
            if ssss > 0 && ssss < 16 {
                let bits_v = if d < 0 { (d - 1) as u32 } else { d as u32 };
                bw.put(bits_v & ((1 << ssss) - 1), ssss);
            }
        }
    }
    bw.flush();
    let out = bw.out;
    let mut file = jpeg::header(input, true).unwrap_or_else(|| vec![0xFF, 0xD8]);
    file.extend_from_slice(&out);
    file.extend_from_slice(&[0xFF, 0xD9]);
    file
}
