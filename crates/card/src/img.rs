//! Sparse byte image of a whole card. Only written pages are stored; everything else reads as `blank`.

use std::collections::BTreeMap;

pub const PAGE: u64 = 4096;

pub struct SparseImage {
    pub size: u64,
    /// Value unwritten bytes read as (0x00 for formatted cards).
    pub blank: u8,
    pages: BTreeMap<u64, Box<[u8]>>,
}

impl SparseImage {
    pub fn new(size: u64) -> Self {
        SparseImage { size, blank: 0, pages: BTreeMap::new() }
    }

    pub fn read(&self, off: u64, buf: &mut [u8]) {
        let mut pos = 0usize;
        while pos < buf.len() {
            let abs = off + pos as u64;
            let page = abs / PAGE;
            let in_page = (abs % PAGE) as usize;
            let n = (PAGE as usize - in_page).min(buf.len() - pos);
            if abs >= self.size {
                buf[pos..].fill(self.blank);
                return;
            }
            match self.pages.get(&page) {
                Some(p) => buf[pos..pos + n].copy_from_slice(&p[in_page..in_page + n]),
                None => buf[pos..pos + n].fill(self.blank),
            }
            pos += n;
        }
    }

    pub fn read_vec(&self, off: u64, len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len];
        self.read(off, &mut v);
        v
    }

    pub fn write(&mut self, off: u64, data: &[u8]) {
        let mut pos = 0usize;
        while pos < data.len() {
            let abs = off + pos as u64;
            if abs >= self.size {
                return;
            }
            let page = abs / PAGE;
            let in_page = (abs % PAGE) as usize;
            let n = (PAGE as usize - in_page).min(data.len() - pos);
            let blank = self.blank;
            let p = self.pages.entry(page).or_insert_with(|| vec![blank; PAGE as usize].into_boxed_slice());
            p[in_page..in_page + n].copy_from_slice(&data[pos..pos + n]);
            pos += n;
        }
    }

    pub fn fill(&mut self, off: u64, len: u64, value: u8) {
        let chunk = vec![value; PAGE as usize];
        let mut done = 0u64;
        while done < len {
            let n = (len - done).min(PAGE - (off + done) % PAGE);
            if value == self.blank && n == PAGE && (off + done) % PAGE == 0 {
                self.pages.remove(&((off + done) / PAGE));
            } else {
                self.write(off + done, &chunk[..n as usize]);
            }
            done += n;
        }
    }

    /// True when the range was never written (fast path for carvers).
    pub fn is_blank_range(&self, off: u64, len: u64) -> bool {
        let first = off / PAGE;
        let last = (off + len.max(1) - 1) / PAGE;
        self.pages.range(first..=last).next().is_none()
    }

    pub fn u16(&self, off: u64) -> u16 {
        let b = self.read_vec(off, 2);
        u16::from_le_bytes([b[0], b[1]])
    }
    pub fn u32(&self, off: u64) -> u32 {
        let b = self.read_vec(off, 4);
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    }
    pub fn put_u16(&mut self, off: u64, v: u16) {
        self.write(off, &v.to_le_bytes());
    }
    pub fn put_u32(&mut self, off: u64, v: u32) {
        self.write(off, &v.to_le_bytes());
    }
}
