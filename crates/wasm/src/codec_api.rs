//! Codec bindings (decode, encode, inspect, profiles, animation/video containers). Owned by the codec work stream.

use refragmenter_codec::{avi, coeffs, decoder, encoder, exif, gif, inspect, profiles, render};
use wasm_bindgen::prelude::*;

fn opts(json: &str) -> serde_json::Value {
    serde_json::from_str(json).unwrap_or(serde_json::Value::Null)
}

/// Result of a forgiving decode.
#[wasm_bindgen]
pub struct Decoded {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    events: String,
}

#[wasm_bindgen]
impl Decoded {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn rgba(&self) -> Vec<u8> {
        self.rgba.clone()
    }
    pub fn events_json(&self) -> String {
        self.events.clone()
    }
}

/// Forgiving decode. Throws "unreadable" only when no frame header can be found.
#[wasm_bindgen]
pub fn decode(input: &[u8], opts_json: &str) -> Result<Decoded, JsValue> {
    let o = render::DecodeOpts::from_json(&opts(opts_json));
    let d = render::decode(input, &o).map_err(|e| JsValue::from_str(&e))?;
    Ok(Decoded {
        width: d.width as u32,
        height: d.height as u32,
        events: serde_json::to_string(&d.events).unwrap_or_else(|_| "[]".into()),
        rgba: d.rgba,
    })
}

/// Forgiving decode with a donor photo for `fill: "donor"`: blocks that never received data show
/// the donor (decoded, stretched nearest-neighbour to this image's size) instead of grey.
/// Any other fill option behaves exactly like `decode`.
#[wasm_bindgen]
pub fn decode_with_donor(input: &[u8], opts_json: &str, donor: &[u8]) -> Result<Decoded, JsValue> {
    let mut o = render::DecodeOpts::from_json(&opts(opts_json));
    if !donor.is_empty() {
        o.donor = Some(donor.to_vec());
    }
    let d = render::decode(input, &o).map_err(|e| JsValue::from_str(&e))?;
    Ok(Decoded {
        width: d.width as u32,
        height: d.height as u32,
        events: serde_json::to_string(&d.events).unwrap_or_else(|_| "[]".into()),
        rgba: d.rgba,
    })
}

/// Encode RGBA. opts: { profile?, quality?, subsampling?, progressive?, restart_interval?, optimize_huffman? }
#[wasm_bindgen]
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8], opts_json: &str) -> Result<Vec<u8>, JsValue> {
    let o = opts(opts_json);
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return Err(JsValue::from_str("rgba buffer does not match width x height"));
    }
    let pid = o.get("profile").and_then(|v| v.as_str()).unwrap_or(profiles::DEFAULT_PROFILE);
    let prof = profiles::get(pid).or_else(|| profiles::get(profiles::DEFAULT_PROFILE)).unwrap();
    let mut s = prof.settings;
    if let Some(q) = o.get("quality").and_then(|v| v.as_i64()) {
        s.set_quality(q.clamp(1, 100) as i32);
    }
    if let Some(sub) = o.get("subsampling").and_then(|v| v.as_str()) {
        s.set_subsampling(sub);
    }
    if let Some(p) = o.get("progressive").and_then(|v| v.as_bool()) {
        s.progressive = p;
    }
    if let Some(r) = o.get("restart_interval").and_then(|v| v.as_i64()) {
        s.restart_interval = r.clamp(0, 65535) as usize;
    }
    if let Some(opt) = o.get("optimize_huffman").and_then(|v| v.as_bool()) {
        s.huffman = if opt { encoder::HuffMode::Optimize } else { encoder::HuffMode::Standard };
    }
    Ok(encoder::encode_rgba(w, h, rgba, &s))
}

/// Encode copying tables / subsampling / progression / restart interval from a JPEG.
#[wasm_bindgen]
pub fn encode_like(width: u32, height: u32, rgba: &[u8], like: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return Err(JsValue::from_str("rgba buffer does not match width x height"));
    }
    let s = encoder::EncodeSettings::like(like).unwrap_or_else(|| profiles::get(profiles::DEFAULT_PROFILE).unwrap().settings);
    Ok(encoder::encode_rgba(w, h, rgba, &s))
}

#[wasm_bindgen]
pub fn profiles() -> String {
    profiles::json()
}

#[wasm_bindgen]
pub fn inspect(input: &[u8]) -> String {
    inspect::inspect_json(input)
}

/// Bit offset where each MCU starts (raster order), 0xFFFFFFFF where never reached.
#[wasm_bindgen]
pub fn mcu_map(input: &[u8]) -> Vec<u32> {
    decoder::parse(input, false).mcu_bits
}

/// One value per 8x8 block of a component: "energy" | "dc" | "zeros" | "bits".
#[wasm_bindgen]
pub fn coeff_heatmap(input: &[u8], component: u32, mode: &str) -> Vec<f32> {
    let p = decoder::parse(input, mode == "bits");
    let Some(img) = p.img.as_ref() else { return Vec::new() };
    let Some(c) = img.comps.get(component as usize) else { return Vec::new() };
    heatmap(c, mode, p.block_bits.get(component as usize))
}

fn heatmap(c: &coeffs::Comp, mode: &str, bits: Option<&Vec<u32>>) -> Vec<f32> {
    let mut out = Vec::with_capacity(c.bw * c.bh);
    for by in 0..c.bh {
        for bx in 0..c.bw {
            let b = c.block(bx, by);
            let v = match mode {
                "dc" => b[0] as f32 * c.q[0] as f32,
                "zeros" => b[1..].iter().filter(|&&x| x == 0).count() as f32,
                "bits" => bits.and_then(|v| v.get(by * c.bw + bx)).copied().unwrap_or(0) as f32,
                _ => b[1..].iter().zip(c.q[1..].iter()).map(|(&x, &q)| (x as f32 * q as f32).powi(2)).sum::<f32>(),
            };
            out.push(v);
        }
    }
    out
}

#[wasm_bindgen]
pub fn strip_private_exif(input: &[u8]) -> Vec<u8> {
    exif::strip_private(input)
}

fn frames_of(arr: &js_sys::Array) -> Vec<Vec<u8>> {
    arr.iter().map(|v| js_sys::Uint8Array::new(&v).to_vec()).collect()
}

#[wasm_bindgen]
pub fn encode_gif(width: u32, height: u32, frames: &js_sys::Array, delay_cs: u32) -> Vec<u8> {
    gif::encode(width as usize, height as usize, &frames_of(frames), delay_cs.min(65535) as u16)
}

#[wasm_bindgen]
pub fn avi_write(jpeg_frames: &js_sys::Array, width: u32, height: u32, fps: u32) -> Vec<u8> {
    avi::write(&frames_of(jpeg_frames), width, height, fps)
}

/// JSON { width, height, fps, frames }.
#[wasm_bindgen]
pub fn avi_read(data: &[u8]) -> String {
    let i = avi::read(data);
    serde_json::json!({ "width": i.width, "height": i.height, "fps": i.fps, "frames": i.frames.len() }).to_string()
}

/// JPEG of frame `index` with standard Huffman tables inserted if it has none.
#[wasm_bindgen]
pub fn avi_frame(data: &[u8], index: u32) -> Result<Vec<u8>, JsValue> {
    avi::frame(data, index as usize).ok_or_else(|| JsValue::from_str("no such frame"))
}
