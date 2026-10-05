//! Minimal EXIF (TIFF) reader/writer: forgiving parse with loop protection, rebuild with
//! relocated values, private-field stripping, orientation and embedded thumbnails.

use crate::markers::{segment, walk, APP1};

#[derive(Clone, Debug)]
pub struct Entry {
    pub tag: u16,
    pub typ: u16,
    pub count: u32,
    /// Raw value bytes in the file's byte order.
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct Tiff {
    pub le: bool,
    pub ifd0: Vec<Entry>,
    pub exif: Vec<Entry>,
    pub gps: Vec<Entry>,
    pub ifd1: Vec<Entry>,
    pub thumb: Option<Vec<u8>>,
}

const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_GPS_IFD: u16 = 0x8825;
const TAG_INTEROP: u16 = 0xA005;
const TAG_THUMB_OFF: u16 = 0x0201;
const TAG_THUMB_LEN: u16 = 0x0202;
pub const TAG_ORIENTATION: u16 = 0x0112;

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 => 4,
        5 | 10 | 12 => 8,
        _ => 1,
    }
}

struct Rd<'a> {
    d: &'a [u8],
    le: bool,
    /// Bytes the value copies may still take. Entries (and whole IFDs) can all point at the same
    /// bytes, so without a budget one 64 KB block expands to ~90 MB of copies.
    budget: std::cell::Cell<usize>,
}
impl Rd<'_> {
    /// `d[o..o + n]`, with the offset arithmetic checked (a u32 offset can overflow usize on wasm32).
    fn slice(&self, o: usize, n: usize) -> Option<&[u8]> {
        self.d.get(o..o.checked_add(n)?)
    }
    fn u16(&self, o: usize) -> Option<u16> {
        let b = self.slice(o, 2)?;
        Some(if self.le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    }
    fn u32(&self, o: usize) -> Option<u32> {
        let b = self.slice(o, 4)?;
        Some(if self.le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) })
    }
    /// Returns entries and the next-IFD offset.
    fn ifd(&self, off: usize) -> (Vec<Entry>, u32) {
        let mut out = Vec::new();
        let Some(n) = self.u16(off) else { return (out, 0) };
        for i in 0..(n as usize).min(512) {
            let Some(e) = off.checked_add(2 + i * 12) else { break };
            let (Some(tag), Some(typ), Some(count)) = (self.u16(e), self.u16(e + 2), self.u32(e + 4)) else { break };
            let size = type_size(typ).saturating_mul(count as usize);
            if size > 1 << 20 || size > self.budget.get() {
                continue;
            }
            let data = if size <= 4 { self.slice(e + 8, size) } else { self.u32(e + 8).and_then(|o| self.slice(o as usize, size)) };
            if let Some(data) = data {
                self.budget.set(self.budget.get() - size);
                out.push(Entry { tag, typ, count, data: data.to_vec() });
            }
        }
        let next = off.checked_add(2 + n as usize * 12).and_then(|o| self.u32(o)).unwrap_or(0);
        (out, next)
    }
}

impl Tiff {
    /// Parse an APP1 payload ("Exif\0\0" + TIFF).
    pub fn parse(app1: &[u8]) -> Option<Tiff> {
        let t = app1.strip_prefix(b"Exif\0\0")?;
        let le = match t.get(0..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        // Real values all lie inside the block, so twice its size is plenty for honest files.
        let r = Rd { d: t, le, budget: std::cell::Cell::new(t.len() * 2) };
        let ifd0_off = r.u32(4)? as usize;
        let (ifd0, next) = r.ifd(ifd0_off);
        let ptr = |entries: &[Entry], tag: u16| -> Option<usize> {
            let e = entries.iter().find(|e| e.tag == tag)?;
            let b = e.data.get(0..4)?;
            Some(if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } as usize)
        };
        // Each IFD is read once: Exif, GPS and IFD1 pointing at an IFD already read are ignored.
        let mut seen = vec![ifd0_off];
        let mut once = |o: usize| -> Option<usize> {
            if seen.contains(&o) {
                return None;
            }
            seen.push(o);
            Some(o)
        };
        let exif = ptr(&ifd0, TAG_EXIF_IFD).and_then(&mut once).map(|o| r.ifd(o).0).unwrap_or_default();
        let gps = ptr(&ifd0, TAG_GPS_IFD).and_then(&mut once).map(|o| r.ifd(o).0).unwrap_or_default();
        let mut ifd1 = Vec::new();
        let mut thumb = None;
        if next != 0 && once(next as usize).is_some() {
            ifd1 = r.ifd(next as usize).0;
            let off = ifd1.iter().find(|e| e.tag == TAG_THUMB_OFF).and_then(|e| entry_u32(e, le));
            let len = ifd1.iter().find(|e| e.tag == TAG_THUMB_LEN).and_then(|e| entry_u32(e, le));
            if let (Some(o), Some(l)) = (off, len) {
                thumb = t.get(o as usize..(o as usize).saturating_add(l as usize)).map(|s| s.to_vec());
            }
        }
        Some(Tiff { le, ifd0, exif, gps, ifd1, thumb })
    }

    fn put16(&self, v: &mut Vec<u8>, x: u16) {
        v.extend_from_slice(&if self.le { x.to_le_bytes() } else { x.to_be_bytes() });
    }
    fn put32(&self, v: &mut Vec<u8>, x: u32) {
        v.extend_from_slice(&if self.le { x.to_le_bytes() } else { x.to_be_bytes() });
    }
    fn enc32(&self, x: u32) -> Vec<u8> {
        let mut v = Vec::new();
        self.put32(&mut v, x);
        v
    }
    fn enc16(&self, x: u16) -> Vec<u8> {
        let mut v = Vec::new();
        self.put16(&mut v, x);
        v
    }

    /// Serialise as an APP1 payload.
    pub fn write(&self) -> Vec<u8> {
        let strip = |v: &[Entry], tags: &[u16]| -> Vec<Entry> { v.iter().filter(|e| !tags.contains(&e.tag)).cloned().collect() };
        let mut ifd0 = strip(&self.ifd0, &[TAG_EXIF_IFD, TAG_GPS_IFD]);
        let exif = strip(&self.exif, &[TAG_INTEROP]);
        if !exif.is_empty() {
            ifd0.push(Entry { tag: TAG_EXIF_IFD, typ: 4, count: 1, data: vec![0; 4] });
        }
        if !self.gps.is_empty() {
            ifd0.push(Entry { tag: TAG_GPS_IFD, typ: 4, count: 1, data: vec![0; 4] });
        }
        ifd0.sort_by_key(|e| e.tag);
        let mut ifd1 = strip(&self.ifd1, &[TAG_THUMB_OFF, TAG_THUMB_LEN]);
        if self.thumb.is_some() {
            ifd1.push(Entry { tag: TAG_THUMB_OFF, typ: 4, count: 1, data: vec![0; 4] });
            ifd1.push(Entry { tag: TAG_THUMB_LEN, typ: 4, count: 1, data: self.enc32(self.thumb.as_ref().map(|t| t.len()).unwrap_or(0) as u32) });
            if !ifd1.iter().any(|e| e.tag == 0x0103) {
                ifd1.push(Entry { tag: 0x0103, typ: 3, count: 1, data: [self.enc16(6), vec![0, 0]].concat() });
            }
            ifd1.sort_by_key(|e| e.tag);
        }
        let ifd_size = |v: &[Entry]| 2 + v.len() * 12 + 4 + v.iter().map(|e| if e.data.len() > 4 { (e.data.len() + 1) & !1 } else { 0 }).sum::<usize>();
        let off0 = 8usize;
        let off_exif = off0 + ifd_size(&ifd0);
        let off_gps = off_exif + if exif.is_empty() { 0 } else { ifd_size(&exif) };
        let off1 = off_gps + if self.gps.is_empty() { 0 } else { ifd_size(&self.gps) };
        let off_thumb = off1 + if ifd1.is_empty() { 0 } else { ifd_size(&ifd1) };
        for e in ifd0.iter_mut() {
            if e.tag == TAG_EXIF_IFD {
                e.data = self.enc32(off_exif as u32);
            }
            if e.tag == TAG_GPS_IFD {
                e.data = self.enc32(off_gps as u32);
            }
        }
        for e in ifd1.iter_mut() {
            if e.tag == TAG_THUMB_OFF {
                e.data = self.enc32(off_thumb as u32);
            }
        }
        let mut t = Vec::new();
        t.extend_from_slice(if self.le { b"II" } else { b"MM" });
        self.put16(&mut t, 42);
        self.put32(&mut t, 8);
        let write_ifd = |t: &mut Vec<u8>, v: &[Entry], start: usize, next: u32| {
            let mut extra = Vec::new();
            let data_start = start + 2 + v.len() * 12 + 4;
            self.put16(t, v.len() as u16);
            for e in v {
                self.put16(t, e.tag);
                self.put16(t, e.typ);
                self.put32(t, e.count);
                if e.data.len() <= 4 {
                    let mut d = e.data.clone();
                    d.resize(4, 0);
                    t.extend_from_slice(&d);
                } else {
                    self.put32(t, (data_start + extra.len()) as u32);
                    extra.extend_from_slice(&e.data);
                    if extra.len() % 2 == 1 {
                        extra.push(0);
                    }
                }
            }
            self.put32(t, next);
            t.extend_from_slice(&extra);
        };
        write_ifd(&mut t, &ifd0, off0, if ifd1.is_empty() { 0 } else { off1 as u32 });
        if !exif.is_empty() {
            write_ifd(&mut t, &exif, off_exif, 0);
        }
        if !self.gps.is_empty() {
            write_ifd(&mut t, &self.gps, off_gps, 0);
        }
        if !ifd1.is_empty() {
            write_ifd(&mut t, &ifd1, off1, 0);
        }
        if let Some(th) = &self.thumb {
            t.extend_from_slice(th);
        }
        let mut out = b"Exif\0\0".to_vec();
        out.extend(t);
        out
    }

    pub fn set_short(&mut self, ifd0: bool, tag: u16, v: u16) {
        let data = [self.enc16(v), vec![0, 0]].concat();
        let list = if ifd0 { &mut self.ifd0 } else { &mut self.exif };
        list.retain(|e| e.tag != tag);
        list.push(Entry { tag, typ: 3, count: 1, data: data[..2].to_vec() });
        list.sort_by_key(|e| e.tag);
    }

    pub fn set_ascii(&mut self, tag: u16, s: &str) {
        let mut d = s.as_bytes().to_vec();
        d.push(0);
        self.ifd0.retain(|e| e.tag != tag);
        self.ifd0.push(Entry { tag, typ: 2, count: d.len() as u32, data: d });
        self.ifd0.sort_by_key(|e| e.tag);
    }
}

fn entry_u32(e: &Entry, le: bool) -> Option<u32> {
    match e.typ {
        3 => {
            let b = e.data.get(0..2)?;
            Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) } as u32)
        }
        _ => {
            let b = e.data.get(0..4)?;
            Some(if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) })
        }
    }
}

/// Minimal little-endian ("II", like Canon) Exif APP1 payload with Make / Model / Orientation.
pub fn minimal(make: &str, model: &str) -> Vec<u8> {
    let mut t = Tiff { le: true, ..Default::default() };
    t.set_ascii(0x010F, make);
    t.set_ascii(0x0110, model);
    t.set_short(true, TAG_ORIENTATION, 1);
    t.write()
}

/// Index of the first Exif APP1 segment in the file layout.
fn exif_segment(d: &[u8]) -> Option<(usize, usize, usize)> {
    let l = walk(d);
    for s in &l.segments {
        if s.marker == 0xDA {
            break;
        }
        if s.marker == APP1 && s.payload(d).starts_with(b"Exif\0\0") {
            return Some((s.offset, s.offset + s.length, s.start));
        }
    }
    None
}

pub fn read(d: &[u8]) -> Option<Tiff> {
    let (_, end, start) = exif_segment(d)?;
    Tiff::parse(&d[start..end])
}

/// Where the Exif thumbnail (IFD1 JPEGInterchangeFormat) lies in the file, as (offset, length), when it lies
/// inside the Exif block. The one thumbnail reader: the card crate uses it too.
pub fn thumbnail_range(d: &[u8]) -> Option<(usize, usize)> {
    let (_, end, start) = exif_segment(d)?;
    let t = Tiff::parse(&d[start..end])?;
    let get = |tag: u16| t.ifd1.iter().find(|e| e.tag == tag).and_then(|e| entry_u32(e, t.le)).map(|v| v as usize);
    let (off, len) = (get(TAG_THUMB_OFF)?, get(TAG_THUMB_LEN)?);
    // the TIFF header starts after "Exif\0\0"
    let at = start.checked_add(6)?.checked_add(off)?;
    (len > 0 && at.checked_add(len)? <= end).then_some((at, len))
}

/// Replace (or insert after SOI / APP0) the Exif APP1 with a new payload.
pub fn replace_app1(d: &[u8], payload: Option<Vec<u8>>) -> Vec<u8> {
    let new_seg = payload.map(|p| segment(APP1, &p)).unwrap_or_default();
    if let Some((a, b, _)) = exif_segment(d) {
        let mut out = d[..a].to_vec();
        out.extend(new_seg);
        out.extend_from_slice(&d[b..]);
        return out;
    }
    // Insert after SOI and a JFIF APP0 if present.
    let mut at = if d.starts_with(&[0xFF, 0xD8]) { 2 } else { 0 };
    let l = walk(d);
    if let Some(s) = l.segments.iter().find(|s| s.offset == at && s.marker == 0xE0) {
        at = s.offset + s.length;
    }
    let mut out = d[..at].to_vec();
    out.extend(new_seg);
    out.extend_from_slice(&d[at..]);
    out
}

/// Tags that can identify a person, a device or a place.
const PRIVATE: [u16; 20] = [
    0x010E, // ImageDescription
    0x013B, // Artist
    0x013C, // HostComputer
    0x8298, // Copyright
    0x9286, // UserComment
    0x927C, // MakerNote (serial numbers, owner, often GPS)
    0x9C9B, // XPTitle
    0x9C9C, // XPComment
    0x9C9D, // XPAuthor
    0x9C9E, // XPKeywords
    0x9C9F, // XPSubject
    0xA420, // ImageUniqueID
    0xA430, // CameraOwnerName
    0xA431, // BodySerialNumber
    0xA432, // LensSpecification
    0xA433, // LensMake
    0xA435, // LensSerialNumber
    0xA437, // Photographer
    0xA438, // ImageEditor
    0xC62F, // CameraSerialNumber (DNG)
];

/// Remove GPS, serial numbers, owner names and maker notes; keep orientation and the rest of the
/// Exif. XMP (APP1) and Photoshop/IPTC (APP13) blocks go entirely, since they carry the same facts
/// (GPS, serials, names) in their own formats. An Exif block that can't be parsed is dropped whole
/// rather than kept as it was.
pub fn strip_private(d: &[u8]) -> Vec<u8> {
    let out = match read(d) {
        Some(mut t) => {
            t.gps.clear();
            t.ifd0.retain(|e| !PRIVATE.contains(&e.tag) && e.tag != TAG_GPS_IFD);
            t.exif.retain(|e| !PRIVATE.contains(&e.tag));
            replace_app1(d, Some(t.write()))
        }
        None if exif_segment(d).is_some() => replace_app1(d, None),
        None => d.to_vec(),
    };
    drop_metadata_blocks(&out)
}

/// The file without its header APP1 segments other than Exif (XMP, extended XMP) and its APP13 ones.
fn drop_metadata_blocks(d: &[u8]) -> Vec<u8> {
    let l = walk(d);
    let mut cut = Vec::new();
    for s in &l.segments {
        if s.marker == 0xDA {
            break;
        }
        let other_app1 = s.marker == APP1 && !s.payload(d).starts_with(b"Exif\0\0");
        if other_app1 || s.marker == 0xED {
            cut.push(s.offset..s.offset + s.length);
        }
    }
    if cut.is_empty() {
        return d.to_vec();
    }
    let mut out = Vec::with_capacity(d.len());
    let mut at = 0;
    for r in cut {
        out.extend_from_slice(&d[at..r.start]);
        at = r.end;
    }
    out.extend_from_slice(&d[at..]);
    out
}

/// Largest APP1 payload a segment can hold (its length field is 16 bits and counts itself).
const MAX_APP1: usize = 0xFFFF - 2;

/// The file with `thumb` as its Exif thumbnail. Errors when Exif plus thumbnail would not fit in one
/// APP1 segment (64 KB): a cut-off block would leave a broken Exif and lose the end of the file.
pub fn with_thumbnail(d: &[u8], thumb: &[u8]) -> Result<Vec<u8>, String> {
    let mut t = read(d).unwrap_or(Tiff { le: true, ..Default::default() });
    t.thumb = Some(thumb.to_vec());
    let payload = t.write();
    if payload.len() > MAX_APP1 {
        return Err(format!("the Exif block would be {} KB with this thumbnail; 64 KB is the limit", payload.len() / 1024));
    }
    Ok(replace_app1(d, Some(payload)))
}

pub fn set_orientation(d: &[u8], v: u16) -> Vec<u8> {
    let mut t = read(d).unwrap_or(Tiff { le: true, ..Default::default() });
    t.set_short(true, TAG_ORIENTATION, v);
    replace_app1(d, Some(t.write()))
}

/// Image size recorded in Exif (PixelXDimension / PixelYDimension), from an APP1 payload.
pub fn dims(app1: &[u8]) -> Option<(usize, usize)> {
    let t = Tiff::parse(app1)?;
    let get = |tag: u16| t.exif.iter().find(|e| e.tag == tag).and_then(|e| entry_u32(e, t.le)).map(|v| v as usize);
    match (get(0xA002), get(0xA003)) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    }
}

fn tag_name(tag: u16) -> Option<&'static str> {
    Some(match tag {
        0x010F => "Make",
        0x0110 => "Model",
        0x0112 => "Orientation",
        0x0132 => "DateTime",
        0x0131 => "Software",
        0x013B => "Artist",
        0x8298 => "Copyright",
        0x829A => "ExposureTime",
        0x829D => "FNumber",
        0x8827 => "ISO",
        0x9003 => "DateTimeOriginal",
        0x920A => "FocalLength",
        0x9209 => "Flash",
        0xA002 => "PixelXDimension",
        0xA003 => "PixelYDimension",
        0xA430 => "CameraOwnerName",
        0xA431 => "BodySerialNumber",
        0xA434 => "LensModel",
        0xA435 => "LensSerialNumber",
        0x927C => "MakerNote",
        _ => return None,
    })
}

fn value_string(e: &Entry, le: bool) -> String {
    let rd = |b: &[u8]| -> u32 { if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) } };
    match e.typ {
        2 => String::from_utf8_lossy(&e.data).trim_end_matches('\0').trim().to_string(),
        3 => entry_u32(e, le).map(|v| v.to_string()).unwrap_or_default(),
        4 => entry_u32(e, le).map(|v| v.to_string()).unwrap_or_default(),
        5 | 10 if e.data.len() >= 8 => {
            let (n, dd) = (rd(&e.data[0..4]), rd(&e.data[4..8]));
            if e.typ == 10 {
                format!("{}/{}", n as i32, dd as i32)
            } else {
                format!("{}/{}", n, dd)
            }
        }
        _ => format!("({} bytes)", e.data.len()),
    }
}

/// Flat key/value view for inspect().
pub fn flat(d: &[u8]) -> Option<serde_json::Map<String, serde_json::Value>> {
    let t = read(d)?;
    let mut m = serde_json::Map::new();
    for e in t.ifd0.iter().chain(t.exif.iter()) {
        if let Some(n) = tag_name(e.tag) {
            m.insert(n.into(), serde_json::Value::String(value_string(e, t.le)));
        }
    }
    if !t.gps.is_empty() {
        m.insert("GPS".into(), serde_json::Value::String(format!("{} fields", t.gps.len())));
    }
    if let Some(th) = &t.thumb {
        m.insert("Thumbnail".into(), serde_json::Value::String(format!("{} bytes", th.len())));
    }
    Some(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Audit B9 (09-11): one thumbnail reader; its range points at the bytes with_thumbnail wrote
    #[test]
    fn thumbnail_range_finds_the_written_thumbnail() {
        let thumb = [0xFF, 0xD8, 7, 8, 9, 0xFF, 0xD9];
        let j = with_thumbnail(&[0xFF, 0xD8, 0xFF, 0xD9], &thumb).unwrap();
        let (o, l) = thumbnail_range(&j).unwrap();
        assert_eq!(&j[o..o + l], &thumb[..]);
        assert_eq!(thumbnail_range(&[0xFF, 0xD8, 0xFF, 0xD9]), None);
    }

    #[test]
    fn roundtrip_orientation_and_thumb() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xD9];
        let j = set_orientation(&jpeg, 6);
        let j = with_thumbnail(&j, &[0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]).unwrap();
        let t = read(&j).unwrap();
        assert_eq!(t.thumb.as_deref(), Some(&[0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9][..]));
        let f = flat(&j).unwrap();
        assert_eq!(f["Orientation"], "6");
    }

    fn ascii(tag: u16, s: &str) -> Entry {
        let mut data = s.as_bytes().to_vec();
        data.push(0);
        Entry { tag, typ: 2, count: data.len() as u32, data }
    }

    /// SOI, then the given header segments, then a tiny scan and EOI.
    fn jpeg_with(segs: &[Vec<u8>]) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8];
        for s in segs {
            j.extend_from_slice(s);
        }
        j.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]);
        j
    }

    #[test]
    fn strip_private_removes_serials_gps_xmp_and_iptc() {
        let mut t = Tiff { le: true, ..Default::default() };
        t.set_ascii(0x010F, "Canon");
        t.set_ascii(0x013B, "A. Person");
        t.set_short(true, TAG_ORIENTATION, 6);
        t.exif = vec![ascii(0xA431, "BODY123"), ascii(0xA434, "EF 50mm"), ascii(0xA435, "LENS456")];
        t.gps = vec![ascii(0x0001, "N")];
        let xmp = segment(APP1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude=\"45,1N\"/>");
        let iptc = segment(0xED, b"Photoshop 3.0\08BIM\x04\x04 owner");
        let j = jpeg_with(&[segment(APP1, &t.write()), xmp, iptc]);

        let s = strip_private(&j);
        let t2 = read(&s).expect("Exif kept");
        let tags: Vec<u16> = t2.ifd0.iter().chain(t2.exif.iter()).map(|e| e.tag).collect();
        for private in [0x013B, 0xA431, 0xA435] {
            assert!(!tags.contains(&private), "tag {private:04X} survived");
        }
        assert!(t2.gps.is_empty() && !tags.contains(&TAG_GPS_IFD));
        assert!(tags.contains(&0x010F) && tags.contains(&0xA434), "camera make and lens model are kept");
        assert_eq!(flat(&s).unwrap()["Orientation"], "6");
        let has = |needle: &[u8]| s.windows(needle.len()).any(|w| w == needle);
        assert!(!has(b"GPSLatitude") && !has(b"Photoshop 3.0") && !has(b"LENS456"));
        assert!(s.ends_with(&[0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]), "the image data is untouched");
    }

    // Audit B1 (09-6): 512 entries all pointing at the same 60 KB used to copy 30 MB; IFDs pointing
    // at each other were read again.
    #[test]
    fn parse_copies_at_most_twice_the_block() {
        let mut t = b"Exif\0\0II*\0".to_vec();
        t.extend(8u32.to_le_bytes());
        t.extend(512u16.to_le_bytes());
        for i in 0..512u16 {
            let tag = if i == 0 { TAG_EXIF_IFD } else { 0x9000 + i };
            let (typ, count, val) = if i == 0 { (4u16, 1u32, 8u32) } else { (7, 60_000, 8) };
            t.extend(tag.to_le_bytes());
            t.extend(typ.to_le_bytes());
            t.extend(count.to_le_bytes());
            t.extend(val.to_le_bytes());
        }
        t.extend(8u32.to_le_bytes()); // next IFD = IFD0 again
        t.resize(65_000, 0x55);
        let tiff = Tiff::parse(&t).unwrap();
        let copied: usize = [&tiff.ifd0, &tiff.exif, &tiff.ifd1].iter().flat_map(|v| v.iter()).map(|e| e.data.len()).sum();
        assert!(copied <= 2 * t.len(), "copied {copied} bytes from a {} byte block", t.len());
        assert!(tiff.exif.is_empty() && tiff.ifd1.is_empty(), "IFD0 read again through a pointer");
    }

    // Audit B1 (09-4): a thumbnail that doesn't fit in one APP1 used to be cut off silently.
    #[test]
    fn an_oversized_thumbnail_is_refused() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xD9];
        assert!(with_thumbnail(&jpeg, &vec![0x11; 70_000]).is_err());
        assert!(with_thumbnail(&jpeg, &vec![0x11; 30_000]).is_ok());
    }

    #[test]
    fn strip_private_drops_an_unreadable_exif_block() {
        let j = jpeg_with(&[segment(APP1, b"Exif\0\0ZZ garbage SERIAL789")]);
        let s = strip_private(&j);
        assert!(!s.windows(9).any(|w| w == b"SERIAL789"));
        assert!(s.starts_with(&[0xFF, 0xD8, 0xFF, 0xDA]));
    }
}
