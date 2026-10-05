//! File-system structures read back the way real drivers read them (audit B4): the BPB of every FAT
//! geometry, and an exFAT walk ported from tests/tools/exfat_check.py with the checks it lacked
//! (DataLength, directory lengths, bitmap, PercentInUse, name hashes).

use refragmenter_card::card::{CameraKind, Card};
use refragmenter_card::carve::{self, Undelete};
use refragmenter_card::fs::Fs;
use refragmenter_codec::step::Pcg32;
use serde_json::json;

fn u16le(b: &[u8], o: usize) -> u64 {
    u16::from_le_bytes([b[o], b[o + 1]]) as u64
}
fn u32le(b: &[u8], o: usize) -> u64 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) as u64
}
fn u64le(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

fn fake_jpeg(seed: u64, body_len: usize) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00];
    v.extend(1..=64u8);
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

/// The FAT type a driver sees (Microsoft's rule: by cluster count only), and the count.
fn fat_type_from_bpb(c: &Card) -> (&'static str, u64) {
    let b = c.img.read_vec(0, 512);
    assert_eq!(&b[510..512], &[0x55, 0xAA]);
    assert_eq!(u16le(&b, 11), 512);
    let spc = b[13] as u64;
    assert!(spc.is_power_of_two() && spc <= 128, "sectors per cluster {spc}");
    assert_eq!(spc * 512, c.vol.cluster_bytes);
    let (rsvd, nfats, root_ent) = (u16le(&b, 14), b[16] as u64, u16le(&b, 17));
    let (tot16, fatsz16, tot32, fatsz32) = (u16le(&b, 19), u16le(&b, 22), u32le(&b, 32), u32le(&b, 36));
    let tot = if tot16 != 0 { tot16 } else { tot32 };
    assert_eq!(tot, c.img.size / 512);
    let fatsz = if fatsz16 != 0 { fatsz16 } else { fatsz32 };
    let count = (tot - (rsvd + nfats * fatsz + (root_ent * 32).div_ceil(512))) / spc;
    let ty = if count < 4085 {
        "fat12"
    } else if count < 65525 {
        "fat16"
    } else {
        "fat32"
    };
    if ty == "fat32" {
        assert_eq!((tot16, fatsz16, root_ent), (0, 0, 0), "FAT32 must use the 32-bit fields only");
        assert!(fatsz * 512 / 4 >= count + 2, "FAT too small");
    }
    (ty, count)
}

// 11-8 + 11-9: many geometries (the UI's FAT32 512 MB / 32 KB, FAT16 8 MB, FAT32 1 GB by default, FAT16
// 4 GB, 128 KB or 3 KB clusters) wrote boot sectors that real drivers read as another FAT type.
#[test]
fn every_fat_card_is_the_type_its_boot_sector_says() {
    for fs in [Fs::Fat16, Fs::Fat32] {
        for mb in [8u64, 16, 33, 64, 300, 512, 1024, 4096, 8192] {
            for ckb in [None, Some(1), Some(3), Some(4), Some(32), Some(128)] {
                let c = Card::new(fs, mb, ckb, CameraKind::Canon2004, vec![], 1);
                let (ty, count) = fat_type_from_bpb(&c);
                assert_eq!(ty, c.vol.fs.name(), "{fs:?} {mb} MB {ckb:?} KB: the boot sector says {ty}");
                assert_eq!(count, c.vol.cluster_count as u64, "{fs:?} {mb} MB {ckb:?}");
                if c.vol.fs != fs {
                    assert!(c.log.iter().any(|l| l.contains("instead")), "{fs:?} {mb} MB: changed type without saying so");
                }
            }
        }
    }
    // the UI's custom default is FAT32 and stays FAT32, with smaller clusters
    let c = Card::new(Fs::Fat32, 512, Some(32), CameraKind::Canon2004, vec![], 1);
    assert_eq!(c.vol.fs, Fs::Fat32);
    assert!(c.log.iter().any(|l| l.contains("32 KB clusters")), "{:?}", c.log);
}

#[test]
fn a_reformat_also_makes_a_valid_card() {
    let mut c = Card::new(Fs::Fat16, 64, Some(8), CameraKind::Canon2004, photos(2, 40_000), 1);
    c.run_events(&[json!({"type":"shoot","count":2}), json!({"type":"reformat_pc","fs":"fat32","cluster_kb":4})]);
    let (ty, _) = fat_type_from_bpb(&c);
    assert_eq!(ty, c.vol.fs.name());
}

fn checksum32(data: &[u8], skip: &[usize]) -> u32 {
    let mut c = 0u32;
    for (i, &x) in data.iter().enumerate() {
        if !skip.contains(&i) {
            c = c.rotate_right(1).wrapping_add(x as u32);
        }
    }
    c
}

fn checksum16(set: &[u8]) -> u16 {
    let mut c = 0u16;
    for (i, &x) in set.iter().enumerate() {
        if i != 2 && i != 3 {
            c = c.rotate_right(1).wrapping_add(x as u16);
        }
    }
    c
}

fn name_hash(units: &[u16]) -> u16 {
    let mut h = 0u16;
    for &u in units {
        let u = if (b'a' as u16..=b'z' as u16).contains(&u) { u - 32 } else { u };
        for b in u.to_le_bytes() {
            h = h.rotate_right(1).wrapping_add(b as u16);
        }
    }
    h
}

struct ExFat<'a> {
    c: &'a Card,
    heap: u64,
    cb: u64,
    fat_off: u64,
}

impl ExFat<'_> {
    fn coff(&self, cl: u64) -> u64 {
        self.heap * 512 + (cl - 2) * self.cb
    }
    fn fat(&self, cl: u64) -> u64 {
        u32le(&self.c.img.read_vec(self.fat_off * 512 + cl * 4, 4), 0)
    }
    fn chain(&self, mut cl: u64) -> Vec<u64> {
        let mut out = Vec::new();
        while (2..self.c.vol.cluster_count as u64 + 2).contains(&cl) && out.len() < 100_000 {
            out.push(cl);
            cl = self.fat(cl);
        }
        out
    }
    /// A directory's bytes as a driver reads them: `len` bytes (None: the whole FAT chain, for the root).
    fn dir_bytes(&self, first: u64, len: Option<u64>, nofat: bool) -> Vec<u8> {
        let mut data = Vec::new();
        if nofat {
            data = self.c.img.read_vec(self.coff(first), len.unwrap() as usize);
        } else {
            for cl in self.chain(first) {
                data.extend(self.c.img.read_vec(self.coff(cl), self.cb as usize));
            }
            if let Some(l) = len {
                data.truncate(l as usize);
            }
        }
        data
    }
    /// Walks every live directory; returns the live files' names.
    fn walk(&self, first: u64, len: Option<u64>, nofat: bool, files: &mut Vec<String>, bitmap: &mut Option<u64>) {
        let d = self.dir_bytes(first, len, nofat);
        let mut i = 0;
        while i + 32 <= d.len() {
            let t = d[i];
            if t == 0 {
                break;
            }
            if t == 0x81 {
                *bitmap = Some(u32le(&d, i + 20));
            } else if t == 0x82 {
                let (cs, ucl, ulen) = (u32le(&d, i + 4) as u32, u32le(&d, i + 20), u64le(&d, i + 24));
                assert_eq!(checksum32(&self.c.img.read_vec(self.coff(ucl), ulen as usize), &[]), cs, "upcase checksum");
            } else if t & 0x7F == 0x05 {
                let sec = d[i + 1] as usize;
                let s = &d[i..(i + 32 * (sec + 1)).min(d.len())];
                assert_eq!(s.len(), 32 * (sec + 1), "entry set cut off by the directory's length");
                if t == 0x85 {
                    assert_eq!(checksum16(s), u16le(s, 2) as u16, "entry set checksum");
                    let st = &s[32..64];
                    let nlen = st[3] as usize;
                    let units: Vec<u16> = (0..sec - 1).flat_map(|k| (0..15).map(move |j| (k, j))).map(|(k, j)| u16le(s, 64 + 32 * k + 2 + 2 * j) as u16).take(nlen).collect();
                    assert_eq!(name_hash(&units), u16le(st, 4) as u16, "name hash");
                    let name = String::from_utf16_lossy(&units);
                    let (vdl, first, dlen) = (u64le(st, 8), u32le(st, 20), u64le(st, 24));
                    let nofat = st[1] & 2 != 0;
                    assert_eq!(vdl, dlen, "{name}: ValidDataLength != DataLength");
                    if u16le(s, 4) & 0x10 != 0 {
                        let clusters = if nofat { dlen.div_ceil(self.cb) } else { self.chain(first).len() as u64 };
                        assert_eq!(dlen, clusters * self.cb, "{name}: directory length doesn't cover its clusters");
                        self.walk(first, Some(dlen), nofat, files, bitmap);
                    } else {
                        files.push(name);
                    }
                }
                i += 32 * sec;
            }
            i += 32;
        }
    }
}

/// exfat_check.py, ported, plus what it didn't look at.
fn check_exfat(c: &Card) -> Vec<String> {
    let b = c.img.read_vec(0, 512);
    assert_eq!(&b[3..11], b"EXFAT   ");
    assert!(b[11..64].iter().all(|&x| x == 0), "MustBeZero");
    let (fat_off, heap, count, root) = (u32le(&b, 80), u32le(&b, 88), u32le(&b, 92), u32le(&b, 96));
    let cb = (1u64 << b[108]) << b[109];
    assert_eq!(cb, c.vol.cluster_bytes, "cluster size shift");
    assert_eq!(count, c.vol.cluster_count as u64);
    let region = c.img.read_vec(0, 11 * 512);
    assert_eq!(checksum32(&region, &[106, 107, 112]) as u64, u32le(&c.img.read_vec(11 * 512, 4), 0), "boot checksum");
    assert_eq!(c.img.read_vec(12 * 512, 11 * 512 + 4), c.img.read_vec(0, 11 * 512 + 4), "backup boot region");
    let used = (2..count as usize + 2).filter(|&k| c.vol.in_use[k]).count() as u64;
    assert_eq!(b[112] as u64, used * 100 / count, "PercentInUse");
    let x = ExFat { c, heap, cb, fat_off };
    let (mut files, mut bitmap) = (Vec::new(), None);
    x.walk(root, None, false, &mut files, &mut bitmap);
    let bm = c.img.read_vec(x.coff(bitmap.expect("bitmap entry")), count.div_ceil(8) as usize);
    for k in 0..count as usize {
        assert_eq!(bm[k / 8] >> (k % 8) & 1 == 1, c.vol.in_use[k + 2], "bitmap bit of cluster {}", k + 2);
    }
    files
}

// 11-10 + 11-11: DataLength was rounded up to whole clusters, and a directory that grew past one cluster
// kept a one-cluster length, so real drivers saw ~42 of 60 photos (4 KB clusters).
#[test]
fn exfat_reads_back_like_a_real_driver_reads_it() {
    let mut c = Card::new(Fs::ExFat, 64, Some(4), CameraKind::Canon2004, photos(60, 6_000), 1);
    c.run_events(&[json!({"type":"shoot","count":60}), json!({"type":"delete","which":"first","count":5}), json!({"type":"shoot","count":3})]);
    let seen = check_exfat(&c);
    for f in c.files.iter().filter(|f| !f.deleted) {
        assert!(seen.contains(&f.name), "{} is invisible to a real driver", f.name);
    }
}

// 11-8: a 3 KB request on exFAT wrote a shift that means 1 KB clusters
#[test]
fn exfat_cluster_shift_matches_odd_requests() {
    for ckb in [3u64, 24, 96] {
        let mut c = Card::new(Fs::ExFat, 128, Some(ckb), CameraKind::Phone, photos(3, 40_000), 1);
        c.run_events(&[json!({"type":"shoot","count":3})]);
        assert!(c.vol.cluster_bytes.is_power_of_two());
        check_exfat(&c);
    }
}

// 11-22: FSInfo went stale after burst and advance
#[test]
fn fsinfo_free_count_is_current_after_every_event() {
    let mut c = Card::new(Fs::Fat32, 300, Some(4), CameraKind::Canon2004, photos(6, 50_000), 1);
    c.run_events(&[json!({"type":"advance","percent":20}), json!({"type":"burst","count":3,"period":2})]);
    let fsinfo = c.img.read_vec(512, 512);
    assert_eq!(u32le(&fsinfo, 488), c.vol.free_clusters() as u64);
    let mut e = Card::new(Fs::ExFat, 300, Some(32), CameraKind::Phone, photos(6, 50_000), 1);
    e.run_events(&[json!({"type":"advance","percent":40}), json!({"type":"burst","count":3})]);
    check_exfat(&e);
}

// 11-22: every chkdsk made another FOUND.000 and every PC visit another SYSTEM~1
#[test]
fn chkdsk_uses_the_next_found_folder_and_the_pc_reuses_its_folder() {
    let mut c = Card::new(Fs::Fat16, 64, Some(4), CameraKind::Canon2004, photos(6, 40_000), 1);
    let lose = [json!({"type":"shoot","count":1}), json!({"type":"power_loss","mode":"no_entry"}), json!({"type":"shoot","count":1}), json!({"type":"chkdsk"})];
    c.run_events(&lose);
    c.run_events(&lose);
    c.run_events(&[json!({"type":"os_junk","kb":16}), json!({"type":"os_junk","kb":16})]);
    let root: Vec<String> = c.vol.read_dir(&c.img, c.vol.root()).into_iter().filter(|e| e.is_dir && !e.deleted).map(|e| e.name).collect();
    assert_eq!(root.iter().filter(|n| *n == "FOUND.000").count(), 1, "{root:?}");
    assert_eq!(root.iter().filter(|n| *n == "FOUND.001").count(), 1, "{root:?}");
    assert_eq!(root.iter().filter(|n| *n == "SYSTEM~1").count(), 1, "{root:?}");
}

// 11-22: on a full card the entry kept the whole size although only part of the file fit
#[test]
fn a_file_cut_short_by_a_full_card_has_the_size_that_fit() {
    let mut c = Card::new(Fs::Fat16, 8, Some(4), CameraKind::Canon2004, photos(1, 600_000), 1);
    c.run_events(&[json!({"type":"advance","percent":95}), json!({"type":"shoot","count":1})]);
    let f = c.files.iter().find(|f| f.kind == "photo").expect("a partial photo");
    assert!(f.size <= f.clusters.len() as u64 * c.vol.cluster_bytes);
    let e = c.vol.read_dir(&c.img, f.dir).into_iter().find(|e| e.name == f.name).unwrap();
    assert_eq!(e.size, f.size);
}

// 11-12: "advance" on exFAT left a fragmented chain with neither a FAT chain nor NoFatChain
#[test]
fn exfat_advance_links_a_fragmented_chain() {
    let mut c = Card::new(Fs::ExFat, 64, Some(4), CameraKind::Phone, photos(3, 40_000), 1);
    c.run_events(&[
        json!({"type":"shoot","count":3}),
        json!({"type":"delete","which":"first","count":1}),
        json!({"type":"power_cycle"}),
        json!({"type":"advance","percent":30}),
    ]);
    check_exfat(&c);
    let rec = carve::fs_read(&c, Undelete::None);
    let old = rec.iter().find(|r| r.name.ends_with("OLDSHOTS.DAT")).unwrap();
    assert!(old.source_clusters.windows(2).any(|w| w[1] != w[0] + 1), "advance should be fragmented here");
    assert_eq!(old.data.len(), old.source_clusters.len() * c.vol.cluster_bytes as usize);
}

// 11-13: fat_glitch claimed cross-links on exFAT, where camera files have no FAT chain to damage
#[test]
fn fat_glitch_on_exfat_says_it_has_no_effect() {
    let mut c = Card::new(Fs::ExFat, 64, Some(4), CameraKind::Phone, photos(3, 40_000), 1);
    c.run_events(&[json!({"type":"shoot","count":3}), json!({"type":"fat_glitch","count":2})]);
    assert!(c.log.last().unwrap().contains("no effect"), "{:?}", c.log);
    let before: Vec<_> = carve::fs_read(&c, Undelete::None).into_iter().map(|r| r.data).collect();
    let mut d = Card::new(Fs::ExFat, 64, Some(4), CameraKind::Phone, photos(3, 40_000), 1);
    d.run_events(&[json!({"type":"shoot","count":3})]);
    assert_eq!(before, carve::fs_read(&d, Undelete::None).into_iter().map(|r| r.data).collect::<Vec<_>>());
}

// 11-15: a header 4 KB+ into a cluster (old file after a reformat to bigger clusters) was skipped
// because the cluster's first 4 KB page was blank
#[test]
fn photorec_finds_a_header_past_a_blank_first_page() {
    let ph = fake_jpeg(3, 30_000);
    let mut c = Card::new(Fs::Fat16, 128, Some(16), CameraKind::Canon2004, vec![], 1);
    assert_eq!(c.vol.cluster_bytes, 16384);
    let off = c.vol.cluster_offset(40) + 8192;
    c.img.write(off, &ph);
    let rec = carve::photorec(&c);
    assert!(rec.iter().any(|r| r.data == ph), "{:?}", rec.iter().map(|r| (&r.name, r.size)).collect::<Vec<_>>());
}

// 11-23: an SOI split across a cluster boundary was missed by the thumbnail carver
#[test]
fn thumbnail_split_across_clusters_is_found() {
    let t = fake_jpeg(4, 6_000);
    let mut c = Card::new(Fs::Fat16, 64, Some(4), CameraKind::Canon2004, vec![], 1);
    for skew in [1u64, 2] {
        let off = c.vol.cluster_offset(60 + skew as u32 * 10) - skew;
        c.img.write(off - 3000, &vec![0x11; 3000]);
        c.img.write(off, &t);
        // (it has no DHT, so the carver hands it back with the standard tables added: match by place)
        let rec = carve::thumbnails(&c);
        let name = format!("t{:07}_{:04}.jpg", off / 512, off % 512);
        assert!(rec.iter().any(|r| r.name == name), "skew {skew}: {:?}", rec.iter().map(|r| &r.name).collect::<Vec<_>>());
    }
}

// 11-4: "Recuva" and "assume contiguous" were the same tool
#[test]
fn recuva_follows_an_exfat_chain_that_contiguous_undelete_misses() {
    let ph = vec![fake_jpeg(1, 30_000), fake_jpeg(2, 60_000), fake_jpeg(3, 90_000)];
    let mut c = Card::new(Fs::ExFat, 64, Some(4), CameraKind::Phone, ph.clone(), 1);
    c.run_events(&[
        json!({"type":"shoot","count":2}),
        json!({"type":"delete","which":"first","count":1}),
        json!({"type":"power_cycle"}),
        json!({"type":"shoot","count":1}),
        json!({"type":"delete","which":"all"}),
    ]);
    let third = c.photo_file(2).unwrap();
    assert!(third.clusters.windows(2).any(|w| w[1] != w[0] + 1), "should be fragmented");
    let get = |m| carve::fs_read(&c, m).into_iter().find(|r| r.name.ends_with(&third.name)).unwrap().data;
    assert_eq!(get(Undelete::Recuva), c.photos[2]);
    assert_ne!(get(Undelete::Contiguous), c.photos[2]);
    assert_ne!(carve::carve(&c, "recuva", &json!({})).iter().map(|r| &r.data).collect::<Vec<_>>(), carve::carve(&c, "undelete_contiguous", &json!({})).iter().map(|r| &r.data).collect::<Vec<_>>());
}
