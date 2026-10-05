use super::*;
use crate::render::{decode, DecodeOpts};

/// A synthetic test photo: gradients, edges and a few colour patches.
pub(crate) fn test_rgba(w: usize, h: usize) -> Vec<u8> {
    let mut v = vec![255u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let ring = (((x as i64 - w as i64 / 2).pow(2) + (y as i64 - h as i64 / 3).pow(2)) as f64).sqrt() as usize;
            v[i] = (x * 255 / w) as u8;
            v[i + 1] = (y * 255 / h) as u8;
            v[i + 2] = if (ring / 12) % 2 == 0 { 200 } else { 40 };
            if x > w * 2 / 3 && y > h / 2 {
                v[i] = 250;
                v[i + 1] = 30;
                v[i + 2] = 30;
            }
        }
    }
    v
}

pub(crate) fn test_jpeg(w: usize, h: usize, sub: &str, progressive: bool) -> Vec<u8> {
    let mut s = encoder::EncodeSettings::standard(80, sub);
    s.progressive = progressive;
    encoder::encode_rgba(w, h, &test_rgba(w, h), &s)
}

fn defaults(info: &StepInfo) -> Value {
    let mut m = serde_json::Map::new();
    for p in &info.params {
        m.insert(p.id.to_string(), p.default.clone());
    }
    Value::Object(m)
}

#[test]
fn every_step_runs_and_is_deterministic() {
    let a = test_jpeg(203, 157, "420", false);
    let b = test_jpeg(160, 120, "444", true);
    let pool = vec![b.clone()];
    let truncated = a[..a.len() * 2 / 3].to_vec();
    for inf in catalog() {
        let p = defaults(&inf);
        for (name, input) in [("clean", &a), ("progressive", &b), ("truncated", &truncated)] {
            let ctx = StepCtx { seed: 7, pool: &pool };
            let r1 = apply(inf.id, &p, input, &ctx).expect("step registered");
            let r2 = apply(inf.id, &p, input, &ctx).unwrap();
            match (&r1, &r2) {
                (Ok(x), Ok(y)) => {
                    assert_eq!(x, y, "{} not deterministic on {}", inf.id, name);
                    // Output must at least be parseable by our forgiving decoder (except steps
                    // whose purpose is to break the header, which may legitimately be unreadable).
                    if !["ransomware_partial", "seven_bit", "byte_swap16", "ftp_ascii"].contains(&inf.id) {
                        assert!(decode(x, &DecodeOpts::default()).is_ok(), "{} output unreadable on {}", inf.id, name);
                    }
                }
                (Err(e), _) => {
                    assert!(name != "clean", "{} failed on clean input: {}", inf.id, e);
                }
                _ => panic!("{} flaky", inf.id),
            }
        }
    }
}

#[test]
fn catalog_ids_match_contract() {
    let ids: Vec<&str> = catalog().iter().map(|i| i.id).collect();
    let want = [
        "requantize", "qtable_decode_swap", "coeff_kill", "coeff_paint", "color_matrix", "channel_drop", "cbcr_swap", "chroma_subsample", "resave",
        "reencode_profile", "encode_like_photo", "progressive_cut", "progressive_drop_dc", "truncate", "bitflip", "byte_delete", "byte_insert",
        "fake_marker", "dc_offset", "restart_markers", "rst_strip_loss", "zero_run", "byte_swap16", "splice", "header_graft", "sof_dims",
        "huffman_swap", "ftp_ascii", "seven_bit", "base64_damage", "interrupted_download", "mms_recompress", "ransomware_partial", "repair_tool",
        "mjpeg_no_dht", "mpf_ghost", "icc_loss", "exif_orientation", "exif_thumb_mismatch", "exif_corrupt", "strip_exif", "sensor_noise",
        "oversharpen", "purple_fringe", "date_stamp", "displace",
    ];
    for w in want {
        assert!(ids.contains(&w), "missing step {w}");
    }
    assert_eq!(ids.len(), want.len());
    for i in catalog() {
        assert!(!i.help.is_empty() && i.help.len() < 400, "{} help", i.id);
    }
}

#[test]
fn coefficient_steps_are_lossless_elsewhere() {
    let a = test_jpeg(96, 64, "420", false);
    let ctx = StepCtx { seed: 1, pool: &[] };
    let out = apply("restart_markers", &serde_json::json!({ "interval": 3 }), &a, &ctx).unwrap().unwrap();
    let x = decode(&a, &DecodeOpts::default()).unwrap();
    let y = decode(&out, &DecodeOpts::default()).unwrap();
    assert_eq!(x.rgba, y.rgba);
    let p = as_progressive(&a).unwrap();
    assert_eq!(decode(&p, &DecodeOpts::default()).unwrap().rgba, x.rgba);
}

#[test]
fn truncation_greys_the_rest() {
    let a = test_jpeg(256, 256, "420", false);
    let t = &a[..a.len() / 2];
    let d = decode(t, &DecodeOpts::default()).unwrap();
    let last = &d.rgba[(255 * 256 + 255) * 4..(255 * 256 + 255) * 4 + 3];
    assert_eq!(last, &[128, 128, 128]);
    assert!(d.events.iter().any(|e| e.kind == "eoi_early" || e.kind == "truncated"));
}

#[test]
fn donor_fill_shows_the_donor_photo() {
    let a = test_jpeg(256, 256, "420", false);
    let t = &a[..a.len() / 2];
    let donor = test_jpeg(128, 128, "444", false);
    let dd = decode(&donor, &DecodeOpts::default()).unwrap();
    let mut o = DecodeOpts::from_json(&serde_json::json!({ "fill": "donor" }));
    o.donor = Some(donor.clone());
    let d = decode(t, &o).unwrap();
    // Bottom-right pixel (255,255) maps to donor pixel (127,127).
    let got = &d.rgba[(255 * 256 + 255) * 4..(255 * 256 + 255) * 4 + 3];
    let want = &dd.rgba[(127 * 128 + 127) * 4..(127 * 128 + 127) * 4 + 3];
    assert_eq!(got, want);
    // Without a donor it falls back to repeating the last good row, never panics.
    let o2 = DecodeOpts::from_json(&serde_json::json!({ "fill": "donor" }));
    assert!(decode(t, &o2).is_ok());
}

#[test]
fn events_carry_position_scan_and_offsets() {
    let mut s = encoder::EncodeSettings::standard(80, "420");
    s.restart_interval = 4;
    let a = encoder::encode_rgba(160, 128, &test_rgba(160, 128), &s);
    // Lose a chunk of scan data in the middle: resync + fill + resume events with positions.
    let mid = a.len() / 2;
    let mut d = a[..mid].to_vec();
    d.extend_from_slice(&a[mid + 300..]);
    let r = decode(&d, &DecodeOpts::default()).unwrap();
    let placed: Vec<_> = r.events.iter().filter(|e| e.mcu >= 0).collect();
    assert!(!placed.is_empty());
    for e in &placed {
        assert_eq!(e.scan, 0);
        assert!(e.x >= 0 && e.y >= 0 && (e.x as usize) < 160 + 16 && (e.y as usize) < 128 + 16, "{e:?}");
        assert!(e.byte > 0 && (e.byte as usize) <= d.len());
    }
    assert!(r.events.iter().any(|e| e.kind == "rst_missing" || e.kind == "resync"));
    let json = serde_json::to_string(&r.events).unwrap();
    assert!(json.contains("\"x\":") && json.contains("\"scan\":"));
}

#[test]
fn invalid_huffman_code_refills_its_17th_bit() {
    // A code that is not in the table consumes 17 bits; the 17th must come from real data when
    // there is any (libjpeg), not be invented as a zero that triggers a grey fill.
    let dc = crate::huffman::HuffSpec::std_dc(false);
    let t = crate::huffman::DecTable::new(&dc);
    // Six zero bytes and two stuffed 0xFF bytes fill the 64-bit buffer; more data follows.
    let data = [0u8, 0, 0, 0, 0, 0, 0xFF, 0x00, 0xFF, 0x00, 0x80, 0, 0];
    let mut r = crate::bits::BitReader::new(&data, 0);
    let mut bad = 0;
    let _ = r.peek(16);
    assert_eq!(r.bits_buffered(), 64);
    let _ = r.get(24);
    let _ = r.get(24);
    // Exactly 16 one-bits remain buffered: not a valid code.
    let v = crate::decoder::huff_for_test(&mut r, &t, &mut bad);
    assert_eq!(v, 0);
    assert_eq!(bad, 1);
    assert!(!r.insufficient, "17th bit should have been read from the data");
}

#[test]
fn fuzz_decoder_never_panics() {
    let seeds = [test_jpeg(120, 90, "420", false), test_jpeg(64, 48, "422", true), {
        let mut s = encoder::EncodeSettings::standard(60, "444");
        s.restart_interval = 2;
        encoder::encode_rgba(80, 40, &test_rgba(80, 40), &s)
    }];
    let mut rng = Pcg32::new(99, 1);
    for round in 0..1500 {
        let mut d = seeds[round % seeds.len()].clone();
        let ops = 1 + rng.below(8);
        for _ in 0..ops {
            if d.is_empty() {
                break;
            }
            let i = rng.below(d.len() as u32) as usize;
            match rng.below(6) {
                0 => d[i] ^= 1 << rng.below(8),
                1 => d[i] = rng.next_u32() as u8,
                2 => {
                    d.remove(i);
                }
                3 => d.insert(i, rng.next_u32() as u8),
                4 => d.truncate(i),
                _ => {
                    d.insert(i, 0xFF);
                    d.insert(i + 1, rng.next_u32() as u8);
                }
            }
        }
        let _ = decode(&d, &DecodeOpts::default());
        let _ = crate::inspect::inspect_json(&d);
        let _ = crate::decoder::parse(&d, true);
    }
    // Absurd dimensions are clamped, not allocated.
    let mut d = seeds[0].clone();
    let l = walk(&d);
    let sof = l.sof().unwrap().offset + 5;
    d[sof..sof + 4].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
    let r = decode(&d, &DecodeOpts::default()).unwrap();
    assert!(r.width * r.height <= crate::decoder::MAX_PIXELS);
}

fn run(id: &str, p: serde_json::Value, input: &[u8], seed: u32, pool: &[Vec<u8>]) -> Vec<u8> {
    let ctx = StepCtx { seed, pool };
    apply(id, &p, input, &ctx).unwrap().unwrap()
}

#[test]
fn header_graft_neutralises_markers_in_the_scan() {
    let a = test_jpeg(640, 480, "420", false);
    let donor = test_jpeg(640, 480, "420", false);
    let pool = vec![donor];
    // Ransomware destroys the header: the body must not carry marker bytes into the scan.
    let enc = run("ransomware_partial", serde_json::json!({ "kb": 4 }), &a, 5, &pool);
    let out = run("header_graft", serde_json::json!({}), &enc, 1, &pool);
    let (s, _) = walk(&out).first_scan_data().unwrap();
    assert!(crate::markers::scan_is_clean(&out, s, out.len()), "stray markers left in the grafted scan");
    let d = decode(&out, &DecodeOpts::default()).unwrap();
    let grey = d.rgba.chunks(4).filter(|p| p[..3].iter().all(|&v| (126..=130).contains(&v))).count();
    assert!(grey * 2 < d.rgba.len() / 4, "grafted ransomware body is mostly grey");
}

#[test]
fn header_graft_skip_counts_from_byte_zero_when_the_header_is_encrypted() {
    let a = test_jpeg(640, 480, "420", false);
    let pool = vec![test_jpeg(640, 480, "420", false)];
    let n = 2usize;
    let enc = run("ransomware_partial", serde_json::json!({ "kb": n }), &a, 3080958776, &pool);
    let out = run("header_graft", serde_json::json!({ "skip": n * 1024 }), &enc, 326471012, &pool);
    let (hdr, _) = super::header::header_of(&pool[0], false).unwrap();
    assert_eq!(out.len(), hdr.len() + enc.len() - n * 1024, "body should be everything after the encrypted part");
}

#[test]
fn header_graft_drops_stray_restart_markers() {
    // A camera-style file without restart markers whose Exif block holds stray FF D7 pairs: the
    // body starts inside the Exif, and one stray restart marker would stop the decoder for good.
    let mut s = encoder::EncodeSettings::standard(80, "420");
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend((0..4000u32).map(|i| if i % 997 == 500 { 0xFF } else if i % 997 == 501 { 0xD7 } else { (i * 7) as u8 }));
    s.segments.push((0xE1, exif));
    let a = encoder::encode_rgba(640, 480, &test_rgba(640, 480), &s);
    let pool = vec![a.clone()];
    let enc = run("ransomware_partial", serde_json::json!({ "kb": 1 }), &a, 3, &pool);
    let out = run("header_graft", serde_json::json!({ "skip": 1024 }), &enc, 4, &pool);
    assert!(grey_fraction(&out) < 0.05, "{:.0}% grey", grey_fraction(&out) * 100.0);
}

#[test]
fn wrong_size_negative_delta_narrows() {
    let a = test_jpeg(160, 120, "420", false);
    let out = run("sof_dims", serde_json::json!({ "width_delta": -16 }), &a, 1, &[]);
    assert_eq!(decode(&out, &DecodeOpts::default()).unwrap().width, 144);
    let info = catalog().into_iter().find(|i| i.id == "sof_dims").unwrap();
    let wd = info.params.iter().find(|p| p.id == "width_delta").unwrap();
    assert!(matches!(wd.kind, ParamKind::Int { min, .. } if min < 0));
}

#[test]
fn ftp_portion_scales_the_damage() {
    let a = test_jpeg(320, 240, "420", false);
    let changed = |portion: f64| {
        let out = run("ftp_ascii", serde_json::json!({ "portion": portion }), &a, 9, &[]);
        out.len() - a.len()
    };
    let (small, full) = (changed(0.1), changed(1.0));
    assert!(full > 0 && small < full, "portion 0.1 added {small} bytes, 1.0 added {full}");
    // portion 1 is the old whole-file behaviour.
    let lf = a.iter().enumerate().filter(|&(i, &b)| b == 0x0A && (i == 0 || a[i - 1] != 0x0D)).count();
    assert_eq!(full, lf);
}

fn grey_fraction(jpeg: &[u8]) -> f64 {
    let d = decode(jpeg, &DecodeOpts::default()).unwrap();
    let grey = d.rgba.chunks(4).filter(|p| p[..3].iter().all(|&v| (126..=130).contains(&v))).count();
    grey as f64 / (d.rgba.len() / 4) as f64
}

#[test]
fn displace_puts_the_seam_where_asked() {
    let a = test_jpeg(640, 480, "420", false);
    let src = parse(&a, false).img.unwrap();
    let gx = src.mcux;
    for seam_x in [0.25, 0.5, 0.8] {
        let p = serde_json::json!({ "shifts": 1, "lost_kb": 4, "seam_x": seam_x, "top_garbage_kb": 0, "natural_cast": false });
        let out = run("displace", p, &a, 3, &[]);
        let img = parse(&out, false).img.unwrap();
        // Find which source MCU landed at output MCU (row 5, col 0): output = source + d.
        let y = |im: &crate::coeffs::CoeffImage, m: usize| im.comps[0].block((m % gx) * 2, (m / gx) * 2).to_vec();
        let at = 5 * gx;
        let got = y(&img, at);
        let m = (0..src.mcux * src.mcuy).find(|&m| y(&src, m) == got).expect("output block comes from the photo");
        let d = at as i64 - m as i64;
        let col = d.rem_euclid(gx as i64);
        let want = (seam_x * gx as f64).round() as i64;
        assert!((col - want).abs() <= 1, "seam at column {col}, asked for {want}");
        assert!(d < 0, "lost data should pull the picture up");
    }
}

#[test]
fn displace_is_deterministic_not_grey_and_clean() {
    let a = test_jpeg(640, 480, "420", false);
    let pool = vec![test_jpeg(640, 480, "420", false), test_jpeg(320, 240, "444", true)];
    for (b, foreign) in [(0.0, 1.0), (0.5, 0.78), (1.0, 0.55)] {
        let p = serde_json::json!({
            "shifts": 1.0 + (2.0 * b as f64).round(), "lost_kb": 2.0 + 30.0 * b, "seam_x": 0.6, "top_garbage_kb": 1.0 + 4.0 * b,
            "foreign_from": foreign, "foreign_photo": -1, "natural_cast": true, "neutralise_markers": true,
        });
        let o1 = run("displace", p.clone(), &a, 11, &pool);
        let o2 = run("displace", p, &a, 11, &pool);
        assert_eq!(o1, o2);
        assert_ne!(o1, a);
        let (s, _) = walk(&o1).first_scan_data().unwrap();
        assert!(crate::markers::scan_is_clean(&o1, s, o1.len() - 2), "stray markers in the scan");
        let g = grey_fraction(&o1);
        assert!(g < 0.2, "b={b}: {:.0}% grey", g * 100.0);
    }
}

#[test]
fn gif_and_avi_roundtrip() {
    let f = test_rgba(32, 24);
    let g = crate::gif::encode(32, 24, &[f.clone(), f.clone()], 10);
    assert!(g.starts_with(b"GIF89a") && g.ends_with(&[0x3B]));
    let j = test_jpeg(32, 24, "420", false);
    let a = crate::avi::write(&[j.clone(), j.clone(), j], 32, 24, 12);
    let i = crate::avi::read(&a);
    assert_eq!(i.frames.len(), 3);
    assert_eq!((i.width, i.height), (32, 24));
    assert!((i.fps - 12.0).abs() < 1e-6);
    let fr = crate::avi::frame(&a, 1).unwrap();
    assert!(decode(&fr, &DecodeOpts::default()).is_ok());
}
