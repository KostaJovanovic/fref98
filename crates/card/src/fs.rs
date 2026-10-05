//! Real on-disk FAT16 / FAT32 / exFAT structures written into a sparse card image.
//! Only what cameras and recovery tools touch is modelled: boot sectors, FATs, allocation bitmap,
//! up-case table, directories with 8.3 / exFAT entry sets, deletion and quick format.

use crate::img::SparseImage;

pub const SECTOR: u64 = 512;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fs {
    Fat16,
    Fat32,
    ExFat,
}

impl Fs {
    pub fn parse(s: &str) -> Fs {
        match s {
            "fat32" => Fs::Fat32,
            "exfat" => Fs::ExFat,
            _ => Fs::Fat16,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Fs::Fat16 => "fat16",
            Fs::Fat32 => "fat32",
            Fs::ExFat => "exfat",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Policy {
    /// Cameras: continue after the last allocated cluster (roving pointer), wrapping.
    NextFree,
    /// PCs filling small files: lowest free cluster first.
    FirstFree,
}

/// A directory: FAT16 fixed root is `Dir::Root16`; everything else is a cluster chain / contiguous run.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dir {
    Root16,
    Cluster(u32),
}

/// Where a file's directory entry lives (so it can be deleted or rewritten later).
#[derive(Clone, Copy, Debug)]
pub struct EntryLoc {
    pub offset: u64,
    /// Number of 32-byte entries (1 for FAT, 3+ for exFAT entry sets).
    pub count: u32,
}

pub struct Volume {
    pub fs: Fs,
    pub size: u64,
    pub cluster_bytes: u64,
    pub cluster_count: u32,
    /// Byte offset of cluster 2.
    pub data_start: u64,
    pub fat_start: u64,
    pub fat_bytes: u64,
    pub nfats: u32,
    pub root16_start: u64,
    pub root16_entries: u32,
    pub root_cluster: u32,
    pub bitmap_cluster: u32,
    pub serial: u32,
    /// In-memory allocation mirror (index = cluster number).
    pub in_use: Vec<bool>,
    pub next_hint: u32,
}

impl Volume {
    pub fn cluster_offset(&self, c: u32) -> u64 {
        self.data_start + (c as u64 - 2) * self.cluster_bytes
    }

    /// Cluster containing absolute byte offset, if in the data area.
    pub fn cluster_at(&self, off: u64) -> Option<u32> {
        if off < self.data_start {
            return None;
        }
        let c = ((off - self.data_start) / self.cluster_bytes) as u32 + 2;
        if c < self.cluster_count + 2 {
            Some(c)
        } else {
            None
        }
    }

    pub fn last_cluster(&self) -> u32 {
        self.cluster_count + 1
    }

    fn eoc(&self) -> u32 {
        match self.fs {
            Fs::Fat16 => 0xFFFF,
            Fs::Fat32 => 0x0FFF_FFFF,
            Fs::ExFat => 0xFFFF_FFFF,
        }
    }

    pub fn fat_get(&self, img: &SparseImage, c: u32) -> u32 {
        match self.fs {
            Fs::Fat16 => img.u16(self.fat_start + c as u64 * 2) as u32,
            Fs::Fat32 => img.u32(self.fat_start + c as u64 * 4) & 0x0FFF_FFFF,
            Fs::ExFat => img.u32(self.fat_start + c as u64 * 4),
        }
    }

    pub fn fat_set(&self, img: &mut SparseImage, c: u32, v: u32) {
        for f in 0..self.nfats as u64 {
            let base = self.fat_start + f * self.fat_bytes;
            match self.fs {
                Fs::Fat16 => img.put_u16(base + c as u64 * 2, v as u16),
                Fs::Fat32 => img.put_u32(base + c as u64 * 4, v & 0x0FFF_FFFF),
                Fs::ExFat => img.put_u32(base + c as u64 * 4, v),
            }
        }
    }

    fn bitmap_set(&self, img: &mut SparseImage, c: u32, used: bool) {
        if self.fs != Fs::ExFat {
            return;
        }
        let bit = (c - 2) as u64;
        let off = self.cluster_offset(self.bitmap_cluster) + bit / 8;
        let mut b = img.read_vec(off, 1)[0];
        if used {
            b |= 1 << (bit % 8);
        } else {
            b &= !(1 << (bit % 8));
        }
        img.write(off, &[b]);
    }

    pub fn mark(&mut self, img: &mut SparseImage, c: u32, used: bool) {
        self.in_use[c as usize] = used;
        self.bitmap_set(img, c, used);
    }

    /// Allocate `n` clusters by policy. Returns fewer when the card is full.
    pub fn alloc(&mut self, n: usize, policy: Policy) -> Vec<u32> {
        let mut out = Vec::with_capacity(n);
        let first = 2u32;
        let last = self.last_cluster();
        let mut c = match policy {
            Policy::NextFree => self.next_hint.clamp(first, last),
            Policy::FirstFree => first,
        };
        let mut scanned = 0u64;
        let total = self.cluster_count as u64;
        while out.len() < n && scanned < total {
            if !self.in_use[c as usize] {
                out.push(c);
            }
            c = if c >= last { first } else { c + 1 };
            scanned += 1;
        }
        if let Some(&l) = out.last() {
            self.next_hint = if l >= last { first } else { l + 1 };
        }
        out
    }

    /// Link a chain in the FAT (exFAT contiguous files skip this, like real cameras with NoFatChain).
    pub fn link_chain(&self, img: &mut SparseImage, chain: &[u32]) {
        for (i, &c) in chain.iter().enumerate() {
            let next = chain.get(i + 1).copied().unwrap_or(self.eoc());
            self.fat_set(img, c, next);
        }
    }

    pub fn free_chain_fat(&self, img: &mut SparseImage, chain: &[u32]) {
        for &c in chain {
            self.fat_set(img, c, 0);
        }
    }

    pub fn is_contiguous(chain: &[u32]) -> bool {
        chain.windows(2).all(|w| w[1] == w[0] + 1)
    }

    pub fn free_clusters(&self) -> u32 {
        self.in_use[2..].iter().filter(|u| !**u).count() as u32
    }

    // ---------------------------------------------------------------- formatting

    pub fn format(img: &mut SparseImage, fs: Fs, cluster_bytes: u64, serial: u32, label: &str) -> Volume {
        let total_sectors = img.size / SECTOR;
        let spc = (cluster_bytes / SECTOR).max(1);
        let mut v = match fs {
            Fs::Fat16 | Fs::Fat32 => {
                let fat16 = fs == Fs::Fat16;
                let reserved: u64 = if fat16 { 1 } else { 32 };
                let root_entries: u64 = if fat16 { 512 } else { 0 };
                let root_sectors = root_entries * 32 / SECTOR;
                let entry = if fat16 { 2 } else { 4 };
                // Solve FAT size iteratively.
                let mut fat_sectors = 1u64;
                loop {
                    let data_sectors = total_sectors.saturating_sub(reserved + 2 * fat_sectors + root_sectors);
                    let clusters = data_sectors / spc;
                    let need = ((clusters + 2) * entry).div_ceil(SECTOR);
                    if need <= fat_sectors {
                        break;
                    }
                    fat_sectors = need;
                }
                let data_start_s = reserved + 2 * fat_sectors + root_sectors;
                let clusters = (total_sectors - data_start_s) / spc;
                let clusters = if fat16 { clusters.min(65524) } else { clusters.min(0x0FFF_FFF5) };
                Volume {
                    fs,
                    size: img.size,
                    cluster_bytes: spc * SECTOR,
                    cluster_count: clusters as u32,
                    data_start: data_start_s * SECTOR,
                    fat_start: reserved * SECTOR,
                    fat_bytes: fat_sectors * SECTOR,
                    nfats: 2,
                    root16_start: (reserved + 2 * fat_sectors) * SECTOR,
                    root16_entries: root_entries as u32,
                    root_cluster: if fat16 { 0 } else { 2 },
                    bitmap_cluster: 0,
                    serial,
                    in_use: vec![false; clusters as usize + 2],
                    next_hint: 2,
                }
            }
            Fs::ExFat => {
                let fat_offset: u64 = 2048;
                let mut fat_len = 1u64;
                loop {
                    let heap = (fat_offset + fat_len).div_ceil(spc) * spc;
                    let clusters = total_sectors.saturating_sub(heap) / spc;
                    let need = ((clusters + 2) * 4).div_ceil(SECTOR);
                    if need <= fat_len {
                        break;
                    }
                    fat_len = need;
                }
                let heap = (fat_offset + fat_len).div_ceil(spc) * spc;
                let clusters = (total_sectors - heap) / spc;
                Volume {
                    fs,
                    size: img.size,
                    cluster_bytes: spc * SECTOR,
                    cluster_count: clusters as u32,
                    data_start: heap * SECTOR,
                    fat_start: fat_offset * SECTOR,
                    fat_bytes: fat_len * SECTOR,
                    nfats: 1,
                    root16_start: 0,
                    root16_entries: 0,
                    root_cluster: 0,
                    bitmap_cluster: 2,
                    serial,
                    in_use: vec![false; clusters as usize + 2],
                    next_hint: 2,
                }
            }
        };
        // Wipe metadata area (FATs and root) so a reformat really resets them; data clusters are untouched.
        let meta_end = match fs {
            Fs::Fat16 => v.data_start,
            _ => v.fat_start + v.fat_bytes * v.nfats as u64,
        };
        img.fill(0, meta_end, 0);
        v.write_boot(img, total_sectors, spc, label);
        match fs {
            Fs::Fat16 => {
                v.fat_set(img, 0, 0xFFF8);
                v.fat_set(img, 1, 0xFFFF);
            }
            Fs::Fat32 => {
                v.fat_set(img, 0, 0x0FFF_FFF8);
                v.fat_set(img, 1, 0x0FFF_FFFF);
                v.in_use[2] = true;
                v.fat_set(img, 2, v.eoc());
                img.fill(v.cluster_offset(2), v.cluster_bytes, 0);
                v.next_hint = 3;
            }
            Fs::ExFat => v.exfat_layout(img, label),
        }
        if fs == Fs::Fat16 {
            v.write_label_entry(img, Dir::Root16, label);
        } else if fs == Fs::Fat32 {
            v.write_label_entry(img, Dir::Cluster(2), label);
            v.update_fsinfo(img);
        }
        v
    }

    fn write_boot(&self, img: &mut SparseImage, total_sectors: u64, spc: u64, label: &str) {
        let mut b = vec![0u8; 512];
        let lab = pad(label, 11);
        match self.fs {
            Fs::Fat16 | Fs::Fat32 => {
                let fat16 = self.fs == Fs::Fat16;
                b[0..3].copy_from_slice(if fat16 { &[0xEB, 0x3C, 0x90] } else { &[0xEB, 0x58, 0x90] });
                b[3..11].copy_from_slice(b"REFRAG98");
                b[11..13].copy_from_slice(&512u16.to_le_bytes());
                b[13] = spc as u8;
                b[14..16].copy_from_slice(&((self.fat_start / SECTOR) as u16).to_le_bytes());
                b[16] = 2;
                b[17..19].copy_from_slice(&(self.root16_entries as u16).to_le_bytes());
                if total_sectors < 65536 {
                    b[19..21].copy_from_slice(&(total_sectors as u16).to_le_bytes());
                } else {
                    b[32..36].copy_from_slice(&(total_sectors as u32).to_le_bytes());
                }
                b[21] = 0xF8;
                b[24..26].copy_from_slice(&63u16.to_le_bytes());
                b[26..28].copy_from_slice(&255u16.to_le_bytes());
                let fat_sectors = (self.fat_bytes / SECTOR) as u32;
                if fat16 {
                    b[22..24].copy_from_slice(&(fat_sectors as u16).to_le_bytes());
                    b[36] = 0x80;
                    b[38] = 0x29;
                    b[39..43].copy_from_slice(&self.serial.to_le_bytes());
                    b[43..54].copy_from_slice(&lab);
                    b[54..62].copy_from_slice(b"FAT16   ");
                } else {
                    b[36..40].copy_from_slice(&fat_sectors.to_le_bytes());
                    b[44..48].copy_from_slice(&2u32.to_le_bytes());
                    b[48..50].copy_from_slice(&1u16.to_le_bytes());
                    b[50..52].copy_from_slice(&6u16.to_le_bytes());
                    b[64] = 0x80;
                    b[66] = 0x29;
                    b[67..71].copy_from_slice(&self.serial.to_le_bytes());
                    b[71..82].copy_from_slice(&lab);
                    b[82..90].copy_from_slice(b"FAT32   ");
                }
                b[510] = 0x55;
                b[511] = 0xAA;
                img.write(0, &b);
                if !fat16 {
                    img.write(6 * SECTOR, &b);
                    let mut fsinfo = vec![0u8; 512];
                    fsinfo[0..4].copy_from_slice(&0x4161_5252u32.to_le_bytes());
                    fsinfo[484..488].copy_from_slice(&0x6141_7272u32.to_le_bytes());
                    fsinfo[508..512].copy_from_slice(&0xAA55_0000u32.to_le_bytes());
                    img.write(SECTOR, &fsinfo);
                    img.write(7 * SECTOR, &fsinfo);
                }
            }
            Fs::ExFat => {
                b[0..3].copy_from_slice(&[0xEB, 0x76, 0x90]);
                b[3..11].copy_from_slice(b"EXFAT   ");
                b[72..80].copy_from_slice(&total_sectors.to_le_bytes());
                b[80..84].copy_from_slice(&((self.fat_start / SECTOR) as u32).to_le_bytes());
                b[84..88].copy_from_slice(&((self.fat_bytes / SECTOR) as u32).to_le_bytes());
                b[88..92].copy_from_slice(&((self.data_start / SECTOR) as u32).to_le_bytes());
                b[92..96].copy_from_slice(&self.cluster_count.to_le_bytes());
                // Root directory cluster is filled in by exfat_layout (written again there).
                b[100..104].copy_from_slice(&self.serial.to_le_bytes());
                b[104..106].copy_from_slice(&0x0100u16.to_le_bytes());
                b[108] = 9;
                b[109] = spc.trailing_zeros() as u8;
                b[110] = 1;
                b[111] = 0x80;
                b[510] = 0x55;
                b[511] = 0xAA;
                img.write(0, &b);
            }
        }
    }

    fn exfat_layout(&mut self, img: &mut SparseImage, label: &str) {
        let cb = self.cluster_bytes;
        let bitmap_bytes = (self.cluster_count as u64).div_ceil(8);
        let bitmap_clusters = bitmap_bytes.div_ceil(cb) as u32;
        let upcase = upcase_table();
        let upcase_clusters = (upcase.len() as u64).div_ceil(cb) as u32;
        let bitmap = 2u32;
        let up = bitmap + bitmap_clusters;
        let root = up + upcase_clusters;
        self.bitmap_cluster = bitmap;
        self.root_cluster = root;
        for c in 2..root + 1 {
            img.fill(self.cluster_offset(c), cb, 0);
        }
        for c in 2..=root {
            self.mark(img, c, true);
        }
        let chain_b: Vec<u32> = (bitmap..up).collect();
        let chain_u: Vec<u32> = (up..root).collect();
        self.link_chain(img, &chain_b);
        self.link_chain(img, &chain_u);
        self.link_chain(img, &[root]);
        self.fat_set(img, 0, 0xFFFF_FFF8);
        self.fat_set(img, 1, 0xFFFF_FFFF);
        self.next_hint = root + 1;
        img.write(self.cluster_offset(up), &upcase);
        // Root directory: label, bitmap, up-case.
        let ro = self.cluster_offset(root);
        let mut e = [0u8; 96];
        e[0] = 0x83;
        let name: Vec<u16> = label.encode_utf16().take(11).collect();
        e[1] = name.len() as u8;
        for (i, ch) in name.iter().enumerate() {
            e[2 + i * 2..4 + i * 2].copy_from_slice(&ch.to_le_bytes());
        }
        e[32] = 0x81;
        e[32 + 20..32 + 24].copy_from_slice(&bitmap.to_le_bytes());
        e[32 + 24..32 + 32].copy_from_slice(&bitmap_bytes.to_le_bytes());
        e[64] = 0x82;
        e[64 + 4..64 + 8].copy_from_slice(&checksum32(&upcase, None).to_le_bytes());
        e[64 + 20..64 + 24].copy_from_slice(&up.to_le_bytes());
        e[64 + 24..64 + 32].copy_from_slice(&(upcase.len() as u64).to_le_bytes());
        img.write(ro, &e);
        // Patch root cluster into boot sector, then build the 12-sector boot region + backup.
        img.put_u32(96, root);
        let mut region = img.read_vec(0, 512);
        region.resize(11 * 512, 0);
        for s in 1..9 {
            region[s * 512 + 510] = 0x55;
            region[s * 512 + 511] = 0xAA;
        }
        let sum = checksum32(&region, Some(&[106, 107, 112]));
        let mut chk = vec![0u8; 512];
        for i in 0..128 {
            chk[i * 4..i * 4 + 4].copy_from_slice(&sum.to_le_bytes());
        }
        region.extend_from_slice(&chk);
        img.write(0, &region);
        img.write(12 * SECTOR, &region);
    }

    pub fn update_fsinfo(&self, img: &mut SparseImage) {
        if self.fs != Fs::Fat32 {
            return;
        }
        let free = self.free_clusters();
        for base in [SECTOR, 7 * SECTOR] {
            img.put_u32(base + 488, free);
            img.put_u32(base + 492, self.next_hint);
        }
    }

    fn write_label_entry(&mut self, img: &mut SparseImage, dir: Dir, label: &str) {
        let mut e = [0u8; 32];
        e[0..11].copy_from_slice(&pad(label, 11));
        e[11] = 0x08;
        if let Some(off) = self.free_slot(img, dir, 1) {
            img.write(off, &e);
        }
    }

    // ---------------------------------------------------------------- directories

    /// Byte offsets of every 32-byte slot in a directory, following its chain.
    pub fn dir_slots(&self, img: &SparseImage, dir: Dir) -> Vec<u64> {
        match dir {
            Dir::Root16 => (0..self.root16_entries as u64).map(|i| self.root16_start + i * 32).collect(),
            Dir::Cluster(c) => {
                let mut out = Vec::new();
                let mut cur = c;
                let mut guard = 0;
                while cur >= 2 && cur <= self.last_cluster() && guard < 4096 {
                    let base = self.cluster_offset(cur);
                    for i in 0..self.cluster_bytes / 32 {
                        out.push(base + i * 32);
                    }
                    let next = self.fat_get(img, cur);
                    if next < 2 || next > self.last_cluster() {
                        break;
                    }
                    cur = next;
                    guard += 1;
                }
                out
            }
        }
    }

    /// Find `n` consecutive free slots (end marker, deleted, or exFAT unused), growing the directory if needed.
    fn free_slot(&mut self, img: &mut SparseImage, dir: Dir, n: usize) -> Option<u64> {
        let slots = self.dir_slots(img, dir);
        // Prefer never-used slots (keeps deleted entries around for undelete tools, like most FAT drivers
        // that append), then fall back to reusing deleted ones.
        for reuse in [false, true] {
            let mut run = 0usize;
            for (i, &off) in slots.iter().enumerate() {
                let t = img.read_vec(off, 1)[0];
                let free = match self.fs {
                    Fs::ExFat => if reuse { t & 0x80 == 0 } else { t == 0 },
                    _ => t == 0x00 || (reuse && t == 0xE5),
                };
                run = if free { run + 1 } else { 0 };
                if run == n {
                    return Some(slots[i + 1 - n]);
                }
            }
        }
        // Grow cluster directories by one cluster.
        if let Dir::Cluster(first) = dir {
            let mut last = first;
            loop {
                let next = self.fat_get(img, last);
                if next < 2 || next > self.last_cluster() {
                    break;
                }
                last = next;
            }
            let new = self.alloc(1, Policy::NextFree);
            let &c = new.first()?;
            self.mark(img, c, true);
            img.fill(self.cluster_offset(c), self.cluster_bytes, 0);
            self.fat_set(img, last, c);
            self.fat_set(img, c, self.eoc());
            return Some(self.cluster_offset(c));
        }
        None
    }

    /// Create a subdirectory and return it; None when the card has no free cluster left.
    pub fn mkdir(&mut self, img: &mut SparseImage, parent: Dir, name: &str, stamp: u32) -> Option<Dir> {
        let &c = self.alloc(1, Policy::NextFree).first()?;
        self.mark(img, c, true);
        img.fill(self.cluster_offset(c), self.cluster_bytes, 0);
        self.fat_set(img, c, self.eoc());
        let loc = self.write_entry(img, parent, name, c, self.cluster_bytes, true, stamp, false);
        let _ = loc;
        if self.fs != Fs::ExFat {
            let parent_c = match parent {
                Dir::Root16 => 0,
                Dir::Cluster(p) if p == self.root_cluster => 0,
                Dir::Cluster(p) => p,
            };
            let base = self.cluster_offset(c);
            img.write(base, &fat_entry(".          ", 0x10, c, 0, stamp));
            img.write(base + 32, &fat_entry("..         ", 0x10, parent_c, 0, stamp));
        }
        Some(Dir::Cluster(c))
    }

    /// Write a directory entry (or exFAT entry set). `contiguous` sets exFAT NoFatChain.
    #[allow(clippy::too_many_arguments)]
    pub fn write_entry(
        &mut self,
        img: &mut SparseImage,
        dir: Dir,
        name: &str,
        first: u32,
        size: u64,
        is_dir: bool,
        stamp: u32,
        contiguous: bool,
    ) -> EntryLoc {
        match self.fs {
            Fs::Fat16 | Fs::Fat32 => {
                let off = self.free_slot(img, dir, 1).unwrap_or(0);
                let e = fat_entry(&to83(name), if is_dir { 0x10 } else { 0x20 }, first, if is_dir { 0 } else { size as u32 }, stamp);
                if off != 0 {
                    img.write(off, &e);
                }
                EntryLoc { offset: off, count: 1 }
            }
            Fs::ExFat => {
                let units: Vec<u16> = name.encode_utf16().collect();
                let name_entries = units.len().div_ceil(15).max(1);
                let count = 2 + name_entries;
                let off = self.free_slot(img, dir, count).unwrap_or(0);
                let mut set = vec![0u8; count * 32];
                set[0] = 0x85;
                set[1] = (count - 1) as u8;
                set[4..6].copy_from_slice(&(if is_dir { 0x10u16 } else { 0x20u16 }).to_le_bytes());
                let ts = exfat_time(stamp);
                set[8..12].copy_from_slice(&ts.to_le_bytes());
                set[12..16].copy_from_slice(&ts.to_le_bytes());
                set[16..20].copy_from_slice(&ts.to_le_bytes());
                let s = &mut set[32..64];
                s[0] = 0xC0;
                s[1] = 0x01 | if contiguous { 0x02 } else { 0 };
                s[3] = units.len() as u8;
                s[4..6].copy_from_slice(&name_hash(&units).to_le_bytes());
                let alloc = if is_dir { self.cluster_bytes } else { size.div_ceil(self.cluster_bytes) * self.cluster_bytes };
                s[8..16].copy_from_slice(&(if is_dir { alloc } else { size }).to_le_bytes());
                s[20..24].copy_from_slice(&first.to_le_bytes());
                s[24..32].copy_from_slice(&alloc.to_le_bytes());
                for i in 0..name_entries {
                    let e = &mut set[64 + i * 32..96 + i * 32];
                    e[0] = 0xC1;
                    for j in 0..15 {
                        if let Some(&u) = units.get(i * 15 + j) {
                            e[2 + j * 2..4 + j * 2].copy_from_slice(&u.to_le_bytes());
                        }
                    }
                }
                let sum = checksum16(&set);
                set[2..4].copy_from_slice(&sum.to_le_bytes());
                if off != 0 {
                    img.write(off, &set);
                }
                EntryLoc { offset: off, count: count as u32 }
            }
        }
    }

    /// Mark an entry deleted the way the OS/camera does.
    /// FAT: first byte 0xE5; with `clear_high`, FAT32's high start-cluster word is zeroed (Windows behaviour).
    /// exFAT: clear the InUse bit of every entry in the set.
    pub fn delete_entry(&self, img: &mut SparseImage, loc: EntryLoc, clear_high: bool) {
        if loc.offset == 0 {
            return;
        }
        match self.fs {
            Fs::Fat16 | Fs::Fat32 => {
                img.write(loc.offset, &[0xE5]);
                if clear_high && self.fs == Fs::Fat32 {
                    img.put_u16(loc.offset + 20, 0);
                }
            }
            Fs::ExFat => {
                for i in 0..loc.count as u64 {
                    let o = loc.offset + i * 32;
                    let t = img.read_vec(o, 1)[0];
                    img.write(o, &[t & 0x7F]);
                }
            }
        }
    }

    /// Rewrite size field of an existing entry (power loss leaves size 0 etc.).
    pub fn set_entry_size(&self, img: &mut SparseImage, loc: EntryLoc, size: u64) {
        if loc.offset == 0 {
            return;
        }
        match self.fs {
            Fs::Fat16 | Fs::Fat32 => img.put_u32(loc.offset + 28, size as u32),
            Fs::ExFat => {
                let mut set = img.read_vec(loc.offset, loc.count as usize * 32);
                set[32 + 8..32 + 16].copy_from_slice(&size.to_le_bytes());
                let sum = checksum16(&set);
                set[2..4].copy_from_slice(&sum.to_le_bytes());
                img.write(loc.offset, &set);
            }
        }
    }

    /// Read every entry in a directory (including deleted ones), for undelete tools.
    pub fn read_dir(&self, img: &SparseImage, dir: Dir) -> Vec<DirEntry> {
        let slots = self.dir_slots(img, dir);
        let mut out = Vec::new();
        let mut i = 0;
        while i < slots.len() {
            let off = slots[i];
            let e = img.read_vec(off, 32);
            match self.fs {
                Fs::Fat16 | Fs::Fat32 => {
                    if e[0] == 0 {
                        break;
                    }
                    if e[11] & 0x08 == 0 && e[11] != 0x0F && e[0] != b'.' {
                        let hi = u16::from_le_bytes([e[20], e[21]]) as u32;
                        let lo = u16::from_le_bytes([e[26], e[27]]) as u32;
                        let mut raw = e[0..11].to_vec();
                        if raw[0] == 0xE5 {
                            raw[0] = b'_';
                        }
                        let name: String = raw.iter().map(|&b| if b.is_ascii_graphic() || b == b' ' { b as char } else { '_' }).collect();
                        out.push(DirEntry {
                            name: from83(&name),
                            first: if self.fs == Fs::Fat32 { (hi << 16) | lo } else { lo },
                            size: u32::from_le_bytes([e[28], e[29], e[30], e[31]]) as u64,
                            is_dir: e[11] & 0x10 != 0,
                            deleted: e[0] == 0xE5,
                            contiguous: false,
                        });
                    }
                    i += 1;
                }
                Fs::ExFat => {
                    let t = e[0];
                    if t == 0 {
                        break;
                    }
                    if t & 0x7F == 0x05 {
                        let secondary = e[1] as usize;
                        if i + secondary < slots.len() && secondary >= 2 {
                            let s = img.read_vec(slots[i + 1], 32);
                            let mut units = Vec::new();
                            for k in 0..secondary - 1 {
                                let n = img.read_vec(slots[i + 2 + k], 32);
                                for j in 0..15 {
                                    units.push(u16::from_le_bytes([n[2 + j * 2], n[3 + j * 2]]));
                                }
                            }
                            units.truncate(s[3] as usize);
                            out.push(DirEntry {
                                name: String::from_utf16_lossy(&units),
                                first: u32::from_le_bytes([s[20], s[21], s[22], s[23]]),
                                size: u64::from_le_bytes(s[8..16].try_into().unwrap()),
                                is_dir: u16::from_le_bytes([e[4], e[5]]) & 0x10 != 0,
                                deleted: t & 0x80 == 0,
                                contiguous: s[1] & 0x02 != 0,
                            });
                        }
                        i += 1 + secondary;
                    } else {
                        i += 1;
                    }
                }
            }
        }
        out
    }

    pub fn root(&self) -> Dir {
        match self.fs {
            Fs::Fat16 => Dir::Root16,
            _ => Dir::Cluster(self.root_cluster),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub first: u32,
    pub size: u64,
    pub is_dir: bool,
    pub deleted: bool,
    pub contiguous: bool,
}

fn pad(s: &str, n: usize) -> Vec<u8> {
    let mut v: Vec<u8> = s.bytes().map(|b| b.to_ascii_uppercase()).take(n).collect();
    v.resize(n, b' ');
    v
}

/// "IMG_0001.JPG" -> "IMG_0001JPG"
pub fn to83(name: &str) -> String {
    if name.len() == 11 && !name.contains('.') {
        return name.to_string();
    }
    let (base, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let mut s = String::from_utf8(pad(base, 8)).unwrap();
    s.push_str(&String::from_utf8(pad(ext, 3)).unwrap());
    s
}

fn from83(s: &str) -> String {
    let base = s.get(0..8).unwrap_or(s).trim_end();
    let ext = s.get(8..11).unwrap_or("").trim_end();
    if ext.is_empty() {
        base.to_string()
    } else {
        format!("{base}.{ext}")
    }
}

/// `stamp` = seconds since 2000-01-01 (no leap handling needed beyond plausibility).
fn dos_datetime(stamp: u32) -> (u16, u16) {
    let days = stamp / 86400;
    let secs = stamp % 86400;
    let year = 2000 + days / 365;
    let doy = days % 365;
    let month = (doy / 31 + 1).min(12);
    let day = (doy % 31 + 1).min(28);
    let date = (((year - 1980) << 9) | (month << 5) | day) as u16;
    let time = (((secs / 3600) << 11) | (((secs / 60) % 60) << 5) | ((secs % 60) / 2)) as u16;
    (date, time)
}

fn exfat_time(stamp: u32) -> u32 {
    let (d, t) = dos_datetime(stamp);
    ((d as u32) << 16) | t as u32
}

pub fn fat_entry(name11: &str, attr: u8, first: u32, size: u32, stamp: u32) -> [u8; 32] {
    let mut e = [0u8; 32];
    e[0..11].copy_from_slice(&pad(name11, 11));
    e[11] = attr;
    let (d, t) = dos_datetime(stamp);
    e[14..16].copy_from_slice(&t.to_le_bytes());
    e[16..18].copy_from_slice(&d.to_le_bytes());
    e[18..20].copy_from_slice(&d.to_le_bytes());
    e[20..22].copy_from_slice(&((first >> 16) as u16).to_le_bytes());
    e[22..24].copy_from_slice(&t.to_le_bytes());
    e[24..26].copy_from_slice(&d.to_le_bytes());
    e[26..28].copy_from_slice(&(first as u16).to_le_bytes());
    e[28..32].copy_from_slice(&size.to_le_bytes());
    e
}

fn checksum32(data: &[u8], skip: Option<&[usize]>) -> u32 {
    let mut c: u32 = 0;
    for (i, &b) in data.iter().enumerate() {
        if skip.is_some_and(|s| s.contains(&i)) {
            continue;
        }
        c = c.rotate_right(1).wrapping_add(b as u32);
    }
    c
}

fn checksum16(set: &[u8]) -> u16 {
    let mut c: u16 = 0;
    for (i, &b) in set.iter().enumerate() {
        if i == 2 || i == 3 {
            continue;
        }
        c = c.rotate_right(1).wrapping_add(b as u16);
    }
    c
}

fn name_hash(units: &[u16]) -> u16 {
    let mut h: u16 = 0;
    for &u in units {
        let u = if (b'a' as u16..=b'z' as u16).contains(&u) { u - 32 } else { u };
        for b in u.to_le_bytes() {
            h = h.rotate_right(1).wrapping_add(b as u16);
        }
    }
    h
}

/// Compressed exFAT up-case table: identity except ASCII a-z.
fn upcase_table() -> Vec<u8> {
    let mut t: Vec<u16> = Vec::new();
    t.extend([0xFFFF, 0x61]);
    for c in b'a'..=b'z' {
        t.push((c - 32) as u16);
    }
    t.extend([0xFFFF, (0x1_0000u32 - 0x7B) as u16]);
    t.iter().flat_map(|u| u.to_le_bytes()).collect()
}
