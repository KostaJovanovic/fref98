//! Minimal MJPEG AVI writer for camera movie clips on the virtual card (Canon-style, video only).

fn chunk(out: &mut Vec<u8>, id: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() % 2 == 1 {
        out.push(0);
    }
}

fn list(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 12);
    v.extend_from_slice(b"LIST");
    v.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    v.extend_from_slice(id);
    v.extend_from_slice(body);
    v
}

pub fn mjpeg_avi(frames: &[Vec<u8>], w: u32, h: u32, fps: u32) -> Vec<u8> {
    let n = frames.len() as u32;
    let max = frames.iter().map(|f| f.len()).max().unwrap_or(0) as u32;
    let mut avih = Vec::new();
    for v in [1_000_000 / fps.max(1), max * fps, 0, 0x10, n, 0, 1, max, w, h, 0, 0, 0, 0] {
        avih.extend_from_slice(&v.to_le_bytes());
    }
    let mut strh = Vec::new();
    strh.extend_from_slice(b"vidsMJPG");
    for v in [0u32, 0, 0, 1, fps, 0, n, max, 0xFFFF_FFFF, 0] {
        strh.extend_from_slice(&v.to_le_bytes());
    }
    strh.extend_from_slice(&[0, 0, 0, 0, (w & 0xFF) as u8, (w >> 8) as u8, (h & 0xFF) as u8, (h >> 8) as u8]);
    let mut strf = Vec::new();
    for v in [40u32, w, h] {
        strf.extend_from_slice(&v.to_le_bytes());
    }
    strf.extend_from_slice(&1u16.to_le_bytes());
    strf.extend_from_slice(&24u16.to_le_bytes());
    strf.extend_from_slice(b"MJPG");
    for v in [w * h * 3, 0, 0, 0, 0] {
        strf.extend_from_slice(&v.to_le_bytes());
    }
    let mut strl = Vec::new();
    chunk(&mut strl, b"strh", &strh);
    chunk(&mut strl, b"strf", &strf);
    let mut hdrl = Vec::new();
    chunk(&mut hdrl, b"avih", &avih);
    hdrl.extend(list(b"strl", &strl));
    let mut movi = Vec::new();
    let mut idx = Vec::new();
    for f in frames {
        let off = movi.len() as u32 + 4;
        chunk(&mut movi, b"00dc", f);
        idx.extend_from_slice(b"00dc");
        idx.extend_from_slice(&0x10u32.to_le_bytes());
        idx.extend_from_slice(&off.to_le_bytes());
        idx.extend_from_slice(&(f.len() as u32).to_le_bytes());
    }
    let mut body = Vec::new();
    body.extend_from_slice(b"AVI ");
    body.extend(list(b"hdrl", &hdrl));
    body.extend(list(b"movi", &movi));
    chunk(&mut body, b"idx1", &idx);
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}
