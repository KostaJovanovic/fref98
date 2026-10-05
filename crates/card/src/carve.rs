//! Recovery tools run against the raw card bytes, the way the real ones do:
//! PhotoRec-style header carving, header-graft-style body rebuilding, Recuva-style undelete,
//! thumbnail carving and plain file-system reads.

use crate::card::Card;
use crate::fs::{Dir, Fs};
use crate::jpeg;
use serde::Serialize;

#[derive(Clone, Serialize, Debug)]
pub struct Recovered {
    pub name: String,
    pub size: usize,
    pub source_clusters: Vec<u32>,
    pub note: String,
    #[serde(skip)]
    pub data: Vec<u8>,
}

const MAX_FILE: usize = 48 << 20;

fn cluster_bytes(card: &Card, c: u32) -> Vec<u8> {
    card.img.read_vec(card.vol.cluster_offset(c), card.vol.cluster_bytes as usize)
}

fn read_chain(card: &Card, chain: &[u32], size: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(size);
    for &c in chain {
        if out.len() >= size {
            break;
        }
        out.extend_from_slice(&cluster_bytes(card, c));
    }
    out.truncate(size);
    out
}

/// Follow a FAT chain from `first` (loop-safe).
pub fn fat_chain(card: &Card, first: u32, max_len: usize) -> Vec<u32> {
    let mut out = Vec::new();
    let mut c = first;
    let last = card.vol.last_cluster();
    while c >= 2 && c <= last && out.len() < max_len {
        if out.contains(&c) {
            break;
        }
        out.push(c);
        c = card.vol.fat_get(&card.img, c);
    }
    out
}

/// How `fs_read` treats deleted entries.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Undelete {
    /// Only live files.
    None,
    /// Recuva-style: an exFAT chain that survived the delete is followed; otherwise the file's clusters
    /// are taken from its start on, skipping clusters another file uses now.
    Recuva,
    /// The plain assumption: one contiguous run from the start cluster.
    Contiguous,
}

pub fn carve(card: &Card, tool: &str, opts: &serde_json::Value) -> Vec<Recovered> {
    match tool {
        "fat" => fs_read(card, Undelete::None),
        "recuva" => fs_read(card, Undelete::Recuva),
        "undelete_contiguous" => fs_read(card, Undelete::Contiguous),
        "thumbnails" => thumbnails(card),
        "graft" => {
            let mut v = photorec(card);
            v.extend(graft(card, &v, opts));
            v
        }
        _ => photorec(card),
    }
}

/// PhotoRec: look for file headers at the start of every cluster, read forward contiguously until the
/// end marker or until another file's header shows up.
pub fn photorec(card: &Card) -> Vec<Recovered> {
    let mut out = Vec::new();
    let cb = card.vol.cluster_bytes;
    let last = card.vol.last_cluster();
    let mut c = 2u32;
    while c <= last {
        let off = card.vol.cluster_offset(c);
        // only a cluster that is blank all through: an old header can sit further in (after a reformat)
        if card.img.is_blank_range(off, cb) {
            c += 1;
            continue;
        }
        let head = card.img.read_vec(off, 12);
        let is_jpeg = head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF;
        let is_riff = &head[0..4] == b"RIFF" && &head[8..12] == b"AVI ";
        if !is_jpeg && !is_riff {
            // After a reformat with another cluster size, old files no longer start on the cluster
            // grid. PhotoRec checks every sector, so look for a JPEG header inside the cluster too.
            let cl = cluster_bytes(card, c);
            let hit = (512..cl.len().saturating_sub(3)).step_by(512).find(|&s| cl[s] == 0xFF && cl[s + 1] == 0xD8 && cl[s + 2] == 0xFF);
            match hit {
                Some(s) => {
                    let (r, used) = carve_jpeg_at(card, off + s as u64, c);
                    out.push(r);
                    c += used;
                }
                None => c += 1,
            }
            continue;
        }
        let sector = off / 512;
        if is_riff {
            let size = (u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize + 8).min(MAX_FILE);
            let n = size.div_ceil(cb as usize) as u32;
            let chain: Vec<u32> = (c..(c + n).min(last + 1)).collect();
            let data = read_chain(card, &chain, size);
            out.push(Recovered {
                name: format!("f{:07}.avi", sector),
                size: data.len(),
                source_clusters: chain.clone(),
                note: "AVI carved by RIFF size (assumed contiguous)".into(),
                data,
            });
            c += n.max(1);
            continue;
        }
        let (r, used) = carve_jpeg_at(card, off, c);
        out.push(r);
        c += used;
    }
    out
}

/// Cluster holding byte `off` of the data area (None before cluster 2 / past the end).
pub fn cluster_at(card: &Card, off: u64) -> Option<u32> {
    card.vol.cluster_at(off)
}

/// PhotoRec's JPEG carve from byte `start` (cluster `c` holds it): read block by block (one
/// cluster each) until the end marker inside entropy data, or until a block is blank or starts
/// with another file's header. Returns the file and how many clusters to skip.
fn carve_jpeg_at(card: &Card, start: u64, c: u32) -> (Recovered, u32) {
    let cb = card.vol.cluster_bytes;
    let end_of_card = card.vol.cluster_offset(card.vol.last_cluster()) + cb;
    let mut buf = Vec::new();
    let mut chain: Vec<u32> = Vec::new();
    let mut end = None;
    let mut scan_from: Option<usize> = None;
    let mut at = start;
    while at < end_of_card && buf.len() < MAX_FILE {
        let len = cb.min(end_of_card - at);
        if at != start && card.img.is_blank_range(at, len) {
            break;
        }
        let cl = card.img.read_vec(at, len as usize);
        if at != start && jpeg::known_header(&cl) {
            break;
        }
        let prev = buf.len();
        buf.extend_from_slice(&cl);
        for o in [at, at + len - 1] {
            if let Some(k) = cluster_at(card, o) {
                if chain.last() != Some(&k) {
                    chain.push(k);
                }
            }
        }
        // EOI can only be trusted inside entropy data (EXIF thumbnails have their own EOI in the header).
        if scan_from.is_none() {
            scan_from = jpeg::scan_start(&buf);
        }
        if let Some(s) = scan_from {
            let from = s.max(prev.saturating_sub(1));
            if let Some(p) = buf[from..].windows(2).position(|w| w == [0xFF, 0xD9]) {
                end = Some(from + p + 2);
                break;
            }
        }
        at += len;
    }
    let (data, note) = match end {
        Some(e) => {
            buf.truncate(e);
            (buf, "complete: header to end marker".to_string())
        }
        None => (buf, "no end marker found: stopped at the next file header".to_string()),
    };
    if end.is_some() {
        // Only clusters that really hold the file's bytes.
        let last = cluster_at(card, start + data.len() as u64 - 1);
        if let Some(l) = last {
            chain.retain(|&k| k <= l);
        }
    }
    let mut used = chain.iter().filter(|&&k| k >= c).count().max(1) as u32;
    if start != card.vol.cluster_offset(c) {
        // Off-grid file: its last cluster may also hold the start of the next old file.
        used = used.saturating_sub(1).max(1);
    }
    let r = Recovered { name: format!("f{:07}.jpg", start / 512), size: data.len(), source_clusters: chain, note, data };
    (r, used)
}

/// header-graft recovery: runs of headerless JPEG-body clusters that no carved file claimed get a donor header
/// (SOI+DQT+SOF+DHT+SOS from a good photo), split at every end marker; damaged markers neutralised.
pub fn graft(card: &Card, carved: &[Recovered], opts: &serde_json::Value) -> Vec<Recovered> {
    use refragmenter_codec::step::get_i64;
    let min_kb = get_i64(opts, "min_kb", 256).max(16) as usize;
    let piece_kb = get_i64(opts, "piece_kb", 128).max(8) as usize;
    let mut claimed = vec![false; card.vol.last_cluster() as usize + 1];
    for r in carved {
        for &c in &r.source_clusters {
            claimed[c as usize] = true;
        }
    }
    let donor = carved
        .iter()
        .filter(|r| r.name.ends_with(".jpg") && r.note.starts_with("complete"))
        .max_by_key(|r| r.size)
        .and_then(|r| jpeg::header(&r.data, true))
        .or_else(|| card.photos.first().and_then(|p| jpeg::header(p, true)));
    let Some(hdr) = donor else { return Vec::new() };
    let cb = card.vol.cluster_bytes as usize;
    let min_clusters = (min_kb * 1024).div_ceil(cb).max(1);
    let mut out = Vec::new();
    let last = card.vol.last_cluster();
    let mut c = 2u32;
    while c <= last {
        let body = |k: u32| -> bool {
            if claimed[k as usize] || card.img.is_blank_range(card.vol.cluster_offset(k), card.vol.cluster_bytes) {
                return false;
            }
            jpeg::classify(&cluster_bytes(card, k)) == jpeg::Kind::JpegBody
        };
        if !body(c) {
            c += 1;
            continue;
        }
        let start = c;
        while c <= last && body(c) {
            c += 1;
        }
        let len = (c - start) as usize;
        if len < min_clusters {
            continue;
        }
        let chain: Vec<u32> = (start..c).collect();
        let mut seg = read_chain(card, &chain, len * cb);
        // Skip leftover header bytes: begin after an SOS in the first cluster if present.
        let mut o = 0usize;
        for k in 0..cb.min(seg.len()).saturating_sub(4) {
            if seg[k] == 0xFF && seg[k + 1] == 0xDA {
                o = k + 2 + u16::from_be_bytes([seg[k + 2], seg[k + 3]]) as usize;
                break;
            }
        }
        let mut cuts = vec![o];
        for k in o..seg.len().saturating_sub(1) {
            if seg[k] == 0xFF && seg[k + 1] == 0xD9 {
                cuts.push(k + 2);
            }
        }
        if *cuts.last().unwrap() < seg.len() {
            cuts.push(seg.len());
        }
        for p in 0..cuts.len() - 1 {
            let (po, pe) = (cuts[p], cuts[p + 1]);
            if pe - po < piece_kb * 1024 {
                continue;
            }
            let mut piece = seg[po..pe].to_vec();
            jpeg::neutralise_markers(&mut piece);
            let mut file = hdr.clone();
            file.extend_from_slice(&piece);
            let src: Vec<u32> = chain[po / cb..(pe.div_ceil(cb)).min(chain.len())].to_vec();
            out.push(Recovered {
                name: format!("orphan_{:05}_{:02}_{}KB.jpg", start, p, (pe - po) / 1024),
                size: file.len(),
                source_clusters: src,
                note: "rebuilt: donor header + orphaned body clusters".into(),
                data: file,
            });
        }
        seg.clear();
    }
    out
}

/// Read files through the file system; with `mode` other than None also deleted entries, from their
/// (possibly damaged) start cluster.
pub fn fs_read(card: &Card, mode: Undelete) -> Vec<Recovered> {
    let undelete = mode != Undelete::None;
    let mut out = Vec::new();
    let mut stack: Vec<(Dir, String, bool, u32)> = vec![(card.vol.root(), String::new(), false, 0)];
    let cb = card.vol.cluster_bytes as usize;
    let last = card.vol.last_cluster();
    let mut visited = Vec::new();
    while let Some((dir, path, dir_deleted, depth)) = stack.pop() {
        if depth > 6 || visited.contains(&dir) {
            continue;
        }
        visited.push(dir);
        for e in card.vol.read_dir(&card.img, dir) {
            let deleted = e.deleted || dir_deleted;
            if deleted && !undelete {
                continue;
            }
            if e.is_dir {
                if e.first >= 2 && e.first <= last {
                    stack.push((Dir::Cluster(e.first), format!("{path}{}/", e.name), deleted, depth + 1));
                }
                continue;
            }
            if e.size == 0 {
                if undelete {
                    out.push(Recovered {
                        name: format!("{path}{}", e.name),
                        size: 0,
                        source_clusters: vec![],
                        note: "0 bytes in directory entry (interrupted write?)".into(),
                        data: vec![],
                    });
                }
                continue;
            }
            if e.first < 2 || e.first > last {
                if undelete {
                    out.push(Recovered {
                        name: format!("{path}{}", e.name),
                        size: 0,
                        source_clusters: vec![],
                        note: format!("start cluster {} is outside the card: can't recover", e.first),
                        data: vec![],
                    });
                }
                continue;
            }
            let size = (e.size as usize).min(MAX_FILE);
            let n = size.div_ceil(cb);
            let exfat_chain = card.vol.fs == Fs::ExFat && !e.contiguous;
            let (chain, note) = if !deleted && !(card.vol.fs == Fs::ExFat && e.contiguous) {
                (fat_chain(card, e.first, n), "read through the FAT chain".to_string())
            } else if mode == Undelete::Recuva && exfat_chain {
                // exFAT deletes leave the FAT alone: the fragmented file's chain is still there
                (fat_chain(card, e.first, n), "undeleted along the FAT chain exFAT kept".to_string())
            } else if mode == Undelete::Recuva {
                let mut chain = Vec::with_capacity(n);
                let mut c = e.first;
                while chain.len() < n && c <= last {
                    if !card.vol.in_use[c as usize] {
                        chain.push(c);
                    }
                    c += 1;
                }
                (chain, "undeleted from the start cluster on, skipping clusters in use by other files".to_string())
            } else {
                let chain: Vec<u32> = (e.first..(e.first + n as u32).min(last + 1)).collect();
                let note = if deleted {
                    if card.vol.fs == Fs::Fat32 {
                        "undeleted assuming contiguous clusters (FAT32 cleared the high start-cluster bits)".to_string()
                    } else {
                        "undeleted assuming contiguous clusters".to_string()
                    }
                } else {
                    "contiguous file (exFAT NoFatChain)".to_string()
                };
                (chain, note)
            };
            let data = read_chain(card, &chain, size);
            let mut name = format!("{path}{}", e.name);
            if deleted && card.vol.fs != Fs::ExFat {
                name = name.replacen("/_", "/~", 1);
            }
            out.push(Recovered { name, size: data.len(), source_clusters: chain, note, data });
        }
    }
    out
}

/// Embedded thumbnails (EXIF IFD1, .THM sidecars): small JPEGs anywhere in written data.
pub fn thumbnails(card: &Card) -> Vec<Recovered> {
    let mut out = Vec::new();
    let cb = card.vol.cluster_bytes as usize;
    let last = card.vol.last_cluster();
    let mut seen_end = 0u64;
    for c in 2..=last {
        let off = card.vol.cluster_offset(c);
        if card.img.is_blank_range(off, cb as u64) {
            continue;
        }
        // two bytes of the next cluster too, so an SOI split across the boundary is seen
        let cl = card.img.read_vec(off, cb + 2);
        let mut i = 0;
        while i < cb && i + 3 <= cl.len() {
            if cl[i] == 0xFF && cl[i + 1] == 0xD8 && cl[i + 2] == 0xFF {
                let abs = off + i as u64;
                if abs >= seen_end {
                    let window = card.img.read_vec(abs, 256 * 1024);
                    if let Some(end) = jpeg::find_end(&window, window.len()) {
                        let at_cluster_start = i == 0;
                        // Full-size photos start at cluster boundaries and are big; thumbnails are small.
                        if (1024..160 * 1024).contains(&end) && (!at_cluster_start || end < 64 * 1024) {
                            let mut data = window[..end].to_vec();
                            let first = card.vol.cluster_at(abs).unwrap_or(c);
                            let lastc = card.vol.cluster_at(abs + end as u64 - 1).unwrap_or(c);
                            // What sits in front of it tells a carver where it came from.
                            let pre = if abs >= 12 { card.img.read_vec(abs - 12, 12) } else { Vec::new() };
                            let xp_header = pre.len() == 12
                                && pre[0..4] == [12, 0, 0, 0]
                                && u32::from_le_bytes([pre[8], pre[9], pre[10], pre[11]]) as usize == end;
                            let has_dht = jpeg::header(&data, false).is_some_and(|h| h.windows(2).any(|w| w == [0xFF, 0xC4]));
                            let note = if !has_dht {
                                // Motion-JPEG frame from an AVI: no Huffman tables, so a carver inserts the standard ones.
                                data = refragmenter_codec::avi::ensure_dht(&data);
                                "MJPEG movie frame (no Huffman tables; standard ones inserted)"
                            } else if xp_header {
                                "thumbnail from a Windows Thumbs.db cache"
                            } else if at_cluster_start {
                                "small JPEG file (.THM sidecar)"
                            } else {
                                "embedded EXIF thumbnail"
                            };
                            out.push(Recovered {
                                name: format!("t{:07}_{:04}.jpg", abs / 512, abs % 512),
                                size: data.len(),
                                source_clusters: (first..=lastc).collect(),
                                note: note.into(),
                                data,
                            });
                            seen_end = abs + end as u64;
                        }
                    }
                }
            }
            i += 1;
        }
    }
    out
}
