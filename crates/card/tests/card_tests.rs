use refragmenter_card::card::{CameraKind, Card};
use refragmenter_card::carve;
use refragmenter_card::fs::Fs;
use refragmenter_codec::step::{Pcg32, StepCtx};
use serde_json::json;

/// Structurally valid JPEG-shaped file: header segments + entropy-like body (no bare markers) + EOI.
fn fake_jpeg(seed: u64, body_len: usize) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00];
    v.extend((1..=64u8).map(|x| x));
    v.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    v.extend([0xFF, 0xDA, 0x00, 0x0C, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
    let mut r = Pcg32::new(seed, 1);
    while v.len() < body_len {
        let b = r.next_u32() as u8;
        v.push(b);
        if b == 0xFF {
            v.push(0);
        }
    }
    v.extend([0xFF, 0xD9]);
    v
}

fn photos(n: usize, len: usize) -> Vec<Vec<u8>> {
    (0..n).map(|i| fake_jpeg(i as u64 + 1, len + i * 3000)).collect()
}

#[test]
fn delete_by_name_removes_exactly_the_selected_files() {
    let mut card = Card::new(Fs::Fat16, 32, Some(4), CameraKind::Canon2004, photos(4, 50_000), 1);
    card.run_events(&[json!({"type":"shoot","count":4})]);
    let names: Vec<String> = card.files.iter().filter(|f| f.kind != "dir").map(|f| f.name.clone()).collect();
    assert_eq!(names.len(), 4);
    // the 2nd and 4th: neither a run from the start nor from the end
    card.run_events(&[json!({"type":"delete","which":"names","names":[names[1].to_lowercase(), names[3]]})]);
    let gone: Vec<&str> = card.files.iter().filter(|f| f.deleted).map(|f| f.name.as_str()).collect();
    assert_eq!(gone, [names[1].as_str(), names[3].as_str()]);
}

#[test]
fn photorec_recovers_unfragmented_photos_exactly() {
    let ph = photos(4, 200_000);
    let mut card = Card::new(Fs::Fat16, 32, Some(4), CameraKind::Canon2004, ph.clone(), 1);
    card.run_events(&[json!({"type":"shoot","count":4}), json!({"type":"delete","which":"all"})]);
    let rec = carve::photorec(&card);
    let jpgs: Vec<_> = rec.iter().filter(|r| r.name.ends_with(".jpg")).collect();
    assert_eq!(jpgs.len(), 4);
    for (r, p) in jpgs.iter().zip(&ph) {
        assert_eq!(&r.data, p);
    }
}

#[test]
fn fragmented_photo_is_cut_at_neighbours_header() {
    let ph = vec![fake_jpeg(1, 60_000), fake_jpeg(2, 100_000), fake_jpeg(3, 150_000)];
    let mut card = Card::new(Fs::Fat16, 32, Some(4), CameraKind::Canon2004, ph.clone(), 1);
    card.run_events(&[
        json!({"type":"shoot","count":2}),
        json!({"type":"delete","which":"first","count":1}),
        json!({"type":"power_cycle"}),
        json!({"type":"shoot","count":1}),
        json!({"type":"delete","which":"all"}),
    ]);
    let third = card.photo_file(2).unwrap();
    assert!(third.clusters.windows(2).any(|w| w[1] != w[0] + 1), "third photo should be fragmented");
    let rec = carve::photorec(&card);
    let r = rec.iter().find(|r| r.source_clusters[0] == third.clusters[0]).unwrap();
    assert!(r.data.len() < ph[2].len());
    assert!(r.note.starts_with("no end marker"));
}

#[test]
fn exfat_contiguous_undelete_is_perfect_fat32_high_bits_are_lost() {
    let ph = photos(3, 120_000);
    let mut ex = Card::new(Fs::ExFat, 64, Some(32), CameraKind::Phone, ph.clone(), 2);
    ex.run_events(&[json!({"type":"shoot","count":3}), json!({"type":"delete","which":"all"})]);
    let rec = carve::fs_read(&ex, true);
    let got: Vec<_> = rec.iter().filter(|r| r.name.ends_with(".JPG")).collect();
    assert_eq!(got.len(), 3);
    assert!(got.iter().zip(&ph).all(|(r, p)| &r.data == p));

    // FAT32 card large enough that start clusters exceed 16 bits.
    let mut f32 = Card::new(Fs::Fat32, 2048, Some(4), CameraKind::Phone, ph, 3);
    f32.run_events(&[json!({"type":"advance","percent":60}), json!({"type":"shoot","count":1}), json!({"type":"delete","which":"all"})]);
    let rec = carve::fs_read(&f32, true);
    let r = rec.iter().find(|r| r.name.ends_with(".JPG")).unwrap();
    assert_ne!(r.source_clusters.first().copied(), f32.photo_file(0).map(|f| f.clusters[0]));
}

#[test]
fn quick_format_keeps_data_and_graft_rebuilds_headerless_bodies() {
    let ph = photos(3, 300_000);
    let mut card = Card::new(Fs::Fat16, 32, Some(4), CameraKind::Canon2004, ph, 4);
    card.run_events(&[
        json!({"type":"shoot","count":3}),
        json!({"type":"delete","which":"all"}),
        json!({"type":"os_junk","kb":64}),
    ]);
    let rec = carve::carve(&card, "graft", &json!({"min_kb": 32, "piece_kb": 16}));
    assert!(rec.iter().any(|r| r.name.starts_with("orphan_")), "expected rebuilt orphan segments");
    for r in rec.iter().filter(|r| r.name.starts_with("orphan_")) {
        assert_eq!(&r.data[0..2], &[0xFF, 0xD8]);
    }
}

#[test]
fn every_event_type_runs_on_every_fs() {
    for fs in [Fs::Fat16, Fs::Fat32, Fs::ExFat] {
        let mut card = Card::new(fs, 128, None, CameraKind::Canon2004, photos(3, 80_000), 5);
        let events: Vec<_> = refragmenter_card::event_catalog().iter().map(|e| json!({"type": e.id})).collect();
        card.run_events(&events);
        card.run_events(&[json!({"type":"shoot","count":2}), json!({"type":"power_loss","mode":"no_entry"}), json!({"type":"shoot"}), json!({"type":"chkdsk"})]);
        for tool in ["fat", "recuva", "photorec", "graft", "thumbnails"] {
            let _ = carve::carve(&card, tool, &json!({}));
        }
    }
}

/// Real, decodable photos (no EXIF) made with the codec.
fn real_photos(n: usize) -> Vec<Vec<u8>> {
    (0..n)
        .map(|k| {
            let (w, h) = (640u32, 480u32);
            let mut rgba = vec![255u8; (w * h * 4) as usize];
            let mut r = Pcg32::new(k as u64 + 40, 3);
            for y in 0..h {
                for x in 0..w {
                    let i = ((y * w + x) * 4) as usize;
                    rgba[i] = ((x + k as u32 * 50) % 256) as u8;
                    rgba[i + 1] = ((y * 2 + k as u32 * 30) % 256) as u8;
                    rgba[i + 2] = (r.next_u32() & 63) as u8 + if (x / 40 + y / 40) % 2 == 0 { 150 } else { 20 };
                }
            }
            refragmenter_codec::encode_rgba(&refragmenter_codec::Image { width: w, height: h, rgba }, 85, "422")
        })
        .collect()
}

#[test]
fn thumbs_db_holds_real_thumbnails_that_carving_finds() {
    let ph = real_photos(3);
    let mut card = Card::new(Fs::Fat16, 32, Some(4), CameraKind::Canon2004, ph, 6);
    card.run_events(&[json!({"type":"shoot","count":3}), json!({"type":"delete","which":"all"}), json!({"type":"os_junk","kb":64})]);
    // Read Thumbs.db back through the file system and parse the compound file.
    let files = carve::fs_read(&card, false);
    let tdb = files.iter().find(|r| r.name.ends_with("THUMBS.DB")).expect("Thumbs.db written");
    let thumbs = refragmenter_card::thumbs::read_thumbs_db(&tdb.data);
    assert_eq!(thumbs.len(), 3, "one thumbnail per photo shown");
    for (_, j) in &thumbs {
        let img = refragmenter_codec::decode_rgba(j).unwrap();
        // Explorer never upscales: an 80x60 DC preview stays 80x60 (big photos come out 96x72).
        assert!(img.width <= 96 && img.height <= 96 && img.width * 3 == img.height * 4);
    }
    // A thumbnail carver finds them in the raw card bytes.
    let rec = carve::thumbnails(&card);
    let from_db: Vec<_> = rec.iter().filter(|r| r.note.contains("Thumbs.db")).collect();
    assert_eq!(from_db.len(), 3, "{:?}", rec.iter().map(|r| (&r.note, r.size, &r.name)).collect::<Vec<_>>());
    for r in from_db {
        assert!(thumbs.iter().any(|(_, j)| j == &r.data));
    }
}

#[test]
fn camera_adds_exif_thumbnails_and_overwrite_destroys_deleted_photos() {
    let ph = real_photos(4);
    let mut card = Card::new(Fs::Fat16, 32, Some(4), CameraKind::Canon2004, ph.clone(), 7);
    card.camera_thumbs = true;
    card.run_events(&[
        json!({"type":"shoot","count":3}),
        json!({"type":"delete","which":"first","count":1}),
        json!({"type":"overwrite","count":1}),
    ]);
    // Every written photo now carries a 160x120 EXIF thumbnail.
    for p in &card.photos[..3] {
        let (o, l) = refragmenter_card::jpeg::exif_thumbnail(p).expect("EXIF thumbnail");
        let t = refragmenter_codec::decode_rgba(&p[o..o + l]).unwrap();
        assert_eq!((t.width, t.height), (160, 120));
    }
    let victim = card.files.iter().position(|f| f.name == "IMG_0001.JPG").unwrap();
    let newest = card.files.iter().position(|f| f.name == "IMG_0004.JPG").unwrap();
    // The new photo sits on the deleted one's first cluster: overwritten, not just deleted.
    let c0 = card.files[victim].clusters[0] as usize;
    assert_eq!(card.owner[c0], newest as i32);
    assert_eq!(card.state[c0], refragmenter_card::card::ST_OVERWROTE);
    assert!(card.log.iter().any(|l| l.contains("IMG_0004.JPG overwrote") && l.contains("IMG_0001.JPG")));
    // Undelete of the victim now returns the new photo's bytes, not the old photo.
    let rec = carve::fs_read(&card, true);
    let r = rec.iter().find(|r| r.name.contains("~MG_0001") || r.name.ends_with("IMG_0001.JPG")).unwrap();
    assert_ne!(&r.data[..], &card.photos[0][..r.data.len().min(card.photos[0].len())]);
    // EXIF thumbnails of live photos are carvable.
    assert!(carve::thumbnails(&card).iter().any(|r| r.note == "embedded EXIF thumbnail"));
}

#[test]
fn mjpeg_frames_are_carved_with_standard_tables() {
    let ph = real_photos(2);
    let mut card = Card::new(Fs::Fat16, 32, Some(4), CameraKind::Canon2004, ph, 8);
    card.run_events(&[json!({"type":"video","frames":3}), json!({"type":"delete","which":"all"})]);
    let rec = carve::thumbnails(&card);
    let frames: Vec<_> = rec.iter().filter(|r| r.note.starts_with("MJPEG")).collect();
    assert!(!frames.is_empty());
    for f in frames {
        let d = refragmenter_codec::render::decode(&f.data, &refragmenter_codec::render::DecodeOpts::default()).unwrap();
        assert_eq!((d.width, d.height), (640, 480));
        assert!(!d.events.iter().any(|e| e.kind == "header_repaired"), "DHT should already be inserted");
    }
}

/// 640x480 photos of about 95 KB (noisier than `real_photos`).
fn big_photos(n: usize) -> Vec<Vec<u8>> {
    (0..n)
        .map(|k| {
            let (w, h) = (640u32, 480u32);
            let mut rgba = vec![255u8; (w * h * 4) as usize];
            let mut r = Pcg32::new(k as u64 + 70, 3);
            for y in 0..h {
                for x in 0..w {
                    let i = ((y * w + x) * 4) as usize;
                    let checker = if (x / 40 + y / 40 + k as u32) % 2 == 0 { 140 } else { 20 };
                    rgba[i] = ((x + k as u32 * 50) % 256) as u8;
                    rgba[i + 1] = ((y * 2 + k as u32 * 30) % 256) as u8 / 2 + (r.next_u32() & 31) as u8;
                    rgba[i + 2] = (r.next_u32() & 63) as u8 + checker;
                }
            }
            refragmenter_codec::encode_rgba(&refragmenter_codec::Image { width: w, height: h, rgba }, 85, "420")
        })
        .collect()
}

/// Fraction of 8x8 blocks that are flat grey (every channel within +-2 of 128).
fn grey_fraction(jpeg: &[u8]) -> f64 {
    let Ok(img) = refragmenter_codec::decode_rgba(jpeg) else { return 1.0 };
    let (w, h) = (img.width as usize, img.height as usize);
    let (mut grey, mut total) = (0usize, 0usize);
    for by in 0..h / 8 {
        for bx in 0..w / 8 {
            total += 1;
            let flat = (0..64).all(|k| {
                let i = ((by * 8 + k / 8) * w + bx * 8 + k % 8) * 4;
                img.rgba[i..i + 3].iter().all(|&v| (126..=130).contains(&v))
            });
            grey += flat as usize;
        }
    }
    grey as f64 / total.max(1) as f64
}

#[test]
fn photorec_pass_through_is_damaged_not_grey() {
    let ph = big_photos(4);
    for sc in ["junk_overwrite", "fragmented", "burst", "power_loss", "pc_reformat"] {
        for sev in [1, 3, 5, 8] {
            let ctx = StepCtx { seed: 11, pool: &ph[1..] };
            let p = json!({"scenario": sc, "tool": "photorec", "severity": sev});
            let out = refragmenter_card::apply_step("pass_through_card", &p, &ph[0], &ctx).unwrap().unwrap();
            let g = grey_fraction(&out);
            assert!(g < 0.2, "{sc} severity {sev}: {:.0}% grey", g * 100.0);
            if sev == 1 {
                assert!(g < 0.05, "{sc} severity 1 should be mostly intact: {:.0}% grey", g * 100.0);
            }
        }
    }
}

#[test]
fn junk_overwrite_scales_with_a_small_photo() {
    // A small photo (a few clusters) is damaged, not wiped: junk is relative to its size.
    let small: Vec<Vec<u8>> = (0..4)
        .map(|k| {
            let (w, h) = (320u32, 240u32);
            let mut rgba = vec![0u8; (w * h * 4) as usize];
            for (i, px) in rgba.chunks_mut(4).enumerate() {
                let (x, y) = (i as u32 % w, i as u32 / w);
                px.copy_from_slice(&[(x + k * 40) as u8, (y * 3) as u8, ((x ^ y) & 0xFF) as u8, 255]);
            }
            refragmenter_codec::encode_rgba(&refragmenter_codec::Image { width: w, height: h, rgba }, 90, "420")
        })
        .collect();
    let ctx = StepCtx { seed: 3, pool: &small[1..] };
    for sev in [1, 5, 8] {
        let p = json!({"scenario": "junk_overwrite", "severity": sev});
        let out = refragmenter_card::apply_step("pass_through_card", &p, &small[0], &ctx).unwrap().unwrap();
        assert_eq!(&out[0..2], &[0xFF, 0xD8]);
        let g = grey_fraction(&out);
        assert!(g < 0.5, "severity {sev}: small photo mostly grey ({:.0}%)", g * 100.0);
    }
}

/// Diagnostic: grey % / output size for every scenario x tool x severity.
#[test]
#[ignore]
fn sweep_pass_through_card() {
    let ph = big_photos(4);
    eprintln!("photo size {} KB", ph[0].len() / 1024);
    for tool in ["photorec", "graft", "recuva", "fat"] {
        for sc in ["junk_overwrite", "fragmented", "burst", "pc_reformat", "power_loss", "flash_failure", "fat32_undelete"] {
            let mut line = format!("{tool:9} {sc:15}");
            for sev in [1, 3, 5, 8, 10] {
                let ctx = StepCtx { seed: 11, pool: &ph[1..] };
                let p = json!({"scenario": sc, "tool": tool, "severity": sev});
                let out = refragmenter_card::apply_step("pass_through_card", &p, &ph[0], &ctx).unwrap().unwrap();
                line += &format!(" {:3.0}%/{:3}K{}", grey_fraction(&out) * 100.0, out.len() / 1024, if out == ph[0] { "=" } else { " " });
            }
            eprintln!("{line}");
        }
    }
}

#[test]
fn steps_are_deterministic_and_return_jpeg_shaped_bytes() {
    let input = fake_jpeg(9, 150_000);
    let pool = vec![fake_jpeg(10, 140_000), fake_jpeg(11, 160_000), fake_jpeg(12, 130_000)];
    for info in refragmenter_card::catalog() {
        let p = json!({});
        let ctx = StepCtx { seed: 7, pool: &pool };
        let a = refragmenter_card::apply_step(info.id, &p, &input, &ctx).unwrap().unwrap();
        let b = refragmenter_card::apply_step(info.id, &p, &input, &ctx).unwrap().unwrap();
        assert_eq!(a, b, "{} not deterministic", info.id);
        assert_eq!(&a[0..2], &[0xFF, 0xD8], "{} lost SOI", info.id);
        assert!(!info.help.is_empty());
    }
}

// Audit B1 (11-1): chkdsk after a format used to revive the old lost chains and index past the
// new, smaller cluster table.
#[test]
fn chkdsk_after_a_format_ignores_chains_lost_before_it() {
    for format in [json!({"type":"reformat_pc","fs":"fat32","cluster_kb":256}), json!({"type":"quick_format"})] {
        let mut c = Card::new(Fs::Fat32, 64, Some(4), CameraKind::Canon2004, photos(4, 90_000), 1);
        c.run_events(&[
            json!({"type":"shoot","count":6}),
            json!({"type":"power_loss","mode":"no_entry"}),
            json!({"type":"shoot","count":1}),
            format.clone(),
            json!({"type":"chkdsk"}),
        ]);
        assert!(c.files.iter().all(|f| f.kind != "chk"), "{format}: a pre-format chain came back");
        assert_eq!(c.log.last().map(String::as_str), Some("chkdsk: no errors found."), "{format}");
    }
}

// Audit B1 (11-2): creating a folder on a full card used to panic.
#[test]
fn a_full_card_logs_instead_of_panicking() {
    let mut c = Card::new(Fs::Fat32, 8, Some(32), CameraKind::Canon2004, photos(3, 60_000), 1);
    c.run_events(&[
        json!({"type":"advance","percent":99}),
        json!({"type":"advance","percent":99}),
        json!({"type":"advance","percent":99}),
        json!({"type":"shoot","count":1}),
        json!({"type":"shoot","count":200}),
        json!({"type":"os_junk","kb":64}),
        json!({"type":"chkdsk"}),
    ]);
    assert!(c.log.iter().any(|l| l.contains("full")), "{:?}", c.log);
}

// Audit B1 (11-20): a 64 GB card with 1 KB clusters used to need 64 M clusters of bookkeeping.
#[test]
fn a_huge_card_with_tiny_clusters_gets_bigger_clusters() {
    let c = Card::new(Fs::ExFat, 65536, Some(1), CameraKind::Canon2004, photos(1, 50_000), 1);
    assert!(c.vol.cluster_count <= 1 << 22, "{} clusters", c.vol.cluster_count);
    assert!(c.log.iter().any(|l| l.contains("too many")), "{:?}", c.log);
}

// Audit B1 (11-3): a donor photo with no data after its header made recuva_contiguous loop forever.
#[test]
fn recuva_contiguous_rejects_a_donor_without_picture_data() {
    let mut header_only = fake_jpeg(5, 0);
    header_only.truncate(header_only.len() - 2);
    let input = fake_jpeg(6, 100_000);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let pool = vec![header_only];
        let ctx = StepCtx { seed: 1, pool: &pool };
        let _ = tx.send(refragmenter_card::apply_step("recuva_contiguous", &json!({}), &input, &ctx).map(|r| r.is_err()));
    });
    let r = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("recuva_contiguous hung");
    assert_eq!(r, Some(true), "an empty donor body should be an error");
}
