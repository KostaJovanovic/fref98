//! The tolerant decoder against hostile files (code audit 2026-10, batch B1). Each input is built
//! here from a few bytes; before the fixes they allocated gigabytes, ran for minutes, overflowed or
//! decoded the wrong data.
use refragmenter_codec::decoder::MAX_PIXELS;
use refragmenter_codec::encoder::{encode_rgba, EncodeSettings};
use refragmenter_codec::render::{decode, DecodeOpts, Decoded};
use std::time::{Duration, Instant};

const SOI: [u8; 2] = [0xFF, 0xD8];
const EOI: [u8; 2] = [0xFF, 0xD9];

fn seg(m: u8, p: &[u8]) -> Vec<u8> {
    let n = (p.len() + 2) as u16;
    [vec![0xFF, m], n.to_be_bytes().to_vec(), p.to_vec()].concat()
}

fn sof(m: u8, w: u16, h: u16, comps: &[(u8, u8, u8)]) -> Vec<u8> {
    let mut p = vec![8];
    p.extend(h.to_be_bytes());
    p.extend(w.to_be_bytes());
    p.push(comps.len() as u8);
    for &(id, hv, tq) in comps {
        p.extend([id, hv, tq]);
    }
    seg(m, &p)
}

fn sos(comps: &[(u8, u8)], ss: u8, se: u8, ah: u8, al: u8) -> Vec<u8> {
    let mut p = vec![comps.len() as u8];
    for &(id, t) in comps {
        p.extend([id, t]);
    }
    p.extend([ss, se, (ah << 4) | al]);
    seg(0xDA, &p)
}

fn dec(d: &[u8]) -> Decoded {
    decode(d, &DecodeOpts::default()).expect("decodes")
}

fn photo() -> Vec<u8> {
    let (w, h) = (96, 64);
    let mut rgba = vec![255u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            rgba[i] = (x * 255 / w) as u8;
            rgba[i + 1] = (y * 255 / h) as u8;
            rgba[i + 2] = if (x / 16 + y / 16) % 2 == 0 { 220 } else { 30 };
        }
    }
    encode_rgba(w, h, &rgba, &EncodeSettings::standard(85, "420"))
}

fn mean_diff(a: &Decoded, b: &Decoded) -> f64 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    a.rgba.iter().zip(&b.rgba).map(|(&x, &y)| (x as f64 - y as f64).abs()).sum::<f64>() / a.rgba.len() as f64
}

/// Offset just past the first segment with marker `m`.
fn after_segment(d: &[u8], m: u8) -> usize {
    let i = d.windows(2).position(|w| w == [0xFF, m]).expect("segment present");
    i + 2 + u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize
}

// 08-1: a 39-byte header claiming 65535x65535 stays inside the pixel cap, at its real width.
#[test]
fn a_huge_frame_is_capped_by_pixels_and_keeps_its_width() {
    let c3 = [(1, 0x11, 0), (2, 0x11, 0), (3, 0x11, 0)];
    let f = [SOI.to_vec(), sof(0xC2, 65535, 65535, &c3), sos(&[(1, 0), (2, 0), (3, 0)], 0, 0, 0, 0), vec![0, 0], EOI.to_vec()].concat();
    assert!(f.len() < 64);
    let d = dec(&f);
    assert_eq!(d.width, 65535, "the width must not be clamped (that re-wraps every row)");
    assert!(d.width * d.height <= MAX_PIXELS);
}

// 08-2: thousands of empty progressive scans used to take minutes.
#[test]
fn thousands_of_empty_scans_finish_quickly() {
    let body: Vec<u8> = (0..20_000).flat_map(|_| sos(&[(1, 0)], 0, 0, 0, 0)).collect();
    let f = [SOI.to_vec(), sof(0xC2, 2048, 2048, &[(1, 0x11, 0)]), body, EOI.to_vec()].concat();
    let t = Instant::now();
    dec(&f);
    assert!(t.elapsed() < Duration::from_secs(20), "took {:?}", t.elapsed());
    let scans = refragmenter_codec::decoder::parse(&f, false).meta.scans.len();
    assert!(scans <= 1001, "{scans} scans decoded");
}

// 08-3: padding between header segments must be skipped, not decoded as picture data.
#[test]
fn padding_between_header_segments_is_skipped() {
    let clean = photo();
    let at = after_segment(&clean, 0xC0);
    for pad in [60usize, 100, 1000] {
        let mut f = clean[..at].to_vec();
        f.extend(std::iter::repeat_n(0u8, pad));
        f.extend_from_slice(&clean[at..]);
        let diff = mean_diff(&dec(&f), &dec(&clean));
        assert!(diff < 0.5, "{pad} padding bytes changed the picture (mean diff {diff:.1})");
    }
}

// 08-4: a 16-bit DQT of 0xFFFF with maximal coefficients overflowed a u32 sum.
#[test]
fn maximal_coefficients_do_not_overflow() {
    let dqt = seg(0xDB, &[[0x10u8].as_slice(), &[0xFF; 128]].concat());
    let dc = seg(0xC4, &[[0x00u8, 1].as_slice(), &[0; 15], &[0]].concat());
    let ac = seg(0xC4, &[[0x10u8, 1].as_slice(), &[0; 15], &[0x0F]].concat());
    let f = [SOI.to_vec(), dqt, sof(0xC0, 8, 8, &[(1, 0x11, 0)]), dc, ac, sos(&[(1, 0)], 0, 63, 0, 0), vec![0; 200], EOI.to_vec()].concat();
    let d = dec(&f);
    assert_eq!((d.width, d.height), (8, 8));
}

// 08-7: every component called 1 (in the frame and the scan) must still decode the colour scan.
#[test]
fn duplicate_component_ids_are_matched_by_position() {
    let clean = photo();
    let mut f = clean.clone();
    let s = clean.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
    for k in 0..3 {
        f[s + 10 + 3 * k] = 1;
    }
    let q = clean.windows(2).position(|w| w == [0xFF, 0xDA]).unwrap();
    for k in 0..3 {
        f[q + 5 + 2 * k] = 1;
    }
    let diff = mean_diff(&dec(&f), &dec(&clean));
    assert!(diff < 0.5, "mean diff {diff:.1}");
}

// 08-12: a stray scan header before the frame must not hide the real scan that follows.
#[test]
fn a_scan_before_the_frame_does_not_count_as_the_scan() {
    let clean = photo();
    let stray = [sos(&[(1, 0)], 0, 63, 0, 0), vec![0x12, 0x34]].concat();
    let f = [&clean[..2], &stray, &clean[2..]].concat();
    let diff = mean_diff(&dec(&f), &dec(&clean));
    assert!(diff < 0.5, "mean diff {diff:.1}");
}
