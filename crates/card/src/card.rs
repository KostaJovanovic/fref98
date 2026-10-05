//! The virtual card: a sparse image + file system + a camera that shoots, deletes, formats and fails.
//! The model keeps a per-cluster state/owner map for the UI; the bytes on "disk" are the truth for carvers.

use crate::fs::{Dir, EntryLoc, Fs, Policy, Volume};
use crate::img::SparseImage;
use refragmenter_codec::step::Pcg32;
use serde::Serialize;
use serde_json::Value;

pub const ST_FREE: u8 = 0;
pub const ST_META: u8 = 1;
pub const ST_LIVE: u8 = 2;
pub const ST_DELETED: u8 = 3;
pub const ST_OVERWROTE: u8 = 4;
pub const ST_DAMAGED: u8 = 5;
pub const ST_VIDEO: u8 = 6;
pub const ST_JUNK: u8 = 7;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CameraKind {
    Canon2004,
    Phone,
    Generic,
}

impl CameraKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "phone" => CameraKind::Phone,
            "generic" => CameraKind::Generic,
            _ => CameraKind::Canon2004,
        }
    }
    fn dirs(self) -> (&'static str, &'static str) {
        match self {
            CameraKind::Canon2004 => ("DCIM", "100CANON"),
            CameraKind::Phone => ("DCIM", "CAMERA"),
            CameraKind::Generic => ("DCIM", "100MEDIA"),
        }
    }
    fn photo_name(self, n: u32) -> String {
        match self {
            CameraKind::Generic => format!("DSC{:05}.JPG", n),
            _ => format!("IMG_{:04}.JPG", n),
        }
    }
    /// Year the camera's clock says (used for timestamps).
    fn epoch(self) -> u32 {
        match self {
            CameraKind::Canon2004 => 4 * 365 * 86400 + 190 * 86400,
            _ => 26 * 365 * 86400 + 270 * 86400,
        }
    }
}

#[derive(Clone, Serialize, Debug)]
pub struct FileRec {
    pub name: String,
    pub kind: &'static str,
    pub first_cluster: u32,
    pub size: u64,
    pub deleted: bool,
    /// Index into the photos list (-1 for non-photo files).
    pub photo_index: i32,
    #[serde(skip)]
    pub clusters: Vec<u32>,
    #[serde(skip)]
    pub loc: EntryLoc,
    #[serde(skip)]
    pub dir: Dir,
}

pub struct Card {
    pub img: SparseImage,
    pub vol: Volume,
    pub camera: CameraKind,
    pub files: Vec<FileRec>,
    pub state: Vec<u8>,
    pub owner: Vec<i32>,
    pub log: Vec<String>,
    pub photos: Vec<Vec<u8>>,
    next_photo: usize,
    shot_no: u32,
    stamp: u32,
    photo_dir: Option<Dir>,
    rng: Pcg32,
    power_loss: Option<(f64, String)>,
    /// The camera adds its 160×120 EXIF thumbnail to photos that lack one (DCF cameras always
    /// write one). Off by default for the Rust API; the WASM `Card.simulate` turns it on.
    pub camera_thumbs: bool,
    /// The volume label every format writes (boot sector and root entry); a format event may set it.
    pub label: String,
    /// Per photo: thumbnail already added (photos[i] then holds the bytes the camera wrote).
    thumbed: Vec<bool>,
    /// Per photo: 1/8-scale DC image, computed once (thumbnails, Thumbs.db).
    small: Vec<Option<refragmenter_codec::Image>>,
}

/// Default cluster sizes: SD Association style for FAT16 and exFAT; FAT32 as Windows formats cards up to
/// 4 GB (4 KB) and as the SDA formats SDHC (32 KB). `fs::plan` still adjusts them to a valid count.
pub fn default_cluster_kb(fs: Fs, size_mb: u64) -> u64 {
    match fs {
        Fs::Fat16 => {
            if size_mb <= 64 {
                2
            } else if size_mb <= 256 {
                4
            } else if size_mb <= 512 {
                8
            } else if size_mb <= 1024 {
                16
            } else {
                32
            }
        }
        Fs::Fat32 => {
            if size_mb <= 4096 {
                4
            } else {
                32
            }
        }
        Fs::ExFat => {
            if size_mb <= 32768 {
                32
            } else {
                128
            }
        }
    }
}

/// A FAT volume label as Windows writes one: upper case, at most 11 characters, none of the characters a
/// label can't hold (empty = no label).
pub fn volume_label(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .filter(|c| !"\"*+,./:;<=>?[\\]|".contains(*c))
        .map(|c| c.to_ascii_uppercase())
        .take(11)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// Most clusters a simulated card may have. Every cluster costs ~10 bytes of bookkeeping (more while
/// overwriting), so a 64 GB card with 1 KB clusters (64 M of them) would need gigabytes.
const MAX_CLUSTERS: u64 = 1 << 22;

impl Card {
    pub fn new(fs: Fs, size_mb: u64, cluster_kb: Option<u64>, camera: CameraKind, photos: Vec<Vec<u8>>, seed: u32) -> Card {
        let size = size_mb.clamp(8, 1 << 20) * 1024 * 1024;
        let mut img = SparseImage::new(size);
        let asked = cluster_kb.unwrap_or_else(|| default_cluster_kb(fs, size_mb)).clamp(1, 1024);
        let plan = crate::fs::plan(fs, size, asked * 1024, MAX_CLUSTERS);
        let fs = plan.fs;
        let mut rng = Pcg32::new(seed as u64, 0x43415244);
        let serial = rng.next_u32();
        let vol = Volume::format(&mut img, fs, plan.cluster_bytes, serial, "CARD");
        let n = vol.cluster_count as usize + 2;
        let np = photos.len();
        let mut c = Card {
            img,
            vol,
            camera,
            files: Vec::new(),
            state: vec![ST_FREE; n],
            owner: vec![-1; n],
            log: Vec::new(),
            photos,
            next_photo: 0,
            shot_no: 1,
            stamp: camera.epoch(),
            photo_dir: None,
            rng,
            power_loss: None,
            camera_thumbs: false,
            label: "CARD".into(),
            thumbed: vec![false; np],
            small: vec![None; np],
        };
        c.sync_meta_states();
        if let Some(n) = plan.note {
            c.log.push(n);
        }
        c.log.push(format!(
            "Formatted {} MB card as {} with {} clusters ({} clusters).",
            size / (1024 * 1024),
            fs.name().to_uppercase(),
            crate::fs::fmt_cluster(c.vol.cluster_bytes),
            c.vol.cluster_count
        ));
        c
    }

    fn sync_meta_states(&mut self) {
        for cl in 2..self.state.len() {
            if self.vol.in_use[cl] && self.owner[cl] < 0 && self.state[cl] == ST_FREE {
                self.state[cl] = ST_META;
            }
        }
    }

    /// The camera's photo folder, created on first use; None (logged) when the card is too full for it.
    fn ensure_dirs(&mut self) -> Option<Dir> {
        if let Some(d) = self.photo_dir {
            return Some(d);
        }
        let (a, b) = self.camera.dirs();
        let root = self.vol.root();
        let made = self.vol.mkdir(&mut self.img, root, a, self.stamp).and_then(|dcim| self.vol.mkdir(&mut self.img, dcim, b, self.stamp));
        self.sync_meta_states();
        if made.is_none() {
            self.log.push("Card full: the camera could not create its photo folder.".into());
        }
        self.photo_dir = made;
        made
    }

    fn mark_clusters(&mut self, clusters: &[u32], file: i32, st: u8) {
        for &c in clusters {
            let c = c as usize;
            if c >= self.state.len() {
                continue;
            }
            let prev = self.state[c];
            self.state[c] = if st == ST_LIVE && (prev == ST_DELETED || prev == ST_OVERWROTE) { ST_OVERWROTE } else { st };
            self.owner[c] = file;
        }
    }

    /// Write a file the way a device does. Returns its index in `files`.
    #[allow(clippy::too_many_arguments)]
    pub fn write_file(
        &mut self,
        dir: Dir,
        name: &str,
        data: &[u8],
        kind: &'static str,
        photo_index: i32,
        policy: Policy,
        st: u8,
    ) -> Option<usize> {
        let cb = self.vol.cluster_bytes as usize;
        let need = data.len().div_ceil(cb).max(1);
        let chain = self.vol.alloc(need, policy);
        if chain.len() < need {
            self.log.push(format!("Card full while writing {name}."));
            if chain.is_empty() {
                return None;
            }
        }
        // on a full card only the part that fits is written, and the entry says so
        let data = &data[..data.len().min(chain.len() * cb)];
        let idx = self.files.len();
        self.stamp += 7 + self.rng.below(50);
        // Power loss: only part of the data reaches the card and metadata is left inconsistent.
        let (written, pl_mode) = match self.power_loss.take() {
            Some((frac, mode)) => (((chain.len() as f64) * frac).ceil() as usize, Some(mode)),
            None => (chain.len(), None),
        };
        for (i, &c) in chain.iter().enumerate().take(written) {
            let s = i * cb;
            let e = (s + cb).min(data.len());
            let off = self.vol.cluster_offset(c);
            if s < data.len() {
                self.img.write(off, &data[s..e]);
                // the slack of the last cluster keeps whatever was there before, as on a camera
            }
        }
        let contiguous = Volume::is_contiguous(&chain);
        let exfat_nofat = self.vol.fs == Fs::ExFat && contiguous;
        let mut rec = FileRec {
            name: name.to_string(),
            kind,
            first_cluster: chain[0],
            size: data.len() as u64,
            deleted: false,
            photo_index,
            clusters: chain.clone(),
            loc: EntryLoc { offset: 0, count: 0 },
            dir,
        };
        match pl_mode.as_deref() {
            Some("no_entry") => {
                // FAT chain committed, directory entry never written: chkdsk will find a lost chain.
                for &c in &chain {
                    self.vol.mark(&mut self.img, c, true);
                }
                if !exfat_nofat {
                    self.vol.link_chain(&mut self.img, &chain);
                }
                rec.deleted = true;
                rec.kind = "lost";
                rec.clusters.truncate(written);
                self.log.push(format!("Power lost while writing {name}: data and FAT written, directory entry missing."));
            }
            Some(_) => {
                // Entry written with size 0, FAT never updated: data sits in clusters the card thinks are free.
                rec.loc = self.vol.write_entry(&mut self.img, dir, name, chain[0], 0, false, self.stamp, false);
                rec.size = 0;
                rec.clusters.truncate(written);
                // Allocation was speculative: release it again.
                for &c in &chain {
                    self.vol.in_use[c as usize] = false;
                }
                self.log.push(format!(
                    "Power lost while writing {name}: {} of {} clusters reached the card, file shows 0 bytes.",
                    written,
                    chain.len()
                ));
                self.files.push(rec.clone());
                let w = rec.clusters.clone();
                self.mark_clusters(&w, idx as i32, ST_DELETED);
                return Some(idx);
            }
            None => {
                for &c in &chain {
                    self.vol.mark(&mut self.img, c, true);
                }
                if !exfat_nofat {
                    self.vol.link_chain(&mut self.img, &chain);
                }
                rec.loc = self.vol.write_entry(&mut self.img, dir, name, chain[0], data.len() as u64, false, self.stamp, exfat_nofat);
                let frag = chain.windows(2).filter(|w| w[1] != w[0] + 1).count();
                self.log.push(if frag > 0 {
                    format!("Wrote {name} ({} KB) in {} fragments.", data.len() / 1024, frag + 1)
                } else {
                    format!("Wrote {name} ({} KB).", data.len() / 1024)
                });
            }
        }
        let cl = rec.clusters.clone();
        let deleted = rec.deleted;
        self.files.push(rec);
        self.mark_clusters(&cl, idx as i32, if deleted { ST_DELETED } else { st });
        self.vol.update_fsinfo(&mut self.img);
        Some(idx)
    }

    fn next_photo_bytes(&mut self) -> Option<(usize, Vec<u8>)> {
        if self.photos.is_empty() {
            return None;
        }
        let i = self.next_photo % self.photos.len();
        self.next_photo += 1;
        Some(self.photo_bytes(i))
    }

    /// The photo at roll position `i` (wrapping) as the camera writes it.
    fn photo_bytes(&mut self, i: usize) -> (usize, Vec<u8>) {
        let i = i % self.photos.len();
        if self.camera_thumbs && !self.thumbed[i] {
            self.thumbed[i] = true;
            if crate::jpeg::exif_thumbnail(&self.photos[i]).is_none() {
                if let Some(small) = self.small_image(i) {
                    let t = crate::thumbs::camera_thumbnail(&small);
                    let with = refragmenter_codec::with_exif_thumbnail(&self.photos[i], &t);
                    if crate::jpeg::exif_thumbnail(&with).is_some() {
                        self.photos[i] = with;
                    }
                }
            }
        }
        (i, self.photos[i].clone())
    }

    /// The photos an event names (`photos`: roll positions), or `count` from the running cursor.
    fn event_photos(&mut self, named: Option<&[usize]>, count: usize) -> Vec<(usize, Vec<u8>)> {
        if self.photos.is_empty() {
            return Vec::new();
        }
        match named {
            Some(list) => list.iter().map(|&i| self.photo_bytes(i)).collect(),
            None => (0..count).filter_map(|_| self.next_photo_bytes()).collect(),
        }
    }

    /// 1/8-scale preview of photo `i` from its DC coefficients (cached).
    pub fn small_image(&mut self, i: usize) -> Option<refragmenter_codec::Image> {
        if self.small.get(i)?.is_none() {
            self.small[i] = crate::thumbs::dc_image(&self.photos[i]);
        }
        self.small[i].clone()
    }

    pub fn shoot(&mut self, count: usize) {
        self.shoot_photos(None, count);
    }

    /// `named`: the roll positions to shoot, in order (else `count` photos from the running cursor).
    pub fn shoot_photos(&mut self, named: Option<&[usize]>, count: usize) {
        let Some(dir) = self.ensure_dirs() else { return };
        for (pi, data) in self.event_photos(named, count) {
            let name = self.camera.photo_name(self.shot_no);
            self.shot_no += 1;
            self.write_file(dir, &name, &data, "photo", pi as i32, Policy::NextFree, ST_LIVE);
        }
    }

    /// Several files written at once (burst buffer flush / RAW+JPEG): clusters alternate between them.
    pub fn burst(&mut self, count: usize, period: usize) {
        let Some(dir) = self.ensure_dirs() else { return };
        let cb = self.vol.cluster_bytes as usize;
        let mut items = Vec::new();
        for _ in 0..count.max(1) {
            let Some((pi, data)) = self.next_photo_bytes() else { return };
            let name = self.camera.photo_name(self.shot_no);
            self.shot_no += 1;
            items.push((pi, data, name));
        }
        let needs: Vec<usize> = items.iter().map(|(_, d, _)| d.len().div_ceil(cb)).collect();
        let total: usize = needs.iter().sum();
        let pool = self.vol.alloc(total, Policy::NextFree);
        let mut chains: Vec<Vec<u32>> = vec![Vec::new(); items.len()];
        let mut it = pool.into_iter();
        'outer: loop {
            let mut progressed = false;
            for (k, chain) in chains.iter_mut().enumerate() {
                for _ in 0..period.max(1) {
                    if chain.len() < needs[k] {
                        match it.next() {
                            Some(c) => {
                                chain.push(c);
                                progressed = true;
                            }
                            None => break 'outer,
                        }
                    }
                }
            }
            if !progressed {
                break;
            }
        }
        for ((pi, data, name), chain) in items.into_iter().zip(chains) {
            if chain.is_empty() {
                continue;
            }
            let idx = self.files.len();
            for (i, &c) in chain.iter().enumerate() {
                let s = i * cb;
                if s < data.len() {
                    let e = (s + cb).min(data.len());
                    let off = self.vol.cluster_offset(c);
                    self.img.write(off, &data[s..e]);
                }
                self.vol.mark(&mut self.img, c, true);
            }
            self.vol.link_chain(&mut self.img, &chain);
            self.stamp += 1;
            let loc = self.vol.write_entry(&mut self.img, dir, &name, chain[0], data.len() as u64, false, self.stamp, false);
            self.files.push(FileRec {
                name: name.clone(),
                kind: "photo",
                first_cluster: chain[0],
                size: data.len() as u64,
                deleted: false,
                photo_index: pi as i32,
                clusters: chain.clone(),
                loc,
                dir,
            });
            self.mark_clusters(&chain, idx as i32, ST_LIVE);
            self.log.push(format!("Burst-wrote {name} interleaved with {} other file(s).", count - 1));
        }
    }

    /// `names` is used by `which == "names"`: delete exactly those live files (a selection in Explorer).
    pub fn delete(&mut self, which: &str, count: usize, clear_high: bool, names: &[String]) {
        let live: Vec<usize> = (0..self.files.len()).filter(|&i| !self.files[i].deleted && self.files[i].kind != "dir").collect();
        let targets: Vec<usize> = match which {
            "all" => live.clone(),
            "names" => live.iter().filter(|&&i| names.iter().any(|n| n.eq_ignore_ascii_case(&self.files[i].name))).copied().collect(),
            "first" => live.iter().take(count).copied().collect(),
            "every_other" => live.iter().step_by(2).copied().collect(),
            "random" => {
                let mut v = live.clone();
                let mut out = Vec::new();
                for _ in 0..count.min(v.len()) {
                    let k = self.rng.below(v.len() as u32) as usize;
                    out.push(v.remove(k));
                }
                out.sort();
                out
            }
            _ => live.iter().rev().take(count).copied().collect(),
        };
        for i in targets {
            let f = self.files[i].clone();
            self.vol.delete_entry(&mut self.img, f.loc, clear_high);
            if self.vol.fs != Fs::ExFat {
                self.vol.free_chain_fat(&mut self.img, &f.clusters);
            }
            for &c in &f.clusters {
                if self.owner[c as usize] == i as i32 {
                    self.vol.mark(&mut self.img, c, false);
                    self.state[c as usize] = ST_DELETED;
                }
            }
            self.files[i].deleted = true;
            self.log.push(format!("Deleted {}.", f.name));
        }
        self.vol.update_fsinfo(&mut self.img);
    }

    pub fn quick_format(&mut self) {
        let fs = self.vol.fs;
        let cb = self.vol.cluster_bytes;
        self.reformat(fs, cb, "In-camera format");
    }

    /// Re-create the file system. Data stays where it is; if the geometry changes, old files no longer
    /// line up with the new cluster grid.
    pub fn reformat(&mut self, fs: Fs, cluster_bytes: u64, why: &str) {
        let plan = crate::fs::plan(fs, self.img.size, cluster_bytes, MAX_CLUSTERS);
        if let Some(n) = &plan.note {
            self.log.push(n.clone());
        }
        let (fs, cluster_bytes) = (plan.fs, plan.cluster_bytes);
        let old_state = std::mem::take(&mut self.state);
        let old_owner = std::mem::take(&mut self.owner);
        let old_ds = self.vol.data_start;
        let old_cb = self.vol.cluster_bytes;
        let old_count = old_state.len();
        let serial = self.rng.next_u32();
        self.vol = Volume::format(&mut self.img, fs, cluster_bytes, serial, &self.label.clone());
        let n = self.vol.cluster_count as usize + 2;
        self.state = vec![ST_FREE; n];
        self.owner = vec![-1; n];
        for c in 2..n {
            let off = self.vol.cluster_offset(c as u32);
            if off < old_ds {
                continue;
            }
            let oc = ((off - old_ds) / old_cb) as usize + 2;
            if oc < old_count && old_owner[oc] >= 0 {
                self.owner[c] = old_owner[oc];
                self.state[c] = match old_state[oc] {
                    ST_DAMAGED => ST_DAMAGED,
                    ST_JUNK => ST_JUNK,
                    _ => ST_DELETED,
                };
            } else if oc < old_count && old_state[oc] == ST_DAMAGED {
                self.state[c] = ST_DAMAGED;
            }
        }
        for f in self.files.iter_mut() {
            f.deleted = true;
            // The new FAT is empty, so a chain lost before the format is no longer "allocated but
            // unreferenced": it is plain deleted data now, and chkdsk must not bring it back.
            if f.kind == "lost" {
                f.kind = "orphan";
            }
        }
        self.photo_dir = None;
        self.sync_meta_states();
        // Metadata may have landed on old data.
        for c in 2..n {
            if self.vol.in_use[c] {
                self.state[c] = ST_META;
            }
        }
        self.log.push(format!(
            "{why}: {} with {} clusters. Old photos are still on the card, just forgotten{}.",
            fs.name().to_uppercase(),
            crate::fs::fmt_cluster(cluster_bytes),
            if cluster_bytes != old_cb || self.vol.data_start != old_ds { " (and no longer aligned to the cluster grid)" } else { "" }
        ));
    }

    pub fn arm_power_loss(&mut self, at: f64, mode: &str) {
        self.power_loss = Some((at.clamp(0.05, 0.95), mode.to_string()));
    }

    /// A live subdirectory of `parent` called `name`, if there is one.
    fn find_dir(&self, parent: Dir, name: &str) -> Option<Dir> {
        self.vol
            .read_dir(&self.img, parent)
            .into_iter()
            .find(|e| e.is_dir && !e.deleted && e.name.eq_ignore_ascii_case(name) && e.first >= 2 && e.first <= self.vol.last_cluster())
            .map(|e| Dir::Cluster(e.first))
    }

    /// chkdsk: chains allocated in the FAT but not referenced by any entry become FOUND.nnn\FILEnnnn.CHK
    /// (each run uses the next free FOUND.nnn, as Windows does).
    pub fn chkdsk(&mut self) {
        let n = self.state.len();
        let lost: Vec<usize> = (0..self.files.len())
            .filter(|&i| {
                let f = &self.files[i];
                f.kind == "lost" && !f.clusters.is_empty() && f.clusters.iter().all(|&c| (c as usize) < n)
            })
            .collect();
        if lost.is_empty() {
            self.log.push("chkdsk: no errors found.".into());
            return;
        }
        let root = self.vol.root();
        let folder = (0..1000).map(|n| format!("FOUND.{n:03}")).find(|n| self.find_dir(root, n).is_none()).unwrap_or_else(|| "FOUND.999".into());
        let Some(found) = self.vol.mkdir(&mut self.img, root, &folder, self.stamp) else {
            self.log.push("chkdsk: the disk is full, so the lost chains could not be saved.".into());
            return;
        };
        for (k, i) in lost.into_iter().enumerate() {
            let f = self.files[i].clone();
            let size = f.clusters.len() as u64 * self.vol.cluster_bytes;
            let name = format!("FILE{:04}.CHK", k);
            let loc = self.vol.write_entry(&mut self.img, found, &name, f.clusters[0], size, false, self.stamp, false);
            self.files[i].name = name.clone();
            self.files[i].kind = "chk";
            self.files[i].deleted = false;
            self.files[i].loc = loc;
            self.files[i].size = size;
            self.files[i].dir = found;
            let cl = f.clusters.clone();
            self.mark_clusters(&cl, i as i32, ST_LIVE);
            self.log.push(format!("chkdsk: recovered lost chain as {folder}\\{name}."));
        }
        self.sync_meta_states();
    }

    /// Damage FAT links: chains jump into other files' clusters (cross-links after a crash). Only files
    /// read through the FAT can be hit: exFAT keeps contiguous files without a FAT chain.
    pub fn fat_glitch(&mut self, count: usize) {
        let chained = |f: &FileRec| self.vol.fs != Fs::ExFat || !Volume::is_contiguous(&f.clusters);
        let live: Vec<usize> = (0..self.files.len()).filter(|&i| !self.files[i].deleted && self.files[i].clusters.len() > 2 && chained(&self.files[i])).collect();
        if live.len() < 2 {
            self.log.push(if self.vol.fs == Fs::ExFat {
                "FAT glitch: no effect, exFAT keeps these photos without a FAT chain.".into()
            } else {
                "FAT glitch: no effect, there are not enough files to cross-link.".into()
            });
            return;
        }
        for _ in 0..count {
            let a = live[self.rng.below(live.len() as u32) as usize];
            let mut b = live[self.rng.below(live.len() as u32) as usize];
            if a == b {
                b = live[(live.iter().position(|&x| x == a).unwrap() + 1) % live.len()];
            }
            let ca = &self.files[a].clusters;
            let cbv = &self.files[b].clusters;
            let ia = 1 + self.rng.below((ca.len() - 1) as u32) as usize;
            let ib = self.rng.below(cbv.len() as u32) as usize;
            let (from, to) = (ca[ia - 1], cbv[ib]);
            self.vol.fat_set(&mut self.img, from, to);
            let (na, nb) = (self.files[a].name.clone(), self.files[b].name.clone());
            self.log.push(format!("FAT glitch: {na} now continues into the middle of {nb} (cross-linked)."));
        }
    }

    /// A second-hand card: free clusters (from the start of the data area, `kb` KB worth) still
    /// hold image data of photos deleted long ago. Nothing in the file system points at it, but a
    /// carver reading past a file's real end finds old photo data instead of blank space.
    pub fn used_card(&mut self, kb: u64) {
        let cb = self.vol.cluster_bytes as usize;
        let mut stale: Vec<u8> = Vec::new();
        for p in self.photos.iter().rev() {
            let s = crate::jpeg::scan_start(p).unwrap_or(0);
            let e = p.len().saturating_sub(2).max(s);
            stale.extend_from_slice(&p[s..e]);
        }
        if stale.is_empty() {
            return;
        }
        let want = kb as usize * 1024;
        let mut pos = stale.len() / 3;
        let mut written = 0usize;
        let mut chunk = Vec::with_capacity(cb);
        for c in 2..=self.vol.last_cluster() {
            if written >= want {
                break;
            }
            if self.vol.in_use[c as usize] {
                continue;
            }
            chunk.clear();
            while chunk.len() < cb {
                let n = (cb - chunk.len()).min(stale.len() - pos);
                chunk.extend_from_slice(&stale[pos..pos + n]);
                pos = (pos + n) % stale.len();
            }
            self.img.write(self.vol.cluster_offset(c), &chunk);
            written += cb;
        }
        self.log.push(format!("The card was used before: {} KB of free space still holds old photo data.", written / 1024));
    }

    /// A PC writes exactly `kb` KB of one index file into the lowest free clusters (no ._ files or
    /// Thumbs.db), so the amount overwritten can be scaled to the size of a photo.
    pub fn os_junk_exact(&mut self, kb: u64) {
        let dir = self.photo_dir.unwrap_or_else(|| self.vol.root());
        let junk: Vec<u8> = (0..kb as usize * 1024).map(|i| ((i % 76) as u8).wrapping_mul(31) ^ 0x5A).collect();
        self.write_file(dir, "INDEXE~1.DAT", &junk, "junk", -1, Policy::FirstFree, ST_JUNK);
        self.log.push(format!("A PC wrote a {kb} KB index file into free space."));
    }

    /// `thumbs_of`: "all" = Thumbs.db remembers every photo Explorer ever showed in the folder
    /// (also ones deleted since), "live" = only photos still on the card.
    pub fn os_junk_with(&mut self, kb: u64, thumbs_of: &str) {
        let root = self.vol.root();
        // the PC reuses its folder from an earlier visit
        let Some(svi) = self.find_dir(root, "SYSTEM~1").or_else(|| self.vol.mkdir(&mut self.img, root, "SYSTEM~1", self.stamp)) else {
            self.log.push("A PC tried to write its index files, but the card is full.".into());
            return;
        };
        let mut junk = vec![0u8; 76];
        for (i, b) in junk.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(31) ^ 0x5A;
        }
        self.write_file(svi, "INDEXE~1", &junk, "junk", -1, Policy::FirstFree, ST_JUNK);
        let dir = self.photo_dir.unwrap_or(root);
        let mut total = 0u64;
        let names: Vec<String> = self.files.iter().filter(|f| f.kind == "photo").map(|f| f.name.clone()).collect();
        for (k, _) in names.into_iter().enumerate() {
            if total >= kb * 1024 {
                break;
            }
            let mut d = vec![0u8; 4096];
            d[0..4].copy_from_slice(&[0x00, 0x05, 0x16, 0x07]);
            d[4..8].copy_from_slice(&[0, 2, 0, 0]);
            d[8..24].copy_from_slice(b"Mac OS X        ");
            let short = format!("_IMG{:04}.JPG", k + 1);
            self.write_file(dir, &short, &d, "junk", -1, Policy::FirstFree, ST_JUNK);
            total += 4096;
        }
        // Thumbs.db: a real Compound File with a 96 px JPEG of every photo Explorer showed.
        let shown: Vec<(String, usize)> = self
            .files
            .iter()
            .filter(|f| f.kind == "photo" && f.photo_index >= 0 && (thumbs_of != "live" || !f.deleted))
            .map(|f| (f.name.clone(), f.photo_index as usize))
            .collect();
        let mut items = Vec::new();
        for (name, pi) in shown {
            if let Some(small) = self.small_image(pi) {
                items.push((name, crate::thumbs::xp_thumbnail(&small)));
            }
        }
        let filetime = (self.stamp as u64 + 946_684_800 + 11_644_473_600) * 10_000_000;
        let tdb = crate::thumbs::thumbs_db(&items, (kb as usize * 1024).saturating_sub(total as usize).max(8192), filetime);
        self.write_file(dir, "THUMBS.DB", &tdb, "junk", -1, Policy::FirstFree, ST_JUNK);
        self.log.push(format!(
            "A PC wrote System Volume Information, ._ files and Thumbs.db ({} thumbnails) into free space.",
            items.len()
        ));
    }

    /// New shots after deletions: the camera (switched off and on, so its write pointer is back
    /// at the start) puts them into the first free clusters, i.e. over deleted photos.
    pub fn overwrite(&mut self, count: usize) {
        self.vol.next_hint = 2;
        let before: Vec<i32> = self.owner.clone();
        let first_new = self.files.len();
        self.shoot(count);
        for fi in first_new..self.files.len() {
            let f = &self.files[fi];
            let mut hit: Vec<(i32, usize)> = Vec::new();
            for &c in &f.clusters {
                let o = before[c as usize];
                if o >= 0 && self.files.get(o as usize).is_some_and(|g| g.deleted) {
                    match hit.iter_mut().find(|(x, _)| *x == o) {
                        Some(e) => e.1 += 1,
                        None => hit.push((o, 1)),
                    }
                }
            }
            let name = f.name.clone();
            if hit.is_empty() {
                self.log.push(format!("{name} went into clusters nobody had used."));
            }
            for (o, n) in hit {
                let victim = &self.files[o as usize];
                let total = victim.clusters.len().max(1);
                self.log.push(format!(
                    "{name} overwrote {n} of {total} clusters of deleted {}{}.",
                    victim.name,
                    if n >= total { " (gone for good)" } else { "" }
                ));
            }
        }
    }

    /// Flash memory failure in the data area: in any file's clusters, or in photo `target`'s only.
    pub fn flash_fault(&mut self, mode: &str, count: usize, page_kb: u64, target: Option<usize>) {
        let page = page_kb.clamp(2, 64) * 1024;
        let used: Vec<u32> = match target.and_then(|i| self.photo_file(i)) {
            // past its header cluster: a lost header is a different story (nothing decodes at all)
            Some(f) => f.clusters.iter().skip(1).copied().filter(|&c| (c as usize) < self.state.len()).collect(),
            None => (2..self.state.len() as u32).filter(|&c| self.owner[c as usize] >= 0).collect(),
        };
        if used.is_empty() {
            return;
        }
        let cb = self.vol.cluster_bytes;
        for _ in 0..count {
            let c = used[self.rng.below(used.len() as u32) as usize];
            let off = self.vol.cluster_offset(c) + (self.rng.below((cb / 512).max(1) as u32) as u64) * 512;
            let off = off - off % page.min(cb);
            let len = page.min(self.img.size - off);
            match mode {
                "burst" => {
                    let mut b = vec![0u8; len as usize];
                    for x in b.iter_mut() {
                        *x = self.rng.next_u32() as u8;
                    }
                    self.img.write(off, &b);
                }
                "stuck_bit" => {
                    let bit = 1u8 << self.rng.below(8);
                    let mut b = self.img.read_vec(off, len as usize);
                    for x in b.iter_mut() {
                        *x |= bit;
                    }
                    self.img.write(off, &b);
                }
                "zero" => self.img.fill(off, len, 0),
                _ => self.img.fill(off, len, 0xFF),
            }
            let first = self.vol.cluster_at(off).unwrap_or(c);
            let last = self.vol.cluster_at(off + len - 1).unwrap_or(c);
            for k in first..=last {
                self.state[k as usize] = ST_DAMAGED;
            }
        }
        self.log.push(format!("Flash fault ({mode}): {count} page(s) of {} KB damaged.", page / 1024));
    }

    /// Movie clip: MJPEG AVI + .THM sidecar (frames are photos of the roll: `named`, or the next ones).
    pub fn video(&mut self, frames: usize, named: Option<&[usize]>) {
        let Some(dir) = self.ensure_dirs() else { return };
        let mut jpegs = Vec::new();
        for (_, d) in self.event_photos(named, frames.max(1)) {
            // 640x480 MJPEG frames with standard tables and no DHT, like Canon's movie mode.
            let frame = refragmenter_codec::decode_rgba(&d)
                .map(|img| {
                    let small = crate::formats::resize_box(&img, 640, 480);
                    crate::jpeg::strip_dht(&refragmenter_codec::encode_rgba(&small, 70, "422"))
                })
                .unwrap_or(d);
            jpegs.push(frame);
        }
        if jpegs.is_empty() {
            return;
        }
        let avi = refragmenter_codec::avi::write(&jpegs, 640, 480, 15);
        let n = self.shot_no;
        self.shot_no += 1;
        let thm = crate::jpeg::exif_thumbnail(&jpegs[0]).map(|(o, l)| jpegs[0][o..o + l].to_vec()).unwrap_or_else(|| jpegs[0].clone());
        self.write_file(dir, &format!("MVI_{:04}.THM", n), &thm, "thm", -1, Policy::NextFree, ST_LIVE);
        self.write_file(dir, &format!("MVI_{:04}.AVI", n), &avi, "video", -1, Policy::NextFree, ST_VIDEO);
    }

    /// Run a scenario JSON: { events: [ {type, ...} ] }.
    pub fn run_events(&mut self, events: &[Value]) {
        use refragmenter_codec::step::{get_bool, get_f64, get_i64, get_str};
        // roll positions an event names ("photos": [0, 1, …]), at most 500
        let named = |e: &Value| -> Option<Vec<usize>> { e.get("photos")?.as_array().map(|a| a.iter().filter_map(|v| v.as_u64()).take(500).map(|v| v as usize).collect()) };
        for e in events {
            let t = get_str(e, "type", "");
            match t {
                "shoot" => self.shoot_photos(named(e).as_deref(), get_i64(e, "count", 1).clamp(1, 500) as usize),
                "burst" => self.burst(get_i64(e, "count", 3).clamp(2, 8) as usize, get_i64(e, "period", 1).clamp(1, 16) as usize),
                "delete" => self.delete(
                    get_str(e, "which", "all"),
                    get_i64(e, "count", 1).max(1) as usize,
                    get_bool(e, "clear_high", true),
                    &e.get("names").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|n| n.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default(),
                ),
                "set_label" => {
                    self.label = volume_label(get_str(e, "label", ""));
                    let label = self.label.clone();
                    self.vol.set_label(&mut self.img, &label);
                }
                "quick_format" => {
                    if let Some(l) = e.get("label").and_then(|v| v.as_str()) {
                        self.label = volume_label(l);
                    }
                    self.quick_format()
                }
                "reformat_pc" => {
                    if let Some(l) = e.get("label").and_then(|v| v.as_str()) {
                        self.label = volume_label(l);
                    }
                    let fs = Fs::parse(get_str(e, "fs", "fat32"));
                    // no size given: what Windows picks for this file system and card size
                    let ckb = match e.get("cluster_kb").and_then(|v| v.as_i64()) {
                        Some(k) => k.clamp(1, 1024) as u64,
                        None => default_cluster_kb(fs, self.img.size >> 20),
                    };
                    self.reformat(fs, ckb * 1024, "Formatted on a PC");
                }
                "power_loss" => self.arm_power_loss(get_f64(e, "at", 0.5), get_str(e, "mode", "size_zero")),
                "chkdsk" => self.chkdsk(),
                "fat_glitch" => self.fat_glitch(get_i64(e, "count", 2).clamp(1, 64) as usize),
                // 64 MB at most: every written page is real memory in the sparse image.
                "used_card" => self.used_card(get_i64(e, "kb", 1024).clamp(1, 1 << 16) as u64),
                "os_junk" if get_bool(e, "exact", false) => self.os_junk_exact(get_i64(e, "kb", 256).clamp(1, 65536) as u64),
                "os_junk" => self.os_junk_with(get_i64(e, "kb", 256).clamp(8, 65536) as u64, get_str(e, "thumbs_of", "all")),
                "overwrite" => self.overwrite(get_i64(e, "count", 2).clamp(1, 500) as usize),
                "flash_fault" => self.flash_fault(
                    get_str(e, "mode", "erased"),
                    get_i64(e, "count", 4).clamp(1, 4096) as usize,
                    get_i64(e, "page_kb", 16) as u64,
                    // internal (pass_through_card): faults aimed at one photo
                    usize::try_from(get_i64(e, "photo", -1)).ok(),
                ),
                "video" => self.video(get_i64(e, "frames", 4).clamp(1, 60) as usize, named(e).as_deref()),
                "power_cycle" => {
                    // Many cameras forget their roving allocation pointer when switched off: next file goes
                    // into the first hole, which is how photos get fragmented.
                    self.vol.next_hint = 2;
                    self.log.push("Camera switched off and on: next photo goes into the first free gap.".into());
                }
                "advance" => {
                    let free = self.vol.free_clusters() as f64;
                    let n = match e.get("kb").and_then(|v| v.as_u64()) {
                        // internal (pass_through_card): an amount instead of a share
                        Some(kb) => ((kb * 1024).div_ceil(self.vol.cluster_bytes) as f64).min(free * 0.99) as usize,
                        None => (free * get_f64(e, "percent", 50.0).clamp(0.0, 99.0) / 100.0) as usize,
                    };
                    let pct = n as f64 * 100.0 / free.max(1.0);
                    // Older shots the owner keeps: occupied clusters (contents not modelled).
                    let chain = self.vol.alloc(n, Policy::NextFree);
                    for &c in &chain {
                        self.vol.mark(&mut self.img, c, true);
                        self.state[c as usize] = ST_META;
                    }
                    // the same rule as write_file: only a contiguous exFAT file goes without a FAT chain
                    let nofat = self.vol.fs == Fs::ExFat && Volume::is_contiguous(&chain);
                    if !nofat {
                        self.vol.link_chain(&mut self.img, &chain);
                    }
                    let root = self.vol.root();
                    if let Some(&first) = chain.first() {
                        let size = chain.len() as u64 * self.vol.cluster_bytes;
                        self.vol.write_entry(&mut self.img, root, "OLDSHOTS.DAT", first, size.min(u32::MAX as u64), false, self.stamp, nofat);
                    }
                    self.log.push(format!("Card already {pct:.0}% used by older shots: writing continues from there."));
                }
                _ => self.log.push(format!("Unknown event '{t}' ignored.")),
            }
        }
        // FSInfo / PercentInUse after everything (burst and advance don't keep them up to date)
        self.vol.update_fsinfo(&mut self.img);
    }

    /// Cluster range covering a file's original data (for matching recovered files back to photos).
    pub fn photo_file(&self, photo_index: usize) -> Option<&FileRec> {
        self.files.iter().find(|f| f.photo_index == photo_index as i32 && f.kind == "photo")
    }
}
