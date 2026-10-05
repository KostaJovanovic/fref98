//! Thumbnails the way devices make them: the camera's 160×120 EXIF thumbnail and Windows XP's
//! Thumbs.db (an OLE2 / Compound File Binary container with one small JPEG per picture).
//! Both are real JPEGs made by our encoder, so thumbnail carving finds them on the card.

use refragmenter_codec::color::ycc_to_rgb;
use refragmenter_codec::coeffs::ColorSpace;
use refragmenter_codec::{decode_rgba, encode_rgba, Image};

/// 1/8-scale image straight from the DC coefficients (what cameras and Windows' fast thumbnail
/// paths effectively do). Much cheaper than a full decode for a multi-megapixel photo.
pub fn dc_image(jpeg: &[u8]) -> Option<Image> {
    let p = refragmenter_codec::decoder::parse(jpeg, false);
    let img = p.img.as_ref()?;
    let y = img.comps.first()?;
    let (w, h) = (y.wib.max(1), y.hib.max(1));
    let level = |ci: usize, bx: usize, by: usize| -> u8 {
        let c = &img.comps[ci];
        let (cx, cy) = ((bx * c.h / img.hmax).min(c.bw - 1), (by * c.v / img.vmax).min(c.bh - 1));
        let dc = c.coef[(cy * c.bw + cx) * 64] as i32 * c.q[0] as i32;
        (128 + (dc + if dc >= 0 { 4 } else { -4 }) / 8).clamp(0, 255) as u8
    };
    let mut rgba = vec![255u8; w * h * 4];
    match (img.color, img.comps.len()) {
        (ColorSpace::YCbCr, 3) | (ColorSpace::Rgb, 3) => {
            for by in 0..h {
                for bx in 0..w {
                    let (a, b, c) = (level(0, bx, by), level(1, bx, by), level(2, bx, by));
                    let (r, g, bl) = if img.color == ColorSpace::Rgb { (a, b, c) } else { ycc_to_rgb(a, b, c) };
                    let o = (by * w + bx) * 4;
                    rgba[o] = r;
                    rgba[o + 1] = g;
                    rgba[o + 2] = bl;
                }
            }
        }
        (ColorSpace::Gray, _) => {
            for by in 0..h {
                for bx in 0..w {
                    let v = level(0, bx, by);
                    let o = (by * w + bx) * 4;
                    rgba[o..o + 3].fill(v);
                }
            }
        }
        _ => {
            let full = decode_rgba(jpeg).ok()?;
            return Some(crate::formats::resize_box(&full, (full.width / 8).max(1), (full.height / 8).max(1)));
        }
    }
    Some(Image { width: w as u32, height: h as u32, rgba })
}

/// Scale `src` to fit a w×h box (keeping aspect), optionally centred on a padded canvas.
pub fn fit_box(src: &Image, bw: u32, bh: u32, pad: Option<[u8; 3]>) -> Image {
    let s = (bw as f64 / src.width as f64).min(bh as f64 / src.height as f64).min(1.0);
    let (w, h) = (((src.width as f64 * s).round() as u32).clamp(1, bw), ((src.height as f64 * s).round() as u32).clamp(1, bh));
    let small = crate::formats::resize_box(src, w, h);
    let Some(col) = pad else { return small };
    let mut out = Image { width: bw, height: bh, rgba: vec![255; (bw * bh * 4) as usize] };
    for p in out.rgba.chunks_mut(4) {
        p[..3].copy_from_slice(&col);
    }
    let (ox, oy) = ((bw - w) / 2, (bh - h) / 2);
    for y in 0..h {
        let a = (y * w * 4) as usize;
        let b = (((y + oy) * bw + ox) * 4) as usize;
        out.rgba[b..b + (w * 4) as usize].copy_from_slice(&small.rgba[a..a + (w * 4) as usize]);
    }
    out
}

/// The camera's EXIF thumbnail: 160×120, letterboxed in black, 4:2:2 like DCF cameras write it.
pub fn camera_thumbnail(small: &Image) -> Vec<u8> {
    encode_rgba(&fit_box(small, 160, 120, Some([0, 0, 0])), 80, "422")
}

/// Windows XP Explorer thumbnail: longest side 96 px, no padding.
pub fn xp_thumbnail(small: &Image) -> Vec<u8> {
    encode_rgba(&fit_box(small, 96, 96, None), 75, "420")
}

const FREESECT: u32 = 0xFFFF_FFFF;
const ENDOFCHAIN: u32 = 0xFFFF_FFFE;
const FATSECT: u32 = 0xFFFF_FFFD;
const NOSTREAM: u32 = 0xFFFF_FFFF;
const SECTOR: usize = 512;
const MINI: usize = 64;
const CUTOFF: usize = 4096;

fn utf16(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

/// Windows XP Thumbs.db: a Compound File (v3, 512-byte sectors) holding a "Catalog" stream and
/// one stream per picture (named by its index written backwards, as Explorer does) containing a
/// 12-byte header and a JPEG. Small streams live in the mini stream, as the format requires; the
/// file is padded with free sectors up to `min_size` bytes (Thumbs.db files are rarely compact).
/// `items`: (file name, thumbnail JPEG). `filetime`: Windows FILETIME for the catalog.
pub fn thumbs_db(items: &[(String, Vec<u8>)], min_size: usize, filetime: u64) -> Vec<u8> {
    // Streams.
    let mut streams: Vec<(String, Vec<u8>)> = Vec::new();
    let mut cat = Vec::new();
    cat.extend_from_slice(&16u16.to_le_bytes());
    cat.extend_from_slice(&7u16.to_le_bytes());
    cat.extend_from_slice(&(items.len() as u32).to_le_bytes());
    cat.extend_from_slice(&96u32.to_le_bytes());
    cat.extend_from_slice(&96u32.to_le_bytes());
    for (i, (name, jpeg)) in items.iter().enumerate() {
        let idx = i as u32 + 1;
        let n = utf16(name);
        let len = 4 + 4 + 8 + n.len() + 2 + 2;
        cat.extend_from_slice(&(len as u32).to_le_bytes());
        cat.extend_from_slice(&idx.to_le_bytes());
        cat.extend_from_slice(&filetime.to_le_bytes());
        cat.extend_from_slice(&n);
        cat.extend_from_slice(&[0, 0, 0, 0]);
        let mut s = Vec::with_capacity(12 + jpeg.len());
        s.extend_from_slice(&12u32.to_le_bytes());
        s.extend_from_slice(&1u32.to_le_bytes());
        s.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
        s.extend_from_slice(jpeg);
        streams.push((idx.to_string().chars().rev().collect(), s));
    }
    streams.insert(0, ("Catalog".to_string(), cat));

    // Mini stream (small streams) and regular streams.
    let mut mini = Vec::new();
    let mut minifat: Vec<u32> = Vec::new();
    let mut regular: Vec<u8> = Vec::new();
    let mut fat: Vec<u32> = Vec::new();
    let mut start = vec![0u32; streams.len()];
    for (k, (_, data)) in streams.iter().enumerate() {
        if data.is_empty() {
            start[k] = ENDOFCHAIN;
        } else if data.len() < CUTOFF {
            let first = minifat.len() as u32;
            let n = data.len().div_ceil(MINI);
            for j in 0..n {
                minifat.push(if j + 1 < n { first + j as u32 + 1 } else { ENDOFCHAIN });
            }
            mini.extend_from_slice(data);
            mini.resize(minifat.len() * MINI, 0);
            start[k] = first;
        } else {
            let first = fat.len() as u32;
            let n = data.len().div_ceil(SECTOR);
            for j in 0..n {
                fat.push(if j + 1 < n { first + j as u32 + 1 } else { ENDOFCHAIN });
            }
            regular.extend_from_slice(data);
            regular.resize(fat.len() * SECTOR, 0);
            start[k] = first;
        }
    }
    let chain = |fat: &mut Vec<u32>, n: usize| -> u32 {
        if n == 0 {
            return ENDOFCHAIN;
        }
        let first = fat.len() as u32;
        for j in 0..n {
            fat.push(if j + 1 < n { first + j as u32 + 1 } else { ENDOFCHAIN });
        }
        first
    };
    let mini_sectors = mini.len().div_ceil(SECTOR);
    let mini_start = chain(&mut fat, mini_sectors);
    let n_entries = 1 + streams.len();
    let dir_sectors = n_entries.div_ceil(SECTOR / 128);
    let dir_start = chain(&mut fat, dir_sectors);
    let minifat_sectors = minifat.len().div_ceil(SECTOR / 4);
    let minifat_start = chain(&mut fat, minifat_sectors);
    // Free padding, then the FAT itself (at most 109 sectors: no DIFAT needed).
    let used = fat.len();
    let want = (min_size / SECTOR).saturating_sub(1);
    let mut fat_sectors = (used + 1).div_ceil(128);
    let mut pad = 0;
    for _ in 0..4 {
        pad = want.saturating_sub(used + fat_sectors).min((109 * 127usize).saturating_sub(used));
        fat_sectors = (used + pad + fat_sectors).div_ceil(128).max(1);
    }
    fat_sectors = fat_sectors.min(109);
    fat.resize(used + pad, FREESECT);
    let fat_start = fat.len() as u32;
    fat.resize(fat.len() + fat_sectors, FATSECT);
    fat.resize(fat_sectors * 128, FREESECT);

    // Directory (all black; siblings form a right-leaning chain in CFB name order).
    let mut order: Vec<usize> = (0..streams.len()).collect();
    order.sort_by(|&a, &b| {
        let (x, y) = (&streams[a].0, &streams[b].0);
        x.len().cmp(&y.len()).then_with(|| x.to_uppercase().cmp(&y.to_uppercase()))
    });
    let entry = |name: &str, kind: u8, right: u32, child: u32, start: u32, size: u64| -> Vec<u8> {
        let mut e = vec![0u8; 128];
        let n = utf16(name);
        e[..n.len()].copy_from_slice(&n);
        e[64..66].copy_from_slice(&((n.len() + 2) as u16).to_le_bytes());
        e[66] = kind;
        e[67] = 1;
        e[68..72].copy_from_slice(&NOSTREAM.to_le_bytes());
        e[72..76].copy_from_slice(&right.to_le_bytes());
        e[76..80].copy_from_slice(&child.to_le_bytes());
        e[116..120].copy_from_slice(&start.to_le_bytes());
        e[120..128].copy_from_slice(&size.to_le_bytes());
        e
    };
    let mut dir = entry("Root Entry", 5, NOSTREAM, order.first().map(|&k| k as u32 + 1).unwrap_or(NOSTREAM), if mini.is_empty() { ENDOFCHAIN } else { mini_start }, mini.len() as u64);
    let mut right = vec![NOSTREAM; streams.len()];
    for w in order.windows(2) {
        right[w[0]] = w[1] as u32 + 1;
    }
    for (k, (name, data)) in streams.iter().enumerate() {
        dir.extend(entry(name, 2, right[k], NOSTREAM, start[k], data.len() as u64));
    }
    while dir.len() < dir_sectors * SECTOR {
        let mut e = vec![0u8; 128];
        e[68..80].fill(0xFF);
        dir.extend(e);
    }

    // Header.
    let mut out = vec![0u8; SECTOR];
    out[0..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    out[24..26].copy_from_slice(&0x3Eu16.to_le_bytes());
    out[26..28].copy_from_slice(&3u16.to_le_bytes());
    out[28..30].copy_from_slice(&0xFFFEu16.to_le_bytes());
    out[30..32].copy_from_slice(&9u16.to_le_bytes());
    out[32..34].copy_from_slice(&6u16.to_le_bytes());
    out[44..48].copy_from_slice(&(fat_sectors as u32).to_le_bytes());
    out[48..52].copy_from_slice(&dir_start.to_le_bytes());
    out[56..60].copy_from_slice(&(CUTOFF as u32).to_le_bytes());
    out[60..64].copy_from_slice(&(if minifat.is_empty() { ENDOFCHAIN } else { minifat_start }).to_le_bytes());
    out[64..68].copy_from_slice(&(minifat_sectors as u32).to_le_bytes());
    out[68..72].copy_from_slice(&ENDOFCHAIN.to_le_bytes());
    for i in 0..109 {
        let v = if i < fat_sectors { fat_start + i as u32 } else { FREESECT };
        out[76 + i * 4..80 + i * 4].copy_from_slice(&v.to_le_bytes());
    }

    // Sectors in allocation order.
    out.extend_from_slice(&regular);
    out.extend_from_slice(&mini);
    out.resize(SECTOR * (1 + regular.len() / SECTOR + mini_sectors), 0);
    out.extend_from_slice(&dir);
    let mut mf: Vec<u8> = minifat.iter().flat_map(|v| v.to_le_bytes()).collect();
    mf.resize(minifat_sectors * SECTOR, 0xFF);
    out.extend_from_slice(&mf);
    // Free padding sectors: leftovers of whatever the PC had in memory (here: zeros).
    out.resize(out.len() + pad * SECTOR, 0);
    let fb: Vec<u8> = fat.iter().flat_map(|v| v.to_le_bytes()).collect();
    out.extend_from_slice(&fb);
    out
}

/// Parse a Thumbs.db back into (stream name, JPEG) pairs (used by tests and the carver's notes).
pub fn read_thumbs_db(d: &[u8]) -> Vec<(String, Vec<u8>)> {
    let u32at = |o: usize| -> u32 { d.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).unwrap_or(FREESECT) };
    if d.len() < SECTOR || d[0..8] != [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] {
        return Vec::new();
    }
    let sector = |s: u32| -> usize { SECTOR * (s as usize + 1) };
    let nfat = u32at(44) as usize;
    let fat: Vec<u32> = (0..nfat.min(109)).flat_map(|i| (0..128).map(move |j| (i, j))).map(|(i, j)| u32at(sector(u32at(76 + i * 4)) + j * 4)).collect();
    let follow = |first: u32, fat: &[u32]| -> Vec<u32> {
        let mut v = Vec::new();
        let mut s = first;
        while (s as usize) < fat.len() && v.len() < fat.len() {
            v.push(s);
            s = fat[s as usize];
        }
        v
    };
    let read = |first: u32, len: usize| -> Vec<u8> {
        let mut o = Vec::new();
        for s in follow(first, &fat) {
            o.extend_from_slice(d.get(sector(s)..sector(s) + SECTOR).unwrap_or(&[]));
        }
        o.truncate(len);
        o
    };
    let dir_chain = follow(u32at(48), &fat);
    let mut dir = Vec::new();
    for s in dir_chain {
        dir.extend_from_slice(d.get(sector(s)..sector(s) + SECTOR).unwrap_or(&[]));
    }
    let minifat_raw = read(u32at(60), u32at(64) as usize * SECTOR);
    let minifat: Vec<u32> = minifat_raw.chunks_exact(4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let root = dir.get(0..128).map(|e| (u32::from_le_bytes([e[116], e[117], e[118], e[119]]), u32::from_le_bytes([e[120], e[121], e[122], e[123]]) as usize));
    let Some((ms, ml)) = root else { return Vec::new() };
    let mini = read(ms, ml);
    let mut out = Vec::new();
    for e in dir.chunks_exact(128).skip(1) {
        if e[66] != 2 {
            continue;
        }
        let nl = (u16::from_le_bytes([e[64], e[65]]) as usize).saturating_sub(2).min(62);
        let name: String = char::decode_utf16(e[..nl].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]]))).filter_map(|c| c.ok()).collect();
        let first = u32::from_le_bytes([e[116], e[117], e[118], e[119]]);
        let size = u32::from_le_bytes([e[120], e[121], e[122], e[123]]) as usize;
        let data = if size < CUTOFF {
            let mut o = Vec::new();
            for s in follow(first, &minifat) {
                o.extend_from_slice(mini.get(s as usize * MINI..s as usize * MINI + MINI).unwrap_or(&[]));
            }
            o.truncate(size);
            o
        } else {
            read(first, size)
        };
        if name != "Catalog" && data.len() > 12 {
            out.push((name, data[12..].to_vec()));
        }
    }
    out
}
